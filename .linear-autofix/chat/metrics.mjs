// chat/metrics.mjs — pure queue/health metrics behind GET /api/metrics. Like watchDecision, the math is a
// dependency-free function so it's unit-testable (test/metrics.test.mjs); the server just loads state,
// gathers the watch-bearing entries, and stamps the HTTP response. `now` is epoch ms (same convention as
// watchDecision, which compares against watch.until/nextAt).
//
// __meta is the poller's per-cycle health record ({lastPollAt, eligibleCount}) — NOT a tracked issue. It
// carries no `identifier`, so trackedEntries here (and every issue count in poll/gc/server) skips it.

const IN_PROGRESS = new Set(['started', 'recovered']); // a pipeline run is actively working the issue
const isCompletedFix = (o) => typeof o === 'string' && o.startsWith('fixed'); // fixed / fixed_needs_human / …
const ageMin = (at, now) => { const t = Date.parse(at); return Number.isNaN(t) ? null : Math.max(0, Math.round((now - t) / 60000)); };

export function computeMetrics(state, watches, config, now = Date.now()) {
  const entries = Object.entries(state || {})
    .filter(([k, e]) => k !== '__meta' && e && e.identifier)
    .map(([, e]) => e);
  const meta = (state && state.__meta) || {};

  const open = entries.length;                          // WIP = every tracked issue in the list (poll's cap counter)
  const cap = Math.max(0, config?.maxOpenBugs ?? 15);
  const wipSaturation = cap > 0 ? open / cap : null;    // null rather than divide-by-zero when the cap is 0

  // Oldest still-running item, in whole minutes since its record was stamped (null when nothing is running).
  let oldestInProgressAgeMin = null;
  for (const e of entries) {
    if (!IN_PROGRESS.has(e.outcome)) continue;
    const a = ageMin(e.at, now);
    if (a != null && (oldestInProgressAgeMin == null || a > oldestInProgressAgeMin)) oldestInProgressAgeMin = a;
  }

  // Most recently completed fix (outcome "fixed*"), by its `at` timestamp. ISO strings sort chronologically.
  let lastCompletedFix = null;
  for (const e of entries) {
    if (!isCompletedFix(e.outcome) || !e.at) continue;
    if (!lastCompletedFix || String(e.at) > String(lastCompletedFix.at)) lastCompletedFix = { identifier: e.identifier, at: e.at };
  }

  // Active (un-expired) background watches. `watches` is the caller's list of watch-bearing entries; an
  // entry whose watch.until has passed is treated as expired (mirrors watchDecision's 'expired').
  const activeWatches = (watches || [])
    .filter((e) => e && e.identifier && e.watch && (e.watch.until == null || now < e.watch.until))
    .map((e) => ({ identifier: e.identifier, reason: e.watch.goal ?? null, until: e.watch.until ?? null }));

  return {
    eligibleCount: meta.eligibleCount ?? null,
    open,
    cap,
    wipSaturation,
    oldestInProgressAgeMin,
    lastPollAt: meta.lastPollAt ?? null,
    lastCompletedFix,
    activeWatches,
  };
}
