/**
 * Generic in-flight tracker for recurring background jobs (LinkedIn sync,
 * drip worker, meta token refresh, loop attribution, etc.).
 *
 * isCronEnabled()/disableCron() (instanceState.ts) stop a job from starting
 * its NEXT run. This registry covers the other half: if a job is already
 * running when gracefulShutdown() begins, drain() waits for it to finish
 * (up to a ceiling) instead of letting process.exit() cut it off blind.
 *
 * Unlike generateMarketingResponseWorkerService's pendingRequests drain,
 * nothing external awaits these job promises, so there is no force-settle —
 * drain() only waits and reports what's still stuck at the ceiling.
 */

import { DRAIN_CEILING_MS, DRAIN_POLL_INTERVAL_MS } from './shutdownConstants';

export interface CronDrainResult {
  drained: boolean;
  stuckCount: number;
  stuckJobs: Record<string, number>;
}

export class CronJobRegistry {
  private inFlight: Map<string, string> = new Map();
  private counter = 0;

  /**
   * Register a running job invocation. Returns the same promise, untouched,
   * so call sites are a drop-in wrap with no change to resolution timing,
   * value, or rejection.
   */
  track<T>(jobName: string, promise: Promise<T>): Promise<T> {
    const runId = `${jobName}_${++this.counter}_${Date.now()}`;
    this.inFlight.set(runId, jobName);

    const cleanup = () => {
      this.inFlight.delete(runId);
    };
    promise.then(cleanup, cleanup);

    return promise;
  }

  size(): number {
    return this.inFlight.size;
  }

  snapshot(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const jobName of this.inFlight.values()) {
      counts[jobName] = (counts[jobName] || 0) + 1;
    }
    return counts;
  }

  async drain(
    ceilingMs: number = DRAIN_CEILING_MS,
    pollIntervalMs: number = DRAIN_POLL_INTERVAL_MS
  ): Promise<CronDrainResult> {
    const deadline = Date.now() + ceilingMs;

    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    if (this.inFlight.size > 0) {
      return { drained: false, stuckCount: this.inFlight.size, stuckJobs: this.snapshot() };
    }

    return { drained: true, stuckCount: 0, stuckJobs: {} };
  }
}

export const cronJobRegistry = new CronJobRegistry();
