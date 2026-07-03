// Unit tests for the glossary helpers. Zero-dep: run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { glossaryDefects, glossaryRunway } from "./glossary.mjs";

const mk = (n, start = "2026-07-03") => ({
  version: 2,
  start_date: start,
  terms: Array.from({ length: n }, (_, i) => ({ term: `term-${i}`, def: `def ${i}`, eg: `eg ${i}` })),
});

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
  assert.deepEqual(glossaryDefects(mk(5), prev), []); // clean append
  assert.match(glossaryDefects(mk(2), prev)[0], /shrank/);
  assert.match(glossaryDefects(mk(5, "2026-07-04"), prev)[0], /start_date changed/);
  const reordered = mk(5);
  [reordered.terms[0], reordered.terms[1]] = [reordered.terms[1], reordered.terms[0]];
  assert.match(glossaryDefects(reordered, prev)[0], /renamed\/reordered/);
  assert.match(glossaryDefects(mk(3), prev)[0], /no terms appended/);
});

test("glossaryDefects allows def/eg touch-ups to existing entries", () => {
  const prev = mk(3);
  const g = mk(4);
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
