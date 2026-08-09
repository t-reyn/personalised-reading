#!/usr/bin/env node
// Should today's issue be written, or is the reader behind? Deterministic + zero tokens —
// generate.yml runs this before spending a Claude run.
//
//   node scripts/backlog.mjs            # human-readable, always exit 0
//   node scripts/backlog.mjs --github   # also append skip=/unread= to $GITHUB_OUTPUT
//
// Reads data/reading-state.json, which is materialised from the private cortex-state repo.
// If it is missing we WRITE rather than skip: a state-fetch problem must never silently
// stop the product (the run would rather publish an extra issue than go quiet unnoticed).
import { readFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backlogDecision } from "./lib/backlog.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (p) => JSON.parse(await readFile(join(ROOT, p), "utf8"));
const tryJson = async (p) => {
  try {
    return await readJson(p);
  } catch {
    return null;
  }
};

const config = (await tryJson("data/config.json")) || {};
const manifest = (await tryJson("data/manifest.json")) || {};
const state = await tryJson("data/reading-state.json");

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Sydney",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

// Tunable in config.json without touching the workflow.
const window = config.backlog?.window ?? 5;
const threshold = config.backlog?.threshold ?? 3;

let decision;
if (!state) {
  decision = { skip: false, unread: 0, considered: 0, window, reason: "reading-state.json missing — writing rather than going quiet" };
} else {
  decision = backlogDecision(manifest.articles || [], state.articles || {}, { window, threshold, today });
}

console.log(`${decision.skip ? "SKIP" : "WRITE"} — ${decision.reason}`);
if (decision.unreadIds?.length) console.log(`  unread: ${decision.unreadIds.join(", ")}`);

if (process.argv.includes("--github") && process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `backlog_skip=${decision.skip}\nbacklog_unread=${decision.unread}\nbacklog_window=${decision.window}\n`);
}
