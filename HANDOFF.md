# Cortex — project handoff / state

Continuation notes so a fresh chat can pick up Cortex without prior context. Last updated 2026-06-29.
(For the daily authoring contract, see `CLAUDE.md` + `skills/AUTHORING.md`.)

## What it is
**Cortex** — a personal, single-user "reading list that writes itself and learns what you know." A
static, **zero-dependency** vanilla-JS PWA. Claude (on the user's **subscription**, via GitHub Actions —
never the paid API) authors articles as committed HTML each morning; deterministic Node scripts build
the hub/feed/sitemap; a thin app layer adds read-tracking, a quiz→learnt knowledge graph, difficulty-
scaled spaced repetition delivered through future articles (not old-article resurfacing), tabs, and
cross-device sync. Phone-first, also used on PC. Australian (en-AU) reader.

- **Live:** https://t-reyn.github.io/personalised-reading/
- **Repo:** `t-reyn/personalised-reading` (PUBLIC — content + state are world-readable; the personal
  profile is NOT in the repo). Local: `~/Documents/Claude Code/personalised-reading/`.
- Naming history: "Reading" → briefly "Cairn" → **Cortex** (driven entirely by `config.title` +
  `manifest.webmanifest`; renaming again is a ~2-min change + regenerate).

## Architecture
- **No framework, no npm, no build step.** Node ≥20 stdlib + browser-native APIs only.
- `index.html` is **GENERATED** by `scripts/lib/render.mjs` (run via `node scripts/generate-index.mjs`).
  **Never hand-edit `index.html`/`feed.xml`/`sitemap.xml`/`data/manifest.json`/`sw.js`** — change the
  generator. `app.js` + `styles.css` are hand-written.
- All state is committed JSON under `data/`. No database. GitHub Pages (deploy-from-Actions).

## Key files
```
index.html              GENERATED hub shell (edit scripts/lib/render.mjs, not this)
app.js                  hub runtime (views, reader, quiz, sync, modes, multi-topic) — hand-written
styles.css              shared styles (hub + article pages) — hand-written, mobile-first
scripts/
  generate-index.mjs    CLI: scan articles/ → build index/feed/sitemap/manifest/sw
  lib/render.mjs        the actual builders (buildIndexHtml, buildManifest, buildServiceWorker, feed)
  lib/{text,articles}.mjs, lib/*.test.mjs
  ingest.mjs            RSS/Atom → data/pool.json (browser UA, dedup via seen.json, per-interest cap)
  health-check.mjs      zero-dep integrity + freshness check (fails → emails owner)
  validate-sources.mjs  scout: validate candidate feeds → sources.json
  serve.mjs             dev-only static server (PORT via argv[2] or env; default 4317)
templates/article.html  article template + the inline #meta contract
articles/YYYY-MM-DD/*.html   committed articles, each with a <script id="meta"> JSON block
skills/AUTHORING.md     daily author contract (profile-driven, mode-aware, multi-topic)
skills/SCOUT.md         feed-discovery contract
skills/GLOSSARY.md      glossary top-up contract (dev term-of-the-day banner)
data/
  config.json           interests (tabs, each with a cadenceDays), audience, passThreshold,
                        maxArticlesPerRun, siteUrl, repo
  sources.json          feeds per interest — RSS/Atom, plus deliver.kontent.ai JSON (the Actuaries
                        Institute publishes no RSS; ingest.mjs detects the host)
  pool.json             ingested-but-unpublished items (the Discover queue reads this)
  manifest.json         GENERATED catalog the app reads
  knowledge.json        concept graph + is_learnt state
  reading-state.json    user read/quiz state (synced from the browser)
  seen.json             ingest dedup keys
  profile.local.json    PRIVATE reader profile — GITIGNORED, never committed (see Privacy)
  glossary.json         dev term-of-the-day list — consumed in order by the hub banner, one term
                        per day the site is opened (seen days live in reading-state.json and sync;
                        a missed day pauses the walk, never skips a term); topped up in batches
                        by glossary.yml (contract: skills/GLOSSARY.md)
.github/workflows/      generate.yml (daily author), deploy.yml, ci.yml, health-check.yml, scout.yml,
                        glossary.yml (weekly runway check → Claude batch top-up when <30 days left)
```

## Content model (current)
Reshaped 2026-06-29 to be **profile-driven** rather than fixed-sources-per-topic:
- **10 interests** in `config.json`, each with `id/label/emoji/accent/ttlDays/mode`. Order = tab order:
  software-ai, design, indie-income, mortgage-broking, property, actuarial, finance, health, videography,
  science.
- **Modes:** every interest has `mode` = `current` (timely, expires) | `learn` (evergreen, builds the
  knowledge graph) | `both`. Every **article** carries its own `mode` (`current`|`learn`) in `#meta`.
  The app's **Current/Learn segmented filter** (`#modeFilter`, URL-hash `m=`) splits the feed;
  `articleMode()` falls back to the interest's mode then expiry for legacy articles.
- **Multi-topic:** `#meta.interests` is an array (primary first, 1–3); manifest carries it; a multi-topic
  card appears under every matching tab and shows a secondary-topic `.xtag` chip. `interestsOf(a)` is the
  helper; tab counts use unique-unread.
- The **profile** (`data/profile.local.json`) is the steering wheel: per-interest mode/level/priority/
  want, plus goals + tone. The author reads it to choose topics, pitch, and write applied where asked.
- **ONE article per day, chosen by cadence (2026-07-17).** The reader wasn't reading a 2/day feed, so
  `maxArticlesPerRun` = 1 and the freed budget goes into research + editing (bigger fetch budget, an
  11-point Editor pass incl. a "card test" — the title/summary must earn the open — and a mandatory
  10–15% cut). With one slot a day, "different primary interest per run" was meaningless, so rotation
  moved ACROSS days: each interest has a **`cadenceDays`** in config.json (its target gap; this is where
  priority now lives) and the author picks the highest `days_since_last_article / cadenceDays`, never
  repeating yesterday's. Σ(1/cadenceDays) ≈ 1.08/day against 1.0 supply — deliberately just
  over-subscribed so something is always due; a 90-day sim holds every topic near its target gap with
  none starved. **To see a topic more often, lower its `cadenceDays`** — that's the only knob.

## Actuarial: the position piece (2026-07-17)
The reader named two actuarial pieces he likes — a practitioner essay re-opening the 2019 PYS/PMIF
reforms (invisiblebalancesheet, ~1,850w) and an **Actuaries Institute submission** to the Life Insurance
Code review. Both are **life** policy with a thesis; neither is a trade brief.
- **Root cause of the gap (verified, not guessed):** every binding rule rewarded fact-density and new
  quiz-able nouns; nothing rewarded a thesis. The **current bar** ("≥3 dated facts, else pick another
  cluster") is the exact axis on which a trade brief always beats an essay — on 17 July the author
  skipped "Did We Solve the Wrong Problem?" sitting at **position 1 of the actuarial digest** and wrote
  a 568-word Taree flood brief instead. 5 of 7 actuarial pieces were GI news; 4 of 5 fell *below* the
  600-word target. Nothing was ever pressing the 1,100 ceiling — **the missing floor was the problem.**
- **Fix:** the current bar is now explicitly *not* a ranking function; a **source ladder** (policy >
  essay > Actuaries Digital > trade press) binds at topic-pick; and a new `shape: "position"` carries
  its own bar (contested question · steelman-then-concede · one original calculation with all inputs ·
  the key number in three units · counts what the data can't see · hands off inside his authority ·
  no jargon apology) and its own band, **1,000–1,400 words**.
- **Length call:** 1,000–1,400, NOT the exemplar's 1,850. The only *measured* datum is that he starred
  the 1,059-word APRA piece — the longest actuarial article ever written; 1,850 is inferred from someone
  else's Substack. A draft-once run cannot buy 1,850 honestly, and the property he liked is density, not
  word count. Revisit if position pieces land well.
- `shape` is optional #meta, read ONLY by AUTHORING.md + health-check.mjs (app/render/generator ignore
  it, so it cannot break the hub). **health-check counts a different region than the contract** — it
  includes the h1/summary/sources footer and runs ~**+101 words** above "body text" (measured 57–111).
  Its thresholds are therefore 1,200 / 1,500, matching contract bands of 1,100 / 1,400. Keep in step.
  NB health-check is **post-hoc detection, not enforcement** — separate workflow, 1.5h after deploy.
- `--max-turns` 44 → **60**: usage-log.jsonl showed nine consecutive runs pinning exactly 45 turns
  against the 44 cap (16/20 ≥40) and 4/26 runs shipping zero articles. The cap was binding.

## Software/AI: teach the machinery (2026-07-17)
Same disease as actuarial, different costume. The tab's 8-slot digest was 5/8 generic tech news
("Samsung's 55-inch Frame art TV is $200 cheaper", "Xi Jinping: AI Must Be Symphony of International
Cooperation"), and of 15 articles carrying the software-ai tag, **six were design-primary pieces**
cross-tagged in — while **zero** taught the mechanisms under his own stack, which is his stated want.
- **CADENCE BUG (the real find, fixed):** `daysSinceLastArticle` counted the `interests[]` ARRAY, so a
  cross-tagged design piece reset software-ai's clock. It was PRIMARY on only 4 of 15 — array clock never
  exceeded 3 days while the real gap was 13, so the old flat "≥5 days" starvation rule **never fired for
  it**, and the cadence rule that replaced starvation reads the same number (the bug survived the
  rewrite). Now **primary-only**. Measured across all 10 interests this changes the answer for
  software-ai ONLY (13 vs 1) — every other tab is byte-identical, which is what makes it safe.
- **SEQUENCING MATTERS:** the clock fix alone makes software-ai the top scorer (1.86) on the very next
  run — against whatever the digest holds. Clock + sources + rules must land in ONE change, or the tab
  wins and writes about Samsung TVs.
- **Sources: 6 → 7 feeds.** CUT theverge (consumer tech, 3.3/mo), a broad Google-News AI query
  (33/mo — those two mechanically WERE the 5/8 drift), and **hnrss.org/frontpage** (took 2 of 8 slots
  with 0 of 3 pooled items about his stack; the profile says deepen-first, NOT random exploration.
  Aiming it failed: hnrss `?q=` does not bind, `?points=150` buys popular not relevant).
  ADDED, all fetch-verified: **CodeOpinion** (3.0/mo, architecture+robustness), **boringSQL** (3.2/mo,
  Postgres = Supabase), **Next.js blog** (1.7/mo, bursty, the framework he ships), **Addy Osmani**
  (AI-coding craft — serves the "keep current" half in a CRAFT register, not a news one).
- **8 FEEDS IS A HARD CEILING per interest.** `DIGEST_PER_INTEREST = 8` and capRoundRobin's round 0
  breaks the instant it fills the budget, so with 9+ ACTIVE feeds the later rounds never run and the
  LEAST-frequent feeds silently get zero — i.e. exactly the low-volume mechanism feeds. Same failure that
  buried the Actuaries Institute. Actuarial sits at exactly 8; software-ai at 7.
- **Removing a feed now evicts its pooled items immediately** (the `liveFeeds` check in the prune).
  Without it a cut is a no-op for POOL_TTL_DAYS=21: orphans keep their `feed` key, form their own queue
  and keep winning a slot. Cutting theverge + the news query stranded 6 such items until August.
- **The rule is deliberately light** — the sources do the work. No tier ban: the tab is `mode: both` and
  half his want is "keep current with AI/dev", so banning news by tier would silently turn it into a
  `learn` tab (its own 2026-06-27 `current` piece would have failed such a rule). Instead: a
  **concept-id test** at topic-pick (if the honest `knowledge.json` id is a product/company/event, it's a
  news brief — pick again) and a **scan knowledge.json for missing machinery** instruction, which
  self-updates rather than hardcoding "113 concepts and none cover hydration" into a contract that its
  own success would falsify. No new `shape` — that stays actuarial-only.

## Sourcing (how the pool gets its material)
- **The Actuaries Institute is the actuarial anchor (2026-07-17).** actuaries.digital folded into
  `actuaries.asn.au`, which is why its old feed 503s — the site has **no RSS at all** (every `/feed` and
  sitemap path 503s; Google News doesn't index `site:actuaries.digital`). Its CMS (Kontent.ai) exposes a
  **public, keyless Delivery API** which is richer than RSS: editor-written `description`, real
  `publish_date`, and a practice-area taxonomy carried onto pool items as **`topics`** (*Life Insurance*,
  *Superannuation and Investments*, …). `ingest.mjs` detects the `deliver.kontent.ai` host and runs
  `parseKontent` instead of `parseFeed`, so sources.json stays a plain list of URLs. Articles resolve at
  `actuaries.asn.au/research-analysis/<slug>` (verified) so authoring-time WebFetch works. A
  `"Actuaries Institute"` Google-News query sits alongside it to catch press coverage of Institute
  research (Green Papers) that the Institute's own API never carries.
- **The Institute POLICY LIBRARY is the top actuarial source (2026-07-17).** Separate from the magazine:
  `system.type=resource` on the same Kontent API = submissions, dialogue/discussion papers, reports,
  position statements, media releases (~8/month public, ~3/month Life Ins or Super). Pool items get
  `kind:"policy"` and `topics:["Submission","Life Insurance"]`.
  - **GOTCHA — `content_types` is a NESTED taxonomy and Kontent's `[any]` does NOT roll up children.**
    Filtering on the `Publication` parent returns **zero** of the 403 Submissions. The query must list
    CHILD codenames explicitly (see the comment in sources.json). This silently cost the reader's own
    exemplar type on the first attempt.
  - Their `url` element contains the literal placeholder `{{ACTUARIES_ASSET_SUBDOMAIN}}` → resolve to
    `https://content.actuaries.asn.au`. Targets are **PDFs**, and the API `description` is a ~170-char
    blurb, so **without ingest-time extraction the source is decorative** — the author's WebFetch returns
    undecoded binary for a PDF.
  - `pdfToText` is ~45 lines of zlib (zero-dep, in keeping with the hand-rolled RSS/HTML parsers).
    **`isLegible` is not optional:** ~1 in 5 Institute PDFs uses CID/Identity-H fonts and decodes to
    long, plausible-looking mojibake — it fails silently, not loudly, and would poison the pool.
  - **`PDF_EXTRACT_CHARS` (20k) is the load-bearing bound, NOT the size cap.** Extraction cost tracks
    stream COUNT, not bytes: measured, a 5.4MB report extracts in 0.3s but an 8.9MB one took **64s** to
    produce 190k chars that were then truncated to 2.2k. Capping the walk took it to 310ms; 4 policy
    PDFs back-to-back now cost ~0.8s against a 120s budget. Because the work is bounded, the size cap
    could go to 10MB, which is what recovers the flagship life/super reports (Intergenerational Equity
    Index 5.4/7.0MB, Mortality in Australia 8.9MB). Don't "tidy" the bound away.
  - **Measured end-to-end on the 24 most recent policy PDFs: 19/24 (79%) full text, and 10/11 (91%) of
    the life/super subset.** Failures are 4× CID fonts + 1× `/Encrypt`. NB an earlier "~48% encrypted"
    figure was across the whole 6,500-item historical archive and is misleading — **encryption is a
    non-issue on recent items**, so qpdf (which would break zero-dep, and cannot fix CID fonts anyway)
    is not worth it. Encrypted/illegible items stay pooled as title+blurb, never dropped.
  - **No login is needed and one would not help.** 882/883 policy resources are `access_level: Public`
    and every PDF returns 200 fetched anonymously; the `/Encrypt` flag is a document permission bit
    (`P=-1340`: printing and accessibility-extraction allowed, copy bit cleared), not access control — a
    logged-in member downloads the byte-identical file.
  - `trimPdfLead` strips the ~400 chars of letterhead/addressee — without it the digest's 300-char
    window shows a postal address instead of the Institute's position.
- **A LOCAL `ingest.mjs --dry-run` CANNOT validate feeds — only CI can (2026-07-17).** Some publishers
  answer a datacenter IP differently, so the same commit reported **45 fetched / 0 failed locally while
  CI silently dropped four feeds with 403** — for weeks. Never conclude "the feeds are fine" from a home
  run; check `gh run view <id> --log | grep ✗` on a `generate.yml` run. Measured from a runner that day:
  - **Substack is an IP ban, not a header problem.** Every publication 403s **every** UA — browser, honest
    bot, Feedly-style, curl, *no UA at all* — and `/api/v1/archive` (its keyless JSON API) 403s too. No
    header, UA or endpoint fixes it; Cloudflare verifies bots by IP allowlist or signed Web Bot Auth, and
    neither is available to us. `invisiblebalancesheet` + `actuarialnotes` were removed for this reason
    (no route: Google News indexes them 0–1 items, Feedly's cache is empty); `boredombaron` survives only
    because it *is* well indexed, as a Google News `site:` mirror.
  - **A browser UA can be actively HARMFUL.** `nofilmschool.com` 403s our Chrome UA (a Chrome that cannot
    exist in a datacenter scores as a liar) and serves an honest bot UA 200/30 items. Hence `fetchFeed`
    buys **one** honest-bot retry on a 403 — identity, not waiting, is what a 403 responds to.
  - **Don't make the UA global.** A sweep of all 45 feeds under both UAs measured the swap as fixing 1 and
    **breaking 1** (`insurancenews.com.au` 200 → ERR: it hangs on a bot UA). Publishers disagree; identity
    must stay per-response.
- **Round-robin per feed (`capRoundRobin`) — load-bearing, don't "simplify" back to recency.** The pool
  and digest caps used to keep the most recent items across all of an interest's feeds, which handed
  every slot to whichever source posts most: a daily insurance trade wire (~15/day) filled 6 of the
  author's 8 actuarial digest slots with broker gossip, and the Institute (~4/week) got **zero** — adding
  the Institute as a source would have changed nothing visible. Slots are now filled round-robin across
  feeds (newest-first within each, feeds visited in sources.json order so the anchor gets first pick).
  Ranking also uses the **article's own date** (`itemTime`), not `added_at`: every feed in a run is
  fetched seconds apart, so sorting on `added_at` silently ranked by position in sources.json.

## Spaced repetition (review model)
Reworked 2026-07-02 — reviews no longer resurface old articles; they're woven into *future* ones.
- Each learnt concept in `knowledge.json` carries a `difficulty` (`easy`/`medium`/`hard`, set by the
  author at teach time, judged against the reader's pitch level) and steps through a difficulty-keyed
  ladder in `app.js` (`REVIEW_LADDERS`): `easy: []` (never resurfaces — one read is enough), `medium:
  [90, 180]` days, `hard: [60, 120, 240]` days. Past the ladder's end (or for `easy`) the concept
  *retires*: `next_review_at` is set to `null` and it never comes due again. `scheduleNextReview(c,
  fromMs)` computes the next step from `review_level`.
- **Passing** a tagged quiz question (whether the concept was freshly taught or reinforced) sets
  `is_learnt:true`, bumps `review_level`, and reschedules via the ladder. **Failing** keeps
  `is_learnt:false`, forces a same-article retry in 3 days (unchanged), and *escalates* difficulty one
  step (`easy→medium→hard`) so a shaky concept comes back sooner next time.
- **Delivery:** the app never again shows a "time to review" shelf for a learnt concept. Instead, per
  `skills/AUTHORING.md`, the daily author checks which learnt concepts have `next_review_at` within the
  next 14 days and — where a topically-suitable new article exists — references and builds on the
  concept, lists it in that article's `#meta.concepts_reinforced`, and adds one application-level
  `quick_check` question tagged with it. `learnConcepts()`/`reconcileQuizKnowledge()` in `app.js` grade
  `concepts_taught` and `concepts_reinforced` on the exact same path (see `gradableConcepts()`). If no
  article fits, the concept is just carried (still due) and `data/quizbank.json` still gets a fresh MCQ
  for it.
- **What still resurfaces an old article:** only a **failed quiz retry** — the "↻ Try again" shelf on
  Home (`articleRetryDue()`), unchanged from before. The old "⟳ Time to review" shelf, `articleReviewDue`,
  `conceptLearntDue`, `REVIEW_INTERVALS`, and the Library "Review due" tier are all gone; Library now
  splits only into Learnt / Read.

## How the daily run works
`.github/workflows/generate.yml` — cron `0 20 * * *` (6am AEST) + manual dispatch:
tests → `ingest.mjs` → materialise profile from `READER_PROFILE` secret → **Author** (claude-code-action,
`CLAUDE_CODE_OAUTH_TOKEN` secret, subscription) → record usage → `generate-index.mjs --strict` →
commit + push main → Pages deploy. `health-check.yml` runs ~1.5h later and emails the owner on failure.

**Secrets (GitHub Actions):** `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`; ~annual rotation) and
`READER_PROFILE` (= contents of `data/profile.local.json`). Update the profile secret after editing the
profile: `gh secret set READER_PROFILE < data/profile.local.json`.

## State & sync (browser)
Local-first: `localStorage` keys `pr:reading-state`, `pr:knowledge`, `pr:gh-token`, `pr:gh-repo`,
`pr:theme`, `pr:install-dismissed`, `pr:discover-dismissed`. Optional cross-device sync via a fine-grained
GitHub PAT (Contents: Read/write) pasted in **Settings** → writes `data/reading-state.json` +
`knowledge.json`. **Sync is MERGE-based** (per-item union, never clobber): push pull-merges before
writing; every mutation stamps `t`; an empty/stale device can only add. Repo coords default from
`config.json → repo` so a new device only needs the token.

## Local dev / verify
```
node scripts/generate-index.mjs --strict     # rebuild
node --test scripts/lib/*.test.mjs            # tests (CI uses this exact glob)
node scripts/health-check.mjs                 # integrity + freshness (exit 1 = problem)
node scripts/ingest.mjs --dry-run             # test feeds
```
Preview: `.claude/launch.json` has `reading` (port 4317) + `reading2` (4319, if 4317 is busy). Verify at
**1320px desktop AND 375px mobile**; check console for errors. (`.claude/` is gitignored.)

## REDESIGN GUARDRAILS (for the Claude Design rework of the site + PWA)
A redesign changes `scripts/lib/render.mjs` (HTML shell) + `styles.css` — **not** `index.html` directly,
then regenerate. It MUST preserve (or update `app.js` in lockstep with) these load-bearing hooks:
- Body: `data-page="hub"` on the hub, `data-page="article"` + `data-interest` on article pages. Most
  desktop CSS is scoped to `body[data-page="hub"]` so article pages stay untouched.
- IDs the runtime binds: `#tabs #list #search #modeFilter #libraryToggle #statsToggle #discoverToggle
  #archiveToggle #settingsBtn #themeBtn #syncline #resultCount #reader #quiz #settings`.
- Classes: `.card[data-id][tabindex][role]`, `.star[data-star]`, `.restore[data-restore]`, `.shelf-grid`,
  `.shelf-title`, `.card-eyebrow`, `.tier`, `.xtag`, `.disc-card[data-dismiss]`, `.mode-seg[data-mode]`,
  `.app-shell > .sidebar + .content` (desktop shell; `display:contents` below 1024px = mobile unchanged).
- **Tri-font system:** Fraunces (headlines) / Inter (body) / JetBrains Mono (labels) via Google Fonts;
  tokens `--font-head/-body/-mono`. Cream/charcoal palette + per-interest `--accent`; dark mode via
  `html[data-theme]` + `prefers-color-scheme`, no-flash script in the generated `<head>`.
- Aesthetic reference the user likes: **GM-Research** (`ngmicapital/GM-Research`) — full-bleed editorial
  "research terminal" feel, hairline-and-tint depth (few shadows), `color-mix` derived states.
- Importing from Claude Design in the WEB client: DesignSync can't `/design-login` there — use Claude
  Design's "Send to Claude Code Web" or download the `.dc.html`.

## Gotchas (all hit + solved — don't re-discover)
- **Generator job timeout cancels the commit.** A job-level `timeout-minutes` killing the run mid-author
  SKIPS Build+Commit (publishes nothing). Fix in place: time-bound the **author STEP** (`timeout-minutes:
  13`) + `continue-on-error` so the run still commits; job backstop 22m. Headless OAuth token window is
  ~15min → keep `maxArticlesPerRun` small (currently **1** — one well-researched article IS the issue;
  the freed turn budget goes into sourcing + the Editor pass, not a second piece) + `--max-turns` modest.
- **Deploy/CI auth (Windows + gh):** push workflows need the gh token `workflow` scope; push via
  `-c credential.helper= -c credential.helper='!gh auth git-credential'` (the `manager` helper shadows
  the token). In-workflow git push uses `https://x-access-token:${GH_TOKEN}@github.com/...`.
- Each cloud run commits to main → the local clone must `git fetch && git rebase origin/main` before every
  push. `data/knowledge.json` is the usual rebase conflict (browser quiz commits) — keep BOTH sides
  (remote learnt-flags + your new concepts).
- **health-check enforces** that every `concepts_taught`, `concepts_assumed`, and `concepts_reinforced`
  id is registered in `knowledge.json` + freshness ≤ `HEALTH_FRESH_DAYS` (2).
- `data/pool.json` IS served on Pages (Discover needs it) even though it's in `deploy.yml`'s
  `paths-ignore` (ignore only affects which pushes TRIGGER deploy, not what's uploaded).
- Shojin/SeatFlow note: a parallel session may hold port 4317 — use `reading2` (4319).

## Privacy (repo is PUBLIC)
- **Never put personal data in any committed file or published article** — no name, age, heritage,
  employer, the specific property, location, tokens. Enforced in `CLAUDE.md` + AUTHORING.md.
- `data/profile.local.json` is gitignored (`*.local.json`) and lives in the cloud only as the encrypted
  `READER_PROFILE` secret. It holds the rich reader profile (per-interest level/mode/priority/goals/tone)
  — the steering wheel for authoring. Its actual contents are intentionally kept OUT of this public repo;
  full personal detail lives in the user's private auto-memory and the gitignored file. To see it, open
  `data/profile.local.json` locally or ask the user.

## Staged / next (not built)
- Let the new model run a few days, then tune: swap thin new-topic feeds (indie-income / mortgage-broking
  / property / videography are mostly Google-News queries now) for better curated anchors; check pitch +
  cadence (currently 2/day) from real output.
- **Claude Design redesign** of the site + PWA (user-led; respect the guardrails above).
- Self-tuning profile from read/skip/quiz behaviour; promote the Current/Learn tag → two hard sections
  only if it earns it; orphan-branch sync optimisation (deferred — would redo the just-fixed merge sync);
  carry-forward/merge (unread items folding into future articles — in the app, dormant in the author).
