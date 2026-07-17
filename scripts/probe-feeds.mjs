#!/usr/bin/env node
// TEMPORARY diagnostic — delete once the blocked feeds are fixed.
// Round 3: rescue attempts for the three Substacks, which 403 on /feed for every UA from a runner.
// Two leads, both of which MUST be measured from the datacenter IP — they all "work" from a home IP,
// which is exactly the trap that makes this bug invisible locally:
//   (a) Substack's public keyless JSON archive endpoint, across every UA (round 2 only tried one).
//   (b) Feedly's keyless cloud stream API — Feedly's crawlers are Cloudflare-allowlisted, so it can
//       fetch what we cannot; the question is whether OUR runner can read Feedly's cached copy.
const UAS = {
  browser: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  bot: "CortexReader/1.0 (+https://t-reyn.github.io/personalised-reading/; personal reading list)",
  feedly_like: "Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)",
  curl: "curl/8.4.0",
  none: null,
};

const PUBS = ["invisiblebalancesheet", "actuarialnotes", "boredombaron"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(url, ua) {
  const headers = { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" };
  if (ua) headers["User-Agent"] = ua;
  try {
    const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(20000) });
    const body = await res.text();
    let items = (body.match(/<item\b|<entry\b/gi) || []).length;
    let sample = "";
    const t = body.trimStart();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        const j = JSON.parse(body);
        const arr = Array.isArray(j) ? j : j.items || [];
        items = arr.length;
        sample = arr[0]?.title || "";
      } catch { items = 0; }
    }
    return { status: res.status, items, bytes: body.length, sample: sample.slice(0, 40) };
  } catch (e) {
    return { status: "ERR", items: 0, bytes: 0, sample: e.message.slice(0, 40) };
  }
}

console.log("=== (a) Substack JSON archive API x every UA, from the runner ===");
for (const pub of PUBS) {
  const url = `https://${pub}.substack.com/api/v1/archive?sort=new&limit=12`;
  for (const [name, ua] of Object.entries(UAS)) {
    const r = await probe(url, ua);
    console.log(`  ${pub.padEnd(24)} ${name.padEnd(12)} -> ${String(r.status).padEnd(5)} ${String(r.items).padStart(3)} items ${String(r.bytes).padStart(7)}b  ${r.sample}`);
    await sleep(600);
  }
  console.log("");
}

console.log("=== (b) Feedly keyless cloud stream API, from the runner ===");
const FEEDLY = (feedUrl) =>
  `https://cloud.feedly.com/v3/streams/contents?streamId=${encodeURIComponent("feed/" + feedUrl)}&count=20`;
for (const pub of PUBS) {
  const r = await probe(FEEDLY(`https://${pub}.substack.com/feed`), UAS.bot);
  console.log(`  feedly:${pub.padEnd(24)} -> ${String(r.status).padEnd(5)} ${String(r.items).padStart(3)} items ${String(r.bytes).padStart(7)}b  ${r.sample}`);
  await sleep(600);
}
const nfs = await probe(FEEDLY("https://nofilmschool.com/rss.xml"), UAS.bot);
console.log(`  feedly:nofilmschool (control)  -> ${String(nfs.status).padEnd(5)} ${String(nfs.items).padStart(3)} items ${String(nfs.bytes).padStart(7)}b  ${nfs.sample}`);
