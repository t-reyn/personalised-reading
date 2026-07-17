#!/usr/bin/env node
// TEMPORARY diagnostic — delete once the blocked feeds are fixed.
// Runs on a GitHub runner to answer one question with evidence: what does it take to fetch the four
// Cloudflare-blocked feeds from a datacenter IP? Local runs cannot see this failure at all.
// Hypothesis under test: a Chrome UA from an Azure IP is an impossible combination and scores as a
// liar, while an honest bot UA is judged on its own merits. Also probes Substack's JSON archive
// endpoint (often less protected than /feed) and a Google News site: mirror as the fallback.

const UAS = {
  browser_current: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  honest_bot: "CortexReader/1.0 (+https://t-reyn.github.io/personalised-reading/; personal reading list; contact via repo)",
  feedly_like: "Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)",
  curl_like: "curl/8.4.0",
  none: null,
};

const TARGETS = [
  ["actuarial", "https://invisiblebalancesheet.substack.com/feed"],
  ["actuarial", "https://actuarialnotes.substack.com/feed"],
  ["finance", "https://boredombaron.substack.com/feed"],
  ["videography", "https://nofilmschool.com/rss.xml"],
];

// Alternative endpoints worth a shot if /feed stays blocked for every UA.
const ALTS = [
  ["substack archive JSON", "https://invisiblebalancesheet.substack.com/api/v1/archive?sort=new&limit=12"],
  ["substack archive JSON", "https://boredombaron.substack.com/api/v1/archive?sort=new&limit=12"],
  ["gnews mirror", "https://news.google.com/rss/search?q=site:invisiblebalancesheet.substack.com&hl=en-AU&gl=AU&ceid=AU:en"],
  ["gnews mirror", "https://news.google.com/rss/search?q=site:actuarialnotes.substack.com&hl=en-AU&gl=AU&ceid=AU:en"],
  ["gnews mirror", "https://news.google.com/rss/search?q=site:boredombaron.substack.com&hl=en-AU&gl=AU&ceid=AU:en"],
  ["gnews mirror", "https://news.google.com/rss/search?q=site:nofilmschool.com&hl=en-AU&gl=AU&ceid=AU:en"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(url, ua) {
  const headers = { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" };
  if (ua) headers["User-Agent"] = ua;
  try {
    const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(20000) });
    const body = await res.text();
    // Count items so a 200 that is actually a challenge page or an empty shell is not read as success.
    const items = (body.match(/<item\b|<entry\b/gi) || []).length;
    const json = body.trimStart().startsWith("{") ? (JSON.parse(body)?.length ?? "?") : null;
    return { status: res.status, bytes: body.length, items: json !== null ? `${json} (json)` : items };
  } catch (e) {
    return { status: "ERR", bytes: 0, items: 0, err: e.message };
  }
}

console.log(`Probing from a GitHub runner. Public egress IP: ${await (async () => {
  try { return (await (await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(8000) })).json()).ip; }
  catch { return "unknown"; }
})()}\n`);

console.log("=== /feed across User-Agents ===");
for (const [interest, url] of TARGETS) {
  const host = new URL(url).hostname;
  for (const [name, ua] of Object.entries(UAS)) {
    const r = await probe(url, ua);
    console.log(`  ${host.padEnd(38)} ${name.padEnd(16)} -> ${String(r.status).padEnd(5)} ${String(r.items).padStart(3)} items  ${r.bytes}b ${r.err || ""}`);
    await sleep(700); // be polite; this is someone else's server
  }
  console.log("");
}

console.log("=== alternative endpoints (honest_bot UA) ===");
for (const [label, url] of ALTS) {
  const r = await probe(url, UAS.honest_bot);
  console.log(`  ${label.padEnd(22)} ${new URL(url).hostname.padEnd(30)} -> ${String(r.status).padEnd(5)} ${String(r.items).padStart(3)} items  ${r.bytes}b ${r.err || ""}`);
  await sleep(700);
}
