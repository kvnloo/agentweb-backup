import { buildUsageCostReconciliation } from '../services/usageCostReconciliation';

const USD = 1_000_000;

describe('buildUsageCostReconciliation', () => {
  it('explains a pooled cost-gate pause from raw counter, migration offset, and policy threshold', () => {
    expect(buildUsageCostReconciliation({
      billingUserId: 'founders', month: '2026-08', rawCounterMicroUsd: 1_335.5651201 * USD,
      ledgerMicroUsd: 293.82 * USD, migrationOffsetMicroUsd: 1_182.850077 * USD,
      purchasedCreditMicroUsd: 0, adminCreditMicroUsd: 0, hardThresholdMicroUsd: 150 * USD,
    })).toMatchObject({
      billingUserId: 'founders', month: '2026-08', gate: { dimension: 'cost', state: 'paused', policyCostMicroUsd: 152_715_043 },
      divergence: { microUsd: 1_041_745_120, exceedsOneCent: true },
    });
  });

  it('reports token observation separately so a low token percentage cannot disguise a cost pause', () => {
    expect(buildUsageCostReconciliation({
      billingUserId: 'owner', month: '2026-08', rawCounterMicroUsd: 151 * USD, ledgerMicroUsd: 151 * USD,
      migrationOffsetMicroUsd: 0, purchasedCreditMicroUsd: 0, adminCreditMicroUsd: 0, hardThresholdMicroUsd: 150 * USD,
      tokenUsed: 543_600_000, tokenAllowance: 1_500_000_000,
    }).token).toEqual({ used: 543_600_000, allowance: 1_500_000_000, percentUsed: 36.24, enforced: false });
  });

  it('keeps migration offsets visible without rewriting raw spend or the ledger divergence', () => {
    const report = buildUsageCostReconciliation({
      billingUserId: 'owner', month: '2026-08', rawCounterMicroUsd: 100 * USD, ledgerMicroUsd: 99.995 * USD,
      migrationOffsetMicroUsd: 40 * USD, purchasedCreditMicroUsd: 10 * USD, adminCreditMicroUsd: 5 * USD,
      hardThresholdMicroUsd: 150 * USD,
    });
    expect(report.adjustments).toEqual({ migrationOffsetMicroUsd: 40 * USD, purchasedCreditMicroUsd: 10 * USD, adminCreditMicroUsd: 5 * USD });
    expect(report.gate).toMatchObject({ rawCounterMicroUsd: 100 * USD, policyCostMicroUsd: 60 * USD, effectiveHardThresholdMicroUsd: 165 * USD, state: 'full_choice' });
    expect(report.divergence).toEqual({ microUsd: 5_000, exceedsOneCent: false });
  });

  it('marks an unconfigured cost policy as observational instead of inventing a paused state', () => {
    expect(buildUsageCostReconciliation({
      billingUserId: 'owner', month: '2026-08', rawCounterMicroUsd: 500 * USD, ledgerMicroUsd: 500 * USD,
      migrationOffsetMicroUsd: 0, purchasedCreditMicroUsd: 0, adminCreditMicroUsd: 0, hardThresholdMicroUsd: null,
    }).gate).toMatchObject({ dimension: 'token', state: 'not_cost_enforced', policyCostMicroUsd: 500 * USD });
  });
});
