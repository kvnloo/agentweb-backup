/**
 * ENG-926 §F — scheduling a daily job so that it survives constant redeploys.
 *
 * `setInterval(24h)` does not work in this environment, and the reason is not obvious:
 * PRs merge every one to two hours, each merge redeploys the backend, and the process
 * restarts. A 24-hour interval NEVER elapses, because the process never lives that long.
 * Every long-interval cron in `server.ts` is therefore really "runs on boot" — which also
 * means its in-memory state (dedupe maps, counters) resets every couple of hours.
 *
 * Anchoring to a wall-clock time fixes it. Each boot re-arms a timer for the SAME target,
 * so restarts are free: only the process alive at the target fires, and it fires exactly
 * once per day however many times we deploy. `activationAnalysisCron` already does this;
 * this helper makes the arithmetic reusable and testable rather than re-derived per cron.
 */

/** Milliseconds from `now` until the next occurrence of `hourUtc`:00 UTC.
 *
 *  Always strictly positive: when called exactly at the target, it schedules tomorrow
 *  rather than returning 0 and firing immediately in a tight loop. */
export function msUntilNextUtcHour(hourUtc: number, now: Date = new Date()): number {
  const next = new Date(now.getTime());
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}
