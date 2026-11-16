import {
  createBatch,
  unitIdempotencyKey,
  nextRunnable,
  markRunning,
  markSucceeded,
  markFailed,
  cancelBatch,
  submitUnitResult,
  isTerminal,
  backoffMs,
  DEFAULT_POLICY,
  MediaBatch,
} from '../mediaBatchStateMachine';

const T0 = 1_000_000;
const policy = { maxAttempts: 3, baseBackoffMs: 1000, maxBackoffMs: 5000, leaseMs: 60_000 };

function fourImageBatch(): MediaBatch {
  return createBatch('batch-1', [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }, { prompt: 'd' }], policy);
}

describe('mediaBatchStateMachine', () => {
  it('AC1: 3 succeeded + 1 interrupted past lease -> only the unfinished unit is runnable', () => {
    let b = fourImageBatch();
    for (const i of [0, 1, 2]) {
      b = markRunning(b, i, T0);
      b = markSucceeded(b, i, T0 + 10, { assetId: `asset-${i}` });
    }
    b = markRunning(b, 3, T0);
    // within lease: nothing runnable
    expect(nextRunnable(b, T0 + 1000)).toEqual([]);
    // past lease: only unit 3
    const runnable = nextRunnable(b, T0 + policy.leaseMs + 1);
    expect(runnable.map((u) => u.index)).toEqual([3]);
    expect(isTerminal(b)).toBe(false);
  });

  it('succeeded units are never re-run', () => {
    let b = fourImageBatch();
    b = markRunning(b, 0, T0);
    b = markSucceeded(b, 0, T0, { assetId: 'x' });
    expect(() => markRunning(b, 0, T0 + 1)).toThrow();
    expect(nextRunnable(b, T0 + 10 ** 9).map((u) => u.index)).toEqual([1, 2, 3]);
  });

  it('AC2: retries retryable failures with capped exponential backoff and attempt budget', () => {
    let b = createBatch('b2', [{ prompt: 'x' }], policy);
    b = markRunning(b, 0, T0);
    b = markFailed(b, 0, T0, { retryable: true, reason: 'timeout' });
    expect(b.units[0].state).toBe('failed_retryable');
    expect(nextRunnable(b, T0 + 999)).toEqual([]);
    expect(nextRunnable(b, T0 + 1000).length).toBe(1);

    b = markRunning(b, 0, T0 + 1000);
    b = markFailed(b, 0, T0 + 1000, { retryable: true, reason: 'timeout' });
    expect(nextRunnable(b, T0 + 1000 + 1999)).toEqual([]);
    expect(nextRunnable(b, T0 + 1000 + 2000).length).toBe(1);

    b = markRunning(b, 0, T0 + 3000);
    b = markFailed(b, 0, T0 + 3000, { retryable: true, reason: 'timeout' });
    // budget of 3 attempts exhausted -> terminal
    expect(b.units[0].state).toBe('failed_terminal');
    expect(nextRunnable(b, T0 + 10 ** 9)).toEqual([]);
    expect(isTerminal(b)).toBe(true);
  });

  it('backoff is capped', () => {
    expect(backoffMs(1, policy)).toBe(1000);
    expect(backoffMs(2, policy)).toBe(2000);
    expect(backoffMs(3, policy)).toBe(4000);
    expect(backoffMs(10, policy)).toBe(5000);
  });

  it('non-retryable provider failure is terminal and distinct from cancellation', () => {
    let b = createBatch('b3', [{ prompt: 'x' }, { prompt: 'y' }], policy);
    b = markRunning(b, 0, T0);
    b = markFailed(b, 0, T0, { retryable: false, reason: 'content_policy' });
    expect(b.units[0].state).toBe('failed_terminal');
    expect(b.units[0].lastError).toBe('content_policy');
    b = cancelBatch(b, T0);
    expect(b.units[0].state).toBe('failed_terminal');
    expect(b.units[1].state).toBe('cancelled');
    expect(isTerminal(b)).toBe(true);
  });

  it('interrupted run past lease counts the attempt toward the budget', () => {
    let b = createBatch('b4', [{ prompt: 'x' }], { ...policy, maxAttempts: 1 });
    b = markRunning(b, 0, T0);
    expect(nextRunnable(b, T0 + policy.leaseMs + 1)).toEqual([]);
    expect(isTerminal(b, T0 + policy.leaseMs + 1)).toBe(true);
  });

  it('AC3: idempotency key is deterministic and input-sensitive', () => {
    const k1 = unitIdempotencyKey('batch-1', 0, { prompt: 'a', size: '1024' });
    const k2 = unitIdempotencyKey('batch-1', 0, { size: '1024', prompt: 'a' });
    expect(k1).toBe(k2);
    expect(unitIdempotencyKey('batch-1', 1, { prompt: 'a', size: '1024' })).not.toBe(k1);
    expect(unitIdempotencyKey('batch-2', 0, { prompt: 'a', size: '1024' })).not.toBe(k1);
    expect(unitIdempotencyKey('batch-1', 0, { prompt: 'b', size: '1024' })).not.toBe(k1);
    expect(fourImageBatch().units[2].key).toBe(fourImageBatch().units[2].key);
  });

  it('AC3: re-submitting a completed key is a no-op', () => {
    let b = fourImageBatch();
    const key = b.units[1].key;
    b = markRunning(b, 1, T0);
    const r1 = submitUnitResult(b, key, T0, { ok: true, assetId: 'first' });
    expect(r1.applied).toBe(true);
    const r2 = submitUnitResult(r1.batch, key, T0 + 5, { ok: true, assetId: 'second' });
    expect(r2.applied).toBe(false);
    expect(r2.batch).toBe(r1.batch);
    expect(r2.batch.units[1].assetId).toBe('first');
    const r3 = submitUnitResult(r1.batch, 'unknown-key', T0, { ok: true, assetId: 'z' });
    expect(r3.applied).toBe(false);
  });

  it('batch completes when all units succeed', () => {
    let b = fourImageBatch();
    for (const i of [0, 1, 2, 3]) {
      b = markRunning(b, i, T0);
      b = markSucceeded(b, i, T0, { assetId: `a${i}` });
    }
    expect(isTerminal(b)).toBe(true);
    expect(nextRunnable(b, T0)).toEqual([]);
  });

  it('is pure: transitions do not mutate the input batch', () => {
    const b = fourImageBatch();
    const snapshot = JSON.stringify(b);
    markRunning(b, 0, T0);
    expect(JSON.stringify(b)).toBe(snapshot);
    expect(DEFAULT_POLICY.maxAttempts).toBeGreaterThan(0);
  });
});
