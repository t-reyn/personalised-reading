// Zero-LLM, zero-dependency integrity check for the generated site + state.
// Exits non-zero on any problem so the GitHub Action fails and emails the owner.
// Run: node scripts/health-check.mjs   (env: HEALTH_FRESH_DAYS default 2; HEALTH_REQUIRE_TODAY=1 to
//                                       also require an article dated today, Sydney or UTC)
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const FRESH_DAYS = Number(process.env.HEALTH_FRESH_DAYS) || 2;
const REQUIRE_TODAY = process.env.HEALTH_REQUIRE_TODAY === "1";
const HARDEN_FROM = "2026-07-02"; // stricter source/length/spelling rules apply to articles created on/after this
const problems = [];
const notes = [];
const warnings = [];
const fail = (m) => problems.push(m);
const ok = (m) => notes.push(m);
const warn = (m) => warnings.push(m);

// today's date (YYYY-MM-DD) in a given IANA zone — used to accept either the Sydney or the UTC date
// around the day boundary, so a run straddling midnight isn't flagged as stale.
const dateIn = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const TODAY = new Set([dateIn("Australia/Sydney"), dateIn("UTC")]);

// Readable body text of an article: prefer the <article> region (falls back to full doc), drop
// script/style blocks and comments, strip tags, decode nothing (word counts don't need it), collapse
// whitespace. The #meta JSON lives in a <script> so it's excluded from the count.
const bodyText = (html) => {
  const art = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html);
  return (art ? art[1] : html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};
const wordCount = (text) => (text ? text.split(" ").length : 0);

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
  const AU_DRIFT = /\b(color|center|organiz|analyz|behavior)\b/; // US spellings the en-AU voice should avoid

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
    const hardened = (a.created_at || "") >= HARDEN_FROM; // stricter rules only for new articles
    // 3. Every TAUGHT concept must be registered in the knowledge graph (the generator
    //    adds these; drift means "learnt" tracking + stats silently miss it).
    for (const cid of a.concepts_taught || []) {
      if (!concepts[cid]) fail(`article ${a.id} teaches unregistered concept "${cid}" (add it to knowledge.json)`);
    }
    // 3b. Every ASSUMED concept must also be registered — the app gates on these, so an unregistered
    //     prerequisite silently breaks gating. (Mirrors the taught check.)
    for (const cid of meta.concepts_assumed || []) {
      if (!concepts[cid]) fail(`article ${a.id} assumes unregistered concept "${cid}" (add it to knowledge.json)`);
    }
    // 3c. Every REINFORCED concept (spaced-repetition review woven into a later article) must also
    //     be registered — it's meant to reference an already-taught concept, never a new one.
    for (const cid of meta.concepts_reinforced || []) {
      if (!concepts[cid]) fail(`article ${a.id} reinforces unregistered concept "${cid}" (add it to knowledge.json)`);
    }
    // 4. Quick-check well-formedness for EVERY article: a non-empty question, exactly four options,
    //    and an integer answer index in range — a malformed quiz breaks the "learnt" gate.
    (meta.quick_check || []).forEach((q, i) => {
      const where = `${a.id} quick_check[${i}]`;
      if (!q || typeof q.q !== "string" || !q.q.trim()) fail(`${where}: empty question`);
      if (!Array.isArray(q.options) || q.options.length !== 4) fail(`${where}: options must be an array of 4`);
      if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct > 3) fail(`${where}: correct must be an integer 0..3`);
    });
    // 5. Stricter content rules for articles created on/after the hardening date (older ones are
    //    grandfathered): real https sources, and a substantial body.
    if (hardened) {
      for (const s of meta.sources || []) {
        const url = (s && s.url) || "";
        if (/example\.com/i.test(url)) fail(`${a.id}: placeholder source url ${url}`);
        if (!/^https:\/\//i.test(url)) fail(`${a.id}: non-https source url ${url || "(missing)"}`);
      }
      const body = bodyText(html);
      const wc = wordCount(body);
      // NB these thresholds are in THIS function's units, which are NOT the contract's. bodyText()
      // counts the whole <article> region — h1, summary and the sources footer included — and measures
      // ~100 words above the "body text" AUTHORING.md bands refer to (measured 57–111, median 101
      // across the actuarial set). So the contract's 1,100 ceiling is ~1,200 here, and a position
      // piece's 1,000-word floor is ~1,100 here. Keep the two in step if either band moves.
      const position = meta.shape === "position";
      const ceiling = position ? 1500 : 1200;
      if (wc < 450) fail(`${a.id}: body word count ${wc} < 450`);
      else if (position && wc < 1100) warn(`${a.id}: position piece word count ${wc} — under the ~1,000-word floor`);
      else if (wc > ceiling) warn(`${a.id}: body word count ${wc} > ${ceiling}`);
      if (AU_DRIFT.test(body)) warn(`${a.id}: body contains US spelling (color/center/organiz/analyz/behavior)`);
    }
  }

  // 6. Same-day freshness (opt-in): after the morning run, at least one article should carry today's
  //    date (Sydney or UTC, for the transition). A hard fail so a silently-skipped run is caught.
  if (REQUIRE_TODAY) {
    const hasToday = arts.some((a) => TODAY.has(a.created_at));
    if (hasToday) ok(`same-day freshness OK — an article is dated ${[...TODAY].join(" or ")}`);
    else fail(`no article dated today (${[...TODAY].join(" or ")}) — today's run may have been skipped`);
  }

  // 7. Freshness: the newest article should be recent, or the morning run likely failed.
  const newest = arts.map((a) => a.created_at).filter(Boolean).sort().pop();
  if (!newest) fail("no article has a created_at date");
  else {
    const ageDays = Math.floor((Date.now() - new Date(newest + "T00:00:00Z").getTime()) / 86400000);
    if (ageDays > FRESH_DAYS) fail(`newest article is ${ageDays} days old (> ${FRESH_DAYS}) — the daily generator may be failing. Newest: ${newest}`);
    else ok(`freshness OK — newest article ${newest} (${ageDays}d old)`);
  }

  // 8. Answer-position skew: across the 20 most-recent quick-check questions, every index 0..3 should
  //    appear at least once — a persistent gap suggests the author is parking the answer in one slot.
  const recent = arts
    .filter((a) => a.created_at)
    .sort((x, y) => (x.created_at < y.created_at ? 1 : -1))
    .slice(0, 20);
  const positions = [];
  for (const a of recent) {
    const file = join(ROOT, a.path);
    if (!existsSync(file)) continue;
    const m = META_RE.exec(readFileSync(file, "utf8"));
    if (!m) continue;
    let meta; try { meta = JSON.parse(m[1]); } catch { continue; }
    for (const q of meta.quick_check || []) {
      if (Number.isInteger(q.correct)) positions.push(q.correct);
      if (positions.length >= 20) break;
    }
    if (positions.length >= 20) break;
  }
  if (positions.length >= 4) {
    const missing = [0, 1, 2, 3].filter((i) => !positions.includes(i));
    if (missing.length) warn(`answer-position skew: index ${missing.join(",")} never appears in the last ${positions.length} quick-check answers`);
  }

  ok(`checked ${arts.length} articles, ${Object.keys((knowledge && knowledge.concepts) || {}).length} concepts`);
}

// Report (also to the GitHub job summary when available).
const lines = [];
lines.push(problems.length ? `# ❌ Cortex health check failed (${problems.length})` : "# ✅ Cortex health check passed");
for (const p of problems) lines.push(`- ❌ ${p}`);
for (const w of warnings) lines.push(`- ⚠️ ${w}`);
for (const n of notes) lines.push(`- ✅ ${n}`);
const report = lines.join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  try { (await import("node:fs")).appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n"); } catch {}
}
process.exit(problems.length ? 1 : 0);
