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
data/
  config.json           interests (tabs), audience, passThreshold, maxArticlesPerRun, siteUrl, repo
  sources.json          RSS feeds per interest
  pool.json             ingested-but-unpublished items (the Discover queue reads this)
  manifest.json         GENERATED catalog the app reads
  knowledge.json        concept graph + is_learnt state
  reading-state.json    user read/quiz state (synced from the browser)
  seen.json             ingest dedup keys
  profile.local.json    PRIVATE reader profile — GITIGNORED, never committed (see Privacy)
.github/workflows/      generate.yml (daily author), deploy.yml, ci.yml, health-check.yml, scout.yml
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
  ~15min → keep `maxArticlesPerRun` small (currently 2) + `--max-turns` modest.
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
