# Authoring run — write today's issue (keep it lean)

You write today's articles, then stop. This runs unattended on a tight time + turn budget, so **be
decisive and efficient** — don't re-read files you've already read, don't deliberate at length.

## Read once (in this order)
1. `data/config.json` — `interests` (each has an `id`, `label`, `ttlDays`, and a **`mode`**), `audience`
   (Australian lens, en-AU), and **`maxArticlesPerRun`**.
2. `data/profile.local.json` — the reader. This is the steering wheel: each interest has a **`mode`**,
   **`level`**, **`priority`**, and **`want`** (what they want from it), plus their **`goals`** and **`tone`**.
   Pitch and choose topics to match.
3. `data/knowledge.json` — concepts already learnt (`is_learnt:true`). Never re-explain these.
4. `data/pool.json` — candidate source items (`status:"pending"`), grouped by interest.
5. `templates/article.html` — copy this for every article.

## Choose what to write
Write **exactly `maxArticlesPerRun` articles, each with a DIFFERENT primary interest.** Choose primaries
by the profile's **priority** (favour `highest`/`high`) and by where the pool has a strong cluster — but
rotate over days so no interest is starved. An interest with a thin pool can be skipped; quality over quantity.

Respect each interest's **mode**:
- **`current`** — track what's new. Timely, news-driven, synthesised from recent pool items. Set an
  `expire_at` (it ages out). Style: lead with what changed and why it matters to the reader.
- **`learn`** — teach a foundation. Evergreen, builds the knowledge graph, does NOT need fresh news (write it
  even if the pool is thin — draw on the topic itself). Omit `expire_at` (or set it far out per `ttlDays`).
  Style: teach one idea well, from the reader's stated level up.
- **`both`** — pick per article: either a timely piece (`current`) or a foundational one (`learn`). Over time
  give the interest a mix.

Be **applied** where the profile asks (e.g. indie-income, property): concrete, do-this-next guidance with
worked AU examples — not general overviews.

## Write each article
- Copy `templates/article.html` → `articles/YYYY-MM-DD/<slug>.html` (today's date; `<slug>` kebab-case).
- **Synthesise** several sources into one original ~500–700 word piece (don't summarise one link). For a
  `learn` piece with a thin pool, it's fine to write from your own knowledge of the topic.
- **Use the real data — don't write a generic overview.** For a `current` piece built on a statistics or
  regulator release (APRA, ABS, RBA, ASIC), the article MUST state the actual figures and what they show
  (the direction, the number, the so-what), not just explain what the series is. The pool excerpt is
  often already enriched with the release's highlights — lead with those. If the excerpt is still thin
  (bare title, page chrome, or a link with no numbers), **`WebFetch` the source URL** to read the
  highlights or the linked data, then draw the conclusions. WebFetch can read the linked PDF/page too.
  - **Fetch sparingly (token + time budget):** only fetch sources you're actually citing in the piece
    you're writing, prefer the enriched excerpt when it already has the numbers, and don't fetch more
    than ~3 pages per run. The run is on a tight headless-token window — a handful of targeted fetches
    is fine; broad crawling is not.
- **Knowledge-aware:** never re-explain an `is_learnt` concept; briefly teach an assumed prerequisite inline
  rather than assuming it. For software/AI the reader "vibecodes" — explain fundamentals + the *why*.
- **Australian lens** per `config.audience` where relevant; cover global developments too. Subtly honour the
  profile's `flavour` (travel / cultural lens) only where it fits naturally — never force it.
- Fill the `#meta` JSON fully:
  - `interest` — the PRIMARY interest id (drives the accent + main placement).
  - **`interests`** — an array of ALL interest ids this genuinely fits, primary first (1–3; e.g. a piece on
    AI tooling for designers → `["software-ai","design"]`). Most pieces have one; use multiple only when real.
  - **`mode`** — `"current"` or `"learn"` for THIS article (see modes above).
  - `concepts_taught` / `concepts_assumed` (stable kebab-case ids), real `sources`, `expire_at` per mode +
    the interest's `ttlDays` (omit for `learn` / when ttl is `null`), and a 1–2 question `quick_check` (each
    tagged with the `concept` it tests). Leave `merged_from: []`, `merged_into: null`.

## Two quick updates, then stop
1. `data/knowledge.json` — add any genuinely new concept ids you taught/assumed, `is_learnt:false` (never
   flip to learnt — only the reader's quizzes do that). **Every `concepts_taught` id MUST be added here**
   (a health-check fails the build otherwise).
2. `data/pool.json` — **remove the items you used** (delete those entries from the `items` array).

Then you're done — the workflow builds the index, commits, and deploys.

## Hard rules
- **Never put the reader's personal data into any article** — no name, age, heritage, employer, the specific
  property, location, tokens, or anything from `profile.local.json`. Articles are PUBLIC; the profile only
  shapes depth, topic choice, and voice.
- Do NOT edit `data/reading-state.json`, `data/config.json`, `scripts/`, or `.github/`.
- Skip carry-forward/merge for now; write fresh, well-pitched articles.
