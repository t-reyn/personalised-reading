#!/usr/bin/env node
// Fetch a small set of KEYLESS live market datapoints → data/live.json, so the daily authoring step
// can ground time-sensitive ("current") finance / markets / property pieces in today's actual figures
// instead of whatever an RSS feed happened to cache.
//
// Zero dependencies (Node 20+ global fetch + stdlib). Best-effort by design: a source that fails
// (timeout, 403/429 from a datacentre IP — Yahoo sometimes blocks CI) is skipped, never fatal, and the
// file is still written with whatever succeeded. Run from the daily routine right after ingest:
//   node scripts/fetch-live.mjs            fetch + write data/live.json
//   node scripts/fetch-live.mjs --dry-run  fetch + report, write nothing
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const log = (...a) => console.log(...a);

// Yahoo Finance chart endpoint (keyless). dp = decimals to round/display; unit annotates non-obvious quotes.
const YAHOO = [
  { symbol: "^AXJO", label: "ASX 200", dp: 1 },
  { symbol: "^GSPC", label: "S&P 500", dp: 1 },
  { symbol: "AUDUSD=X", label: "AUD/USD", dp: 4 },
  { symbol: "GC=F", label: "Gold", dp: 1, unit: "USD/oz" },
  { symbol: "CL=F", label: "WTI", dp: 2, unit: "USD/bbl" },
  { symbol: "^VIX", label: "VIX", dp: 2 },
];

const fmt = (n, dp) => Number(n).toLocaleString("en-AU", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const sign = (n) => (n >= 0 ? "+" : "");
const changePct = (price, prev) => (prev == null || price == null || !prev ? null : ((price - prev) / prev) * 100);

async function getJson(url, ms = 12000) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchYahoo(it) {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(it.symbol)}?range=2d&interval=1d`);
  const m = j?.chart?.result?.[0]?.meta;
  if (!m || m.regularMarketPrice == null) throw new Error("no price in response");
  const price = m.regularMarketPrice;
  const chg = changePct(price, m.chartPreviousClose ?? null);
  return {
    symbol: it.symbol, label: it.label, currency: m.currency || "", unit: it.unit || null,
    price: +Number(price).toFixed(it.dp),
    changePct: chg == null ? null : +chg.toFixed(2),
    display: `${fmt(price, it.dp)}${chg == null ? "" : ` (${sign(chg)}${chg.toFixed(1)}%)`}`,
  };
}

async function fetchCrypto() {
  const c = await getJson("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=aud,usd&include_24hr_change=true");
  const out = [];
  for (const [id, label] of [["bitcoin", "Bitcoin"], ["ethereum", "Ethereum"]]) {
    const d = c[id];
    if (!d || d.aud == null) continue;
    const chg = d.aud_24h_change ?? null;
    out.push({
      id, label, aud: d.aud, usd: d.usd,
      changePct: chg == null ? null : +chg.toFixed(2),
      display: `A$${fmt(d.aud, 0)}${chg == null ? "" : ` (${sign(chg)}${chg.toFixed(1)}%)`}`,
    });
  }
  return out;
}

async function main() {
  const markets = [];
  for (const it of YAHOO) {
    try { const q = await fetchYahoo(it); markets.push(q); log(`  ✓ ${q.label} ${q.display}`); }
    catch (e) { log(`  ✗ ${it.label} (${it.symbol}) — ${e.message}`); }
  }

  let crypto = [];
  try { crypto = await fetchCrypto(); crypto.forEach((x) => log(`  ✓ ${x.label} ${x.display}`)); }
  catch (e) { log(`  ✗ crypto — ${e.message}`); }

  const asOf = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short" }).format(new Date());
  const summary = [...markets.map((m) => `${m.label} ${m.display}`), ...crypto.map((c) => `${c.label} ${c.display}`)].join(" · ");
  const out = { version: 1, updatedAt: new Date().toISOString(), asOf: `${asOf} AEST`, markets, crypto, summary };

  log(`\n${markets.length} market(s) + ${crypto.length} crypto fetched${DRY ? " (dry-run — nothing written)" : ""}`);
  if (summary) log(`summary: ${summary}`);
  if (DRY) return;
  await writeFile(join(ROOT, "data/live.json"), JSON.stringify(out, null, 2) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
