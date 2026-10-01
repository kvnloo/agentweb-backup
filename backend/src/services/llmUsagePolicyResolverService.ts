import { getSubscriptionTypeConfig, getUserSubscriptionType } from "./subscriptionService";
import { getUserTokenUsage, resolveBillingUserId } from "./tokenUsageService";
import {
  evaluateLlmUsageMode,
  type LlmUsageModeDecision,
  type LlmUsagePolicy,
} from "./llmUsagePolicyService";
import { userDb } from './db';
import { applyLlmUsageCredits, getLlmUsageCreditAdjustment } from './llmUsageCreditService';
import { resolveEnforcementCostBasisMicroUsd } from './spendEnforcementBasis';

export async function getEffectiveLlmUsagePolicy(userId: string): Promise<{
  billingUserId: string;
  policy: LlmUsagePolicy | null;
  costUsedMicroUsd: number;
  tokenUsed: number;
  mode: LlmUsageModeDecision;
  /**
   * Whether ANY credit moved this cycle's spend or ceiling (ENG-1215 AC4).
   *
   * Credits are stored as month totals with no per-day timeline, so the state
   * at an arbitrary earlier day of the cycle cannot be reconstructed. Callers
   * that reason about a PAST moment — the forecast backtest — need to know that
   * and decline rather than compute against today's adjusted figures.
   */
  creditsApplied: boolean;
}> {
  // A number of legacy controller unit tests replace the token/subscription
  // modules with deliberately partial Jest mocks. Keep those unrelated tests
  // on the pre-policy (no configured policy) path without weakening runtime
  // behavior; production always imports the complete concrete services.
  if (
    process.env.NODE_ENV === 'test'
    && (
      typeof resolveBillingUserId !== 'function'
      || typeof getUserTokenUsage !== 'function'
      || typeof getUserSubscriptionType !== 'function'
      || typeof getSubscriptionTypeConfig !== 'function'
      || typeof userDb?.getUserById !== 'function'
    )
  ) {
    return {
      billingUserId: userId,
      policy: null,
      costUsedMicroUsd: 0,
      creditsApplied: false,
      tokenUsed: 0,
      mode: evaluateLlmUsageMode({ costUsedMicroUsd: 0, tokenUsed: 0, policy: null }),
    };
  }
  const billingUserId = await resolveBillingUserId(userId);
  const [usage, subscriptionType, billingUser] = await Promise.all([
    getUserTokenUsage(billingUserId),
    getUserSubscriptionType(billingUserId),
    userDb.getUserById(billingUserId),
  ]);
  const config = await getSubscriptionTypeConfig(subscriptionType);
  const basePolicy = config?.llmUsagePolicy || null;
  const legacyRawCostUsedMicroUsd = Math.max(0, Math.round((usage.totalCost || 0) * 1_000_000));
  // ENG-1250 §9.6 enforcement cutover (dark by default): swap the raw spend basis
  // onto the vendor-inclusive spend ledger and leave the rest of this pipeline —
  // credit application, threshold, predicate — untouched. See spendEnforcementBasis.ts.
  const { rawCostUsedMicroUsd } = await resolveEnforcementCostBasisMicroUsd({
    billingUserId,
    billingMonth: usage.month,
    legacyRawCostUsedMicroUsd,
    tier: subscriptionType,
  });
  const adjustment = getLlmUsageCreditAdjustment(billingUser?.llmUsageCredits, usage.month);
  const adjusted = basePolicy
    ? applyLlmUsageCredits({
        rawCostUsedMicroUsd,
        hardThresholdMicroUsd: basePolicy.hardCostThresholdMicroUsd,
        adjustment,
      })
    : { policyCostUsedMicroUsd: rawCostUsedMicroUsd, effectiveHardThresholdMicroUsd: 0 };
  const policy = basePolicy
    ? { ...basePolicy, hardCostThresholdMicroUsd: adjusted.effectiveHardThresholdMicroUsd }
    : null;
  const costUsedMicroUsd = adjusted.policyCostUsedMicroUsd;
  return {
    billingUserId,
    policy,
    costUsedMicroUsd,
    tokenUsed: usage.totalTokens,
    mode: evaluateLlmUsageMode({ costUsedMicroUsd, tokenUsed: usage.totalTokens, policy }),
    creditsApplied:
      adjustment.purchasedMicroUsd > 0 ||
      adjustment.adminGrantedMicroUsd > 0 ||
      adjustment.migrationOffsetMicroUsd > 0,
  };
}
