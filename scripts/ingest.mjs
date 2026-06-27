#!/usr/bin/env node
// Fetch RSS/Atom feeds per interest → dedup → append new items to data/pool.json.
// Zero dependencies (Node 20+ global fetch + stdlib). Usage:
//   node scripts/ingest.mjs            fetch + update pool.json + seen.json
//   node scripts/ingest.mjs --dry-run  fetch + report, write nothing
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");
const PER_FEED_CAP = 25; // bound how many new items one feed can add per run
const POOL_TTL_DAYS = 21; // candidates not used within this window age out, keeping the pool fresh
const MAX_PENDING_PER_INTEREST = 20; // hard cap: the pool is the authoring input, so keep it small + cheap

const readJson = async (p, fallback) => {
  try { return JSON.parse(await readFile(join(ROOT, p), "utf8")); } catch { return fallback; }
};
const log = (...a) => console.log(...a);
const hash = (s) => createHash("sha1").update(s).digest("hex").slice(0, 12);

const decode = (s = "") =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ").trim();

const tag = (block, name) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? decode(m[1]) : "";
};
// Atom <link href="..."/> vs RSS <link>text</link>
const linkOf = (block) => {
  const href = /<link[^>]*\shref="([^"]+)"/i.exec(block);
  if (href) return href[1];
  return tag(block, "link");
};

function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const title = tag(b, "title");
    const url = linkOf(b);
    const guid = tag(b, "guid") || tag(b, "id") || url;
    const published = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || "";
    const excerpt = (tag(b, "description") || tag(b, "summary") || tag(b, "content")).slice(0, 400);
    if (!title || !guid) continue;
    items.push({ title, url, guid, published, excerpt });
  }
  return items;
}

// A browser-like UA + Accept gets past naive bot filters. It will NOT beat real anti-bot
// challenges (Cloudflare JS checks return 403/503 regardless) — pick feeds that serve scripts.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
async function fetchFeed(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const config = await readJson("data/config.json", { interests: [] });
  const sources = await readJson("data/sources.json", {});
  const seenState = await readJson("data/seen.json", { version: 1, seen: [] });
  const pool = await readJson("data/pool.json", { version: 1, items: [] });

  const seen = new Set(seenState.seen || []);

  let added = 0, fetched = 0, failed = 0;
  for (const interest of config.interests || []) {
    const feeds = (sources[interest.id] || []).filter((u) => typeof u === "string" && u.startsWith("http"));
    for (const url of feeds) {
      let items;
      try { items = parseFeed(await fetchFeed(url)); fetched++; }
      catch (e) { failed++; log(`  ✗ ${interest.id} ${url} — ${e.message}`); continue; }

      let newForFeed = 0;
      for (const it of items) {
        const key = hash(it.guid || it.url);
        if (seen.has(key)) continue;
        seen.add(key);
        if (newForFeed >= PER_FEED_CAP) continue; // cap per feed: mark seen, don't pool beyond the cap
        pool.items.push({
          id: `${interest.id}-${hash(it.guid || it.url)}`,
          interest: interest.id,
          title: it.title,
          url: it.url,
          excerpt: it.excerpt,
          published_at: it.published,
          added_at: new Date().toISOString(),
          status: "pending",
          used_in: [],
        });
        newForFeed++; added++;
      }
      log(`  ${interest.id} ${url} — ${items.length} items, ${newForFeed} new`);
    }
  }

  // Keep the pool small — it's the authoring input. Retain only fresh PENDING candidates (drop used /
  // expired / past-TTL), then cap per interest (newest first). Dedup still lives in seen.json, and
  // used items' provenance lives in the article #meta, so dropping them here is safe.
  const beforePrune = pool.items.length;
  const cutoff = Date.now() - POOL_TTL_DAYS * 86400000;
  const fresh = pool.items.filter((it) => it.status === "pending" && (!it.added_at || new Date(it.added_at).getTime() >= cutoff));
  const groups = {};
  for (const it of fresh) (groups[it.interest] ||= []).push(it);
  const kept = [];
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => (b.added_at || "").localeCompare(a.added_at || ""));
    kept.push(...groups[k].slice(0, MAX_PENDING_PER_INTEREST));
  }
  const pruned = beforePrune - kept.length;
  pool.items = kept;

  log(`\n${fetched} feed(s) fetched, ${failed} failed, ${added} new pending item(s), ${pruned} pruned, ${pool.items.length} in pool${DRY ? " (dry-run — nothing written)" : ""}`);
  if (DRY) return;

  seenState.seen = [...seen];
  pool.updatedAt = new Date().toISOString();
  await writeFile(join(ROOT, "data/seen.json"), JSON.stringify(seenState, null, 2) + "\n");
  await writeFile(join(ROOT, "data/pool.json"), JSON.stringify(pool, null, 2) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
