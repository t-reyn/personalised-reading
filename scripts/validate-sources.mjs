#!/usr/bin/env node
// Validate candidate feeds proposed by the scout (data/source-candidates.json) and append the working
// ones to data/sources.json. A feed qualifies only if it returns HTTP 200 AND contains >=1 item/entry.
// Zero-dep. After running, the candidates file is cleared. Usage: node scripts/validate-sources.mjs
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_FEEDS_PER_INTEREST = 12; // don't let the scout balloon any one tab
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const readJson = async (p, fb) => {
  try { return JSON.parse(await readFile(join(ROOT, p), "utf8")); } catch { return fb; }
};

async function feedHasItems(url) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return false;
    const t = await r.text();
    return /<(item|entry)\b/i.test(t);
  } catch {
    return false;
  }
}

async function main() {
  const candidates = await readJson("data/source-candidates.json", {});
  const sources = await readJson("data/sources.json", {});
  const existing = new Set(Object.values(sources).flatMap((v) => (Array.isArray(v) ? v : [])));

  let added = 0, rejected = 0, skipped = 0;
  for (const [interest, urls] of Object.entries(candidates)) {
    if (interest.startsWith("_")) continue;
    if (!Array.isArray(sources[interest])) { console.log(`· skip unknown interest "${interest}"`); continue; }
    for (const url of urls || []) {
      if (typeof url !== "string" || !url.startsWith("http")) { rejected++; continue; }
      if (existing.has(url)) { skipped++; continue; }
      if (sources[interest].length >= MAX_FEEDS_PER_INTEREST) { console.log(`· ${interest} at cap, skipping ${url}`); skipped++; continue; }
      if (await feedHasItems(url)) {
        sources[interest].push(url);
        existing.add(url);
        added++;
        console.log(`✓ added   [${interest}] ${url}`);
      } else {
        rejected++;
        console.log(`✗ rejected [${interest}] ${url}`);
      }
    }
  }

  await writeFile(join(ROOT, "data/sources.json"), JSON.stringify(sources, null, 2) + "\n");
  await writeFile(
    join(ROOT, "data/source-candidates.json"),
    JSON.stringify({ _comment: "The scout writes candidate feeds here as {interestId:[urls]}; validate-sources.mjs validates + appends the working ones to sources.json, then clears this file." }, null, 2) + "\n",
  );
  console.log(`\nscout validate: ${added} added, ${rejected} rejected, ${skipped} skipped (dup/cap)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
