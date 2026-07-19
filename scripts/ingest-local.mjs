#!/usr/bin/env node
// Local ingest supplement: fetch the feeds in data/sources-local.json — publishers that IP-ban
// GitHub Actions runners (Substack bans every UA from datacenter IPs) — from this machine's
// residential IP, and add their items to the shared pool.
//
// Three things differ from the cloud ingest on purpose:
//   1. The excerpt is the FULL post body (content:encoded, capped like the policy-PDF enrichment),
//      not the ~400-char feed blurb. The cloud author's WebFetch runs on the same banned runner IP,
//      so what lands in the pool here is ALL it will ever read of these sources.
//   2. It also enriches pending kind:"video" pool items with TRANSCRIPTS. YouTube bot-walls the
//      InnerTube player endpoint for GitHub runner IPs (probed 2026-07-18: playability
//      LOGIN_REQUIRED on every video), so like Substack this only works from a residential IP.
//   3. It commits + pushes (with --push) so the 6am cloud run sees the items.
//
// GIT FLOW — sync first, rebuild on race, NEVER rebase the derived files (learned 2026-07-19):
// pool.json/seen.json are rewritten wholesale by every cloud ingest, so rebasing a local commit
// that touches them over a cloud commit conflicts BY CONSTRUCTION — the first scheduled run
// (committing before pulling) wedged the repo mid-rebase with UU pool.json. Instead: pull before
// reading anything; keep this run's changes as DATA (newItems/newSeen/patches); apply→write→
// commit→push; if the push races a remote move, reset the branch to the fresh tip (touching ONLY
// the two derived files, so unrelated WIP in the tree survives) and re-apply. Derived data is
// always regenerable — rebuilding beats merging.
//
// Usage: node scripts/ingest-local.mjs           fetch + write pool/seen locally, no git
//        node scripts/ingest-local.mjs --push    sync repo first, then commit + push to main
//        node scripts/ingest-local.mjs --reseed  one-time bootstrap: also re-pool items whose seen.json
//                                                keys were burned while the feed was still cloud-listed
//                                                (marked seen, then evicted un-read when the source was
//                                                cut). Bounded to the last RESEED_DAYS of posts. Not for
//                                                the scheduled run — it would re-offer author-used items.
// Scheduled via Windows Task Scheduler ("Cortex local ingest", 05:15 local + StartWhenAvailable,
// log %LOCALAPPDATA%\cortex-ingest-local.log) — see HANDOFF.md.
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchFeed, parseFeed, decode, rawInner, hash } from "./ingest.mjs";
import { fetchTranscript } from "./lib/transcripts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUSH = process.argv.includes("--push");
const RESEED = process.argv.includes("--reseed");
const RESEED_DAYS = 60;
const PER_FEED_CAP = 25;
const BODY_CHARS = 2200; // matches ENRICH_CHARS in ingest.mjs — the author-facing budget per item
const MAX_TRANSCRIPTS = 8;      // per run; the backlog catches up across days
const TRANSCRIPT_RETRY_HOURS = 48; // a just-uploaded video may not have ASR captions yet — retry later, not daily

const readJson = async (p, fallback) => {
  try { return JSON.parse(await readFile(join(ROOT, p), "utf8")); } catch { return fallback; }
};
const log = (...a) => console.log(new Date().toISOString(), ...a);
const git = (...args) => execFileSync("git", args, { cwd: ROOT, stdio: "inherit" });
const gitTry = (...args) => { try { git(...args); return true; } catch { return false; } };
const seenKey = (e) => (typeof e === "string" ? e : e && e.k) || null;

// Substack carries the full post in content:encoded; parseFeed only reads the short description.
// Pull the bodies straight from the raw XML, keyed the same way parseFeed keys items (guid), so the
// two can be joined without changing parseFeed's cloud behaviour.
function fullBodies(xml) {
  const bodies = new Map();
  for (const b of xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || []) {
    const guid = /<guid[^>]*>([\s\S]*?)<\/guid>/i.exec(b)?.[1]?.trim();
    const enc = rawInner(b, "content:encoded");
    if (guid && enc) bodies.set(decode(guid), decode(enc).slice(0, BODY_CHARS));
  }
  return bodies;
}

// Start from the latest main so the eventual commit is a fast-forward on top of the cloud's work.
// Self-heals the states a crashed/raced previous run can leave behind.
function syncRepo() {
  if (gitTry("pull", "--rebase", "--autostash", "origin", "main")) return;
  gitTry("rebase", "--abort");
  gitTry("merge", "--abort");
  if (gitTry("pull", "--rebase", "--autostash", "origin", "main")) return;
  // Last resort: a stranded derived-data commit that cannot rebase. Drop it, refresh ONLY the two
  // regenerable files, keep any other WIP in the tree untouched.
  if (gitTry("fetch", "origin") &&
      gitTry("reset", "--mixed", "origin/main") &&
      gitTry("checkout", "--", "data/pool.json", "data/seen.json") &&
      gitTry("pull", "--rebase", "--autostash", "origin", "main")) return;
  log("cannot sync the repo — resolve manually");
  process.exit(1);
}

async function main() {
  if (PUSH) syncRepo();

  const localSources = await readJson("data/sources-local.json", {});
  const now = new Date().toISOString();
  const seenState0 = await readJson("data/seen.json", { version: 1, seen: [] });
  const pool0 = await readJson("data/pool.json", { version: 1, items: [] });
  const seen0 = new Set((seenState0.seen || []).map(seenKey).filter(Boolean));
  const inPool0 = new Set(pool0.items.map((i) => i.id));

  // Everything this run wants to change, held as DATA so it can be re-applied onto a fresh
  // checkout if the push races the cloud run.
  const newItems = [];       // pool items to add (ids already present at apply time are skipped)
  const newSeen = new Map(); // seen keys to union in
  const patches = new Map(); // pool item id → fields to set (transcript enrichment)

  let failed = 0;
  for (const [interestId, feeds] of Object.entries(localSources)) {
    if (!Array.isArray(feeds)) continue; // _comment key
    for (const url of feeds.filter((u) => typeof u === "string" && u.startsWith("http"))) {
      let raw;
      try { raw = await fetchFeed(url); }
      catch (e) { failed++; log(`✗ ${interestId} ${url} — ${e.message}`); continue; }
      const items = parseFeed(raw);
      const bodies = fullBodies(raw);
      let newForFeed = 0;
      for (const it of items) {
        const key = hash(it.guid || it.url);
        const id = `${interestId}-${key}`;
        if (newSeen.has(key)) continue; // another local feed already claimed it this run
        if (seen0.has(key)) {
          if (!RESEED || inPool0.has(id)) continue;
          const pubMs = Date.parse(it.published || "");
          if (!Number.isFinite(pubMs) || (Date.now() - pubMs) / 86400000 > RESEED_DAYS) continue;
        }
        newSeen.set(key, now);
        if (newForFeed >= PER_FEED_CAP) continue;
        const body = bodies.get(it.guid) || "";
        newItems.push({
          id,
          interest: interestId,
          feed: url,
          kind: "article",
          title: it.title,
          url: it.url,
          ...(it.author ? { source: it.author } : {}),
          excerpt: body || it.excerpt,
          ...(body ? { enriched_at: now } : {}),
          published_at: it.published,
          added_at: now,
          status: "pending",
          used_in: [],
        });
        newForFeed++;
      }
      log(`${interestId} ${url} — ${items.length} items, ${newForFeed} new`);
    }
  }

  // Transcript enrichment: pending videos (usually pooled by the cloud ingest) whose excerpt is
  // still just the channel description. The transcript replaces it — it's the video's actual
  // substance, and the only text of it the cloud author will ever have.
  let transcribed = 0, tried = 0;
  const retryCutoff = Date.now() - TRANSCRIPT_RETRY_HOURS * 3600000;
  for (const item of pool0.items) {
    if (tried >= MAX_TRANSCRIPTS) break;
    if (item.kind !== "video" || item.status !== "pending" || item.transcript_at) continue;
    if (item.transcript_tried_at && new Date(item.transcript_tried_at).getTime() > retryCutoff) continue;
    tried++;
    const patch = { transcript_tried_at: now };
    try {
      const { text, reason, kind } = await fetchTranscript(item.url, { maxChars: BODY_CHARS });
      if (text) {
        Object.assign(patch, { excerpt: text, transcript_at: now, transcript_kind: kind });
        transcribed++;
        log(`↪ transcript ${item.id} (${kind}) — ${text.length} chars`);
      } else {
        log(`· transcript ${item.id} — ${reason}, kept description`);
      }
    } catch (e) { log(`✗ transcript ${item.id} — ${e.message}`); }
    patches.set(item.id, patch);
  }

  if (!newItems.length && !patches.size) {
    log(`nothing to do (${failed} feed(s) failed) — no write, no push`);
    return;
  }

  // Apply this run's changes onto the CURRENT files — fresh-read every time, so it works equally
  // on the state we fetched against and on a just-reset newer checkout.
  async function applyAndWrite() {
    const seenState = await readJson("data/seen.json", { version: 1, seen: [] });
    const pool = await readJson("data/pool.json", { version: 1, items: [] });
    const have = new Set((seenState.seen || []).map(seenKey).filter(Boolean));
    for (const [k, t] of newSeen) if (!have.has(k)) (seenState.seen ||= []).push({ k, t });
    const ids = new Set(pool.items.map((i) => i.id));
    for (const it of newItems) if (!ids.has(it.id)) { pool.items.push(it); ids.add(it.id); }
    for (const item of pool.items) {
      const p = patches.get(item.id);
      if (p) Object.assign(item, p); // an item the cloud pruned meanwhile is simply absent — fine
    }
    pool.updatedAt = new Date().toISOString();
    await writeFile(join(ROOT, "data/seen.json"), JSON.stringify(seenState, null, 2) + "\n");
    await writeFile(join(ROOT, "data/pool.json"), JSON.stringify(pool, null, 2) + "\n");
  }

  await applyAndWrite();
  log(`${newItems.length} new item(s), ${transcribed} transcript(s) captured (${tried} attempted), ${failed} feed(s) failed`);
  if (!PUSH) { log("(no --push: local write only)"); return; }

  for (let attempt = 1; attempt <= 3; attempt++) {
    git("add", "data/pool.json", "data/seen.json");
    let staged = true;
    try { execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: ROOT }); staged = false; } catch {}
    if (!staged) { log("nothing staged — skipping push"); return; }
    git("commit", "-m", "ingest(local): substack + transcript supplement");
    if (gitTry("push", "origin", "HEAD:main")) { log("pushed"); return; }
    // main moved in the window (cloud run or browser sync). Never rebase the derived files —
    // rebuild on the fresh tip: move the branch, refresh ONLY pool/seen, re-apply, go again.
    log(`push rejected (attempt ${attempt}) — rebuilding on the fresh main`);
    if (!gitTry("fetch", "origin") || !gitTry("reset", "--mixed", "origin/main") ||
        !gitTry("checkout", "--", "data/pool.json", "data/seen.json")) break;
    await applyAndWrite();
  }
  log("push failed after retries");
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
