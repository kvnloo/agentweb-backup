import { userDb } from './db';
import { readBilledLedgerRows } from './llmUsageLedgerReader';
import { getLlmUsageCreditAdjustment } from './llmUsageCreditService';
import { getSubscriptionTypeConfig, getUserSubscriptionType } from './subscriptionService';
import { getUserTokenUsage, resolveBillingUserId } from './tokenUsageService';
import { buildUsageCostReconciliation } from './usageCostReconciliation';

/** Read-only composition for the customer-visible cost-gate explanation. */
export async function resolveUsageCostReconciliation(userId: string) {
  const billingUserId = await resolveBillingUserId(userId);
  const [usage, billingUser, subscriptionType] = await Promise.all([
    getUserTokenUsage(billingUserId),
    userDb.getUserById(billingUserId),
    getUserSubscriptionType(billingUserId),
  ]);
  const config = await getSubscriptionTypeConfig(subscriptionType);
  const month = usage.month;
  const rows = await readBilledLedgerRows(billingUserId, `${month}-01`, `${month}-31`);
  const adjustment = getLlmUsageCreditAdjustment(billingUser?.llmUsageCredits, month);
  const ledgerMicroUsd = rows.reduce((total, row) => total + Math.max(0, Math.round(row.costMicroUsd || 0)), 0);

  return buildUsageCostReconciliation({
    billingUserId,
    month,
    rawCounterMicroUsd: Math.max(0, Math.round((usage.totalCost || 0) * 1_000_000)),
    ledgerMicroUsd,
    migrationOffsetMicroUsd: adjustment.migrationOffsetMicroUsd,
    purchasedCreditMicroUsd: adjustment.purchasedMicroUsd,
    adminCreditMicroUsd: adjustment.adminGrantedMicroUsd,
    hardThresholdMicroUsd: config?.llmUsagePolicy?.hardCostThresholdMicroUsd ?? null,
    tokenUsed: usage.totalTokens,
    tokenAllowance: config?.monthlyTokenAllowance ?? null,
  });
}
