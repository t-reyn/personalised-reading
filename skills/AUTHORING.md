# Authoring run — write today's issue (keep it lean)

You write today's articles, then stop. This runs unattended on a tight time + turn budget, so **be
decisive and efficient** — don't re-read files you've already read, don't deliberate at length.

## Read once (in this order)
1. `data/config.json` — `interests` (tabs), `audience` (Australian lens, en-AU), and **`maxArticlesPerRun`**.
2. `data/profile.local.json` if present — the reader's background + per-tab level. Pitch to it.
3. `data/knowledge.json` — concepts already learnt (`is_learnt:true`). Never re-explain these.
4. `data/pool.json` — candidate source items (`status:"pending"`), grouped by interest.
5. `templates/article.html` — copy this for every article.

## Write
Write **exactly `maxArticlesPerRun` articles, each in a DIFFERENT interest** (spread across the tabs —
never two for the same tab in one run). For each, pick the single strongest cluster of related pool
items in that interest and:
- Copy `templates/article.html` → `articles/YYYY-MM-DD/<slug>.html` (today's date; `<slug>` kebab-case).
- **Synthesise** several sources into one original ~500–700 word piece (don't summarise one link).
- **Knowledge-aware:** do NOT re-explain any `is_learnt` concept. Briefly teach an assumed prerequisite
  inline rather than assuming it. For Software/AI: the reader "vibecodes" — explain fundamentals + the
  *why*, don't assume deep mechanism knowledge.
- **Australian lens** per `config.audience` where relevant, but cover global developments too.
- Fill the `#meta` JSON fully: `concepts_taught` / `concepts_assumed` (stable kebab-case ids), real
  `sources`, `expire_at` per the interest's `ttlDays` (omit when ttl is `null`), and a 1–2 question
  `quick_check` (each tagged with the `concept` it tests). Leave `merged_from: []`, `merged_into: null`.

## Two quick updates, then stop
1. `data/knowledge.json` — add any genuinely new concept ids you taught/assumed, `is_learnt:false`
   (never flip to learnt — only the reader's quizzes do that).
2. `data/pool.json` — **remove the items you used** (delete those entries from the `items` array) so they
   aren't reused tomorrow. (One edit — don't mark per-item statuses.)

Then you're done — the workflow builds the index, commits, and deploys.

## Hard rules
- **Never put the reader's personal data into any article** — no name, email, employer, location, tokens,
  or anything from `profile.local.json`. Articles are PUBLIC; the profile only shapes depth + voice.
- Do NOT edit `data/reading-state.json`, `data/config.json`, `scripts/`, or `.github/`.
- If a tab's pool is too thin for a good article, write fewer — that's fine. Quality over quantity.
- Skip carry-forward/merge for now; just write fresh, well-pitched articles.
