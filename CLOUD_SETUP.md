# Cloud setup — daily writing without keeping your PC on

The site writes itself each morning via **GitHub Actions** on your **Claude subscription** (no API
bill, no PC needed). Your phone just reads from GitHub Pages. One-time setup, ~10 minutes.

## What goes to the cloud (and what doesn't)
- **Up:** two encrypted GitHub **secrets** — your Claude subscription token and your reader profile.
- **Stays on your PC:** your raw `~/.claude` memory. Only the distilled `profile.local.json` is uploaded
  (as a secret), and it's written to a gitignored file at runtime — never committed, never public.
- **Already public:** the articles and your reading state (no personal data; the writer is barred from
  putting any in).

## Steps

1. **Create the repo + push.** Public is fine (Pages is free on public repos):
   ```bash
   cd personalised-reading
   git init && git add -A && git commit -m "init"
   gh repo create personalised-reading --public --source=. --push
   ```

2. **Turn on Pages via Actions:** repo → **Settings → Pages → Build and deployment → Source = GitHub
   Actions**. Then set `data/config.json` → `siteUrl` to your Pages URL
   (`https://<you>.github.io/personalised-reading`), commit, push.

3. **Make your subscription token** (one-time, on your PC — needs your interactive login):
   ```bash
   claude setup-token
   ```
   Copy the printed token (valid ~1 year).

4. **Add the two secrets:** repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - `CLAUDE_CODE_OAUTH_TOKEN` = the token from step 3.
   - `READER_PROFILE` = the **entire contents** of `data/profile.local.json` (paste the JSON).

5. **Test it:** repo → **Actions → Generate → Run workflow**. Watch it ingest → author → build → deploy.
   Then open your Pages URL and read today's issue. (Tune the cron time in
   `.github/workflows/generate.yml`, and `maxArticlesPerRun` / model to taste.)

## Maintenance & safety
- **Annual rotation:** the token expires after ~1 year (and headless tokens don't auto-refresh). When a
  run fails with an auth error, re-run `claude setup-token` and update the `CLAUDE_CODE_OAUTH_TOKEN`
  secret. That's the only recurring chore.
- **Keep runs short.** Headless OAuth tokens can drop after ~10–15 min, so the job is capped
  (`maxArticlesPerRun`, `--max-turns`, a 12-min timeout). Don't raise these much.
- **Terms of service:** OAuth is licensed for subscribers' "ordinary use." A small personal daily digest
  is very plausibly that, but Anthropic doesn't define it and *could* flag high-volume automation. Keep
  volume modest. If they ever ask you to move to the API, that's the fallback.
- **Secrets are safe on a public repo** for `schedule`/`workflow_dispatch` runs (GitHub never exposes
  secrets to pull requests from forks). Never print them in a step.
- **Update the profile** by re-pasting the `READER_PROFILE` secret whenever `profile.local.json` changes
  (e.g. after a weekly local refresh from your memory).

## Usage tracking

Every run appends one line to **`data/usage-log.jsonl`** (committed, so it accumulates):

```json
{"date":"2026-06-27","articles":4,"cost_usd":0.0,"input":...,"output":...,"cache_read":...,"cache_creation":...,"turns":...,"model":"claude-sonnet-4-6"}
```

The **token counts** (`input`/`output`/`cache_read`) are the reliable figures; `cost_usd` is Claude
Code's own client-side *estimate* (handy for trends, not billing-exact — and on a subscription you don't
pay per token anyway). After a few days you (or I) can chart `data/usage-log.jsonl` to see real daily
usage and decide whether to keep 4 articles/day or dial it. If `cost_usd`/tokens log as `null` on the
first run, the execution-output path needs a one-line tweak — tell me and I'll fix it from the real file.

## Fallback (no cloud)
If you'd rather not run on the subscription in CI, the same pipeline runs locally: `node
scripts/ingest.mjs` then `claude -p` against `skills/AUTHORING.md`, then `node
scripts/generate-index.mjs`, then commit. Schedule that with Windows Task Scheduler ("run when
available" for catch-up). Nothing leaves your machine.
