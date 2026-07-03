#!/usr/bin/env node
// Validate data/glossary.json and report the top-up runway (days of unseen terms left).
// Usage: node scripts/glossary-check.mjs [--runway] [--prev <file>] [--today YYYY-MM-DD]
//   --runway   print just the runway number (for shell comparisons) — still exits 1 on defects
//   --prev     also enforce the append-only contract against a pre-top-up snapshot
//   --today    override "today" (defaults to the current date in Australia/Sydney)
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { glossaryDefects, glossaryRunway } from "./lib/glossary.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);

const today = valueOf("--today") || new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
const g = JSON.parse(await readFile(join(ROOT, "data/glossary.json"), "utf8"));
const prevPath = valueOf("--prev");
const prev = prevPath ? JSON.parse(await readFile(prevPath, "utf8")) : null;

const defects = glossaryDefects(g, prev);
const runway = glossaryRunway(g, today);

if (args.includes("--runway")) {
  console.log(runway);
} else {
  for (const d of defects) console.error(`⛔ glossary: ${d}`);
  console.log(`glossary: ${g.terms?.length ?? 0} term(s), ${runway} day(s) of unseen terms left as of ${today}` +
    (prev ? ` (+${(g.terms?.length ?? 0) - (prev.terms?.length ?? 0)} this top-up)` : ""));
}
process.exit(defects.length ? 1 : 0);
