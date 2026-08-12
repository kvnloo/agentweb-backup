import { userDb, type User } from './db';

export type LlmUsageCreditSource = 'purchase' | 'migration' | 'admin';

export interface LlmUsageCreditGrant {
  id: string;
  source: LlmUsageCreditSource;
  amountMicroUsd: number;
  grantedAt: string;
  reason?: string;
  grantedBy?: string;
}

export interface MonthlyLlmUsageCredits {
  month: string;
  version?: number;
  totalPurchasedMicroUsd: number;
  totalPurchasedReversedMicroUsd?: number;
  /** One-time current-month credits issued by an admin. */
  totalAdminGrantedMicroUsd?: number;
  totalMigrationOffsetMicroUsd: number;
  grantIds: string[];
  grants: LlmUsageCreditGrant[];
  reversalIds?: string[];
  reversals?: Array<{
    id: string;
    grantId: string;
    amountMicroUsd: number;
    reversedAt: string;
  }>;
}

export interface LlmUsageCreditAdjustment {
  purchasedMicroUsd: number;
  adminGrantedMicroUsd: number;
  migrationOffsetMicroUsd: number;
}

export function getCurrentUsageMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function getLlmUsageCreditAdjustment(
  ledger: MonthlyLlmUsageCredits | null | undefined,
  month = getCurrentUsageMonth(),
): LlmUsageCreditAdjustment {
  if (!ledger || ledger.month !== month) {
    return { purchasedMicroUsd: 0, adminGrantedMicroUsd: 0, migrationOffsetMicroUsd: 0 };
  }
  return {
    purchasedMicroUsd: Math.max(
      0,
      Math.round(ledger.totalPurchasedMicroUsd || 0) - Math.round(ledger.totalPurchasedReversedMicroUsd || 0),
    ),
    adminGrantedMicroUsd: Math.max(0, Math.round(ledger.totalAdminGrantedMicroUsd || 0)),
    migrationOffsetMicroUsd: Math.max(0, Math.round(ledger.totalMigrationOffsetMicroUsd || 0)),
  };
}

export function applyLlmUsageCredits(input: {
  rawCostUsedMicroUsd: number;
  hardThresholdMicroUsd: number;
  adjustment: LlmUsageCreditAdjustment;
}): { policyCostUsedMicroUsd: number; effectiveHardThresholdMicroUsd: number } {
  return {
    policyCostUsedMicroUsd: Math.max(
      0,
      Math.round(input.rawCostUsedMicroUsd) - input.adjustment.migrationOffsetMicroUsd,
    ),
    effectiveHardThresholdMicroUsd:
      Math.round(input.hardThresholdMicroUsd) +
      input.adjustment.purchasedMicroUsd +
      input.adjustment.adminGrantedMicroUsd,
  };
}

export function planRolloutMigrationCredit(input: {
  usageMonth?: string;
  rawCostUsedUsd?: number;
  currentMonth?: string;
  policyVersion?: string | null;
}): { action: 'grant'; amountMicroUsd: number; grantIdSuffix: string } | { action: 'skip'; reason: string } {
  const currentMonth = input.currentMonth || getCurrentUsageMonth();
  if (!input.policyVersion?.trim()) return { action: 'skip', reason: 'no_versioned_policy' };
  if (input.usageMonth !== currentMonth) return { action: 'skip', reason: 'no_current_month_usage' };
  const amountMicroUsd = Math.max(0, Math.round((input.rawCostUsedUsd || 0) * 1_000_000));
  if (amountMicroUsd === 0) return { action: 'skip', reason: 'no_current_month_usage' };
  return {
    action: 'grant',
    amountMicroUsd,
    grantIdSuffix: `rollout:${input.policyVersion}:${currentMonth}`,
  };
}

/**
 * The rollout "reset to zero" is represented as a one-month offset instead of
 * deleting finance data. Customer policy usage becomes zero immediately while
 * raw provider spend remains auditable, and the deterministic grant id makes
 * the migration safe to rerun.
 */
export const planRolloutUsageReset = planRolloutMigrationCredit;

function isConditionalFailure(error: any): boolean {
  return error?.code === 'ConditionalCheckFailedException';
}

/**
 * Grant monthly LLM usage exactly once. The optimistic condition makes Stripe
 * webhook retries and concurrent deliveries idempotent while keeping the raw
 * provider-cost ledger untouched for finance/audit.
 */
export async function grantMonthlyLlmUsageCredit(input: {
  billingUserId: string;
  grantId: string;
  source: LlmUsageCreditSource;
  amountMicroUsd: number;
  now?: Date;
  reason?: string;
  grantedBy?: string;
}): Promise<{ granted: boolean; billingUserId: string; ledger: MonthlyLlmUsageCredits }> {
  const amountMicroUsd = Math.round(input.amountMicroUsd);
  if (!input.grantId.trim()) throw new Error('grantId is required');
  if (!Number.isInteger(amountMicroUsd) || amountMicroUsd <= 0) {
    throw new Error('amountMicroUsd must be a positive integer');
  }

  const billingUserId = input.billingUserId;
  const month = getCurrentUsageMonth(input.now);
  const grantedAt = (input.now || new Date()).toISOString();

  for (let attempt = 0; attempt < 3; attempt++) {
    const user = await userDb.getUserById(billingUserId) as User | undefined;
    if (!user) throw new Error(`User not found: ${billingUserId}`);
    const existing = user.llmUsageCredits;
    const current = existing?.month === month
      ? existing
      : {
          month,
          version: 0,
          totalPurchasedMicroUsd: 0,
          totalPurchasedReversedMicroUsd: 0,
          totalAdminGrantedMicroUsd: 0,
          totalMigrationOffsetMicroUsd: 0,
          grantIds: [],
          grants: [],
          reversalIds: [],
          reversals: [],
        };

    if (current.grantIds.includes(input.grantId)) {
      return { granted: false, billingUserId, ledger: current };
    }

    const grant: LlmUsageCreditGrant = {
      id: input.grantId,
      source: input.source,
      amountMicroUsd,
      grantedAt,
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
      ...(input.grantedBy?.trim() ? { grantedBy: input.grantedBy.trim() } : {}),
    };
    const next: MonthlyLlmUsageCredits = {
      ...current,
      month,
      version: (existing?.version || 0) + 1,
      totalPurchasedMicroUsd:
        current.totalPurchasedMicroUsd + (input.source === 'purchase' ? amountMicroUsd : 0),
      totalAdminGrantedMicroUsd:
        (current.totalAdminGrantedMicroUsd || 0) + (input.source === 'admin' ? amountMicroUsd : 0),
      totalMigrationOffsetMicroUsd:
        current.totalMigrationOffsetMicroUsd + (input.source === 'migration' ? amountMicroUsd : 0),
      grantIds: [...(current.grantIds || []), input.grantId],
      grants: [...(current.grants || []), grant],
    };

    const condition: {
      expression: string;
      names: Record<string, string>;
      values?: Record<string, any>;
    } = existing
      ? existing.version == null
        ? {
          expression: '#creditLedger.#month = :expectedMonth AND #creditLedger.#grantIds = :expectedGrantIds AND attribute_not_exists(#creditLedger.#version)',
          names: {
            '#creditLedger': 'llmUsageCredits',
            '#month': 'month',
            '#grantIds': 'grantIds',
            '#version': 'version',
          },
          values: {
            ':expectedMonth': existing.month,
            ':expectedGrantIds': existing.grantIds || [],
          },
        }
        : {
          expression: '#creditLedger.#version = :expectedVersion',
          names: { '#creditLedger': 'llmUsageCredits', '#version': 'version' },
          values: { ':expectedVersion': existing.version },
        }
      : {
          expression: 'attribute_not_exists(#creditLedger)',
          names: { '#creditLedger': 'llmUsageCredits' },
        };

    try {
      await userDb.updateUser(billingUserId, { llmUsageCredits: next }, { condition });
      return { granted: true, billingUserId, ledger: next };
    } catch (error) {
      if (isConditionalFailure(error)) continue;
      throw error;
    }
  }
  throw new Error(`Concurrent usage-credit updates did not settle for ${billingUserId}`);
}

/**
 * Reduce a current-month purchased grant to Stripe's cumulative refunded
 * amount. Cumulative targets make duplicate and out-of-order refund webhooks
 * idempotent while preserving the original grant for finance/audit.
 */
export async function reverseMonthlyPurchasedLlmUsageCredit(input: {
  billingUserId: string;
  grantId: string;
  reversalId: string;
  targetReversedMicroUsd: number;
  now?: Date;
}): Promise<{ reversed: boolean; billingUserId: string; ledger: MonthlyLlmUsageCredits }> {
  const targetReversedMicroUsd = Math.round(input.targetReversedMicroUsd);
  if (!input.grantId.trim()) throw new Error('grantId is required');
  if (!input.reversalId.trim()) throw new Error('reversalId is required');
  if (!Number.isInteger(targetReversedMicroUsd) || targetReversedMicroUsd < 0) {
    throw new Error('targetReversedMicroUsd must be a non-negative integer');
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const user = await userDb.getUserById(input.billingUserId) as User | undefined;
    if (!user) throw new Error(`User not found: ${input.billingUserId}`);
    const existing = user.llmUsageCredits;
    if (!existing) throw new Error(`Usage credit ledger not found: ${input.billingUserId}`);

    const purchase = (existing.grants || []).find(
      (grant) => grant.id === input.grantId && grant.source === 'purchase',
    );
    if (!purchase || existing.month !== getCurrentUsageMonth(input.now)) {
      return { reversed: false, billingUserId: input.billingUserId, ledger: existing };
    }
    const alreadyReversed = (existing.reversals || [])
      .filter((reversal) => reversal.grantId === input.grantId)
      .reduce((sum, reversal) => sum + reversal.amountMicroUsd, 0);
    const desiredReversed = Math.min(purchase.amountMicroUsd, targetReversedMicroUsd);
    if ((existing.reversalIds || []).includes(input.reversalId) || desiredReversed <= alreadyReversed) {
      return { reversed: false, billingUserId: input.billingUserId, ledger: existing };
    }

    const delta = desiredReversed - alreadyReversed;
    const next: MonthlyLlmUsageCredits = {
      ...existing,
      version: (existing.version || 0) + 1,
      totalPurchasedReversedMicroUsd: (existing.totalPurchasedReversedMicroUsd || 0) + delta,
      reversalIds: [...(existing.reversalIds || []), input.reversalId],
      reversals: [...(existing.reversals || []), {
        id: input.reversalId,
        grantId: input.grantId,
        amountMicroUsd: delta,
        reversedAt: (input.now || new Date()).toISOString(),
      }],
    };
    const condition = existing.version == null
      ? {
          expression: '#creditLedger.#month = :expectedMonth AND #creditLedger.#grantIds = :expectedGrantIds AND attribute_not_exists(#creditLedger.#version)',
          names: {
            '#creditLedger': 'llmUsageCredits', '#month': 'month',
            '#grantIds': 'grantIds', '#version': 'version',
          },
          values: { ':expectedMonth': existing.month, ':expectedGrantIds': existing.grantIds || [] },
        }
      : {
          expression: '#creditLedger.#version = :expectedVersion',
          names: { '#creditLedger': 'llmUsageCredits', '#version': 'version' },
          values: { ':expectedVersion': existing.version },
        };

    try {
      await userDb.updateUser(input.billingUserId, { llmUsageCredits: next }, { condition });
      return { reversed: true, billingUserId: input.billingUserId, ledger: next };
    } catch (error) {
      if (isConditionalFailure(error)) continue;
      throw error;
    }
  }
  throw new Error(`Concurrent usage-credit reversals did not settle for ${input.billingUserId}`);
}
