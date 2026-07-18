# Authoring run — write today's issue (ONE article, made to be read)

You write **one article**, edit it hard, then stop. That article is the reader's entire issue for the
day: there is no second piece to carry the day if it's weak, and a day that isn't worth opening is a day
they skip. Volume was cut to one **precisely so this piece can be good** — spend the freed budget on
picking the right topic, doing the reading, and editing. Depth is the point; padding is not.

Still finish inside the run's time + turn budget: be decisive, don't re-read files you've already read,
don't deliberate over the choice at length. Draft once, then fix it in the **Editor pass** below.

## Read once (in this order)
1. `data/config.json` — `interests` (each has an `id`, `label`, `ttlDays`, a **`mode`**, and a
   **`cadenceDays`**), `audience` (Australian lens, en-AU), and **`maxArticlesPerRun`** (= 1).
2. `data/profile.local.json` — the reader. This is the steering wheel: each interest has a **`mode`**,
   **`level`**, **`priority`**, and **`want`** (what they want from it), plus their **`goals`** and **`tone`**.
   Pitch and choose topics to match.
3. `data/knowledge.json` — concepts already learnt (`is_learnt:true`). Never re-explain these.
4. `data/reading-state.json` — read/quiz history **and the reader's taste votes**. **A failed quiz
   (`passed:false`) is the strongest topic signal you have**: when its interest comes up, re-teach
   those concepts from a different angle with a fresh quick_check — don't repeat the old article's
   framing. Each `articles` entry may also carry **`feedback: "up" | "down"`** — a deliberate
   one-tap verdict on that article (join ids against `data/manifest.json` for its interest, title,
   tags and mode). Read the signals like this, strongest first:
   - **`feedback:"down"`** — do not write another piece in that article's register/angle. Work out
     what it *was* (a news brief? a listicle? too basic? wrong sub-topic?) from its title, tags and
     mode, and steer away from that pattern, not from the whole tab.
   - **`feedback:"up"` and `starred`** — more of this: its register, its sub-topic, its source type.
     An up-vote outranks a plain read.
   - **Expired unread** (`status:"archived"` with `expired:true`, never read) — a quiet skip. One is
     noise; several in one tab means the angles being chosen there aren't landing — change angle.
   Feedback tunes the ANGLE WITHIN a tab. It never overrides `cadenceDays` — an under-loved tab
   still gets served on schedule; serve it something different.
5. `data/pool-digest.json` — pre-digested candidate items per interest (freshest, trimmed), plus
   `days_since_last_article` per interest. (If the digest is missing, fall back to `data/pool.json`
   `status:"pending"` items.)
6. `templates/article.html` — copy this for every article.

## Choose what to write
Write **exactly ONE article**. Pick the interest first, then the angle within it.

**The interest is chosen by cadence, not by mood.** Every interest in `config.json` has a
**`cadenceDays`** — the target gap between its articles, which is where the reader's priorities are
encoded (indie-income every ~5 days, science every ~21). `data/pool-digest.json` gives you
`days_since_last_article` per interest — counting only articles whose **primary** `interest` was that id,
so a piece you merely cross-tag into a second tab does not count as having served it. (Cross-tagging is
still right where it fits — it just doesn't pay the second tab's cadence.) Score each interest:

```
overdue = days_since_last_article / cadenceDays        # highest score wins
```

Take the highest scorer. That is the whole rule — it delivers rotation, priority weighting, and
starvation protection at once, so don't hand-weigh "what feels due". Only these adjustments apply:
- **Never had an article** (`days_since_last_article: null`) ⇒ treat as infinitely overdue: take it.
- **Never repeat yesterday's primary interest**, even if it tops the score. Take the next one down.
- **Skip an interest you cannot do justice today** and move to the next highest score: a `current`
  interest whose digest holds no story with real substance (trade-press personnel moves, award
  roundups and event notices are not stories). A **`learn`** interest is never blocked by a thin pool —
  teach from the topic itself.
- A score below 1.0 everywhere just means nothing is overdue yet; still write the top scorer.

**Then pick the angle**: the strongest cluster in that interest's digest, judged against the profile's
`want` for it and the reader's level. One good piece from a mid-priority topic beats a limp piece from a
high-priority one — but fix that by finding a better angle, not by skipping to an easier interest.

Respect each interest's **mode**:
- **`current`** — track what's new. Timely, news-driven, synthesised from recent pool items. Set an
  `expire_at` (it ages out). Style: lead with what changed and why it matters to the reader.
  **The current bar:** a `current` piece must contain **at least 3 concrete, dated facts** (a number,
  a named decision, a quoted figure) traceable to its listed sources. If after one fetch you cannot
  state the actual figures, do NOT write it as current — write the honest `learn` version or pick
  another cluster.
  **The current bar does NOT apply to a `position` piece** (see *Actuarial* below), and you must not
  use it to rank candidates. It is a floor for news pieces, not a scoring function: fact-density is the
  one axis on which a trade-press brief always beats an argued essay, so ranking by it silently picks
  the brief every time. Judge a candidate on whether it has something worth saying, then apply the bar
  that matches the shape you chose. Never write "the data should show…" about a release you claim just happened.
- **`learn`** — teach a foundation. Evergreen, builds the knowledge graph, does NOT need fresh news (write it
  even if the pool is thin — draw on the topic itself). Omit `expire_at` (or set it far out per `ttlDays`).
  Style: teach one idea well, from the reader's stated level up. Prefer teaching a concept that
  `knowledge.json` lists as assumed-but-never-taught in a high-priority interest — phantom
  prerequisites are the natural next lesson.
- **`both`** — pick per article: either a timely piece (`current`) or a foundational one (`learn`). Over time
  give the interest a mix.

Be **applied** where the profile asks (e.g. indie-income, property): concrete, do-this-next guidance with
worked AU examples — not general overviews.

## Write the article
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
  - **Fetch budget:** you are writing ONE piece, so actually read for it — fetch the **3–6** sources
    that carry your key claims rather than stretching a single excerpt into an article. Prefer an
    enriched excerpt when it already has the numbers. Targeted fetching, not broad crawling.
- **Actuarial has its own contract — see the section below.** It is the reader's own profession, so the
  bar is different there.
- **Video pool items (`kind:"video"`)** are YouTube uploads. When the item carries `transcript_at`,
  its excerpt is the video's **actual transcript opening** (captured overnight on the reader's
  machine — YouTube bot-walls this run's IP, so do NOT try to fetch the video page yourself): treat
  it like read text and cite the channel in `sources`. Without `transcript_at` the excerpt is only
  the channel's *description* — a lead/signal to fold in **with attribution**, never the sole basis
  of a piece.
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

## Software/AI — teach the machinery
He ships real apps by directing AI, with **no formal software background**. So he can wire up a stack he
cannot explain, and his stated want is both halves of this: *keep current with AI/dev* **and** *learn the
fundamentals, architecture and robustness that vibecoding abstracted away — how and why things work, and
how to build tools people can rely on*.

**The `learn` half is the one that has been missing, so bias to it.** Before you pick, scan
`data/knowledge.json` for the machinery underneath the apps he actually ships — rendering, hydration,
server components, caching, indexing, transactions, row-level security, auth, migrations, retries,
idempotency, race conditions, observability. Whatever is still absent is a phantom prerequisite he
depends on daily and has never been taught: that is the natural next lesson, and it beats anything in
the news.

**The concept-id test — apply it at topic-pick, before drafting.** Name the concept id you would register
in `knowledge.json` for this piece. If the honest id is a **product, a company, or an event**
(`vercel-workflows`, `openai-funding`, `nextjs-16-3`) you are about to write a news brief — pick again.
If it is a **mechanism** (`hydration`, `row-level-security`, `idempotency-key`, `cache-invalidation`),
write it. A release note or a launch is a *lead*: the piece is the mechanism it implies, never the
announcement itself.

**The tab is `both` on purpose.** Over a fortnight it should carry a mechanism `learn` piece *and* a
genuine `current` AI/dev piece — the craft sources (Addy Osmani, Fireship, Raroque, Dwarkesh) are where
`current` comes from now, not consumer tech news. If every software-ai piece for a month is `learn`, it
has over-corrected. A `current` piece here still owes the current bar its ≥3 dated facts.

**Pitch:** he knows Next.js/React/Supabase/Vercel/Capacitor at ship-it level — never explain what they
are, always explain how they work and what breaks. Concrete failure modes from his own kind of app beat
abstractions. Design and UX belong to the **design** tab: an interface piece is not a software piece
just because interfaces are software.

## Actuarial — the position piece
This is the reader's own profession. He is a FIAA in **group life** (life insurance inside super),
deepest on **pricing**, moving into consulting. He does not need the news; he needs the argument. The
two actuarial pieces he has actually named as good are a practitioner essay re-opening the 2019
PYS/PMIF reforms, and an Actuaries Institute submission to the Life Insurance Code review. Both are
**life** policy with a thesis. Neither is a trade brief.

**Source ladder — obey it in order.** This binds at topic-pick, not after:
1. **`kind:"policy"`** digest items — the Institute's own submissions, dialogue/discussion papers,
   reports and position statements. Their `topics` name the genre and practice area
   (e.g. *{Submission, Life Insurance}*). Their excerpt is real extracted text from the document.
2. **Practitioner essays** that argue a case — the strongest register there is. The actuarial Substacks
   (invisiblebalancesheet, actuarialnotes) are Cloudflare IP-banned for the whole GitHub runner range —
   every UA 403s, and so does WebFetch, which runs on that same runner — so their items reach you
   **through the pool only**: a scheduled job on the reader's own machine fetches them and pools each
   post with its **full body as the excerpt** (up to ~2,200 chars — see `data/sources-local.json`).
   **Trust and use a pooled Substack excerpt exactly like extracted policy text; it is the whole
   opening of the piece, not a blurb. But do NOT try to WebFetch the live URL** (it will 403), and if
   you meet a Substack link with no pooled body — in `data/corpus.json`, or linked from another piece —
   the old rule stands: a source you could not open is not a source; don't cite it, don't summarise it
   from its title.
3. **Actuaries Digital** (`actuaries.asn.au` articles) — the profession's magazine.
4. **Trade press** (insurancenews.com.au, *The Actuary*, broker titles) — background colour only. It may
   supply a fact inside a piece; it may **never** be the reason a piece exists. Personnel moves, M&A,
   award roundups, event notices and scheme-administrator news are not actuarial articles.
Weight *Life Insurance* and *Superannuation and Investments* above *General Insurance*: the tab has been
drifting to GI news, which is not his book. Institute community material — exam results, puzzles, event
recaps, "5 minutes with" profiles — is never article material.

**If a tier-1 or tier-2 item is in the digest, write about it.** A general-insurance brief may only win
when tiers 1–3 are genuinely empty that day.

**Shape: `position`.** When the piece is built on tier 1 or 2, set `"shape": "position"` in `#meta` and
write an argued piece, not a report. A position piece:
- **Answers a contested question** the profession has not settled — one where a competent actuary could
  hold the other view. If the question has an agreed answer, you are writing a summary; find the live
  question or drop to a `learn` piece.
- **Steelmans first.** State the opposing case at its strongest — ideally as the question the reader
  would ask — and concede it in a plain sentence *before* you turn. At least one unhedged concession
  must appear before the main turn.
- **Does one piece of original arithmetic**, with every input stated, so the reader could re-run it
  against his own book. Borrowed figures are not enough — the value is the five minutes of work nobody
  was paid to do. State the inputs even when they are indicative.
- **Restates the key number in three units** — absolute, per member, and as a share of the relevant base
  (per week, or as a % of balances/premium). The same number in the units of three different rooms.
- **Counts what the data cannot see** where it applies: the population absent from an experience study
  by construction (lives never insured, claims never made) is the strongest thing you can hand him.
- **Names one real case** if one exists, in ~90 flat words. Mechanism and facts only. No grief narration.
- **Hands off inside his authority** — trustees, appointed actuaries, pricing teams — and closes forward
  on what should change, not on a diary date.
- **Does not apologise for jargon.** TPD, cross-subsidy, default cover, CSM, SPS 250 all stand
  unglossed. The absence of definitions is what tells him the piece is for him.
- Writes as an insider (`we`), implicated in the problem — never as a critic throwing rocks at the
  industry, and never blaming named people.
- **Length: 1,000–1,400 words of body text** (the normal 600–900 target does NOT apply). The floor is
  the point: you cannot steelman, model, restate in three units and hand off in 600 words. If the piece
  cannot honestly reach 1,000, it has failed the position bar — do the arithmetic, do not pad. If it
  will not pass 1,400, split it.
- **Concepts:** teach the **reframe**, not a new noun. A position piece usually teaches 1 concept (e.g.
  `cross-subsidy-as-product`), sometimes 0. Do NOT reach for an adjacent general-insurance definition
  just to have something quiz-able — that is how this tab drifted. If `concepts_taught` is empty, tag
  the `quick_check` question to a `concepts_reinforced` id and make it test the ARGUMENT (given these
  inputs, what follows?), not a definition.

## House style
- Voice: confident, plain, Australian — a sharp analyst briefing a smart friend. No throat-clearing.
- Open with the single most newsworthy or useful sentence. Close with a specific next action or a
  dated thing to watch, under a heading you have NOT used this week ("The bottom line" is worn out).
- **Earn the open.** The `title` and `summary` are the ONLY things the reader sees on the hub card
  before deciding whether to read — the best article in the world doesn't count if the card is skipped.
  So the title states the actual finding ("Negative gearing has a runway until 2027"), not the subject
  area ("An update on negative gearing"); and the summary is the specific promise the piece keeps, in
  one sentence, not a table of contents. Neither may be vague, coy, or a question the piece answers in
  paragraph one. Ask honestly: knowing what they know, would the reader open this over their phone's
  home screen? If not, the angle is wrong — fix the angle, not the wording.
- Banned more than once per article: *actually*, *worth watching*, *worth noting*, *it's important to*,
  *the key thing*. Use an em-dash construction at most twice per article. Vary sentence rhythm.
- Titles: informative and specific; no colon-subtitle unless it adds information.

## Editor pass (mandatory — re-read the article before the updates)
This is where the day's quality is actually won, and with one article there is budget to do it properly.
Re-read the piece as an editor — not as its author looking for typos — fix what fails, then state one
pass/fail line per check:
1. **Card test** — would the reader open this on the strength of the `title` + `summary` alone? Does the
   title state the finding rather than the topic? (See "Earn the open".)
2. **Cut it** — tighten by roughly 10–15%: delete every sentence that restates the previous one, every
   throat-clearing lead-in, every "in this article we'll". Length is a budget, not a target; if the
   piece is done at 620 words, it's done. Never pad to reach a number. (On a `position` piece, cut for
   density but respect the 1,000-word floor — if cutting takes it under, the argument was too thin to
   be a position piece.)
3. **Substance** — does it make a claim the reader couldn't have guessed from the title? If it only
   confirms the obvious, find the sharper angle or the surprising figure and lead with that instead.
4. **Current bar** — `current` pieces: ≥3 dated, concrete facts present; live.json quoted for
   finance/markets/property (or say why not relevant). **Skip for `shape: position`** — use step 4b.
4b. **Position bar** (`shape: position` only) — contested question stated; opposing case steelmanned
   and conceded before the turn; one original calculation with ALL inputs stated; key number given in
   three units; closes inside the reader's authority. If any is missing, fix it — a position piece that
   fails this is a summary wearing a thesis.
5. **en-AU** — no US spellings (color, center, organize, analyze, behavior, -ize verbs) in body or headings.
6. **Privacy** — no proper noun from `profile.local.json` appears anywhere (project names, employer,
   people, places). Articles are PUBLIC.
7. **Sources** — every URL real, resolvable, https, on the publisher's own domain; no redirect tokens,
   no placeholders.
8. **Voice** — house style above: banned-phrase count, fresh closing heading, ≤2 em-dash constructions.
9. **Quiz** — one question per taught concept; correct indices vary; correct option not the longest;
   distractors plausible.
10. **Length** — 450–1,100 words of body text (target 600–900), after the cut in step 2. For
   `shape: position`: **1,000–1,400**.
11. **Meta** — `mode`, `interests`, `expire_at` per rules; concept ids kebab-case; taught ≤3; on a
   position piece `shape` is present and set to `"position"` (every length and bar rule keys on it —
   omit it and the piece silently reverts to the news-brief rules). Every id in `interests` must earn
   its place against **that tab's** stated `want` — not by sharing a noun with it. A colour-theory piece
   is not `software-ai` because interfaces are software; drop the tag rather than stretch it.

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
   - If a due concept genuinely fits today's article, weave it in: reference it and build on it (don't
     re-explain it from scratch), list its id in `concepts_reinforced`, and include one
     application-level `quick_check` question tagged with it. Passing that question advances the
     concept's review schedule exactly like a taught concept. With one article a day most due concepts
     WON'T fit — that's expected, and forcing an off-topic concept in to tick this box is worse than
     carrying it. The quizbank entry below is what keeps a carried concept from being lost.
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
