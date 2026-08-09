// Rank interests by how overdue they are, so scripts/pick-interest.mjs can choose today's research
// topic BEFORE any tokens are spent. Pure functions, no I/O — the CLI owns reading config.json,
// pool-digest.json, manifest.json, and reading-state.json and passes the plain data in.
//
// The scoring rule is the one skills/AUTHORING.md has always described (days_since_last_article /
// cadenceDays, highest wins) — this module is the first time it runs in code rather than being
// judged by the author each morning. A "current" interest (timely, expires) additionally needs a
// non-empty pool to report on: there is nothing to research if the pool is dry. "learn"/"both"
// interests are never blocked by a thin pool — a learn piece can be built from the knowledge graph
// and corpus alone, without a fresh feed item to react to.

const READ = "read";
const ARCHIVED = "archived";

/**
 * @param interests         config.json's ordered interests array ({ id, label, mode, cadenceDays })
 * @param digestInterests   pool-digest.json's `interests` map ({ [id]: { days_since_last_article, items } })
 * @param excludeId          an interest id to drop outright (e.g. yesterday's primary — never repeat it)
 * @returns [{ id, label, mode, cadenceDays, daysSince, score }] sorted most-overdue first (score may be Infinity)
 */
export function scoreInterests(interests = [], digestInterests = {}, { excludeId = null } = {}) {
  const ranked = [];
  for (const interest of interests) {
    if (!interest || interest.id === excludeId) continue;
    const digest = digestInterests[interest.id] || { days_since_last_article: null, items: [] };
    const items = digest.items || [];
    if (interest.mode === "current" && items.length === 0) continue;
    const daysSince = digest.days_since_last_article ?? null;
    const score = daysSince === null ? Infinity : daysSince / interest.cadenceDays;
    ranked.push({
      id: interest.id,
      label: interest.label,
      mode: interest.mode,
      cadenceDays: interest.cadenceDays,
      daysSince,
      score,
    });
  }

  // Array#sort is stable (ES2019+), so a comparator that returns 0 on a full tie preserves the
  // interests array's own order — exactly the "config-array order" tiebreak the spec asks for,
  // with no extra bookkeeping. `b.score - a.score` sorts Infinity first without producing NaN,
  // because the only way to subtract Infinity from Infinity is when both sides are equal, which
  // the `!==` guard already routes around.
  ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const ad = a.daysSince === null ? Infinity : a.daysSince;
    const bd = b.daysSince === null ? Infinity : b.daysSince;
    return bd - ad;
  });
  return ranked;
}

/**
 * The newest article's primary interest, by created_at (YYYY-MM-DD, so lexical compare is
 * chronological — same trick lib/backlog.mjs uses).
 * @param articles  manifest article records ({ id, interest, created_at })
 * @returns { interest, created_at } or null when there are none
 */
export function latestInterest(articles = []) {
  let latest = null;
  for (const a of articles) {
    if (!a || !a.created_at) continue;
    if (!latest || a.created_at > latest.created_at) latest = { interest: a.interest, created_at: a.created_at };
  }
  return latest;
}

/**
 * Recent read/feedback signal for one interest, for the research brief to steer its angle by.
 * Filters on the PRIMARY interest only — the same reasoning ingest.mjs's daysSinceLastArticle
 * comment gives: counting cross-tagged `interests[]` hits lets one tab's history leak into
 * another's, which is exactly the software-ai starvation bug that rule was written to avoid.
 * @param articles     manifest articles
 * @param state        reading-state.json content, or null when it hasn't been materialised
 * @param interestId   primary interest id to summarise
 * @param limit         newest N articles to include (default 8)
 */
export function feedbackSummary(articles = [], state, interestId, { limit = 8 } = {}) {
  const byNewest = (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""));
  return articles
    .filter((a) => a && a.interest === interestId)
    .sort(byNewest)
    .slice(0, limit)
    .map((a) => {
      const entry = state?.articles?.[a.id];
      const status = !state
        ? "unknown"
        : entry?.status === READ
        ? "read"
        : entry?.status === ARCHIVED
        ? "expired-unread"
        : "unread";
      const quiz = state?.quizzes?.[a.id];
      return {
        id: a.id,
        title: a.title,
        tags: a.tags || [],
        mode: a.mode,
        feedback: entry?.feedback === "up" || entry?.feedback === "down" ? entry.feedback : null,
        starred: !!entry?.starred,
        status,
        failed_quiz_concepts: quiz?.passed === false ? a.concepts_taught || [] : [],
      };
    });
}

/**
 * Re-join digest items against the full pool records.
 *
 * pool-digest.json deliberately carries only what the OLD single-step author needed (id, title,
 * trimmed excerpt, url, kind, source, topics) — which silently dropped **`transcript_at`**, the one
 * field that says whether a `kind:"video"` excerpt is a real transcript or just the channel's
 * marketing description. Both contracts hang a rule on that distinction ("without `transcript_at`
 * the excerpt is a lead, never the sole basis of a piece"), so the researcher has to be able to see
 * it. `date` comes along for the same reason: "dated facts" is a bar, and the item's own publication
 * date is how the researcher judges whether a lead is still news.
 *
 * @param digestItems  pool-digest.json items for one interest (already round-robin capped + trimmed)
 * @param poolItems    data/pool.json `items` (full records)
 */
export function enrichItems(digestItems = [], poolItems = []) {
  const byId = new Map();
  for (const it of poolItems) if (it && it.id) byId.set(it.id, it);
  return digestItems.filter(Boolean).map((d) => {
    const full = byId.get(d.id) || {};
    const publication = d.source || full.source || null;

    // NOT a slice: ingest.mjs stores whatever the feed emitted, and 135 of the 192 items in the
    // pool today are RFC-822 ("Thu, 06 Aug 2026 13:08:25 +0000"), which slices to "Thu, 06 Au" —
    // no year, no parseable day. ingest.mjs:465 already documents the mixed format and normalises
    // it with Date.parse; this is the same idiom.
    const parsed = full.published_at ? new Date(full.published_at) : null;
    const date = parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;

    // The pooled body IS the source for anything the researcher cannot fetch: YouTube transcripts
    // and Substack posts (both bot-walled for the whole runner IP range) and PDF-extracted policy
    // text. ingest.mjs trims the digest copy to 300 chars, which is plenty to CHOOSE an ordinary
    // RSS lead it will then fetch — but for these three the pool entry is the only text that will
    // ever exist, and both contracts tell the model to treat it as read text while forbidding the
    // fetch. Handing over a 300-char stub gets it quoted as if it were the whole opening.
    const unfetchable = !!(full.transcript_at || full.enriched_at || full.kind === "policy");
    const excerpt = unfetchable && (full.excerpt || "").length > (d.excerpt || "").length ? full.excerpt : d.excerpt;

    return {
      id: d.id,
      title: d.title,
      excerpt,
      url: d.url,
      ...(d.kind ? { kind: d.kind } : {}),
      ...(publication ? { publication } : {}),
      ...(date ? { date } : {}),
      ...(full.transcript_at ? { transcript_at: full.transcript_at } : {}),
      ...((d.topics || full.topics || []).length ? { topics: d.topics || full.topics } : {}),
    };
  });
}

/**
 * The whole day's research input, assembled deterministically BEFORE any tokens are spent:
 * which interest to serve, its candidate items, and how the reader reacted to that tab lately.
 *
 * Pure — the CLI owns all I/O and stamps the wall-clock. `score` is emitted as `null` rather than
 * Infinity for a never-served interest because `JSON.stringify(Infinity)` is `null` anyway; the
 * explicit `never_served: true` flag is what the brief should read.
 *
 * @param date        issue date (AEST, YYYY-MM-DD) — the CLI resolves it
 * @param pickCount   how many ranked interests to carry (2 = the pick plus one fallback)
 * @returns { version, date, excluded_yesterday, picks: [...] }
 */
export function buildDigestToday({
  interests = [],
  digestInterests = {},
  articles = [],
  state = null,
  poolItems = [],
  date = "",
  pickCount = 2,
} = {}) {
  const latest = latestInterest(articles);
  const excluded = latest?.interest || null;

  let ranked = scoreInterests(interests, digestInterests, { excludeId: excluded });
  // Fail OPEN, never quiet: with few interests (or a run where every `current` tab has a dry pool)
  // the "never repeat yesterday" rule can empty the ranking outright. Serving the same tab two days
  // running is a much smaller failure than shipping no issue, so drop the exclusion and re-rank.
  const repeatedYesterday = ranked.length === 0 && !!excluded;
  if (repeatedYesterday) ranked = scoreInterests(interests, digestInterests, {});

  const picks = ranked.slice(0, pickCount).map((r) => ({
    id: r.id,
    label: r.label,
    mode: r.mode,
    cadence_days: r.cadenceDays,
    days_since_last_article: r.daysSince,
    score: Number.isFinite(r.score) ? Math.round(r.score * 100) / 100 : null,
    ...(r.daysSince === null ? { never_served: true } : {}),
    items: enrichItems(digestInterests[r.id]?.items || [], poolItems),
    recent_feedback: feedbackSummary(articles, state, r.id),
  }));

  return {
    version: 1,
    date,
    excluded_yesterday: repeatedYesterday ? null : excluded,
    ...(repeatedYesterday ? { repeated_yesterday: excluded } : {}),
    picks,
  };
}
