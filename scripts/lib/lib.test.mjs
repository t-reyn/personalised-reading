// Unit tests for the shared build helpers. Zero-dep: run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, stripHtml, slugify, truncate, humanDate, toRfc822, hasRawEntity } from "./text.mjs";

test("escapeHtml escapes the five special characters", () => {
  assert.equal(escapeHtml(`<a href="x">A & B's</a>`), "&lt;a href=&quot;x&quot;&gt;A &amp; B&#39;s&lt;/a&gt;");
  assert.equal(escapeHtml(""), "");
});

test("stripHtml removes tags, decodes entities, collapses whitespace", () => {
  assert.equal(stripHtml("<p>Hello&nbsp;&amp; <b>world</b></p>"), "Hello & world");
  assert.equal(stripHtml("a   b\n c"), "a b c");
  assert.equal(stripHtml("<![CDATA[raw]]>".replace(/<!\[CDATA\[|\]\]>/g, "")), "raw");
});

test("slugify lowercases, hyphenates, trims", () => {
  assert.equal(slugify("The IFRS 17 CSM, in plain terms!"), "the-ifrs-17-csm-in-plain-terms");
  assert.equal(slugify("  --Hello--  World  "), "hello-world");
  assert.equal(slugify("café & crème"), "caf-cr-me");
});

test("truncate adds an ellipsis only when over the limit", () => {
  assert.equal(truncate("hello", 10), "hello");
  assert.equal(truncate("hello world", 6), "hello…");
  assert.equal(truncate("hello…", 6).length <= 6, true);
});

test("toRfc822 renders an RFC-822 date", () => {
  assert.match(toRfc822("2026-06-25"), /25 Jun 2026/);
  assert.match(toRfc822("not-a-date"), /1970/); // invalid → epoch fallback
});

test("humanDate formats an ISO date (en-AU)", () => {
  assert.equal(humanDate("2026-06-25"), "25 June 2026");
  assert.equal(humanDate(""), "");
});

test("hasRawEntity flags leaked HTML entities in plain-text fields", () => {
  assert.equal(hasRawEntity("plain text, no entities"), false);
  assert.equal(hasRawEntity("Q&A and AT&T"), false); // ampersand without a closing ; is fine
  assert.equal(hasRawEntity("a &amp; b"), true);
  assert.equal(hasRawEntity("price &minus;5"), true);
});
