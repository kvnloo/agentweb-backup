/**
 * ENG-668 PR-2 — the settlement amount is the gate's own measurement.
 *
 * `computePaygSettlementAmount` must bill exactly the overage the gates admitted the customer into: for
 * the same spend, credits, pool mark, opt-in and cap it has to reach the same overage, cap and pool as
 * `resolveLlmUsagePoolDecision` (the one decision both gates share). These run the real gate pipeline
 * next to settlement over identical inputs, so a second derivation drifting from the first fails here.
 */
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), getUserByIdConsistent: jest.fn(), updateUser: jest.fn() },
}));
jest.mock('../services/spendEnforcementBasis', () => ({ resolveEnforcementCostBasisMicroUsd: jest.fn() }));
jest.mock('../services/paygOverageService', () => ({ paygOverageSwitch: { isEnabled: jest.fn(async () => true) } }));

import { userDb } from '../services/db';
import { resolveEnforcementCostBasisMicroUsd } from '../services/spendEnforcementBasis';
import { resolveLlmUsagePoolDecision } from '../services/llmUsagePoolDecision';
import { getCurrentUsageMonth, type MonthlyLlmUsageCredits } from '../services/llmUsageCreditService';
import { getCurrentMonth } from '../services/tokenUsageService';
import { withPaygAdmission, type PaygAdmittedMonth, type PaygOverageSettings } from '../services/paygOverage';
import type { UpdateUserOptions } from './helpers/userRowFake';
import {
  computePaygSettlementAmount,
  paygSettlementIdempotencyKey,
  paygSettlementMonthsToPrune,
  paygMonthInputsFromRow,
  previousUsageMonth,
  type PaygSettlement,
} from '../services/paygSettlement';

const USD = 1_000_000;
const policy = {
  version: 'pro',
  enforcementState: 'hard_only' as const,
  optimizationCostThresholdMicroUsd: 50 * USD,
  hardCostThresholdMicroUsd: 100 * USD,
  optimizedModelIds: ['gpt-5-chat-2'],
  optimizedDefaultModel: 'gpt-5-chat-2',
};

describe('ENG-668 settlement amount = the gate\'s measurement', () => {
  const month = getCurrentUsageMonth();
  const account = (over: Partial<PaygOverageSettings> = {}): PaygOverageSettings => ({
    enabled: true,
    capPercentOfPool: 50,
    poolHighWater: { month, thresholdMicroUsd: 100 * USD },
    updatedBy: 'u1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...over,
  });
  const credits = (purchasedUsd: number, adminUsd = 0, migrationUsd = 0): MonthlyLlmUsageCredits => ({
    month: getCurrentMonth(),
    totalPurchasedMicroUsd: purchasedUsd * USD,
    totalAdminGrantedMicroUsd: adminUsd * USD,
    totalMigrationOffsetMicroUsd: migrationUsd * USD,
    grantIds: purchasedUsd ? ['seat-credit:org-1'] : [],
    grants: purchasedUsd
      ? [{ id: `seat-credit:org-1:${month}`, source: 'purchase', amountMicroUsd: purchasedUsd * USD, grantedAt: '2026-01-01T00:00:00.000Z' }]
      : [],
  });

  const cases: Array<[string, { spendUsd: number; account: PaygOverageSettings; credits?: MonthlyLlmUsageCredits }]> = [
    ['plain overage', { spendUsd: 130, account: account() }],
    ['an opt-in baseline', { spendUsd: 130, account: account({ optIn: { month, overageBaselineMicroUsd: 12 * USD, poolAtOptInMicroUsd: 100 * USD } }) }],
    ['a baseline shrunk by pool growth', { spendUsd: 150, account: account({ optIn: { month, overageBaselineMicroUsd: 15 * USD, poolAtOptInMicroUsd: 90 * USD } }) }],
    ['a higher high-water mark (downgrade)', { spendUsd: 140, account: account({ poolHighWater: { month, thresholdMicroUsd: 120 * USD } }) }],
    ['seat, admin and migration credit', { spendUsd: 160, account: account(), credits: credits(20, 5, 3) }],
    ['the 25% cap', { spendUsd: 120, account: account({ capPercentOfPool: 25 }) }],
    ['sub-cent spend', { spendUsd: 117.123457, account: account({ capPercentOfPool: 200 }) }],
  ];

  it.each(cases)('%s', async (_name, input) => {
    (resolveEnforcementCostBasisMicroUsd as jest.Mock).mockResolvedValue({ rawCostUsedMicroUsd: Math.round(input.spendUsd * USD), basis: 'spend_ledger' });
    const owner = {
      paygOverage: input.account,
      llmUsageCredits: input.credits,
      has_payment_method: true,
      subscription_status: 'active',
    };
    (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValue(owner);
    // Keep what the gate writes: the high-water mark it raises and the admission record settlement bills from.
    const written: Record<string, unknown> = {};
    (userDb.updateUser as jest.Mock).mockImplementation(async (_id: string, _fields: unknown, options: UpdateUserOptions | undefined) => {
      for (const { path, value } of options?.pathSets ?? []) written[path[1]] = value;
      return {};
    });

    const gate = await resolveLlmUsagePoolDecision({
      billingUserId: 'u1',
      billingUser: owner,
      month: getCurrentMonth(),
      subscriptionType: 'Pro',
      basePolicy: policy,
      paygTier: async () => ({ allowed: true, markupBps: 10_000 }),
      legacyRawCostUsedMicroUsd: async () => 0,
      recordAdmission: true,
    });
    expect(gate.mode.reason).toBe('payg_overage');
    expect(written.admittedMonths).toEqual([{
      month, capHighWaterMicroUsd: gate.overage!.capMicroUsd, tierPoolHighWaterMicroUsd: 100 * USD, markupBps: 10_000, spendBasis: 'spend_ledger',
    }]);

    const afterGate = { ...input.account, ...written } as PaygOverageSettings;
    const settled = computePaygSettlementAmount({
      month,
      admitted: afterGate.admittedMonths![0],
      inputs: paygMonthInputsFromRow({ llmUsageCredits: input.credits, paygOverage: afterGate }, month, month)!,
      settledMicroUsd: Math.round(input.spendUsd * USD),
    })!;
    expect(settled.netOverageMicroUsd).toBe(gate.overage!.overageMicroUsd);
    expect(settled.poolMicroUsd).toBe(gate.overage!.poolMicroUsd);
    expect(settled.capMicroUsd).toBe(gate.overage!.capMicroUsd);
    expect(settled.overageCostMicroUsd).toBe(Math.min(gate.overage!.overageMicroUsd, gate.overage!.capMicroUsd));
  });

  const admittedAt = (over: Partial<PaygAdmittedMonth> = {}): PaygAdmittedMonth => ({
    month, capHighWaterMicroUsd: 50 * USD, tierPoolHighWaterMicroUsd: 100 * USD, markupBps: 15_000, spendBasis: 'spend_ledger', ...over,
  });
  const noCredits = { purchasedMicroUsd: 0, adminGrantedMicroUsd: 0, migrationOffsetMicroUsd: 0 };
  const plain = { credits: noCredits, poolHighWater: { month, thresholdMicroUsd: 100 * USD } };

  it('is null (hold, never guess) without a usable pool, cap, price or baseline', () => {
    const base = { month, inputs: plain, settledMicroUsd: 130 * USD };
    expect(computePaygSettlementAmount({ ...base, admitted: admittedAt({ tierPoolHighWaterMicroUsd: 0 }) })).toBeNull();
    expect(computePaygSettlementAmount({ ...base, admitted: admittedAt({ capHighWaterMicroUsd: 0 }) })).toBeNull();
    expect(computePaygSettlementAmount({ ...base, admitted: admittedAt({ markupBps: null }) })).toBeNull();
    expect(computePaygSettlementAmount({ ...base, admitted: admittedAt({ markupBps: 9_999 }) })).toBeNull();
    expect(computePaygSettlementAmount({
      ...base, admitted: admittedAt(), inputs: { ...plain, optIn: { month, overageBaselineMicroUsd: Number.NaN } },
    })).toBeNull();
  });

  it('applies the markup to the capped cost and rounds down to whole cents', () => {
    const amount = computePaygSettlementAmount({
      month, admitted: admittedAt({ markupBps: 12_345 }), inputs: plain, settledMicroUsd: 133_333_333,
    })!;
    // 33.333333 x 1.2345 = 41.149999... -> 41_149_999 micro-USD -> 4114 cents.
    expect(amount).toMatchObject({ overageCostMicroUsd: 33_333_333, billedMicroUsd: 41_149_999, amountCents: 4114, percentOfCap: 66 });
  });

  it('reads the closed month\'s mark and opt-in from the row, not the new month\'s', () => {
    const row = {
      paygOverage: account({
        poolHighWater: { month: '2026-10', thresholdMicroUsd: 80 * USD },
        poolHighWaterClosed: { month: '2026-09', thresholdMicroUsd: 110 * USD },
        optIn: { month: '2026-10', overageBaselineMicroUsd: 0 },
        optInClosed: { month: '2026-09', overageBaselineMicroUsd: 5 * USD, poolAtOptInMicroUsd: 110 * USD },
      }),
    };
    const amount = computePaygSettlementAmount({
      month: '2026-09',
      admitted: { month: '2026-09', capHighWaterMicroUsd: 55 * USD, tierPoolHighWaterMicroUsd: 100 * USD, markupBps: 10_000, spendBasis: 'spend_ledger' },
      inputs: paygMonthInputsFromRow(row, '2026-09', '2026-09')!,
      settledMicroUsd: 130 * USD,
    })!;
    // Pool $110 (closed mark), $20 gross - $5 baseline = $15.
    expect(amount.poolMicroUsd).toBe(110 * USD);
    expect(amount.overageCostMicroUsd).toBe(15 * USD);
  });

  it('the row\'s inputs are trusted only for the month that just closed (older ones are gone from the row)', () => {
    const row = { paygOverage: account() };
    expect(paygMonthInputsFromRow(row, '2026-09', '2026-09')).not.toBeNull();
    expect(paygMonthInputsFromRow(row, '2026-08', '2026-09')).toBeNull();
  });
});

describe('ENG-668 admission record merge', () => {
  const sept: PaygAdmittedMonth = { month: '2026-09', capHighWaterMicroUsd: 50 * USD, tierPoolHighWaterMicroUsd: 100 * USD, markupBps: 15_000, spendBasis: 'spend_ledger' };
  it('writes nothing when an admission changes nothing, and only ever moves toward the customer', () => {
    expect(withPaygAdmission([sept], { ...sept, capHighWaterMicroUsd: 40 * USD, markupBps: 20_000 })).toBeNull();
    expect(withPaygAdmission([sept], { ...sept, capHighWaterMicroUsd: 60 * USD, markupBps: 20_000 }))
      .toEqual([{ ...sept, capHighWaterMicroUsd: 60 * USD }]);
    expect(withPaygAdmission([sept], { ...sept, tierPoolHighWaterMicroUsd: 90 * USD, markupBps: 12_000 }))
      .toEqual([{ ...sept, markupBps: 12_000 }]);
  });
  it('a new month goes first and 13 months are kept (the current one and settlement\'s 12-month window)', () => {
    const months = Array.from({ length: 13 }, (_, i) => ({ ...sept, month: `2025-${String(i % 12 + 1).padStart(2, '0')}-${i}` }));
    const nov = { ...sept, month: '2026-11' };
    const next = withPaygAdmission(months, nov)!;
    expect(next).toHaveLength(13);
    expect(next[0]).toEqual(nov);
    expect(next[12]).toEqual(months[11]);
  });
});

describe('ENG-668 settlement helpers', () => {
  it('previousUsageMonth crosses the year in UTC', () => {
    expect(previousUsageMonth(new Date('2026-10-02T00:00:00.000Z'))).toBe('2026-09');
    expect(previousUsageMonth(new Date('2027-01-02T23:59:59.000Z'))).toBe('2026-12');
  });

  it('keeps the month being written and the 11 before it', () => {
    const stored = Object.fromEntries(['2025-08', '2025-09', '2025-10', '2026-08'].map((m) => [m, {} as PaygSettlement]));
    expect(paygSettlementMonthsToPrune(stored, '2026-09').sort()).toEqual(['2025-08', '2025-09']);
    expect(paygSettlementMonthsToPrune(undefined, '2026-09')).toEqual([]);
  });

  it('one idempotency key per owner per month', () => {
    expect(paygSettlementIdempotencyKey('u1', '2026-09')).toBe('payg:u1:2026-09');
  });
});
