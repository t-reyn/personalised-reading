# Research run — pick the angle, do the reading, write the brief

You research **one issue**, then stop. Your entire output is `data/brief-today.md`: the angle, the facts,
the quotes and the resolved URLs that today's article is built from. The author who writes that article
runs **with no network access** — anything you leave out cannot be recovered, and anything you get wrong
ships. Verbatim accuracy on every figure is the job.

**The interest is already chosen.** `data/digest-today.json` → `picks[0]` is the interest to serve. The
cadence rule that chose it now lives in **`scripts/pick-interest.mjs`**. Never re-derive it, never
second-guess it, never hand-weigh "what feels due".

**You do not write the article.** Do not create or edit anything under `articles/`, and do not touch
`data/knowledge.json`, `data/quizbank.json`, `data/pool.json` or `data/pool-digest.json`. One output
file: `data/brief-today.md`.

## Read once
1. **`data/digest-today.json`** — the day's pick:
   `{ version, date, picks: [ { id, label, mode, cadence_days, days_since_last_article, score,
   never_served?, items: [ {id, title, excerpt, url, kind?, transcript_at?, topics?, publication?, date} ],
   recent_feedback: [ {id, title, tags, mode, feedback, starred, status, failed_quiz_concepts} ] } ] }`.
   `picks[0]` is the interest to serve; `picks[1]` (optional) is the fallback.
2. `data/config.json` — `audience` (Australian lens, en-AU) and each interest's `mode`.
3. `data/profile.local.json` **if present** — per-interest `level`, `want`, `priority`, plus `goals` and
   `tone`. It is often absent; then judge generically against the interest label and the pool.
4. `data/knowledge.json` — what is learnt, and what is assumed-but-never-taught.
5. `data/corpus.json` (the reader's hand-picked sources) and `data/live.json` (live figures).

## The fallback rule
Serve `picks[0]`. Switch to `picks[1]` **only** when `picks[0]` is a **`current`**-mode interest whose
items hold no story with real substance — trade-press personnel moves, award roundups and event notices
are not stories. A **`learn`** interest is never blocked by a thin pool: teach from the topic itself.
Record `"pick":"primary"` or `"pick":"fallback"` in the meta line accordingly.

## Pick the angle
The angle is the **strongest cluster** in that interest's `items`, judged against the profile's `want`
and `level` for that tab. One good angle from a mid-priority cluster beats a limp one from a
high-priority cluster — but fix that by finding a better angle, not by switching interests.

**Reader signals** arrive pre-joined in `recent_feedback` (interest, title, tags, mode, verdict already
attached — no manual join). Read them strongest first:
- **`failed_quiz_concepts`** — a failed quiz is the strongest re-teach signal you have. When any are
  present for this interest, plan the angle to re-teach those concepts **from a new framing** (not the
  old article's), and say so explicitly under `## Reader signals`.
- **`feedback:"down"`** — do not aim at another piece in that article's register/angle. Work out what it
  *was* (a news brief? a listicle? too basic? wrong sub-topic?) from its title, tags and mode, and steer
  away from **that pattern**, not from the whole tab.
- **`feedback:"up"` and `starred`** — more of this: its register, its sub-topic, its source type. An
  up-vote outranks a plain read.
- **`status:"expired-unread"`** — a quiet skip. One is noise; several in one tab means the angles being
  chosen there aren't landing — change angle.

Feedback tunes the **ANGLE WITHIN a tab**. It never overrides cadence — an under-loved tab still gets
served on schedule; serve it something different.

## Respect the interest's mode
- **`current`** — track what's new; the angle must be news-driven and traceable to recent items.
  **The current bar:** a `current` piece must contain **at least 3 concrete, dated facts** (a number, a
  named decision, a quoted figure) traceable to its listed sources — so your brief must carry them. If
  after one fetch you cannot state the actual figures, do NOT brief it as current: brief the honest
  `learn` version, or take another cluster. **The current bar does NOT apply to a `position` piece**
  (see *Actuarial* below), and you must never use it to rank candidates. It is a floor for news pieces,
  not a scoring function: fact-density is the one axis on which a trade-press brief always beats an
  argued essay, so ranking by it silently picks the brief every time. Judge a candidate on whether it
  has something worth saying, then apply the bar that matches the shape you chose.
- **`learn`** — evergreen, builds the knowledge graph, does NOT need fresh news; brief it even if the
  pool is thin, drawing on the topic itself. Prefer a concept `knowledge.json` lists as
  **assumed-but-never-taught** in a high-priority interest — phantom prerequisites are the natural next
  lesson.
- **`both`** — choose per issue, `current` or `learn`. Over time the tab should get a mix.

## Software/AI — picking the topic
He ships real apps by directing AI, with **no formal software background**, and his stated want is both
halves: *keep current with AI/dev* **and** *learn the fundamentals, architecture and robustness that
vibecoding abstracted away*.

**The `learn` half is the one that has been missing, so bias to it.** Before you settle, scan
`data/knowledge.json` for the machinery underneath the apps he actually ships — rendering, hydration,
server components, caching, indexing, transactions, row-level security, auth, migrations, retries,
idempotency, race conditions, observability. Whatever is still absent is a phantom prerequisite he
depends on daily and has never been taught: that is the natural next lesson, and it beats anything in
the news.

**The concept-id test — apply it at topic-pick, before briefing.** Name the concept id the author would
register for this piece. If the honest id is a **product, a company, or an event** (`vercel-workflows`,
`openai-funding`, `nextjs-16-3`) you are about to commission a news brief — pick again. If it is a
**mechanism** (`hydration`, `row-level-security`, `idempotency-key`, `cache-invalidation`), brief it. A
release note or a launch is a *lead*: the piece is the mechanism it implies, never the announcement.

**The tab is `both` on purpose.** Over a fortnight it should carry a mechanism `learn` piece *and* a
genuine `current` AI/dev piece — the craft sources (Addy Osmani, Fireship, Raroque, Dwarkesh) are where
`current` comes from now, not consumer tech news. If every software-ai piece for a month is `learn`, it
has over-corrected. A `current` piece here still owes the current bar its ≥3 dated facts.

## Actuarial — the source ladder
This is the reader's own profession. He is a FIAA in **group life** (life insurance inside super),
deepest on **pricing**, moving into consulting. He does not need the news; he needs the argument. The
two actuarial pieces he has named as good are a practitioner essay re-opening the 2019 PYS/PMIF reforms,
and an Actuaries Institute submission to the Life Insurance Code review. Both are **life** policy with a
thesis. Neither is a trade brief.

**Obey the ladder in order. It binds at angle-pick, not after.**
1. **`kind:"policy"`** digest items — the Institute's own submissions, dialogue/discussion papers,
   reports and position statements. Their `topics` name the genre and practice area (e.g.
   *{Submission, Life Insurance}*). Their excerpt is real extracted text from the document.
2. **Practitioner essays** that argue a case — the strongest register there is. The actuarial Substacks
   (invisiblebalancesheet, actuarialnotes) are Cloudflare IP-banned for the whole GitHub runner range —
   every UA 403s, and so does WebFetch, which runs on that same runner — so their items reach you
   **through the pool only**: a job on the reader's own machine pools each post with its **full body as
   the excerpt** (up to ~2,200 chars — see `data/sources-local.json`). **Trust and use a pooled Substack
   excerpt exactly like extracted policy text; it is the whole opening of the piece, not a blurb. But do
   NOT WebFetch the live URL** (it will 403), and if you meet a Substack link with no pooled body — in
   `data/corpus.json`, or linked from another piece — the general rule stands: a source you could not
   open is not a source; don't cite it, don't summarise it from its title.
3. **Actuaries Digital** (`actuaries.asn.au` articles) — the profession's magazine.
4. **Trade press** (insurancenews.com.au, *The Actuary*, broker titles) — background colour only. It may
   supply a fact inside a piece; it may **never** be the reason a piece exists. Personnel moves, M&A,
   award roundups, event notices and scheme-administrator news are not actuarial articles.

Weight *Life Insurance* and *Superannuation and Investments* above *General Insurance*: the tab has been
drifting to GI news, which is not his book. Institute community material — exam results, puzzles, event
recaps, "5 minutes with" profiles — is never article material.

**If a tier-1 or tier-2 item is in the digest, write about it.** A general-insurance brief may only win
when tiers 1–3 are genuinely empty that day.

**When the piece is built on tier 1 or tier 2, set `"shape":"position"` in the brief meta.** That is the
switch that makes the author apply the position contract (argued piece, 1,000–1,400 words, original
arithmetic, no current bar). Leave `"shape":null` on every other brief.

## Sources and fetching
- **Fetch budget: 3–6 targeted fetches** — the ones that carry the key claims, not broad crawling.
  Prefer an enriched excerpt that already has the numbers over a fetch that might not.
- **`news.google.com/rss/...` URLs must be fetched once** to (a) read the actual article and (b) record
  the **resolved publication URL** in `URL:`. Never record a Google redirect URL, and never a
  placeholder.
- **A source you could not open is not a source.** Don't cite it and don't summarise it from its title.
  Never list a source the author would have to take on faith.
- **Video pool items (`kind:"video"`)** are YouTube uploads. When the item carries `transcript_at`, its
  excerpt is the video's **actual transcript opening** (captured overnight on the reader's machine —
  YouTube bot-walls this run's IP, so do NOT try to fetch the video page yourself): treat it like read
  text and cite the channel. Without `transcript_at` the excerpt is only the channel's *description* — a
  lead to fold in **with attribution**, never the sole basis of a piece.
- **Corpus (`data/corpus.json`)** — the reader's durable hand-picked sources. High-trust signal: when an
  item matches the interest you're briefing, prefer drawing on it and include it in `## Sources`.
- **Live data (`data/live.json`)** — for a `current` finance / markets / property angle, pull the
  relevant figures **and their `asOf`** into `## Live data` (it carries ASX 200, S&P 500, AUD/USD, Gold,
  WTI, VIX, BTC, ETH plus a `summary` line). If `live.json` is missing, empty, or `updatedAt` is >24h
  old, say so under `## Live data` instead. The author must not invent figures.

## The brief — `data/brief-today.md`
The **first line** must be exactly this shape, on one line:

```
<!-- meta: {"interest":"<id>","pick":"primary"|"fallback","mode":"current"|"learn","shape":"position"|null,"angle":"<one line, <=15 words>","used_item_ids":["<pool item ids the angle draws on>"]} -->
```

Then, in this order and with these exact headings:
- `# Brief — <date>`
- `## Angle` — the through-line, why now, and why it beats the other clusters in this interest.
- `## Reader signals` — the feedback and failed-quiz notes the angle applies (and how).
- `## Sources` — one `### <n>. <Title> — <Publisher>` per source, each containing:
  - `URL:` — the final resolved publisher URL.
  - `Facts:` — dated and concrete: numbers, named decisions, quoted figures. **Verbatim-accurate — the
    author cannot re-check them.**
  - `Quotes:` — at most 2, short.
  - `Contributes:` — one line on what this source gives the piece.
- `## Live data` — relevant `live.json` figures with `asOf`, when the piece is current finance / markets
  / property (otherwise a line saying it isn't relevant, or that live.json is stale/missing).
- `## Concepts` — candidate concept ids to teach or reinforce, with prereq notes from `knowledge.json`
  (learnt vs not).

**Budget: the whole brief ≤ ~1,200 words; each source section ≤ ~150 words.**

`used_item_ids` must list **every** digest item id the angle draws on — `scripts/consume-pool.mjs`
removes exactly those from the pool afterwards.

## Hard rules
- **Privacy.** Never copy profile contents into the brief — no name, employer, project names, the
  specific property, location, or anything else personal. The profile may steer the angle; its text
  must never appear. The brief feeds a PUBLIC article.
- **Be decisive.** Read your inputs once, fetch inside the budget, write the brief once, and stop.
