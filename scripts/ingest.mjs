#!/usr/bin/env node
// Fetch RSS/Atom feeds per interest → dedup → append new items to data/pool.json.
// Zero dependencies (Node 20+ global fetch + stdlib). Usage:
//   node scripts/ingest.mjs            fetch + update pool.json + seen.json
//   node scripts/ingest.mjs --dry-run  fetch + report, write nothing
import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");
const PER_FEED_CAP = 25; // bound how many new items one feed can add per run
const POOL_TTL_DAYS = 21; // candidates not used within this window age out, keeping the pool fresh
const MAX_PENDING_PER_INTEREST = 20; // hard cap: the pool is the authoring input, so keep it small + cheap

// Enrichment: some feeds (regulators / statistics publishers) announce a release via RSS but the
// <description> is just rendered page chrome — no numbers, no findings. We fetch the landing page and
// extract the readable body so authoring has the actual highlights instead of a generic overview.
const DATA_SOURCE_HOSTS = ["apra.gov.au"]; // hosts whose RSS is known to carry only template chrome
const MAX_ENRICH = 8;       // bound page fetches per run (network time + politeness)
const ENRICH_CHARS = 2200;  // cap the extracted body kept on the pool item (keeps pool.json lean)
const EXCERPT_CHARS = 400;  // default cap for ordinary feed excerpts

const readJson = async (p, fallback) => {
  try { return JSON.parse(await readFile(join(ROOT, p), "utf8")); } catch { return fallback; }
};
const log = (...a) => console.log(...a);
const hash = (s) => createHash("sha1").update(s).digest("hex").slice(0, 12);

// First pass over real markup: strip comments + every tag aggressively.
const stripMarkup = (s = "") =>
  s.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ");
// Second pass (post entity-decode): strip ONLY tag-like sequences, so prose comparisons such as
// "if a < b then" survive (a bare "< b" is not a tag) while revealed `<div>`/`<a …>` soup is removed.
const stripTagsLoose = (s = "") =>
  s.replace(/<!--[\s\S]*?-->/g, " ").replace(/<\/?[a-zA-Z][^>]*>/g, " ");
const safeCodePoint = (n) => (Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ");

// Strip → decode entities → strip AGAIN. The second pass matters: some feeds (e.g. APRA) entity-encode
// their HTML, so real tags only appear as text AFTER decoding — a single strip leaves `<div>` soup.
const decode = (s = "") => {
  let t = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  t = stripMarkup(t)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(+n));
  return stripTagsLoose(t).replace(/\s+/g, " ").trim();
};

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
// YouTube channel feeds (https://www.youtube.com/feeds/videos.xml?channel_id=…) → tag items as video.
const isYouTubeFeed = (u) => /youtube\.com\/feeds\/videos\.xml/i.test(u);

function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const title = tag(b, "title");
    const url = linkOf(b);
    const guid = tag(b, "guid") || tag(b, "id") || url;
    const published = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || "";
    // media:description is where YouTube (and other media RSS) carry the body — fall back to it so
    // video items don't land with an empty excerpt.
    const excerpt = (tag(b, "description") || tag(b, "summary") || tag(b, "content") || tag(b, "media:description")).slice(0, EXCERPT_CHARS);
    // Atom <author><name> holds the channel/creator — used to attribute video sources.
    const author = tag(b, "name");
    if (!title || !guid) continue;
    items.push({ title, url, guid, published, excerpt, author });
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

async function fetchPage(url, timeoutMs = 8000) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Remove <tag>…</tag> blocks (content included) in LINEAR time via indexOf. A regex with a lazy
// backreference (…[\s\S]*?</\1>) is catastrophic on pages with many unclosed same-name tags (seconds
// on a ~1MB page); indexOf can't backtrack. An unclosed tag drops the remainder, which is fine — the
// content after a broken <script>/<style> is unusable anyway.
const BLOCK_TAGS = ["script", "style", "svg", "head", "nav", "header", "footer", "form", "aside", "noscript"];
function removeBlock(html, tag) {
  const lower = html.toLowerCase();
  const open = "<" + tag, close = "</" + tag + ">";
  let out = "", i = 0;
  for (;;) {
    const start = lower.indexOf(open, i);
    if (start === -1) { out += html.slice(i); break; }
    const after = lower[start + open.length];
    if (after !== undefined && !/[\s/>]/.test(after)) { // e.g. <navbar> is not <nav>
      out += html.slice(i, start + open.length);
      i = start + open.length;
      continue;
    }
    out += html.slice(i, start);
    const end = lower.indexOf(close, start);
    if (end === -1) break; // unclosed → drop the rest
    i = end + close.length;
  }
  return out;
}

// Pull the readable body out of a full HTML page: drop chrome/scripts/comments, strip tags, decode.
// No length cap — APRA's figures can sit past 600KB in a ~1MB page — but removeBlock is linear, so a
// pathological page can't stall us. (3MB backstop guards only against absurd inputs, well above any page.)
function extractReadable(html) {
  let s = String(html).slice(0, 3_000_000).replace(/<!--[\s\S]*?-->/g, " ");
  for (const t of BLOCK_TAGS) s = removeBlock(s, t);
  return decode(s);
}

// Skip site nav/hero crumbs by starting at the first statistics marker (or the title), so the kept
// slice leads with substance. Falls back to the whole text when no marker is found near the top.
function trimToBody(text, title = "") {
  const markers = ["Highlights", "At a glance", "Key statistics", "Key findings", "Summary", "Statistics"];
  if (title) markers.unshift(title.slice(0, 40));
  let start = -1;
  for (const m of markers) {
    const i = text.indexOf(m);
    if (i >= 0 && (start < 0 || i < start)) start = i;
  }
  return start > 0 && start < 1200 ? text.slice(start) : text;
}

// Boundary-aware host check: "apra.gov.au" matches itself and "www.apra.gov.au", NOT "evil-apra.gov.au".
const hostMatches = (hostname, h) => hostname === h || hostname.endsWith("." + h);

// Links we must never follow as a "release" (social share, print, archive, off-domain CDNs, etc.).
const SKIP_LINK = /\b(archive|share|print)\b|twitter|x\.com|linkedin|facebook|whatsapp|mailto:/i;

// A statistics landing page usually only lists data files; the actual findings live in the linked
// "media release". Find that link — same-host + http(s) only — so we fetch the page with the numbers.
// Prefer a URL whose PATH names the release (most reliable) over an anchor-text match, and never the
// first random "media release" mention (could be a footer "archive" link).
function findReleaseUrl(html, base) {
  let baseHost;
  try { baseHost = new URL(base).hostname; } catch { return null; }
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m, byPath = null, byText = null;
  while ((m = re.exec(html))) {
    const href = m[1], text = decode(m[2]);
    if (SKIP_LINK.test(href) || SKIP_LINK.test(text)) continue;
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (!hostMatches(u.hostname, baseHost)) continue; // stay on the regulator's own domain
    if (!byPath && /apra-releases|media-release/i.test(u.pathname)) byPath = u.href;
    else if (!byText && /\bAPRA releases\b|\bmedia release\b/i.test(text)) byText = u.href;
  }
  return byPath || byText || null;
}

// Start the excerpt at the first hard figure so it leads with the conclusion, not the page lead-in.
const FIGURE_RE = /\$\s?\d|\d+(?:\.\d+)?\s*(?:per cent|%)|\b\d+(?:\.\d+)?\s*(?:billion|million|trillion)\b/i;
function leadWithFigures(text) {
  const i = text.search(FIGURE_RE);
  if (i <= 120) return text;
  const slice = text.slice(i - 120);
  const sp = slice.indexOf(" "); // drop the partial leading word the back-off may have cut into
  return sp > 0 && sp < 30 ? slice.slice(sp + 1) : slice;
}

// Only enrich items from known statistics/regulator hosts. Their RSS is reliably just template chrome,
// and host-gating means we never fetch an arbitrary article that merely quotes markup in its excerpt.
function needsEnrich(item) {
  try {
    const hostname = new URL(item.url).hostname;
    return DATA_SOURCE_HOSTS.some((h) => hostMatches(hostname, h));
  } catch { return false; }
}

async function main() {
  const config = await readJson("data/config.json", { interests: [] });
  const sources = await readJson("data/sources.json", {});
  const seenState = await readJson("data/seen.json", { version: 1, seen: [] });
  const pool = await readJson("data/pool.json", { version: 1, items: [] });

  const seen = new Set(seenState.seen || []);

  let added = 0, fetched = 0, failed = 0;
  const freshlyAdded = [];
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
        const kind = isYouTubeFeed(url) ? "video" : "article";
        if (kind === "video" && /\/shorts\//i.test(it.url)) continue; // skip YouTube Shorts — too thin to synthesise (already marked seen above)
        const item = {
          id: `${interest.id}-${hash(it.guid || it.url)}`,
          interest: interest.id,
          kind,
          title: it.title,
          url: it.url,
          ...(kind === "video" && it.author ? { source: it.author } : {}),
          excerpt: it.excerpt,
          published_at: it.published,
          added_at: new Date().toISOString(),
          status: "pending",
          used_in: [],
        };
        pool.items.push(item);
        freshlyAdded.push(item);
        newForFeed++; added++;
      }
      log(`  ${interest.id} ${url} — ${items.length} items, ${newForFeed} new`);
    }
  }

  // Enrich thin items (regulator/statistics pages whose RSS is just template chrome) by fetching the
  // landing page and extracting its readable body, so authoring gets the actual figures + findings.
  // This phase runs BEFORE the authoring step, so it must never approach its timeout: we bound the
  // number of ATTEMPTS (not just successes — a run of failing fetches must still stop) and enforce a
  // hard wall-clock budget. Skipped under --dry-run so source validation has no live side effects.
  let enriched = 0, attempts = 0;
  const enrichDeadline = Date.now() + 90_000;
  if (!DRY) for (const item of freshlyAdded) {
    if (attempts >= MAX_ENRICH || Date.now() > enrichDeadline) break;
    if (!needsEnrich(item)) continue;
    attempts++;
    try {
      const html = await fetchPage(item.url);
      let body = trimToBody(extractReadable(html), item.title);
      // Prefer the linked media release — that's where the actual figures + findings live.
      const releaseUrl = findReleaseUrl(html, item.url);
      if (releaseUrl && Date.now() <= enrichDeadline) {
        try {
          const rel = leadWithFigures(extractReadable(await fetchPage(releaseUrl)));
          if (rel && rel.length >= 200) { body = rel; item.source_release = releaseUrl; }
        } catch (e) { log(`  · release fetch ${item.id} — ${e.message}`); }
      }
      if (body && body.length >= 120) {
        item.excerpt = body.slice(0, ENRICH_CHARS);
        item.enriched_at = new Date().toISOString();
        enriched++;
        log(`  ↪ enriched ${item.id}${item.source_release ? " (+release)" : ""} — ${item.excerpt.length} chars`);
      } else {
        log(`  · enrich ${item.id} — thin body (${body.length} chars), kept original`);
      }
    } catch (e) { log(`  ✗ enrich ${item.id} — ${e.message}`); }
  } else if (DRY) {
    const would = freshlyAdded.filter(needsEnrich).length;
    log(`  (dry-run: would attempt enrichment on up to ${Math.min(would, MAX_ENRICH)} of ${would} data-source item(s))`);
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

  log(`\n${fetched} feed(s) fetched, ${failed} failed, ${added} new pending item(s), ${enriched} enriched, ${pruned} pruned, ${pool.items.length} in pool${DRY ? " (dry-run — nothing written)" : ""}`);
  if (DRY) return;

  seenState.seen = [...seen];
  pool.updatedAt = new Date().toISOString();
  await writeFile(join(ROOT, "data/seen.json"), JSON.stringify(seenState, null, 2) + "\n");
  await writeFile(join(ROOT, "data/pool.json"), JSON.stringify(pool, null, 2) + "\n");
}

export { parseFeed, isYouTubeFeed };

// Run the pipeline only when invoked directly (node scripts/ingest.mjs), so tests can import
// parseFeed without triggering a live fetch + file writes.
let invokedDirectly = false;
try { invokedDirectly = realpathSync(process.argv[1] || "") === realpathSync(fileURLToPath(import.meta.url)); } catch {}
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
