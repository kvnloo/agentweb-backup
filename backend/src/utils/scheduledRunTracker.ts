/**
 * ENG-324: register in-flight scheduled runs with the graceful-shutdown drain
 * registry.
 *
 * Scheduled chats are dispatched fire-and-forget from the cron poll (the run
 * promise is never awaited by the request handler). Without tracking, a
 * deploy/SIGTERM would run `gracefulShutdown` — which drains the LLM worker and
 * `cronJobRegistry`, then calls `process.exit(0)` — while the scheduled run was
 * still in-flight. The main process died before `runScheduledChat`'s catch could
 * persist a run result, requeue the schedule, or emit the job-incomplete message,
 * leaving the session with only the system prompt + kickoff message
 * (messageCount=2), null tokens/cost, and no run result at all.
 *
 * Wrapping the dispatch in `trackScheduledRun` puts the run into the same drain
 * that `gracefulShutdown` already awaits, so a deploy waits for the run — and its
 * requeue/persist catch — to finish (up to the drain ceiling) instead of
 * abandoning it mid-flight.
 */

import { cronJobRegistry, CronJobRegistry } from './cronJobRegistry';

/** Job name scheduled runs are tracked under (shows up in the drain snapshot). */
export const SCHEDULED_RUN_JOB_NAME = 'ScheduledChat';

/**
 * Register a fire-and-forget scheduled-run promise with the graceful-shutdown
 * drain registry. Returns the same promise untouched, so it's a drop-in wrap
 * around the existing dispatch with no change to resolution timing or value.
 *
 * @param run       the scheduled-run promise (typically the full
 *                  `runScheduledChat(...).then(...).catch(...)` chain)
 * @param registry  registry to track against; defaults to the shared singleton
 *                  that `gracefulShutdown` drains. Injectable for tests.
 */
export function trackScheduledRun<T>(
  run: Promise<T>,
  registry: CronJobRegistry = cronJobRegistry
): Promise<T> {
  return registry.track(SCHEDULED_RUN_JOB_NAME, run);
}
