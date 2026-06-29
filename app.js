/* Personalised Reading — hub app. Vanilla, zero-dependency, local-first.
   State lives in localStorage (works with no token); an optional GitHub token
   syncs reading-state.json + knowledge.json back to the repo for cross-device + the generator. */
(function () {
  "use strict";

  const BASE = window.PR_BASE || "./";
  const CONFIG = window.PR_CONFIG || { interests: [], passThreshold: 0.75, freshness: { agingAfterDays: 3 } };
  const INTERESTS = CONFIG.interests || [];
  const INTEREST_BY_ID = Object.fromEntries(INTERESTS.map((i) => [i.id, i]));
  const PASS = CONFIG.passThreshold ?? 0.75;
  const AGING_DAYS = CONFIG.freshness?.agingAfterDays ?? 3;

  const LS = { state: "pr:reading-state", know: "pr:knowledge", token: "pr:gh-token", repo: "pr:gh-repo" };
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const now = () => new Date().toISOString();
  const daysBetween = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);

  let manifest = { articles: [] };
  let state = { version: 1, updatedAt: null, articles: {}, quizzes: {} };
  let knowledge = { version: 1, updatedAt: null, concepts: {} };
  let activeTab = "all";
  let query = "";
  let view = "reading"; // reading | library | stats | discover | archive
  let modeFilter = "all"; // all | current | learn
  const metaCache = {}; // articleId -> #meta (lazy)

  /* ---------- storage ---------- */
  function loadLocal(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  }
  // Repo coordinates default to config.json so a new device only needs a token pasted.
  const repoDefault = CONFIG.repo && CONFIG.repo.owner && CONFIG.repo.name ? { branch: "main", ...CONFIG.repo } : null;
  const repoCfg = () => loadLocal(LS.repo, null) || repoDefault;
  const token = () => { try { return localStorage.getItem(LS.token) || ""; } catch { return ""; } };

  async function fetchJson(path) {
    const r = await fetch(BASE + path, { cache: "no-store" });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  }

  /* ---------- merge (never clobber across devices) ----------
     State syncs as a per-item union: an article/concept missing on one side
     never deletes it; on conflict the most recently touched entry wins. This
     makes an empty or stale device incapable of wiping another device's reads. */
  const stamp = (e) => e?.t || e?.read_at || e?.archived_at || "";
  function mergeEntry(x, y) {
    if (!x) return y; if (!y) return x;
    const tx = stamp(x), ty = stamp(y);
    if (tx === ty) return (y.status === "read" && x.status !== "read") ? y : x;
    return ty > tx ? y : x;
  }
  function mergeStates(a, b) {
    const A = a || {}, B = b || {}, out = { version: 1, updatedAt: null, articles: {}, quizzes: {} };
    new Set([...Object.keys(A.articles || {}), ...Object.keys(B.articles || {})]).forEach((id) =>
      (out.articles[id] = mergeEntry((A.articles || {})[id], (B.articles || {})[id])));
    new Set([...Object.keys(A.quizzes || {}), ...Object.keys(B.quizzes || {})]).forEach((id) => {
      const x = (A.quizzes || {})[id], y = (B.quizzes || {})[id];
      out.quizzes[id] = !x ? y : !y ? x : ((y.taken_at || "") >= (x.taken_at || "") ? y : x);
    });
    out.updatedAt = [A.updatedAt, B.updatedAt].filter(Boolean).sort().pop() || now();
    return out;
  }
  function mergeKnowledge(a, b) {
    const A = a || {}, B = b || {}, out = { version: 1, updatedAt: null, concepts: {} };
    new Set([...Object.keys(A.concepts || {}), ...Object.keys(B.concepts || {})]).forEach((id) => {
      const x = (A.concepts || {})[id], y = (B.concepts || {})[id];
      if (!x || !y) { out.concepts[id] = x || y; return; }
      if (x.is_learnt !== y.is_learnt) { out.concepts[id] = x.is_learnt ? x : y; return; } // learnt always wins
      out.concepts[id] = (y.learnt_at || "") >= (x.learnt_at || "") ? y : x;
    });
    out.updatedAt = [A.updatedAt, B.updatedAt].filter(Boolean).sort().pop() || now();
    return out;
  }
  const isKnow = (file) => file === "knowledge.json";
  const localFor = (file) => (isKnow(file) ? knowledge : state);
  const mergeFor = (file, remote, local) => (isKnow(file) ? mergeKnowledge(remote, local) : mergeStates(remote, local));
  function adoptMerged(file, merged) {
    if (isKnow(file)) { knowledge = merged; try { localStorage.setItem(LS.know, JSON.stringify(knowledge)); } catch {} }
    else { state = merged; try { localStorage.setItem(LS.state, JSON.stringify(state)); } catch {} }
  }

  /* ---------- pixel-brain logo ----------
     Renders the 16×16 brain as a crisp-edges SVG data-URL and exposes it as --brain.
     Ported from the Cortex Hub design; colours are baked in (theme-independent). */
  function brainDataUrl() {
    const BODY = [
      "    mmm  mmm    ", "  mmmmm  mmmmm  ", "  mmmmmmmmmmmm  ", " mmmmmmmmmmmmmm ",
      " mmmmmmmmmmmmmm ", "mmmmmmmmmmmmmmmm", "mmmmmmmmmmmmmmmm", "mmmmmmmmmmmmmmmm",
      " mmmmmmmmmmmmmm ", " mmmmmmmmmmmmmm ", "  mmmmmmmmmmmm  ", "   mmmmmmmmmmm  ",
      "    mmmmmmmmmm  ", "      mmmmm     ", "      mmm       ", "      mmm       ",
    ].map((r) => (r + "                ").slice(0, 16).split(""));
    const set = (pts, ch) => pts.forEach(([r, c]) => { if (BODY[r] && BODY[r][c] && BODY[r][c] !== " ") BODY[r][c] = ch; });
    set([[3, 3], [5, 2], [5, 3], [7, 3], [9, 2], [9, 3], [3, 12], [5, 12], [5, 13], [7, 12], [9, 12], [9, 13]], "d");
    for (let r = 2; r <= 6; r++) set([[r, 7], [r, 8]], "s");
    set([[6, 4], [6, 5], [7, 4], [7, 5], [6, 10], [6, 11], [7, 10], [7, 11]], "e");
    set([[6, 4], [6, 10]], "w");
    const pal = { o: "#241509", m: "#ff8a5b", d: "#e06a38", s: "#e06a38", e: "#241509", w: "#ffe0d2" };
    const H = BODY.length, W = BODY[0].length;
    const at = (r, c) => (r < 0 || c < 0 || r >= H || c >= W) ? " " : BODY[r][c];
    let rects = "";
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const ch = BODY[r][c];
      if (ch === " ") continue;
      const edge = at(r - 1, c) === " " || at(r + 1, c) === " " || at(r, c - 1) === " " || at(r, c + 1) === " ";
      const col = ch === "s" ? pal.s : ch === "e" ? pal.e : ch === "w" ? pal.w : edge ? pal.o : ch === "d" ? pal.d : pal.m;
      rects += `<rect x='${c}' y='${r}' width='1' height='1' fill='${col}'/>`;
    }
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' shape-rendering='crispEdges'>${rects}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }

  async function boot() {
    document.documentElement.style.setProperty("--brain", brainDataUrl());

    // Data (committed artifacts)
    try { manifest = await fetchJson("data/manifest.json"); } catch { manifest = { articles: [] }; }

    // State: local-first. Seed from committed file only on first visit to this device.
    const localState = loadLocal(LS.state, null);
    state = localState || (await fetchJson("data/reading-state.json").catch(() => state));
    const localKnow = loadLocal(LS.know, null);
    knowledge = localKnow || (await fetchJson("data/knowledge.json").catch(() => knowledge));
    state.articles ||= {}; state.quizzes ||= {}; knowledge.concepts ||= {};

    // If synced, pull remote and adopt if newer (cross-device).
    if (token() && repoCfg()) { await pullRemote().catch(() => {}); }
    sweepExpired();

    wireChrome();
    readHashState();
    renderTabs();
    render();
    handleDeepLink();
    initInstallPrompt();
  }

  /* ---------- knowledge / selection ---------- */
  const isLearnt = (cid) => !!knowledge.concepts[cid]?.is_learnt;
  const taughtSomewhere = (cid) => manifest.articles.some((a) => !a.merged_into && (a.concepts_taught || []).includes(cid));

  // Conservative gating: block only when a prerequisite genuinely exists and isn't learnt.
  function category(a) {
    const assumed = a.concepts_assumed || [];
    const taught = a.concepts_taught || [];
    const blocked = assumed.some((c) => knowledge.concepts[c] && !isLearnt(c) && taughtSomewhere(c));
    if (blocked) return "blocked";
    if (taught.length && taught.every(isLearnt)) return "review";
    return "normal";
  }

  /* ---------- render ---------- */
  function visibleArticles() {
    let arts = manifest.articles.filter((a) => !a.merged_into);
    if (activeTab !== "all") arts = arts.filter((a) => interestsOf(a).includes(activeTab));
    if (modeFilter !== "all") arts = arts.filter((a) => articleMode(a) === modeFilter);
    if (query) {
      const q = query.toLowerCase();
      arts = arts.filter((a) => (a.title + " " + a.summary + " " + (a.tags || []).join(" ")).toLowerCase().includes(q));
    }
    return arts;
  }

  function statusOf(id) { return state.articles[id]?.status || "backlog"; }
  function isRead(id) { return statusOf(id) === "read"; }

  // An article can belong to several interests (primary first); its mode is current/learn.
  const interestsOf = (a) => (a.interests && a.interests.length ? a.interests : [a.interest]);
  function articleMode(a) {
    if (a.mode === "current" || a.mode === "learn") return a.mode;
    const m = (INTEREST_BY_ID[a.interest] || {}).mode;
    if (m === "current" || m === "learn") return m;
    return a.expire_at ? "current" : "learn"; // 'both'/unknown → infer from whether it expires
  }

  /* ---------- spaced repetition (renudge) ----------
     A learnt concept resurfaces for review once its interval has elapsed. Passing the
     quiz again lengthens the next interval; legacy learnt concepts with no schedule
     fall back to a default gap so they still come back around. */
  const REVIEW_INTERVALS = [3, 7, 16, 35, 90, 180]; // days, indexed by review_level - 1
  const DEFAULT_REVIEW_DAYS = 21;
  function conceptDue(cid) {
    const c = knowledge.concepts[cid];
    if (!c || !c.is_learnt) return false;
    if (c.next_review_at) return c.next_review_at <= now();
    return c.learnt_at ? daysBetween(now(), c.learnt_at) >= DEFAULT_REVIEW_DAYS : false;
  }
  function articleReviewDue(a) {
    return isRead(a.id) && !a.merged_into && (a.concepts_taught || []).some(conceptDue);
  }
  function articleLearnt(a) {
    const t = a.concepts_taught || [];
    return !!state.quizzes[a.id]?.passed || (t.length > 0 && t.every(isLearnt));
  }

  function renderTabs() {
    const tabs = $("#tabs");
    const counts = {};
    let total = 0;
    manifest.articles.forEach((a) => {
      if (a.merged_into || isRead(a.id)) return;
      if (modeFilter !== "all" && articleMode(a) !== modeFilter) return;
      total++;
      interestsOf(a).forEach((id) => { counts[id] = (counts[id] || 0) + 1; });
    });
    const mk = (id, label, emoji, n, accent) =>
      `<button class="tab" role="tab" data-tab="${esc(id)}" aria-selected="${activeTab === id}"${accent ? ` style="--accent:${esc(accent)}"` : ""}>${emoji ? esc(emoji) + " " : ""}${esc(label)}${n ? ` <span class="count">${n}</span>` : ""}</button>`;
    tabs.innerHTML = mk("all", "All", "", total) + INTERESTS.map((i) => mk(i.id, i.label, i.emoji, counts[i.id] || 0, i.accent)).join("");
    tabs.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => { activeTab = b.dataset.tab; writeHashState(); renderTabs(); render(); }));
  }

  function ageLabel(a) {
    const age = daysBetween(now(), a.created_at);
    if (a.expire_at) {
      const left = daysBetween(a.expire_at, now());
      if (left <= AGING_DAYS) return { txt: left <= 0 ? "expires today" : `expires in ${left}d`, aging: true };
    }
    if (age <= 0) return { txt: "today", aging: false };
    if (age === 1) return { txt: "yesterday", aging: false };
    return { txt: `${age}d ago`, aging: false };
  }

  function cardHtml(a, opts = {}) {
    const it = INTEREST_BY_ID[a.interest] || {};
    const read = isRead(a.id);
    const star = state.articles[a.id]?.starred;
    const age = ageLabel(a);
    const merged = (a.merged_from || []).length;
    const secondary = interestsOf(a).slice(1).map((id) => INTEREST_BY_ID[id]).filter(Boolean);
    const dim = opts.archive || (read && !opts.review);   // review nudges stay bright, not greyed-out
    const tier = opts.library
      ? (articleReviewDue(a) ? { c: "due", t: "Review due" } : articleLearnt(a) ? { c: "learnt", t: "Learnt" } : { c: "read", t: "Read" })
      : null;
    return `<article class="card${dim ? " read" : ""}${opts.review ? " due" : ""}" style="--accent:${esc(it.accent || "#4f7cac")}" data-id="${esc(a.id)}" tabindex="0" role="button">
      ${opts.archive
        ? `<button class="restore" data-restore="${esc(a.id)}" aria-label="Restore" title="Restore to your list">↩</button>`
        : `<button class="star${star ? " on" : ""}" data-star="${esc(a.id)}" aria-label="${star ? "Unstar" : "Star"}" title="Keep / star">${star ? "★" : "☆"}</button>`}
      <div class="card-eyebrow"><span class="emoji">${esc(it.emoji || "")}</span>${esc(it.label || a.interest)}${tier ? `<span class="tier ${tier.c}">${tier.t}</span>` : ""}<span class="age${age.aging ? " aging" : ""}">${esc(age.txt)}</span></div>
      <h3>${esc(a.title)}</h3>
      <p>${esc(a.summary)}</p>
      <div class="card-foot">
        ${secondary.map((s) => `<span class="xtag">${esc((s.emoji ? s.emoji + " " : "") + s.label)}</span>`).join("")}
        ${(a.tags || []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
        ${opts.review ? `<span class="due-note">⟳ time to review</span>` : (read ? `<span class="readtick">✓ read</span>` : "")}
        ${merged ? `<span class="merged-note">↳ consolidates ${merged}</span>` : ""}
      </div>
    </article>`;
  }

  const byNew = (x, y) => (y.created_at || "").localeCompare(x.created_at || "");

  function bindCards(root) {
    root.querySelectorAll(".card").forEach((el) => {
      el.addEventListener("click", (e) => { if (e.target.closest(".star,.restore")) return; openReader(el.dataset.id); });
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") openReader(el.dataset.id); });
    });
    root.querySelectorAll(".star").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); toggleStar(b.dataset.star); }));
    root.querySelectorAll(".restore").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); restore(b.dataset.restore); }));
  }

  function render() {
    const list = $("#list");
    const arts = visibleArticles();
    const archived = arts.filter((a) => statusOf(a.id) === "archived");
    const active = arts.filter((a) => statusOf(a.id) !== "archived");
    const rc = $("#resultCount");
    if (rc) rc.textContent = (query && view === "reading") ? `${active.length} result${active.length === 1 ? "" : "s"} for “${query}”` : "";

    if (view === "library") { renderLibrary(); return; }
    if (view === "stats") { renderStats(); return; }
    if (view === "discover") { renderDiscover(); return; }

    if (view === "archive") {
      list.innerHTML = `<h2 class="shelf-title">Archive · outdated or set aside</h2>` +
        (archived.length
          ? `<div class="shelf-grid">${archived.sort(byNew).map((a) => cardHtml(a, { archive: true })).join("")}</div>`
          : `<div class="empty"><p>Nothing archived yet. Unread items move here once they pass their freshness date (star one to keep it forever).</p></div>`);
      bindCards(list);
      updateToggles();
      return;
    }

    if (!active.length) {
      list.innerHTML = `<div class="empty"><div class="big">📭</div><p>${query ? "No articles match your search." : "Nothing here yet. New reading is written each morning."}</p></div>`;
      updateToggles();
      return;
    }
    const buckets = { normal: [], review: [], blocked: [], read: [] };
    const reviewDue = [];
    active.forEach((a) => {
      if (isRead(a.id)) { if (articleReviewDue(a)) reviewDue.push(a); else buckets.read.push(a); }
      else buckets[category(a)].push(a);
    });
    const shelf = (title, items, opts) => items.length ? `<h2 class="shelf-title">${title}</h2><div class="shelf-grid">${items.sort(byNew).map((a) => cardHtml(a, opts)).join("")}</div>` : "";
    list.innerHTML =
      shelf("⟳ Time to review", reviewDue, { review: true }) +
      shelf("To read", buckets.normal) +
      shelf("Worth a review", buckets.review) +
      shelf("Locked until you learn the basics", buckets.blocked) +
      shelf("Read", buckets.read);
    bindCards(list);
    updateToggles();
  }

  const byReadDesc = (x, y) => (state.articles[y.id]?.read_at || "").localeCompare(state.articles[x.id]?.read_at || "");
  function renderLibrary() {
    const list = $("#list");
    let reads = manifest.articles.filter((a) => !a.merged_into && isRead(a.id));
    if (activeTab !== "all") reads = reads.filter((a) => interestsOf(a).includes(activeTab));
    if (modeFilter !== "all") reads = reads.filter((a) => articleMode(a) === modeFilter);
    if (query) { const q = query.toLowerCase(); reads = reads.filter((a) => (a.title + " " + a.summary + " " + (a.tags || []).join(" ")).toLowerCase().includes(q)); }
    const learntCount = Object.values(knowledge.concepts).filter((c) => c.is_learnt).length;
    const due = reads.filter(articleReviewDue);
    const learnt = reads.filter((a) => !articleReviewDue(a) && articleLearnt(a));
    const plain = reads.filter((a) => !articleReviewDue(a) && !articleLearnt(a));
    const shelf = (title, items, opts) => items.length ? `<h2 class="shelf-title">${title}</h2><div class="shelf-grid">${items.sort(byReadDesc).map((a) => cardHtml(a, opts)).join("")}</div>` : "";
    list.innerHTML =
      `<div class="lib-summary"><b>${reads.length}</b> read · <b>${learntCount}</b> concept${learntCount === 1 ? "" : "s"} learnt${due.length ? ` · <b>${due.length}</b> due for review` : ""}</div>` +
      (reads.length
        ? shelf("Due for review", due, { library: true, review: true }) + shelf("Learnt", learnt, { library: true }) + shelf("Read", plain, { library: true })
        : `<div class="empty"><div class="big">📚</div><p>${query ? "No read articles match your search." : "Your library fills up as you read. Open an article, mark it read — it lives here with what you've learnt."}</p></div>`);
    bindCards(list);
    updateToggles();
  }

  function updateToggles() {
    const archN = manifest.articles.filter((a) => !a.merged_into && statusOf(a.id) === "archived").length;
    const dueN = manifest.articles.filter(articleReviewDue).length;
    const btn = (sel, v, icon, label) => { const b = $(sel); if (!b) return; b.hidden = false; b.classList.toggle("on", view === v); b.innerHTML = icon + `<span>${esc(label)}</span>`; };
    btn("#libraryToggle", "library", ICON_LIBRARY, dueN > 0 ? `Library · ${dueN} due` : "Library");
    btn("#statsToggle", "stats", ICON_CHART, "Stats");
    btn("#discoverToggle", "discover", ICON_DISCOVER, "Discover");
    const ab = $("#archiveToggle");
    if (ab) {
      if (archN > 0 || view === "archive") { ab.hidden = false; ab.classList.toggle("on", view === "archive"); ab.innerHTML = ICON_ARCHIVE + `<span>Archive${archN ? ` (${archN})` : ""}</span>`; }
      else ab.hidden = true;
    }
    // Mobile bottom tab bar active state (HOME = reading; secondary views highlight nothing).
    const navFor = { reading: "navHome", library: "navLibrary", stats: "navStats" };
    ["navHome", "navLibrary", "navStats"].forEach((id) => {
      const b = document.getElementById(id); if (!b) return;
      const on = navFor[view] === id;
      b.classList.toggle("on", on);
      b.setAttribute("aria-current", on ? "page" : "false");
    });
  }

  /* ---------- stats ---------- */
  function conceptInterest(cid, c) { return c.interest || (manifest.articles.find((a) => a.id === c.first_taught) || {}).interest || "other"; }
  function renderStats() {
    const list = $("#list");
    const reads = manifest.articles.filter((a) => !a.merged_into && isRead(a.id));
    const learnt = Object.entries(knowledge.concepts).filter(([, c]) => c.is_learnt);
    const dueN = manifest.articles.filter(articleReviewDue).length;
    // Day streak: consecutive days (ending today or yesterday) with at least one read.
    const days = new Set(Object.values(state.articles).filter((a) => a.read_at).map((a) => a.read_at.slice(0, 10)));
    let streak = 0, d = new Date(now().slice(0, 10) + "T00:00:00Z");
    if (!days.has(d.toISOString().slice(0, 10))) d.setUTCDate(d.getUTCDate() - 1);
    while (days.has(d.toISOString().slice(0, 10))) { streak++; d.setUTCDate(d.getUTCDate() - 1); }
    const byTopic = {}; reads.forEach((a) => (byTopic[a.interest] = (byTopic[a.interest] || 0) + 1));
    const learntByTopic = {}; learnt.forEach(([cid, c]) => { const i = conceptInterest(cid, c); learntByTopic[i] = (learntByTopic[i] || 0) + 1; });
    const stat = (label, val) => `<div class="stat"><div class="stat-num">${val}</div><div class="stat-label">${label}</div></div>`;
    const bars = (data) => {
      const rows = INTERESTS.filter((i) => data[i.id]);
      if (!rows.length) return `<p class="muted-note">Nothing here yet — read a few articles and this fills in.</p>`;
      const max = Math.max(1, ...rows.map((i) => data[i.id]));
      return rows.map((i) => `<div class="bar-row"><span class="bar-label">${esc(i.emoji)} ${esc(i.label)}</span><span class="bar-track"><span class="bar-fill" style="width:${Math.round(data[i.id] / max * 100)}%;background:${esc(i.accent)}"></span></span><span class="bar-val">${data[i.id]}</span></div>`).join("");
    };
    list.innerHTML =
      `<div class="stats-grid">${stat("Day streak", streak)}${stat("Articles read", reads.length)}${stat("Concepts learnt", learnt.length)}${stat("Due for review", dueN)}</div>` +
      `<h2 class="shelf-title">Reading by topic</h2><div class="bars">${bars(byTopic)}</div>` +
      `<h2 class="shelf-title">Concepts learnt by topic</h2><div class="bars">${bars(learntByTopic)}</div>`;
    updateToggles();
  }

  /* ---------- discover (scout queue) ---------- */
  function dismissDiscover(id) {
    let arr; try { arr = JSON.parse(localStorage.getItem("pr:discover-dismissed") || "[]"); } catch { arr = []; }
    if (!arr.includes(id)) arr.push(id);
    try { localStorage.setItem("pr:discover-dismissed", JSON.stringify(arr)); } catch {}
    renderDiscover();
  }
  async function renderDiscover() {
    const list = $("#list");
    list.innerHTML = `<div class="lib-summary">Loading fresh reads from your feeds…</div>`;
    let pool = [];
    try { pool = (await fetchJson("data/pool.json")).items || []; } catch {}
    if (view !== "discover") return; // user navigated away during the fetch
    let dismissed; try { dismissed = new Set(JSON.parse(localStorage.getItem("pr:discover-dismissed") || "[]")); } catch { dismissed = new Set(); }
    let items = pool.filter((it) => it.status !== "used" && it.url && !dismissed.has(it.id));
    if (activeTab !== "all") items = items.filter((it) => it.interest === activeTab);
    if (query) { const q = query.toLowerCase(); items = items.filter((it) => (it.title || "").toLowerCase().includes(q)); }
    items.sort((a, b) => (b.added_at || b.published_at || "").localeCompare(a.added_at || a.published_at || ""));
    items = items.slice(0, 80);
    if (!items.length) {
      list.innerHTML = `<div class="empty"><div class="big">🛰</div><p>${query ? "No discoveries match your search." : "No fresh external reads right now — the scout refreshes your feeds each morning."}</p></div>`;
      updateToggles(); return;
    }
    const dash = /\s+[-–—|]\s+([^-–—|]{2,42})$/;
    const cleanTitle = (t) => { t = (t || "").trim(); const m = t.match(dash); return m ? t.slice(0, m.index).trim() : t; };
    const srcOf = (it) => { const m = (it.title || "").match(dash); if (m) return m[1].trim(); try { return new URL(it.url).hostname.replace(/^www\./, ""); } catch { return ""; } };
    const ageOf = (it) => { const x = it.published_at || it.added_at; if (!x) return ""; const n = daysBetween(now(), new Date(x).toISOString()); return n <= 0 ? "today" : n === 1 ? "yesterday" : `${n}d ago`; };
    const byInterest = {}; items.forEach((it) => (byInterest[it.interest] ||= []).push(it));
    const card = (it) => `<article class="disc-card" style="--accent:${esc((INTEREST_BY_ID[it.interest] || {}).accent || "#4f7cac")}">
        <button class="disc-x" data-dismiss="${esc(it.id)}" aria-label="Dismiss" title="Hide this">✕</button>
        <div class="disc-src">${esc(srcOf(it))}${srcOf(it) && ageOf(it) ? " · " : ""}${esc(ageOf(it))}</div>
        <a class="disc-title" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(cleanTitle(it.title))}</a>
      </article>`;
    list.innerHTML =
      `<div class="lib-summary">Fresh from your feeds — <b>${items.length}</b> unread from the web. Open one to read the original.</div>` +
      INTERESTS.filter((i) => byInterest[i.id]).map((i) => `<h2 class="shelf-title">${esc(i.emoji)} ${esc(i.label)}</h2><div class="shelf-grid">${byInterest[i.id].map(card).join("")}</div>`).join("");
    list.querySelectorAll("[data-dismiss]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); dismissDiscover(b.dataset.dismiss); }));
    updateToggles();
  }

  /* ---------- mutations ---------- */
  function saveState() { state.updatedAt = now(); try { localStorage.setItem(LS.state, JSON.stringify(state)); } catch {} scheduleSync("reading-state.json", state); }
  function saveKnowledge() { knowledge.updatedAt = now(); try { localStorage.setItem(LS.know, JSON.stringify(knowledge)); } catch {} scheduleSync("knowledge.json", knowledge); }

  function toggleStar(id) {
    const a = (state.articles[id] ||= { status: "backlog" });
    a.starred = !a.starred; a.t = now(); saveState(); renderTabs(); render();
  }
  function markRead(id) {
    const a = (state.articles[id] ||= {});
    a.status = "read"; a.read_at = now(); a.t = now(); saveState(); renderTabs();
  }
  function restore(id) {
    const a = (state.articles[id] ||= {});
    a.status = "backlog"; a.archived_at = null; a.keep = true; a.t = now(); // keep: the freshness sweep won't re-archive it
    saveState(); renderTabs(); render();
  }
  // Freshness: move unread, unstarred, un-kept items to the archive once they pass their expire_at.
  function sweepExpired() {
    const today = now().slice(0, 10);
    let changed = false;
    for (const a of manifest.articles) {
      if (a.merged_into || !a.expire_at || a.expire_at >= today) continue;
      const st = state.articles[a.id];
      const status = st?.status || "backlog";
      if (status === "backlog" && !st?.starred && !st?.keep) {
        state.articles[a.id] = { ...(st || {}), status: "archived", archived_at: now(), t: now(), expired: true };
        changed = true;
      }
    }
    if (changed) saveState();
  }

  function learnConcepts(article, passed) {
    (article.concepts_taught || []).forEach((cid) => {
      const c = (knowledge.concepts[cid] ||= { label: cid, interest: article.interest, prerequisite_ids: [], is_learnt: false, review_level: 0, next_review_at: null });
      if (passed) {
        c.is_learnt = true; c.learnt_at = c.learnt_at || now();
        c.review_level = Math.min((c.review_level || 0) + 1, REVIEW_INTERVALS.length); // each pass lengthens the gap
        c.next_review_at = new Date(Date.now() + REVIEW_INTERVALS[c.review_level - 1] * 86400000).toISOString();
      } else { c.is_learnt = false; c.review_level = Math.max(1, c.review_level || 0); c.next_review_at = new Date(Date.now() + 3 * 86400000).toISOString(); }
    });
    saveKnowledge();
  }

  /* ---------- reader ---------- */
  async function loadMeta(a) {
    if (metaCache[a.id]) return metaCache[a.id];
    try {
      const html = await (await fetch(BASE + a.path, { cache: "no-store" })).text();
      const m = /<script\s+type="application\/json"\s+id="meta">([\s\S]*?)<\/script>/i.exec(html);
      metaCache[a.id] = m ? JSON.parse(m[1]) : {};
    } catch { metaCache[a.id] = {}; }
    return metaCache[a.id];
  }

  async function openReader(id) {
    const a = manifest.articles.find((x) => x.id === id);
    if (!a) return;
    const meta = await loadMeta(a);
    const hasQuiz = Array.isArray(meta.quick_check) && meta.quick_check.length > 0;
    const it = INTEREST_BY_ID[a.interest] || {};
    const ov = $("#reader");
    ov.style.setProperty("--accent", it.accent || "#ff8a5b");
    const star = !!state.articles[id]?.starred;
    ov.innerHTML = `
      <div class="ov-bar">
        <button class="back" data-act="back" aria-label="Back to reading">← ${esc((it.emoji ? it.emoji + " " : "") + (it.label || a.interest))}</button>
        <span class="ov-title">${esc(a.title)}</span>
        <button class="ovstar${star ? " on" : ""}" data-act="star" aria-label="${star ? "Unsave" : "Save"}" title="Save / keep">${star ? "★" : "☆"}</button>
      </div>
      <div class="ov-body"><iframe class="reader-frame" title="${esc(a.title)}" src="${esc(BASE + a.path)}" sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe></div>
      <div class="ov-actions">
        ${isRead(id) ? `<button class="btn" data-act="unread">Mark unread</button>` : `<button class="btn good" data-act="read">✓ Mark read</button>`}
        ${hasQuiz ? `<button class="btn primary" data-act="quiz">Take quiz →</button>` : ""}
      </div>`;
    show(ov);
    ov.querySelector('[data-act="back"]').onclick = () => hide(ov);
    ov.querySelector('[data-act="star"]')?.addEventListener("click", () => {
      toggleStar(id);
      const b = ov.querySelector('[data-act="star"]'); const on = !!state.articles[id]?.starred;
      b.classList.toggle("on", on); b.textContent = on ? "★" : "☆"; b.setAttribute("aria-label", on ? "Unsave" : "Save");
    });
    ov.querySelector('[data-act="read"]')?.addEventListener("click", () => { markRead(id); if (hasQuiz) openQuiz(a, meta); else { hide(ov); render(); } });
    ov.querySelector('[data-act="unread"]')?.addEventListener("click", () => { const e = (state.articles[id] ||= {}); e.status = "backlog"; e.t = now(); saveState(); renderTabs(); hide(ov); render(); });
    ov.querySelector('[data-act="quiz"]')?.addEventListener("click", () => openQuiz(a, meta));
  }

  /* ---------- quiz ---------- */
  function openQuiz(a, meta) {
    const qs = meta.quick_check || [];
    const ov = $("#quiz");
    const answers = new Array(qs.length).fill(null);
    const render = (graded) => {
      ov.innerHTML = `
        <div class="ov-bar"><button class="close" aria-label="Close">✕</button><span class="ov-title">Quick check · ${esc(a.title)}</span></div>
        <div class="ov-body"><div class="sheet">
          <p class="note">Pass to mark these ideas <b>learnt</b> — future articles won't re-explain them.</p>
          ${qs.map((q, qi) => `<div class="q"><p class="qq">${qi + 1}. ${esc(q.q)}</p>${q.options.map((o, oi) => {
            let cls = "opt"; if (graded) { if (oi === q.correct) cls += " correct"; else if (answers[qi] === oi) cls += " wrong"; } else if (answers[qi] === oi) cls += " sel";
            return `<button class="${cls}" data-q="${qi}" data-o="${oi}"${graded ? " disabled" : ""}>${esc(o)}</button>`;
          }).join("")}</div>`).join("")}
        </div></div>
        <div class="ov-actions">${graded ? `<button class="btn primary" data-act="done">Done</button>` : `<button class="btn primary" data-act="submit">Submit</button>`}</div>`;
      ov.querySelector(".close").onclick = () => { hide(ov); render2(); };
      if (!graded) {
        ov.querySelectorAll(".opt").forEach((b) => b.addEventListener("click", () => { answers[+b.dataset.q] = +b.dataset.o; render(false); }));
        ov.querySelector('[data-act="submit"]').addEventListener("click", () => {
          if (answers.includes(null)) return;
          const correct = qs.reduce((n, q, i) => n + (answers[i] === q.correct ? 1 : 0), 0);
          const score = correct / qs.length, passed = score >= PASS;
          state.quizzes[a.id] = { score, passed, taken_at: now() };
          markRead(a.id); // engaging with the quiz implies the article was read
          learnConcepts(a, passed);
          render(true);
        });
      } else {
        ov.querySelector('[data-act="done"]').addEventListener("click", () => { hide(ov); render2(); });
      }
    };
    const render2 = () => { hide($("#reader")); renderTabs(); render(); };
    show(ov); render(false);
  }

  /* ---------- settings + sync ---------- */
  function openSettings() {
    const ov = $("#settings");
    const r = repoCfg() || { owner: "", name: "", branch: "main" };
    ov.innerHTML = `
      <div class="ov-bar"><button class="close" aria-label="Close">✕</button><span class="ov-title">Settings</span></div>
      <div class="ov-body"><div class="sheet">
        <p class="note">Your reading + learning is saved <b>on this device</b> automatically. To sync across devices (and feed the writer), add a GitHub token below — everything keeps working without one.</p>
        <h2>Sync</h2>
        <div class="field"><label>Repository owner</label><input id="s-owner" value="${esc(r.owner)}" placeholder="your-github-username" /></div>
        <div class="field"><label>Repository name</label><input id="s-name" value="${esc(r.name)}" placeholder="personalised-reading" /></div>
        <div class="field"><label>Branch</label><input id="s-branch" value="${esc(r.branch || "main")}" placeholder="main" /></div>
        <div class="field"><label>Access token</label><input id="s-token" type="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" value="${esc(token())}" placeholder="github_pat_…" />
          <p class="hint">A <b>fine-grained</b> token scoped to this one repo with <b>Contents: Read and write</b>. Create one at <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings</a>. Stored only in this browser.</p></div>
        <div class="ov-actions" style="padding-left:0;padding-right:0">
          <button class="btn" data-act="pull">Pull</button>
          <button class="btn primary" data-act="save">Save</button>
        </div>
        <p class="hint" id="s-status"></p>
      </div></div>`;
    show(ov);
    ov.querySelector(".close").onclick = () => hide(ov);
    ov.querySelector('[data-act="save"]').addEventListener("click", async () => {
      const owner = $("#s-owner").value.trim(), name = $("#s-name").value.trim(), branch = $("#s-branch").value.trim() || "main", tk = $("#s-token").value.trim();
      const status = $("#s-status");
      try { localStorage.setItem(LS.repo, JSON.stringify({ owner, name, branch })); tk ? localStorage.setItem(LS.token, tk) : localStorage.removeItem(LS.token); }
      catch { status.textContent = "This browser blocked saving (private mode?)."; return; }
      if (!token()) { status.textContent = "No token saved — paste your github_pat_… token, then Save."; return; }
      if (!apiBase()) { status.textContent = "Fill in repository owner and name, then Save."; return; }
      status.textContent = "Saving…";
      try {
        await pushJson("reading-state.json", state);
        await pushJson("knowledge.json", knowledge);
        status.textContent = "Synced ✓ — your reading now syncs to GitHub.";
      } catch (e) {
        status.textContent = "Sync failed (" + e.message + ") — token needs Contents: Read and write on this repo.";
      }
    });
    ov.querySelector('[data-act="pull"]').addEventListener("click", () => {
      $("#s-status").textContent = "Pulling…";
      pullRemote().then((n) => { $("#s-status").textContent = n ? "Pulled ✓ — updated." : "Pulled ✓ — already up to date."; renderTabs(); render(); })
        .catch((e) => { $("#s-status").textContent = "Pull failed: " + e.message; });
    });
  }

  // GitHub Contents API
  const apiBase = () => { const r = repoCfg(); return r && r.owner && r.name ? `https://api.github.com/repos/${r.owner}/${r.name}/contents/data/` : null; };
  const ghHeaders = () => ({ Authorization: `Bearer ${token()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
  function b64(str) { const bytes = new TextEncoder().encode(str); let bin = ""; const C = 0x8000; for (let i = 0; i < bytes.length; i += C) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + C)); return btoa(bin); }

  // Read a state file from the repo → { obj, sha }. obj is null if the file doesn't exist.
  async function getFile(file) {
    const r = repoCfg();
    const res = await fetch(`${apiBase()}${file}?ref=${r.branch}`, { headers: ghHeaders(), cache: "no-store" });
    if (res.status === 404) return { obj: null, sha: null };
    if (!res.ok) throw new Error(`read ${res.status}`);
    const j = await res.json();
    let obj = null;
    try { obj = JSON.parse(decodeURIComponent(escape(atob((j.content || "").replace(/\n/g, ""))))); } catch {}
    return { obj, sha: j.sha };
  }
  // Push = pull-merge-push: fetch remote, union with local, adopt the merge locally, write it.
  // This can only ever ADD to the repo, so a stale/empty device can never wipe another's reads.
  async function pushJson(file, _ignored) {
    if (!token() || !apiBase()) return; // local-only mode — no-op
    const r = repoCfg();
    for (let attempt = 0; attempt < 3; attempt++) {
      const { obj: remote, sha } = await getFile(file);
      const merged = mergeFor(file, remote, localFor(file));
      adoptMerged(file, merged);
      const body = JSON.stringify({ message: `state: update ${file}`, content: b64(JSON.stringify(merged, null, 2) + "\n"), branch: r.branch, ...(sha ? { sha } : {}) });
      const res = await fetch(`${apiBase()}${file}`, { method: "PUT", headers: ghHeaders(), body });
      if (res.ok) return;
      if (res.status !== 409) throw new Error(`write ${res.status}`); // 409 = sha race → re-merge & retry
    }
    throw new Error("write conflict");
  }
  async function pullRemote() {
    if (!token() || !apiBase()) return false;
    const before = JSON.stringify([state.articles, state.quizzes, knowledge.concepts]);
    const { obj: rs } = await getFile("reading-state.json");
    if (rs) adoptMerged("reading-state.json", mergeStates(rs, state));
    const { obj: kn } = await getFile("knowledge.json");
    if (kn) adoptMerged("knowledge.json", mergeKnowledge(kn, knowledge));
    return JSON.stringify([state.articles, state.quizzes, knowledge.concepts]) !== before;
  }

  // Debounced background sync so rapid reads don't spam commits.
  const pending = {}; let syncTimer = null;
  function scheduleSync(file, obj) {
    if (!token() || !apiBase()) return;
    pending[file] = obj;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(flushSync, 8000);
  }
  function flushSync() {
    const files = Object.keys(pending); const jobs = files.map((f) => pushJson(f, pending[f]));
    Object.keys(pending).forEach((k) => delete pending[k]);
    Promise.allSettled(jobs).then((rs) => { setSync(rs.every((x) => x.status === "fulfilled") ? "Synced ✓" : "Sync error — will retry"); });
  }
  window.addEventListener("pagehide", () => { if (Object.keys(pending).length) flushSync(); });
  window.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && Object.keys(pending).length) flushSync(); });

  function setSync(msg) { const el = $("#syncline"); if (!el) return; el.textContent = msg; el.hidden = false; }

  /* ---------- chrome ---------- */
  function currentTheme() {
    const t = document.documentElement.dataset.theme;
    if (t === "dark" || t === "light") return t;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  // Header icons (line SVGs, per the Cortex design). Show the target mode: sun while dark, moon while light.
  const ICON_SUN = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" /></svg>`;
  const ICON_MOON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" /></svg>`;
  const setThemeIcon = (t) => { const b = $("#themeBtn"); if (b) b.innerHTML = t === "dark" ? ICON_SUN : ICON_MOON; };
  // Nav-view line icons (Heroicons outline), matching the design's icon language.
  const svgIco = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="${d}" /></svg>`;
  const ICON_LIBRARY = svgIco("M6 6.878V6a2.25 2.25 0 0 1 2.25-2.25h7.5A2.25 2.25 0 0 1 18 6v.878m-12 0c.235-.083.487-.128.75-.128h10.5c.263 0 .515.045.75.128m-12 0A2.25 2.25 0 0 0 4.5 9v.878m13.5-3A2.25 2.25 0 0 1 19.5 9v.878m0 0a2.246 2.246 0 0 0-.75-.128H5.25c-.263 0-.515.045-.75.128m15 0A2.25 2.25 0 0 1 21 12v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6c0-.98.626-1.813 1.5-2.122");
  const ICON_CHART = svgIco("M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z");
  const ICON_DISCOVER = svgIco("M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z");
  const ICON_ARCHIVE = svgIco("m20.25 7.5-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z");
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("pr:theme", t); } catch {}
    setThemeIcon(t);
  }
  function isStandalone() {
    return matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }
  // The install bar is a phone "add to home screen" affordance — never show it on the desktop layout.
  const isDesktop = () => matchMedia("(min-width: 1024px)").matches;
  function initInstallPrompt() {
    if (isStandalone() || isDesktop()) return;
    try { if (localStorage.getItem("pr:install-dismissed")) return; } catch {}
    let deferred = null;
    window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; });
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    setTimeout(() => {
      if (isStandalone() || isDesktop() || document.querySelector(".install-bar")) return;
      const bar = document.createElement("div");
      bar.className = "install-bar";
      bar.innerHTML = `<span>${isIos ? "Add to your home screen — tap Share, then “Add to Home Screen”." : "Install this as an app for one-tap reading."}</span>` +
        `<span class="install-actions">${isIos ? "" : `<button class="install-go">Install</button>`}<button class="install-x" aria-label="Dismiss">✕</button></span>`;
      document.body.appendChild(bar);
      bar.querySelector(".install-x").addEventListener("click", () => { try { localStorage.setItem("pr:install-dismissed", "1"); } catch {} bar.remove(); });
      const go = bar.querySelector(".install-go");
      if (go) go.addEventListener("click", async () => { if (deferred) { deferred.prompt(); try { await deferred.userChoice; } catch {} deferred = null; } bar.remove(); });
    }, 6000);
  }
  function show(ov) { ov.hidden = false; document.body.style.overflow = "hidden"; }
  function hide(ov) { ov.hidden = true; ov.innerHTML = ""; document.body.style.overflow = ""; }
  function wireChrome() {
    $("#settingsBtn").addEventListener("click", openSettings);
    const tb = $("#themeBtn");
    if (tb) { setThemeIcon(currentTheme()); tb.addEventListener("click", () => applyTheme(currentTheme() === "dark" ? "light" : "dark")); }
    const setView = (v) => { view = view === v ? "reading" : v; render(); window.scrollTo(0, 0); };
    $("#libraryToggle")?.addEventListener("click", () => setView("library"));
    $("#statsToggle")?.addEventListener("click", () => setView("stats"));
    $("#discoverToggle")?.addEventListener("click", () => setView("discover"));
    $("#archiveToggle")?.addEventListener("click", () => setView("archive"));
    // Mobile bottom tab bar: HOME always returns to the feed; LIBRARY/STATS toggle.
    $("#navHome")?.addEventListener("click", () => { view = "reading"; render(); window.scrollTo(0, 0); });
    $("#navLibrary")?.addEventListener("click", () => setView("library"));
    $("#navStats")?.addEventListener("click", () => setView("stats"));
    $("#modeFilter")?.querySelectorAll(".mode-seg").forEach((b) => b.addEventListener("click", () => {
      modeFilter = b.dataset.mode || "all"; syncModeSeg(); writeHashState(); renderTabs(); render();
    }));
    const s = $("#search");
    s.addEventListener("input", () => { query = s.value.trim(); writeHashState(); render(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelectorAll(".overlay:not([hidden])").forEach(hide); });
    document.addEventListener("keydown", onShortcutKey);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register(BASE + "sw.js").catch(() => {});
  }
  // Keyboard: / focuses search, j/k (or arrows) move a roving selection through cards, o opens.
  // Enter is intentionally NOT handled here — cards bind their own Enter (avoids a double-open).
  function onShortcutKey(e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); $("#search")?.focus(); return; }
    if (document.querySelector(".overlay:not([hidden])")) return;
    const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    if (e.key === "/" && !typing) { e.preventDefault(); $("#search")?.focus(); return; }
    if (typing) return;
    const cards = [...document.querySelectorAll("#list .card")];
    if (!cards.length) return;
    const cur = cards.indexOf(document.activeElement);
    if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); (cards[cur + 1] || cards[0]).focus(); }
    else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); (cards[Math.max(cur - 1, 0)] || cards[0]).focus(); }
    else if (e.key === "o" && cur >= 0) { e.preventDefault(); openReader(cards[cur].dataset.id); }
  }
  // Filter state (tab + search) lives in the URL hash so a filtered view is bookmarkable/shareable across devices.
  function syncModeSeg() {
    const mf = $("#modeFilter"); if (!mf) return;
    mf.querySelectorAll(".mode-seg").forEach((x) => { const on = x.dataset.mode === modeFilter; x.classList.toggle("on", on); x.setAttribute("aria-pressed", on ? "true" : "false"); });
  }
  function readHashState() {
    const h = new URLSearchParams((location.hash || "").replace(/^#/, ""));
    const t = h.get("t");
    if (t && (t === "all" || INTERESTS.some((i) => i.id === t))) activeTab = t;
    const m = h.get("m");
    if (m === "current" || m === "learn") modeFilter = m;
    const q = h.get("q");
    if (q) { query = q; const s = $("#search"); if (s) s.value = q; }
    syncModeSeg();
  }
  function writeHashState() {
    const p = new URLSearchParams();
    if (activeTab && activeTab !== "all") p.set("t", activeTab);
    if (modeFilter !== "all") p.set("m", modeFilter);
    if (query) p.set("q", query);
    const hash = p.toString();
    try { history.replaceState(null, "", hash ? "#" + hash : location.pathname + location.search); } catch {}
  }
  function handleDeepLink() {
    const id = new URLSearchParams(location.search).get("article");
    if (id && manifest.articles.some((a) => a.id === id)) openReader(id);
  }

  boot();
})();
