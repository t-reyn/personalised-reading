# Personalised Reading

A reading list that **writes itself** and **learns what you know**. A static site where Claude
authors knowledge-aware articles from your chosen feeds, you read them in tabs by interest, and a
quick-check quiz tracks what you've actually learnt — so future articles never re-explain what you
know nor assume what you haven't read yet.

- **No backend, no database, no paid API.** Content is committed HTML; state is committed JSON.
- **Generation** runs through **Claude Code on a subscription** (a scheduled routine), not the API.
- **Hosting**: static, on GitHub Pages (free).

## How it fits together

```
feeds → Claude Code routine → commits articles/ + updates data/*.json
      → scripts/generate-index.mjs builds index.html + feed.xml + sitemap.xml + data/manifest.json
      → GitHub Pages serves it → you read in the browser/PWA
      → marking read / passing a quiz writes data/reading-state.json + data/knowledge.json back
        (via a scoped GitHub token) → the next routine run sees it
```

## Commands

```bash
node scripts/generate-index.mjs        # rebuild hub + feed + sitemap + manifest from articles/
node scripts/generate-index.mjs --strict   # treat extraction warnings as errors (authoring gate)
node scripts/ingest.mjs --dry-run      # fetch feeds, show what's new, write nothing
node scripts/ingest.mjs                # fetch feeds → append new items to data/pool.json
```

Run a local server to preview (any static server), e.g. `npx serve .` or `python -m http.server`.

See **CLAUDE.md** for the authoring contract and architecture details.
