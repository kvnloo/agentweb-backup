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

export interface LlmUsageDebit {
  /** Deterministic id derived from workId — `meter:{workId}` today. */
  id: string;
  /** Work unit that produced the spend (session/task/coding-agent run id). */
  workId: string;
  amountMicroUsd: number;
  debitedAt: string;
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
  /**
   * Append-only debit ledger (ENG-1138 AC5a). Populated by
   * `recordLlmUsageDebit`. Each entry ties an amount drawn from the
   * purchased/admin allowance pool to the work unit that caused it — used by
   * reconciliation, by the AC4 carryover computation ("purchased not yet
   * consumed"), and by the AC5b reversal-review check ("did we revoke money
   * the customer had already spent"). Missing/empty for accounts that never
   * crossed the hard threshold or predate this ship.
   */
  debits?: LlmUsageDebit[];
  debitIds?: string[];
  totalDebitedMicroUsd?: number;
  /**
   * True once `debits[]` has been pruned to stay under DynamoDB's 400KB item
   * limit. The granular tail is incomplete when set, but `totalDebitedMicroUsd`
   * remains authoritative — it never decrements on prune. Consumers that need
   * full granular audit should page to a dedicated table once this ever flips.
   */
  debitsTruncated?: boolean;
}

/**
 * Cap on debit entries kept in-line on the user row before pruning starts.
 * Each entry is ~150 bytes so 2000 entries ≈ 300KB, safely under DynamoDB's
 * 400KB item-size limit while leaving headroom for the rest of the ledger
 * (grants, reversals, admin fields). Realistic worst-case (top 1% of Pro
 * users going many multiples over hard cap for a full month) sits an order
 * of magnitude below this, so a single-item ledger is sustainable until we
 * outgrow it and decide to move to a dedicated `AW-UsageDebits` table.
 */
const MAX_DEBITS_PER_LEDGER = 2000;

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
    const condition: {
      expression: string;
      names: Record<string, string>;
      values?: Record<string, any>;
    } = existing.version == null
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

/**
 * Record an append-only debit against the AgentWeb Credits wallet (ENG-1138
 * AC5a). Idempotent by `workId` — the same work unit debited twice returns
 * `{debited: false}` on the second call, so a fire-and-forget caller on the
 * metering chokepoint can be retried after a transient DynamoDB failure
 * without double-charging the customer.
 *
 * NOT wired into `meterUserUsage` in this PR — that's a follow-up. This
 * function ships the data-plane API; the chokepoint call site + guard-test
 * allowlist update land in PR3 alongside AC4 (cross-month carryover) and
 * AC5b (reversal-past-consumption review flag), both of which lean on this
 * ledger to know how much of the allowance was actually consumed.
 */
export async function recordLlmUsageDebit(input: {
  billingUserId: string;
  workId: string;
  amountMicroUsd: number;
  now?: Date;
}): Promise<{ debited: boolean; billingUserId: string; ledger: MonthlyLlmUsageCredits }> {
  const amountMicroUsd = Math.round(input.amountMicroUsd);
  const workId = (input.workId || '').trim();
  if (!workId) throw new Error('workId is required');
  // Cap workId length so a runaway caller can't push a single debit entry
  // toward the DynamoDB item ceiling. 256 chars is well above any real UUID
  // or task/session id today; anything longer is almost certainly a bug.
  if (workId.length > 256) throw new Error('workId must be at most 256 chars');
  if (!Number.isInteger(amountMicroUsd) || amountMicroUsd <= 0) {
    throw new Error('amountMicroUsd must be a positive integer');
  }

  const billingUserId = input.billingUserId;
  const month = getCurrentUsageMonth(input.now);
  const debitedAt = (input.now || new Date()).toISOString();
  const debitId = `meter:${workId}`;

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
          debits: [],
          debitIds: [],
          totalDebitedMicroUsd: 0,
        };

    if ((current.debitIds || []).includes(debitId)) {
      return { debited: false, billingUserId, ledger: current };
    }

    const debit: LlmUsageDebit = {
      id: debitId,
      workId,
      amountMicroUsd,
      debitedAt,
    };

    // Item-size guard: keep in-line debits below the DynamoDB 400KB ceiling
    // by dropping the oldest entry when the array hits MAX_DEBITS_PER_LEDGER.
    // `totalDebitedMicroUsd` deliberately does NOT decrement — audit totals
    // stay authoritative even after granular tail rows fall off; the
    // debitsTruncated flag records that they did.
    const existingDebits = current.debits || [];
    const existingDebitIds = current.debitIds || [];
    const willTruncate = existingDebits.length >= MAX_DEBITS_PER_LEDGER;
    const keptDebits = willTruncate
      ? existingDebits.slice(existingDebits.length - (MAX_DEBITS_PER_LEDGER - 1))
      : existingDebits;
    const keptDebitIds = willTruncate
      ? existingDebitIds.slice(existingDebitIds.length - (MAX_DEBITS_PER_LEDGER - 1))
      : existingDebitIds;
    if (willTruncate) {
      console.warn(
        `[llmUsageCreditService] Pruning oldest debits for ${billingUserId} (${month}) — ledger reached ${existingDebits.length} entries. Migrate to a dedicated table if this fires often.`
      );
    }

    const next: MonthlyLlmUsageCredits = {
      ...current,
      month,
      version: (existing?.version || 0) + 1,
      debits: [...keptDebits, debit],
      debitIds: [...keptDebitIds, debitId],
      totalDebitedMicroUsd: (current.totalDebitedMicroUsd || 0) + amountMicroUsd,
      ...(willTruncate || current.debitsTruncated ? { debitsTruncated: true } : {}),
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
      return { debited: true, billingUserId, ledger: next };
    } catch (error) {
      if (isConditionalFailure(error)) continue;
      throw error;
    }
  }
  throw new Error(`Concurrent usage-credit debits did not settle for ${billingUserId}`);
}
