/**
 * Read-model math for explaining the two cost rails without changing either.
 * The admission counter remains authoritative; the legacy usage ledger is
 * reported alongside it so drift is visible instead of silently normalized.
 */
export interface UsageCostReconciliationInput {
  billingUserId: string;
  month: string;
  rawCounterMicroUsd: number;
  ledgerMicroUsd: number;
  migrationOffsetMicroUsd: number;
  purchasedCreditMicroUsd: number;
  adminCreditMicroUsd: number;
  hardThresholdMicroUsd: number | null;
  tokenUsed?: number;
  tokenAllowance?: number | null;
}

const wholeMicroUsd = (value: number) => Math.max(0, Math.round(value || 0));

export function buildUsageCostReconciliation(input: UsageCostReconciliationInput) {
  const rawCounterMicroUsd = wholeMicroUsd(input.rawCounterMicroUsd);
  const ledgerMicroUsd = wholeMicroUsd(input.ledgerMicroUsd);
  const migrationOffsetMicroUsd = wholeMicroUsd(input.migrationOffsetMicroUsd);
  const purchasedCreditMicroUsd = wholeMicroUsd(input.purchasedCreditMicroUsd);
  const adminCreditMicroUsd = wholeMicroUsd(input.adminCreditMicroUsd);
  const policyCostMicroUsd = Math.max(0, rawCounterMicroUsd - migrationOffsetMicroUsd);
  const configuredThreshold = input.hardThresholdMicroUsd === null
    ? null
    : wholeMicroUsd(input.hardThresholdMicroUsd);
  const effectiveHardThresholdMicroUsd = configuredThreshold === null
    ? null
    : configuredThreshold + purchasedCreditMicroUsd + adminCreditMicroUsd;
  const tokenUsed = Math.max(0, Math.round(input.tokenUsed || 0));
  const tokenAllowance = input.tokenAllowance == null ? null : Math.max(0, Math.round(input.tokenAllowance));
  const tokenPercentUsed = tokenAllowance && tokenAllowance > 0
    ? Number(((tokenUsed / tokenAllowance) * 100).toFixed(2))
    : 0;

  return {
    billingUserId: input.billingUserId,
    month: input.month,
    adjustments: { migrationOffsetMicroUsd, purchasedCreditMicroUsd, adminCreditMicroUsd },
    gate: {
      dimension: configuredThreshold === null ? 'token' : 'cost',
      state: configuredThreshold === null
        ? 'not_cost_enforced'
        : policyCostMicroUsd >= effectiveHardThresholdMicroUsd! ? 'paused' : 'full_choice',
      rawCounterMicroUsd,
      policyCostMicroUsd,
      effectiveHardThresholdMicroUsd,
    },
    token: { used: tokenUsed, allowance: tokenAllowance, percentUsed: tokenPercentUsed, enforced: false },
    divergence: {
      microUsd: Math.abs(rawCounterMicroUsd - ledgerMicroUsd),
      exceedsOneCent: Math.abs(rawCounterMicroUsd - ledgerMicroUsd) > 10_000,
    },
  };
}
