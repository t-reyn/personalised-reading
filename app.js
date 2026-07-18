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

  const LS = { state: "pr:reading-state", know: "pr:knowledge", corpus: "pr:corpus", token: "pr:gh-token", repo: "pr:gh-repo" };
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const now = () => new Date().toISOString();
  const daysBetween = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
  const strHash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };
  const strHashNum = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h >>> 0; };

  let manifest = { articles: [] };
  let state = { version: 1, updatedAt: null, articles: {}, quizzes: {} };
  let knowledge = { version: 1, updatedAt: null, concepts: {} };
  let corpus = { version: 1, updatedAt: null, items: [] }; // user-curated permanent sources (synced)
  let quizbank = null; // { version, questions: { conceptId: [{q,options,correct}] } } — lazy-loaded, committed (not synced)
  let activeTab = "all";
  let query = "";
  let view = "reading"; // reading | library | stats | discover | corpus | archive
  let modeFilter = "all"; // all | current | learn
  const metaCache = {}; // articleId -> #meta (lazy)

  /* ---------- storage ---------- */
  function loadLocal(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  }
  // Repo coordinates default to config.json so a new device only needs a token pasted.
  const repoDefault = CONFIG.repo && CONFIG.repo.owner && CONFIG.repo.name ? { branch: "main", ...CONFIG.repo } : null;
  const repoCfg = () => {
    const saved = loadLocal(LS.repo, null);
    // 2026-07-18 privacy split: state now syncs to the private cortex-state repo. A device that
    // saved the pre-split default would keep writing state to the PUBLIC repo — treat that stored
    // value as stale and fall through to the embedded default (a deliberate non-default override
    // of some other name is left alone).
    if (saved && saved.name === "personalised-reading" && repoDefault && repoDefault.name !== "personalised-reading") return repoDefault;
    return saved || repoDefault;
  };
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
    if (A.glossary || B.glossary) { // grow-only union: a day seen on any device stays seen
      out.glossary = { seen_days: [...new Set([...(A.glossary?.seen_days || []), ...(B.glossary?.seen_days || [])])].sort() };
    }
    new Set([...Object.keys(A.quizzes || {}), ...Object.keys(B.quizzes || {})]).forEach((id) => {
      const x = (A.quizzes || {})[id], y = (B.quizzes || {})[id];
      if (!x || !y) { out.quizzes[id] = x || y; return; }
      if (x.passed !== y.passed) { out.quizzes[id] = x.passed ? x : y; return; } // best-ever wins: a pass never regresses to a fail
      out.quizzes[id] = (y.taken_at || "") >= (x.taken_at || "") ? y : x;
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
  // Corpus syncs as a per-item union keyed by id; soft-deletes carry a `deleted` flag so a removal on
  // one device propagates instead of being resurrected by a stale device. Most-recently-touched wins.
  function mergeCorpus(a, b) {
    const A = a || {}, B = b || {}, by = {};
    for (const it of [...(A.items || []), ...(B.items || [])]) {
      if (!it || !it.id) continue;
      const prev = by[it.id];
      if (!prev || (it.t || "") >= (prev.t || "")) by[it.id] = it;
    }
    return { version: 1, updatedAt: [A.updatedAt, B.updatedAt].filter(Boolean).sort().pop() || now(), items: Object.values(by) };
  }
  const isKnow = (file) => file === "knowledge.json";
  const isCorpus = (file) => file === "corpus.json";
  const localFor = (file) => (isKnow(file) ? knowledge : isCorpus(file) ? corpus : state);
  const mergeFor = (file, remote, local) => (isKnow(file) ? mergeKnowledge(remote, local) : isCorpus(file) ? mergeCorpus(remote, local) : mergeStates(remote, local));
  function adoptMerged(file, merged) {
    if (isKnow(file)) { knowledge = merged; try { localStorage.setItem(LS.know, JSON.stringify(knowledge)); } catch {} }
    else if (isCorpus(file)) { corpus = merged; try { localStorage.setItem(LS.corpus, JSON.stringify(corpus)); } catch {} }
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
    const localCorpus = loadLocal(LS.corpus, null);
    corpus = localCorpus || (await fetchJson("data/corpus.json").catch(() => corpus));
    state.articles ||= {}; state.quizzes ||= {}; knowledge.concepts ||= {}; corpus.items ||= [];

    // If synced, pull remote and adopt if newer (cross-device).
    if (token() && apiBase()) {
      requestPersistentStorage();
      await pullRemote().then(() => setSync("Synced ✓")).catch((e) => setSync(e?.auth ? AUTH_MSG : "Sync error — check token in Settings", true));
    } else if (apiBase() && !token()) {
      setSync("Not syncing — add your GitHub token in Settings", true);
    }
    sweepExpired();
    reconcileQuizKnowledge();

    wireChrome();
    readHashState();
    renderTabs();
    render();
    handleDeepLink();
    initInstallPrompt();

    // Dev term of the day — non-blocking; the banner appears whenever the glossary lands.
    fetchJson("data/glossary.json").then((g) => { glossary = g; renderTermBanner(); }).catch(() => {});
  }

  /* ---------- dev term of the day ----------
     A walk through data/glossary.json that advances one term per day the banner is actually
     seen, rendered as a compact "$ whatis <term>" strip above the Home list. Days the site
     isn't opened don't consume a term — the walk pauses and resumes on the next visit, so a
     missed day's term shows up then instead of being skipped forever. Seen days live in
     reading-state (state.glossary.seen_days) and union-merge across devices like the rest of
     the state; today's term is terms[seen days before today], so synced devices agree and the
     index is stable however many times today re-renders. skills/GLOSSARY.md tops the list up
     before it runs out; if that lapses, wrap to the oldest. Tap to reveal the example, ✕ hides
     it for the rest of the day. */
  let glossary = null; // { version, start_date, terms: [{term, def, eg}] } — committed, read-only
  const TERM_DISMISS_LS = "pr:term-dismissed";
  const localDayStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  // One-time seed for state that predates seen-day tracking: approximate past open-days from
  // recorded activity (reads, archives, quizzes) since the glossary began, so the walk resumes
  // near where the old calendar walk left off instead of replaying from term 0.
  function seedSeenDays() {
    const start = glossary?.start_date || "", today = localDayStr(), days = new Set();
    const add = (ts) => {
      const ms = Date.parse(ts || "");
      if (!Number.isFinite(ms)) return;
      const d = localDayStr(new Date(ms));
      if (d >= start && d < today) days.add(d);
    };
    Object.values(state.articles || {}).forEach((a) => { add(a.read_at); add(a.archived_at); add(a.t); });
    Object.values(state.quizzes || {}).forEach((q) => add(q.taken_at));
    return [...days].sort();
  }
  function renderTermBanner() {
    const el = $("#termBanner");
    if (!el) return;
    const terms = glossary?.terms || [];
    const day = localDayStr();
    let dismissed = null; try { dismissed = localStorage.getItem(TERM_DISMISS_LS); } catch {}
    if (view !== "reading" || !terms.length || dismissed === day) { el.hidden = true; return; }
    if (!Array.isArray(state.glossary?.seen_days)) { state.glossary = { seen_days: seedSeenDays() }; saveState(); }
    const seen = state.glossary.seen_days;
    const idx = seen.filter((d) => d < day).length % terms.length;
    const t = terms[idx];
    el.innerHTML = `
      <div class="term-card" role="button" tabindex="0" aria-expanded="false" title="Tap for an example">
        <div class="term-top">
          <span class="term-ps1" aria-hidden="true">$</span>
          <span class="term-cmd" aria-hidden="true">whatis</span>
          <b class="term-word">${esc(t.term)}</b>
          <span class="term-tod">term of the day</span>
          <button class="term-x" aria-label="Dismiss for today" title="Dismiss for today">✕</button>
        </div>
        <p class="term-def">${esc(t.def)}</p>
        ${t.eg ? `<p class="term-eg" hidden>${esc(t.eg)}</p><span class="term-more" aria-hidden="true">▸ example</span>` : ""}
      </div>`;
    el.hidden = false;
    if (!seen.includes(day)) { seen.push(day); seen.sort(); saveState(); } // today's term is now seen — the walk advances tomorrow
    const card = el.querySelector(".term-card");
    const toggle = () => {
      const eg = el.querySelector(".term-eg"), more = el.querySelector(".term-more");
      if (!eg) return;
      eg.hidden = !eg.hidden;
      if (more) more.textContent = eg.hidden ? "▸ example" : "▾ example";
      card.setAttribute("aria-expanded", String(!eg.hidden));
    };
    card.addEventListener("click", (e) => { if (e.target.closest(".term-x")) return; toggle(); });
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    el.querySelector(".term-x").addEventListener("click", (e) => {
      e.stopPropagation();
      try { localStorage.setItem(TERM_DISMISS_LS, day); } catch {}
      el.hidden = true;
    });
  }

  /* ---------- knowledge / selection ---------- */
  const isLearnt = (cid) => !!knowledge.concepts[cid]?.is_learnt;
  const taughtSomewhere = (cid) => manifest.articles.some((a) => !a.merged_into && (a.concepts_taught || []).includes(cid));

  // The article to read first to unlock a blocked one — it teaches the missing, not-yet-learnt prereq.
  function prereqArticleFor(a) {
    for (const c of (a.concepts_assumed || [])) {
      if (knowledge.concepts[c] && !isLearnt(c) && taughtSomewhere(c)) {
        const t = manifest.articles.find((x) => !x.merged_into && (x.concepts_taught || []).includes(c));
        if (t) return t;
      }
    }
    return null;
  }

  // Conservative gating: block only when a prerequisite genuinely exists and isn't learnt.
  function category(a) {
    const assumed = a.concepts_assumed || [];
    const taught = a.concepts_taught || [];
    // Current (perishable) briefs never hard-lock — they expire faster than prereqs get learnt. Gate learn-mode only.
    const blocked = articleMode(a) !== "current" && assumed.some((c) => knowledge.concepts[c] && !isLearnt(c) && taughtSomewhere(c));
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
     Learnt concepts do NOT resurface old articles any more — they wait out a difficulty-scaled
     ladder, then get woven into a FUTURE article via that article's concepts_reinforced (see
     skills/AUTHORING.md). Only a FAILED quiz still resurfaces the original article, as a same-
     article "↻ Try again" retry a few days later. */
  const REVIEW_LADDERS = { easy: [], medium: [90, 180], hard: [60, 120, 240] }; // days; empty = never resurfaces
  const DEFAULT_DIFFICULTY = "medium";
  const LEGACY_REVIEW_DAYS = 90; // learnt concepts with no schedule fall due after this (authoring-side only)
  // Advance a concept's schedule from `fromMs` using its difficulty's ladder at its current review_level.
  // Past the ladder's end (or for "easy", which has an empty ladder) the concept retires: next_review_at
  // stays null and it never comes due again.
  function scheduleNextReview(c, fromMs) {
    const ladder = REVIEW_LADDERS[c.difficulty] || REVIEW_LADDERS[DEFAULT_DIFFICULTY];
    const idx = (c.review_level || 1) - 1;
    c.next_review_at = idx < ladder.length ? new Date(fromMs + ladder[idx] * 86400000).toISOString() : null;
  }
  function conceptDue(cid) {
    const c = knowledge.concepts[cid];
    if (!c) return false;
    if (!c.is_learnt) {
      // A failed concept was rescheduled (review_level ≥ 1) — resurface it once its retry gap elapses.
      return c.review_level >= 1 && !!c.next_review_at && c.next_review_at <= now();
    }
    if (c.next_review_at === null) return false; // retired: ladder exhausted, or difficulty "easy" — never resurfaces
    if (c.next_review_at) return c.next_review_at <= now();
    // Legacy learnt concept with no schedule at all (pre-migration data): authoring-side awareness only.
    return c.learnt_at ? daysBetween(now(), c.learnt_at) >= LEGACY_REVIEW_DAYS : false;
  }
  // A concept that's due specifically because a quiz was failed (vs a learnt one up for spaced review).
  const conceptFailedDue = (cid) => { const c = knowledge.concepts[cid]; return !!c && !c.is_learnt && conceptDue(cid); };
  // An already-read article whose failed concepts are due for another attempt. This is the ONLY
  // way an old article resurfaces on Home — learnt-concept review no longer does (see above).
  function articleRetryDue(a) {
    return isRead(a.id) && !a.merged_into && (a.concepts_taught || []).some(conceptFailedDue);
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
      ? (articleLearnt(a) ? { c: "learnt", t: "Learnt" } : { c: "read", t: "Read" })
      : null;
    const prereq = opts?.locked ? prereqArticleFor(a) : null;
    const readMin = a.word_count ? Math.ceil(a.word_count / 200) : 0; // ~200 wpm; only when the manifest carries a count
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
        ${readMin ? `<span class="tag">${readMin} min</span>` : ""}
        ${opts.review ? `<span class="due-note">⟳ time to review</span>` : (read ? `<span class="readtick">✓ read</span>` : "")}
        ${merged ? `<span class="merged-note">↳ consolidates ${merged}</span>` : ""}
        ${prereq ? `<button class="prereq" type="button" data-prereq="${esc(prereq.id)}" title="Open the prerequisite article">🔒 Read "${esc(prereq.title)}" first</button>` : ""}
        ${opts.archive ? "" : fbHtml(a.id)}
      </div>
    </article>`;
  }

  const byNew = (x, y) => (y.created_at || "").localeCompare(x.created_at || "");

  function bindCards(root) {
    root.querySelectorAll(".card").forEach((el) => {
      el.addEventListener("click", (e) => { if (e.target.closest(".star,.restore,.prereq,.fb")) return; openReader(el.dataset.id); });
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") openReader(el.dataset.id); });
    });
    root.querySelectorAll(".fbb").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      setFeedback(b.dataset.fbid, b.dataset.fb);
      const fb = state.articles[b.dataset.fbid]?.feedback;
      b.closest(".fb").querySelectorAll(".fbb").forEach((x) => x.classList.toggle("on", x.dataset.fb === fb));
    }));
    root.querySelectorAll(".star").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); toggleStar(b.dataset.star); }));
    root.querySelectorAll(".restore").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); restore(b.dataset.restore); }));
    root.querySelectorAll("[data-prereq]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openReader(b.dataset.prereq); }));
  }

  function render() {
    renderTermBanner(); // only visible on the Home view — every view change routes through here
    const list = $("#list");
    const arts = visibleArticles();
    const archived = arts.filter((a) => statusOf(a.id) === "archived");
    const active = arts.filter((a) => statusOf(a.id) !== "archived");
    const rc = $("#resultCount");
    if (rc) rc.textContent = (query && view === "reading") ? `${active.length} result${active.length === 1 ? "" : "s"} for “${query}”` : "";

    if (view === "library") { renderLibrary(); return; }
    if (view === "stats") { renderStats(); return; }
    if (view === "discover") { renderDiscover(); return; }
    if (view === "corpus") { renderCorpus(); return; }

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
    const buckets = { normal: [], review: [], blocked: [] };
    const retryDue = [];
    active.forEach((a) => {
      // Read articles live in Library; on Home only re-surface ones due for a failed-quiz retry.
      // Learnt-concept review no longer resurfaces old articles — it's woven into future ones instead.
      if (isRead(a.id)) { if (articleRetryDue(a)) retryDue.push(a); }
      else buckets[category(a)].push(a);
    });
    const shelf = (title, items, opts) => items.length ? `<h2 class="shelf-title">${title}</h2><div class="shelf-grid">${items.sort(byNew).map((a) => cardHtml(a, opts)).join("")}</div>` : "";
    const shelves =
      shelf("↻ Try again", retryDue, { review: true }) +
      shelf("To read", buckets.normal) +
      shelf("Worth a review", buckets.review) +
      shelf("Locked until you learn the basics", buckets.blocked, { locked: true });
    list.innerHTML = shelves || `<div class="empty"><div class="big">✓</div><p>${query ? "No unread articles match your search." : "You're all caught up. New reading is written each morning — your read articles live in Library."}</p></div>`;
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
    const learnt = reads.filter(articleLearnt);
    const plain = reads.filter((a) => !articleLearnt(a));
    const shelf = (title, items, opts) => items.length ? `<h2 class="shelf-title">${title}</h2><div class="shelf-grid">${items.sort(byReadDesc).map((a) => cardHtml(a, opts)).join("")}</div>` : "";
    list.innerHTML =
      `<div class="lib-summary"><b>${reads.length}</b> read · <b>${learntCount}</b> concept${learntCount === 1 ? "" : "s"} learnt</div>` +
      (reads.length
        ? shelf("Learnt", learnt, { library: true }) + shelf("Read", plain, { library: true })
        : `<div class="empty"><div class="big">📚</div><p>${query ? "No read articles match your search." : "Your library fills up as you read. Open an article, mark it read — it lives here with what you've learnt."}</p></div>`);
    bindCards(list);
    updateToggles();
  }

  function updateToggles() {
    const archN = manifest.articles.filter((a) => !a.merged_into && statusOf(a.id) === "archived").length;
    const retryN = manifest.articles.filter(articleRetryDue).length;
    const btn = (sel, v, icon, label) => { const b = $(sel); if (!b) return; b.hidden = false; b.classList.toggle("on", view === v); b.innerHTML = icon + `<span>${esc(label)}</span>`; };
    const corpusN = corpus.items.filter((x) => !x.deleted).length;
    btn("#libraryToggle", "library", ICON_LIBRARY, retryN > 0 ? `Library · ${retryN} to retry` : "Library");
    btn("#statsToggle", "stats", ICON_CHART, "Stats");
    btn("#discoverToggle", "discover", ICON_DISCOVER, "Discover");
    btn("#corpusToggle", "corpus", ICON_CORPUS, corpusN ? `Corpus (${corpusN})` : "Corpus");
    const ab = $("#archiveToggle");
    if (ab) {
      if (archN > 0 || view === "archive") { ab.hidden = false; ab.classList.toggle("on", view === "archive"); ab.innerHTML = ICON_ARCHIVE + `<span>Archive${archN ? ` (${archN})` : ""}</span>`; }
      else ab.hidden = true;
    }
    // Mobile bottom tab bar active state (HOME = reading; archive highlights nothing).
    const navFor = { reading: "navHome", library: "navLibrary", stats: "navStats", discover: "navDiscover", corpus: "navCorpus" };
    ["navHome", "navLibrary", "navStats", "navDiscover", "navCorpus"].forEach((id) => {
      const b = document.getElementById(id); if (!b) return;
      const on = navFor[view] === id;
      b.classList.toggle("on", on);
      b.setAttribute("aria-current", on ? "page" : "false");
    });
  }

  /* ---------- stats ---------- */
  function conceptInterest(cid, c) { return c.interest || (manifest.articles.find((a) => a.id === c.first_taught) || {}).interest || "other"; }
  // The knowledge map: every concept as a chip, grouped by interest — filled dot = learnt, ⟳ = due
  // for review, › = has prerequisites. Tapping a chip highlights its prerequisite chips (the graph's
  // edges, revealed on demand: a drawn 115-node edge diagram is unreadable at phone width).
  function renderKnowledgeMap() {
    const groups = {};
    for (const [cid, c] of Object.entries(knowledge.concepts)) (groups[conceptInterest(cid, c)] ||= []).push([cid, c]);
    // Edges: explicit prerequisite_ids (the generator has never populated these — 0/115 as of
    // 2026-07-18) unioned with edges DERIVED from the articles themselves: a piece that teaches X
    // while assuming Y makes Y a prerequisite of X. That derivation is what actually draws the map.
    const prereqsOf = {};
    for (const a of manifest.articles) {
      for (const t of a.concepts_taught || []) {
        for (const p of a.concepts_assumed || []) (prereqsOf[t] ||= new Set()).add(p);
      }
    }
    const chip = ([cid, c]) => {
      const due = conceptDue(cid);
      const pre = [...new Set([...(c.prerequisite_ids || []), ...(prereqsOf[cid] || [])])].filter((p) => knowledge.concepts[p]);
      const stateTxt = due ? "due for review" : c.is_learnt ? "learnt" : "not yet learnt";
      return `<button type="button" class="kc${c.is_learnt ? " learnt" : ""}${due ? " due" : ""}" data-kc="${esc(cid)}"${pre.length ? ` data-pre="${esc(pre.join(","))}"` : ""} title="${esc(c.label || cid)} — ${stateTxt}${pre.length ? ` · needs ${pre.length}` : ""}"><span class="kc-dot"></span>${esc(c.label || cid)}${due ? `<span class="kc-due">⟳</span>` : ""}${pre.length ? `<span class="kc-pre">›</span>` : ""}</button>`;
    };
    const sections = [...INTERESTS, { id: "other", label: "Other", emoji: "◦", accent: "#8a8a8a" }]
      .filter((i) => groups[i.id]?.length)
      .map((i) => {
        const items = groups[i.id].sort((a, b) =>
          (b[1].is_learnt ? 1 : 0) - (a[1].is_learnt ? 1 : 0) || (a[1].label || a[0]).localeCompare(b[1].label || b[0]));
        const learntN = items.filter(([, c]) => c.is_learnt).length;
        return `<div class="kmap-sec" style="--accent:${esc(i.accent)}"><div class="kmap-head"><span>${esc(i.emoji)} ${esc(i.label)}</span><span class="kmap-count">${learntN}/${items.length} learnt</span></div><div class="kmap-chips">${items.map(chip).join("")}</div></div>`;
      });
    if (!sections.length) return "";
    return `<h2 class="shelf-title">Knowledge map</h2>
      <div class="kmap-legend"><span><span class="kc-dot demo filled"></span> learnt</span><span><span class="kc-dot demo"></span> not yet</span><span><span class="kc-due">⟳</span> due for review</span><span><span class="kc-pre">›</span> tap to see prerequisites</span></div>
      ${sections.join("")}`;
  }
  function bindKnowledgeMap(root) {
    root.querySelectorAll(".kc").forEach((b) => b.addEventListener("click", () => {
      const wasSelected = b.classList.contains("sel");
      root.querySelectorAll(".kc").forEach((x) => x.classList.remove("sel", "hl"));
      if (wasSelected) return; // second tap clears the highlight
      b.classList.add("sel");
      (b.dataset.pre || "").split(",").filter(Boolean).forEach((p) =>
        root.querySelector(`.kc[data-kc="${CSS.escape(p)}"]`)?.classList.add("hl"));
    }));
  }
  function renderStats() {
    const list = $("#list");
    const reads = manifest.articles.filter((a) => !a.merged_into && isRead(a.id));
    const learnt = Object.entries(knowledge.concepts).filter(([, c]) => c.is_learnt);
    const retryN = manifest.articles.filter(articleRetryDue).length;
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
      `<div class="stats-grid">${stat("Day streak", streak)}${stat("Articles read", reads.length)}${stat("Concepts learnt", learnt.length)}${stat("Due for retry", retryN)}</div>` +
      `<h2 class="shelf-title">Reading by topic</h2><div class="bars">${bars(byTopic)}</div>` +
      `<h2 class="shelf-title">Concepts learnt by topic</h2><div class="bars">${bars(learntByTopic)}</div>` +
      renderKnowledgeMap();
    bindKnowledgeMap(list);
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
    const card = (it) => { const saved = corpusHas(it.url); return `<article class="disc-card has-save" style="--accent:${esc((INTEREST_BY_ID[it.interest] || {}).accent || "#4f7cac")}">
        <button class="disc-save${saved ? " saved" : ""}" data-save="${esc(it.id)}" aria-label="Save to corpus" title="${saved ? "Saved to corpus" : "Save to corpus"}"${saved ? " disabled" : ""}>${saved ? "✓" : "＋"}</button>
        <button class="disc-x" data-dismiss="${esc(it.id)}" aria-label="Dismiss" title="Hide this">✕</button>
        <div class="disc-src">${esc(srcOf(it))}${srcOf(it) && ageOf(it) ? " · " : ""}${esc(ageOf(it))}</div>
        <a class="disc-title" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(cleanTitle(it.title))}</a>
      </article>`; };
    list.innerHTML =
      `<div class="lib-summary">Fresh from your feeds — <b>${items.length}</b> unread from the web. Open one to read the original.</div>` +
      INTERESTS.filter((i) => byInterest[i.id]).map((i) => `<h2 class="shelf-title">${esc(i.emoji)} ${esc(i.label)}</h2><div class="shelf-grid">${byInterest[i.id].map(card).join("")}</div>`).join("");
    list.querySelectorAll("[data-dismiss]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); dismissDiscover(b.dataset.dismiss); }));
    list.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const it = items.find((x) => x.id === b.dataset.save);
      if (it && addToCorpus({ url: it.url, title: cleanTitle(it.title), interest: it.interest })) { b.textContent = "✓"; b.classList.add("saved"); b.disabled = true; b.title = "Saved to corpus"; }
    }));
    updateToggles();
  }

  /* ---------- corpus (durable, user-curated sources) ---------- */
  function renderCorpus() {
    const list = $("#list");
    let items = corpus.items.filter((x) => !x.deleted);
    if (activeTab !== "all") items = items.filter((x) => x.interest === activeTab);
    if (query) { const q = query.toLowerCase(); items = items.filter((x) => (`${x.title} ${x.url} ${x.note || ""}`).toLowerCase().includes(q)); }
    items.sort((a, b) => (b.added_at || "").localeCompare(a.added_at || ""));
    const addBar = `<div class="corpus-add">
        <input id="corpus-url" type="url" placeholder="Paste a URL to save…" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" />
        <button class="btn primary" id="corpus-add-btn">Save</button>
      </div>
      <p class="corpus-hint" id="corpus-msg">Your hand-picked sources — they sync across devices and feed the writer. Tap “＋” on a Discover card to add one here.</p>`;
    const card = (x) => `<article class="disc-card has-save" style="--accent:${esc((INTEREST_BY_ID[x.interest] || {}).accent || "#4f7cac")}">
        <button class="disc-x" data-remove="${esc(x.id)}" aria-label="Remove" title="Remove from corpus">✕</button>
        <div class="disc-src">${esc(hostOf(x.url))}${x.interest && INTEREST_BY_ID[x.interest] ? " · " + esc(INTEREST_BY_ID[x.interest].label) : ""}</div>
        <a class="disc-title" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title || x.url)}</a>
        ${x.note ? `<div class="disc-note">${esc(x.note)}</div>` : ""}
      </article>`;
    list.innerHTML = addBar + (items.length
      ? `<div class="lib-summary"><b>${items.length}</b> saved source${items.length === 1 ? "" : "s"}${activeTab !== "all" ? " in this topic" : ""}</div><div class="shelf-grid">${items.map(card).join("")}</div>`
      : `<div class="empty"><div class="big">🔖</div><p>${query ? "No saved sources match your search." : "Nothing saved yet. Paste a URL above, or tap “＋” on a Discover card to keep a source here."}</p></div>`);
    const input = $("#corpus-url"), msg = $("#corpus-msg");
    const doAdd = () => {
      if (addToCorpus({ url: input.value, interest: activeTab !== "all" ? activeTab : null })) { input.value = ""; renderCorpus(); }
      else { msg.textContent = "Enter a full URL (https://…)."; msg.classList.add("error"); }
    };
    $("#corpus-add-btn")?.addEventListener("click", doAdd);
    input?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doAdd(); } });
    list.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); removeFromCorpus(b.dataset.remove); }));
    updateToggles();
  }

  /* ---------- mutations ---------- */
  function saveState() { state.updatedAt = now(); try { localStorage.setItem(LS.state, JSON.stringify(state)); } catch {} scheduleSync("reading-state.json", state); }
  function saveKnowledge() { knowledge.updatedAt = now(); try { localStorage.setItem(LS.know, JSON.stringify(knowledge)); } catch {} scheduleSync("knowledge.json", knowledge); }
  function saveCorpus() { corpus.updatedAt = now(); try { localStorage.setItem(LS.corpus, JSON.stringify(corpus)); } catch {} scheduleSync("corpus.json", corpus); }
  // Share links carry tracking junk in the query string, and a Substack share URL's `token` is a signed
  // blob whose payload contains your numeric Substack user_id. corpus.json is committed to a PUBLIC
  // repo, so a pasted share link publishes that id forever. Drop the query string and the fragment —
  // nothing we save needs either — and prefer the publication's own host over the share redirector.
  function canonicalUrl(raw) {
    try {
      const u = new URL(raw);
      u.search = "";
      u.hash = "";
      // open.substack.com/pub/<pub>/p/<slug> -> <pub>.substack.com/p/<slug>
      const m = /^\/pub\/([^/]+)(\/p\/.+)$/.exec(u.pathname);
      if (u.hostname === "open.substack.com" && m) {
        u.hostname = `${m[1]}.substack.com`;
        u.pathname = m[2];
      }
      return u.toString().replace(/\/$/, "");
    } catch { return raw; }
  }
  const corpusHas = (url) => { const c = canonicalUrl(url); return corpus.items.some((x) => x.url === c && !x.deleted); };
  // Save an external source to the durable corpus (deduped by url; un-deletes if it was removed before).
  function addToCorpus({ url, title, interest, note }) {
    url = canonicalUrl((url || "").trim());
    if (!/^https?:\/\//i.test(url)) return false;
    const id = strHash(url);
    // Match on url too: ids of pre-canonicalisation entries were hashed from the raw share URL, so an
    // id-only lookup would miss them and push a duplicate card for the same article.
    const existing = corpus.items.find((x) => x.id === id || x.url === url);
    if (existing) Object.assign(existing, { deleted: false, t: now() }, (title && title.trim()) ? { title: title.trim() } : {});
    else corpus.items.push({ id, url, title: (title || "").trim() || hostOf(url), interest: interest || null, note: (note || "").trim(), added_at: now(), t: now(), deleted: false });
    saveCorpus();
    return true;
  }
  function removeFromCorpus(id) {
    const it = corpus.items.find((x) => x.id === id);
    if (!it) return;
    it.deleted = true; it.t = now(); saveCorpus();
    if (view === "corpus") renderCorpus();
  }

  function toggleStar(id) {
    const a = (state.articles[id] ||= { status: "backlog" });
    a.starred = !a.starred; a.t = now(); saveState(); renderTabs(); render();
  }
  // Taste signal for the daily author: "more like this" / "less like this". One value per article
  // (up | down | absent); tapping the active one clears it. Lives on the article entry so it rides
  // the existing per-entry sync merge, and the generator reads it from reading-state.json.
  function setFeedback(id, dir) {
    const a = (state.articles[id] ||= { status: "backlog" });
    a.feedback = a.feedback === dir ? null : dir;
    if (!a.feedback) delete a.feedback;
    a.t = now(); saveState();
  }
  const fbHtml = (id, cls = "") => {
    const fb = state.articles[id]?.feedback;
    return `<span class="fb ${cls}"><button type="button" class="fbb${fb === "up" ? " on" : ""}" data-fb="up" data-fbid="${esc(id)}" aria-label="More like this" title="More like this">👍</button><button type="button" class="fbb${fb === "down" ? " on" : ""}" data-fb="down" data-fbid="${esc(id)}" aria-label="Less like this" title="Less like this">👎</button></span>`;
  };
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

  // Union of an article's taught + reinforced concept ids (no duplicates) — reinforced concepts
  // (woven into a later article per skills/AUTHORING.md) are graded on exactly the same path as
  // freshly-taught ones.
  const gradableConcepts = (article) => {
    const out = [];
    const seen = new Set();
    for (const cid of [...(article.concepts_taught || []), ...(article.concepts_reinforced || [])]) {
      if (!seen.has(cid)) { seen.add(cid); out.push(cid); }
    }
    return out;
  };

  // Grade each taught/reinforced concept on its own tagged questions. `passMap` is { conceptId: bool };
  // a concept with no tagged question is absent from the map and left untouched (neither credited nor
  // failed).
  function learnConcepts(article, passMap) {
    let touched = false;
    gradableConcepts(article).forEach((cid) => {
      if (!(cid in passMap)) return; // untested this quiz — the authoring contract now requires one question per concept
      const c = (knowledge.concepts[cid] ||= { label: cid, interest: article.interest, prerequisite_ids: [], is_learnt: false, review_level: 0, next_review_at: null, difficulty: DEFAULT_DIFFICULTY });
      if (passMap[cid]) {
        c.is_learnt = true; c.learnt_at = c.learnt_at || now();
        c.review_level = (c.review_level || 0) + 1; // each pass advances the ladder
        scheduleNextReview(c, Date.now());
      } else {
        c.is_learnt = false; c.review_level = Math.max(1, c.review_level || 0); c.next_review_at = new Date(Date.now() + 3 * 86400000).toISOString();
        // A failed quiz escalates difficulty a step — it comes back sooner (or for the first time) next round.
        const d = c.difficulty || DEFAULT_DIFFICULTY;
        c.difficulty = d === "easy" ? "medium" : "hard";
      }
      touched = true;
    });
    if (touched) saveKnowledge();
  }

  // Boot-time repair: a passed quiz and its concepts' is_learnt can diverge (state + knowledge are written
  // separately and synced separately). For every passed quiz, credit any taught/reinforced concept still
  // not learnt — stamping learnt_at from the quiz's taken_at and initialising review fields like a normal
  // pass. Idempotent.
  function reconcileQuizKnowledge() {
    let changed = false;
    for (const [id, qz] of Object.entries(state.quizzes || {})) {
      if (!qz?.passed) continue;
      const art = manifest.articles.find((x) => x.id === id);
      if (!art) continue;
      for (const cid of gradableConcepts(art)) {
        const c = knowledge.concepts[cid];
        if (c && c.is_learnt) continue;
        const base = c || (knowledge.concepts[cid] = { label: cid, interest: art.interest, prerequisite_ids: [], is_learnt: false, review_level: 0, next_review_at: null, difficulty: DEFAULT_DIFFICULTY });
        base.is_learnt = true;
        base.learnt_at = base.learnt_at || qz.taken_at || now();
        base.review_level = (base.review_level || 0) + 1;
        scheduleNextReview(base, new Date(base.learnt_at).getTime());
        changed = true;
      }
    }
    if (changed) saveKnowledge(); // persist + queue a sync only when something actually diverged
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
        ${fbHtml(id, "ov-fb")}
        ${isRead(id) ? `<button class="btn" data-act="unread">Mark unread</button>` : `<button class="btn good" data-act="read">✓ Mark read</button>`}
        ${hasQuiz ? `<button class="btn primary" data-act="quiz">Take quiz →</button>` : ""}
      </div>`;
    show(ov);
    ov.querySelectorAll(".fbb").forEach((b) => b.addEventListener("click", () => {
      setFeedback(id, b.dataset.fb);
      const fb = state.articles[id]?.feedback;
      ov.querySelectorAll(".fbb").forEach((x) => x.classList.toggle("on", x.dataset.fb === fb));
    }));
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
  // Deterministic seeded shuffle of a question's options, remapping the correct index. Seeded on the
  // article id + question index + the calendar day, so a re-render is stable within a day but not gameable.
  function shuffleOptions(q, seed) {
    let s = seed >>> 0; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; // LCG
    const idx = q.options.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    return { ...q, options: idx.map((i) => q.options[i]), correct: idx.indexOf(q.correct) };
  }
  async function loadQuizbank() {
    if (quizbank) return quizbank;
    quizbank = await fetchJson("data/quizbank.json").catch(() => ({ version: 1, questions: {} }));
    quizbank.questions ||= {};
    return quizbank;
  }
  // Build the question list for a quiz. First reads use the article's own questions. Reviews prefer a
  // fresh quizbank question per due concept (rotated by review_level) so spaced repetition doesn't just
  // re-serve the graded answer key; concepts with no bank entry fall back to the article's own question.
  function reviewQuestions(a, meta, bank) {
    const own = meta.quick_check || [];
    const byConcept = {};
    own.forEach((q) => { if (q.concept && !(q.concept in byConcept)) byConcept[q.concept] = q; });
    const dueConcepts = (a.concepts_taught || []).filter((cid) => byConcept[cid] || (bank.questions[cid] || []).length);
    if (!dueConcepts.length) return own;
    return dueConcepts.map((cid) => {
      const pool = bank.questions[cid] || [];
      if (pool.length) {
        const lvl = knowledge.concepts[cid]?.review_level || 1;
        const pick = pool[(pool.length - 1 - (lvl - 1)) % pool.length] || pool[pool.length - 1]; // rotate from newest
        return { ...pick, concept: cid };
      }
      return byConcept[cid];
    });
  }

  async function openQuiz(a, meta) {
    const ov = $("#quiz");
    const isReview = !!state.quizzes[a.id]?.passed || articleRetryDue(a);
    let qs = meta.quick_check || [];
    if (isReview) { try { qs = reviewQuestions(a, meta, await loadQuizbank()); } catch {} }
    const daySeed = strHashNum(now().slice(0, 10));
    qs = qs.map((q, qi) => shuffleOptions(q, strHashNum(a.id) ^ (qi + 1) * 2654435761 ^ daySeed)); // render-time only; never mutates meta
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
          // Per-concept grading: a concept is learnt only when every question tagged with it is correct.
          const passMap = {};
          qs.forEach((q, i) => { if (!q.concept) return; const ok = answers[i] === q.correct; passMap[q.concept] = (q.concept in passMap ? passMap[q.concept] : true) && ok; });
          learnConcepts(a, passMap);
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
        <div class="field"><label>Repository name</label><input id="s-name" value="${esc(r.name)}" placeholder="cortex-state" /></div>
        <div class="field"><label>Branch</label><input id="s-branch" value="${esc(r.branch || "main")}" placeholder="main" /></div>
        <div class="field"><label>Access token</label><input id="s-token" type="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" value="${esc(token())}" placeholder="github_pat_…" />
          <p class="hint">A <b>fine-grained</b> token with <b>Contents: Read and write</b> on the <b>private state repo</b> named above (your reading state lives there, not in the public site repo). Set the expiry to <b>No expiration</b> (or 1 year) so it doesn't lapse. Create one at <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings</a>. Stored only in this browser — paste once.</p></div>
        <div class="ov-actions" style="padding-left:0;padding-right:0">
          <button class="btn" data-act="pull">Pull</button>
          <button class="btn primary" data-act="save">Save</button>
        </div>
        <p class="hint" id="s-status"></p>
        <p class="hint" id="s-storage"></p>
      </div></div>`;
    show(ov);
    ov.querySelector(".close").onclick = () => hide(ov);
    (async () => {
      const el = $("#s-storage"); if (!el) return;
      try {
        if (navigator.storage && navigator.storage.persisted) {
          el.textContent = (await navigator.storage.persisted()) ? "Storage: protected ✓ — your token won't be evicted." : "Storage: not yet protected — press Save (or install to home screen) to keep your token.";
        }
      } catch {}
    })();
    ov.querySelector('[data-act="save"]').addEventListener("click", async () => {
      const owner = $("#s-owner").value.trim(), name = $("#s-name").value.trim(), branch = $("#s-branch").value.trim() || "main", tk = $("#s-token").value.trim();
      const status = $("#s-status");
      try { localStorage.setItem(LS.repo, JSON.stringify({ owner, name, branch })); tk ? localStorage.setItem(LS.token, tk) : localStorage.removeItem(LS.token); }
      catch { status.textContent = "This browser blocked saving (private mode?)."; return; }
      if (!token()) { status.textContent = "No token saved — paste your github_pat_… token, then Save."; return; }
      if (!apiBase()) { status.textContent = "Fill in repository owner and name, then Save."; return; }
      status.textContent = "Saving…";
      await requestPersistentStorage();   // user gesture → best chance the browser keeps the token
      try {
        await pushJson("reading-state.json", state);
        await pushJson("knowledge.json", knowledge);
        status.textContent = "Synced ✓ — your reading now syncs to GitHub.";
        try { const se = $("#s-storage"); if (se && navigator.storage?.persisted) se.textContent = (await navigator.storage.persisted()) ? "Storage: protected ✓ — your token won't be evicted." : "Storage: not protected — install to home screen to keep your token."; } catch {}
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

  // Auth failures (bad/expired/revoked token) must be distinguished from transient ones so we stop
  // retrying instead of hammering 401s. A 403 that carries a rate-limit signal is transient, not auth.
  const AUTH_MSG = "Sync paused — your GitHub token expired or was revoked. Paste a new one in Settings.";
  function isAuthError(res) {
    if (res.status === 401) return true;
    // A 403 is transient (rate limit / secondary limit) when it carries a limit signal; otherwise it's auth.
    if (res.status === 403) return !(res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"));
    return false;
  }
  const mkErr = (msg, auth) => { const e = new Error(msg); if (auth) e.auth = true; return e; };
  // file -> { etag, sha }: the ETag lets an unchanged GET 304 (no body, no rate-limit cost); the blob
  // sha is what a subsequent PUT needs, and stays valid while the file is unchanged (304).
  const remoteRef = {};

  // Read a state file from the repo → { obj, sha } (or { notModified:true, sha } on a 304).
  // obj is null if the file doesn't exist.
  async function getFile(file) {
    const r = repoCfg();
    const headers = ghHeaders();
    const ref = remoteRef[file];
    if (ref?.etag) headers["If-None-Match"] = ref.etag;
    const res = await fetch(`${apiBase()}${file}?ref=${r.branch}`, { headers, cache: "no-store" });
    if (res.status === 304) return { notModified: true, sha: ref?.sha ?? null }; // unchanged → last blob sha still valid
    if (res.status === 404) { delete remoteRef[file]; return { obj: null, sha: null }; }
    if (isAuthError(res)) throw mkErr(AUTH_MSG, true);
    if (!res.ok) throw new Error(`read ${res.status}`);
    const j = await res.json();
    remoteRef[file] = { etag: res.headers.get("etag") || null, sha: j.sha };
    let obj = null;
    try { obj = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob((j.content || "").replace(/\n/g, "")), (c) => c.charCodeAt(0)))); } catch {}
    return { obj, sha: j.sha };
  }
  // Push = pull-merge-push: fetch remote, union with local, adopt the merge locally, write it.
  // This can only ever ADD to the repo, so a stale/empty device can never wipe another's reads.
  async function pushJson(file, _ignored) {
    if (!token() || !apiBase()) return; // local-only mode — no-op
    const r = repoCfg();
    for (let attempt = 0; attempt < 3; attempt++) {
      const { obj: remote, sha } = await getFile(file); // remote is undefined on a 304 (unchanged → local already reflects it)
      const merged = mergeFor(file, remote ?? null, localFor(file));
      adoptMerged(file, merged);
      const body = JSON.stringify({ message: `state: update ${file}`, content: b64(JSON.stringify(merged, null, 2) + "\n"), branch: r.branch, ...(sha ? { sha } : {}) });
      const res = await fetch(`${apiBase()}${file}`, { method: "PUT", headers: ghHeaders(), body });
      if (res.ok) { try { remoteRef[file] = { etag: null, sha: (await res.json())?.content?.sha || null }; } catch { delete remoteRef[file]; } return; } // new blob sha for the next PUT; drop the ETag so the next GET re-reads once
      if (isAuthError(res)) throw mkErr(AUTH_MSG, true);
      if (res.status !== 409) throw new Error(`write ${res.status}`); // 409 = sha race → re-merge & retry
    }
    throw new Error("write conflict");
  }
  async function pullRemote() {
    if (!token() || !apiBase()) return false;
    const before = JSON.stringify([state.articles, state.quizzes, state.glossary, knowledge.concepts, corpus.items]);
    // Each getFile sends If-None-Match; an unchanged file 304s (no body, no rate-limit cost) → skip its merge.
    const rs = await getFile("reading-state.json");
    if (rs.obj) adoptMerged("reading-state.json", mergeStates(rs.obj, state));
    const kn = await getFile("knowledge.json");
    if (kn.obj) adoptMerged("knowledge.json", mergeKnowledge(kn.obj, knowledge));
    const cp = await getFile("corpus.json");
    if (cp.obj) adoptMerged("corpus.json", mergeCorpus(cp.obj, corpus));
    return JSON.stringify([state.articles, state.quizzes, state.glossary, knowledge.concepts, corpus.items]) !== before;
  }

  // Debounced background sync so rapid reads don't spam commits.
  const pending = {}; let syncTimer = null;
  function scheduleSync(file, obj) {
    if (!apiBase()) return;                 // no repo configured → pure local mode, nothing to surface
    pending[file] = obj;                    // queue regardless of token so it survives a token re-add
    if (!token()) { setSync("Not syncing — add your GitHub token in Settings", true); return; }
    clearTimeout(syncTimer);
    syncTimer = setTimeout(flushSync, 8000);
  }
  function flushSync() {
    const files = Object.keys(pending);
    if (!files.length) return;
    if (!token() || !apiBase()) { setSync("Not syncing — add your GitHub token in Settings", true); return; } // keep pending
    files.forEach((k) => delete pending[k]);
    Promise.allSettled(files.map((f) => pushJson(f, localFor(f)))).then((rs) => {
      const failed = files.filter((_, i) => rs[i].status === "rejected");
      if (!failed.length) { setSync("Synced ✓"); return; }
      const auth = rs.some((r) => r.status === "rejected" && r.reason?.auth);
      failed.forEach((f) => { pending[f] = localFor(f); });   // re-queue so a failed push is never lost
      if (auth) { setSync(AUTH_MSG, true); clearTimeout(syncTimer); return; } // token is dead — stop hammering 401s until it's re-pasted
      setSync("Sync error — check token in Settings", true);
      clearTimeout(syncTimer); syncTimer = setTimeout(flushSync, 30000); // back off, then retry transient failures
    });
  }
  window.addEventListener("pagehide", () => { if (Object.keys(pending).length) flushSync(); });
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { if (Object.keys(pending).length) flushSync(); }
    else { refreshFromRemote(); }
  });
  window.addEventListener("focus", refreshFromRemote);

  function setSync(msg, isError) { const el = $("#syncline"); if (!el) return; el.textContent = msg; el.hidden = false; el.classList.toggle("error", !!isError); }
  // Pull remote state when the app regains focus, so a read on another device shows up
  // without a cold relaunch. Guarded so rapid focus/visibility events don't double-pull.
  let lastRemotePull = 0;
  async function refreshFromRemote() {
    if (!token() || !apiBase()) return;
    const t = Date.now(); if (t - lastRemotePull < 4000) return; lastRemotePull = t;
    try { const changed = await pullRemote(); setSync("Synced ✓"); if (changed) { sweepExpired(); renderTabs(); render(); } }
    catch (e) { setSync(e?.auth ? AUTH_MSG : "Sync error — check token in Settings", true); }
  }
  // Ask the browser to keep our storage so the saved token isn't evicted — the cause of
  // having to re-paste it. Best granted from a user gesture / installed PWA; safe to call often.
  async function requestPersistentStorage() {
    try {
      if (!navigator.storage || !navigator.storage.persist) return;
      if (await navigator.storage.persisted()) return;
      await navigator.storage.persist();
    } catch {}
  }

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
  const ICON_CORPUS = svgIco("M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z"); // bookmark
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
    $("#corpusToggle")?.addEventListener("click", () => setView("corpus"));
    $("#archiveToggle")?.addEventListener("click", () => setView("archive"));
    // Mobile bottom tab bar: HOME always returns to the feed; LIBRARY/STATS toggle.
    $("#navHome")?.addEventListener("click", () => { view = "reading"; render(); window.scrollTo(0, 0); });
    $("#navLibrary")?.addEventListener("click", () => setView("library"));
    $("#navStats")?.addEventListener("click", () => setView("stats"));
    $("#navDiscover")?.addEventListener("click", () => setView("discover"));
    $("#navCorpus")?.addEventListener("click", () => setView("corpus"));
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
