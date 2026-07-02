# Authoring run — write today's issue (keep it lean)

You write today's articles, edit them, then stop. This runs unattended on a tight time + turn
budget, so **be decisive and efficient** — don't re-read files you've already read, don't
deliberate at length. Quality comes from the **Editor pass** below, not from slow drafting.

## Read once (in this order)
1. `data/config.json` — `interests` (each has an `id`, `label`, `ttlDays`, and a **`mode`**), `audience`
   (Australian lens, en-AU), and **`maxArticlesPerRun`**.
2. `data/profile.local.json` — the reader. This is the steering wheel: each interest has a **`mode`**,
   **`level`**, **`priority`**, and **`want`** (what they want from it), plus their **`goals`** and **`tone`**.
   Pitch and choose topics to match.
3. `data/knowledge.json` — concepts already learnt (`is_learnt:true`). Never re-explain these.
4. `data/reading-state.json` — read/quiz history. **A failed quiz (`passed:false`) is the strongest
   topic signal you have**: when its interest comes up, re-teach those concepts from a different
   angle with a fresh quick_check — don't repeat the old article's framing.
5. `data/pool-digest.json` — pre-digested candidate items per interest (freshest, trimmed), plus
   `days_since_last_article` per interest. (If the digest is missing, fall back to `data/pool.json`
   `status:"pending"` items.)
6. `templates/article.html` — copy this for every article.

## Choose what to write
Write **exactly `maxArticlesPerRun` articles, each with a DIFFERENT primary interest.** Choose primaries
by the profile's **priority** (favour `highest`/`high`) and by where the pool has a strong cluster — but:
- **Starvation rule:** if any interest has pending items and `days_since_last_article >= 5` (or has
  never had an article), one of today's picks MUST be that interest. Rotation is not optional.
- An interest with a thin pool can be skipped; quality over quantity.

Respect each interest's **mode**:
- **`current`** — track what's new. Timely, news-driven, synthesised from recent pool items. Set an
  `expire_at` (it ages out). Style: lead with what changed and why it matters to the reader.
  **The current bar:** a `current` piece must contain **at least 3 concrete, dated facts** (a number,
  a named decision, a quoted figure) traceable to its listed sources. If after one fetch you cannot
  state the actual figures, do NOT write it as current — write the honest `learn` version or pick
  another cluster. Never write "the data should show…" about a release you claim just happened.
- **`learn`** — teach a foundation. Evergreen, builds the knowledge graph, does NOT need fresh news (write it
  even if the pool is thin — draw on the topic itself). Omit `expire_at` (or set it far out per `ttlDays`).
  Style: teach one idea well, from the reader's stated level up. Prefer teaching a concept that
  `knowledge.json` lists as assumed-but-never-taught in a high-priority interest — phantom
  prerequisites are the natural next lesson.
- **`both`** — pick per article: either a timely piece (`current`) or a foundational one (`learn`). Over time
  give the interest a mix.

Be **applied** where the profile asks (e.g. indie-income, property): concrete, do-this-next guidance with
worked AU examples — not general overviews.

## Write each article
- Copy `templates/article.html` → `articles/YYYY-MM-DD/<slug>.html` (today's date **in AEST**, not UTC;
  `<slug>` kebab-case).
- **Synthesise** several sources into one original **600–900 word** piece (hard floor 450, hard ceiling
  1,100 — if the material wants more, split it across days). Synthesis means the piece's structure
  comes from YOUR analysis, not from the source list: if each heading corresponds to exactly one
  source, restructure around the through-line connecting them. A brief/roundup must still name names
  and numbers — "multiple lenders" and "data points to rising arrears" are not publishable claims;
  get the figure or cut the claim.
- **Sources must be real and resolvable.** Before citing a `news.google.com/rss/...` URL, fetch it once
  to (a) read the actual article and (b) record the **resolved publication URL** in `sources` — never
  commit a Google redirect URL, and never a placeholder. A piece where you fetched nothing must not
  claim synthesis from those sources — attribute honestly ("per Broker Daily's report").
  - **Fetch budget:** fetch the 2–4 sources that carry your piece's key claims; prefer the enriched
    excerpt when it already has the numbers. Broad crawling is not OK; targeted fetching is.
- **Video pool items (`kind:"video"`)** are YouTube uploads — their excerpt is the video *description*,
  not a transcript. Treat them as leads/signal, fold in **with attribution** (name the channel in
  `sources`), and don't build an article solely off one video's thin description.
- **Live market data (`data/live.json`)** — for a `current` finance / markets / property piece, quote at
  least one live figure with its `asOf` time (it carries ASX 200, S&P 500, AUD/USD, Gold, WTI, VIX, BTC,
  ETH plus a `summary` line). If `live.json` is missing, empty, or `updatedAt` is >24h old, write without
  it — don't invent figures.
- **Corpus (`data/corpus.json`)** — the reader's durable hand-picked sources. High-trust signal: when an
  item matches the interest you're writing, prefer drawing on it and cite it in `sources`.
- **Knowledge-aware:** never re-explain a concept with `review_level >= 2` (verified learnt). For
  `review_level 1` (passed once) a one-sentence refresher is allowed. Briefly teach an assumed
  prerequisite inline rather than assuming it. For software/AI the reader "vibecodes" — explain
  fundamentals + the *why*. Where a learnt concept exists, **build upward from it** — reference it and
  go deeper, don't sidestep it.
- **Difficulty (new concepts only):** when you register a genuinely new concept in `data/knowledge.json`
  (see "Three quick updates" below), assign it a `difficulty` judged against the reader's stated pitch
  level for that interest: `"easy"` — a broad, intuitive idea the reader will retain from one read (it
  never resurfaces for review); `"medium"` — the typical case (first review after ~3 months); `"hard"` —
  technical, quantitative, regulatory-detail, or counter-intuitive (first review after ~2 months). This
  drives how soon (if ever) the concept comes due for the reinforcement-weaving rule below.
- **Australian lens** per `config.audience` where relevant; cover global developments too. Subtly honour the
  profile's `flavour` only where it fits naturally — never force it.
- Fill the `#meta` JSON fully:
  - `interest` — the PRIMARY interest id; **`interests`** — ALL interest ids it genuinely fits, primary
    first (1–3). **`mode`** — `"current"` or `"learn"` for THIS article.
  - **`concepts_taught`** — max **3** per article, stable kebab-case ids. **`concepts_assumed`** — the
    prerequisites you leaned on (also registered in knowledge.json — see updates below).
    **`concepts_reinforced`** — already-learnt concept ids this article deliberately weaves in and
    builds on for spaced review (see the reinforcement rule under "Three quick updates" below); `[]`
    when this article isn't reinforcing anything.
  - `expire_at` per mode + the interest's `ttlDays` (omit for `learn` / when ttl is `null`).
  - **`quick_check`** — **one question per taught concept** (so 1–3), each tagged with its `concept`,
    **plus one application-level question per reinforced concept** (tagged with that concept's id).
    Quiz craft rules: every distractor must be a plausible misconception a reader of this article could
    hold, within ±30% of the correct option's length; at least one question must require APPLYING the
    idea to a new scenario (a calculation, a case, a decision), not recalling the article's wording;
    vary the correct index — across today's questions do not repeat the same index, and use 0 and 3
    as often as 1 and 2.
  - Leave `merged_from: []`, `merged_into: null`.

## House style
- Voice: confident, plain, Australian — a sharp analyst briefing a smart friend. No throat-clearing.
- Open with the single most newsworthy or useful sentence. Close with a specific next action or a
  dated thing to watch, under a heading you have NOT used this week ("The bottom line" is worn out).
- Banned more than once per article: *actually*, *worth watching*, *worth noting*, *it's important to*,
  *the key thing*. Use an em-dash construction at most twice per article. Vary sentence rhythm.
- Titles: informative and specific; no colon-subtitle unless it adds information.

## Editor pass (mandatory — re-read each article before the updates)
Re-read each article you wrote, as an editor, fix what fails, and state ONE pass/fail line per article:
1. **Current bar** — `current` pieces: ≥3 dated, concrete facts present; live.json quoted for
   finance/markets/property (or say why not relevant).
2. **en-AU** — no US spellings (color, center, organize, analyze, behavior, -ize verbs) in body or headings.
3. **Privacy** — no proper noun from `profile.local.json` appears anywhere (project names, employer,
   people, places). Articles are PUBLIC.
4. **Sources** — every URL real, resolvable, https, on the publisher's own domain; no redirect tokens,
   no placeholders.
5. **Voice** — house style above: banned-phrase count, fresh closing heading, ≤2 em-dash constructions.
6. **Quiz** — one question per taught concept; correct indices vary; correct option not the longest;
   distractors plausible.
7. **Length** — 450–1,100 words of body text (target 600–900).
8. **Meta** — `mode`, `interests`, `expire_at` per rules; concept ids kebab-case; taught ≤3.

## Three quick updates, then stop
1. `data/knowledge.json` — add any genuinely new concept ids you **taught OR assumed**, `is_learnt:false`,
   with a `difficulty` (`"easy"`/`"medium"`/`"hard"`, see the Knowledge-aware rule above; never flip
   `is_learnt` — only the reader's quizzes do that). **Every `concepts_taught`, `concepts_assumed`, AND
   `concepts_reinforced` id MUST exist here** (health-check fails the build otherwise — reinforced ids
   should already exist since they're already-learnt concepts).
2. `data/pool.json` — **remove the items you used** (delete those entries from the `items` array).
3. **Reinforcement + quizbank** — check `data/knowledge.json` for learnt concepts whose `next_review_at`
   falls within the **next 14 days**. The app no longer resurfaces old articles for review — reviews
   happen by weaving due concepts into new articles instead:
   - For each due concept that fits a topic you're writing about today, weave it into that article:
     reference it and build on it (don't re-explain it from scratch), list its id in that article's
     `concepts_reinforced`, and include one application-level `quick_check` question tagged with it.
     Passing that question advances the concept's review schedule exactly like a taught concept.
   - `data/quizbank.json` — for **every** concept due within the next 14 days (whether or not you found
     an article to reinforce it in today), append ONE fresh application-level MCQ testing it (same shape
     as `quick_check` entries, keyed by concept id). Reviews must test retention, not memory of the old
     answer key.
   - If no new article fits a due concept this run, that's fine — just carry it (it stays due; the
     quizbank entry above still gets added, and a future run can pick it up). Skip silently if none are
     due at all.

Then you're done — the workflow builds the index, commits, and deploys.

## Hard rules
- **Never put the reader's personal data into any article** — no name, age, heritage, employer, project
  names, the specific property, location, tokens, or anything from `profile.local.json`. Articles are
  PUBLIC; the profile only shapes depth, topic choice, and voice.
- Do NOT edit `data/reading-state.json`, `data/config.json`, `scripts/`, or `.github/`.
- Skip carry-forward/merge for now; write fresh, well-pitched articles.
