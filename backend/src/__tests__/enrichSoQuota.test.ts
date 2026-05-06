// Tests for enrichSoQuota — per-user daily quota tracker.

import {
  QuotaExceededError,
  LookupByEmailQuotaExceededError,
  InMemoryQuotaTracker,
  DynamoQuotaTracker,
  DEFAULT_DAILY_LIMITS,
  DEFAULT_LOOKUP_BY_EMAIL_DAILY_LIMIT,
  type UsageRow,
} from '../services/enrichSoQuota';
import type { EnrichSoEndpoint } from '../services/enrichSoCacheKeys';

beforeEach(() => {
  jest.useRealTimers();
});

describe('InMemoryQuotaTracker.checkQuota', () => {
  it('does not throw when user is below the daily cap', async () => {
    const t = new InMemoryQuotaTracker();
    await expect(t.checkQuota('u1', 'validate')).resolves.toBeUndefined();
  });

  it('throws QuotaExceededError when user has hit the daily cap for that endpoint', async () => {
    const t = new InMemoryQuotaTracker({ limits: { validate: 2, find: 2, reverse: 2 } });
    await t.recordUsage('u1', 'validate');
    await t.recordUsage('u1', 'validate');
    await expect(t.checkQuota('u1', 'validate')).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('error names the endpoint and limit so the caller can surface a clear message', async () => {
    const t = new InMemoryQuotaTracker({ limits: { validate: 1, find: 1, reverse: 1 } });
    await t.recordUsage('u1', 'find');
    try {
      await t.checkQuota('u1', 'find');
      throw new Error('expected to throw');
    } catch (err: any) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      expect(err.endpoint).toBe('find');
      expect(err.limit).toBe(1);
      expect(err.message).toMatch(/find/);
      expect(err.message).toMatch(/1/);
    }
  });

  it('counters are tracked independently per endpoint', async () => {
    const t = new InMemoryQuotaTracker({ limits: { validate: 1, find: 1, reverse: 1 } });
    await t.recordUsage('u1', 'validate');
    // validate is at limit; find is still 0
    await expect(t.checkQuota('u1', 'validate')).rejects.toBeInstanceOf(QuotaExceededError);
    await expect(t.checkQuota('u1', 'find')).resolves.toBeUndefined();
  });

  it('counters are tracked independently per user', async () => {
    const t = new InMemoryQuotaTracker({ limits: { validate: 1, find: 1, reverse: 1 } });
    await t.recordUsage('u1', 'validate');
    await expect(t.checkQuota('u1', 'validate')).rejects.toBeInstanceOf(QuotaExceededError);
    await expect(t.checkQuota('u2', 'validate')).resolves.toBeUndefined();
  });

  it('resets at the start of a new day', async () => {
    const t = new InMemoryQuotaTracker({
      limits: { validate: 1, find: 1, reverse: 1 },
      now: () => new Date('2026-05-04T23:59:00Z'),
    });
    await t.recordUsage('u1', 'validate');
    await expect(t.checkQuota('u1', 'validate')).rejects.toBeInstanceOf(QuotaExceededError);

    // Advance to next day
    (t as any)._now = () => new Date('2026-05-05T00:01:00Z');
    await expect(t.checkQuota('u1', 'validate')).resolves.toBeUndefined();
  });
});

describe('InMemoryQuotaTracker.recordUsage', () => {
  it('increments the counter for the right endpoint', async () => {
    const t = new InMemoryQuotaTracker();
    await t.recordUsage('u1', 'reverse');
    const usage = await t.getUsage('u1');
    expect(usage.reverseCount).toBe(1);
    expect(usage.validateCount).toBe(0);
    expect(usage.findCount).toBe(0);
  });

  it('multiple recordUsage calls accumulate', async () => {
    const t = new InMemoryQuotaTracker();
    for (let i = 0; i < 5; i++) await t.recordUsage('u1', 'validate');
    expect((await t.getUsage('u1')).validateCount).toBe(5);
  });
});

describe('InMemoryQuotaTracker.getUsage', () => {
  it('returns zeroed usage for a user with no recorded calls', async () => {
    const t = new InMemoryQuotaTracker();
    const usage = await t.getUsage('u1');
    expect(usage.validateCount).toBe(0);
    expect(usage.findCount).toBe(0);
    expect(usage.reverseCount).toBe(0);
    expect(usage.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('DEFAULT_DAILY_LIMITS', () => {
  it('defaults to 1000 per endpoint per day', () => {
    expect(DEFAULT_DAILY_LIMITS.validate).toBe(1000);
    expect(DEFAULT_DAILY_LIMITS.find).toBe(1000);
    expect(DEFAULT_DAILY_LIMITS.reverse).toBe(1000);
  });
  it('lookup-by-email defaults to 50/day (much tighter than reverse — abuse gate)', () => {
    expect(DEFAULT_LOOKUP_BY_EMAIL_DAILY_LIMIT).toBe(50);
  });
});

// ─── lookup-by-email quota (C4) ───────────────────────────────────────────────

describe('InMemoryQuotaTracker.checkLookupByEmailQuota', () => {
  it('uses a separate counter from reverseCount', async () => {
    const t = new InMemoryQuotaTracker({ lookupByEmailLimit: 2 });
    await t.recordLookupByEmailUsage('u1');
    await t.recordLookupByEmailUsage('u1');
    await expect(t.checkLookupByEmailQuota('u1')).rejects.toBeInstanceOf(LookupByEmailQuotaExceededError);
    // reverse counter is unaffected
    expect((await t.getUsage('u1')).reverseCount).toBe(0);
  });

  it('error includes the configured limit', async () => {
    const t = new InMemoryQuotaTracker({ lookupByEmailLimit: 5 });
    for (let i = 0; i < 5; i++) await t.recordLookupByEmailUsage('u1');
    try {
      await t.checkLookupByEmailQuota('u1');
      throw new Error('expected to throw');
    } catch (err: any) {
      expect(err).toBeInstanceOf(LookupByEmailQuotaExceededError);
      expect(err.limit).toBe(5);
    }
  });

  it('resets at the start of a new day independently', async () => {
    const t = new InMemoryQuotaTracker({
      lookupByEmailLimit: 1,
      now: () => new Date('2026-05-04T23:59:00Z'),
    });
    await t.recordLookupByEmailUsage('u1');
    await expect(t.checkLookupByEmailQuota('u1')).rejects.toBeInstanceOf(LookupByEmailQuotaExceededError);
    (t as any)._now = () => new Date('2026-05-05T00:01:00Z');
    await expect(t.checkLookupByEmailQuota('u1')).resolves.toBeUndefined();
  });
});

// ─── DynamoQuotaTracker (C3 — day-boundary race) ──────────────────────────────

describe('DynamoQuotaTracker', () => {
  function makeTracker(opts: {
    initialRow?: UsageRow | null;
    today?: string;
    incrementUsage?: jest.Mock;
    incrementLookupByEmail?: jest.Mock;
  } = {}) {
    const today = opts.today ?? '2026-05-04';
    const incrementUsage = opts.incrementUsage ?? jest.fn().mockResolvedValue(undefined);
    const incrementLookupByEmail = opts.incrementLookupByEmail ?? jest.fn().mockResolvedValue(undefined);
    let row: UsageRow | null = opts.initialRow ?? null;
    return {
      tracker: new DynamoQuotaTracker(
        {
          readUsage: jest.fn(async () => row),
          writeUsage: jest.fn(async (_u, r) => { row = r; }),
          incrementUsage,
          incrementLookupByEmail,
        },
        { ...DEFAULT_DAILY_LIMITS, validate: 5, find: 5, reverse: 5 },
        2,  // tight lookup limit so tests are fast
        () => new Date(`${today}T12:00:00Z`),
      ),
      incrementUsage,
      incrementLookupByEmail,
    };
  }

  it('returns zero counters when no row exists', async () => {
    const { tracker } = makeTracker({ initialRow: null });
    const usage = await tracker.getUsage('u1');
    expect(usage).toEqual({ date: '2026-05-04', validateCount: 0, findCount: 0, reverseCount: 0, lookupByEmailCount: 0 });
  });

  it('treats stale row (different date) as zero — quota does not carry over', async () => {
    const { tracker } = makeTracker({
      initialRow: { date: '2026-05-03', validateCount: 5, findCount: 5, reverseCount: 5, lookupByEmailCount: 5 },
    });
    await expect(tracker.checkQuota('u1', 'validate' as EnrichSoEndpoint)).resolves.toBeUndefined();
    await expect(tracker.checkLookupByEmailQuota('u1')).resolves.toBeUndefined();
  });

  it('throws QuotaExceededError when same-day count is at limit', async () => {
    const { tracker } = makeTracker({
      initialRow: { date: '2026-05-04', validateCount: 5, findCount: 0, reverseCount: 0, lookupByEmailCount: 0 },
    });
    await expect(tracker.checkQuota('u1', 'validate' as EnrichSoEndpoint))
      .rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('delegates recordUsage to incrementUsage with today date', async () => {
    const incrementUsage = jest.fn().mockResolvedValue(undefined);
    const { tracker } = makeTracker({ incrementUsage });
    await tracker.recordUsage('u1', 'find' as EnrichSoEndpoint);
    expect(incrementUsage).toHaveBeenCalledWith('u1', 'find', '2026-05-04');
  });

  it('delegates recordLookupByEmailUsage to its own incrementer', async () => {
    const incrementLookupByEmail = jest.fn().mockResolvedValue(undefined);
    const { tracker } = makeTracker({ incrementLookupByEmail });
    await tracker.recordLookupByEmailUsage('u1');
    expect(incrementLookupByEmail).toHaveBeenCalledWith('u1', '2026-05-04');
  });

  it('lookup quota uses its own limit (passed via constructor)', async () => {
    const { tracker } = makeTracker({
      initialRow: { date: '2026-05-04', validateCount: 0, findCount: 0, reverseCount: 0, lookupByEmailCount: 2 },
    });
    await expect(tracker.checkLookupByEmailQuota('u1')).rejects.toBeInstanceOf(LookupByEmailQuotaExceededError);
  });
});
