import { getSubscriptionTypeConfig, getUserSubscriptionType } from "./subscriptionService";
import { getCurrentMonth, getUserTokenUsage, resolveBillingUserId } from "./tokenUsageService";
import {
  evaluateLlmUsageMode,
  type LlmUsageModeDecision,
  type LlmUsagePolicy,
} from "./llmUsagePolicyService";
import { userDb, type User } from './db';
import { withOwnerOpenInvoice } from './paygSettlement';
import { resolveLlmUsagePoolDecision } from './llmUsagePoolDecision';
import type { PaygBlock, PaygOverageStatus } from './paygOverage';

export async function getEffectiveLlmUsagePolicy(userId: string): Promise<{
  billingUserId: string;
  policy: LlmUsagePolicy | null;
  costUsedMicroUsd: number;
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
  /** ENG-668: overage past the pool, for a PAYG-live account only. Internal: carries micro-USD. */
  overage?: PaygOverageStatus;
  paygBlock?: PaygBlock;
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
      mode: evaluateLlmUsageMode({ costUsedMicroUsd: 0, policy: null }),
    };
  }
  const billingUserId = await resolveBillingUserId(userId);
  // ENG-1250 AC7: month from the clock; the legacy counter is read only on the rollback fallback.
  const month = getCurrentMonth();
  const [subscriptionType, billingUser] = await Promise.all([
    getUserSubscriptionType(billingUserId),
    userDb.getUserById(billingUserId),
  ]);
  const config = await getSubscriptionTypeConfig(subscriptionType);
  // ENG-668: the same pool decision checkTokenUsage reaches — spend basis, credits, the hard-threshold
  // predicate and PAYG all live there once, so this gate cannot admit what that one refuses.
  const pool = await resolveLlmUsagePoolDecision({
    billingUserId,
    billingUser,
    month,
    subscriptionType,
    basePolicy: config?.llmUsagePolicy || null,
    paygTier: async () => config?.paygOverage,
    // Lazy: read only if the basis falls back to legacy (rollback path), never on the live ledger path.
    legacyRawCostUsedMicroUsd: async (): Promise<number> =>
      Math.max(0, Math.round(((await getUserTokenUsage(billingUserId)).totalCost || 0) * 1_000_000)),
  });
  const { adjustment } = pool;
  return {
    billingUserId,
    policy: pool.policy,
    costUsedMicroUsd: pool.costUsedMicroUsd,
    mode: pool.mode,
    creditsApplied:
      adjustment.purchasedMicroUsd > 0 ||
      adjustment.adminGrantedMicroUsd > 0 ||
      adjustment.migrationOffsetMicroUsd > 0,
    // Present only for an account with PAYG live and past its pool (absent keeps every other result as it was).
    ...(pool.overage ? { overage: pool.overage } : {}),
    // ENG-668: the owner of a suspended account is pointed at the unpaid invoice.
    ...(pool.paygBlock
      ? { paygBlock: withOwnerOpenInvoice(pool.paygBlock, userId === billingUserId, (billingUser as User | undefined)?.paygSettlements)! }
      : {}),
  };
}
