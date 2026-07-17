// Tests for the ingest pipeline's pure helpers. Lives under scripts/lib/ because CI runs
// `node --test scripts/lib/*.test.mjs`; ingest.mjs guards its main() so importing it is side-effect free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKontent, isKontentFeed, capRoundRobin, itemTime } from "../ingest.mjs";

const KONTENT_URL =
  "https://deliver.kontent.ai/4f4649d8-6df9-023d-bb6c-14e842b8aadb/items?system.type=article&order=elements.publish_date[desc]";

test("isKontentFeed matches the Delivery API host only", () => {
  assert.equal(isKontentFeed(KONTENT_URL), true);
  assert.equal(isKontentFeed("https://www.apra.gov.au/rss.xml"), false);
  // Must not match a lookalike host that merely contains the string.
  assert.equal(isKontentFeed("https://evil.com/deliver.kontent.ai/items"), false);
});

test("parseKontent maps Delivery API items onto the feed item shape", () => {
  const items = parseKontent(
    JSON.stringify({
      items: [
        {
          system: { id: "abc-123", name: "fallback name" },
          elements: {
            title: { value: "How will your FCR consider Quantum Computing?" },
            slug: { value: "quantum-computing-fcr-risk" },
            description: { value: "Quantum computers could soon break today's encryption." },
            publish_date: { value: "2026-07-14T14:00:00Z" },
            practice_areas: { value: [{ name: "Life Insurance" }, { name: "Risk Management" }] },
          },
        },
      ],
    })
  );
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    title: "How will your FCR consider Quantum Computing?",
    url: "https://www.actuaries.asn.au/research-analysis/quantum-computing-fcr-risk",
    guid: "abc-123",
    published: "2026-07-14T14:00:00Z",
    excerpt: "Quantum computers could soon break today's encryption.",
    source: "Actuaries Digital (Actuaries Institute)",
    topics: ["Life Insurance", "Risk Management"],
  });
});

test("parseKontent skips items with no slug (no resolvable URL to cite)", () => {
  const items = parseKontent(
    JSON.stringify({
      items: [
        { system: { id: "1" }, elements: { title: { value: "Untitled draft" }, slug: { value: "" } } },
        { system: { id: "2" }, elements: { title: { value: "Real" }, slug: { value: "real-one" } } },
      ],
    })
  );
  assert.deepEqual(items.map((i) => i.guid), ["2"]);
});

test("parseKontent tolerates missing optional elements", () => {
  const items = parseKontent(
    JSON.stringify({ items: [{ system: { id: "9" }, elements: { title: { value: "T" }, slug: { value: "s" } } }] })
  );
  assert.equal(items[0].excerpt, "");
  assert.equal(items[0].published, "");
  assert.equal(items[0].topics, undefined); // omitted, not an empty array
});

test("itemTime prefers the article's own date, falls back to added_at, never NaN", () => {
  assert.equal(itemTime({ published_at: "2026-07-14T00:00:00Z", added_at: "2026-01-01T00:00:00Z" }),
    Date.parse("2026-07-14T00:00:00Z"));
  // RSS RFC-822 and the API's ISO stamps must both parse.
  assert.equal(itemTime({ published_at: "Mon, 14 Jul 2026 10:00:00 GMT" }), Date.parse("2026-07-14T10:00:00Z"));
  assert.equal(itemTime({ published_at: "not a date", added_at: "2026-02-02T00:00:00Z" }),
    Date.parse("2026-02-02T00:00:00Z"));
  assert.equal(itemTime({}), 0);
});

test("capRoundRobin gives a low-volume feed a slot against a firehose", () => {
  // The regression this exists for: a trade wire posting daily buried the Institute's ~weekly output.
  const firehose = Array.from({ length: 30 }, (_, i) => ({
    feed: "wire",
    title: `wire ${i}`,
    published_at: `2026-07-${String(16 - (i % 10)).padStart(2, "0")}T00:00:00Z`,
  }));
  const anchor = [{ feed: "institute", title: "institute piece", published_at: "2026-07-10T00:00:00Z" }];
  const kept = capRoundRobin([...firehose, ...anchor], 8);
  assert.equal(kept.length, 8);
  assert.ok(kept.some((i) => i.feed === "institute"), "the anchor source must survive the cap");
});

test("capRoundRobin spreads slots evenly and respects the cap", () => {
  const items = [];
  for (const feed of ["a", "b", "c"]) {
    for (let i = 0; i < 5; i++) items.push({ feed, title: `${feed}${i}`, published_at: `2026-07-0${i + 1}T00:00:00Z` });
  }
  const kept = capRoundRobin(items, 6);
  assert.equal(kept.length, 6);
  for (const feed of ["a", "b", "c"]) {
    assert.equal(kept.filter((i) => i.feed === feed).length, 2, `feed ${feed} should get an equal share`);
  }
});

test("capRoundRobin takes newest first within a feed and returns newest-first overall", () => {
  const items = [
    { feed: "a", title: "old", published_at: "2026-01-01T00:00:00Z" },
    { feed: "a", title: "new", published_at: "2026-07-01T00:00:00Z" },
  ];
  const kept = capRoundRobin(items, 1);
  assert.deepEqual(kept.map((i) => i.title), ["new"]);
  assert.deepEqual(capRoundRobin(items, 2).map((i) => i.title), ["new", "old"]);
});

test("capRoundRobin terminates when the cap exceeds the item count", () => {
  const kept = capRoundRobin([{ feed: "a", published_at: "2026-07-01T00:00:00Z" }], 50);
  assert.equal(kept.length, 1);
});

test("capRoundRobin buckets legacy items with no feed together", () => {
  const kept = capRoundRobin([{ published_at: "2026-07-01T00:00:00Z" }, { published_at: "2026-07-02T00:00:00Z" }], 2);
  assert.equal(kept.length, 2);
});
