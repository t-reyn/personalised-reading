// Tests for the pure transcript helpers (no network). The fetch path is validated empirically —
// locally it works, from GitHub runners YouTube answers LOGIN_REQUIRED (see HANDOFF.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTimedText, pickTrack, videoId } from "./transcripts.mjs";

test("parseTimedText reads srv1 (<text>) — the legacy web format", () => {
  const xml = `<?xml version="1.0"?><transcript><text start="0" dur="2">Hello &amp; welcome</text><text start="2" dur="3">to <i>the</i> show</text></transcript>`;
  assert.equal(parseTimedText(xml), "Hello & welcome to the show");
});

test("parseTimedText reads srv3 (<p>/<s> word segments) — what the ANDROID client serves", () => {
  const xml = `<timedtext format="3"><head><ws id="0"/></head><body><p t="80" d="5120"><s ac="0">hey</s><s t="160"> what&#39;s</s><s t="320"> up</s></p><p t="5200" d="2000"><s>second</s><s> cue</s></p></body></timedtext>`;
  assert.equal(parseTimedText(xml), "hey what's up second cue");
});

test("pickTrack prefers human captions over ASR, English over other languages", () => {
  const asrEn = { languageCode: "en", kind: "asr" };
  const manualEn = { languageCode: "en-US" };
  const manualDe = { languageCode: "de" };
  assert.equal(pickTrack([asrEn, manualEn, manualDe]), manualEn);
  assert.equal(pickTrack([asrEn, manualDe]), asrEn, "an English ASR track beats a foreign manual one");
  assert.equal(pickTrack([]), null);
});

test("videoId handles watch, youtu.be and shorts URLs", () => {
  assert.equal(videoId("https://www.youtube.com/watch?v=8R6fYMJLI5E"), "8R6fYMJLI5E");
  assert.equal(videoId("https://youtu.be/8R6fYMJLI5E?t=1"), "8R6fYMJLI5E");
  assert.equal(videoId("https://www.youtube.com/shorts/8R6fYMJLI5E"), "8R6fYMJLI5E");
  assert.equal(videoId("https://example.com/not-a-video"), null);
});
