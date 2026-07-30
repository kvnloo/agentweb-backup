/**
 * Tests for usageAnalyticsService (admin shadow-usage read models).
 */

jest.mock('../services/usageRecordDb', () => ({
  usageRecordDb: {
    queryByUserDateRange: jest.fn(),
    scanByDateRange: jest.fn(),
  },
  // Real semantics: a per-unit vendor row has BOTH provider and unit.
  isVendorEntry: (r: any) => !!(r && r.provider && r.unit),
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

const mockGetAccountById = jest.fn();
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountById: (...a: any[]) => mockGetAccountById(...a),
}));

import { usageRecordDb } from '../services/usageRecordDb';
import { userDb } from '../services/db';
import {
  getUserUsageByModelDay,
  getUsageComparison,
  getCostAggregation,
  getXAllocatedTotals,
  getXCostByActingUser,
  currentXBillingCycle,
  getUserXBreakdown,
} from '../services/usageAnalyticsService';

const mockQuery = usageRecordDb.queryByUserDateRange as jest.Mock;
const mockScan = usageRecordDb.scanByDateRange as jest.Mock;
const mockGetUser = userDb.getUserById as jest.Mock;
beforeEach(() => mockGetAccountById.mockReset());

const row = (overrides: any = {}) => ({
  userId: 'user-1',
  sk: '2026-06-02#gpt-5-chat-2#agent-chat',
  date: '2026-06-02',
  model: 'gpt-5-chat-2',
  feature: 'agent-chat',
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 1100,
  costMicroUsd: 3500,
  callCount: 3,
  billingUserId: 'user-1',
  updatedAt: '2026-06-02T01:00:00.000Z',
  ttl: 1780000000,
  ...overrides,
});

describe('usageAnalyticsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue([]);
    mockScan.mockResolvedValue([]);
    mockGetUser.mockResolvedValue(null);
  });

  describe('getUserUsageByModelDay', () => {
    it('rejects malformed dates', async () => {
      await expect(getUserUsageByModelDay('u', 'June 1', '2026-06-30')).rejects.toThrow(
        'YYYY-MM-DD'
      );
      await expect(getUserUsageByModelDay('u', '2026-06-01', '06-30-2026')).rejects.toThrow(
        'YYYY-MM-DD'
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects an inverted range', async () => {
      await expect(getUserUsageByModelDay('u', '2026-06-30', '2026-06-01')).rejects.toThrow(
        'start must be <= end'
      );
    });

    it('returns sorted rows with USD conversion and aggregate totals', async () => {
      mockQuery.mockResolvedValue([
        row({ date: '2026-06-03', sk: '2026-06-03#gpt-5-chat-2#agent-chat', costMicroUsd: 1_000_000 }),
        row(),
        row({
          model: 'anthropic.claude-sonnet-4-6',
          sk: '2026-06-02#anthropic.claude-sonnet-4-6#emma',
          feature: 'emma',
          costMicroUsd: 500_000,
          callCount: 1,
        }),
      ]);

      const result = await getUserUsageByModelDay('user-1', '2026-06-01', '2026-06-30');

      expect(mockQuery).toHaveBeenCalledWith('user-1', '2026-06-01', '2026-06-30');
      expect(result.rows.map((r) => `${r.date}|${r.model}`)).toEqual([
        '2026-06-02|anthropic.claude-sonnet-4-6',
        '2026-06-02|gpt-5-chat-2',
        '2026-06-03|gpt-5-chat-2',
      ]);
      expect(result.rows[2].costUsd).toBe(1);
      expect(result.totals.totalTokens).toBe(3300);
      expect(result.totals.callCount).toBe(7);
      expect(result.totals.costMicroUsd).toBe(1_000_000 + 3500 + 500_000);
    });

    it('computes total cost exactly in micro USD', async () => {
      mockQuery.mockResolvedValue([
        row({ costMicroUsd: 1_000_000 }),
        row({ costMicroUsd: 500_000 }),
      ]);
      const result = await getUserUsageByModelDay('user-1', '2026-06-01', '2026-06-30');
      expect(result.totals.costMicroUsd).toBe(1_500_000);
      expect(result.totals.costUsd).toBe(1.5);
    });

    it('returns empty rows and zero totals for a user with no usage', async () => {
      const result = await getUserUsageByModelDay('user-1', '2026-06-01', '2026-06-30');
      expect(result.rows).toEqual([]);
      expect(result.totals).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        callCount: 0,
        costMicroUsd: 0,
        costUsd: 0,
      });
    });

    it('fills missing numeric fields with 0 in toRow', async () => {
      // A row where only date/model/feature/costMicroUsd are set; every other
      // numeric field is undefined. Exercises the `item.X || 0` fallbacks.
      mockQuery.mockResolvedValue([
        {
          userId: 'user-1',
          sk: '2026-06-05#gpt-5-chat-2#agent-chat',
          date: '2026-06-05',
          model: 'gpt-5-chat-2',
          feature: 'agent-chat',
          inputTokens: undefined,
          outputTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
          totalTokens: undefined,
          callCount: undefined,
          costMicroUsd: 2_000_000,
        },
      ]);

      const result = await getUserUsageByModelDay('user-1', '2026-06-01', '2026-06-30');

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toEqual({
        date: '2026-06-05',
        model: 'gpt-5-chat-2',
        feature: 'agent-chat',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        callCount: 0,
        costMicroUsd: 2_000_000,
        costUsd: 2,
      });
    });

    it('treats a missing costMicroUsd as 0 in toRow', async () => {
      // Exercises the `costMicroUsd || 0` fallback (line 54).
      mockQuery.mockResolvedValue([
        {
          userId: 'user-1',
          sk: '2026-06-06#gpt-5-chat-2#agent-chat',
          date: '2026-06-06',
          model: 'gpt-5-chat-2',
          feature: 'agent-chat',
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 15,
          callCount: 1,
          costMicroUsd: undefined,
        },
      ]);

      const result = await getUserUsageByModelDay('user-1', '2026-06-01', '2026-06-30');

      expect(result.rows[0].costMicroUsd).toBe(0);
      expect(result.rows[0].costUsd).toBe(0);
      expect(result.rows[0].totalTokens).toBe(15);
    });
  });

  describe('getUsageComparison', () => {
    it('rejects malformed months', async () => {
      await expect(getUsageComparison('u', '2026-6')).rejects.toThrow('YYYY-MM');
      await expect(getUsageComparison('u', 'June 2026')).rejects.toThrow('YYYY-MM');
    });

    it('compares shadow totals against the current-month legacy counter', async () => {
      mockQuery.mockResolvedValue([
        row({ totalTokens: 1100, costMicroUsd: 3500 }),
        row({ totalTokens: 900, costMicroUsd: 1500 }),
      ]);
      mockGetUser.mockResolvedValue({
        userId: 'user-1',
        tokenUsage: { month: '2026-06', totalTokens: 1800, totalCost: 0.004, resetDate: 'x' },
      });

      const result = await getUsageComparison('user-1', '2026-06');

      expect(mockQuery).toHaveBeenCalledWith('user-1', '2026-06-01', '2026-06-31');
      expect(result.shadow).toEqual({ totalTokens: 2000, costUsd: 0.005, callCount: 6 });
      expect(result.legacy).toEqual({ totalTokens: 1800, costUsd: 0.004, source: 'current' });
      expect(result.delta.totalTokens).toBe(200);
      expect(result.delta.costUsd).toBeCloseTo(0.001, 10);
    });

    it('falls back to tokenUsageHistory for past months', async () => {
      mockGetUser.mockResolvedValue({
        userId: 'user-1',
        tokenUsage: { month: '2026-06', totalTokens: 50, totalCost: 0.1, resetDate: 'x' },
        tokenUsageHistory: [
          { month: '2026-04', totalTokens: 10, totalCost: 0.01 },
          { month: '2026-05', totalTokens: 4000, totalCost: 0.02 },
        ],
      });

      const result = await getUsageComparison('user-1', '2026-05');
      expect(result.legacy).toEqual({ totalTokens: 4000, costUsd: 0.02, source: 'history' });
    });

    it('reports legacy source "none" for unknown users or untracked months', async () => {
      const result = await getUsageComparison('user-1', '2026-01');
      expect(result.legacy).toEqual({ totalTokens: 0, costUsd: 0, source: 'none' });
      expect(result.shadow).toEqual({ totalTokens: 0, costUsd: 0, callCount: 0 });
    });

    it('treats missing shadow item fields as 0 in the monthly reduce', async () => {
      // A shadow record missing totalTokens/costMicroUsd/callCount — exercises
      // the `item.X || 0` fallbacks in the shadow reduce (lines 133-135).
      mockQuery.mockResolvedValue([
        {
          userId: 'user-1',
          sk: '2026-06-02#gpt-5-chat-2#agent-chat',
          date: '2026-06-02',
          model: 'gpt-5-chat-2',
          feature: 'agent-chat',
          totalTokens: undefined,
          costMicroUsd: undefined,
          callCount: undefined,
        },
        row({ totalTokens: 700, costMicroUsd: 2000, callCount: 2 }),
      ]);
      mockGetUser.mockResolvedValue(null);

      const result = await getUsageComparison('user-1', '2026-06');

      // The undefined-field record contributes 0 to each accumulator.
      expect(result.shadow).toEqual({ totalTokens: 700, costUsd: 0.002, callCount: 2 });
      expect(result.legacy.source).toBe('none');
    });

    it('treats missing current-month legacy fields as 0', async () => {
      // tokenUsage.month matches but totalTokens/totalCost are undefined —
      // exercises the `|| 0` fallbacks in the current branch (lines 146-147).
      mockGetUser.mockResolvedValue({
        userId: 'user-1',
        tokenUsage: { month: '2026-06', totalTokens: undefined, totalCost: undefined, resetDate: 'x' },
      });

      const result = await getUsageComparison('user-1', '2026-06');

      expect(result.legacy).toEqual({ totalTokens: 0, costUsd: 0, source: 'current' });
    });

    it('treats missing history legacy fields as 0', async () => {
      // A matching tokenUsageHistory entry with undefined totalTokens/totalCost —
      // exercises the `|| 0` fallbacks in the history branch (lines 156-157).
      mockGetUser.mockResolvedValue({
        userId: 'user-1',
        tokenUsage: { month: '2026-06', totalTokens: 50, totalCost: 0.1, resetDate: 'x' },
        tokenUsageHistory: [
          { month: '2026-05', totalTokens: undefined, totalCost: undefined },
        ],
      });

      const result = await getUsageComparison('user-1', '2026-05');

      expect(result.legacy).toEqual({ totalTokens: 0, costUsd: 0, source: 'history' });
    });
  });

  // ENG-366 — admin cost aggregation (backend slice of ENG-353).
  // Test → contract mapping (ENG-353 behavioral contract, HUMAN-WRITTEN):
  //   assertion 2 (by-model totals = sum of underlying per-user stored costs, no
  //     second pricing table) → 'aggregates by model…' + 'sums stored costMicroUsd…'
  //   assertion 3 (window filtering) → 'passes the window through to the scan'
  //   assertion 4, API half (empty window → explicit zeros, never NaN) →
  //     'returns an explicit zero payload…'
  describe('getCostAggregation', () => {
    const aggRow = (overrides: any = {}) => ({
      userId: 'user-1',
      sk: '2026-06-02#gpt-5-chat-2#agent-chat',
      date: '2026-06-02',
      model: 'gpt-5-chat-2',
      feature: 'agent-chat',
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1100,
      costMicroUsd: 3500,
      callCount: 3,
      billingUserId: 'user-1',
      updatedAt: '2026-06-02T01:00:00.000Z',
      ttl: 1780000000,
      ...overrides,
    });

    it('rejects a malformed start date without scanning', async () => {
      await expect(getCostAggregation('June 1', '2026-06-30')).rejects.toThrow('YYYY-MM-DD');
      expect(mockScan).not.toHaveBeenCalled();
    });

    it('rejects a malformed end date without scanning', async () => {
      await expect(getCostAggregation('2026-06-01', '06-30-2026')).rejects.toThrow('YYYY-MM-DD');
      expect(mockScan).not.toHaveBeenCalled();
    });

    it('rejects an inverted range without scanning', async () => {
      await expect(getCostAggregation('2026-06-30', '2026-06-01')).rejects.toThrow(
        'start must be <= end'
      );
      expect(mockScan).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range topUsersLimit', async () => {
      await expect(getCostAggregation('2026-06-01', '2026-06-30', 0)).rejects.toThrow(
        'topUsersLimit'
      );
      await expect(getCostAggregation('2026-06-01', '2026-06-30', 101)).rejects.toThrow(
        'topUsersLimit'
      );
      expect(mockScan).not.toHaveBeenCalled();
    });

    it('passes the window through to the scan (assertion 3: filtering is the data layer bound)', async () => {
      await getCostAggregation('2026-06-01', '2026-06-30');
      expect(mockScan).toHaveBeenCalledTimes(1);
      expect(mockScan).toHaveBeenCalledWith('2026-06-01', '2026-06-30');
    });

    it('aggregates by model: totals equal the sum of underlying per-user stored costs (assertion 2)', async () => {
      mockScan.mockResolvedValue([
        aggRow({ userId: 'user-1', costMicroUsd: 3_500_000, callCount: 3 }),
        aggRow({
          userId: 'user-2',
          sk: '2026-06-03#gpt-5-chat-2#emma',
          date: '2026-06-03',
          feature: 'emma',
          costMicroUsd: 1_500_000,
          inputTokens: 400,
          outputTokens: 40,
          totalTokens: 440,
          callCount: 1,
        }),
        aggRow({
          userId: 'user-1',
          sk: '2026-06-02#anthropic.claude-opus-4-8#agent-chat',
          model: 'anthropic.claude-opus-4-8',
          costMicroUsd: 10_000_000,
          callCount: 2,
        }),
      ]);

      const result = await getCostAggregation('2026-06-01', '2026-06-30');

      // Sorted by cost desc.
      expect(result.byModel.map((m) => m.model)).toEqual([
        'anthropic.claude-opus-4-8',
        'gpt-5-chat-2',
      ]);
      const gpt = result.byModel[1];
      expect(gpt.costMicroUsd).toBe(5_000_000); // 3.5M (user-1) + 1.5M (user-2)
      expect(gpt.costUsd).toBe(5);
      expect(gpt.callCount).toBe(4);
      expect(gpt.inputTokens).toBe(1400);
      const opus = result.byModel[0];
      expect(opus.costMicroUsd).toBe(10_000_000);
      expect(opus.costUsd).toBe(10);

      // Overall totals are the sum over every row.
      expect(result.totals.costMicroUsd).toBe(15_000_000);
      expect(result.totals.costUsd).toBe(15);
      expect(result.totals.callCount).toBe(6);
    });

    it('sums stored costMicroUsd only — tolerates rows with missing counters (no re-pricing)', async () => {
      mockScan.mockResolvedValue([
        aggRow({
          costMicroUsd: undefined,
          inputTokens: undefined,
          outputTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
          totalTokens: undefined,
          callCount: undefined,
        }),
      ]);

      const result = await getCostAggregation('2026-06-01', '2026-06-30');

      expect(result.totals.costMicroUsd).toBe(0);
      expect(result.totals.costUsd).toBe(0);
      expect(Number.isNaN(result.totals.costUsd)).toBe(false);
      expect(result.byModel[0].costUsd).toBe(0);
    });

    it('builds the by-day series sorted by date then model', async () => {
      mockScan.mockResolvedValue([
        aggRow({
          sk: '2026-06-03#gpt-5-chat-2#agent-chat',
          date: '2026-06-03',
          costMicroUsd: 2_000_000,
        }),
        aggRow({ costMicroUsd: 1_000_000 }), // 2026-06-02, gpt-5-chat-2
        aggRow({
          userId: 'user-2',
          sk: '2026-06-02#gpt-5-chat-2#emma',
          feature: 'emma',
          costMicroUsd: 500_000,
        }),
        aggRow({
          sk: '2026-06-02#anthropic.claude-opus-4-8#agent-chat',
          model: 'anthropic.claude-opus-4-8',
          costMicroUsd: 4_000_000,
        }),
      ]);

      const result = await getCostAggregation('2026-06-01', '2026-06-30');

      expect(
        result.series.map((s) => [s.date, s.model, s.costMicroUsd])
      ).toEqual([
        ['2026-06-02', 'anthropic.claude-opus-4-8', 4_000_000],
        ['2026-06-02', 'gpt-5-chat-2', 1_500_000], // user-1 + user-2 merged per (date, model)
        ['2026-06-03', 'gpt-5-chat-2', 2_000_000],
      ]);
      expect(result.series[1].costUsd).toBe(1.5);
    });

    it('aggregates the secondary feature cut from the stored feature dimension', async () => {
      mockScan.mockResolvedValue([
        aggRow({ costMicroUsd: 1_000_000 }), // agent-chat
        aggRow({
          userId: 'user-2',
          sk: '2026-06-02#gpt-5-chat-2#emma',
          feature: 'emma',
          costMicroUsd: 3_000_000,
        }),
      ]);

      const result = await getCostAggregation('2026-06-01', '2026-06-30');

      expect(result.byFeature.map((f) => [f.feature, f.costMicroUsd])).toEqual([
        ['emma', 3_000_000],
        ['agent-chat', 1_000_000],
      ]);
    });

    it('ranks top users by spend with a per-model breakdown, enriched with email', async () => {
      mockScan.mockResolvedValue([
        aggRow({ userId: 'user-1', costMicroUsd: 1_000_000 }),
        aggRow({
          userId: 'user-1',
          sk: '2026-06-02#anthropic.claude-opus-4-8#agent-chat',
          model: 'anthropic.claude-opus-4-8',
          costMicroUsd: 6_000_000,
        }),
        aggRow({
          userId: 'user-2',
          sk: '2026-06-02#gpt-5-chat-2#emma',
          feature: 'emma',
          costMicroUsd: 2_000_000,
        }),
      ]);
      mockGetUser.mockImplementation(async (id: string) =>
        id === 'user-1' ? { userId: 'user-1', email: 'one@example.com' } : null
      );

      const result = await getCostAggregation('2026-06-01', '2026-06-30');

      expect(result.topUsers).toHaveLength(2);
      expect(result.topUsers[0].userId).toBe('user-1');
      expect(result.topUsers[0].costMicroUsd).toBe(7_000_000);
      expect(result.topUsers[0].email).toBe('one@example.com');
      expect(result.topUsers[0].byModel.map((m) => m.model)).toEqual([
        'anthropic.claude-opus-4-8',
        'gpt-5-chat-2',
      ]);
      expect(result.topUsers[1].userId).toBe('user-2');
      expect(result.topUsers[1].email).toBeNull();
    });

    it('limits top users to topUsersLimit and only enriches the returned ones', async () => {
      mockScan.mockResolvedValue([
        aggRow({ userId: 'user-1', costMicroUsd: 1_000_000 }),
        aggRow({
          userId: 'user-2',
          sk: '2026-06-02#gpt-5-chat-2#emma',
          feature: 'emma',
          costMicroUsd: 3_000_000,
        }),
        aggRow({
          userId: 'user-3',
          sk: '2026-06-02#gpt-5-chat-2#seo',
          feature: 'seo',
          costMicroUsd: 2_000_000,
        }),
      ]);

      const result = await getCostAggregation('2026-06-01', '2026-06-30', 2);

      expect(result.topUsers.map((u) => u.userId)).toEqual(['user-2', 'user-3']);
      expect(mockGetUser).toHaveBeenCalledTimes(2);
    });

    it('keeps the user row when email enrichment fails (best-effort, non-critical)', async () => {
      mockScan.mockResolvedValue([aggRow({ costMicroUsd: 1_000_000 })]);
      mockGetUser.mockRejectedValue(new Error('dynamo down'));

      const result = await getCostAggregation('2026-06-01', '2026-06-30');

      expect(result.topUsers).toHaveLength(1);
      expect(result.topUsers[0].email).toBeNull();
      expect(result.topUsers[0].costMicroUsd).toBe(1_000_000);
    });

    it('returns an explicit zero payload for an empty window — no NaN, no undefined (assertion 4, API half)', async () => {
      mockScan.mockResolvedValue([]);

      const result = await getCostAggregation('2026-06-01', '2026-06-30');

      expect(result).toEqual({
        start: '2026-06-01',
        end: '2026-06-30',
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          callCount: 0,
          costMicroUsd: 0,
          costUsd: 0,
        },
        byModel: [],
        series: [],
        byFeature: [],
        topUsers: [],
        byXAccount: [],
      });
      expect(mockGetUser).not.toHaveBeenCalled();
    });
  });
});

// ── ENG-664: X allocated totals + billing-cycle window ────────────────────────

const xRow = (model: string, over: any = {}) => ({
  userId: over.userId ?? 'user-1',
  sk: `2026-07-10#${model}#x-account:acc-1`,
  date: '2026-07-10',
  model,
  feature: 'x-account:acc-1',
  callCount: 1,
  quantity: 1,
  costMicroUsd: 0,
  ...over,
});

describe('getXAllocatedTotals', () => {
  it('sums only twitter:* rows and counts post-read units separately', async () => {
    mockScan.mockResolvedValue([
      xRow('twitter:search_tweets', { quantity: 10, callCount: 1, costMicroUsd: 50_000 }), // $0.05, 10 post-reads
      xRow('twitter:get_profile', { quantity: 1, callCount: 1, costMicroUsd: 10_000 }),     // $0.01, user read (not post-read)
      xRow('twitter:post', { quantity: 1, callCount: 1, costMicroUsd: 15_000 }),            // $0.015 write
      // Non-twitter rows must be ignored entirely.
      { ...xRow('gpt-5-chat-2'), model: 'gpt-5-chat-2', costMicroUsd: 999_000 },
    ]);

    const t = await getXAllocatedTotals('2026-07-03', '2026-07-31');
    expect(t.costUsd).toBeCloseTo(0.075, 6); // 0.05 + 0.01 + 0.015 — the LLM row excluded
    expect(t.callCount).toBe(3);
    expect(t.postReadUnits).toBe(10); // only search_tweets counts
    expect(t.byOperation.map((r) => r.operation)).toContain('search_tweets');
    expect(t.byOperation[0].operation).toBe('search_tweets'); // sorted by spend desc
  });

  it('returns zeros for an empty window', async () => {
    mockScan.mockResolvedValue([]);
    const t = await getXAllocatedTotals('2026-07-01', '2026-07-02');
    expect(t.costUsd).toBe(0);
    expect(t.callCount).toBe(0);
    expect(t.postReadUnits).toBe(0);
    expect(t.byOperation).toEqual([]);
  });

  it('rejects a malformed or inverted range', async () => {
    await expect(getXAllocatedTotals('nope', '2026-07-02')).rejects.toThrow(/YYYY-MM-DD/);
    await expect(getXAllocatedTotals('2026-07-05', '2026-07-01')).rejects.toThrow(/<=/);
  });
});

describe('getXCostByActingUser', () => {
  it('sums twitter:* $ per acting userId and excludes non-twitter rows', async () => {
    mockScan.mockResolvedValue([
      xRow('twitter:search_tweets', { userId: 'user-1', costMicroUsd: 50_000 }), // $0.05
      xRow('twitter:get_profile', { userId: 'user-1', costMicroUsd: 10_000 }),   // +$0.01 → user-1 = $0.06
      xRow('twitter:post', { userId: 'user-2', costMicroUsd: 15_000 }),          // user-2 = $0.015
      // An LLM row for user-1 must NOT inflate their X total.
      { ...xRow('gpt-5-chat-2', { userId: 'user-1' }), model: 'gpt-5-chat-2', costMicroUsd: 999_000 },
      // A row with no userId is skipped.
      xRow('twitter:like', { userId: undefined, costMicroUsd: 0 }),
    ]);

    const map = await getXCostByActingUser('2026-07-01', '2026-07-31');
    expect(map['user-1']).toBeCloseTo(0.06, 6);
    expect(map['user-2']).toBeCloseTo(0.015, 6);
    // No entry for users without X spend (caller renders $0).
    expect(map['user-3']).toBeUndefined();
  });

  it('returns an empty map for an empty window', async () => {
    mockScan.mockResolvedValue([]);
    await expect(getXCostByActingUser('2026-07-01', '2026-07-02')).resolves.toEqual({});
  });

  it('rejects a malformed or inverted range', async () => {
    await expect(getXCostByActingUser('nope', '2026-07-02')).rejects.toThrow(/YYYY-MM-DD/);
    await expect(getXCostByActingUser('2026-07-05', '2026-07-01')).rejects.toThrow(/<=/);
  });
});

describe('currentXBillingCycle', () => {
  it('starts on the reset day this month when today is past it', () => {
    const c = currentXBillingCycle(3, new Date('2026-07-20T12:00:00Z'));
    expect(c.start).toBe('2026-07-03');
    expect(c.end).toBe('2026-07-20');
  });

  it('rolls back to last month when today is before the reset day', () => {
    const c = currentXBillingCycle(15, new Date('2026-07-05T00:00:00Z'));
    expect(c.start).toBe('2026-06-15');
    expect(c.end).toBe('2026-07-05');
  });

  it('falls back to day 1 when the reset day is null/invalid', () => {
    expect(currentXBillingCycle(null, new Date('2026-07-20T00:00:00Z')).start).toBe('2026-07-01');
    expect(currentXBillingCycle(99, new Date('2026-07-20T00:00:00Z')).start).toBe('2026-07-01');
  });

  it('rolls the year back at the January boundary', () => {
    const c = currentXBillingCycle(15, new Date('2026-01-05T00:00:00Z'));
    expect(c.start).toBe('2025-12-15');
    expect(c.end).toBe('2026-01-05');
  });

  it('clamps a 29-31 reset day to a short prior month (no month overflow, never start>end)', () => {
    // Feb 2026 (28 days): reset day 31 early in March must clamp to Feb 28, not spill to Mar 3.
    const c = currentXBillingCycle(31, new Date('2026-03-01T00:00:00Z'));
    expect(c.start).toBe('2026-02-28');
    expect(c.end).toBe('2026-03-01');
    expect(c.start <= c.end).toBe(true);
    // April (30 days): reset day 31 mid-May clamps to Apr 30.
    expect(currentXBillingCycle(31, new Date('2026-05-10T00:00:00Z')).start).toBe('2026-04-30');
  });
});

describe('getCostAggregation — byXAccount (@handle enrichment, ENG-664)', () => {
  // Option B: userId = acting member; billingUserId = account owner. Enrichment
  // resolves the handle through the OWNER (billingUserId).
  const xr = (accountId: string, actingUserId: string, owner: string, costMicroUsd: number, callCount = 1) => ({
    userId: actingUserId,
    billingUserId: owner,
    sk: `2026-07-10#twitter:search_tweets#x-account:${accountId}`,
    date: '2026-07-10',
    model: 'twitter:search_tweets',
    feature: `x-account:${accountId}`,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    callCount,
    quantity: callCount,
    costMicroUsd,
  });

  it('groups X rows by account and enriches the handle via the OWNER (billingUserId), across acting members', async () => {
    mockScan.mockResolvedValue([
      // acc-1 owned by owner-1, but the calls were made by two different members.
      xr('acc-1', 'member-a', 'owner-1', 90_000, 9),
      xr('acc-1', 'member-b', 'owner-1', 10_000, 1),
      xr('acc-2', 'owner-3', 'owner-3', 5_000, 1),
      // a non-X row must not appear as an account
      { ...xr('acc-1', 'member-a', 'owner-1', 999_000), model: 'gpt-5-chat-2', feature: 'agent-chat' },
    ]);
    mockGetUser.mockResolvedValue(null);
    mockGetAccountById.mockImplementation((accountId: string, userId: string) => {
      if (accountId === 'acc-1' && userId === 'owner-1') return Promise.resolve({ account_name: '@a', config: { username: 'alice' } });
      if (accountId === 'acc-2') return Promise.resolve({ account_name: 'Bob', config: {} });
      return Promise.resolve(null);
    });

    const result = await getCostAggregation('2026-07-01', '2026-07-31');

    expect(result.byXAccount.map((a) => a.accountId)).toEqual(['acc-1', 'acc-2']); // sorted by spend
    expect(result.byXAccount[0]).toMatchObject({ accountId: 'acc-1', handle: 'alice', callCount: 10 });
    expect(result.byXAccount[0].costUsd).toBeCloseTo(0.1, 6); // (90000+10000)/1e6, both members
    // Handle resolved via the OWNER (billingUserId), NOT either acting member.
    expect(mockGetAccountById).toHaveBeenCalledWith('acc-1', 'owner-1', 'twitter');
    expect(mockGetAccountById).not.toHaveBeenCalledWith('acc-1', 'member-a', 'twitter');
    // acc-2 config has no username → falls back to account_name.
    expect(result.byXAccount[1]).toMatchObject({ accountId: 'acc-2', handle: 'Bob' });
  });

  it('yields handle=null when the account cannot be resolved (fallback to raw id)', async () => {
    mockScan.mockResolvedValue([xr('acc-x', 'u1', 'u1', 5_000)]);
    mockGetUser.mockResolvedValue(null);
    mockGetAccountById.mockResolvedValue(null);

    const result = await getCostAggregation('2026-07-01', '2026-07-31');
    expect(result.byXAccount).toEqual([
      { accountId: 'acc-x', handle: null, costMicroUsd: 5_000, costUsd: 0.005, callCount: 1 },
    ]);
  });

  it('is empty when there are no X rows', async () => {
    mockScan.mockResolvedValue([]);
    mockGetUser.mockResolvedValue(null);
    const result = await getCostAggregation('2026-07-01', '2026-07-31');
    expect(result.byXAccount).toEqual([]);
    expect(mockGetAccountById).not.toHaveBeenCalled();
  });
});

describe('getUserXBreakdown (per-user X cost by tool, ENG-664)', () => {
  const txr = (op: string, costMicroUsd: number, callCount = 1, quantity = callCount) => ({
    userId: 'u1',
    sk: `2026-07-10#twitter:${op}#x-account:acc-1`,
    date: '2026-07-10',
    model: `twitter:${op}`,
    feature: 'x-account:acc-1',
    callCount,
    quantity,
    costMicroUsd,
  });

  it('groups a user\'s twitter rows by tool, sorted by spend, ignoring non-twitter rows', async () => {
    mockQuery.mockResolvedValue([
      txr('search_tweets', 50_000, 5, 10),
      txr('post', 15_000, 1),
      { ...txr('post', 999_000), model: 'gpt-5-chat-2', feature: 'agent-chat' }, // non-X, ignored
    ]);
    const r = await getUserXBreakdown('u1', '2026-07-01', '2026-07-31');
    expect(mockQuery).toHaveBeenCalledWith('u1', '2026-07-01', '2026-07-31');
    expect(r.costUsd).toBeCloseTo(0.065, 6); // 0.05 + 0.015
    expect(r.callCount).toBe(6);
    expect(r.byOperation.map((o) => o.operation)).toEqual(['search_tweets', 'post']); // spend desc
    expect(r.byOperation[0].costUsd).toBeCloseTo(0.05, 6);
  });

  it('returns empty for a user with no X usage', async () => {
    mockQuery.mockResolvedValue([]);
    const r = await getUserXBreakdown('u1', '2026-07-01', '2026-07-31');
    expect(r).toEqual({ userId: 'u1', start: '2026-07-01', end: '2026-07-31', costUsd: 0, callCount: 0, byOperation: [] });
  });

  it('rejects a malformed or inverted range', async () => {
    await expect(getUserXBreakdown('u1', 'x', '2026-07-31')).rejects.toThrow(/YYYY-MM-DD/);
    await expect(getUserXBreakdown('u1', '2026-07-31', '2026-07-01')).rejects.toThrow(/<=/);
  });
});
