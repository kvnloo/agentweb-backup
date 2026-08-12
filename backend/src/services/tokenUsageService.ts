import { userDb, orgDb, User } from "./db";
import { getSubscriptionTypeConfig, getUserSubscriptionType } from "./subscriptionService";
import { inheritsOrgBilling } from "./orgAuthz";

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
  // Whether the cost cap is the ENFORCED gate right now (ENFORCE_COST_CAP). While
  // false the dollar figures are observe-only — we're gathering spend data to
  // decide the cost quota. UIs use this to know when a real cost denominator
  // exists: the customer-facing meter only surfaces cost once this is true.
  costEnforced: boolean;
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
}> {
  const subscriptionTypeName = await getUserSubscriptionType(userId);
  const config = await getSubscriptionTypeConfig(subscriptionTypeName);

  const baseAllowance = config?.monthlyTokenAllowance ?? null;
  const costAllowance = config?.monthlyCostAllowance ?? null;
  const user = await userDb.getUserById(userId);
  const bonus = user?.tokenAllowanceBonus || 0;

  if (baseAllowance === null || baseAllowance === undefined) {
    return { allowance: null, bonus, effectiveAllowance: null, costAllowance };
  }

  return {
    allowance: baseAllowance,
    bonus,
    effectiveAllowance: baseAllowance + bonus,
    costAllowance,
  };
}

/**
 * Check if a user can send messages. Returns usage status with warning/blocked flags.
 * For org members, quota is checked against the org owner's subscription and usage.
 */
export async function checkTokenUsage(userId: string): Promise<TokenUsageStatus> {
  const billingUserId = await resolveBillingUserId(userId);
  const usage = await getUserTokenUsage(billingUserId);
  const { allowance, bonus, effectiveAllowance, costAllowance } = await getUserTokenAllowance(
    billingUserId
  );

  // Two independent limits: token-count and dollar cost. The cost dimension is
  // what will eventually make higher-cost models (e.g. Fable) safe to enable — a
  // token-count cap alone can't bound dollar spend.
  //
  // Cost enforcement is OFF by default (observe-only): we accumulate and surface
  // per-user cost so we can gather real spend data before deciding to gate on it,
  // but we do NOT block users on cost yet. Token-count remains the only hard gate.
  // Per-model pricing is now normalized and accurate (ENG-207 — every model,
  // including Fable, is priced from the shared llmPricing book), so the dollar
  // figure is trustworthy. We still keep the cap observe-only until we've
  // validated real per-user spend against the shadow book. Flip
  // ENFORCE_COST_CAP=true to enable the cost cap; the enforcement path stays
  // tested below.
  const enforceCostCap = process.env.ENFORCE_COST_CAP === "true";

  const tokenPercentUsed = computePercentUsed(usage.totalTokens, effectiveAllowance);
  const costPercentUsed = computePercentUsed(usage.totalCost, costAllowance);

  const tokenAllowed = effectiveAllowance === null || tokenPercentUsed < 100;
  const costAllowed = costAllowance === null || costPercentUsed < 100;
  const allowed = tokenAllowed && (enforceCostCap ? costAllowed : true);

  const tokenWarning = effectiveAllowance !== null && tokenPercentUsed >= 80 && tokenPercentUsed < 100;
  // Only surface a cost warning to users when the cost cap is actually enforced —
  // otherwise we'd nag about a limit that can't block them.
  const costWarning =
    enforceCostCap && costAllowance !== null && costPercentUsed >= 80 && costPercentUsed < 100;

  return {
    allowed,
    warning: allowed && (tokenWarning || costWarning),
    used: usage.totalTokens,
    allowance,
    bonus,
    effectiveAllowance,
    percentUsed: effectiveAllowance === null ? 0 : tokenPercentUsed,
    month: usage.month,
    costUsed: usage.totalCost,
    costAllowance,
    costPercentUsed: costAllowance === null ? 0 : costPercentUsed,
    costEnforced: enforceCostCap,
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
}): { costCapTriggered: boolean; tokenCapTriggered: boolean; blockedByCost: boolean } {
  const costCapTriggered =
    status.costAllowance != null && (status.costPercentUsed ?? 0) >= 100;
  const effectiveTokenAllowance =
    status.effectiveAllowance != null ? status.effectiveAllowance : status.allowance;
  const tokenCapTriggered =
    effectiveTokenAllowance != null && (status.percentUsed ?? 0) >= 100;
  return {
    costCapTriggered,
    tokenCapTriggered,
    blockedByCost: costCapTriggered && !tokenCapTriggered,
  };
}

/**
 * Atomically increment a user's token usage for the current month.
 * For org members, usage is recorded on the org owner's account.
 * Performs lazy monthly reset if the stored month differs from current.
 */
export async function incrementUserTokenUsage(
  userId: string,
  tokens: number,
  cost: number
): Promise<void> {
  if (tokens <= 0 && cost <= 0) return;

  const currentMonth = getCurrentMonth();

  try {
    const billingUserId = await resolveBillingUserId(userId);
    // Try to read current user to check if we need a month reset
    const user = await userDb.getUserById(billingUserId);
    if (!user) return;

    const existingMonth = user.tokenUsage?.month;

    if (existingMonth !== currentMonth) {
      // New month — archive previous month to history, reset usage, clear bonus
      const prevUsage = user.tokenUsage;
      const existingHistory = user.tokenUsageHistory || [];
      let newHistory = existingHistory;
      if (prevUsage && prevUsage.month) {
        const entry = { month: prevUsage.month, totalTokens: prevUsage.totalTokens, totalCost: prevUsage.totalCost };
        newHistory = [...existingHistory, entry].slice(-24);
      }
      await userDb.updateUser(billingUserId, {
        tokenUsage: {
          month: currentMonth,
          totalTokens: tokens,
          totalCost: cost,
          resetDate: getNextResetDate(),
        },
        tokenAllowanceBonus: 0,
        tokenUsageHistory: newHistory,
      });
    } else {
      const updated = await userDb.incrementTokenUsageForMonth(
        billingUserId,
        currentMonth,
        tokens,
        cost,
        user.tokenUsage?.resetDate || getNextResetDate()
      );
      if (!updated) {
        console.warn(
          `[tokenUsageService] Skipped token increment for ${billingUserId}: tokenUsage month changed during update`
        );
      }
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
