#!/usr/bin/env node
// Choose today's interest and assemble the research input — deterministic + zero tokens.
//
//   node scripts/pick-interest.mjs                 # write data/digest-today.json
//   node scripts/pick-interest.mjs --date=2026-08-10
//   node scripts/pick-interest.mjs --dry-run       # print the picks, write nothing
//   node scripts/pick-interest.mjs --github        # also append pick=/date= to $GITHUB_OUTPUT
//
// This is the first step of the split pipeline: pick (here) -> research (skills/RESEARCH.md,
// networked) -> author (skills/AUTHORING.md, offline). The cadence rule that lives here used to be
// prose in AUTHORING.md that the model re-derived every morning from a 10-interest digest. Two things
// were wrong with that: a judgement call that is really arithmetic was being paid for in tokens and
// could come out differently on identical inputs, and the digest of every tab had to be loaded to
// make it. Now the arithmetic is code, and only the chosen tab's items reach the model.
//
// Output: data/digest-today.json — { version, date, excluded_yesterday, picks: [primary, fallback] }.
// Read by skills/RESEARCH.md. It carries the reader's per-article feedback and read status, so it is
// PRIVATE (gitignored, deleted before the Pages upload) exactly like reading-state.json.
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDigestToday } from "./lib/pick-interest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const DRY = process.argv.includes("--dry-run");

const readJson = async (p) => JSON.parse(await readFile(join(ROOT, p), "utf8"));
const tryJson = async (p) => {
  try {
    return await readJson(p);
  } catch {
    return null;
  }
};

const sydneyToday = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const date = arg("date") || sydneyToday();
const config = (await tryJson("data/config.json")) || { interests: [] };
const digest = await tryJson("data/pool-digest.json");
const manifest = (await tryJson("data/manifest.json")) || { articles: [] };
const pool = (await tryJson("data/pool.json")) || { items: [] };
// Absent on a keyless local run (it lives in the private cortex-state repo). feedbackSummary reports
// every article as "unknown" then, which is honest — better than pretending nothing was read.
const state = await tryJson("data/reading-state.json");

// Hard-fail rather than pick blind: without the digest there are no candidate items, and a research
// run against an empty menu would invent its own topic — the exact drift the pipeline exists to stop.
if (!digest) {
  console.error("data/pool-digest.json missing — run scripts/ingest.mjs first");
  process.exit(1);
}
if (!state) console.warn("! data/reading-state.json not materialised — reader signals will be empty");

const today = buildDigestToday({
  interests: config.interests || [],
  digestInterests: digest.interests || {},
  articles: manifest.articles || [],
  state,
  poolItems: pool.items || [],
  date,
});

if (!today.picks.length) {
  console.error("no interest could be served — every tab is either excluded or a `current` tab with an empty pool");
  process.exit(1);
}

for (const [i, p] of today.picks.entries()) {
  const role = i === 0 ? "PICK    " : "fallback";
  const since = p.never_served ? "never served" : `${p.days_since_last_article}d since last (cadence ${p.cadence_days}d)`;
  console.log(`${role} ${p.id} — ${since}, score ${p.score ?? "∞"}, ${p.items.length} item(s), ${p.recent_feedback.length} recent`);
}
if (today.excluded_yesterday) console.log(`  excluded yesterday's interest: ${today.excluded_yesterday}`);
if (today.repeated_yesterday) console.log(`  ! nothing else was servable, so ${today.repeated_yesterday} repeats today`);

if (!DRY) {
  await writeFile(join(ROOT, "data/digest-today.json"), JSON.stringify({ ...today, generated_at: new Date().toISOString() }, null, 2) + "\n");
  console.log(`wrote data/digest-today.json for ${date}`);
}

if (process.argv.includes("--github") && process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `pick=${today.picks[0].id}\npick_date=${date}\n`);
}
