# Glossary top-up — append a batch of dev terms (keep it lean)

You extend `data/glossary.json`, the "dev term of the day" list the hub banner walks through one
term per day. This runs unattended on a tight budget: read the file once, append one batch, stop.

## The reader

A smart professional who is **not a developer**, learning the vocabulary so they can follow what
Claude Code, GitHub, and developers say. Every entry must land for someone with no programming
background — but the early basics have already been covered, so later batches can safely lean on
vocabulary that appears **earlier in the list** (and only on that).

## What to do

1. Read `data/glossary.json` once. Note `start_date`, the batch size range in `topup`
   (`batch_min`–`batch_max`), and every existing `term` (your batch must not duplicate any of
   them, case-insensitively — "CI" duplicates "ci").
2. Append **`batch_min`–`batch_max` new entries to the END of the `terms` array**, each shaped
   exactly like the existing ones:
   - `term` — the word/phrase as developers actually write it.
   - `def` — one or two plain-English sentences (≤ ~40 words). No circular definitions; any jargon
     used inside a `def` must itself appear earlier in the list.
   - `eg` — one short "how you'll hear it" line, matching the existing voice: a quoted usage plus
     a gloss, e.g. `"\"Wait for CI\" = don't merge until the robot finishes its checks."`
3. Append one entry to the `batches` log: `{ "added": "<today YYYY-MM-DD>", "count": <N> }`.
4. Stop. Do not edit anything else.

## Choosing terms

- **Fill real gaps first**: vocabulary the reader will actually meet in Claude Code output, PRs,
  CI logs, and dev conversation that the list doesn't cover yet.
- **Stay current**: include genuinely new/rising vocabulary — AI-assisted development (agents,
  context window, RAG, MCP, prompt caching, evals…), and whatever has entered common dev usage
  since the last batch. This is why the list is topped up instead of written once.
- **Ramp difficulty gently**: the list is consumed in order, so a batch appended a year in can
  assume the reader has seen the earlier terms — build on them; never re-explain them.
- Keep the register consistent with the existing entries: plain, precise, lightly wry, **en-AU**
  spelling. No personal data of any kind — this file is PUBLIC.

## Hard rules (CI enforces these — a violation throws the whole batch away)

- **Append-only.** Never remove, reorder, or rename existing entries; never change `start_date`.
  Both would silently change which term shows on which day. (Fixing a typo inside an existing
  `def`/`eg` is allowed.)
- No duplicate `term` (case-insensitive, trimmed).
- Every entry has non-empty `term`, `def`, and `eg`.
- The file must remain valid JSON. `node scripts/glossary-check.mjs --prev <snapshot>` is the
  gate the workflow runs; nothing commits if it fails.
