import { getSubscriptionTypeConfig, getUserSubscriptionType } from "./subscriptionService";
import { getUserTokenUsage, resolveBillingUserId } from "./tokenUsageService";
import {
  evaluateLlmUsageMode,
  type LlmUsageModeDecision,
  type LlmUsagePolicy,
} from "./llmUsagePolicyService";
import { userDb } from './db';
import { applyLlmUsageCredits, getLlmUsageCreditAdjustment } from './llmUsageCreditService';

export async function getEffectiveLlmUsagePolicy(userId: string): Promise<{
  billingUserId: string;
  policy: LlmUsagePolicy | null;
  costUsedMicroUsd: number;
  tokenUsed: number;
  mode: LlmUsageModeDecision;
}> {
  const billingUserId = await resolveBillingUserId(userId);
  const [usage, subscriptionType, billingUser] = await Promise.all([
    getUserTokenUsage(billingUserId),
    getUserSubscriptionType(billingUserId),
    userDb.getUserById(billingUserId),
  ]);
  const config = await getSubscriptionTypeConfig(subscriptionType);
  const basePolicy = config?.llmUsagePolicy || null;
  const rawCostUsedMicroUsd = Math.max(0, Math.round((usage.totalCost || 0) * 1_000_000));
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
  };
}
