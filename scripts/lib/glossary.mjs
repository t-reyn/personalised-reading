// Glossary ("dev term of the day") helpers: structural validation + top-up runway.
// Used by scripts/glossary-check.mjs as the CI gate for batch top-ups. Pure, zero-dep.

const DAY_MS = 86400000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// Structural defects in a glossary object. With `prev` (a snapshot from before a top-up),
// also enforces the append-only contract: start_date frozen, existing entries frozen in
// place, and at least one term actually appended.
export function glossaryDefects(g, prev = null) {
  if (!g || typeof g !== "object") return ["glossary is not an object"];
  const out = [];
  if (!ISO_DAY.test(g.start_date || "") || !Number.isFinite(Date.parse(g.start_date))) {
    out.push(`invalid start_date "${g.start_date}" (need YYYY-MM-DD)`);
  }
  const batches = Array.isArray(g.batches) ? g.batches : null;
  if (!batches || !batches.length) out.push("batches must be a non-empty array");
  else batches.forEach((b, i) => {
    if (!ISO_DAY.test(b?.added || "")) out.push(`batches[${i}]: invalid "added" date "${b?.added}"`);
    if (!Number.isInteger(b?.count) || b.count < 1) out.push(`batches[${i}]: "count" must be a positive integer`);
  });
  const terms = Array.isArray(g.terms) ? g.terms : null;
  if (!terms || !terms.length) return [...out, "terms must be a non-empty array"];
  const seen = new Map();
  terms.forEach((t, i) => {
    for (const k of ["term", "def", "eg"]) {
      if (typeof t?.[k] !== "string" || !t[k].trim()) out.push(`terms[${i}]: missing/empty "${k}"`);
    }
    const key = (t?.term || "").trim().toLowerCase();
    if (!key) return;
    if (seen.has(key)) out.push(`terms[${i}]: duplicate term "${t.term}" (first at index ${seen.get(key)})`);
    else seen.set(key, i);
  });
  if (prev) {
    if (prev.start_date !== g.start_date) {
      out.push(`start_date changed (${prev.start_date} → ${g.start_date}) — it anchors which term shows on which day`);
    }
    const p = Array.isArray(prev.terms) ? prev.terms : [];
    if (terms.length < p.length) out.push(`terms shrank (${p.length} → ${terms.length}) — top-ups are append-only`);
    for (let i = 0; i < Math.min(p.length, terms.length); i++) {
      if ((terms[i]?.term || "") !== (p[i]?.term || "")) {
        out.push(`terms[${i}] renamed/reordered ("${p[i]?.term}" → "${terms[i]?.term}") — existing entries are frozen`);
        break;
      }
    }
    if (terms.length === p.length && !out.length) out.push("no terms appended — the top-up did nothing");
    // The header is frozen too: topup config must survive a batch, and the batches log must
    // truthfully record exactly this top-up (it's the audit trail of what ran when).
    if (JSON.stringify(g.topup ?? null) !== JSON.stringify(prev.topup ?? null)) {
      out.push("topup config changed — a top-up may only append terms and log its batch");
    }
    const pb = Array.isArray(prev.batches) ? prev.batches : [];
    if (batches && terms.length > p.length) {
      const last = batches[batches.length - 1];
      if (batches.length !== pb.length + 1) out.push(`batches log must gain exactly one entry per top-up (${pb.length} → ${batches.length})`);
      else if (last?.count !== terms.length - p.length) out.push(`batches log entry says count ${last?.count} but ${terms.length - p.length} term(s) were appended`);
    }
  }
  return out;
}

// Days of not-yet-shown terms remaining as of `today` (YYYY-MM-DD), counting today's term.
// Counts every calendar day since start_date as consumed — the app actually advances only on
// days the banner is seen (app.js seen_days), so this is a conservative floor: real runway is
// never shorter. 0 means the banner is already wrapping back to the oldest terms.
export function glossaryRunway(g, today) {
  const start = Date.parse(g?.start_date || "");
  if (!Number.isFinite(start) || !Number.isFinite(Date.parse(today || ""))) return 0;
  const shown = Math.max(0, Math.round((Date.parse(today) - start) / DAY_MS));
  return Math.max(0, (g.terms?.length || 0) - shown);
}
