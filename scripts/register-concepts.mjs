#!/usr/bin/env node
// Deterministic safety net for the authoring contract's "register every taught/assumed concept"
// rule: scan all articles' #meta and add any missing concept ids to data/knowledge.json as
// is_learnt:false. Additive only — never flips or removes anything (the browser owns learnt state).
// Run after the author step; health-check.mjs then verifies rather than fails the morning email.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const KNOWLEDGE = join(ROOT, "data", "knowledge.json");

const knowledge = JSON.parse(readFileSync(KNOWLEDGE, "utf8"));
knowledge.concepts ||= {};

const added = [];
const articlesDir = join(ROOT, "articles");
for (const day of readdirSync(articlesDir)) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
  for (const file of readdirSync(join(articlesDir, day))) {
    if (!file.endsWith(".html")) continue;
    const html = readFileSync(join(articlesDir, day, file), "utf8");
    const m = html.match(/<script[^>]*id="meta"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) continue;
    let meta;
    try { meta = JSON.parse(m[1]); } catch { continue; }
    for (const id of [...(meta.concepts_taught || []), ...(meta.concepts_assumed || [])]) {
      if (!knowledge.concepts[id]) {
        knowledge.concepts[id] = { is_learnt: false };
        added.push(`${id} (${meta.id})`);
      }
    }
  }
}

if (added.length) {
  knowledge.updatedAt = new Date().toISOString();
  writeFileSync(KNOWLEDGE, JSON.stringify(knowledge, null, 2) + "\n");
  console.log(`✓ registered ${added.length} missing concept(s):`);
  for (const a of added) console.log(`  + ${a}`);
} else {
  console.log("✓ all taught/assumed concepts already registered");
}
