import { userDb, User } from "./db";
import { getSubscriptionTypeConfig, getUserSubscriptionType } from "./subscriptionService";

export interface TokenUsageStatus {
  allowed: boolean;
  warning: boolean;
  used: number;
  allowance: number | null; // null = unlimited
  bonus: number;
  effectiveAllowance: number | null; // allowance + bonus, null = unlimited
  percentUsed: number; // 0-100+, 0 if unlimited
  month: string; // "YYYY-MM"
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
): Promise<{ allowance: number | null; bonus: number; effectiveAllowance: number | null }> {
  const subscriptionTypeName = await getUserSubscriptionType(userId);
  const config = await getSubscriptionTypeConfig(subscriptionTypeName);

  const baseAllowance = config?.monthlyTokenAllowance ?? null;
  const user = await userDb.getUserById(userId);
  const bonus = user?.tokenAllowanceBonus || 0;

  if (baseAllowance === null || baseAllowance === undefined) {
    return { allowance: null, bonus, effectiveAllowance: null };
  }

  return {
    allowance: baseAllowance,
    bonus,
    effectiveAllowance: baseAllowance + bonus,
  };
}

/**
 * Check if a user can send messages. Returns usage status with warning/blocked flags.
 */
export async function checkTokenUsage(userId: string): Promise<TokenUsageStatus> {
  const usage = await getUserTokenUsage(userId);
  const { allowance, bonus, effectiveAllowance } = await getUserTokenAllowance(userId);

  // Unlimited
  if (effectiveAllowance === null) {
    return {
      allowed: true,
      warning: false,
      used: usage.totalTokens,
      allowance,
      bonus,
      effectiveAllowance,
      percentUsed: 0,
      month: usage.month,
    };
  }

  const percentUsed =
    effectiveAllowance > 0
      ? Math.round((usage.totalTokens / effectiveAllowance) * 100)
      : usage.totalTokens > 0
      ? 100
      : 0;

  return {
    allowed: percentUsed < 100,
    warning: percentUsed >= 80 && percentUsed < 100,
    used: usage.totalTokens,
    allowance,
    bonus,
    effectiveAllowance,
    percentUsed,
    month: usage.month,
  };
}

/**
 * Atomically increment a user's token usage for the current month.
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
    // Try to read current user to check if we need a month reset
    const user = await userDb.getUserById(userId);
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
      await userDb.updateUser(userId, {
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
      // Same month — increment atomically
      await userDb.updateUser(userId, {
        tokenUsage: {
          month: currentMonth,
          totalTokens: (user.tokenUsage?.totalTokens || 0) + tokens,
          totalCost: (user.tokenUsage?.totalCost || 0) + cost,
          resetDate: user.tokenUsage?.resetDate || getNextResetDate(),
        },
      });
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
 */
export async function checkExtraCostUsage(userId: string): Promise<ExtraCostUsageStatus> {
  const usage = await getUserExtraCostUsage(userId);
  const subscriptionTypeName = await getUserSubscriptionType(userId);
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
    const user = await userDb.getUserById(userId);
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
      await userDb.updateUser(userId, {
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
      await userDb.updateUser(userId, {
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
