// Zero-LLM, zero-dependency integrity check for the generated site + state.
// Exits non-zero on any problem so the GitHub Action fails and emails the owner.
// Run: node scripts/health-check.mjs   (env: HEALTH_FRESH_DAYS, default 2)
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const FRESH_DAYS = Number(process.env.HEALTH_FRESH_DAYS) || 2;
const problems = [];
const notes = [];
const fail = (m) => problems.push(m);
const ok = (m) => notes.push(m);

function readJson(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) { fail(`missing file: ${rel}`); return null; }
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { fail(`invalid JSON in ${rel}: ${e.message}`); return null; }
}

const manifest = readJson("data/manifest.json");
const knowledge = readJson("data/knowledge.json");
const reading = readJson("data/reading-state.json");
readJson("data/config.json");

// 1. State files are well-formed.
if (knowledge && typeof knowledge.concepts !== "object") fail("knowledge.json has no concepts object");
if (reading && (typeof reading.articles !== "object" || typeof reading.quizzes !== "object")) fail("reading-state.json missing articles/quizzes");

if (manifest && Array.isArray(manifest.articles)) {
  const arts = manifest.articles;
  if (manifest.count !== arts.length) fail(`manifest count (${manifest.count}) != articles length (${arts.length})`);
  const concepts = (knowledge && knowledge.concepts) || {};
  const META_RE = /<script\s+type="application\/json"\s+id="meta">([\s\S]*?)<\/script>/i;

  for (const a of arts) {
    if (!a.path) { fail(`article ${a.id} has no path`); continue; }
    const file = join(ROOT, a.path);
    if (!existsSync(file)) { fail(`article file missing: ${a.path}`); continue; }
    // 2. Every article's inline #meta parses and matches its manifest id.
    const html = readFileSync(file, "utf8");
    const m = META_RE.exec(html);
    if (!m) { fail(`no #meta block in ${a.path}`); continue; }
    let meta;
    try { meta = JSON.parse(m[1]); }
    catch (e) { fail(`bad #meta JSON in ${a.path}: ${e.message}`); continue; }
    if (meta.id !== a.id) fail(`#meta id (${meta.id}) != manifest id (${a.id}) in ${a.path}`);
    // 3. Every TAUGHT concept must be registered in the knowledge graph (the generator
    //    adds these; drift means "learnt" tracking + stats silently miss it). Assumed
    //    concepts are allowed to be external prerequisites, so they're not required here.
    for (const cid of a.concepts_taught || []) {
      if (!concepts[cid]) fail(`article ${a.id} teaches unregistered concept "${cid}" (add it to knowledge.json)`);
    }
  }

  // 4. Freshness: the newest article should be recent, or the morning run likely failed.
  const newest = arts.map((a) => a.created_at).filter(Boolean).sort().pop();
  if (!newest) fail("no article has a created_at date");
  else {
    const ageDays = Math.floor((Date.now() - new Date(newest + "T00:00:00Z").getTime()) / 86400000);
    if (ageDays > FRESH_DAYS) fail(`newest article is ${ageDays} days old (> ${FRESH_DAYS}) — the daily generator may be failing. Newest: ${newest}`);
    else ok(`freshness OK — newest article ${newest} (${ageDays}d old)`);
  }
  ok(`checked ${arts.length} articles, ${Object.keys((knowledge && knowledge.concepts) || {}).length} concepts`);
}

// Report (also to the GitHub job summary when available).
const lines = [];
lines.push(problems.length ? `# ❌ Cortex health check failed (${problems.length})` : "# ✅ Cortex health check passed");
for (const p of problems) lines.push(`- ❌ ${p}`);
for (const n of notes) lines.push(`- ✅ ${n}`);
const report = lines.join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  try { (await import("node:fs")).appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n"); } catch {}
}
process.exit(problems.length ? 1 : 0);
