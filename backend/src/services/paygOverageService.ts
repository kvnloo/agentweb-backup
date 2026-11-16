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
import { getCurrentMonth, resolveBillingUserId } from './tokenUsageService';
import { getEffectiveLlmUsagePolicy } from './llmUsagePolicyResolverService';
import { getCurrentUsageMonth, getRevocablePurchasedCreditMicroUsd } from './llmUsageCreditService';
import { isPaygDisputeHold, paygOpenInvoiceUrl } from './paygSettlement';
import {
  createExactTrueSwitch,
  PAYG_OVERAGE_SETTING,
  isPaygCapPercent,
  paygAdmittedMonth,
  PAYG_SETTLEMENT_SETTING,
  paygGrossOverageMicroUsd,
  paygOverageThresholdMicroUsd,
  paygSuspendedReasonOf,
  type PaygCapPercent,
  type PaygOverageSettings,
  type PaygSuspensionReason,
} from './paygOverage';

/** Process-wide switch reader: one cache, one answer for both gates and the settings routes. */
export const paygOverageSwitch = createExactTrueSwitch({
  getSetting: (name) => settingsService.getSetting(name),
  now: () => Date.now(),
  log: (message, fields) => console.error(message, fields),
}, PAYG_OVERAGE_SETTING);

/** Month-end settlement's own switch (`paygSettlementService.ts`): off = the settlement cron does nothing. */
export const paygSettlementSwitch = createExactTrueSwitch({
  getSetting: (name) => settingsService.getSetting(name),
  now: () => Date.now(),
  log: (message, fields) => console.error(message, fields),
}, PAYG_SETTLEMENT_SETTING);

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
  /** The billing owner has a payment method on file. Always false for a caller who is not the owner. */
  hasPaymentMethod: boolean;
  /**
   * The Stripe-hosted page of the newest unpaid overage invoice (a month whose charge failed), where it
   * can be paid with any card — paying it lifts a payment-failure hold. Owner only; null otherwise.
   * No amount: the page carries it.
   */
  openInvoiceUrl: string | null;
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
    // The owner's billing state is the owner's: a pooled member sees false, never the owner's card status.
    hasPaymentMethod: context.eligible && context.billingUser?.has_payment_method === true,
    // Never under a dispute hold (paying does not lift it), the same rule as the 429's `usageBlock`.
    openInvoiceUrl: context.eligible && !isPaygDisputeHold(paygSuspendedReasonOf(account?.suspended))
      ? paygOpenInvoiceUrl(context.billingUser?.paygSettlements) ?? null
      : null,
  };
}

/** At most one live Stripe check per billing owner per window from the settings read. */
export const LIVE_PAYMENT_METHOD_CHECK_WINDOW_MS = 120_000;
/** Bounds the map; the oldest entries are evicted first (Map keeps insertion order). */
const LIVE_PAYMENT_METHOD_CHECK_MAX_ENTRIES = 10_000;
const lastLivePaymentMethodCheckAt = new Map<string, number>();

/**
 * Whether a live check may run now for this owner, recording it if so. Settings pages poll and refresh;
 * without this every GET would be a Stripe `paymentMethods.list`. Per process, which is enough to
 * bound it — a missed repair just waits for the next window.
 */
function claimLivePaymentMethodCheck(billingUserId: string, now: number): boolean {
  const last = lastLivePaymentMethodCheckAt.get(billingUserId);
  if (last !== undefined && now - last < LIVE_PAYMENT_METHOD_CHECK_WINDOW_MS) return false;
  // Re-insert so the entry moves to the newest end, then trim from the oldest.
  lastLivePaymentMethodCheckAt.delete(billingUserId);
  lastLivePaymentMethodCheckAt.set(billingUserId, now);
  while (lastLivePaymentMethodCheckAt.size > LIVE_PAYMENT_METHOD_CHECK_MAX_ENTRIES) {
    const oldest = lastLivePaymentMethodCheckAt.keys().next().value as string;
    lastLivePaymentMethodCheckAt.delete(oldest);
  }
  return true;
}

/** Tests: forget every recorded live check. */
export function resetLivePaymentMethodChecksForTests(): void {
  lastLivePaymentMethodCheckAt.clear();
}

/**
 * Repair a stale cached `has_payment_method` for an owner with PAYG on.
 *
 * The gates read the cached flag on every check, and nothing refreshes it when a card is added in the
 * Stripe customer portal — so an owner who added a card after enabling PAYG would be refused
 * (`payg_inactive` / `no_payment_method`) indefinitely. Opening the PAYG settings asks Stripe (at most
 * once per owner per `LIVE_PAYMENT_METHOD_CHECK_WINDOW_MS`) and sets the flag when a card is there.
 * Only ever repairs upward (clearing stays with the webhooks), only for the billing owner, and a
 * Stripe failure leaves the flag as it was rather than failing the read. The write is unconditional:
 * a webhook clearing the flag in the same instant could be overwritten (accepted; the next webhook or
 * live check settles it).
 */
async function repairPaymentMethodFlag(context: PaygContext): Promise<PaygContext> {
  const user = context.billingUser;
  if (!context.available || !context.eligible) return context;
  if (user?.paygOverage?.enabled !== true || user.has_payment_method === true) return context;
  const customerId = user.stripe_customer_id;
  if (!customerId) return context;
  if (!claimLivePaymentMethodCheck(context.billingUserId, Date.now())) return context;
  try {
    const { stripeService } = await import('./stripeService');
    if (!(await stripeService.resolveUserPaymentMethod(user, context.billingUserId)).hasPaymentMethod) return context;
    const updated = (await userDb.updateUser(context.billingUserId, { has_payment_method: true })) as User | undefined;
    return { ...context, billingUser: updated ?? { ...user, has_payment_method: true } };
  } catch (error: any) {
    console.error('[paygOverage] Could not refresh the payment-method flag:', error?.message || error);
    return context;
  }
}

/** Overage as % of cap, from the same pool decision the gates use. 0 unless PAYG is live and past the pool. */
async function currentOveragePercent(userId: string, context: PaygContext): Promise<number> {
  if (!context.available || context.billingUser?.paygOverage?.enabled !== true) return 0;
  const usage = await getEffectiveLlmUsagePolicy(userId);
  return usage.overage?.percentOfCap ?? 0;
}

export async function getPaygOverageView(userId: string): Promise<PaygOverageView> {
  const context = await repairPaymentMethodFlag(await loadContext(userId));
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
 * Only usage AFTER opting in is overage: the month's FIRST off -> on records the overage already standing
 * at that moment (`optIn`), and the gates subtract it for the rest of that month. Re-enabling within the
 * same month keeps that baseline, so the cap stays a true per-month cap that toggling cannot reset.
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
    throw new PaygOverageRequestError(404, 'payg_unavailable', 'Extra usage is not available on this plan');
  }
  if (!context.eligible) {
    throw new PaygOverageRequestError(403, 'not_billing_owner', 'Only the account that pays for this plan can change extra usage');
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
      'Only the account owner can turn on extra usage or raise its limit',
    );
  }

  // Nothing stored and nothing to turn on: there is no opt-in to withdraw.
  if (!existing && !input.enabled) return toView(context, existing, 0);

  let optIn: PaygOverageSettings['optIn'] | undefined;
  let poolHighWater: PaygOverageSettings['poolHighWater'] | undefined;
  // The previous month's opt-in / mark these replace: settlement of that month runs after it closes and
  // still needs them (see `optInClosed`).
  let optInClosed: PaygOverageSettings['optInClosed'] | undefined;
  let poolHighWaterClosed: PaygOverageSettings['poolHighWaterClosed'] | undefined;
  if (turningOn) {
    // Overage already standing right now is not the customer's to pay for: it accrued before they
    // agreed. Measured exactly the way the gates measure it (same pool, same high-water mark).
    const usage = await getEffectiveLlmUsagePolicy(input.userId);
    if (!usage.policy || usage.mode.reason === 'policy_not_enforced' || usage.policy.hardCostThresholdMicroUsd <= 0) {
      throw new PaygOverageRequestError(404, 'payg_unavailable', 'This plan has no usage pool to go past');
    }
    const month = getCurrentUsageMonth();
    // The baseline is taken ONLY on the month's first opt-in, and only if PAYG has not already admitted
    // anything this month. Re-enabling later in the same month keeps the month's baseline: re-measuring
    // would turn overage already admitted (and billable) into "standing before opt-in", so toggling PAYG
    // off and on would reset the cap. That includes an opt-in carried over from an earlier month — its
    // baseline for this month is 0, and an off -> on mid-month must not replace that with the overage
    // the owner has already run up on PAYG. A new month starts with no baseline (the gates ignore a stale one).
    if (existing?.optIn?.month !== month && !paygAdmittedMonth(existing, month)) {
      const poolMicroUsd = paygOverageThresholdMicroUsd({
        effectiveHardThresholdMicroUsd: usage.policy.hardCostThresholdMicroUsd,
        poolHighWater: existing?.poolHighWater,
        month,
      });
      optIn = {
        month,
        overageBaselineMicroUsd: paygGrossOverageMicroUsd(usage.costUsedMicroUsd, poolMicroUsd),
        poolAtOptInMicroUsd: poolMicroUsd,
      };
      if (existing?.optIn) optInClosed = existing.optIn;
      // Pin the month's pool at least at the opt-in pool, so a downgrade before the next check cannot
      // drop the pool under the one the baseline was measured against. Like the gate's own mark, it
      // leaves out top-up credit a refund can still revoke (llmUsagePoolDecision.ts).
      const markMicroUsd = Math.max(
        0,
        usage.policy.hardCostThresholdMicroUsd
          - getRevocablePurchasedCreditMicroUsd(context.billingUser?.llmUsageCredits, getCurrentMonth()),
      );
      if (existing?.poolHighWater?.month !== month || existing.poolHighWater.thresholdMicroUsd < markMicroUsd) {
        poolHighWater = { month, thresholdMicroUsd: markMicroUsd };
        if (existing?.poolHighWater && existing.poolHighWater.month !== month) poolHighWaterClosed = existing.poolHighWater;
      }
    }
    await requireLivePaymentMethod(context.billingUser, context.billingUserId);
  }
  // Stripe just confirmed a card: the gates read the cached flag, so it is written with the settings.
  const userFields: Partial<User> = turningOn ? { has_payment_method: true } : {};

  const now = new Date().toISOString();
  const nextVersion = (Number.isInteger(existing?.version) ? existing!.version : 0) + 1;
  let updated: User;
  try {
    if (!existing) {
      const created: PaygOverageSettings = {
        enabled: input.enabled,
        capPercentOfPool: capPercentOfPool!,
        ...(optIn ? { optIn } : {}),
        ...(poolHighWater ? { poolHighWater } : {}),
        updatedBy: input.actorId,
        updatedAt: now,
        version: nextVersion,
      };
      updated = (await userDb.updateUser(context.billingUserId, { ...userFields, paygOverage: created }, {
        condition: { expression: 'attribute_not_exists(#paygOverage)', names: { '#paygOverage': 'paygOverage' } },
      })) as User;
    } else {
      // Field-by-field, so the high-water mark and a settlement suspension written alongside are kept.
      const fields: Partial<PaygOverageSettings> = {
        enabled: input.enabled,
        ...(capPercentOfPool !== null ? { capPercentOfPool } : {}),
        ...(optIn ? { optIn } : {}),
        ...(poolHighWater ? { poolHighWater } : {}),
        ...(optInClosed ? { optInClosed } : {}),
        ...(poolHighWaterClosed ? { poolHighWaterClosed } : {}),
        updatedBy: input.actorId,
        updatedAt: now,
        version: nextVersion,
      };
      const conditions = [
        Number.isInteger(existing.version)
          ? '#payg.#version = :expectedVersion'
          : 'attribute_exists(#payg) AND attribute_not_exists(#payg.#version)',
      ];
      const values: Record<string, unknown> = Number.isInteger(existing.version) ? { ':expectedVersion': existing.version } : {};
      if (poolHighWaterClosed) {
        // Rolling last month's mark over. Nothing raises a month's mark once the month has ended, so the
        // closed copy is right whether the stored mark is still that one or the gate rolled it over a
        // moment ago (this request's own usage read above does exactly that) — but, as below, never
        // over a mark the gate has since raised higher for this month.
        conditions.push(
          '((#payg.#hw.#hwMonth = :prevHwMonth AND #payg.#hw.#hwThreshold = :prevHwThreshold)'
            + ' OR (#payg.#hw.#hwMonth = :hwMonth AND #payg.#hw.#hwThreshold <= :hwThreshold))',
        );
        values[':prevHwMonth'] = poolHighWaterClosed.month;
        values[':prevHwThreshold'] = poolHighWaterClosed.thresholdMicroUsd;
        values[':hwMonth'] = poolHighWater!.month;
        values[':hwThreshold'] = poolHighWater!.thresholdMicroUsd;
      } else if (poolHighWater) {
        // The gate raises the mark without bumping the version; never lower one it raised meanwhile.
        conditions.push('(attribute_not_exists(#payg.#hw) OR #payg.#hw.#hwMonth <> :hwMonth OR #payg.#hw.#hwThreshold <= :hwThreshold)');
        values[':hwMonth'] = poolHighWater.month;
        values[':hwThreshold'] = poolHighWater.thresholdMicroUsd;
      }
      updated = (await userDb.updateUser(context.billingUserId, userFields, {
        pathSets: Object.entries(fields).map(([key, value]) => ({ path: ['paygOverage', key], value })),
        condition: {
          expression: conditions.join(' AND '),
          names: {
            '#payg': 'paygOverage',
            '#version': 'version',
            ...(poolHighWater ? { '#hw': 'poolHighWater', '#hwMonth': 'month', '#hwThreshold': 'thresholdMicroUsd' } : {}),
          },
          ...(Object.keys(values).length > 0 ? { values } : {}),
        },
      })) as User;
    }
  } catch (error: any) {
    if (error?.code === 'ConditionalCheckFailedException') {
      throw new PaygOverageRequestError(409, 'payg_conflict', 'Extra usage settings changed in the meantime; reload and try again');
    }
    throw error;
  }

  const account = updated?.paygOverage;
  const writtenContext = { ...context, billingUser: updated ?? context.billingUser };
  return toView(writtenContext, account, await currentOveragePercent(input.userId, writtenContext));
}

async function requireLivePaymentMethod(billingUser: User | null, billingUserId: string): Promise<void> {
  const customerId = billingUser?.stripe_customer_id;
  if (!customerId) {
    throw new PaygOverageRequestError(409, 'payment_method_required', 'Add a payment method before turning on extra usage');
  }
  let hasPaymentMethod: boolean;
  try {
    const { stripeService } = await import('./stripeService');
    // ENG-2571's single answer: every live Stripe customer that belongs to this user, not just the row's.
    hasPaymentMethod = (await stripeService.resolveUserPaymentMethod(billingUser, billingUserId)).hasPaymentMethod;
  } catch (error: any) {
    console.error('[paygOverage] Live payment-method check failed:', error?.message || error);
    throw new PaygOverageRequestError(503, 'payment_check_unavailable', 'Could not confirm your payment method right now; please try again');
  }
  if (!hasPaymentMethod) {
    throw new PaygOverageRequestError(409, 'payment_method_required', 'Add a payment method before turning on extra usage');
  }
}
