// Unit tests for the backlog guard. Zero-dep: run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unreadInWindow, backlogDecision } from "./backlog.mjs";

// Issues newest-first: 2026-08-09 down to 2026-08-01.
const issues = (n = 9) =>
  Array.from({ length: n }, (_, i) => ({
    id: `a${i}`,
    created_at: `2026-08-${String(n - i).padStart(2, "0")}`,
  }));

const read = (...ids) => Object.fromEntries(ids.map((id) => [id, { status: "read" }]));

test("only the N newest issues are judged", () => {
  // a0 is the newest; a5..a8 are older than the 5-issue window.
  const r = unreadInWindow(issues(), read("a5", "a6", "a7", "a8"), { window: 5 });
  assert.equal(r.considered, 5);
  assert.equal(r.unread, 5, "reads outside the window must not count as keeping up");
});

test("reads inside the window reduce the count", () => {
  const r = unreadInWindow(issues(), read("a0", "a1", "a2"), { window: 5 });
  assert.deepEqual(r.unreadIds, ["a3", "a4"]);
});

test("an auto-archived (expired unread) issue still counts as unread", () => {
  const state = { a0: { status: "unread", archived_at: "2026-08-30T00:00:00Z" } };
  assert.equal(unreadInWindow(issues(), state, { window: 5 }).unread, 5);
});

test("issues dated after today are ignored", () => {
  const r = unreadInWindow(issues(), {}, { window: 5, today: "2026-08-05" });
  assert.equal(r.considered, 5);
  assert.ok(!r.unreadIds.includes("a0"), "2026-08-09 is in the future relative to today");
});

test("skips once the threshold is met, writes below it", () => {
  const all = issues();
  assert.equal(backlogDecision(all, read("a0", "a1"), { window: 5, threshold: 3 }).skip, true, "3 unread => skip");
  assert.equal(backlogDecision(all, read("a0", "a1", "a2"), { window: 5, threshold: 3 }).skip, false, "2 unread => write");
});

test("the guard recovers — reading enough restarts publishing", () => {
  const all = issues();
  const paused = backlogDecision(all, {}, { window: 5, threshold: 3 });
  assert.equal(paused.skip, true);
  const resumed = backlogDecision(all, read("a0", "a1", "a2"), { window: 5, threshold: 3 });
  assert.equal(resumed.skip, false, "a paused guard MUST be able to unpause, or it kills the product");
});

test("never gates before the window has filled (fresh install can publish)", () => {
  const d = backlogDecision(issues(2), {}, { window: 5, threshold: 3 });
  assert.equal(d.skip, false);
  assert.match(d.reason, /below the 5-issue window/);
});

test("missing/empty inputs are safe and never skip", () => {
  assert.equal(backlogDecision([], {}, { window: 5, threshold: 3 }).skip, false);
  assert.equal(backlogDecision(undefined, undefined, { window: 5, threshold: 3 }).skip, false);
});
