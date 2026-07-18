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
//      LOGIN_REQUIRED, "Sign in to confirm you're not a bot" on every video), so like Substack this
//      only works from a residential IP. Videos pooled by yesterday's cloud ingest get their
//      transcript here, one day late — the author reads them the next morning.
//   3. It commits + pushes (with --push) so the 6am cloud run sees the items. Rebase-retry mirrors
//      generate.yml's Commit step — the browser sync can write main at any moment.
//
// Usage: node scripts/ingest-local.mjs           fetch + write pool/seen locally, no git
//        node scripts/ingest-local.mjs --push    …then commit + push to main
//        node scripts/ingest-local.mjs --reseed  one-time bootstrap: also re-pool items whose seen.json
//                                                keys were burned while the feed was still cloud-listed
//                                                (marked seen, then evicted un-read when the source was
//                                                cut). Bounded to the last RESEED_DAYS of posts. Not for
//                                                the scheduled run — it would re-offer author-used items.
// Scheduled via Windows Task Scheduler (see HANDOFF.md) at 05:15 local, before the 06:00 generate.
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

async function main() {
  const localSources = await readJson("data/sources-local.json", {});
  const seenState = await readJson("data/seen.json", { version: 1, seen: [] });
  const pool = await readJson("data/pool.json", { version: 1, items: [] });

  const now = new Date().toISOString();
  const seenTs = new Map();
  for (const e of seenState.seen || []) {
    if (typeof e === "string") seenTs.set(e, now);
    else if (e && typeof e.k === "string") seenTs.set(e.k, e.t || now);
  }

  let added = 0, failed = 0;
  for (const [interestId, feeds] of Object.entries(localSources)) {
    if (!Array.isArray(feeds)) continue; // _comment key
    for (const url of feeds.filter((u) => typeof u === "string" && u.startsWith("http"))) {
      let raw;
      try { raw = await fetchFeed(url); }
      catch (e) { failed++; log(`✗ ${interestId} ${url} — ${e.message}`); continue; }
      const items = parseFeed(raw);
      const bodies = fullBodies(raw);
      const inPool = new Set(pool.items.map((i) => i.id));
      let newForFeed = 0;
      for (const it of items) {
        const key = hash(it.guid || it.url);
        const id = `${interestId}-${key}`;
        if (seenTs.has(key)) {
          if (!RESEED || inPool.has(id)) continue;
          const pubMs = Date.parse(it.published || "");
          if (!Number.isFinite(pubMs) || (Date.now() - pubMs) / 86400000 > RESEED_DAYS) continue;
        }
        seenTs.set(key, now);
        if (newForFeed >= PER_FEED_CAP) continue;
        const body = bodies.get(it.guid) || "";
        pool.items.push({
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
        newForFeed++; added++;
      }
      log(`${interestId} ${url} — ${items.length} items, ${newForFeed} new`);
    }
  }

  // Transcript enrichment: pending videos (usually pooled by yesterday's cloud ingest) whose
  // excerpt is still just the channel description. The transcript replaces it — it's the video's
  // actual substance, and the only text of it the cloud author will ever have.
  let transcribed = 0, tried = 0;
  const retryCutoff = Date.now() - TRANSCRIPT_RETRY_HOURS * 3600000;
  for (const item of pool.items) {
    if (tried >= MAX_TRANSCRIPTS) break;
    if (item.kind !== "video" || item.status !== "pending" || item.transcript_at) continue;
    if (item.transcript_tried_at && new Date(item.transcript_tried_at).getTime() > retryCutoff) continue;
    tried++;
    item.transcript_tried_at = now;
    try {
      const { text, reason, kind } = await fetchTranscript(item.url, { maxChars: BODY_CHARS });
      if (text) {
        item.excerpt = text;
        item.transcript_at = now;
        item.transcript_kind = kind;
        transcribed++;
        log(`↪ transcript ${item.id} (${kind}) — ${text.length} chars`);
      } else {
        log(`· transcript ${item.id} — ${reason}, kept description`);
      }
    } catch (e) { log(`✗ transcript ${item.id} — ${e.message}`); }
  }

  if (!added && !transcribed && !tried) { log(`nothing new (${failed} feed(s) failed) — no write, no push`); return; }

  seenState.seen = [...seenTs.entries()].map(([k, t]) => ({ k, t }));
  pool.updatedAt = now;
  await writeFile(join(ROOT, "data/seen.json"), JSON.stringify(seenState, null, 2) + "\n");
  await writeFile(join(ROOT, "data/pool.json"), JSON.stringify(pool, null, 2) + "\n");
  log(`${added} new item(s) pooled, ${transcribed} transcript(s) captured (${tried} attempted), ${failed} feed(s) failed`);

  if (!PUSH) { log("(no --push: local write only)"); return; }
  git("add", "data/pool.json", "data/seen.json");
  try { execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: ROOT }); log("nothing staged — skipping push"); return; } catch {}
  git("commit", "-m", "ingest(local): substack supplement");
  let pushed = false;
  for (let i = 0; i < 3 && !pushed; i++) {
    try {
      git("pull", "--rebase", "--autostash", "origin", "main");
      git("push", "origin", "HEAD:main");
      pushed = true;
    } catch (e) {
      log(`push attempt ${i + 1} failed — ${e.message}`);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
  if (!pushed) { log("push failed after retries"); process.exit(1); }
  log("pushed");
}

main().catch((e) => { console.error(e); process.exit(1); });
