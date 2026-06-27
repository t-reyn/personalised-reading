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
  let viewArchive = false;
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

  async function boot() {
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
    if (activeTab !== "all") arts = arts.filter((a) => a.interest === activeTab);
    if (query) {
      const q = query.toLowerCase();
      arts = arts.filter((a) => (a.title + " " + a.summary + " " + (a.tags || []).join(" ")).toLowerCase().includes(q));
    }
    return arts;
  }

  function statusOf(id) { return state.articles[id]?.status || "backlog"; }
  function isRead(id) { return statusOf(id) === "read"; }

  function renderTabs() {
    const tabs = $("#tabs");
    const counts = {};
    manifest.articles.forEach((a) => { if (!a.merged_into && !isRead(a.id)) counts[a.interest] = (counts[a.interest] || 0) + 1; });
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    const mk = (id, label, emoji, n) =>
      `<button class="tab" role="tab" data-tab="${esc(id)}" aria-selected="${activeTab === id}">${emoji ? esc(emoji) + " " : ""}${esc(label)}${n ? ` <span class="count">${n}</span>` : ""}</button>`;
    tabs.innerHTML = mk("all", "All", "", total) + INTERESTS.map((i) => mk(i.id, i.label, i.emoji, counts[i.id] || 0)).join("");
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

  function cardHtml(a, inArchive) {
    const it = INTEREST_BY_ID[a.interest] || {};
    const read = isRead(a.id);
    const star = state.articles[a.id]?.starred;
    const age = ageLabel(a);
    const merged = (a.merged_from || []).length;
    return `<article class="card${read || inArchive ? " read" : ""}" style="--accent:${esc(it.accent || "#4f7cac")}" data-id="${esc(a.id)}" tabindex="0" role="button">
      ${inArchive
        ? `<button class="restore" data-restore="${esc(a.id)}" aria-label="Restore" title="Restore to your list">↩</button>`
        : `<button class="star${star ? " on" : ""}" data-star="${esc(a.id)}" aria-label="${star ? "Unstar" : "Star"}" title="Keep / star">${star ? "★" : "☆"}</button>`}
      <div class="card-eyebrow"><span class="emoji">${esc(it.emoji || "")}</span>${esc(it.label || a.interest)}<span class="age${age.aging ? " aging" : ""}">${esc(age.txt)}</span></div>
      <h3>${esc(a.title)}</h3>
      <p>${esc(a.summary)}</p>
      <div class="card-foot">
        ${(a.tags || []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
        ${read ? `<span class="readtick">✓ read</span>` : ""}
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
    if (rc) rc.textContent = (query && !viewArchive) ? `${active.length} result${active.length === 1 ? "" : "s"} for “${query}”` : "";

    if (viewArchive) {
      list.innerHTML = `<h2 class="shelf-title">Archive · outdated or set aside</h2>` +
        (archived.length
          ? `<div class="shelf-grid">${archived.sort(byNew).map((a) => cardHtml(a, true)).join("")}</div>`
          : `<div class="empty"><p>Nothing archived yet. Unread items move here once they pass their freshness date (star one to keep it forever).</p></div>`);
      bindCards(list);
      updateArchiveToggle();
      return;
    }

    if (!active.length) {
      list.innerHTML = `<div class="empty"><div class="big">📭</div><p>${query ? "No articles match your search." : "Nothing here yet. New reading is written each morning."}</p></div>`;
      updateArchiveToggle();
      return;
    }
    const buckets = { normal: [], review: [], blocked: [], read: [] };
    active.forEach((a) => { if (isRead(a.id)) buckets.read.push(a); else buckets[category(a)].push(a); });
    const shelf = (title, items) => items.length ? `<h2 class="shelf-title">${title}</h2><div class="shelf-grid">${items.sort(byNew).map((a) => cardHtml(a)).join("")}</div>` : "";
    list.innerHTML =
      shelf("To read", buckets.normal) +
      shelf("Worth a review", buckets.review) +
      shelf("Locked until you learn the basics", buckets.blocked) +
      shelf("Read", buckets.read);
    bindCards(list);
    updateArchiveToggle();
  }

  function updateArchiveToggle() {
    const b = $("#archiveToggle"); if (!b) return;
    const n = manifest.articles.filter((a) => !a.merged_into && statusOf(a.id) === "archived").length;
    if (viewArchive) { b.hidden = false; b.textContent = "← Back to reading"; }
    else if (n > 0) { b.hidden = false; b.textContent = `🗄 Archive (${n})`; }
    else { b.hidden = true; }
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
      if (passed) { c.is_learnt = true; c.learnt_at = now(); c.review_level = 3; c.next_review_at = null; }
      else { c.is_learnt = false; c.review_level = Math.max(1, c.review_level || 0); c.next_review_at = new Date(Date.now() + 3 * 86400000).toISOString(); }
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
    const ov = $("#reader");
    ov.innerHTML = `
      <div class="ov-bar"><button class="close" aria-label="Close">✕</button><span class="ov-title">${esc(a.title)}</span></div>
      <div class="ov-body"><iframe class="reader-frame" title="${esc(a.title)}" src="${esc(BASE + a.path)}" sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe></div>
      <div class="ov-actions">
        ${isRead(id) ? `<button class="btn" data-act="unread">Mark unread</button>` : `<button class="btn primary" data-act="read">Mark as read</button>`}
        ${hasQuiz ? `<button class="btn good" data-act="quiz">Test me</button>` : ""}
      </div>`;
    show(ov);
    ov.querySelector(".close").onclick = () => hide(ov);
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
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("pr:theme", t); } catch {}
    const b = $("#themeBtn"); if (b) b.textContent = t === "dark" ? "☀" : "☾";
  }
  function isStandalone() {
    return matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }
  function initInstallPrompt() {
    if (isStandalone()) return;
    try { if (localStorage.getItem("pr:install-dismissed")) return; } catch {}
    let deferred = null;
    window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; });
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    setTimeout(() => {
      if (isStandalone() || document.querySelector(".install-bar")) return;
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
    if (tb) { tb.textContent = currentTheme() === "dark" ? "☀" : "☾"; tb.addEventListener("click", () => applyTheme(currentTheme() === "dark" ? "light" : "dark")); }
    $("#archiveToggle")?.addEventListener("click", () => { viewArchive = !viewArchive; render(); window.scrollTo(0, 0); });
    const s = $("#search");
    s.addEventListener("input", () => { query = s.value.trim(); writeHashState(); render(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelectorAll(".overlay:not([hidden])").forEach(hide); });
    document.addEventListener("keydown", onShortcutKey);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register(BASE + "sw.js").catch(() => {});
  }
  // Keyboard: / focuses search, j/k (or arrows) move a roving selection through cards, o opens.
  // Enter is intentionally NOT handled here — cards bind their own Enter (avoids a double-open).
  function onShortcutKey(e) {
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
  function readHashState() {
    const h = new URLSearchParams((location.hash || "").replace(/^#/, ""));
    const t = h.get("t");
    if (t && (t === "all" || INTERESTS.some((i) => i.id === t))) activeTab = t;
    const q = h.get("q");
    if (q) { query = q; const s = $("#search"); if (s) s.value = q; }
  }
  function writeHashState() {
    const p = new URLSearchParams();
    if (activeTab && activeTab !== "all") p.set("t", activeTab);
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
