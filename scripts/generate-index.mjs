#!/usr/bin/env node
// Scan articles/ → build index.html, feed.xml, sitemap.xml, data/manifest.json.
// Usage: node scripts/generate-index.mjs [--strict]
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanArticles } from "./lib/articles.mjs";
import { buildManifest, buildFeedXml, buildSitemapXml, buildIndexHtml, buildServiceWorker } from "./lib/render.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");

const BLOCKING = /not valid JSON|no #meta|missing "(id|slug|interest|title|created_at)"|unfilled/;

async function main() {
  const config = JSON.parse(await readFile(join(ROOT, "data/config.json"), "utf8"));
  const now = new Date().toISOString();
  const items = await scanArticles(join(ROOT, "articles"), ROOT);

  let warnings = 0;
  let blocking = 0;
  for (const it of items) {
    for (const w of it.warnings) {
      const isBlock = BLOCKING.test(w);
      if (isBlock) blocking++;
      else warnings++;
      console.log(`${isBlock ? "⛔" : "⚠️ "} ${it.path}: ${w}`);
    }
  }

  // Only fully-valid articles make it into the published artifacts.
  const usable = items.filter((i) => i.meta && i.meta.id && i.meta.slug && !BLOCKING.test(i.warnings.join(" ")));

  const manifest = buildManifest(usable, now);
  await writeFile(join(ROOT, "data/manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(ROOT, "feed.xml"), buildFeedXml(usable, config, now));
  await writeFile(join(ROOT, "sitemap.xml"), buildSitemapXml(usable, config, now));
  await writeFile(join(ROOT, "index.html"), buildIndexHtml(config, { count: manifest.count }, now));
  await writeFile(join(ROOT, "sw.js"), buildServiceWorker(now));

  console.log(`\n✓ ${manifest.count} article(s) → index.html, feed.xml, sitemap.xml, data/manifest.json`);
  if (warnings || blocking) console.log(`  ${warnings} warning(s), ${blocking} blocking defect(s)`);

  if (blocking) {
    console.error(`\n✗ ${blocking} blocking defect(s) — fix before committing.`);
    process.exit(1);
  }
  if (STRICT && warnings) {
    console.error(`\n✗ --strict: ${warnings} warning(s) treated as errors.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
