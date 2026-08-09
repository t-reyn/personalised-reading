#!/usr/bin/env node
// Retire the pool items today's issue was built from — deterministic + zero tokens.
//
//   node scripts/consume-pool.mjs                  # mark the brief's used_item_ids as used
//   node scripts/consume-pool.mjs --date=2026-08-10
//   node scripts/consume-pool.mjs --dry-run        # report only, write nothing
//
// The last step of the split pipeline. The author used to do this itself, which meant the offline
// step needed read/write access to data/pool.json for pure bookkeeping — and a run that died
// mid-edit could leave the pool half-updated. Now the brief declares what it drew on
// (`used_item_ids` in its meta header) and this script applies it.
//
// "Used" rather than deleted, matching what the app and the ingester already expect: Discover
// filters `status !== "used"` (so a consumed item stops being offered the moment the piece about it
// publishes) and the next ingest prunes used items out of pool.json entirely. Provenance survives in
// the article's own #meta sources.
//
// NOTHING is consumed unless an article actually published today. A research step that wrote a fine
// brief followed by an author step that timed out must leave the pool untouched — otherwise the run
// burns its own candidates and tomorrow re-picks the tab with the good items already gone.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBriefMeta } from "./lib/brief.mjs";
import { scanArticles } from "./lib/articles.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const DRY = process.argv.includes("--dry-run");

const date =
  arg("date") ||
  new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

let brief;
try {
  brief = await readFile(join(ROOT, "data/brief-today.md"), "utf8");
} catch {
  console.log("no data/brief-today.md — nothing to consume");
  process.exit(0);
}

// A malformed header exits non-zero on purpose: it means the research step produced something the
// author could not have followed either, and consuming nothing *silently* would hide that. The
// workflow runs this step `continue-on-error` so a red mark here can never cost the day's issue.
let meta;
try {
  meta = parseBriefMeta(brief);
} catch (err) {
  console.error(`! cannot read data/brief-today.md — pool untouched: ${err.message}`);
  process.exit(1);
}

// "Published TODAY" is not the same as "in today's folder". On a workflow_dispatch the guard's
// "today's issue already exists" check is bypassed, so the folder can already hold a committed
// article from an earlier run — and consuming against THAT would burn the brief's candidates even
// though this run wrote nothing. data/manifest.json is still the previous run's catalogue at this
// point (the Build step regenerates it immediately after), so an id missing from it is exactly an
// article written this run. A missing manifest falls back to treating them all as new.
let known = new Set();
try {
  const manifest = JSON.parse(await readFile(join(ROOT, "data/manifest.json"), "utf8"));
  known = new Set((manifest.articles || []).map((a) => a.id));
} catch {
  console.warn("! data/manifest.json unreadable — treating every article in the folder as new");
}

const all = (await scanArticles(join(ROOT, "articles", date), ROOT)).filter((r) => r.meta?.id).map((r) => r.meta.id);
const published = all.filter((id) => !known.has(id));

if (!published.length) {
  const seen = all.length ? ` (${all.length} pre-existing article(s) in that folder are not this run's)` : "";
  console.log(`no issue published for ${date}${seen} — pool untouched (${meta.used_item_ids.length} item(s) stay pending)`);
  process.exit(0);
}
if (!meta.used_item_ids.length) {
  console.log(`brief used no pool items (${meta.interest}, ${meta.mode || "mode unset"}) — nothing to consume`);
  process.exit(0);
}

const pool = JSON.parse(await readFile(join(ROOT, "data/pool.json"), "utf8"));
const wanted = new Set(meta.used_item_ids);
const stamp = new Date().toISOString();
const consumed = [];

for (const item of pool.items || []) {
  if (!wanted.has(item.id)) continue;
  consumed.push(item.id);
  item.status = "used";
  item.used_at = stamp;
  item.used_in = [...new Set([...(item.used_in || []), ...published])];
}

const missing = meta.used_item_ids.filter((id) => !consumed.includes(id));
console.log(`${meta.interest}: consumed ${consumed.length}/${meta.used_item_ids.length} item(s) into ${published.join(", ")}`);
// Not fatal — an id can legitimately vanish if the local supplement rewrote the pool mid-run, and
// the issue is already written. Logged so a systematically hallucinated id shows up in the run log.
if (missing.length) console.warn(`! not found in pool.json (ignored): ${missing.join(", ")}`);

if (DRY) {
  console.log("(dry-run — pool.json not written)");
} else if (consumed.length) {
  await writeFile(join(ROOT, "data/pool.json"), JSON.stringify(pool, null, 2) + "\n");
  console.log("wrote data/pool.json");
}
