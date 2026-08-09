// Unit tests for the research-brief header parser. Zero-dep: run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBriefMeta } from "./brief.mjs";

const header = (obj) => `<!-- meta: ${JSON.stringify(obj)} -->\n\n# Brief — 2026-08-10\n\n## Angle\n…\n`;

const full = {
  interest: "actuarial",
  pick: "primary",
  mode: "learn",
  shape: "position",
  angle: "Default TPD cover prices a population the experience data cannot see",
  used_item_ids: ["actuarial-aa11", "actuarial-bb22"],
};

test("parses a well-formed header", () => {
  const meta = parseBriefMeta(header(full));
  assert.equal(meta.interest, "actuarial");
  assert.equal(meta.pick, "primary");
  assert.equal(meta.mode, "learn");
  assert.equal(meta.shape, "position");
  assert.deepEqual(meta.used_item_ids, ["actuarial-aa11", "actuarial-bb22"]);
});

test("tolerates leading blank lines and loose whitespace in the comment", () => {
  const meta = parseBriefMeta(`\n\n<!--   meta:   {"interest":"design","used_item_ids":[]}   -->\n# Brief\n`);
  assert.equal(meta.interest, "design");
  assert.deepEqual(meta.used_item_ids, []);
});

test("a learn piece with no pool items is valid — used_item_ids defaults to empty", () => {
  const meta = parseBriefMeta(header({ interest: "design", mode: "learn" }));
  assert.deepEqual(meta.used_item_ids, []);
  assert.equal(meta.pick, "primary", "pick defaults to primary");
  assert.equal(meta.shape, null);
});

test("duplicate item ids collapse (they'd be consumed once anyway)", () => {
  const meta = parseBriefMeta(header({ interest: "finance", used_item_ids: ["a", "a", " a ", "b"] }));
  assert.deepEqual(meta.used_item_ids, ["a", "b"]);
});

test("an unknown mode/pick degrades to null/primary rather than throwing", () => {
  const meta = parseBriefMeta(header({ interest: "finance", mode: "opinion", pick: "third" }));
  assert.equal(meta.mode, null);
  assert.equal(meta.pick, "primary");
});

test("throws when the header is missing entirely", () => {
  assert.throws(() => parseBriefMeta("# Brief — 2026-08-10\n\n## Angle\n"), /no `<!-- meta/);
});

test("throws on malformed JSON rather than consuming nothing silently", () => {
  assert.throws(() => parseBriefMeta(`<!-- meta: {"interest":"finance",} -->`), /not valid JSON/);
});

test("throws when interest is missing or blank", () => {
  assert.throws(() => parseBriefMeta(header({ used_item_ids: [] })), /missing "interest"/);
  assert.throws(() => parseBriefMeta(header({ interest: "   " })), /missing "interest"/);
});

test("refuses a used_item_ids that is not a list of ids — consuming the wrong items is unrecoverable", () => {
  assert.throws(() => parseBriefMeta(header({ interest: "finance", used_item_ids: "a,b" })), /must be an array/);
  assert.throws(() => parseBriefMeta(header({ interest: "finance", used_item_ids: [{ id: "a" }] })), /non-empty strings/);
  assert.throws(() => parseBriefMeta(header({ interest: "finance", used_item_ids: [""] })), /non-empty strings/);
});
