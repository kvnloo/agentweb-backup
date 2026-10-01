import {
  applyLlmUsageCredits,
  getCurrentUsageMonth,
  getLlmUsageCreditAdjustment,
  grantMonthlyLlmUsageCredit,
  planRolloutMigrationCredit,
  reverseMonthlyPurchasedLlmUsageCredit,
  type MonthlyLlmUsageCredits,
} from '../services/llmUsageCreditService';
import { userDb } from '../services/db';

const ledger: MonthlyLlmUsageCredits = {
  month: '2026-08',
  totalPurchasedMicroUsd: 10_000_000,
  totalAdminGrantedMicroUsd: 0,
  totalMigrationOffsetMicroUsd: 31_000_000,
  grantIds: ['migration:2026-08:u1', 'stripe:cs_test_1'],
  grants: [],
};

describe('LLM usage credits', () => {
  // usageCycle.ts's header comment documents the billing cycle as "reckoned
  // per CALENDAR month in UTC." getCurrentUsageMonth had no direct test and
  // silently used local-time getters instead, which only read as correct
  // because every CI/prod machine for this project happens to already run in
  // UTC — found via a real timezone-dependent test failure (orgSeatCreditGrantService
  // tests passed on UTC machines, failed on Pacific). Pinning explicit UTC dates
  // here (process.env.TZ-independent, unlike `new Date(2026, 9, 1)` which is
  // local-time) is what actually exercises the UTC contract regardless of the
  // machine running the suite.
  describe('getCurrentUsageMonth', () => {
    it('reckons the month in UTC, not the host process\'s local timezone', () => {
      // 2026-10-01T00:00:00Z is still 2026-09-30 in every timezone behind UTC
      // (the whole Western hemisphere) — exactly the boundary a local-time
      // implementation gets wrong.
      expect(getCurrentUsageMonth(new Date('2026-10-01T00:00:00Z'))).toBe('2026-10');
      expect(getCurrentUsageMonth(new Date('2026-09-30T23:59:59Z'))).toBe('2026-09');
    });

    it('pads single-digit months', () => {
      expect(getCurrentUsageMonth(new Date('2026-01-15T12:00:00Z'))).toBe('2026-01');
    });
  });

  it('migration credit starts an affected user from zero without erasing raw spend', () => {
    const adjustment = getLlmUsageCreditAdjustment(ledger, '2026-08');
    expect(applyLlmUsageCredits({
      rawCostUsedMicroUsd: 31_000_000,
      hardThresholdMicroUsd: 60_000_000,
      adjustment,
    })).toEqual({
      policyCostUsedMicroUsd: 0,
      effectiveHardThresholdMicroUsd: 70_000_000,
    });
  });

  it('purchased credit extends only the hard ceiling and does not erase spend', () => {
    const adjustment = getLlmUsageCreditAdjustment({ ...ledger, totalMigrationOffsetMicroUsd: 0 }, '2026-08');
    expect(applyLlmUsageCredits({
      rawCostUsedMicroUsd: 35_000_000,
      hardThresholdMicroUsd: 60_000_000,
      adjustment,
    })).toEqual({
      policyCostUsedMicroUsd: 35_000_000,
      effectiveHardThresholdMicroUsd: 70_000_000,
    });
  });

  it('expires all monthly credits automatically on reset', () => {
    expect(getLlmUsageCreditAdjustment(ledger, '2026-09')).toEqual({
      purchasedMicroUsd: 0,
      adminGrantedMicroUsd: 0,
      migrationOffsetMicroUsd: 0,
    });
  });

  it('plans a one-month offset equal to existing raw spend without deleting it', () => {
    expect(planRolloutMigrationCredit({
      usageMonth: '2026-08',
      rawCostUsedUsd: 42.25,
      currentMonth: '2026-08',
      policyVersion: 'pro-v1',
    })).toEqual({
      action: 'grant',
      amountMicroUsd: 42_250_000,
      grantIdSuffix: 'rollout:pro-v1:2026-08',
    });
  });

  it('admin credits extend the current hard ceiling without erasing recorded spend', () => {
    const adjustment = getLlmUsageCreditAdjustment({
      ...ledger,
      totalPurchasedMicroUsd: 0,
      totalAdminGrantedMicroUsd: 25_000_000,
      totalMigrationOffsetMicroUsd: 0,
    }, '2026-08');
    expect(applyLlmUsageCredits({
      rawCostUsedMicroUsd: 60_000_000,
      hardThresholdMicroUsd: 60_000_000,
      adjustment,
    })).toEqual({
      policyCostUsedMicroUsd: 60_000_000,
      effectiveHardThresholdMicroUsd: 85_000_000,
    });
  });

  it('records an admin grant once with its reason and actor', async () => {
    const getUser = jest.spyOn(userDb, 'getUserById').mockResolvedValue({
      userId: 'u1', email: 'u1@agentweb.pro', llmUsageCredits: undefined,
    } as any);
    const updateUser = jest.spyOn(userDb, 'updateUser').mockResolvedValue({} as any);

    const result = await grantMonthlyLlmUsageCredit({
      billingUserId: 'u1',
      grantId: 'admin:u1:grant_1234',
      source: 'admin',
      amountMicroUsd: 7_000_000,
      reason: 'GROW-106 founder event',
      grantedBy: 'admin@agentweb.pro',
      now: new Date('2026-08-11T12:00:00.000Z'),
    });

    expect(result.ledger.totalAdminGrantedMicroUsd).toBe(7_000_000);
    expect(result.ledger.grants[0]).toMatchObject({
      source: 'admin', reason: 'GROW-106 founder event', grantedBy: 'admin@agentweb.pro',
    });
    // Admin path routes ledger + audit through a single TransactWriteItems call
    // instead of userDb.updateUser (see llmUsageAdminCreditAudit.test.ts).
    expect(updateUser).not.toHaveBeenCalled();
    getUser.mockRestore();
    updateUser.mockRestore();
  });

  it('reverses a refunded purchase to its cumulative target exactly once', async () => {
    const purchaseLedger: MonthlyLlmUsageCredits = {
      month: '2026-08',
      totalPurchasedMicroUsd: 10_000_000,
      totalAdminGrantedMicroUsd: 0,
      totalMigrationOffsetMicroUsd: 0,
      grantIds: ['stripe:topup-1'],
      grants: [{
        id: 'stripe:topup-1', source: 'purchase', amountMicroUsd: 10_000_000,
        grantedAt: '2026-08-11T12:00:00.000Z',
      }],
    };
    const getUser = jest.spyOn(userDb, 'getUserById').mockResolvedValue({
      userId: 'u1', email: 'u1@agentweb.pro', llmUsageCredits: purchaseLedger,
    } as any);
    const updateUser = jest.spyOn(userDb, 'updateUser').mockResolvedValue({} as any);

    const result = await reverseMonthlyPurchasedLlmUsageCredit({
      billingUserId: 'u1',
      grantId: 'stripe:topup-1',
      reversalId: 'charge:ch_1:refunded:1250',
      targetReversedMicroUsd: 5_000_000,
      now: new Date('2026-08-11T13:00:00.000Z'),
    });

    expect(result.reversed).toBe(true);
    expect(getLlmUsageCreditAdjustment(result.ledger, '2026-08').purchasedMicroUsd).toBe(5_000_000);
    expect(result.ledger.reversals).toEqual([
      expect.objectContaining({ grantId: 'stripe:topup-1', amountMicroUsd: 5_000_000 }),
    ]);
    expect(updateUser).toHaveBeenCalledTimes(1);
    getUser.mockRestore();
    updateUser.mockRestore();
  });
});
