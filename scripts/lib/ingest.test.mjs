// Tests for the ingest pipeline's pure helpers. Lives under scripts/lib/ because CI runs
// `node --test scripts/lib/*.test.mjs`; ingest.mjs guards its main() so importing it is side-effect free.
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { createServer } from "node:http";
import { parseKontent, isKontentFeed, capRoundRobin, itemTime, isLegible, trimPdfLead, pdfToText, fetchFeed } from "../ingest.mjs";

// Build a minimal PDF carrying `n` Flate-compressed content streams, each showing one text run.
function fakePdf(runs) {
  const chunks = [Buffer.from("%PDF-1.4\n")];
  for (const run of runs) {
    const body = zlib.deflateSync(Buffer.from(`BT /F1 12 Tf (${run}) Tj ET`));
    chunks.push(Buffer.from("5 0 obj<</Length 1/Filter/FlateDecode>>stream\n"), body, Buffer.from("\nendstream endobj\n"));
  }
  return Buffer.concat(chunks);
}

// Serve a feed from localhost so retry behaviour is tested without touching a live source.
// `plan` is the status code per attempt; 200 serves the body. Every request's UA is recorded, so a
// test can assert WHICH identity was used — the point of the 403 fallback.
const FEED_XML = '<?xml version="1.0"?><rss><channel><item><title>Ok</title><link>https://e.g/1</link></item></channel></rss>';
async function withServer(plan, fn) {
  const hits = { n: 0, uas: [] };
  const srv = createServer((req, res) => {
    hits.uas.push(req.headers["user-agent"] || "");
    const status = plan[Math.min(hits.n++, plan.length - 1)];
    res.writeHead(status);
    res.end(status === 200 ? FEED_XML : "error");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${srv.address().port}/feed.xml`, hits);
  } finally {
    srv.close();
  }
}

// Serve 403 to a browser-claiming UA and 200 to an honest bot — i.e. exactly what nofilmschool.com was
// measured doing from a datacenter IP on 2026-07-17.
async function withUaPickyServer(fn) {
  const hits = { n: 0, uas: [] };
  const srv = createServer((req, res) => {
    const ua = req.headers["user-agent"] || "";
    hits.uas.push(ua);
    hits.n++;
    if (/Mozilla|Chrome/.test(ua)) { res.writeHead(403); return res.end("blocked"); }
    res.writeHead(200);
    res.end(FEED_XML);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${srv.address().port}/feed.xml`, hits);
  } finally {
    srv.close();
  }
}

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
    kind: "article",
    topics: ["Life Insurance", "Risk Management"],
  });
});

// A dropped feed silently thins the pool the author writes from, so a transient blip (Google News
// 503ing a whole batch) must not cost the run a source — while a settled 403 must not cost it time.
test("fetchFeed retries a transient 503 and returns the body once it recovers", async () => {
  await withServer([503, 503, 200], async (url, hits) => {
    const body = await fetchFeed(url);
    assert.match(body, /<title>Ok<\/title>/);
    assert.equal(hits.n, 3, "should have taken all three attempts");
  });
});

test("fetchFeed retries a 429 (rate limit), not just 5xx", async () => {
  await withServer([429, 200], async (url, hits) => {
    await fetchFeed(url);
    assert.equal(hits.n, 2);
  });
});

// A 403 is the one status where changing IDENTITY (not waiting) can help: nofilmschool.com 403s a
// Chrome UA from a datacenter IP but serves an honest bot. So a 403 buys exactly one honest retry.
test("fetchFeed retries a 403 ONCE as an honest bot, and succeeds where the publisher allows it", async () => {
  await withUaPickyServer(async (url, hits) => {
    const body = await fetchFeed(url);
    assert.match(body, /<title>Ok<\/title>/);
    assert.equal(hits.n, 2, "browser UA first, then exactly one honest-bot retry");
    assert.match(hits.uas[0], /Chrome/, "leads with the browser UA");
    assert.doesNotMatch(hits.uas[1], /Chrome|Mozilla/, "falls back to a non-browser identity");
    assert.match(hits.uas[1], /CortexReader/, "identifies itself honestly rather than impersonating a reader");
  });
});

test("fetchFeed does not blindly retry a 403 — a hard block costs 2 attempts, not 3+", async () => {
  // The Substacks 403 every UA (an IP ban). That must cost one browser try + one honest try, then stop.
  await withServer([403, 403, 403, 200], async (url, hits) => {
    await assert.rejects(fetchFeed(url), /HTTP 403/);
    assert.equal(hits.n, 2, "must not burn the time-boxed run on an unfixable block");
  });
});

test("fetchFeed gives up after a bounded number of attempts and reports the last status", async () => {
  await withServer([503], async (url, hits) => {
    await assert.rejects(fetchFeed(url), /HTTP 503/);
    assert.equal(hits.n, 3, "must not retry unbounded — the run is time-boxed");
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

test("parseKontent reads a policy `resource` item and resolves the asset placeholder", () => {
  const items = parseKontent(
    JSON.stringify({
      items: [
        {
          system: { id: "res-1", name: "sys name" },
          elements: {
            name: { value: "Life Insurance Code of Practice Review - Interim Report Response" },
            description: { value: "Our submission focuses on mental health." },
            created_date: { value: "2026-05-12T00:00:00Z" },
            // The API returns this literal placeholder, not a usable URL.
            url: { value: "{{ACTUARIES_ASSET_SUBDOMAIN}}/resources/resource-ce6yyqn64sx3-2093352434-60809" },
            content_types: { value: [{ name: "Submission" }] },
            practice_areas: { value: [{ name: "Life Insurance" }] },
          },
        },
      ],
    })
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://content.actuaries.asn.au/resources/resource-ce6yyqn64sx3-2093352434-60809");
  assert.equal(items[0].kind, "policy");
  assert.equal(items[0].source, "Actuaries Institute");
  assert.equal(items[0].published, "2026-05-12T00:00:00Z");
  // genre first, then practice area — the author reads this to judge register + relevance
  assert.deepEqual(items[0].topics, ["Submission", "Life Insurance"]);
});

test("parseKontent still marks magazine articles as kind:article, not policy", () => {
  const items = parseKontent(
    JSON.stringify({
      items: [{ system: { id: "a1" }, elements: { title: { value: "T" }, slug: { value: "s" } } }],
    })
  );
  assert.equal(items[0].kind, "article");
  assert.equal(items[0].url, "https://www.actuaries.asn.au/research-analysis/s");
});

test("parseKontent skips a resource with no usable url", () => {
  const items = parseKontent(
    JSON.stringify({
      items: [
        { system: { id: "x" }, elements: { name: { value: "No url" }, url: { value: "" } } },
        { system: { id: "y" }, elements: { name: { value: "Offsite" }, url: { value: "https://elsewhere.example/x.pdf" } } },
      ],
    })
  );
  assert.equal(items.length, 0);
});

test("isLegible rejects CID-font mojibake and accepts prose", () => {
  // The real failure mode: one of five Institute PDFs decodes to glyph indices, not text. It is long,
  // so length alone would pass it — this gate is the only thing standing between it and the pool.
  const mojibake = "1 1 &330553==:      662996,, lí" .repeat(40);
  assert.equal(isLegible(mojibake), false);
  const prose = "The Actuaries Institute welcomes the opportunity to respond to this consultation on genetic testing protections in life insurance. ".repeat(12);
  assert.equal(isLegible(prose), true);
  assert.equal(isLegible(""), false);
  // Real prose but too short to be a document we can write from.
  assert.equal(isLegible("The Institute welcomes the opportunity to respond."), false);
});

test("trimPdfLead drops the letterhead so the excerpt opens on the position", () => {
  const raw =
    "Actuaries Institute Level 34, Australia Square, 264 George Street, Sydney NSW 2000, Australia " +
    "P +61 (0) 2 9239 6100 | actuaries.asn.au 25 June 2026 Insurance Unit The Treasury Langton Crescent " +
    "Parkes ACT 2600 Via Treasury Consultation Hub Dear Sir/Madam, Consultation: Genetic testing " +
    "protections in life insurance The Actuaries Institute welcomes the opportunity to provide feedback.";
  const out = trimPdfLead(raw);
  assert.ok(out.startsWith("Dear Sir/Madam,"), `expected to start at the salutation, got: ${out.slice(0, 40)}`);
  assert.ok(!out.includes("Australia Square"), "postal address must be gone");
});

test("trimPdfLead leaves a media release (no letterhead) alone, minus the lang token", () => {
  const raw = "en-AUActuaries Institute Maps the Generational Flow of Australia's $1 trillion Tax and Spending System. Government spending follows a U-shaped pattern.";
  const out = trimPdfLead(raw);
  assert.ok(out.startsWith("Actuaries Institute Maps"), out.slice(0, 40));
});

test("pdfToText reads Flate text streams", () => {
  const text = pdfToText(fakePdf(["Dear Mr Kell", "The Institute welcomes the opportunity"]));
  assert.match(text, /Dear Mr Kell/);
  assert.match(text, /welcomes the opportunity/);
});

test("pdfToText stops at maxChars — the bound that keeps a chart-heavy report cheap", () => {
  // Regression guard: unbounded, a real 8.9MB Institute report spent 64s extracting 190k chars that
  // were then truncated to 2.2k anyway. Bounding the walk took it to 310ms.
  const many = Array.from({ length: 400 }, (_, i) => `chunk ${i} of prose text here`);
  const bounded = pdfToText(fakePdf(many), 200);
  const full = pdfToText(fakePdf(many));
  assert.ok(bounded.length < full.length, "bounded extraction must stop early");
  assert.ok(bounded.length >= 200, "…but must still return at least the requested budget");
  assert.ok(full.length > 2000, "sanity: the unbounded walk really does read the whole document");
});

test("capRoundRobin buckets legacy items with no feed together", () => {
  const kept = capRoundRobin([{ published_at: "2026-07-01T00:00:00Z" }, { published_at: "2026-07-02T00:00:00Z" }], 2);
  assert.equal(kept.length, 2);
});
