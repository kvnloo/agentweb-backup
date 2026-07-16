/**
 * ENG-324: scheduled runs must be registered with the graceful-shutdown drain
 * registry.
 *
 * Root cause of the "scheduled run produced no assistant response" failures:
 * the cron poll dispatched each `runScheduledChat(...)` fire-and-forget and never
 * registered it with `cronJobRegistry`. On deploy/SIGTERM, `gracefulShutdown`
 * drained the LLM worker and the cron registry, then called `process.exit(0)` —
 * but the untracked scheduled run was still in-flight, so the main process died
 * before `runScheduledChat`'s catch could persist a run result, requeue, or emit
 * the job-incomplete message. The session was left with only the system prompt +
 * kickoff message (messageCount=2), null tokens/cost, and no run result at all.
 *
 * `trackScheduledRun` is the seam the fix wires into every dispatch site so the
 * drain waits for the whole run — including its requeue/persist catch — to finish.
 */

import { CronJobRegistry } from '../utils/cronJobRegistry';

// Isolate a fresh registry per test rather than the shared singleton so parallel
// suites can't leak in-flight jobs into these assertions.
function makeDeferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('trackScheduledRun (ENG-324)', () => {
  it('registers an in-flight scheduled run under the ScheduledChat job name', () => {
    const registry = new CronJobRegistry();
    const { trackScheduledRun, SCHEDULED_RUN_JOB_NAME } = require('../utils/scheduledRunTracker');

    const deferred = makeDeferred();
    trackScheduledRun(deferred.promise, registry);

    expect(registry.size()).toBe(1);
    expect(registry.snapshot()).toEqual({ [SCHEDULED_RUN_JOB_NAME]: 1 });

    deferred.resolve();
  });

  it('returns the same promise untouched (drop-in wrap)', async () => {
    const registry = new CronJobRegistry();
    const { trackScheduledRun } = require('../utils/scheduledRunTracker');

    const deferred = makeDeferred<string>();
    const tracked = trackScheduledRun(deferred.promise, registry);
    expect(tracked).toBe(deferred.promise);

    deferred.resolve('done');
    await expect(tracked).resolves.toBe('done');
  });

  it('keeps drain() blocked until the tracked run completes its requeue', async () => {
    const registry = new CronJobRegistry();
    const { trackScheduledRun } = require('../utils/scheduledRunTracker');

    // Model the real dispatch: runScheduledChat resolves, THEN a catch/finally
    // does the requeue + persist. The whole chain is what must be drained.
    let requeued = false;
    const inner = makeDeferred();
    const run = inner.promise.then(async () => {
      // Simulate the async requeue/persist that happens after the LLM call.
      await Promise.resolve();
      requeued = true;
    });
    trackScheduledRun(run, registry);

    let drainResolved = false;
    const drain = registry.drain(5000, 10).then((result) => {
      drainResolved = true;
      return result;
    });

    // While the run is in-flight, the drain must NOT resolve — this is exactly
    // what was missing before: an untracked run left drain() empty, so
    // process.exit() cut the run off mid-flight.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(drainResolved).toBe(false);
    expect(requeued).toBe(false);

    // Let the run finish; the drain must then observe the requeue completed.
    inner.resolve();
    const result = await drain;
    expect(requeued).toBe(true);
    expect(result.drained).toBe(true);
    expect(registry.size()).toBe(0);
  });

  it('reports the run in the drain snapshot when the ceiling is hit', async () => {
    const registry = new CronJobRegistry();
    const { trackScheduledRun, SCHEDULED_RUN_JOB_NAME } = require('../utils/scheduledRunTracker');

    const deferred = makeDeferred();
    trackScheduledRun(deferred.promise, registry);

    const result = await registry.drain(20, 5);
    expect(result.drained).toBe(false);
    expect(result.stuckCount).toBe(1);
    expect(result.stuckJobs).toEqual({ [SCHEDULED_RUN_JOB_NAME]: 1 });

    deferred.resolve();
  });

  it('cleans up tracking even when the run rejects', async () => {
    const registry = new CronJobRegistry();
    const { trackScheduledRun } = require('../utils/scheduledRunTracker');

    const deferred = makeDeferred();
    const tracked = trackScheduledRun(deferred.promise, registry);
    expect(registry.size()).toBe(1);

    deferred.reject(new Error('boom'));
    await expect(tracked).rejects.toThrow('boom');
    // cleanup runs on rejection too, so the registry doesn't leak.
    expect(registry.size()).toBe(0);
  });

  it('defaults to the shared cronJobRegistry singleton when none is passed', () => {
    const { trackScheduledRun } = require('../utils/scheduledRunTracker');
    const { cronJobRegistry } = require('../utils/cronJobRegistry');

    const before = cronJobRegistry.size();
    const deferred = makeDeferred();
    trackScheduledRun(deferred.promise);
    expect(cronJobRegistry.size()).toBe(before + 1);

    deferred.resolve();
  });
});
