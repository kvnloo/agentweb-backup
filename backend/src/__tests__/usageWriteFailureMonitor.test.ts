/**
 * ENG-702 AC3 and AC6.
 *
 *   AC3 — a write that cannot be persisted is retried and, if it still cannot
 *         be persisted, is SURFACED rather than silently discarded.
 *   AC6 — a sustained write-failure window raises ONE alert, not one per
 *         dropped record.
 */
import {
  ALERT_WINDOW_MS,
  DroppedWriteWindow,
  flushDroppedWriteAlerts,
  getDroppedWriteTotals,
  isTransientWriteError,
  recordDroppedWrite,
  resetDroppedWriteState,
  retryTransientWrite,
  setDroppedWriteAlertSink,
} from '../services/usageWriteFailureMonitor';

const err = (code: string) => Object.assign(new Error(code), { code });
const noSleep = async () => {};

describe('isTransientWriteError', () => {
  it.each([
    'ProvisionedThroughputExceededException',
    'ThrottlingException',
    'TransactionConflictException',
    'InternalServerError',
    'NetworkingError',
    'ECONNRESET',
  ])('treats %s as transient', (code) => {
    expect(isTransientWriteError(err(code))).toBe(true);
  });

  it.each([
    'ValidationException',
    'ConditionalCheckFailedException',
    'ResourceNotFoundException',
    'AccessDeniedException',
  ])('treats %s as permanent — retrying it only delays the alert', (code) => {
    expect(isTransientWriteError(err(code))).toBe(false);
  });

  it('treats an error with no code as permanent', () => {
    expect(isTransientWriteError(new Error('mystery'))).toBe(false);
  });
});

describe('retryTransientWrite (AC3)', () => {
  it('returns the first success without retrying', async () => {
    const write = jest.fn().mockResolvedValue('ok');

    await expect(retryTransientWrite(write, { sleep: noSleep })).resolves.toBe('ok');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and succeeds', async () => {
    const write = jest
      .fn()
      .mockRejectedValueOnce(err('ThrottlingException'))
      .mockResolvedValue('ok');

    await expect(retryTransientWrite(write, { sleep: noSleep })).resolves.toBe('ok');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('gives up after the bounded number of attempts', async () => {
    const write = jest.fn().mockRejectedValue(err('ThrottlingException'));

    await expect(retryTransientWrite(write, { sleep: noSleep })).rejects.toThrow('ThrottlingException');
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a permanent failure', async () => {
    // Retrying a ValidationException is just a slower failure, and it delays
    // the alert that says spend is going unrecorded.
    const write = jest.fn().mockRejectedValue(err('ValidationException'));

    await expect(retryTransientWrite(write, { sleep: noSleep })).rejects.toThrow('ValidationException');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially between attempts', async () => {
    const waits: number[] = [];
    const write = jest.fn().mockRejectedValue(err('ThrottlingException'));

    await expect(
      retryTransientWrite(write, { baseDelayMs: 50, sleep: async (ms) => void waits.push(ms) }),
    ).rejects.toBeDefined();

    expect(waits).toEqual([50, 100]);
  });
});

describe('recordDroppedWrite (AC3 + AC6)', () => {
  let alerts: DroppedWriteWindow[];

  beforeEach(() => {
    resetDroppedWriteState();
    alerts = [];
    setDroppedWriteAlertSink((summary) => alerts.push(summary));
  });

  it('raises ONE alert for a burst inside a single window, not one per record', async () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 1000; i++) {
      recordDroppedWrite(
        { provider: 'you.com', operation: 'query', costMicroUsd: 12500, billingUserId: 'owner-1', reason: 'throttled' },
        t0 + i,
      );
    }

    // Nothing emitted yet — the window is still open.
    expect(alerts).toHaveLength(0);

    // One later drop closes it, and the single alert carries all 1000.
    recordDroppedWrite(
      { provider: 'you.com', operation: 'query', costMicroUsd: 12500, billingUserId: 'owner-1', reason: 'throttled' },
      t0 + ALERT_WINDOW_MS + 1,
    );

    expect(alerts).toHaveLength(1);
    expect(alerts[0].count).toBe(1000);
  });

  it('reports how much spend stopped being recorded — the counter the row said was missing', () => {
    const t0 = 2_000_000;
    recordDroppedWrite({ provider: 'v0', operation: 'chat_create', costMicroUsd: 2_000_000, billingUserId: 'o', reason: 'x' }, t0);
    recordDroppedWrite({ provider: 'you.com', operation: 'query', costMicroUsd: 12_500, billingUserId: 'o', reason: 'x' }, t0 + 1);

    flushDroppedWriteAlerts(t0 + ALERT_WINDOW_MS + 1);

    expect(alerts[0].lostMicroUsd).toBe(2_012_500);
    expect(alerts[0].byProvider).toEqual({ v0: 1, 'you.com': 1 });
  });

  it('keeps a cumulative total across windows', () => {
    const t0 = 3_000_000;
    recordDroppedWrite({ provider: 'p', operation: 'o', costMicroUsd: 100, billingUserId: 'o', reason: 'x' }, t0);
    recordDroppedWrite({ provider: 'p', operation: 'o', costMicroUsd: 200, billingUserId: 'o', reason: 'x' }, t0 + ALERT_WINDOW_MS + 1);

    expect(getDroppedWriteTotals()).toEqual({ count: 2, lostMicroUsd: 300 });
  });

  it('starts a fresh window after one closes', () => {
    const t0 = 4_000_000;
    recordDroppedWrite({ provider: 'p', operation: 'o', costMicroUsd: 100, billingUserId: 'o', reason: 'first' }, t0);
    recordDroppedWrite({ provider: 'p', operation: 'o', costMicroUsd: 200, billingUserId: 'o', reason: 'second' }, t0 + ALERT_WINDOW_MS + 1);
    flushDroppedWriteAlerts(t0 + 2 * ALERT_WINDOW_MS + 2);

    expect(alerts).toHaveLength(2);
    expect(alerts[0].count).toBe(1);
    expect(alerts[1].count).toBe(1);
    expect(alerts[1].lostMicroUsd).toBe(200);
  });

  describe('flushDroppedWriteAlerts', () => {
    it('emits the final window, which nothing else would ever report', () => {
      // recordDroppedWrite only flushes when a LATER drop arrives. When the
      // failures stop — exactly when someone starts investigating — the last
      // and often largest batch would otherwise sit unemitted forever.
      const t0 = 5_000_000;
      recordDroppedWrite({ provider: 'p', operation: 'o', costMicroUsd: 999, billingUserId: 'o', reason: 'x' }, t0);

      expect(alerts).toHaveLength(0);
      flushDroppedWriteAlerts(t0 + ALERT_WINDOW_MS + 1);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].lostMicroUsd).toBe(999);
    });

    it('does not emit a window that is still open', () => {
      const t0 = 6_000_000;
      recordDroppedWrite({ provider: 'p', operation: 'o', costMicroUsd: 1, billingUserId: 'o', reason: 'x' }, t0);

      flushDroppedWriteAlerts(t0 + 1);

      expect(alerts).toHaveLength(0);
    });

    it('is a no-op with nothing pending', () => {
      flushDroppedWriteAlerts(9_000_000);
      expect(alerts).toHaveLength(0);
    });
  });
});
