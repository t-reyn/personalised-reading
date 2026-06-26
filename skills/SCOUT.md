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
1. **Independent Substacks / blogs** — they expose a clean `/feed` and serve scripts reliably
   (e.g. `https://<publication>.substack.com/feed`). Best signal-to-noise.
2. **Specific publications via Google News** — `https://news.google.com/rss/search?q=site:DOMAIN&hl=en-AU&gl=AU&ceid=AU:en`.
   This works even when a site blocks its own RSS (many do), so it's the way to follow a named outlet.
3. **Emerging-subtopic topic queries** — `https://news.google.com/rss/search?q=<terms>&hl=en-AU&gl=AU&ceid=AU:en`
   for a specific angle that isn't well covered yet.

Guidance: prefer quality + relevance over volume; honour the Australian lens where it matters; match the
spirit of what's already curated and the reader's profile. Don't propose paywalled native RSS (use the
Google News `site:` form for paywalled outlets instead). It's fine to propose nothing for a tab that's
already well-served.

## Output
Write your proposals to **`data/source-candidates.json`** as `{ "<interestId>": ["url1", "url2", ... ], ... }`
and then STOP. Do not edit `data/sources.json` yourself — `scripts/validate-sources.mjs` will fetch-test
each candidate, drop the dead/blocked/duplicate ones, append the survivors (capped per interest), and
clear the candidates file. Do not touch anything else.
