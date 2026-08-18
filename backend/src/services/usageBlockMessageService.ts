import { settingsService } from './settingsService';
import { deriveBlockedByCost } from './tokenUsageService';
import { getUserSubscriptionType } from './subscriptionService';

/**
 * ENG-1344: a blocked user (portal 429 today; the Emma MCP 429 payload once
 * ENG-1035 merges) is told in one shared shape what ran out, when it comes
 * back, and what they can do about it right now — never a bare "usage is
 * paused" with no next step. See the Linear issue for the full incident
 * (a paying customer escalated on two channels because the old message was
 * undecodable).
 *
 * Reset timing: every cap this service knows about today is the monthly
 * token/cost cap in tokenUsageService, which always resets at the start of
 * the next calendar month. `resetsAutomatically` exists so a future
 * non-resetting cap (e.g. a one-time credit grant) has somewhere to say so
 * instead of silently inheriting a monthly date that doesn't apply to it.
 */
export interface UsageBlockInfo {
  exhausted: 'cost' | 'tokens';
  usedLabel: string;
  resetsAt: string | null;
  resetsAutomatically: boolean;
  hasNextTier: boolean;
  upgradeUrl: string | null;
  supportUrl: string;
}

export interface UsageBlockInput {
  currentTierName: string;
  blockedByCost: boolean;
  userId?: string;
  used?: number | null;
  allowance?: number | null;
  costUsed?: number | null;
  costAllowance?: number | null;
}

const SUPPORT_URL = 'https://www.hireemma.ai/support';

function getNextResetDateIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

function formatCostLabel(used: number, allowance: number): string {
  return `$${used.toFixed(2)} of your $${allowance.toFixed(2)} monthly AI budget`;
}

function formatTokenRatioLabel(used: number, allowance: number): string {
  const percent = allowance > 0 ? Math.min(100, Math.round((used / allowance) * 100)) : 100;
  return `${percent}% of your monthly AI usage`;
}

interface RawSubscriptionTypeRow {
  name?: string;
  monthlyCostAllowance?: number | null;
  monthlyTokenAllowance?: number | null;
}

async function loadSubscriptionTypeRows(): Promise<RawSubscriptionTypeRow[]> {
  try {
    const setting = await settingsService.getSetting('subscription_types');
    if (!setting) return [];
    const parsed = JSON.parse(setting.settingValue);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A malformed/unreadable tier config must never crash the block screen —
    // it fails loud into "no next tier" (AC4's honest-guidance branch), not a 500.
    return [];
  }
}

/**
 * "Higher" is defined per the dimension that actually blocked this user
 * (cost vs. token cap) — comparing the other dimension could recommend an
 * "upgrade" that doesn't touch the thing that's actually out. null/undefined
 * allowance means unlimited and always counts as higher.
 */
function tierIsHigher(
  candidate: RawSubscriptionTypeRow,
  currentAllowance: number | null,
  dimension: 'cost' | 'tokens',
): boolean {
  const candidateAllowance =
    dimension === 'cost' ? candidate.monthlyCostAllowance : candidate.monthlyTokenAllowance;
  if (candidateAllowance === null || candidateAllowance === undefined) return true;
  if (currentAllowance === null || currentAllowance === undefined) return false;
  return candidateAllowance > currentAllowance;
}

export async function buildUsageBlockInfo(input: UsageBlockInput): Promise<UsageBlockInfo> {
  const exhausted: 'cost' | 'tokens' = input.blockedByCost ? 'cost' : 'tokens';
  const usedLabel = input.blockedByCost
    ? formatCostLabel(input.costUsed ?? 0, input.costAllowance ?? 0)
    : formatTokenRatioLabel(input.used ?? 0, input.allowance ?? 0);

  const rows = await loadSubscriptionTypeRows();
  const currentAllowance = input.blockedByCost ? (input.costAllowance ?? null) : (input.allowance ?? null);
  const hasNextTier = rows.some(
    (row) => row.name !== input.currentTierName && tierIsHigher(row, currentAllowance, exhausted),
  );

  const base = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
  const upgradeUrl =
    hasNextTier && input.userId ? `${base}/settings?upgrade=true&userId=${input.userId}` : null;

  return {
    exhausted,
    usedLabel,
    resetsAt: getNextResetDateIso(),
    resetsAutomatically: true,
    hasNextTier,
    upgradeUrl,
    supportUrl: SUPPORT_URL,
  };
}

/**
 * Convenience wrapper for the 429 call sites: derives the cost-vs-token
 * attribution and the user's current tier so callers don't have to.
 */
export async function buildUsageBlockInfoForUser(
  userId: string,
  usageStatus: {
    used?: number | null;
    allowance?: number | null;
    effectiveAllowance?: number | null;
    costUsed?: number | null;
    costAllowance?: number | null;
    costPercentUsed?: number;
    percentUsed?: number;
    costEnforced?: boolean;
  },
): Promise<UsageBlockInfo> {
  const { blockedByCost } = deriveBlockedByCost(usageStatus);
  const currentTierName = await getUserSubscriptionType(userId);
  return buildUsageBlockInfo({
    currentTierName,
    blockedByCost,
    userId,
    used: usageStatus.used,
    allowance: usageStatus.effectiveAllowance ?? usageStatus.allowance,
    costUsed: usageStatus.costUsed,
    costAllowance: usageStatus.costAllowance,
  });
}
