#!/usr/bin/env node
// TEMPORARY diagnostic — delete once the blocked feeds are fixed.
// Round 2: the candidate fix is a global User-Agent change (an honest self-identifying bot UA beat the
// Chrome UA on nofilmschool: 403 -> 200). A global UA swap touches EVERY feed, so before shipping it we
// must prove it regresses nothing — especially the Google News queries that supply most interests.
// Fetches every feed in sources.json under both UAs, from a datacenter IP, and flags any regression.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const CURRENT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CANDIDATE_UA = "CortexReader/1.0 (+https://t-reyn.github.io/personalised-reading/; personal reading list; contact via repo)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(url, ua) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": ua, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.text();
    // A 200 carrying no items is a failure dressed as success (challenge page / empty shell).
    let items = (body.match(/<item\b|<entry\b/gi) || []).length;
    if (body.trimStart().startsWith("{")) {
      try { items = JSON.parse(body)?.items?.length ?? 0; } catch { items = 0; }
    }
    return { ok: res.ok, status: res.status, items };
  } catch (e) {
    return { ok: false, status: "ERR", items: 0, err: e.message };
  }
}

const sources = JSON.parse(await readFile(join(ROOT, "data/sources.json"), "utf8"));
const feeds = [];
for (const [interest, list] of Object.entries(sources)) {
  if (interest.startsWith("_")) continue;
  for (const url of list) if (typeof url === "string" && url.startsWith("http")) feeds.push({ interest, url });
}

console.log(`Probing ${feeds.length} feeds x 2 UAs from a GitHub runner.\n`);
console.log("  status: CURRENT(chrome) -> CANDIDATE(honest bot)\n");

const regressions = [], fixes = [], both = [];
for (const { interest, url } of feeds) {
  const a = await probe(url, CURRENT_UA);
  await sleep(300);
  const b = await probe(url, CANDIDATE_UA);
  await sleep(300);

  const host = new URL(url).hostname.replace(/^www\./, "");
  const label = `${interest}/${host}`.padEnd(46);
  const verdict =
    a.ok && !b.ok ? "REGRESSION" :
    !a.ok && b.ok ? "FIX" :
    a.ok && b.ok ? "both ok" : "both fail";
  if (verdict === "REGRESSION") regressions.push({ interest, url, a, b });
  if (verdict === "FIX") fixes.push({ interest, url, a, b });
  if (verdict === "both fail") both.push({ interest, url });

  console.log(`  ${label} ${String(a.status).padEnd(4)}(${String(a.items).padStart(3)}) -> ${String(b.status).padEnd(4)}(${String(b.items).padStart(3)})  ${verdict}`);
}

console.log(`\n===== SUMMARY =====`);
console.log(`  fixed by the candidate UA : ${fixes.length}`);
for (const f of fixes) console.log(`      + ${f.interest} ${f.url}`);
console.log(`  REGRESSED by candidate UA : ${regressions.length}`);
for (const r of regressions) console.log(`      ! ${r.interest} ${r.url} (${r.a.status} -> ${r.b.status})`);
console.log(`  still failing under both  : ${both.length}`);
for (const b of both) console.log(`      x ${b.interest} ${b.url}`);
console.log(`\n  VERDICT: ${regressions.length === 0 ? "candidate UA is safe to ship" : "candidate UA REGRESSES feeds — do not ship as-is"}`);
