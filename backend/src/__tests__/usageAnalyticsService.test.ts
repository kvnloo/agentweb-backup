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
  getCostAggregation,
  getXAllocatedTotals,
  currentXBillingCycle,
  getUserXBreakdown,
  PROVIDER_UNRECORDED,
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

    it('provider scope: default "llm" excludes vendor rows; "twitter" keeps only X; "all" keeps both', async () => {
      // A realistic mixed ledger: one LLM row and one X vendor row (provider+unit,
      // as recordVendorUsage writes) — so the LLM Costs tab (default "llm") must
      // NOT show the twitter row (ENG-664 leak fix).
      const rows = [
        aggRow({ costMicroUsd: 3_000_000 }), // LLM $3
        xRow('twitter:post', { provider: 'twitter', unit: 'post', costMicroUsd: 500_000 }), // X $0.50
      ];
      // The X cut enriches @handles via getAccountById — return null (unresolved).
      mockGetAccountById.mockResolvedValue(null);

      mockScan.mockResolvedValue(rows);
      const llm = await getCostAggregation('2026-06-01', '2026-06-30'); // default "llm"
      expect(llm.byModel.some((m) => m.model.startsWith('twitter:'))).toBe(false);
      expect(llm.totals.costUsd).toBeCloseTo(3, 6);

      mockScan.mockResolvedValue(rows);
      const x = await getCostAggregation('2026-06-01', '2026-06-30', 10, 'twitter');
      expect(x.byModel.length).toBeGreaterThan(0);
      expect(x.byModel.every((m) => m.model.startsWith('twitter:'))).toBe(true);
      expect(x.totals.costUsd).toBeCloseTo(0.5, 6);

      mockScan.mockResolvedValue(rows);
      const all = await getCostAggregation('2026-06-01', '2026-06-30', 10, 'all');
      expect(all.totals.costUsd).toBeCloseTo(3.5, 6);
    });

    // ── availableProviders: the admin picker's option list (ENG-1837) ────────
    // AC1-3 of ENG-1837. The union of a registry and what the window actually
    // contains, computed BEFORE the provider filter.

    it('offers every metered vendor even when the ledger is empty (ENG-1837 AC2)', async () => {
      mockScan.mockResolvedValue([]);
      const agg = await getCostAggregation('2026-06-01', '2026-06-30', 10, 'all');
      // A vendor with an adapter but no spend must still be SELECTABLE, so the
      // admin gets an empty state instead of the option silently missing.
      expect(agg.availableProviders).toEqual([
        'all',
        'llm',
        '2captcha',
        'apollo',
        'elevenlabs',
        'enigma',
        'enrich.so',
        'placid',
        'remotion',
        'twilio',
        'twitter',
        'v0',
        'you.com',
      ]);
    });

    it('includes a provider present in the window but absent from the registry (ENG-1837 AC3)', async () => {
      mockGetAccountById.mockResolvedValue(null);
      mockScan.mockResolvedValue([
        aggRow({ model: 'newvendor:lookup', provider: 'newvendor', unit: 'lookup', costMicroUsd: 1_000 }),
      ]);
      const agg = await getCostAggregation('2026-06-01', '2026-06-30', 10, 'all');
      // A vendor whose adapter shipped after the registry was last edited must
      // still surface — a forgotten registry entry degrades to a missing empty
      // state, never to hidden spend.
      expect(agg.availableProviders).toContain('newvendor');
    });

    // ── byProvider: spend by upstream (ENG-1859) ────────────────────────────

    it('groups LLM spend by the provider that served it', async () => {
      mockScan.mockResolvedValue([
        aggRow({ model: 'anthropic.claude-opus-5', provider: 'bedrock', costMicroUsd: 3_000_000 }),
        aggRow({ model: 'anthropic.claude-sonnet-5', provider: 'bedrock', costMicroUsd: 1_000_000 }),
        aggRow({ model: 'gemini-3.5-flash', provider: 'gemini', costMicroUsd: 500_000 }),
      ]);

      const agg = await getCostAggregation('2026-06-01', '2026-06-30');

      expect(agg.byProvider.map((p) => [p.provider, p.costUsd])).toEqual([
        ['bedrock', 4],
        ['gemini', 0.5],
      ]);
      // The cut must reconcile with the headline, or it is worse than absent.
      expect(agg.byProvider.reduce((t, p) => t + p.costMicroUsd, 0)).toBe(agg.totals.costMicroUsd);
    });

    it('separates the same model served through two different providers', async () => {
      // The reason this cut cannot be derived from byModel: one model, two
      // upstreams, two different costs to us.
      mockScan.mockResolvedValue([
        aggRow({ model: 'anthropic.claude-sonnet-4-6', provider: 'bedrock', costMicroUsd: 2_000_000 }),
        aggRow({ model: 'anthropic/claude-sonnet-4.6', provider: 'openrouter', costMicroUsd: 700_000 }),
      ]);

      const agg = await getCostAggregation('2026-06-01', '2026-06-30');
      expect(agg.byProvider.map((p) => p.provider)).toEqual(['bedrock', 'openrouter']);
    });

    it('buckets pre-ENG-693 rows as unrecorded rather than inventing a provider', async () => {
      mockScan.mockResolvedValue([
        aggRow({ model: 'gpt-5-chat-2', costMicroUsd: 1_000_000 }), // no provider attribute
        aggRow({ model: 'gemini-3.5-flash', provider: 'gemini', costMicroUsd: 500_000 }),
      ]);

      const agg = await getCostAggregation('2026-06-01', '2026-06-30');

      const unrecorded = agg.byProvider.find((p) => p.provider === PROVIDER_UNRECORDED);
      expect(unrecorded?.costUsd).toBe(1);
      // Not attributed to a provider, and not dropped — the rows still sum.
      expect(agg.byProvider.reduce((t, p) => t + p.costMicroUsd, 0)).toBe(agg.totals.costMicroUsd);
    });

    it('excludes LLM providers, which also carry a `provider` since ENG-693', async () => {
      mockGetAccountById.mockResolvedValue(null);
      mockScan.mockResolvedValue([
        // Real shape of an LLM row after ENG-693: it HAS a provider, but no
        // unit, and its model is not vendor-namespaced. Returning row.provider
        // unconditionally put bedrock/gemini/openai/azure-openai/openrouter into
        // the per-unit vendor picker in production (ENG-1837 follow-up).
        aggRow({ model: 'anthropic.claude-opus-5', provider: 'bedrock', costMicroUsd: 3_000_000 }),
        aggRow({ model: 'gemini-3.5-flash', provider: 'gemini', costMicroUsd: 1_000_000 }),
        aggRow({ model: 'gpt-5.5', provider: 'azure-openai', costMicroUsd: 500_000 }),
        // A genuine vendor row, so the assertion is not vacuous.
        xRow('apollo:email_reveal', { provider: 'apollo', unit: 'reveal', costMicroUsd: 49_500 }),
      ]);

      const agg = await getCostAggregation('2026-06-01', '2026-06-30', 10, 'all');

      expect(agg.availableProviders).toContain('apollo');
      for (const llmProvider of ['bedrock', 'gemini', 'azure-openai', 'openai', 'openrouter']) {
        expect(agg.availableProviders).not.toContain(llmProvider);
      }
      // The registry entries are still offered — this narrows what the WINDOW
      // contributes, not what the registry guarantees.
      expect(agg.availableProviders).toEqual([
        'all', 'llm', '2captcha', 'apollo', 'elevenlabs', 'enigma', 'enrich.so',
        'placid', 'remotion', 'twilio', 'twitter', 'v0', 'you.com',
      ]);
    });

    it('detects a vendor by model namespace when the provider attribute is absent', async () => {
      mockGetAccountById.mockResolvedValue(null);
      mockScan.mockResolvedValue([
        // No `provider` attribute, but the filter would still match this row on
        // its "{provider}:" model prefix — so the option list must too, or the
        // vendor is filterable yet unlistable.
        aggRow({ model: 'legacyvendor:op', costMicroUsd: 1_000 }),  // no provider, no unit
      ]);
      const agg = await getCostAggregation('2026-06-01', '2026-06-30', 10, 'all');
      expect(agg.availableProviders).toContain('legacyvendor');
    });

    it('does not treat a Bedrock numeric version suffix as a provider', async () => {
      mockScan.mockResolvedValue([
        aggRow({ model: 'anthropic.claude-sonnet-4-5-20250929-v1:0', costMicroUsd: 2_000_000 }),
      ]);
      const agg = await getCostAggregation('2026-06-01', '2026-06-30');
      expect(agg.availableProviders).not.toContain('anthropic.claude-sonnet-4-5-20250929-v1');
    });

    it('is computed over the UNFILTERED window, so selecting one provider does not collapse the list', async () => {
      mockGetAccountById.mockResolvedValue(null);
      mockScan.mockResolvedValue([
        aggRow({ costMicroUsd: 3_000_000 }),
        xRow('twitter:post', { provider: 'twitter', unit: 'post', costMicroUsd: 500_000 }),
        aggRow({ model: 'zzvendor:call', provider: 'zzvendor', unit: 'call', costMicroUsd: 1_000 }),
      ]);
      // Scoped to twitter: the ROWS are X-only...
      const agg = await getCostAggregation('2026-06-01', '2026-06-30', 10, 'twitter');
      expect(agg.byModel.every((m) => m.model.startsWith('twitter:'))).toBe(true);
      // ...but the picker must still offer everything, or switching away from a
      // selection would be impossible once it was made.
      expect(agg.availableProviders).toContain('zzvendor');
      expect(agg.availableProviders).toContain('llm');
    });

    it('"llm" scope excludes a twitter:* row even if it is missing the unit field, but keeps Bedrock :0 versions', async () => {
      mockGetAccountById.mockResolvedValue(null);
      mockScan.mockResolvedValue([
        // A vendor row with the model namespace but NO provider/unit — the belt-and-
        // suspenders model-prefix guard must still exclude it from the LLM view.
        aggRow({ model: 'twitter:post', feature: 'x-account:acc-1', costMicroUsd: 500_000 }),
        // A Bedrock model whose id ends in a numeric ":0" version tag is LLM, not a
        // vendor — it must be KEPT.
        aggRow({ model: 'anthropic.claude-sonnet-4-5-20250929-v1:0', costMicroUsd: 2_000_000 }),
      ]);

      const llm = await getCostAggregation('2026-06-01', '2026-06-30'); // default "llm"
      expect(llm.byModel.some((m) => m.model.startsWith('twitter:'))).toBe(false);
      expect(llm.byModel.some((m) => m.model === 'anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(true);
      expect(llm.totals.costUsd).toBeCloseTo(2, 6); // only the Bedrock row counts
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

      // userCount is the distinct-user count over the FULL set (user-1, user-2),
      // independent of the topUsers cap — 3 rows across 2 users → 2.
      expect(result.userCount).toBe(2);
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

    it('keeps one feature bucket when rows carry a provenance qualifier (ENG-1210)', async () => {
      // The metering tag appends `:interactive` / `:scheduled:<id>` to `feature`
      // so the runway work can attribute spend. Bucketing on the raw string
      // would shatter this cut: one `agent_task` line becomes one line per
      // schedule — ~90 of them in production — and none of them aggregate with
      // the untagged rows already in the table. `normaliseFeature` takes the
      // segment before the first `:`, which is exactly what this dimension has
      // always meant.
      mockScan.mockResolvedValue([
        aggRow({ sk: '2026-06-02#gpt-5-chat-2#agent_task', feature: 'agent_task', costMicroUsd: 1_000_000 }),
        aggRow({ sk: '2026-06-02#gpt-5-chat-2#agent_task:interactive', feature: 'agent_task:interactive', costMicroUsd: 2_000_000 }),
        aggRow({ sk: '2026-06-02#gpt-5-chat-2#agent_task:scheduled:sched-a', feature: 'agent_task:scheduled:sched-a', costMicroUsd: 4_000_000 }),
        aggRow({ sk: '2026-06-02#gpt-5-chat-2#agent_task:scheduled:sched-b', feature: 'agent_task:scheduled:sched-b', costMicroUsd: 8_000_000 }),
      ]);

      const result = await getCostAggregation('2026-06-01', '2026-06-30');

      expect(result.byFeature.map((f) => [f.feature, f.costMicroUsd])).toEqual([
        ['agent_task', 15_000_000],
      ]);
    });

    it('still separates features that merely contain a colon (ENG-1210)', async () => {
      // `x-account:<id>` is a real dimension, not a provenance tag, and it
      // predates the tagging convention. Collapsing every `x-account:*` row into
      // one bucket would erase the per-account cut the admin cost modal is built
      // on — so grouping is by the leading segment for everyone, consistently,
      // and the X rollup keeps its own dedicated cut.
      // The X cut enriches @handles via getAccountById — return null (unresolved).
      mockGetAccountById.mockResolvedValue(null);
      mockScan.mockResolvedValue([
        aggRow({ sk: '2026-06-02#gpt-5-chat-2#x-account:111', feature: 'x-account:111', costMicroUsd: 1_000_000 }),
        aggRow({ sk: '2026-06-02#gpt-5-chat-2#emma', feature: 'emma', costMicroUsd: 5_000_000 }),
      ]);

      const result = await getCostAggregation('2026-06-01', '2026-06-30');

      expect(result.byFeature.map((f) => f.feature)).toEqual(['emma', 'x-account']);
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
        byProvider: [],
        series: [],
        byFeature: [],
        topUsers: [],
        userCount: 0,
        byXAccount: [],
        // Not a spend figure: the picker's options are a capability list, so an
        // empty window still offers every metered vendor (ENG-1837 AC2) rather
        // than emptying the dropdown along with the data.
        availableProviders: [
          'all',
          'llm',
          '2captcha',
          'apollo',
          'elevenlabs',
          'enigma',
          'enrich.so',
          'placid',
          'remotion',
          'twilio',
          'twitter',
          'v0',
          'you.com',
        ],
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

    // provider="twitter": byXAccount is an X-only cut, so it's populated only when
    // X rows are in scope (the Usage & Cost tab requests exactly this).
    const result = await getCostAggregation('2026-07-01', '2026-07-31', 10, 'twitter');

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

    // provider="twitter": byXAccount is an X-only cut, so it's populated only when
    // X rows are in scope (the Usage & Cost tab requests exactly this).
    const result = await getCostAggregation('2026-07-01', '2026-07-31', 10, 'twitter');
    expect(result.byXAccount).toEqual([
      { accountId: 'acc-x', handle: null, costMicroUsd: 5_000, costUsd: 0.005, callCount: 1 },
    ]);
  });

  it('is empty when there are no X rows', async () => {
    mockScan.mockResolvedValue([]);
    mockGetUser.mockResolvedValue(null);
    // provider="twitter": byXAccount is an X-only cut, so it's populated only when
    // X rows are in scope (the Usage & Cost tab requests exactly this).
    const result = await getCostAggregation('2026-07-01', '2026-07-31', 10, 'twitter');
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
