/**
 * ENG-1139 — per-billing-subject unit economics.
 *
 * The two things most likely to go quietly wrong here are both about honesty
 * rather than arithmetic, so they are asserted first:
 *
 *  - thresholds must come from the LIVE policy, never a constant. The ticket's
 *    table was written against Starter $60 / Pro $150 and production moved to
 *    $80 / $200 on 2026-09-01, with Super Premium never having had a row. A
 *    report that disagrees with the enforcer about where the cap sits is worse
 *    than no report.
 *  - vendor spend must not be presented as all-in. Most ENG-666 vendors write
 *    no ledger rows, so a summed "all-in" figure would read as the overhead
 *    envelope being comfortably met when it is simply unmeasured.
 */

const mockScanByDateRange = jest.fn();
const mockGetAllUsers = jest.fn();
const mockGetSubscriptionTypeConfig = jest.fn();

jest.mock('../services/usageRecordDb', () => ({
  ...jest.requireActual('../services/usageRecordDb'),
  usageRecordDb: { scanByDateRange: (...a: any[]) => mockScanByDateRange(...a) },
}));
jest.mock('../services/db', () => ({
  userDb: { getAllUsers: (...a: any[]) => mockGetAllUsers(...a) },
}));
jest.mock('../services/subscriptionService', () => ({
  getSubscriptionTypeConfig: (...a: any[]) => mockGetSubscriptionTypeConfig(...a),
}));

import { buildUnitEconomicsReport, monthBounds } from '../services/llmUnitEconomicsService';

const llmRow = (billingUserId: string, costMicroUsd: number, model = 'gpt-5.4') => ({
  userId: billingUserId, billingUserId, sk: `2026-09-05#${model}#agent_task`,
  date: '2026-09-05', model, feature: 'agent_task', costMicroUsd, callCount: 1,
  totalTokens: 100, updatedAt: '', ttl: 0,
});
const vendorRow = (billingUserId: string, costMicroUsd: number) => ({
  userId: billingUserId, billingUserId, sk: '2026-09-05#twitter:read#social',
  date: '2026-09-05', model: 'twitter:read', feature: 'social', costMicroUsd,
  callCount: 1, updatedAt: '', ttl: 0, provider: 'twitter', unit: 'read', quantity: 3,
});

const PRO_POLICY = { llmUsagePolicy: { enforcementState: 'hard_only', hardCostThresholdMicroUsd: 200_000_000 } };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSubscriptionTypeConfig.mockResolvedValue(PRO_POLICY);
});

describe('monthBounds', () => {
  it('covers the whole month including a 31st and a leap February', () => {
    expect(monthBounds('2026-09')).toEqual({ start: '2026-09-01', end: '2026-09-30' });
    expect(monthBounds('2026-01')).toEqual({ start: '2026-01-01', end: '2026-01-31' });
    expect(monthBounds('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(monthBounds('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
  });
  it('rejects anything that is not YYYY-MM', () => {
    for (const bad of ['2026', '2026-13', '2026-00', 'nope']) {
      expect(() => monthBounds(bad)).toThrow();
    }
  });
});

describe('thresholds come from the live policy, never a constant', () => {
  it('uses whatever hardCostThresholdMicroUsd the tier currently carries', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 50_000_000)]);
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', email: 'a@x.com', subscriptionType: 'Pro' }]);
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0].includedThresholdUsd).toBe(200);
    expect(r.rows[0].percentUsed).toBe(25);
  });

  it('follows the policy when it moves, rather than the ticket’s old table', async () => {
    // Starter's ticket value was $60; production moved it to $80.
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      llmUsagePolicy: { enforcementState: 'hard_only', hardCostThresholdMicroUsd: 80_000_000 },
    });
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 40_000_000)]);
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', email: 'a@x.com', subscriptionType: 'Starter' }]);
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0].includedThresholdUsd).toBe(80);
    expect(r.rows[0].percentUsed).toBe(50);
  });

  it('reports a tier with no policy as uncapped and alerts on it', async () => {
    mockGetSubscriptionTypeConfig.mockResolvedValue({});
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 300_000_000)]);
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', email: 'm@x.com', subscriptionType: 'Managed' }]);
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0].includedThresholdUsd).toBeNull();
    expect(r.rows[0].percentUsed).toBeNull();
    expect(r.alerts.find((a) => a.kind === 'uncapped_tier')?.count).toBe(1);
  });
});

describe('vendor spend is never presented as all-in', () => {
  it('keeps vendor separate from LLM and flags coverage as partial', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 10_000_000), vendorRow('u1', 2_000_000)]);
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', email: 'a@x.com', subscriptionType: 'Pro' }]);
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0].llmCostUsd).toBe(10);
    expect(r.rows[0].vendorCostUsd).toBe(2);
    expect(r.rows[0].vendorCoverage).toBe('partial');
    // No summed all-in field exists to be mistaken for one.
    expect(r.rows[0]).not.toHaveProperty('allInCostUsd');
    expect(r.vendorCoverageNote).toMatch(/not an all-in figure/i);
  });
});

describe('credit ledger and the cap arithmetic', () => {
  it('subtracts the migration offset from what the cap counts, and adds credits to the ceiling', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 250_000_000)]);
    mockGetAllUsers.mockResolvedValue([{
      userId: 'u1', email: 'a@x.com', subscriptionType: 'Pro',
      llmUsageCredits: {
        month: '2026-09', totalMigrationOffsetMicroUsd: 50_000_000,
        totalPurchasedMicroUsd: 60_000_000, totalPurchasedReversedMicroUsd: 0,
        totalAdminGrantedMicroUsd: 40_000_000,
      },
    }]);
    const r = await buildUnitEconomicsReport('2026-09');
    const row = r.rows[0];
    expect(row.llmCostUsd).toBe(250);
    expect(row.policyCostUsd).toBe(200);          // 250 - 50 offset
    expect(row.effectiveThresholdUsd).toBe(300);  // 200 + 60 purchased + 40 admin
    expect(row.percentUsed).toBeCloseTo(66.67, 1);
    expect(row.purchasedCredits).toBe(true);
  });

  it('ignores a credit ledger from a different month', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 10_000_000)]);
    mockGetAllUsers.mockResolvedValue([{
      userId: 'u1', email: 'a@x.com', subscriptionType: 'Pro',
      llmUsageCredits: { month: '2026-08', totalPurchasedMicroUsd: 999_000_000, totalMigrationOffsetMicroUsd: 999_000_000 },
    }]);
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0].purchasedCreditsUsd).toBe(0);
    expect(r.rows[0].migrationOffsetUsd).toBe(0);
    expect(r.rows[0].policyCostUsd).toBe(10);
  });
});

describe('AC2 — discrepancies are visible, not hidden', () => {
  it('surfaces a ledger/counter drift instead of silently trusting one', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 100_000_000)]);
    mockGetAllUsers.mockResolvedValue([{
      userId: 'u1', email: 'drift@x.com', subscriptionType: 'Pro',
      tokenUsage: { month: '2026-09', totalCost: 92.7 },
    }]);
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0].reconciled).toBe(false);
    expect(r.rows[0].ledgerVsCounterDeltaUsd).toBeCloseTo(7.3, 2);
    expect(r.unreconciled).toHaveLength(1);
    expect(r.alerts.find((a) => a.kind === 'ledger_counter_drift')?.count).toBe(1);
  });

  it('does not flag sub-cent rounding as drift', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 100_000_000)]);
    mockGetAllUsers.mockResolvedValue([{
      userId: 'u1', email: 'ok@x.com', subscriptionType: 'Pro',
      tokenUsage: { month: '2026-09', totalCost: 100.004 },
    }]);
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0].reconciled).toBe(true);
    expect(r.unreconciled).toHaveLength(0);
  });

  it('does not compare against a counter describing a different month', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 100_000_000)]);
    mockGetAllUsers.mockResolvedValue([{
      userId: 'u1', email: 'ok@x.com', subscriptionType: 'Pro',
      tokenUsage: { month: '2026-08', totalCost: 5 },
    }]);
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0].counterCostUsd).toBeNull();
    expect(r.rows[0].reconciled).toBe(true);
  });
});

describe('AC1 — filters', () => {
  const seed = () => {
    mockScanByDateRange.mockResolvedValue([
      llmRow('u1', 10_000_000, 'gpt-5.4'),
      llmRow('u2', 20_000_000, 'gemini-3.5-flash'),
    ]);
    mockGetAllUsers.mockResolvedValue([
      { userId: 'u1', email: 'alpha@x.com', subscriptionType: 'Pro' },
      { userId: 'u2', email: 'beta@y.com', subscriptionType: 'Starter',
        llmUsageCredits: { month: '2026-09', totalPurchasedMicroUsd: 5_000_000 } },
    ]);
  };
  it('filters by tier', async () => { seed();
    expect((await buildUnitEconomicsReport('2026-09', { tier: 'Starter' })).rows.map(r => r.email)).toEqual(['beta@y.com']); });
  it('filters by account substring on id or email', async () => { seed();
    expect((await buildUnitEconomicsReport('2026-09', { account: 'ALPHA' })).rows.map(r => r.email)).toEqual(['alpha@x.com']); });
  it('filters by model', async () => { seed();
    expect((await buildUnitEconomicsReport('2026-09', { model: 'gemini-3.5-flash' })).rows.map(r => r.email)).toEqual(['beta@y.com']); });
  it('filters to accounts that purchased credits', async () => { seed();
    expect((await buildUnitEconomicsReport('2026-09', { purchasedOnly: true })).rows.map(r => r.email)).toEqual(['beta@y.com']); });
  it('does not leak the internal model set into the response', async () => { seed();
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0]).not.toHaveProperty('_models'); });
});

describe('AC5 — alerting is aggregate, not per-account', () => {
  it('emits one counted alert rather than one entry per heavy account', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 300_000_000), llmRow('u2', 400_000_000)]);
    mockGetAllUsers.mockResolvedValue([
      { userId: 'u1', email: 'a@x.com', subscriptionType: 'Pro' },
      { userId: 'u2', email: 'b@x.com', subscriptionType: 'Pro' },
    ]);
    const r = await buildUnitEconomicsReport('2026-09');
    const over = r.alerts.filter((a) => a.kind === 'over_threshold');
    expect(over).toHaveLength(1);
    expect(over[0].count).toBe(2);
  });
});
