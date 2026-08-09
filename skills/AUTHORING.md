# Authoring run — write today's issue (ONE article, made to be read)

You write **one article**, edit it hard, then stop. That article is the reader's entire issue for the
day: there is no second piece to carry the day if it's weak, and a day that isn't worth opening is a day
they skip. Volume was cut to one **precisely so this piece can be good** — spend the budget on the
writing and the editing. Depth is the point; padding is not.

**The research is done.** The angle, the sources, the facts and the URLs are already decided and written
up in **`data/brief-today.md`** by the research step. You work **only** from that brief.

**You have NO network access.** There is no WebFetch in this run. Never invent a source, a figure, a
quote or a URL, and never "recall" one from memory. If the brief does not support a claim, write the
piece the brief honestly supports — a narrower true article beats a wider invented one.

Still finish inside the run's time + turn budget: be decisive, don't re-read files you've already read.
Draft once, then fix it in the **Editor pass** below.

## Read once (in this order)
1. **`data/brief-today.md`** — the whole basis of the piece: its meta line (`interest`, `pick`, `mode`,
   `shape`, `angle`, `used_item_ids`), then `## Angle`, `## Reader signals`, `## Sources`
   (`URL:` / `Facts:` / `Quotes:` / `Contributes:` per source), `## Live data`, `## Concepts`.
2. `data/config.json` — `audience` (Australian lens, en-AU) and the interests' `ttlDays` and `mode`.
3. `data/profile.local.json` **if present** — the reader: per-interest `level`, `want`, `priority`, plus
   `goals` and `tone`. Pitch to it. (Often absent; then pitch to the brief's stated level of detail.)
4. `data/knowledge.json` — concepts already learnt. Never re-explain these.
5. `templates/article.html` — copy this for the article.
6. `data/quizbank.json` — at update time only (see "Two quick updates").

## Write the article
- Copy `templates/article.html` → `articles/YYYY-MM-DD/<slug>.html` (today's date **in AEST**, not UTC;
  `<slug>` kebab-case). Fill every `{{PLACEHOLDER}}` and the `#meta` JSON.
- **Synthesise** the brief's sources into one original **600–900 word** piece (hard floor **450**, hard
  ceiling **1,100** — if the material wants more, save the rest for another day). Synthesis means the
  piece's structure comes from **YOUR analysis**, not from the source list: if each heading corresponds
  to exactly one source, restructure around the through-line connecting them. A brief/roundup must still
  name names and numbers — "multiple lenders" and "data points to rising arrears" are not publishable
  claims; use the figure from the brief's `Facts:` lines or cut the claim.
- **Sources.** The `sources` array is **exactly the brief's resolved URLs**, listed as given — no
  additions, no substitutions, no reconstruction from memory. If a URL isn't in the brief, it isn't in
  the article.
- **Live figures** come only from the brief's `## Live data`, quoted with their `asOf`. If the brief says
  live data is stale, missing or not relevant, write without it — never invent a figure.
- **Mode style.** A `current` piece leads with what changed and why it matters to the reader, and sets
  an `expire_at`. A `learn` piece teaches one idea well, from the reader's stated level up, and omits
  `expire_at` (or sets it far out per `ttlDays`). Never write "the data should show…" about a release
  you claim just happened.
- **Knowledge-aware:** never re-explain a concept with `review_level >= 2` (verified learnt). For
  `review_level 1` (passed once) a one-sentence refresher is allowed. Briefly teach an assumed
  prerequisite inline rather than assuming it — or hold the idea if the piece depends on an unlearnt
  prereq. For software/AI the reader "vibecodes" — explain fundamentals + the *why*. Where a learnt
  concept exists, **build upward from it**: reference it and go deeper, don't sidestep it.
- **Difficulty (new concepts only):** when you register a genuinely new concept in `data/knowledge.json`
  (see "Two quick updates" below), assign it a `difficulty` judged against the reader's pitch level for
  that interest: `"easy"` — a broad, intuitive idea the reader will retain from one read (it never
  resurfaces for review); `"medium"` — the typical case (first review after ~3 months); `"hard"` —
  technical, quantitative, regulatory-detail, or counter-intuitive (first review after ~2 months). This
  drives how soon, if ever, the concept comes due for the reinforcement rule below.
- **Australian lens** per `config.audience` where relevant; cover global developments too. Be **applied**
  where the profile asks (e.g. indie-income, property): concrete, do-this-next guidance with worked AU
  examples, not general overviews. Subtly honour the profile's `flavour` only where it fits naturally —
  never force it.
- **Carry-forward is suspended** — write fresh pieces; leave `merged_from: []` and `merged_into: null`.

## The `#meta` contract
```json
{
  "id": "2026-06-25-slug", "slug": "slug",
  "interest": "software-ai", "interests": ["software-ai", "design"], "mode": "learn", "shape": "position",
  "title": "…", "summary": "…", "tags": ["…"],
  "created_at": "2026-06-25", "expire_at": "2026-07-16",
  "concepts_taught": ["concept-id"], "concepts_assumed": ["prereq-id"], "concepts_reinforced": [],
  "sources": [{ "title": "…", "url": "https://…" }],
  "merged_from": [], "merged_into": null,
  "quick_check": [{ "q": "…", "options": ["…","…","…","…"], "correct": 0, "concept": "concept-id" }]
}
```
- **`interest`** — the PRIMARY interest id (the brief's `interest`). **`interests`** — ALL interest ids
  the piece genuinely fits, primary first (**1–3**). Every id must **earn its place** against *that
  tab's* stated `want`, not by sharing a noun with it.
- **`mode`** — `"current"` or `"learn"` for THIS article; take it from the brief's meta line.
- **`shape`** — optional, and only ever `"position"`. **Take it from the brief's meta line**: if the
  brief says `"shape":"position"`, set it here and apply the position contract below; otherwise omit it.
  Every length and bar rule keys on it — omit it on a position piece and the piece silently reverts to
  the news-brief rules.
- **`expire_at`** — per mode + the interest's `ttlDays` in `config.json` (omit for `learn`, and whenever
  `ttlDays` is `null` ⇒ never expires).
- **`concepts_taught`** — max **3** per article, stable kebab-case ids. **`concepts_assumed`** — the
  prerequisites you leaned on (also registered in `knowledge.json` — see updates below).
  **`concepts_reinforced`** — already-learnt concept ids this article deliberately weaves in and builds
  on for spaced review; `[]` when this article isn't reinforcing anything.
- **`quick_check`** — **one question per taught concept** (so 1–3), each tagged with its `concept`,
  **plus one application-level question per reinforced concept** (tagged with that concept's id).
  Quiz craft rules: every distractor must be a plausible misconception a reader of this article could
  hold, within **±30%** of the correct option's length; at least one question must require **APPLYING**
  the idea to a new scenario (a calculation, a case, a decision), not recalling the article's wording;
  vary the correct index — across today's questions do not repeat the same index, and use **0 and 3 as
  often as 1 and 2**.

## Software/AI — the pitch
He ships real apps by directing AI, with **no formal software background**. He knows
Next.js/React/Supabase/Vercel/Capacitor at ship-it level — **never explain what they are, always explain
how they work and what breaks**. Concrete failure modes from his own kind of app beat abstractions.
Design and UX belong to the **design** tab: an interface piece is not a software piece just because
interfaces are software.

(Choosing the software/AI topic — the learn-bias, the concept-id test, the `both` balance — now lives in
`skills/RESEARCH.md`; the brief has already made that call.)

## Actuarial — the position piece
This is the reader's own profession, and the brief's meta line tells you when the piece is one: if it
carries `"shape":"position"`, write an argued piece, not a report. A position piece:
- **Answers a contested question** the profession has not settled — one where a competent actuary could
  hold the other view. If the question has an agreed answer, you are writing a summary; find the live
  question in the brief or write it as a `learn` piece.
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
- **Names one real case** if the brief supplies one, in ~90 flat words. Mechanism and facts only. No
  grief narration.
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
  home screen? If not, the angle is being expressed wrongly — sharpen how you're telling it.
- Banned more than once per article: *actually*, *worth watching*, *worth noting*, *it's important to*,
  *the key thing*. Use an em-dash construction at most twice per article. Vary sentence rhythm.
- Titles: informative and specific; no colon-subtitle unless it adds information.

## Editor pass (mandatory — re-read the article before the updates)
This is where the day's quality is actually won, and with one article there is budget to do it properly.
Re-read the piece as an editor — not as its author looking for typos — fix what fails, then state one
pass/fail line per check. One pass, no fetching.
1. **Card test** — would the reader open this on the strength of the `title` + `summary` alone? Does the
   title state the finding rather than the topic? (See "Earn the open".)
2. **Cut it** — tighten by roughly 10–15%: delete every sentence that restates the previous one, every
   throat-clearing lead-in, every "in this article we'll". Length is a budget, not a target; if the
   piece is done at 620 words, it's done. Never pad to reach a number. (On a `position` piece, cut for
   density but respect the 1,000-word floor — if cutting takes it under, the argument was too thin to
   be a position piece.)
3. **Substance** — does it make a claim the reader couldn't have guessed from the title? If it only
   confirms the obvious, lead with the sharper angle or the surprising figure the brief gives you.
4. **Current bar** — `current` pieces: **≥3 dated, concrete facts** present, each one traceable to a
   `Facts:` line in the brief (check them against it, verbatim); live.json figures quoted for
   finance/markets/property from the brief's `## Live data` (or say why not relevant).
   **Skip for `shape: position`** — use step 4b.
4b. **Position bar** (`shape: position` only) — contested question stated; opposing case steelmanned
   and conceded before the turn; one original calculation with ALL inputs stated; key number given in
   three units; closes inside the reader's authority. If any is missing, fix it — a position piece that
   fails this is a summary wearing a thesis.
5. **en-AU** — no US spellings (color, center, organize, analyze, behavior, -ize verbs) in body or headings.
6. **Privacy** — no proper noun from `profile.local.json` appears anywhere (project names, employer,
   people, places). Articles are PUBLIC.
7. **Sources** — every URL in `sources` is **exactly** a URL from the brief, https, on the publisher's
   own domain, with no redirect tokens and no placeholders. Verify by **string inspection against the
   brief** — you cannot fetch, and a URL you can't find in the brief must be removed.
8. **Voice** — house style above: banned-phrase count, fresh closing heading, ≤2 em-dash constructions.
9. **Quiz** — one question per taught concept; correct indices vary; correct option not the longest;
   distractors plausible.
10. **Length** — 450–1,100 words of body text (target 600–900), after the cut in step 2. For
   `shape: position`: **1,000–1,400**.
11. **Meta** — `mode`, `interests`, `expire_at` per rules; concept ids kebab-case; taught ≤3; on a
   position piece `shape` is present and set to `"position"`. Every id in `interests` must earn its
   place against **that tab's** stated `want` — not by sharing a noun with it. A colour-theory piece is
   not `software-ai` because interfaces are software; drop the tag rather than stretch it.

## Two quick updates, then stop
1. `data/knowledge.json` — add any genuinely new concept ids you **taught OR assumed**, `is_learnt:false`,
   with a `difficulty` (`"easy"`/`"medium"`/`"hard"`, see the Difficulty rule above; never flip
   `is_learnt` — only the reader's quizzes do that). **Every `concepts_taught`, `concepts_assumed`, AND
   `concepts_reinforced` id MUST exist here** (health-check fails the build otherwise — reinforced ids
   should already exist since they're already-learnt concepts).
2. **Reinforcement + quizbank** — check `data/knowledge.json` for learnt concepts whose `next_review_at`
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

**The pool is no longer yours.** `scripts/consume-pool.mjs` removes the items the brief used
(`used_item_ids`). Do not read or edit `data/pool.json` or `data/pool-digest.json`.

Then you're done — the workflow builds the index, commits, and deploys.

## Hard rules
- **Never put the reader's personal data into any article** — no name, age, heritage, employer, project
  names, the specific property, location, tokens, or anything from `profile.local.json`. Articles are
  PUBLIC; the profile only shapes depth, topic choice, and voice.
- **No network.** Work only from `data/brief-today.md`. Never fetch, never invent a source, figure or
  URL. If the brief is missing or unusable, **stop without writing** and say so — an invented issue is
  worse than no issue.
- Do NOT edit `data/reading-state.json`, `data/config.json`, `scripts/`, or `.github/`.
