/**
 * ENG-668: the PAYG switch instance and the customer settings behind `GET/PUT /api/subscription/payg`.
 *
 * The admission decision is not here — it is the pure `evaluatePaygAdmission` (paygOverage.ts), reached
 * by both gates through `resolveLlmUsagePoolDecision`. This module only reads and writes the billing
 * owner's opt-in. No dollar amount leaves it: the customer chooses a cap as a percentage of their pool
 * and sees overage as a percentage of that cap.
 */
import { userDb, type User } from './db';
import { settingsService } from './settingsService';
import { getSubscriptionTypeConfig, getUserSubscriptionType } from './subscriptionService';
import { resolveBillingUserId } from './tokenUsageService';
import { getEffectiveLlmUsagePolicy } from './llmUsagePolicyResolverService';
import { getCurrentUsageMonth } from './llmUsageCreditService';
import {
  createPaygOverageSwitch,
  isPaygCapPercent,
  paygGrossOverageMicroUsd,
  paygOverageThresholdMicroUsd,
  type PaygCapPercent,
  type PaygOverageSettings,
  type PaygSuspensionReason,
} from './paygOverage';

/** Process-wide switch reader: one cache, one answer for both gates and the settings routes. */
export const paygOverageSwitch = createPaygOverageSwitch({
  getSetting: (name) => settingsService.getSetting(name),
  now: () => Date.now(),
  log: (message, fields) => console.error(message, fields),
});

/** A refusal the route maps straight to `status` + `{ error: code }`. */
export class PaygOverageRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'PaygOverageRequestError';
  }
}

export interface PaygOverageView {
  /** The switch is on and the billing owner's tier allows PAYG. */
  available: boolean;
  /** The caller is their own billing owner, so the settings are theirs to change. */
  eligible: boolean;
  enabled: boolean;
  capPercentOfPool: PaygCapPercent | null;
  /** Overage this month as a percentage of the cap; 0 while inside the plan pool. */
  overagePercentUsed: number;
  suspended: PaygSuspensionReason | null;
  hasPaymentMethod: boolean;
}

interface PaygContext {
  billingUserId: string;
  billingUser: User | null;
  available: boolean;
  eligible: boolean;
}

async function loadContext(userId: string): Promise<PaygContext> {
  const billingUserId = await resolveBillingUserId(userId);
  const [subscriptionType, billingUser, switchOn] = await Promise.all([
    getUserSubscriptionType(billingUserId),
    userDb.getUserById(billingUserId) as Promise<User | null | undefined>,
    paygOverageSwitch.isEnabled(),
  ]);
  const tier = await getSubscriptionTypeConfig(subscriptionType);
  return {
    billingUserId,
    billingUser: billingUser ?? null,
    available: switchOn && tier?.paygOverage?.allowed === true,
    eligible: billingUserId === userId,
  };
}

function toView(
  context: PaygContext,
  account: PaygOverageSettings | null | undefined,
  overagePercentUsed: number,
): PaygOverageView {
  return {
    available: context.available,
    eligible: context.eligible,
    enabled: account?.enabled === true,
    capPercentOfPool: isPaygCapPercent(account?.capPercentOfPool) ? account!.capPercentOfPool : null,
    overagePercentUsed,
    suspended: account?.suspended?.reason ?? null,
    hasPaymentMethod: context.billingUser?.has_payment_method === true,
  };
}

/** Overage as % of cap, from the same pool decision the gates use. 0 unless PAYG is live and past the pool. */
async function currentOveragePercent(userId: string, context: PaygContext): Promise<number> {
  if (!context.available || context.billingUser?.paygOverage?.enabled !== true) return 0;
  const usage = await getEffectiveLlmUsagePolicy(userId);
  return usage.overage?.percentOfCap ?? 0;
}

export async function getPaygOverageView(userId: string): Promise<PaygOverageView> {
  const context = await loadContext(userId);
  return toView(context, context.billingUser?.paygOverage, await currentOveragePercent(userId, context));
}

/**
 * Turn PAYG on or off, or change the cap, for the caller's own pool.
 *
 * Enabling needs a payment method confirmed LIVE with Stripe — the cached `has_payment_method` flag is
 * enough for the gate, which re-reads it every check, but not to start an agreement to be billed. A
 * Stripe failure refuses rather than enabling on a guess. Turning PAYG off never touches Stripe, and is
 * accepted even after the tier stops offering PAYG: an opt-in the customer cannot withdraw would resume
 * billing silently the day the tier offered it again.
 *
 * Consent to be billed is the customer's own. A delegated admin (acting AS the customer) may only
 * reduce exposure — turn PAYG off or lower the cap — never turn it on or raise the cap.
 *
 * Only usage AFTER opting in is overage: turning PAYG on records the overage already standing at that
 * moment (`optIn`), and the gates subtract it for the rest of that month.
 */
export async function updatePaygOverage(input: {
  userId: string;
  /** Who made the change (a delegated admin's id when acting as the customer). */
  actorId: string;
  /** The caller is a delegated admin acting as the customer (`req.delegateInfo.isDelegated`). */
  isDelegated: boolean;
  enabled: unknown;
  capPercentOfPool: unknown;
}): Promise<PaygOverageView> {
  const context = await loadContext(input.userId);
  const existing = context.billingUser?.paygOverage;
  const disabling = input.enabled === false;
  if (!context.available && !(disabling && existing?.enabled === true)) {
    throw new PaygOverageRequestError(404, 'payg_unavailable', 'Pay-as-you-go is not available on this plan');
  }
  if (!context.eligible) {
    throw new PaygOverageRequestError(403, 'not_billing_owner', 'Only the account that pays for this plan can change pay-as-you-go');
  }
  if (typeof input.enabled !== 'boolean') {
    throw new PaygOverageRequestError(400, 'invalid_request', '`enabled` must be a boolean');
  }
  const capProvided = input.capPercentOfPool !== undefined && input.capPercentOfPool !== null;
  if ((input.enabled && !capProvided) || (capProvided && !isPaygCapPercent(input.capPercentOfPool))) {
    throw new PaygOverageRequestError(422, 'invalid_cap', 'capPercentOfPool must be one of 25, 50, 100 or 200');
  }
  const capPercentOfPool = capProvided ? (input.capPercentOfPool as PaygCapPercent) : null;
  const turningOn = input.enabled && existing?.enabled !== true;
  const raisingCap = capPercentOfPool !== null
    && (!isPaygCapPercent(existing?.capPercentOfPool) || capPercentOfPool > existing!.capPercentOfPool);
  if (input.isDelegated && (turningOn || raisingCap)) {
    throw new PaygOverageRequestError(
      403,
      'delegate_cannot_consent',
      'Only the account owner can turn on pay-as-you-go or raise its limit',
    );
  }

  // Nothing stored and nothing to turn on: there is no opt-in to withdraw.
  if (!existing && !input.enabled) return toView(context, existing, 0);

  let optIn: PaygOverageSettings['optIn'] | undefined;
  if (turningOn) {
    // Overage already standing right now is not the customer's to pay for: it accrued before they
    // agreed. Measured exactly the way the gates measure it (same pool, same high-water mark).
    const usage = await getEffectiveLlmUsagePolicy(input.userId);
    if (!usage.policy || usage.mode.reason === 'policy_not_enforced' || usage.policy.hardCostThresholdMicroUsd <= 0) {
      throw new PaygOverageRequestError(404, 'payg_unavailable', 'This plan has no usage pool to go past');
    }
    const month = getCurrentUsageMonth();
    const poolMicroUsd = paygOverageThresholdMicroUsd({
      effectiveHardThresholdMicroUsd: usage.policy.hardCostThresholdMicroUsd,
      poolHighWater: existing?.poolHighWater,
      month,
    });
    optIn = { month, overageBaselineMicroUsd: paygGrossOverageMicroUsd(usage.costUsedMicroUsd, poolMicroUsd) };
    await requireLivePaymentMethod(context.billingUser);
  }

  const now = new Date().toISOString();
  const nextVersion = (Number.isInteger(existing?.version) ? existing!.version : 0) + 1;
  let updated: User;
  try {
    if (!existing) {
      const created: PaygOverageSettings = {
        enabled: input.enabled,
        capPercentOfPool: capPercentOfPool!,
        ...(optIn ? { optIn } : {}),
        updatedBy: input.actorId,
        updatedAt: now,
        version: nextVersion,
      };
      updated = (await userDb.updateUser(context.billingUserId, { paygOverage: created }, {
        condition: { expression: 'attribute_not_exists(#paygOverage)', names: { '#paygOverage': 'paygOverage' } },
      })) as User;
    } else {
      // Field-by-field, so the high-water mark and a settlement suspension written alongside are kept.
      const fields: Partial<PaygOverageSettings> = {
        enabled: input.enabled,
        ...(capPercentOfPool !== null ? { capPercentOfPool } : {}),
        ...(optIn ? { optIn } : {}),
        updatedBy: input.actorId,
        updatedAt: now,
        version: nextVersion,
      };
      updated = (await userDb.updateUser(context.billingUserId, {}, {
        pathSets: Object.entries(fields).map(([key, value]) => ({ path: ['paygOverage', key], value })),
        condition: Number.isInteger(existing.version)
          ? {
              expression: '#payg.#version = :expectedVersion',
              names: { '#payg': 'paygOverage', '#version': 'version' },
              values: { ':expectedVersion': existing.version },
            }
          : {
              expression: 'attribute_exists(#payg) AND attribute_not_exists(#payg.#version)',
              names: { '#payg': 'paygOverage', '#version': 'version' },
            },
      })) as User;
    }
  } catch (error: any) {
    if (error?.code === 'ConditionalCheckFailedException') {
      throw new PaygOverageRequestError(409, 'payg_conflict', 'Pay-as-you-go settings changed in the meantime; reload and try again');
    }
    throw error;
  }

  const account = updated?.paygOverage;
  const writtenContext = { ...context, billingUser: updated ?? context.billingUser };
  return toView(writtenContext, account, await currentOveragePercent(input.userId, writtenContext));
}

async function requireLivePaymentMethod(billingUser: User | null): Promise<void> {
  const customerId = billingUser?.stripe_customer_id;
  if (!customerId) {
    throw new PaygOverageRequestError(409, 'payment_method_required', 'Add a payment method before turning on pay-as-you-go');
  }
  let hasPaymentMethod: boolean;
  try {
    const { stripeService } = await import('./stripeService');
    hasPaymentMethod = await stripeService.customerHasPaymentMethod(customerId);
  } catch (error: any) {
    console.error('[paygOverage] Live payment-method check failed:', error?.message || error);
    throw new PaygOverageRequestError(503, 'payment_check_unavailable', 'Could not confirm your payment method right now; please try again');
  }
  if (!hasPaymentMethod) {
    throw new PaygOverageRequestError(409, 'payment_method_required', 'Add a payment method before turning on pay-as-you-go');
  }
}
