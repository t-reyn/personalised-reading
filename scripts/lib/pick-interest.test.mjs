// Unit tests for the interest picker. Zero-dep: run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreInterests, latestInterest, feedbackSummary, enrichItems, buildDigestToday } from "./pick-interest.mjs";

const interests = [
  { id: "software-ai", label: "Software, AI", mode: "both", cadenceDays: 7 },
  { id: "finance", label: "Finance", mode: "current", cadenceDays: 12 },
  { id: "design", label: "Design", mode: "learn", cadenceDays: 10 },
];

test("never-served (null days_since) ranks first as Infinity", () => {
  const digest = {
    "software-ai": { days_since_last_article: 3, items: [] },
    finance: { days_since_last_article: null, items: [{ id: "x" }] }, // current, non-empty pool
    design: { days_since_last_article: 5, items: [] },
  };
  const ranked = scoreInterests(interests, digest);
  assert.equal(ranked[0].id, "finance");
  assert.equal(ranked[0].score, Infinity);
});

test("missing digest entry is treated as never-served with an empty pool", () => {
  const ranked = scoreInterests(
    [{ id: "science", label: "Science", mode: "learn", cadenceDays: 21 }],
    {} // no entry at all for "science"
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].daysSince, null);
  assert.equal(ranked[0].score, Infinity);
});

test("excludeId drops that interest outright", () => {
  const digest = {
    "software-ai": { days_since_last_article: 10, items: [] },
    finance: { days_since_last_article: 1, items: [{ id: "x" }] },
    design: { days_since_last_article: 1, items: [] },
  };
  const ranked = scoreInterests(interests, digest, { excludeId: "software-ai" });
  assert.ok(!ranked.some((r) => r.id === "software-ai"));
  assert.equal(ranked.length, 2);
});

test("current mode with an empty pool is excluded; learn mode with an empty pool is kept", () => {
  const digest = {
    "software-ai": { days_since_last_article: 1, items: [] },
    finance: { days_since_last_article: 1, items: [] }, // current + empty ⇒ can't be served
    design: { days_since_last_article: 1, items: [] }, // learn + empty ⇒ fine
  };
  const ranked = scoreInterests(interests, digest);
  assert.ok(!ranked.some((r) => r.id === "finance"), "current mode must be excluded when its pool is empty");
  assert.ok(ranked.some((r) => r.id === "design"), "learn mode must survive an empty pool");
  assert.ok(ranked.some((r) => r.id === "software-ai"), "both mode must survive an empty pool");
});

test("score ordering: highest days_since / cadenceDays wins", () => {
  const digest = {
    "software-ai": { days_since_last_article: 7, items: [] }, // 7/7 = 1.0
    finance: { days_since_last_article: 12, items: [{ id: "x" }] }, // 12/12 = 1.0
    design: { days_since_last_article: 20, items: [] }, // 20/10 = 2.0
  };
  const ranked = scoreInterests(interests, digest);
  assert.equal(ranked[0].id, "design");
  assert.equal(ranked[0].score, 2);
});

test("tie on score falls back to days_since desc, then config-array order", () => {
  // software-ai and design both score exactly 1.0 (7/7 and 10/10) with equal days_since (7 vs 10 —
  // NOT equal), so this exercises the days_since tiebreak: design (10) must outrank software-ai (7).
  const digest = {
    "software-ai": { days_since_last_article: 7, items: [] },
    finance: { days_since_last_article: 24, items: [{ id: "x" }] }, // 24/12 = 2.0, ranks first outright
    design: { days_since_last_article: 10, items: [] },
  };
  const ranked = scoreInterests(interests, digest);
  assert.deepEqual(ranked.map((r) => r.id), ["finance", "design", "software-ai"]);
});

test("a full tie (score AND days_since) preserves config-array order", () => {
  const same = [
    { id: "a", label: "A", mode: "learn", cadenceDays: 10 },
    { id: "b", label: "B", mode: "learn", cadenceDays: 10 },
    { id: "c", label: "C", mode: "learn", cadenceDays: 10 },
  ];
  const digest = {
    a: { days_since_last_article: 5, items: [] },
    b: { days_since_last_article: 5, items: [] },
    c: { days_since_last_article: 5, items: [] },
  };
  const ranked = scoreInterests(same, digest);
  assert.deepEqual(ranked.map((r) => r.id), ["a", "b", "c"]);
});

test("latestInterest picks the newest article by created_at", () => {
  const articles = [
    { id: "1", interest: "design", created_at: "2026-08-01" },
    { id: "2", interest: "finance", created_at: "2026-08-09" },
    { id: "3", interest: "science", created_at: "2026-08-05" },
  ];
  assert.deepEqual(latestInterest(articles), { interest: "finance", created_at: "2026-08-09" });
});

test("latestInterest returns null for no articles", () => {
  assert.equal(latestInterest([]), null);
  assert.equal(latestInterest(undefined), null);
});

test("feedbackSummary maps read / expired-unread / unread / unknown status", () => {
  const articles = [
    { id: "read-1", interest: "finance", created_at: "2026-08-04", title: "Read one", tags: [] },
    { id: "archived-1", interest: "finance", created_at: "2026-08-03", title: "Archived one", tags: [] },
    { id: "untouched-1", interest: "finance", created_at: "2026-08-02", title: "Untouched one", tags: [] },
    { id: "other-1", interest: "design", created_at: "2026-08-09", title: "Wrong interest", tags: [] },
  ];
  const state = {
    articles: {
      "read-1": { status: "read" },
      "archived-1": { status: "archived" },
    },
    quizzes: {},
  };
  const summary = feedbackSummary(articles, state, "finance");
  assert.equal(summary.length, 3, "only the primary-interest articles are included");
  const byId = Object.fromEntries(summary.map((s) => [s.id, s]));
  assert.equal(byId["read-1"].status, "read");
  assert.equal(byId["archived-1"].status, "expired-unread");
  assert.equal(byId["untouched-1"].status, "unread");
});

test("feedbackSummary reports unknown status when reading-state is null", () => {
  const articles = [{ id: "a", interest: "finance", created_at: "2026-08-01", title: "A", tags: [] }];
  const summary = feedbackSummary(articles, null, "finance");
  assert.equal(summary[0].status, "unknown");
});

test("feedbackSummary carries feedback, starred, and failed-quiz concepts", () => {
  const articles = [
    {
      id: "a",
      interest: "finance",
      created_at: "2026-08-01",
      title: "A",
      tags: ["x"],
      mode: "current",
      concepts_taught: ["marginal-barrel-pricing"],
    },
  ];
  const state = {
    articles: { a: { status: "read", feedback: "down", starred: true } },
    quizzes: { a: { passed: false } },
  };
  const [s] = feedbackSummary(articles, state, "finance");
  assert.equal(s.feedback, "down");
  assert.equal(s.starred, true);
  assert.deepEqual(s.failed_quiz_concepts, ["marginal-barrel-pricing"]);
});

test("feedbackSummary yields no failed-quiz concepts when the quiz passed or was never taken", () => {
  const articles = [
    { id: "a", interest: "finance", created_at: "2026-08-01", title: "A", tags: [], concepts_taught: ["c1"] },
    { id: "b", interest: "finance", created_at: "2026-08-02", title: "B", tags: [], concepts_taught: ["c2"] },
  ];
  const state = { articles: {}, quizzes: { a: { passed: true } } }; // b was never taken
  const byId = Object.fromEntries(feedbackSummary(articles, state, "finance").map((s) => [s.id, s]));
  assert.deepEqual(byId.a.failed_quiz_concepts, []);
  assert.deepEqual(byId.b.failed_quiz_concepts, []);
});

test("feedbackSummary respects the limit and sorts newest first", () => {
  const articles = Array.from({ length: 10 }, (_, i) => ({
    id: `a${i}`,
    interest: "finance",
    created_at: `2026-08-${String(i + 1).padStart(2, "0")}`,
    title: `A${i}`,
    tags: [],
  }));
  const summary = feedbackSummary(articles, null, "finance", { limit: 3 });
  assert.deepEqual(summary.map((s) => s.id), ["a9", "a8", "a7"]);
});

test("enrichItems restores transcript_at, date and publication from the pool record", () => {
  const digestItems = [
    { id: "v1", title: "A video", excerpt: "…", url: "https://youtube.com/watch?v=1", kind: "video", source: "Dwarkesh Patel" },
    { id: "p1", title: "A paper", excerpt: "…", url: "https://example.org/p", kind: "policy" },
  ];
  const poolItems = [
    { id: "v1", published_at: "2026-08-07T04:00:00.000Z", transcript_at: "2026-08-08T19:15:00.000Z", source: "Dwarkesh Patel" },
    { id: "p1", published_at: "2026-08-05T00:00:00.000Z", source: "Actuaries Institute", topics: ["Submission", "Life Insurance"] },
  ];
  const [video, policy] = enrichItems(digestItems, poolItems);
  assert.equal(video.transcript_at, "2026-08-08T19:15:00.000Z");
  assert.equal(video.date, "2026-08-07");
  assert.equal(video.publication, "Dwarkesh Patel");
  assert.equal(policy.transcript_at, undefined, "a non-video must not carry a transcript stamp");
  assert.deepEqual(policy.topics, ["Submission", "Life Insurance"]);
  assert.equal(policy.publication, "Actuaries Institute");
});

test("enrichItems normalises RFC-822 dates — most feeds emit them, not ISO", () => {
  // 135 of the 192 items in the real pool are RFC-822. A naive slice(0,10) yields "Thu, 06 Au":
  // no year, no parseable day, and the researcher uses this field to judge whether a lead is stale.
  const items = [
    { id: "a", title: "T", excerpt: "e", url: "https://x/a" },
    { id: "b", title: "T", excerpt: "e", url: "https://x/b" },
    { id: "c", title: "T", excerpt: "e", url: "https://x/c" },
    { id: "d", title: "T", excerpt: "e", url: "https://x/d" },
  ];
  const pool = [
    { id: "a", published_at: "Thu, 06 Aug 2026 13:08:25 +0000" },
    { id: "b", published_at: "Sat, 08 Aug 2026 18:46:28 GMT" },
    { id: "c", published_at: "2026-08-07T04:00:00.000Z" },
    { id: "d", published_at: "not a date at all" },
  ];
  const [a, b, c, d] = enrichItems(items, pool);
  assert.equal(a.date, "2026-08-06");
  assert.equal(b.date, "2026-08-08");
  assert.equal(c.date, "2026-08-07", "an already-ISO stamp must be unchanged");
  assert.equal(d.date, undefined, "an unparseable stamp must be omitted, never emitted as junk");
});

test("enrichItems hands over the FULL pooled body only for sources the researcher cannot fetch", () => {
  // Transcripts, local-ingest Substack bodies and PDF policy extracts are capped at ~2,200 chars in
  // pool.json and trimmed to 300 in the digest. Both contracts say to treat these as read text and
  // forbid fetching the URL, so the trimmed copy would be quoted as if it were the whole opening.
  const long = "x".repeat(2200);
  const short = "y".repeat(300);
  const items = [
    { id: "vid", title: "T", excerpt: short, url: "https://x/v" },
    { id: "sub", title: "T", excerpt: short, url: "https://x/s" },
    { id: "pol", title: "T", excerpt: short, url: "https://x/p" },
    { id: "rss", title: "T", excerpt: short, url: "https://x/r" },
  ];
  const pool = [
    { id: "vid", excerpt: long, transcript_at: "2026-08-08T19:15:00.000Z" },
    { id: "sub", excerpt: long, enriched_at: "2026-08-08T19:15:00.000Z" },
    { id: "pol", excerpt: long, kind: "policy" },
    { id: "rss", excerpt: long, kind: "article" }, // fetchable — the researcher opens the URL itself
  ];
  const [vid, sub, pol, rss] = enrichItems(items, pool);
  assert.equal(vid.excerpt.length, 2200);
  assert.equal(sub.excerpt.length, 2200);
  assert.equal(pol.excerpt.length, 2200);
  assert.equal(rss.excerpt.length, 300, "a fetchable RSS lead keeps the cheap trimmed excerpt");
});

test("enrichItems keeps an item whose pool record has gone missing", () => {
  const [only] = enrichItems([{ id: "gone", title: "T", excerpt: "E", url: "https://x/y" }], []);
  assert.equal(only.id, "gone");
  assert.equal(only.date, undefined);
  assert.equal(only.transcript_at, undefined);
});

test("buildDigestToday carries two picks and excludes yesterday's primary interest", () => {
  const digest = {
    "software-ai": { days_since_last_article: 14, items: [{ id: "s1", title: "S", excerpt: "e", url: "https://x/s" }] },
    finance: { days_since_last_article: 24, items: [{ id: "f1", title: "F", excerpt: "e", url: "https://x/f" }] },
    design: { days_since_last_article: 5, items: [] },
  };
  const articles = [{ id: "y", interest: "finance", created_at: "2026-08-09", title: "Yesterday", tags: [] }];
  const out = buildDigestToday({ interests, digestInterests: digest, articles, poolItems: [], date: "2026-08-10" });
  assert.equal(out.excluded_yesterday, "finance");
  assert.ok(!out.picks.some((p) => p.id === "finance"), "yesterday's interest must not be servable today");
  assert.equal(out.picks.length, 2);
  assert.equal(out.picks[0].id, "software-ai", "14/7 = 2.0 beats 5/10 = 0.5");
  assert.equal(out.picks[0].score, 2);
  assert.equal(out.picks[0].cadence_days, 7);
  assert.equal(out.date, "2026-08-10");
});

test("buildDigestToday emits score:null + never_served instead of unserialisable Infinity", () => {
  const out = buildDigestToday({
    interests: [{ id: "design", label: "Design", mode: "learn", cadenceDays: 10 }],
    digestInterests: { design: { days_since_last_article: null, items: [] } },
    date: "2026-08-10",
  });
  assert.equal(out.picks[0].score, null);
  assert.equal(out.picks[0].never_served, true);
  assert.equal(JSON.parse(JSON.stringify(out)).picks[0].score, null, "must survive a JSON round-trip");
});

test("buildDigestToday fails OPEN: repeats yesterday rather than returning no pick at all", () => {
  // One interest, served yesterday — the "never repeat yesterday" rule would otherwise empty the
  // ranking and leave the research step with nothing to write about.
  const out = buildDigestToday({
    interests: [{ id: "design", label: "Design", mode: "learn", cadenceDays: 10 }],
    digestInterests: { design: { days_since_last_article: 0, items: [] } },
    articles: [{ id: "y", interest: "design", created_at: "2026-08-09", title: "Y", tags: [] }],
    date: "2026-08-10",
  });
  assert.equal(out.picks.length, 1);
  assert.equal(out.picks[0].id, "design");
  assert.equal(out.repeated_yesterday, "design", "the repeat must be visible, not silent");
  assert.equal(out.excluded_yesterday, null);
});

test("buildDigestToday attaches per-interest reader signals to each pick", () => {
  const articles = [
    // software-ai is yesterday's (so it's excluded and design is served) — the point of the test is
    // that design's signals are design's alone.
    { id: "d1", interest: "design", created_at: "2026-08-07", title: "Down", tags: ["ui"], mode: "learn" },
    { id: "s1", interest: "software-ai", created_at: "2026-08-08", title: "Up", tags: ["db"], mode: "learn" },
  ];
  const state = { articles: { d1: { status: "read", feedback: "down" }, s1: { status: "read", starred: true } } };
  const out = buildDigestToday({
    interests,
    digestInterests: {
      design: { days_since_last_article: 30, items: [] },
      "software-ai": { days_since_last_article: 14, items: [] },
      finance: { days_since_last_article: 0, items: [] },
    },
    articles,
    state,
    date: "2026-08-10",
  });
  const design = out.picks.find((p) => p.id === "design");
  assert.equal(design.recent_feedback[0].feedback, "down");
  assert.ok(
    !design.recent_feedback.some((f) => f.id === "s1"),
    "signals must stay primary-interest-scoped — one tab's history must not leak into another's"
  );
});
