/**
 * Tests for cronJobRegistry — the generic in-flight job tracker used by
 * gracefulShutdown() to drain recurring background jobs (LinkedIn sync,
 * drip worker, meta token refresh, etc.), the same way
 * generateMarketingResponseWorkerService drains LLM-generation requests.
 */

import { CronJobRegistry } from '../utils/cronJobRegistry';

describe('CronJobRegistry', () => {
  let registry: CronJobRegistry;

  beforeEach(() => {
    registry = new CronJobRegistry();
  });

  it('drains immediately when nothing is tracked', async () => {
    const start = Date.now();
    const result = await registry.drain(100, 20);
    const elapsed = Date.now() - start;

    expect(result).toEqual({ drained: true, stuckCount: 0, stuckJobs: {} });
    expect(elapsed).toBeLessThan(50);
  });

  it('uses the shared shutdown-constant defaults when called with no arguments', async () => {
    // Nothing tracked, so this resolves on the first size check without
    // ever sleeping for the real 10-minute default ceiling.
    const start = Date.now();
    const result = await registry.drain();
    const elapsed = Date.now() - start;

    expect(result).toEqual({ drained: true, stuckCount: 0, stuckJobs: {} });
    expect(elapsed).toBeLessThan(50);
  });

  it('waits for a tracked promise to settle before resolving, without waiting for the ceiling', async () => {
    let resolveJob: () => void;
    const jobPromise = new Promise<void>((resolve) => {
      resolveJob = resolve;
    });
    registry.track('testJob', jobPromise);

    let drained = false;
    const drainPromise = registry.drain(5000, 20).then((result) => {
      drained = true;
      return result;
    });

    // Give the drain loop a couple of poll ticks — it must still be waiting.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(drained).toBe(false);
    expect(registry.size()).toBe(1);

    resolveJob!();
    const result = await drainPromise;

    expect(drained).toBe(true);
    expect(result.drained).toBe(true);
    expect(result.stuckCount).toBe(0);
  });

  it('reports stuck jobs and returns drained:false when the ceiling is hit', async () => {
    const neverSettles = new Promise<void>(() => {});
    registry.track('stuckJob', neverSettles);

    const start = Date.now();
    const result = await registry.drain(100, 20);
    const elapsed = Date.now() - start;

    expect(result.drained).toBe(false);
    expect(result.stuckCount).toBe(1);
    expect(result.stuckJobs).toEqual({ stuckJob: 1 });
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(500);
  });

  it('cleans up tracking on rejection and propagates the original rejection unaltered', async () => {
    const failure = new Error('job blew up');
    let rejectJob: (err: Error) => void;
    const jobPromise = new Promise<void>((_resolve, reject) => {
      rejectJob = reject;
    });

    const tracked = registry.track('failingJob', jobPromise);
    // Attach a rejection handler immediately so Node doesn't flag this as
    // an unhandled rejection while we assert on registry state.
    const trackedAssertion = expect(tracked).rejects.toBe(failure);

    expect(registry.size()).toBe(1);
    rejectJob!(failure);

    await trackedAssertion;
    expect(registry.size()).toBe(0);
  });

  it('buckets stuck-job counts per job name', async () => {
    const settled = Promise.resolve();
    const stuckA = new Promise<void>(() => {});
    const stuckB = new Promise<void>(() => {});

    registry.track('jobA', settled);
    registry.track('jobB', stuckA);
    registry.track('jobB', stuckB);

    // Let the settled promise's cleanup run before draining.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await registry.drain(80, 20);

    expect(result.drained).toBe(false);
    expect(result.stuckCount).toBe(2);
    expect(result.stuckJobs).toEqual({ jobB: 2 });
  });
});
