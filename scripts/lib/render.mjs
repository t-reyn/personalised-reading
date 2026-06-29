// Build the generated artifacts: manifest.json, feed.xml, sitemap.xml, index.html.
import { escapeHtml, escapeXml, toRfc822, humanDate } from "./text.mjs";

const live = (items) => items.filter((i) => i.meta && !i.meta.merged_into);

export function buildManifest(items, now) {
  const articles = items
    .filter((i) => i.meta)
    .map(({ meta }) => ({
      id: meta.id,
      slug: meta.slug,
      interest: meta.interest,
      interests: meta.interests && meta.interests.length ? meta.interests : [meta.interest],
      mode: meta.mode ?? null,
      title: meta.title,
      summary: meta.summary,
      tags: meta.tags ?? [],
      created_at: meta.created_at,
      expire_at: meta.expire_at ?? null,
      concepts_taught: meta.concepts_taught ?? [],
      concepts_assumed: meta.concepts_assumed ?? [],
      source_count: (meta.sources ?? []).length,
      merged_from: meta.merged_from ?? [],
      merged_into: meta.merged_into ?? null,
      path: meta.path,
    }));
  return { version: 1, generatedAt: now, count: articles.length, articles };
}

export function buildFeedXml(items, config, now) {
  const site = (config.siteUrl || "").replace(/\/+$/, "");
  const entries = live(items)
    .slice(0, 50)
    .map(({ meta }) => {
      const url = `${site}/${meta.path}`;
      return `    <item>
      <title>${escapeXml(meta.title)}</title>
      <link>${escapeXml(url)}</link>
      <guid isPermaLink="true">${escapeXml(url)}</guid>
      <category>${escapeXml(meta.interest)}</category>
      <pubDate>${toRfc822(meta.created_at)}</pubDate>
      <description>${escapeXml(meta.summary || "")}</description>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(config.title || "Reading")}</title>
    <link>${escapeXml(site)}/</link>
    <description>${escapeXml(config.tagline || "")}</description>
    <lastBuildDate>${toRfc822(now)}</lastBuildDate>
${entries}
  </channel>
</rss>
`;
}

export function buildSitemapXml(items, config, now) {
  const site = (config.siteUrl || "").replace(/\/+$/, "");
  const urls = [`${site}/`, ...live(items).map((i) => `${site}/${i.meta.path}`)];
  const body = urls.map((u) => `  <url><loc>${escapeXml(u)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

export const buildVersion = (now) => now.replace(/[-:TZ.]/g, "").slice(0, 14);

export function buildIndexHtml(config, stats, now) {
  const cfgJson = JSON.stringify(config).replace(/</g, "\\u003c");
  const v = buildVersion(now);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${escapeHtml(config.title || "Reading")}</title>
  <meta name="description" content="${escapeHtml(config.tagline || "")}" />
  <meta name="theme-color" content="#ece3cf" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#14100b" media="(prefers-color-scheme: dark)" />
  <link rel="icon" href="favicon.svg" type="image/svg+xml" />
  <link rel="manifest" href="manifest.webmanifest" />
  <link rel="alternate" type="application/rss+xml" title="${escapeHtml(config.title || "Reading")}" href="feed.xml" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Silkscreen:wght@400;700&family=Space+Grotesk:wght@400;500;600;700&family=Geist+Mono:wght@100..900&family=VT323&display=swap" />
  <link rel="stylesheet" href="styles.css?v=${v}" />
  <script>
    try { var _t = localStorage.getItem("pr:theme"); if (_t === "dark" || _t === "light") document.documentElement.dataset.theme = _t; } catch (e) {}
    window.PR_BASE = "./";
    window.PR_BUILD = ${JSON.stringify(now)};
    window.PR_CONFIG = ${cfgJson};
  </script>
</head>
<body data-page="hub">
  <div class="app-shell">
    <aside class="sidebar">
      <header class="top">
        <div class="scanlines" aria-hidden="true"></div>
        <div class="scanbeam" aria-hidden="true"></div>
        <div class="top-row">
          <div class="logo">
            <div class="logo-brain" aria-hidden="true">
              <div class="brain glitch"></div>
              <div class="brain main"></div>
            </div>
            <div class="logo-text">
              <h1 class="brand">${escapeHtml(config.title || "Reading")}</h1>
              <p class="tagline">${escapeHtml(config.tagline || "")}</p>
            </div>
          </div>
          <div class="top-actions">
            <button id="themeBtn" class="icon-btn" aria-label="Toggle dark mode" title="Toggle dark mode"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" /></svg></button>
            <button id="settingsBtn" class="icon-btn" aria-label="Settings" title="Settings"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg></button>
          </div>
        </div>
        <div class="search-term">
          <span class="term-prompt" aria-hidden="true">&gt;</span>
          <input id="search" class="search" type="search" placeholder="search ${stats.count} article${stats.count === 1 ? "" : "s"}" aria-label="Search articles" />
          <span class="term-caret" aria-hidden="true">_</span>
          <span class="term-kbd" aria-hidden="true">⌘K</span>
        </div>
      </header>
      <div id="modeFilter" class="mode-filter" role="group" aria-label="Reading mode">
        <button class="mode-seg" data-mode="all" aria-pressed="true">All</button>
        <button class="mode-seg" data-mode="current" aria-pressed="false">Current</button>
        <button class="mode-seg" data-mode="learn" aria-pressed="false">Learn</button>
      </div>
      <nav id="tabs" class="tabs" aria-label="Interests"></nav>
      <div class="nav-views">
        <button id="libraryToggle" class="archive-toggle" hidden></button>
        <button id="statsToggle" class="archive-toggle" hidden></button>
        <button id="discoverToggle" class="archive-toggle" hidden></button>
        <button id="corpusToggle" class="archive-toggle" hidden></button>
        <button id="archiveToggle" class="archive-toggle" hidden></button>
      </div>
      <p id="syncline" class="syncline" hidden></p>
    </aside>

    <div class="content">
      <main id="list" class="list" aria-live="polite"></main>
      <footer class="foot">
        <span id="resultCount" class="result-count"></span>
        <span>${stats.count} article${stats.count === 1 ? "" : "s"} · built ${escapeHtml(humanDate(now.slice(0, 10)))}</span>
        <span class="foot-note">Written for you by Claude · adapts to what you've learnt.</span>
      </footer>
    </div>
  </div>

  <nav class="tabbar" aria-label="Primary navigation">
    <button id="navHome" class="tabbar-btn" data-view="reading" aria-current="page">
      <svg class="icon-outline" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" /></svg><svg class="icon-solid" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.47 3.841a.75.75 0 0 1 1.06 0l8.69 8.69a.75.75 0 1 0 1.06-1.061l-8.689-8.69a2.25 2.25 0 0 0-3.182 0l-8.69 8.69a.75.75 0 1 0 1.061 1.06l8.69-8.689Z" /><path d="m12 5.432 8.159 8.159c.03.03.06.058.091.086v6.198c0 1.035-.84 1.875-1.875 1.875H15a.75.75 0 0 1-.75-.75v-4.5a.75.75 0 0 0-.75-.75h-3a.75.75 0 0 0-.75.75V21a.75.75 0 0 1-.75.75H5.625a1.875 1.875 0 0 1-1.875-1.875v-6.198a2.29 2.29 0 0 0 .091-.086L12 5.432Z" /></svg><span class="tabbar-lbl">HOME</span>
    </button>
    <button id="navLibrary" class="tabbar-btn" data-view="library">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 6.878V6a2.25 2.25 0 0 1 2.25-2.25h7.5A2.25 2.25 0 0 1 18 6v.878m-12 0c.235-.083.487-.128.75-.128h10.5c.263 0 .515.045.75.128m-12 0A2.25 2.25 0 0 0 4.5 9v.878m13.5-3A2.25 2.25 0 0 1 19.5 9v.878m0 0a2.246 2.246 0 0 0-.75-.128H5.25c-.263 0-.515.045-.75.128m15 0A2.25 2.25 0 0 1 21 12v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6c0-.98.626-1.813 1.5-2.122" /></svg><span class="tabbar-lbl">LIBRARY</span>
    </button>
    <button id="navStats" class="tabbar-btn" data-view="stats">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" /></svg><span class="tabbar-lbl">STATS</span>
    </button>
    <button id="navDiscover" class="tabbar-btn" data-view="discover">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" /></svg><span class="tabbar-lbl">DISCOVER</span>
    </button>
    <button id="navCorpus" class="tabbar-btn" data-view="corpus">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg><span class="tabbar-lbl">CORPUS</span>
    </button>
  </nav>

  <div id="reader" class="overlay" hidden aria-modal="true" role="dialog"></div>
  <div id="quiz" class="overlay" hidden aria-modal="true" role="dialog"></div>
  <div id="settings" class="overlay" hidden aria-modal="true" role="dialog"></div>

  <script src="app.js?v=${v}"></script>
</body>
</html>
`;
}

export function buildServiceWorker(now) {
  const v = buildVersion(now);
  return `/* generated by scripts/generate-index.mjs — do not hand-edit.
   Offline shell + visited articles. Never caches the GitHub API or user-state JSON. */
const VERSION = "pr-${v}";
const CORE = ["./", "index.html", "app.js?v=${v}", "styles.css?v=${v}", "favicon.svg", "manifest.webmanifest", "data/manifest.json"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE).catch(() => {})));
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
const isStateFile = (url) => /\\/data\\/(reading-state|knowledge)\\.json$/.test(url.pathname);
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || isStateFile(url)) return;
  const isAsset = /\\.(css|js|svg|png|ico|woff2?)$/.test(url.pathname);
  if (req.mode === "navigate" || url.pathname.endsWith("/data/manifest.json") || url.pathname.includes("/articles/")) {
    e.respondWith((async () => {
      try { const fresh = await fetch(req); if (fresh && fresh.ok) (await caches.open(VERSION)).put(req, fresh.clone()); return fresh; }
      catch { return (await caches.match(req)) || (await caches.match("./")) || Response.error(); }
    })());
    return;
  }
  if (isAsset) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      const fetching = fetch(req).then((res) => { if (res && res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone())); return res; }).catch(() => null);
      return cached || (await fetching) || Response.error();
    })());
  }
});
`;
}
