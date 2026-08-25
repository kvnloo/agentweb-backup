// ENG-265: tests for the per-sender daily send-volume tracker and warmup ramp.
// Mirrors enrichSoQuota.test.ts's structure for InMemory + Dynamo(deps-injected).

import {
  SenderDailyLimitExceededError,
  InMemorySenderUsageTracker,
  DynamoSenderUsageTracker,
  effectiveDailyLimit,
  DEFAULT_POST_WARMUP_DAILY_LIMIT,
  senderUsageConfigId,
  type SenderUsageRow,
} from '../services/senderUsageTracker';

beforeEach(() => {
  jest.useRealTimers();
});

describe('InMemorySenderUsageTracker.checkQuota', () => {
  it('does not throw when sender is below its daily cap', async () => {
    const t = new InMemorySenderUsageTracker();
    await expect(t.checkQuota('u1', 's1', 5)).resolves.toBeUndefined();
  });

  it('throws SenderDailyLimitExceededError once the sender is at its cap', async () => {
    const t = new InMemorySenderUsageTracker();
    await t.recordSend('u1', 's1');
    await t.recordSend('u1', 's1');
    await expect(t.checkQuota('u1', 's1', 2)).rejects.toBeInstanceOf(SenderDailyLimitExceededError);
  });

  it('error carries the senderId and limit for a clear caller-facing message', async () => {
    const t = new InMemorySenderUsageTracker();
    await t.recordSend('u1', 's1');
    try {
      await t.checkQuota('u1', 's1', 1);
      throw new Error('expected to throw');
    } catch (err: any) {
      expect(err).toBeInstanceOf(SenderDailyLimitExceededError);
      expect(err.senderId).toBe('s1');
      expect(err.limit).toBe(1);
      expect(err.message).toMatch(/daily sending limit/);
    }
  });

  it('counters are tracked independently per sender', async () => {
    const t = new InMemorySenderUsageTracker();
    await t.recordSend('u1', 's1');
    await expect(t.checkQuota('u1', 's1', 1)).rejects.toBeInstanceOf(SenderDailyLimitExceededError);
    await expect(t.checkQuota('u1', 's2', 1)).resolves.toBeUndefined();
  });

  it('counters are tracked independently per user even for the same senderId', async () => {
    const t = new InMemorySenderUsageTracker();
    await t.recordSend('u1', 's1');
    await expect(t.checkQuota('u1', 's1', 1)).rejects.toBeInstanceOf(SenderDailyLimitExceededError);
    await expect(t.checkQuota('u2', 's1', 1)).resolves.toBeUndefined();
  });

  it('resets at the start of a new UTC day', async () => {
    const t = new InMemorySenderUsageTracker({ now: () => new Date('2026-05-04T23:59:00Z') });
    await t.recordSend('u1', 's1');
    await expect(t.checkQuota('u1', 's1', 1)).rejects.toBeInstanceOf(SenderDailyLimitExceededError);

    (t as any)._now = () => new Date('2026-05-05T00:01:00Z');
    await expect(t.checkQuota('u1', 's1', 1)).resolves.toBeUndefined();
  });

  it('a failed send that never calls recordSend does not consume quota', async () => {
    const t = new InMemorySenderUsageTracker();
    await t.checkQuota('u1', 's1', 1); // simulate provider call failing after the check
    await expect(t.checkQuota('u1', 's1', 1)).resolves.toBeUndefined();
    expect((await t.getUsage('u1', 's1')).sentCount).toBe(0);
  });
});

describe('InMemorySenderUsageTracker.getUsage', () => {
  it('returns a zeroed row for a sender with no recorded sends', async () => {
    const t = new InMemorySenderUsageTracker();
    const usage = await t.getUsage('u1', 's1');
    expect(usage.sentCount).toBe(0);
    expect(usage.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('accumulates across multiple recordSend calls', async () => {
    const t = new InMemorySenderUsageTracker();
    for (let i = 0; i < 4; i++) await t.recordSend('u1', 's1');
    expect((await t.getUsage('u1', 's1')).sentCount).toBe(4);
  });
});

describe('senderUsageConfigId', () => {
  it('namespaces the AW-Configs range key so it cannot collide with other config rows', () => {
    expect(senderUsageConfigId('sender-abc')).toBe('senderUsage:sender-abc');
  });
});

describe('DynamoSenderUsageTracker', () => {
  function makeTracker(opts: {
    initialRow?: SenderUsageRow | null;
    today?: string;
    incrementUsage?: jest.Mock;
  } = {}) {
    const today = opts.today ?? '2026-05-04';
    const incrementUsage = opts.incrementUsage ?? jest.fn().mockResolvedValue(undefined);
    const row = opts.initialRow ?? null;
    return {
      tracker: new DynamoSenderUsageTracker(
        {
          readUsage: jest.fn(async () => row),
          incrementUsage,
        },
        () => new Date(`${today}T12:00:00Z`),
      ),
      incrementUsage,
    };
  }

  it('returns zero when no row exists yet', async () => {
    const { tracker } = makeTracker({ initialRow: null });
    const usage = await tracker.getUsage('u1', 's1');
    expect(usage).toEqual({ date: '2026-05-04', sentCount: 0 });
  });

  it('treats a stale row (different date) as zero — quota does not carry over to a new day', async () => {
    const { tracker } = makeTracker({ initialRow: { date: '2026-05-03', sentCount: 40 } });
    await expect(tracker.checkQuota('u1', 's1', 5)).resolves.toBeUndefined();
  });

  it('throws when the same-day count is at the limit', async () => {
    const { tracker } = makeTracker({ initialRow: { date: '2026-05-04', sentCount: 5 } });
    await expect(tracker.checkQuota('u1', 's1', 5)).rejects.toBeInstanceOf(SenderDailyLimitExceededError);
  });

  it('delegates recordSend to incrementUsage with today\'s date', async () => {
    const incrementUsage = jest.fn().mockResolvedValue(undefined);
    const { tracker } = makeTracker({ incrementUsage });
    await tracker.recordSend('u1', 's1');
    expect(incrementUsage).toHaveBeenCalledWith('u1', 's1', '2026-05-04');
  });
});

describe('effectiveDailyLimit', () => {
  it('returns null (no cap) for a sender with neither dailyLimit nor warmupStartedAt', () => {
    expect(effectiveDailyLimit({})).toBeNull();
  });

  it('returns the flat dailyLimit for a sender not in warmup', () => {
    expect(effectiveDailyLimit({ dailyLimit: 200 })).toBe(200);
  });

  it('caps at 10/day for warmup days 1-3', () => {
    const start = '2026-05-01T00:00:00.000Z';
    expect(effectiveDailyLimit({ warmupStartedAt: start }, new Date('2026-05-01T12:00:00Z'))).toBe(10);
    expect(effectiveDailyLimit({ warmupStartedAt: start }, new Date('2026-05-03T12:00:00Z'))).toBe(10);
  });

  it('caps at 20/day for warmup days 4-7', () => {
    const start = '2026-05-01T00:00:00.000Z';
    expect(effectiveDailyLimit({ warmupStartedAt: start }, new Date('2026-05-04T12:00:00Z'))).toBe(20);
    expect(effectiveDailyLimit({ warmupStartedAt: start }, new Date('2026-05-07T12:00:00Z'))).toBe(20);
  });

  it('caps at 35/day for warmup days 8-14', () => {
    const start = '2026-05-01T00:00:00.000Z';
    expect(effectiveDailyLimit({ warmupStartedAt: start }, new Date('2026-05-08T12:00:00Z'))).toBe(35);
    expect(effectiveDailyLimit({ warmupStartedAt: start }, new Date('2026-05-14T12:00:00Z'))).toBe(35);
  });

  it('falls back to the sender dailyLimit (or 50 default) once warmup completes on day 15+', () => {
    const start = '2026-05-01T00:00:00.000Z';
    expect(effectiveDailyLimit({ warmupStartedAt: start }, new Date('2026-05-15T12:00:00Z'))).toBe(DEFAULT_POST_WARMUP_DAILY_LIMIT);
    expect(effectiveDailyLimit({ warmupStartedAt: start, dailyLimit: 150 }, new Date('2026-05-15T12:00:00Z'))).toBe(150);
  });

  it('clamps a warmupStartedAt in the future to day 1 rather than a negative/zero day', () => {
    const start = '2026-06-01T00:00:00.000Z';
    expect(effectiveDailyLimit({ warmupStartedAt: start }, new Date('2026-05-01T12:00:00Z'))).toBe(10);
  });
});
