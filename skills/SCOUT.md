# Source scout — propose new feeds to broaden the reader's sources

You run weekly. Your job: discover **new** feeds worth following for each interest, so the source mix
keeps growing instead of going stale. You only *propose*; a deterministic script validates + appends.

## Read first
1. `data/config.json` — `interests` (the tabs) and `audience` (Australian lens, en-AU).
2. `data/sources.json` — the feeds already in use. **Never propose a URL that's already there.**
3. `data/profile.local.json` if present — the reader's background + per-tab level (pitch suggestions to it).
4. Skim recent `articles/**` + `data/knowledge.json` — what's already covered / what they're into.

## Propose
For each interest, propose **2–5 NEW candidate feed URLs** the reader would value. Favour, in order:
1. **Independent blogs with native RSS** — a clean `/feed` or `/rss` that serves scripts reliably.
   Best signal-to-noise. **NOT Substack:** Substack IP-bans this runner (every publication 403s every
   UA from datacenter IPs), so a Substack proposal always fails validation. Substacks reach the pool
   only via `data/sources-local.json` (fetched from the reader's own machine) — that's a human call,
   not yours.
2. **YouTube channels** — `https://www.youtube.com/feeds/videos.xml?channel_id=UC…` for a channel
   that *teaches* the interest (craft over news churn, roughly 1–8 uploads/month; a daily channel
   drowns a capped feed). Find the `UC…` id in the channel page source (`"channelId"` /
   `"externalId"`) and confirm the feed URL returns entries whose `<title>` matches the channel
   before proposing. Items get `kind:"video"` and are transcript-enriched overnight on the reader's
   machine.
3. **Specific publications via Google News** — `https://news.google.com/rss/search?q=site:DOMAIN&hl=en-AU&gl=AU&ceid=AU:en`.
   This works even when a site blocks its own RSS (many do), so it's the way to follow a named outlet.
4. **Emerging-subtopic topic queries** — `https://news.google.com/rss/search?q=<terms>&hl=en-AU&gl=AU&ceid=AU:en`
   for a specific angle that isn't well covered yet.

Guidance: prefer quality + relevance over volume; honour the Australian lens where it matters; match the
spirit of what's already curated and the reader's profile. Don't propose paywalled native RSS (use the
Google News `site:` form for paywalled outlets instead). It's fine to propose nothing for a tab that's
already well-served. **8 feeds is a hard ceiling per interest** (the validator enforces it): the
author's digest has 8 slots filled round-robin, so a 9th feed doesn't add coverage — it silently
evicts the least-frequent feed. If a tab is at 8 and you've found something clearly better than an
incumbent, note it in the candidates file under `"_suggested_swaps"` instead of proposing it — swapping
out a source is the reader's call.

## Output
Write your proposals to **`data/source-candidates.json`** as `{ "<interestId>": ["url1", "url2", ... ], ... }`
and then STOP. Do not edit `data/sources.json` yourself — `scripts/validate-sources.mjs` will fetch-test
each candidate, drop the dead/blocked/duplicate ones, append the survivors (capped per interest), and
clear the candidates file. Do not touch anything else.
