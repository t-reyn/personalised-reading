// Decide whether the reader is keeping up, so generate.yml can skip a run instead of
// writing into a backlog nobody is clearing.
//
// Deliberately a ROLLING WINDOW over the most recent issues, not a count of the whole
// unread pile. On 2026-08-09 the lifetime pile was 37 unread against 22 read — a rule of
// "skip if 3+ unread anywhere" would have paused the product permanently and never
// resumed. The window asks a recoverable question instead: "of the last N issues, how
// many are still unread?" Read a couple and publishing restarts on its own.

const READ = "read";

/** Articles are dated YYYY-MM-DD, so lexical compare is chronological. */
const byNewest = (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""));

/**
 * @param articles  manifest article records ({ id, created_at, expire_at })
 * @param state     reading-state `articles` map ({ [id]: { status, archived_at } })
 * @param window    how many recent issues to judge (default 5)
 * @param today     YYYY-MM-DD; issues dated later are ignored (clock skew on the runner)
 * @returns { window, considered, unread, unreadIds }
 */
export function unreadInWindow(articles = [], state = {}, { window = 5, today = "9999-12-31" } = {}) {
  const recent = articles
    .filter((a) => a && a.created_at && a.created_at <= today)
    .sort(byNewest)
    .slice(0, window);

  const unreadIds = recent
    .filter((a) => {
      const s = state[a.id];
      if (!s) return true; // never touched
      if (s.status === READ) return false;
      // Auto-archived (expired unread) still counts as not-read: it is backlog the reader
      // never got to, which is exactly the signal we want to slow down on.
      return true;
    })
    .map((a) => a.id);

  return { window, considered: recent.length, unread: unreadIds.length, unreadIds };
}

/**
 * @returns { skip, reason, ...unreadInWindow() }
 */
export function backlogDecision(articles, state, { window = 5, threshold = 3, today } = {}) {
  const r = unreadInWindow(articles, state, { window, today });
  // Don't gate before there is a window to judge — a fresh install must be able to publish.
  if (r.considered < window) {
    return { ...r, skip: false, reason: `only ${r.considered} issue(s) published — below the ${window}-issue window` };
  }
  const skip = r.unread >= threshold;
  return {
    ...r,
    skip,
    reason: skip
      ? `${r.unread} of the last ${window} issues unread (threshold ${threshold}) — pausing until some are read`
      : `${r.unread} of the last ${window} issues unread (threshold ${threshold}) — keeping up`,
  };
}
