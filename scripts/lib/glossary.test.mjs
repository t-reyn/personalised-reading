// Unit tests for the glossary helpers. Zero-dep: run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { glossaryDefects, glossaryRunway } from "./glossary.mjs";

const mk = (n, start = "2026-07-03") => ({
  version: 2,
  start_date: start,
  topup: { min_runway_days: 30, batch_min: 60, batch_max: 90 },
  batches: [{ added: start, count: n }],
  terms: Array.from({ length: n }, (_, i) => ({ term: `term-${i}`, def: `def ${i}`, eg: `eg ${i}` })),
});
// A well-formed top-up of `prev`: terms appended AND the batch logged, as GLOSSARY.md requires.
const topup = (prev, n) => {
  const g = mk(prev.terms.length + n, prev.start_date);
  g.batches = [...prev.batches, { added: "2026-12-21", count: n }];
  return g;
};

test("glossaryDefects passes a well-formed glossary", () => {
  assert.deepEqual(glossaryDefects(mk(3)), []);
});

test("glossaryDefects flags structural problems", () => {
  assert.match(glossaryDefects(null)[0], /not an object/);
  assert.match(glossaryDefects({ start_date: "2026-07-03" })[0], /non-empty array/);
  assert.match(glossaryDefects(mk(2, "03/07/2026"))[0], /invalid start_date/);
  const missing = mk(2);
  missing.terms[1].def = "  ";
  assert.match(glossaryDefects(missing)[0], /terms\[1\].*"def"/);
});

test("glossaryDefects flags duplicate terms case-insensitively", () => {
  const g = mk(3);
  g.terms[2].term = "  TERM-0 ";
  assert.match(glossaryDefects(g)[0], /duplicate term/);
});

test("glossaryDefects enforces append-only against a previous snapshot", () => {
  const prev = mk(3);
  assert.deepEqual(glossaryDefects(topup(prev, 2), prev), []); // clean append + logged batch
  assert.match(glossaryDefects(mk(2), prev)[0], /shrank/);
  assert.match(glossaryDefects(topup({ ...prev, start_date: "2026-07-04" }, 2), { ...prev })[0], /start_date changed/);
  const reordered = topup(prev, 2);
  [reordered.terms[0], reordered.terms[1]] = [reordered.terms[1], reordered.terms[0]];
  assert.match(glossaryDefects(reordered, prev)[0], /renamed\/reordered/);
  assert.match(glossaryDefects(mk(3), prev)[0], /no terms appended/);
});

test("glossaryDefects enforces a truthful batches log and frozen topup config", () => {
  const prev = mk(3);
  const unlogged = mk(5); // terms appended but batches log untouched
  assert.match(glossaryDefects(unlogged, prev)[0], /batches log must gain exactly one entry/);
  const miscounted = topup(prev, 2);
  miscounted.batches[miscounted.batches.length - 1].count = 9;
  assert.match(glossaryDefects(miscounted, prev)[0], /says count 9 but 2/);
  const tampered = topup(prev, 2);
  tampered.topup = { min_runway_days: 1 };
  assert.match(glossaryDefects(tampered, prev)[0], /topup config changed/);
  const badLog = mk(3);
  badLog.batches = [{ added: "yesterday", count: 0 }];
  const ds = glossaryDefects(badLog);
  assert.match(ds[0], /invalid "added" date/);
  assert.match(ds[1], /"count" must be a positive integer/);
});

test("glossaryDefects allows def/eg touch-ups to existing entries", () => {
  const prev = mk(3);
  const g = topup(prev, 1);
  g.terms[1].def = "a clearer definition"; // typo fixes are fine — only term names are frozen
  assert.deepEqual(glossaryDefects(g, prev), []);
});

test("glossaryRunway counts unseen terms including today's", () => {
  const g = mk(10);
  assert.equal(glossaryRunway(g, "2026-07-03"), 10); // day 0: all 10 ahead
  assert.equal(glossaryRunway(g, "2026-07-12"), 1);  // day 9: the last term shows today
  assert.equal(glossaryRunway(g, "2026-07-13"), 0);  // day 10: wrapped
  assert.equal(glossaryRunway(g, "2026-08-01"), 0);  // never negative
  assert.equal(glossaryRunway(g, "2026-07-01"), 10); // clock skew before start: clamps, no crash
  assert.equal(glossaryRunway({ start_date: "nope", terms: g.terms }, "2026-07-03"), 0);
});
