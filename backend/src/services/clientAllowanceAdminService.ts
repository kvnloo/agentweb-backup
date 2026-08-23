/**
 * The narrow business boundary for cross-account allowance administration.
 *
 * This service deliberately does not know about HTTP or MCP.  Both callers
 * must supply an authenticated admin identity; mutations retain the current
 * admin APIs' conditional-write semantics and leave Stripe untouched.
 */

import { getLlmUsageCreditAdjustment, grantMonthlyLlmUsageCredit, type MonthlyLlmUsageCredits } from './llmUsageCreditService';

export type ClientAllowanceSnapshot = {
  userId: string;
  email: string;
  billingUserId: string;
  subscriptionType: string;
  currentMonthUsage: { tokens: number; costUsd: number };
  baseAllowance: number | null;
  bonusAllowance: number;
  effectiveAllowance: number | null;
  costAllowance: number | null;
  ledgerReconciliation: {
    legacyCostUsd: number;
    migrationOffsetUsd: number;
    effectivePolicyCostUsd: number;
    purchasedCreditUsd: number;
    adminCreditUsd: number;
  };
  resetMonth: string;
  blocked: boolean;
};

// The DynamoDB repository exposes AttributeMap, whose runtime shape is wider
// than this service needs. Keep that persistence type at the boundary and
// validate the required identity fields before using them.
type User = Record<string, unknown> & { userId?: string; email?: string; subscriptionType?: string; llmUsageCredits?: MonthlyLlmUsageCredits };
type Deps = {
  // DynamoDB's repository returns `undefined` for a missing item.  Accept it
  // at this boundary and normalize it alongside `null` in the service.
  getUserByEmail(email: string): Promise<User | null | undefined>;
  getUserById(userId: string): Promise<User | null | undefined>;
  resolveBillingUserId(userId: string): Promise<string>;
  getUserSubscriptionType(userId: string): Promise<string>;
  getUserTokenUsage(userId: string): Promise<{ month: string; totalTokens: number; totalCost: number; bonus: number }>;
  getUserTokenAllowance(userId: string): Promise<{ allowance: number | null; bonus: number; effectiveAllowance: number | null; costAllowance: number | null }>;
  checkTokenUsage(userId: string): Promise<{ allowed: boolean }>;
  getSubscriptionTypeConfig(subscriptionType: string): Promise<unknown | null>;
  // The mutation result is intentionally unused: the post-write inspection is
  // the source of the returned snapshot. Keep this adapter compatible with
  // UserDB's DynamoDB AttributeMap | User result without widening business
  // data through the service boundary.
  updateUser(userId: string, updates: { subscriptionType: string }, options: unknown): Promise<unknown>;
  grantMonthlyLlmUsageCredit(input: {
    billingUserId: string; grantId: string; source: 'admin'; amountMicroUsd: number; reason: string; grantedBy: string;
  }): Promise<{ granted: boolean; billingUserId: string; ledger: MonthlyLlmUsageCredits }>;
  recordAdminAudit(event: Record<string, unknown>): void;
};

export class ClientAllowanceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

function normalizeEmail(email: string): string {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalized || !normalized.includes('@')) throw new ClientAllowanceError('INVALID_EMAIL', 'A valid exact email is required');
  return normalized;
}

function requireUserIdentity(user: User, field: 'userId' | 'email'): string {
  const value = user[field];
  if (typeof value !== 'string' || !value) {
    throw new ClientAllowanceError('CLIENT_NOT_FOUND', 'The client record is missing required identity data');
  }
  return value;
}

export async function inspectClientAllowance(email: string, deps: Deps): Promise<ClientAllowanceSnapshot> {
  const client = await deps.getUserByEmail(normalizeEmail(email));
  if (!client) throw new ClientAllowanceError('CLIENT_NOT_FOUND', 'No client exists for that exact email');

  const clientUserId = requireUserIdentity(client, 'userId');
  const clientEmail = requireUserIdentity(client, 'email');
  const billingUserId = await deps.resolveBillingUserId(clientUserId);
  const [subscriptionType, usage, allowance, status, billingUser] = await Promise.all([
    deps.getUserSubscriptionType(billingUserId),
    deps.getUserTokenUsage(billingUserId),
    deps.getUserTokenAllowance(billingUserId),
    deps.checkTokenUsage(billingUserId),
    deps.getUserById(billingUserId),
  ]);
  if (!billingUser) throw new ClientAllowanceError('CLIENT_NOT_FOUND', 'The client billing account no longer exists');
  const adjustment = getLlmUsageCreditAdjustment(billingUser.llmUsageCredits as MonthlyLlmUsageCredits | undefined, usage.month);

  return {
    userId: clientUserId,
    email: clientEmail,
    billingUserId,
    subscriptionType,
    currentMonthUsage: { tokens: usage.totalTokens, costUsd: usage.totalCost },
    baseAllowance: allowance.allowance,
    bonusAllowance: allowance.bonus,
    effectiveAllowance: allowance.effectiveAllowance,
    costAllowance: allowance.costAllowance,
    ledgerReconciliation: {
      legacyCostUsd: usage.totalCost,
      migrationOffsetUsd: adjustment.migrationOffsetMicroUsd / 1_000_000,
      effectivePolicyCostUsd: Math.max(0, usage.totalCost - adjustment.migrationOffsetMicroUsd / 1_000_000),
      purchasedCreditUsd: adjustment.purchasedMicroUsd / 1_000_000,
      adminCreditUsd: adjustment.adminGrantedMicroUsd / 1_000_000,
    },
    resetMonth: usage.month,
    blocked: !status.allowed,
  };
}

export async function grantClientCostCredit(
  input: { email: string; amountUsd: number; idempotencyKey: string; actor: { userId: string; email?: string }; reason: string },
  deps: Deps,
): Promise<{ before: ClientAllowanceSnapshot; after: ClientAllowanceSnapshot; granted: boolean }> {
  if (!input.reason?.trim()) throw new ClientAllowanceError('REASON_REQUIRED', 'A mutation reason is required');
  if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.idempotencyKey)) {
    throw new ClientAllowanceError('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey must be 8-100 URL-safe characters');
  }
  const centsExact = input.amountUsd * 100;
  const cents = Math.round(centsExact);
  if (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0 || Math.abs(centsExact - cents) > 1e-9) {
    throw new ClientAllowanceError('INVALID_CREDIT_AMOUNT', 'amountUsd must be a positive whole-cent amount');
  }

  const before = await inspectClientAllowance(input.email, deps);
  const result = await deps.grantMonthlyLlmUsageCredit({
    billingUserId: before.billingUserId,
    grantId: `admin:${before.billingUserId}:${input.idempotencyKey}`,
    source: 'admin', amountMicroUsd: cents * 10_000,
    reason: input.reason.trim(), grantedBy: input.actor.email || input.actor.userId,
  });
  const after = await inspectClientAllowance(input.email, deps);
  if (result.granted) {
    deps.recordAdminAudit({
      actorUserId: input.actor.userId, actorEmail: input.actor.email,
      action: 'client_allowance_cost_credit_grant', targetUserId: before.billingUserId,
      targetEmail: before.email, reason: input.reason.trim(),
      before: before.ledgerReconciliation, after: after.ledgerReconciliation,
    });
  }
  return { before, after, granted: result.granted };
}

export async function changeClientSubscription(
  input: { email: string; subscriptionType: string; actor: { userId: string; email?: string }; reason: string },
  deps: Deps,
): Promise<{ before: ClientAllowanceSnapshot; after: ClientAllowanceSnapshot; changed: boolean }> {
  if (!input.reason?.trim()) throw new ClientAllowanceError('REASON_REQUIRED', 'A mutation reason is required');
  const before = await inspectClientAllowance(input.email, deps);
  const requested = typeof input.subscriptionType === 'string' ? input.subscriptionType.trim() : '';
  if (!requested) throw new ClientAllowanceError('INVALID_SUBSCRIPTION_TYPE', 'A subscription type is required');
  if (!await deps.getSubscriptionTypeConfig(requested)) {
    throw new ClientAllowanceError('UNKNOWN_SUBSCRIPTION_TYPE', 'The requested subscription type does not exist');
  }
  if (before.subscriptionType === requested) return { before, after: before, changed: false };

  try {
    await deps.updateUser(before.billingUserId, { subscriptionType: requested }, {
      condition: {
        expression: '#subscriptionType = :expectedSubscriptionType',
        names: { '#subscriptionType': 'subscriptionType' },
        values: { ':expectedSubscriptionType': before.subscriptionType },
      },
    });
  } catch (error: any) {
    if (error?.code === 'ConditionalCheckFailedException') {
      throw new ClientAllowanceError('CLIENT_ALLOWANCE_CONFLICT', 'The client subscription changed concurrently; inspect again before retrying');
    }
    throw error;
  }

  const after = await inspectClientAllowance(input.email, deps);
  if (after.subscriptionType !== requested) {
    throw new ClientAllowanceError('CLIENT_ALLOWANCE_CONFLICT', 'The client subscription did not persist as requested; inspect again before retrying');
  }
  deps.recordAdminAudit({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    action: 'client_allowance_subscription_change',
    targetUserId: before.billingUserId,
    targetEmail: before.email,
    reason: input.reason.trim(),
    before: { subscriptionType: before.subscriptionType },
    after: { subscriptionType: after.subscriptionType },
  });
  return { before, after, changed: true };
}
