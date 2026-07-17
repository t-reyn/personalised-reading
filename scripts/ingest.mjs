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
import zlib from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");
const PER_FEED_CAP = 25; // bound how many new items one feed can add per run
const POOL_TTL_DAYS = 21; // candidates not used within this window age out, keeping the pool fresh
const MAX_PENDING_PER_INTEREST = 20; // hard cap: the pool is the authoring input, so keep it small + cheap
const SEEN_TTL_DAYS = 180; // dedup keys older than this are pruned from seen.json (bounds its growth)
const DIGEST_PER_INTEREST = 8; // freshest pending items per interest in the author-facing pool digest
const DIGEST_EXCERPT_CHARS = 300; // trim digest excerpts to a word boundary near this length

// Enrichment: some feeds (regulators / statistics publishers) announce a release via RSS but the
// <description> is just rendered page chrome — no numbers, no findings. We fetch the landing page and
// extract the readable body so authoring has the actual highlights instead of a generic overview.
const DATA_SOURCE_HOSTS = ["apra.gov.au"]; // hosts whose RSS is known to carry only template chrome
const MAX_ENRICH = 8;       // bound page fetches per run (network time + politeness)
const ENRICH_CHARS = 2200;  // cap the extracted body kept on the pool item (keeps pool.json lean)
const EXCERPT_CHARS = 400;  // default cap for ordinary feed excerpts

// The Actuaries Institute publishes its policy work (submissions, dialogue papers, reports) as PDFs on
// this host, and its API `description` is a ~170-char blurb — too thin to write from. The author's
// WebFetch returns undecoded binary for a PDF, so if the substance isn't extracted HERE the source is
// decorative. Kept to its own budget so a slow PDF can't starve the APRA path (or vice versa).
const POLICY_ASSET_HOSTS = ["content.actuaries.asn.au"];
const MAX_POLICY_ENRICH = 4;        // policy items arrive ~8/month; 4 per run is ample headroom
const PDF_MAX_BYTES = 10_000_000;   // the Institute's flagship reports are chart-heavy: the
                                    // Intergenerational Equity Index is 5.4-7.0MB and Mortality in
                                    // Australia is 8.9MB — all life/super relevant, so don't cut them.
                                    // Safe because PDF_EXTRACT_CHARS (not size) bounds the real cost.
const PDF_EXTRACT_CHARS = 20_000;   // stop extracting here. Only ENRICH_CHARS (2.2k) is ever kept, and
                                    // extraction cost tracks stream COUNT, not bytes: a 5.4MB report
                                    // extracts in 0.3s while an 8.9MB one ran 64s to produce 190k chars
                                    // we then threw away. Bounding the work makes the run size-agnostic.
const PDF_TIMEOUT_MS = 15000;       // PDFs are bigger than pages; 8s isn't enough at ~250KB+
const PDF_MIN_WORDS = 150;          // below this the extraction is a failure, not a short document
const PDF_MIN_LEGIBLE = 0.5;        // letters / total chars — see pdfToText

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

// Raw inner text of a tag with NEWLINES PRESERVED (decode() collapses them) — for line-based cleaning.
const rawInner = (block, name) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1") : "";
};
// YouTube/video descriptions bury the substance under sponsor reads, promo codes, link dumps, hashtag
// piles and "chapters/socials" tails — each typically its own line. Drop those lines so the pooled
// excerpt LEADS with the actual topic. Falls back to the raw text if cleaning would gut it.
const JUNK_LINE = /https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.]+|sponsor|thanks to .*for|promo ?code|use code|coupon|\d+\s*% ?off|sign ?up|free trial|patreon|join (this|the) (channel|membership)|merch|my (course|newsletter|gear|kit)|newsletter|subscribe|follow (me|us)|email me|e-?mail|as featured|book a (call|consult|strategy|chat)|dm me|business (enquir|inquir)|socials?\b|instagram|twitter|tiktok|discord|^\s*#|want more|^\s*[-*•▶📸🎥🔗🗞🧠📚🔖👉🎬🛒💸▶️]|^\s*(chapters?|timestamps?)\b|^\s*\d{1,2}:\d{2}\b/i;
function cleanVideoDesc(raw) {
  const kept = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !JUNK_LINE.test(l));
  const cleaned = decode(kept.join("\n"));
  return cleaned.length >= 60 ? cleaned : decode(raw); // if we stripped too much, keep the original body
}

// The Actuaries Institute (actuaries.asn.au) publishes NO RSS — its own /feed and every sitemap path
// 503, and actuaries.digital now redirects into it, so the magazine has no feed at all. Its CMS
// (Kontent.ai) exposes a public, keyless, read-only Delivery API instead, which carries better metadata
// than RSS would: an editor-written `description`, a real `publish_date`, and a practice-area taxonomy.
// Detected by host so sources.json stays a plain list of URLs.
const isKontentFeed = (u) => /^https?:\/\/deliver\.kontent\.ai\//i.test(u);
// Delivery API items carry a slug, not a URL. Every `article` lives under this path (verified against
// the live site); if the Institute ever restructures, article URLs 404 and the author drops the source.
const KONTENT_ARTICLE_BASE = "https://www.actuaries.asn.au/research-analysis/";
const KONTENT_PUBLICATION = "Actuaries Digital (Actuaries Institute)";
// The Institute's `resource` items (submissions, dialogue/discussion papers, reports, media releases)
// store a URL with this literal placeholder in it, which the site resolves to its asset host.
const KONTENT_ASSET_TOKEN = "{{ACTUARIES_ASSET_SUBDOMAIN}}";
const KONTENT_ASSET_HOST = "https://content.actuaries.asn.au";
const KONTENT_POLICY_PUBLICATION = "Actuaries Institute";

// Map Delivery API JSON onto the same item shape parseFeed returns, so the rest of the pipeline
// (dedup, pooling, digest) treats it exactly like a feed. Handles BOTH Institute content types:
//   `article`  — the Actuaries Digital magazine. Has title + slug; URL is built from the slug.
//   `resource` — the policy/research library (Submissions, Dialogue Papers, Reports, Media Releases).
//                Has name + description + a url element; the target is a PDF on the asset host.
// Throws on malformed JSON — the caller already logs a failed source and moves on.
function parseKontent(text) {
  const json = JSON.parse(text);
  const items = [];
  for (const it of json.items || []) {
    const e = it.elements || {};
    const title = decode(e.title?.value || e.name?.value || it.system?.name || "");
    if (!title) continue;
    // practice_areas is the Institute's own taxonomy (Life Insurance, Superannuation and Investments,
    // Data Science and AI, …); content_types names the genre (Submission, Report, …). Both are kept so
    // the author can judge relevance and register before spending a fetch.
    const topics = [
      ...(e.content_types?.value || []).map((t) => t.name),
      ...(e.practice_areas?.value || []).map((t) => t.name),
    ].filter(Boolean);
    const slug = (e.slug?.value || "").trim();
    const rawUrl = (e.url?.value || "").trim();
    let url, kind, source;
    if (slug) {
      url = KONTENT_ARTICLE_BASE + slug;
      kind = "article";
      source = KONTENT_PUBLICATION;
    } else if (rawUrl.includes(KONTENT_ASSET_TOKEN) || rawUrl.startsWith(KONTENT_ASSET_HOST)) {
      // `policy` marks the profession's own position papers — the author's top-tier actuarial source.
      url = rawUrl.replace(KONTENT_ASSET_TOKEN, KONTENT_ASSET_HOST);
      kind = "policy";
      source = KONTENT_POLICY_PUBLICATION;
    } else continue; // no resolvable URL ⇒ not citable
    items.push({
      title,
      url,
      guid: it.system?.id || slug || url,
      published: e.publish_date?.value || e.created_date?.value || "",
      excerpt: decode(e.description?.value || "").slice(0, EXCERPT_CHARS),
      source,
      kind,
      ...(topics.length ? { topics } : {}),
    });
  }
  return items;
}

function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const title = tag(b, "title");
    const url = linkOf(b);
    const guid = tag(b, "guid") || tag(b, "id") || url;
    const published = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || "";
    // media:description is where YouTube (and other media RSS) carry the body — fall back to it (cleaned
    // of sponsor/link noise) so video items lead with substance instead of an empty or promo-laden excerpt.
    const articleDesc = tag(b, "description") || tag(b, "summary") || tag(b, "content");
    const mediaRaw = articleDesc ? "" : rawInner(b, "media:description");
    const excerpt = (articleDesc || (mediaRaw ? cleanVideoDesc(mediaRaw) : "")).slice(0, EXCERPT_CHARS);
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
// The honest fallback identity. Measured from a GitHub runner (2026-07-17), publishers disagree about
// which UA they trust, so there is no single right answer: nofilmschool.com 403s the Chrome UA from a
// datacenter IP (a browser that cannot exist there — it scores as a liar) but serves this one 200/30
// items, while insurancenews.com.au does the reverse and hangs on a bot UA. Hence per-response identity
// rather than a global switch: a global swap to this UA was measured to FIX 1 feed and BREAK 1.
// Self-identifying and truthful on purpose — impersonating Feedly also worked, but claiming to be
// someone else's crawler is not ours to do.
const BOT_UA = "CortexReader/1.0 (+https://t-reyn.github.io/personalised-reading/; personal reading list)";
// Retry ONLY what a second attempt can plausibly fix: 429/5xx and network/timeout errors. Google News
// 503s the whole batch when a run hits it too fast (13 feeds lost in one go on 2026-07-16), and one
// dropped feed silently thins the pool the author writes from. A 403/404 is a decision, not a blip —
// retrying it just burns the budget before the authoring step (see HANDOFF: the run is time-boxed).
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const FEED_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [400, 1200]; // bounded: worst case ~1.6s extra per persistently-failing feed
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOnce(url, ua) {
  const res = await fetch(url, {
    headers: { "User-Agent": ua, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status; // carried so the caller can tell a bot-block from a blip
    throw err;
  }
  return res.text();
}

async function fetchFeed(url) {
  let lastErr;
  for (let attempt = 0; attempt < FEED_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_BACKOFF_MS[attempt - 1]);
    try {
      return await fetchOnce(url, UA);
    } catch (e) {
      lastErr = e; // fetch rejects on DNS/socket/timeout — all worth one more go
      if (e.status !== undefined && !RETRY_STATUS.has(e.status)) break;
    }
  }
  // 403 means "I don't believe who you say you are" — the one status where changing IDENTITY, not
  // waiting, can help. So this is not a blind retry of the same request: it's the same request made
  // honestly, exactly once. Costs one extra call for a genuinely blocked feed (the Substacks 403 every
  // UA — that's an IP ban, unfixable here) and nothing at all for a feed that answers on the first try.
  if (lastErr?.status === 403) {
    try {
      return await fetchOnce(url, BOT_UA);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
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

// --- Minimal PDF text extraction (zero-dep; zlib is stdlib) --------------------------------------
// Enough to read the Institute's policy PDFs, and deliberately no more. It inflates each Flate stream
// and pulls the strings out of the text-showing operators (Tj / TJ / ' / "). It does NOT handle
// encryption, and it does NOT map CID/Identity-H fonts — those PDFs decode to glyph indices, which
// come out as mojibake rather than an error. Measured on 5 real Institute PDFs: 4 extract at 75-83%
// letters, 1 (CID-encoded) yields 0 real words. Hence isLegible below: the caller MUST gate on it,
// because the failure mode is silent garbage, and garbage in the pool is worse than a thin blurb.
// `maxChars` stops the walk early: only the first couple of thousand characters are ever kept, and a
// chart-heavy report can hold hundreds of thousands across hundreds of streams. Bail once we have
// enough to trim a lead from and judge legibility.
function pdfToText(buf, maxChars = Infinity) {
  const out = [];
  let got = 0;
  let i = 0;
  for (;;) {
    if (got >= maxChars) break;
    const s = buf.indexOf("stream", i);
    if (s === -1) break;
    let start = s + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const end = buf.indexOf("endstream", start);
    if (end === -1) break;
    const raw = buf.subarray(start, end);
    i = end + 9;
    let txt = null;
    for (const inflate of [zlib.inflateSync, zlib.inflateRawSync]) {
      try { txt = inflate(raw).toString("latin1"); break; } catch {} // not a Flate stream (image/font) — skip
    }
    if (!txt) continue;
    const parts = [];
    const re = /\(((?:\\.|[^\\()])*)\)\s*(?:Tj|'|")|\[([\s\S]*?)\]\s*TJ/g;
    let m;
    while ((m = re.exec(txt))) {
      if (m[1] !== undefined) parts.push(m[1]);
      else if (m[2] !== undefined) {
        const inner = /\(((?:\\.|[^\\()])*)\)/g;
        let k;
        while ((k = inner.exec(m[2]))) parts.push(k[1]);
      }
    }
    if (parts.length) {
      const chunk = parts.join("")
        .replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
        .replace(/\\([()\\])/g, "$1");
      out.push(chunk);
      got += chunk.length;
    }
  }
  return out.join("\n").replace(/\s+/g, " ").trim();
}

// An encrypted PDF inflates fine but every string is ciphertext, so this must be checked BEFORE
// trusting pdfToText. Roughly half the Institute's submissions carry /Encrypt.
const isEncryptedPdf = (buf) => buf.subarray(0, 2000).toString("latin1").includes("/Encrypt") ||
  buf.subarray(-2000).toString("latin1").includes("/Encrypt");

// Institute submissions open with ~400 chars of letterhead — postal address, phone, date, the
// addressee's department — before the position starts. The author's digest shows only the first 300
// chars of an excerpt, so without this it reads an address block instead of an argument. Same job as
// trimToBody does for HTML. Media releases have no letterhead and fall through unchanged.
const PDF_LEAD_MARKERS = ["Dear ", "welcomes the opportunity", "Executive summary", "Executive Summary", "Our submission"];
function trimPdfLead(text) {
  const t = text.replace(/^(?:en-[A-Z]{2})\s*/, ""); // stray xml:lang token from the content stream
  let start = -1;
  for (const m of PDF_LEAD_MARKERS) {
    const i = t.indexOf(m);
    if (i > 0 && i < 1500 && (start < 0 || i < start)) start = i;
  }
  if (start < 0) return t;
  // Back up to the start of the sentence so the excerpt doesn't open mid-clause.
  const stop = t.lastIndexOf(". ", start);
  return stop > 0 && start - stop < 200 ? t.slice(stop + 2) : t.slice(start);
}

// The garbage gate. CID-font PDFs return plenty of "text" that is not words, so length alone proves
// nothing — require that it reads like prose.
function isLegible(text) {
  if (!text) return false;
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const words = (text.match(/\b[A-Za-z]{3,}\b/g) || []).length;
  return words >= PDF_MIN_WORDS && letters / text.length >= PDF_MIN_LEGIBLE;
}

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

// Institute policy PDFs — same idea as needsEnrich, separate host list + separate budget.
function needsPolicyEnrich(item) {
  try {
    const hostname = new URL(item.url).hostname;
    return POLICY_ASSET_HOSTS.some((h) => hostMatches(hostname, h));
  } catch { return false; }
}

// Fetch a policy PDF and return its readable text, or null with a reason. Never throws for an expected
// condition — the caller keeps the API description when this returns null.
async function fetchPdfText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/pdf,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(PDF_TIMEOUT_MS),
  });
  if (!res.ok) return { text: null, reason: `HTTP ${res.status}` };
  // Bail on the outsized ones before buying the download.
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > PDF_MAX_BYTES) return { text: null, reason: `${(declared / 1e6).toFixed(1)}MB > cap` };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > PDF_MAX_BYTES) return { text: null, reason: `${(buf.length / 1e6).toFixed(1)}MB > cap` };
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return { text: null, reason: "not a PDF" };
  if (isEncryptedPdf(buf)) return { text: null, reason: "encrypted" };
  const text = pdfToText(buf, PDF_EXTRACT_CHARS);
  if (!isLegible(text)) return { text: null, reason: "unreadable fonts (CID/Identity-H)" };
  return { text: trimPdfLead(text), reason: null };
}

// Recency of an ITEM, for ranking the pool + digest. Prefer the article's own publication date over
// added_at (when we happened to fetch it): sorting on added_at ranks by feed position in sources.json,
// because every feed in a run is fetched seconds apart, so whichever source is listed LAST wins the
// per-interest cap. That silently starved the anchor sources listed first. Date.parse handles both
// RSS's RFC-822 and the ISO stamps the Delivery API returns; anything unparseable falls back to
// added_at, then to 0 (sorts last, never NaN — which would make the comparator non-deterministic).
function itemTime(it) {
  const published = Date.parse(it.published_at || "");
  if (Number.isFinite(published)) return published;
  const added = Date.parse(it.added_at || "");
  return Number.isFinite(added) ? added : 0;
}
const byNewestFirst = (a, b) => itemTime(b) - itemTime(a);

// Fill a capped slot budget ROUND-ROBIN across the feeds an interest draws from, newest-first within
// each feed, rather than by pure recency across all of them. Recency alone hands every slot to whichever
// source publishes most: a daily trade wire posting 15 items/day buried the Actuaries Institute (~4 a
// week) completely — the author's digest held zero Institute items while the Institute was nominally a
// source. Round-robin means volume buys reach, not exclusivity. The property that matters: when the cap
// is >= the feed count, EVERY feed gets at least one slot. (Feed visit order follows the items array —
// newest-item-first once the pool has been pruned once — so it is not sources.json order; that only
// decides who wins a leftover slot.) Legacy items with no `feed` share one bucket.
function capRoundRobin(items, cap) {
  const byFeed = new Map();
  for (const it of items) {
    const key = it.feed || "(unknown)";
    if (!byFeed.has(key)) byFeed.set(key, []);
    byFeed.get(key).push(it);
  }
  const queues = [...byFeed.values()];
  for (const q of queues) q.sort(byNewestFirst);
  const kept = [];
  for (let round = 0; kept.length < cap; round++) {
    let placed = false;
    for (const q of queues) {
      if (round >= q.length) continue;
      kept.push(q[round]);
      placed = true;
      if (kept.length >= cap) break;
    }
    if (!placed) break; // every queue exhausted
  }
  return kept.sort(byNewestFirst);
}

// Trim to a word boundary at or before `max` chars (never mid-word); append an ellipsis when cut.
function trimExcerpt(s = "", max = DIGEST_EXCERPT_CHARS) {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > 0 ? cut.slice(0, sp) : cut).replace(/[\s.,;:—-]+$/, "") + "…";
}

// Days since the interest last had a published article, from data/manifest.json. An article counts for
// an interest when the id appears in its `interests[]` (falling back to the primary `interest` field).
// null when the interest has never had an article.
function daysSinceLastArticle(manifest, interestId) {
  const arts = (manifest && manifest.articles) || [];
  let newest = "";
  for (const a of arts) {
    const ids = Array.isArray(a.interests) && a.interests.length ? a.interests : (a.interest ? [a.interest] : []);
    if (ids.includes(interestId) && a.created_at && a.created_at > newest) newest = a.created_at;
  }
  if (!newest) return null;
  return Math.floor((Date.now() - new Date(newest + "T00:00:00Z").getTime()) / 86400000);
}

// Author-facing pre-digested view of the pool: the freshest pending items per interest with trimmed
// excerpts, plus recency signal. The author reads this small file instead of re-parsing all of
// pool.json (only the excerpt is signal; the rest is bookkeeping), so cost stops scaling with pool size.
async function writePoolDigest(config, pool) {
  const manifest = await readJson("data/manifest.json", { articles: [] });
  const groups = {};
  for (const it of pool.items) if (it.status === "pending") (groups[it.interest] ||= []).push(it);
  const interests = {};
  for (const interest of config.interests || []) {
    // Round-robin here too, not just in the pool: the digest is the ONLY thing the author reads, so a
    // balanced pool still shows an all-one-source menu if the digest re-sorts it by pure recency.
    const items = capRoundRobin(groups[interest.id] || [], DIGEST_PER_INTEREST)
      .map((it) => ({
        id: it.id,
        title: it.title,
        excerpt: trimExcerpt(it.excerpt),
        url: it.url,
        kind: it.kind,
        ...(it.source ? { source: it.source } : {}),
        ...(it.topics?.length ? { topics: it.topics } : {}),
      }));
    interests[interest.id] = {
      days_since_last_article: daysSinceLastArticle(manifest, interest.id),
      items,
    };
  }
  const digest = { version: 1, generatedAt: new Date().toISOString(), interests };
  await writeFile(join(ROOT, "data/pool-digest.json"), JSON.stringify(digest, null, 2) + "\n");
  log(`  wrote pool-digest.json — ${Object.keys(interests).length} interest(s)`);
}

async function main() {
  const config = await readJson("data/config.json", { interests: [] });
  const sources = await readJson("data/sources.json", {});
  const seenState = await readJson("data/seen.json", { version: 1, seen: [] });
  const pool = await readJson("data/pool.json", { version: 1, items: [] });

  // seen.json dedup keys carry a timestamp so we can prune stale ones (it was an unbounded flat array,
  // committed every run). Accept BOTH the legacy flat string form and the new [{k, t}] form on load;
  // membership is still by key. `now` timestamps any legacy key + every newly-seen key.
  const now = new Date().toISOString();
  const seenTs = new Map();
  for (const e of seenState.seen || []) {
    if (typeof e === "string") seenTs.set(e, now);
    else if (e && typeof e.k === "string") seenTs.set(e.k, e.t || now);
  }
  const seen = { has: (k) => seenTs.has(k), add: (k) => seenTs.set(k, now) };

  let added = 0, fetched = 0, failed = 0;
  const freshlyAdded = [];
  for (const interest of config.interests || []) {
    const feeds = (sources[interest.id] || []).filter((u) => typeof u === "string" && u.startsWith("http"));
    for (const url of feeds) {
      let items;
      try {
        const raw = await fetchFeed(url);
        items = isKontentFeed(url) ? parseKontent(raw) : parseFeed(raw);
        fetched++;
      }
      catch (e) { failed++; log(`  ✗ ${interest.id} ${url} — ${e.message}`); continue; }

      let newForFeed = 0;
      for (const it of items) {
        const key = hash(it.guid || it.url);
        if (seen.has(key)) continue;
        seen.add(key);
        if (newForFeed >= PER_FEED_CAP) continue; // cap per feed: mark seen, don't pool beyond the cap
        const kind = it.kind || (isYouTubeFeed(url) ? "video" : "article");
        if (kind === "video" && /\/shorts\//i.test(it.url)) continue; // skip YouTube Shorts — too thin to synthesise (already marked seen above)
        const item = {
          id: `${interest.id}-${hash(it.guid || it.url)}`,
          interest: interest.id,
          feed: url, // which source produced it — drives the round-robin cap (see capRoundRobin)
          kind,
          title: it.title,
          url: it.url,
          // A parser-supplied publication name wins; otherwise a video's channel attributes it.
          ...(it.source ? { source: it.source } : kind === "video" && it.author ? { source: it.author } : {}),
          ...(it.topics?.length ? { topics: it.topics } : {}),
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
  let enriched = 0, attempts = 0, policyAttempts = 0;
  const enrichDeadline = Date.now() + 120_000;
  if (!DRY) for (const item of freshlyAdded) {
    if (Date.now() > enrichDeadline) break;
    // Institute policy PDFs: own budget, so neither path can exhaust the other's attempts.
    if (needsPolicyEnrich(item)) {
      if (policyAttempts >= MAX_POLICY_ENRICH) continue;
      policyAttempts++;
      try {
        const { text, reason } = await fetchPdfText(item.url);
        if (text) {
          item.excerpt = text.slice(0, ENRICH_CHARS);
          item.enriched_at = new Date().toISOString();
          enriched++;
          log(`  ↪ policy ${item.id} — ${item.excerpt.length} chars from PDF`);
        } else {
          // Keep the item: an Institute title + blurb is still a real lead the author can judge.
          log(`  · policy ${item.id} — ${reason}, kept API description`);
        }
      } catch (e) { log(`  ✗ policy ${item.id} — ${e.message}`); }
      continue;
    }
    if (attempts >= MAX_ENRICH) continue;
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
    const wouldPolicy = freshlyAdded.filter(needsPolicyEnrich).length;
    log(`  (dry-run: would attempt enrichment on up to ${Math.min(would, MAX_ENRICH)} of ${would} data-source item(s)` +
        `, and up to ${Math.min(wouldPolicy, MAX_POLICY_ENRICH)} of ${wouldPolicy} policy PDF(s))`);
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
    kept.push(...capRoundRobin(groups[k], MAX_PENDING_PER_INTEREST));
  }
  const pruned = beforePrune - kept.length;
  pool.items = kept;

  log(`\n${fetched} feed(s) fetched, ${failed} failed, ${added} new pending item(s), ${enriched} enriched, ${pruned} pruned, ${pool.items.length} in pool${DRY ? " (dry-run — nothing written)" : ""}`);
  if (DRY) { log("  (dry-run: skipping pool-digest.json write)"); return; }

  // Prune dedup keys not seen within the retention window, then persist the new [{k, t}] form. Keeps
  // seen.json from growing without bound; membership semantics are unchanged (still keyed on k).
  const seenCutoff = Date.now() - SEEN_TTL_DAYS * 86400000;
  seenState.seen = [...seenTs.entries()]
    .filter(([, t]) => { const ms = new Date(t).getTime(); return !Number.isFinite(ms) || ms >= seenCutoff; })
    .map(([k, t]) => ({ k, t }));
  pool.updatedAt = new Date().toISOString();
  await writeFile(join(ROOT, "data/seen.json"), JSON.stringify(seenState, null, 2) + "\n");
  await writeFile(join(ROOT, "data/pool.json"), JSON.stringify(pool, null, 2) + "\n");
  await writePoolDigest(config, pool);
}

export { parseFeed, parseKontent, isYouTubeFeed, isKontentFeed, capRoundRobin, itemTime, pdfToText, isLegible, trimPdfLead, fetchFeed };

// Run the pipeline only when invoked directly (node scripts/ingest.mjs), so tests can import
// parseFeed without triggering a live fetch + file writes.
let invokedDirectly = false;
try { invokedDirectly = realpathSync(process.argv[1] || "") === realpathSync(fileURLToPath(import.meta.url)); } catch {}
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
