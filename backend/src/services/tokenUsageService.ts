import { userDb, orgDb, User } from "./db";
import { getSubscriptionTypeConfig, getUserSubscriptionType } from "./subscriptionService";
import { inheritsOrgBilling } from "./orgAuthz";
import { evaluateLlmUsageMode, type LlmUsageMode, type LlmUsagePolicy } from "./llmUsagePolicyService";
import { applyLlmUsageCredits, getLlmUsageCreditAdjustment } from './llmUsageCreditService';
import { randomUUID } from 'crypto';
import { recordLlmChargeEvent, LLM_CHARGE_EVENTS_TABLE } from './llmChargeAuditDb';

export interface TokenUsageStatus {
  allowed: boolean;
  warning: boolean;
  used: number;
  allowance: number | null; // null = unlimited
  bonus: number;
  effectiveAllowance: number | null; // allowance + bonus, null = unlimited
  percentUsed: number; // 0-100+, 0 if unlimited (token dimension)
  month: string; // "YYYY-MM"
  // Cost-based limit (per-user monthly LLM spend cap in USD). Independent of the
  // token-count limit so that higher-cost models can be enabled without risking
  // runaway per-user spend (ENG-200).
  costUsed: number; // USD spent this month
  costAllowance: number | null; // null = unlimited
  costPercentUsed: number; // 0-100+, 0 if unlimited (cost dimension)
  // Whether the cost cap is the dimension actually gating THIS user right now.
  // Requires both ENFORCE_COST_CAP and a configured costAllowance — the flag alone
  // is not enough, because an unpriced tier falls back to its token cap (ENG-1116).
  // While false the dollar figures are observe-only. UIs use this to know which
  // dimension to render as the quota: true means a real cost denominator exists.
  costEnforced: boolean;
  usageMode?: LlmUsageMode;
  usagePolicyVersion?: string | null;
}

/**
 * For org members, returns the org owner's userId so that all quota checks
 * and usage increments are applied to the owner (the subscription holder).
 * Returns the original userId for solo users and org owners.
 */
export async function resolveBillingUserId(userId: string): Promise<string> {
  const user = await userDb.getUserById(userId);
  if (!user || !user.orgId) return userId;

  const org = await orgDb.getOrgById(user.orgId);
  if (!org) return userId;

  // Anchored on the billing root, not on a role. The previous test was
  // `user.orgRole !== "member"`, which treated "member" as a synonym for "not the
  // owner". With admins (or a second owner) that is false: they are not "member",
  // so usage stopped landing on the org counter and started burning their own
  // quota — silently. Everyone except the billing root pools onto it.
  // ENG-1084: a member holding their own live subscription no longer pools onto
  // the root — `inheritsOrgBilling` is now the single predicate entitlement and
  // quota both resolve through, so the two cannot drift a fourth time.
  if (
    !inheritsOrgBilling(
      { userId, orgId: user.orgId, subscription_status: user.subscription_status },
      org,
    )
  ) {
    return userId;
  }

  return org.ownerUserId;
}

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function getNextResetDate(): string {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return nextMonth.toISOString();
}

/**
 * Percent of an allowance consumed. Returns 0 for an unlimited (null) allowance.
 * For a zero allowance, any usage counts as 100% (fully consumed).
 */
function computePercentUsed(used: number, allowance: number | null): number {
  if (allowance === null || allowance === undefined) return 0;
  if (allowance > 0) return Math.round((used / allowance) * 100);
  return used > 0 ? 100 : 0;
}

/**
 * Get a user's current month token usage, performing lazy reset if month changed.
 */
export async function getUserTokenUsage(
  userId: string
): Promise<{ month: string; totalTokens: number; totalCost: number; bonus: number }> {
  const user = await userDb.getUserById(userId);
  if (!user) throw new Error(`User not found: ${userId}`);

  const currentMonth = getCurrentMonth();
  const usage = user.tokenUsage;

  // If no usage yet, or month has changed → treat as zero
  if (!usage || usage.month !== currentMonth) {
    return { month: currentMonth, totalTokens: 0, totalCost: 0, bonus: 0 };
  }

  return {
    month: currentMonth,
    totalTokens: usage.totalTokens || 0,
    totalCost: usage.totalCost || 0,
    bonus: user.tokenAllowanceBonus || 0,
  };
}

/**
 * Get the token allowance for a user based on their subscription type + bonus.
 */
export async function getUserTokenAllowance(
  userId: string
): Promise<{
  allowance: number | null;
  bonus: number;
  effectiveAllowance: number | null;
  costAllowance: number | null;
  llmUsagePolicy: LlmUsagePolicy | null;
}> {
  const subscriptionTypeName = await getUserSubscriptionType(userId);
  const config = await getSubscriptionTypeConfig(subscriptionTypeName);

  const baseAllowance = config?.monthlyTokenAllowance ?? null;
  const costAllowance = config?.monthlyCostAllowance ?? null;
  const llmUsagePolicy = config?.llmUsagePolicy ?? null;
  const user = await userDb.getUserById(userId);
  const bonus = user?.tokenAllowanceBonus || 0;

  if (baseAllowance === null || baseAllowance === undefined) {
    return { allowance: null, bonus, effectiveAllowance: null, costAllowance, llmUsagePolicy };
  }

  return {
    allowance: baseAllowance,
    bonus,
    effectiveAllowance: baseAllowance + bonus,
    costAllowance,
    llmUsagePolicy,
  };
}

/**
 * Check if a user can send messages. Returns usage status with warning/blocked flags.
 * For org members, quota is checked against the org owner's subscription and usage.
 */
export async function checkTokenUsage(userId: string): Promise<TokenUsageStatus> {
  const billingUserId = await resolveBillingUserId(userId);
  const usage = await getUserTokenUsage(billingUserId);
  const [{ allowance, bonus, effectiveAllowance, costAllowance, llmUsagePolicy }, billingUser] = await Promise.all([
    getUserTokenAllowance(billingUserId),
    userDb.getUserById(billingUserId),
  ]);

  // Two dimensions are measured — token-count and dollar cost — but only ONE of
  // them gates at a time. Dollars are the real unit of consumption: a token-count
  // cap cannot bound spend once models are priced differently (ENG-207), so a
  // token allowance sized for cheap models silently becomes either a giveaway or,
  // as happened here, a wall. ENFORCE_COST_CAP selects which dimension gates.
  //
  // ENG-1116 — this used to AND the two caps (cost as an *additional* limit).
  // It now REPLACES: with the flag on, cost gates and the token counter is
  // observe-only. Keeping the token cap live alongside cost would defeat the flip
  // entirely, because the token allowances are the thing being retired — four prod
  // users are already past them, one at 1600% of a Free tier's 3M.
  // Versioned admin policy is the explicit cost-gating switch. The legacy env
  // flag retains the same replacement semantics for tiers without a versioned
  // policy: when cost is gated, token volume is observe-only.
  // Cost enforcement is OFF by default (observe-only): we accumulate and surface
  // per-user cost so we can gather real spend data before deciding to gate on it,
  // but we do NOT block users on cost yet. Token-count remains the only hard gate.
  // Per-model pricing is now normalized and accurate (ENG-207 — every model,
  // including Fable, is priced from the shared llmPricing book), so the dollar
  // figure is trustworthy. We still keep the cap observe-only until we've
  // validated real per-user spend against the shadow book. Flip
  // ENFORCE_COST_CAP=true to enable the cost cap; the enforcement path stays
  // tested below.
  const versionedCostPolicyEnforced = !!llmUsagePolicy && llmUsagePolicy.enforcementState !== "observe";
  const enforceCostCap = versionedCostPolicyEnforced || process.env.ENFORCE_COST_CAP === "true";

  const rawCostUsedMicroUsd = Math.max(0, Math.round((usage.totalCost || 0) * 1_000_000));
  const creditAdjustment = getLlmUsageCreditAdjustment(billingUser?.llmUsageCredits, usage.month);
  const adjustedUsage = llmUsagePolicy
    ? applyLlmUsageCredits({
        rawCostUsedMicroUsd,
        hardThresholdMicroUsd: llmUsagePolicy.hardCostThresholdMicroUsd,
        adjustment: creditAdjustment,
      })
    : { policyCostUsedMicroUsd: rawCostUsedMicroUsd, effectiveHardThresholdMicroUsd: 0 };
  const effectiveLlmUsagePolicy = llmUsagePolicy
    ? { ...llmUsagePolicy, hardCostThresholdMicroUsd: adjustedUsage.effectiveHardThresholdMicroUsd }
    : null;
  const costUsedMicroUsd = adjustedUsage.policyCostUsedMicroUsd;
  const usageDecision = evaluateLlmUsageMode({
    costUsedMicroUsd,
    tokenUsed: usage.totalTokens,
    policy: effectiveLlmUsagePolicy,
  });
  const effectiveCostAllowance = versionedCostPolicyEnforced
    ? effectiveLlmUsagePolicy!.hardCostThresholdMicroUsd / 1_000_000
    : costAllowance;

  const tokenPercentUsed = computePercentUsed(usage.totalTokens, effectiveAllowance);
  const policyCostUsed = costUsedMicroUsd / 1_000_000;
  const costPercentUsed = computePercentUsed(policyCostUsed, effectiveCostAllowance);

  // A tier with no configured dollar allowance would become completely ungated the
  // moment the flag flips — a strictly worse failure than the cap being replaced.
  // Such tiers keep their token cap until someone prices them. That guard is also
  // what makes the rollout order-independent: this code can ship to prod, where
  // every tier is currently unpriced, and change nothing until the allowances land.
  const costIsGate = enforceCostCap && effectiveCostAllowance !== null;

  const tokenAllowed = effectiveAllowance === null || tokenPercentUsed < 100;
  const costAllowed = effectiveCostAllowance === null || costPercentUsed < 100;
  // Once a versioned cost policy is enforced, raw token volume is observe-only:
  // admission is governed exclusively by provider/model cost. Legacy rows retain
  // the old token gate until an admin explicitly saves a versioned policy.
  const allowed = versionedCostPolicyEnforced
    ? usageDecision.admissionAllowed
    : costIsGate
      ? costAllowed
      : tokenAllowed;

  // Warn only on the dimension that can actually block. Warning about an
  // observe-only cap is the same stale nag ENG-951 removed from customer surfaces.
  const tokenWarning =
    !costIsGate && effectiveAllowance !== null && tokenPercentUsed >= 80 && tokenPercentUsed < 100;
  const costWarning =
    costIsGate && costPercentUsed >= 80 && costPercentUsed < 100;

  return {
    allowed,
    warning: allowed && (tokenWarning || costWarning),
    used: usage.totalTokens,
    allowance,
    bonus,
    effectiveAllowance,
    percentUsed: effectiveAllowance === null ? 0 : tokenPercentUsed,
    month: usage.month,
    costUsed: versionedCostPolicyEnforced ? policyCostUsed : usage.totalCost,
    costAllowance: effectiveCostAllowance,
    costPercentUsed: effectiveCostAllowance === null ? 0 : costPercentUsed,
    costEnforced: costIsGate,
    usageMode: versionedCostPolicyEnforced ? usageDecision.usageMode : (allowed ? "full_choice" : "paused"),
    usagePolicyVersion: llmUsagePolicy?.version || null,
  };
}

/**
 * Given a usage status, determine whether a *block* was caused by the dollar cost
 * cap rather than the token-count cap (ENG-200). Shared by the scheduled-chat
 * block message (agentModeController) and its email (emailService) so both agree
 * on the reason — a user with an unlimited token allowance can only be blocked by
 * the cost cap, and the message must then read in dollars, not "0 / N/A tokens".
 *
 * Tolerant of partial status objects (the email caller passes a subset): a missing
 * effectiveAllowance falls back to allowance, and missing percentages read as 0.
 */
export function deriveBlockedByCost(status: {
  allowance?: number | null;
  effectiveAllowance?: number | null;
  percentUsed?: number;
  costAllowance?: number | null;
  costPercentUsed?: number;
  costEnforced?: boolean;
}): { costCapTriggered: boolean; tokenCapTriggered: boolean; blockedByCost: boolean } {
  const costCapTriggered =
    status.costAllowance != null && (status.costPercentUsed ?? 0) >= 100;
  const effectiveTokenAllowance =
    status.effectiveAllowance != null ? status.effectiveAllowance : status.allowance;
  const tokenCapTriggered =
    effectiveTokenAllowance != null && (status.percentUsed ?? 0) >= 100;

  // ENG-1116: when cost is the gate, the token counter cannot block anyone, so a
  // block over both caps is a COST block and must be worded in dollars. The old
  // `!tokenCapTriggered` veto was right only while the caps were ANDed — under
  // replacement it would tell a user they had run out of tokens, pointing them at
  // a limit that no longer exists. When cost is not the gate the original
  // attribution stands: a token block reads in tokens.
  const blockedByCost = status.costEnforced
    ? costCapTriggered
    : costCapTriggered && !tokenCapTriggered;

  return { costCapTriggered, tokenCapTriggered, blockedByCost };
}

/**
 * Atomically increment a user's token usage for the current month.
 * For org members, usage is recorded on the org owner's account.
 * Performs lazy monthly reset if the stored month differs from current.
 */
export async function incrementUserTokenUsage(
  userId: string,
  tokens: number,
  cost: number,
  audit?: { eventId?: string; model?: string; provider?: string; feature?: string; sessionId?: string }
): Promise<void> {
  if (tokens <= 0 && cost <= 0) return;

  const currentMonth = getCurrentMonth();

  try {
    const billingUserId = await resolveBillingUserId(userId);
    // Persist the evidence before changing the counter. A failed evidence write
    // therefore fails open (no surprise charge), while a retry with the same
    // event id is a no-op rather than a duplicate counter increment.
    //
    // ENG-1251 Greptile P1: the random fallback below only protects a caller
    // that truly has no stable identity for this charge. When the SAME usage
    // report is retried without an eventId, the fallback mints a fresh one
    // every time and the dedup above never fires — so callers that CAN supply
    // a real one must. The two highest-volume paths (agentModeService.callLLM,
    // chatbotService's chat turn) now pass the provider response's own id,
    // which is identical across a re-processed/retried response and distinct
    // across genuinely separate calls. Other callers (image/video/voice/deep
    // research/llmService) still fall through to the random default — each is
    // either structurally called at most once per success today or lacks a
    // verified stable id at the call site; tracked as a fast-follow rather
    // than guessed here.
    const occurredAt = new Date().toISOString();
    const eventId = audit?.eventId || `${occurredAt}#${randomUUID()}`;
    const isNewCharge = await recordLlmChargeEvent({
      billingUserId, eventId, occurredAt, actingUserId: userId,
      tokens: Math.max(0, Math.round(tokens)), costMicroUsd: Math.max(0, Math.round(cost * 1_000_000)),
      model: audit?.model, provider: audit?.provider, feature: audit?.feature, sessionId: audit?.sessionId,
    });
    if (!isNewCharge) return;

    // Apply the counter update and mark the audit event applied atomically —
    // either both land or neither does (ENG-1251 Greptile fix). Previously
    // these were two separate calls: a markLlmChargeApplied failure after a
    // successful counter update silently hid an applied charge from
    // itemization, and a lost concurrency race still marked the event
    // applied even though the counter was never touched. Bounded retry
    // against a fresh read handles a genuine concurrent writer (rollover or
    // same-month increment) the same way the old two-branch logic did.
    const MAX_ATTEMPTS = 3;
    let outcome: "applied" | "already_applied" | "lost_race" | "no_user" = "lost_race";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const user = await userDb.getUserById(billingUserId);
      if (!user || !user.email) {
        outcome = "no_user";
        break;
      }

      const existingMonth = user.tokenUsage?.month;
      const isNewMonth = existingMonth !== currentMonth;

      let history: Array<{ month: string; totalTokens: number; totalCost: number }> | undefined;
      if (isNewMonth) {
        // New month — archive previous month to history, reset usage, clear bonus.
        const prevUsage = user.tokenUsage;
        const existingHistory = user.tokenUsageHistory || [];
        history = existingHistory;
        if (prevUsage && prevUsage.month) {
          const entry = { month: prevUsage.month, totalTokens: prevUsage.totalTokens, totalCost: prevUsage.totalCost };
          history = [...existingHistory, entry].slice(-24);
        }
      }

      outcome = await userDb.applyMonthlyChargeAtomic({
        userId: billingUserId,
        userEmail: user.email,
        month: currentMonth,
        tokens,
        cost,
        resetDate: isNewMonth ? getNextResetDate() : (user.tokenUsage?.resetDate || getNextResetDate()),
        isNewMonth,
        history,
        auditTableName: LLM_CHARGE_EVENTS_TABLE,
        billingUserId,
        eventId,
      });

      if (outcome === "applied" || outcome === "already_applied") break;
      // outcome === "lost_race": another writer rolled the month or incremented
      // this user concurrently — re-read fresh state and retry.
    }

    if (outcome === "lost_race") {
      // Exhausted retries under real contention. Fail open, per the same
      // contract recordLlmChargeEvent already documents: the counter is NOT
      // incremented, and the audit event is left unmarked rather than
      // falsely claiming the charge was applied.
      console.warn(
        `[tokenUsageService] Failed to atomically apply charge for ${billingUserId} after ${MAX_ATTEMPTS} attempts ` +
        `(eventId=${eventId}): concurrent writers kept winning the race. Charge NOT counted.`
      );
    }
  } catch (error) {
    // Don't block message flow on usage tracking failures
    console.error(`[tokenUsageService] Failed to increment usage for ${userId}:`, error);
  }
}

// ─── Extra Cost Usage ─────────────────────────────────────────────────────────
// Tracks non-token API costs (Google Search, enrichment, image gen, etc.) per
// user per month. Uses the same lazy-reset + 24-month history pattern as tokens.

export interface ExtraCostUsageStatus {
  allowed: boolean;
  warning: boolean;
  used: number;       // USD spent this month
  allowance: number | null; // null = unlimited
  percentUsed: number;
  month: string;
}

/**
 * Get a user's current month extra cost usage, with lazy reset if month changed.
 */
export async function getUserExtraCostUsage(
  userId: string
): Promise<{ month: string; totalCost: number; breakdown: Record<string, number> }> {
  const user = await userDb.getUserById(userId);
  if (!user) throw new Error(`User not found: ${userId}`);

  const currentMonth = getCurrentMonth();
  const usage = user.extraCostUsage;

  if (!usage || usage.month !== currentMonth) {
    return { month: currentMonth, totalCost: 0, breakdown: {} };
  }

  return {
    month: currentMonth,
    totalCost: usage.totalCost || 0,
    breakdown: usage.breakdown || {},
  };
}

/**
 * Check if a user can incur more extra cost this month.
 * For org members, quota is checked against the org owner's subscription and usage.
 */
export async function checkExtraCostUsage(userId: string): Promise<ExtraCostUsageStatus> {
  const billingUserId = await resolveBillingUserId(userId);
  const usage = await getUserExtraCostUsage(billingUserId);
  const subscriptionTypeName = await getUserSubscriptionType(billingUserId);
  const config = await getSubscriptionTypeConfig(subscriptionTypeName);
  const allowance = config?.monthlyExtraCostAllowance ?? null;

  if (allowance === null || allowance === undefined) {
    return {
      allowed: true,
      warning: false,
      used: usage.totalCost,
      allowance: null,
      percentUsed: 0,
      month: usage.month,
    };
  }

  const percentUsed =
    allowance > 0
      ? Math.round((usage.totalCost / allowance) * 100)
      : usage.totalCost > 0
      ? 100
      : 0;

  return {
    allowed: percentUsed < 100,
    warning: percentUsed >= 80 && percentUsed < 100,
    used: usage.totalCost,
    allowance,
    percentUsed,
    month: usage.month,
  };
}

/**
 * Atomically increment extra cost usage for the current month.
 * For org members, usage is recorded on the org owner's account.
 * @param breakdown - keyed costs to add (e.g. { enrichment: 0.52 })
 */
export async function incrementExtraCostUsage(
  userId: string,
  breakdown: Record<string, number>
): Promise<void> {
  const totalNew = Object.values(breakdown).reduce((s, v) => s + v, 0);
  if (totalNew <= 0) return;

  const currentMonth = getCurrentMonth();

  try {
    const billingUserId = await resolveBillingUserId(userId);
    const user = await userDb.getUserById(billingUserId);
    if (!user) return;

    const existingMonth = user.extraCostUsage?.month;

    if (existingMonth !== currentMonth) {
      // New month — archive previous, reset
      const prevUsage = user.extraCostUsage;
      const existingHistory = user.extraCostUsageHistory || [];
      let newHistory = existingHistory;
      if (prevUsage && prevUsage.month) {
        const entry = { month: prevUsage.month, totalCost: prevUsage.totalCost, breakdown: prevUsage.breakdown };
        newHistory = [...existingHistory, entry].slice(-24);
      }
      await userDb.updateUser(billingUserId, {
        extraCostUsage: {
          month: currentMonth,
          totalCost: totalNew,
          breakdown: { ...breakdown },
          resetDate: getNextResetDate(),
        },
        extraCostUsageHistory: newHistory,
      });
    } else {
      // Same month — merge breakdown and increment total
      const prevBreakdown = user.extraCostUsage?.breakdown || {};
      const mergedBreakdown: Record<string, number> = { ...prevBreakdown };
      for (const [key, val] of Object.entries(breakdown)) {
        mergedBreakdown[key] = (mergedBreakdown[key] || 0) + val;
      }
      await userDb.updateUser(billingUserId, {
        extraCostUsage: {
          month: currentMonth,
          totalCost: (user.extraCostUsage?.totalCost || 0) + totalNew,
          breakdown: mergedBreakdown,
          resetDate: user.extraCostUsage?.resetDate || getNextResetDate(),
        },
      });
    }
  } catch (error) {
    console.error(`[tokenUsageService] Failed to increment extra cost for ${userId}:`, error);
  }
}

/**
 * Grant bonus tokens to a user (additive to any existing bonus).
 */
export async function grantTokenBonus(
  userId: string,
  bonusTokens: number
): Promise<void> {
  const user = await userDb.getUserById(userId);
  if (!user) throw new Error(`User not found: ${userId}`);

  const currentBonus = user.tokenAllowanceBonus || 0;
  await userDb.updateUser(userId, {
    tokenAllowanceBonus: currentBonus + bonusTokens,
  });
}
