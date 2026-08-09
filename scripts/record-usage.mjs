#!/usr/bin/env node
// Append one row per run to data/usage-log.jsonl, summed across the run's Claude steps.
//
//   node scripts/record-usage.mjs research=/path/research.json author=/path/author.json
//
// Replaces the inline jq block generate.yml used while there was exactly one Claude step. With the
// pipeline split into research + author there are two execution files, and the row has to stay
// comparable with 50+ rows of history: the top-level fields are still the run's TOTALS (every
// existing reading of this file keeps working) and a new `phases` object carries the split, which is
// the number that actually answers "is research or writing the expensive half?".
//
// Missing files are normal, not an error — a timed-out step often leaves no execution output at all,
// which is precisely why 12 of the first 52 rows logged nulls. Absent phases are recorded as null so
// a gap stays visible instead of reading as a cheap run.
import { readFile, appendFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const FIELDS = {
  input: (u) => u.input_tokens,
  output: (u) => u.output_tokens,
  cache_read: (u) => u.cache_read_input_tokens,
  cache_creation: (u) => u.cache_creation_input_tokens,
};

// The action writes a JSON array of stream events; the last `result` event carries the totals.
async function readPhase(path) {
  if (!path) return null;
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  // The action has emitted both a JSON array and newline-delimited JSON across versions, and the
  // jq block this replaces (`jq -s 'flatten | …'`) quietly accepted either. Keep doing that.
  let list;
  try {
    const parsed = JSON.parse(raw);
    list = Array.isArray(parsed) ? parsed.flat() : [parsed];
  } catch {
    list = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }
  const result = list.filter((e) => e && e.type === "result").pop();
  if (!result) return null;
  const u = result.usage || {};
  const phase = { cost_usd: result.total_cost_usd ?? null, turns: result.num_turns ?? null };
  for (const [name, pick] of Object.entries(FIELDS)) phase[name] = pick(u) ?? null;
  return phase;
}

const args = process.argv.slice(2).filter((a) => a.includes("="));
const phases = {};
for (const a of args) {
  const i = a.indexOf("=");
  phases[a.slice(0, i)] = await readPhase(a.slice(i + 1));
}

const sum = (key) => {
  const values = Object.values(phases).map((p) => p?.[key]).filter((v) => typeof v === "number");
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
};

const syd = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
let articles = 0;
try {
  articles = (await readdir(join(ROOT, "articles", syd))).filter((f) => f.endsWith(".html")).length;
} catch {
  /* no folder = no issue today */
}

const row = {
  date: new Date().toISOString().slice(0, 10),
  articles,
  cost_usd: sum("cost_usd"),
  input: sum("input"),
  output: sum("output"),
  cache_read: sum("cache_read"),
  cache_creation: sum("cache_creation"),
  turns: sum("turns"),
  model: "sonnet",
  phases,
};

await appendFile(join(ROOT, "data/usage-log.jsonl"), JSON.stringify(row) + "\n");
console.log(`usage row: ${JSON.stringify(row)}`);
for (const [name, p] of Object.entries(phases)) if (!p) console.warn(`! no execution output for the ${name} step — its tokens are missing from this row`);
