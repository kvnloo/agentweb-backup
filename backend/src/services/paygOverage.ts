/**
 * ENG-668: opt-in pay-as-you-go overages for the Emma usage pool.
 *
 * Today an account that reaches its plan's hard cost threshold is paused (429 `usage_paused`) until the
 * month resets or it buys a top-up. With PAYG enabled, the billing owner instead keeps working past the
 * pool up to a cap they chose, and the overage is settled after the month closes (`paygSettlement.ts`;
 * this module charges nothing).
 *
 * The decision lives here, as ONE pure function, because there are two admission gates —
 * `checkTokenUsage` and `getEffectiveLlmUsagePolicy` — and both must reach the same answer. If PAYG
 * were applied in only one of them, the first would admit a turn the second then refuses (or the
 * reverse). Both gates reach it through `resolveLlmUsagePoolDecision`, never directly.
 *
 * Switch: AW-Settings row `payg_overage_enabled`. ONLY the exact string 'true' (no trim, no case
 * folding) enables it; absent / any other value / a cold-start read failure => off, i.e. exactly
 * today's behaviour. A successful read is cached ~60s; a failed refresh keeps the last-known value.
 * Same pattern as workPlanStepModels.ts. The process-wide instance lives in paygOverageService.ts.
 *
 * Data (all additive and optional — no table, no index):
 *   - `SubscriptionType.paygOverage` — whether the tier may opt in, and the markup settlement bills at.
 *   - `User.paygOverage` on the BILLING OWNER's row — the opt-in and its cap (a percentage only), the
 *     month's pool high-water mark, the overage already standing when the owner opted in, and a
 *     suspension set by settlement when a charge fails.
 *
 * Every input that is missing or unreadable keeps the 429. Being paused by mistake is recoverable; an
 * uncapped account billed for usage it did not agree to is not.
 */
import type { LlmUsageModeDecision } from './llmUsagePolicyService';
import { hasOwnLiveSubscription } from './orgAuthz';
import type { PaygInactiveReason, PaygSuspendedReason, UsageBlockReason } from '../utils/usageBlockCopy';

export const PAYG_OVERAGE_SETTING = 'payg_overage_enabled';
/**
 * Separate AW-Settings row for month-end settlement (PR-2, `paygSettlementService.ts`): turning the gate
 * on must never start charging cards by itself. Same exact-'true' rule and cache as the gate's switch.
 */
export const PAYG_SETTLEMENT_SETTING = 'payg_settlement_enabled';

/** The only caps a customer can pick, as a percentage of their plan's pool. */
export const PAYG_CAP_PERCENTS = [25, 50, 100, 200] as const;
export type PaygCapPercent = (typeof PAYG_CAP_PERCENTS)[number];

export function isPaygCapPercent(value: unknown): value is PaygCapPercent {
  return (PAYG_CAP_PERCENTS as readonly unknown[]).includes(value);
}

/** Tier-level config, admin-managed in `subscription_types`. */
export interface SubscriptionPaygOverageConfig {
  allowed: boolean;
  /**
   * Customer price / provider cost, in basis points (10_000 = 1x). Read by settlement (PR-2). Required
   * when `allowed` is true; a tier that does not offer PAYG need not price it.
   */
  markupBps?: number;
}

export type PaygSuspensionReason = 'payment_failed' | 'dispute';

/** Per-account opt-in, stored on the billing owner's AW-Users row. */
export interface PaygOverageSettings {
  enabled: boolean;
  /**
   * The cap, as a percentage of the month's pool. Deliberately NOT stored in dollars: the cap is
   * re-derived every check from the same pool figure overage is measured against, so "50% of your
   * plan" stays true across top-ups and plan changes, and next month's cap follows next month's pool.
   */
  capPercentOfPool: PaygCapPercent;
  /**
   * The highest effective pool threshold seen in `month` (UTC `YYYY-MM`), not counting top-up credit a
   * refund or dispute can still revoke (seat and admin credit are counted). Overage is measured above the
   * larger of this and today's pool, so a mid-month downgrade never turns usage the customer already had
   * included into retroactive overage, while a revoked top-up stops extending the pool. Written only when
   * it rises.
   */
  poolHighWater?: { month: string; thresholdMicroUsd: number };
  /**
   * Overage already standing when the owner FIRST turned PAYG on (off -> on) in `month` (UTC `YYYY-MM`).
   * Only usage AFTER opting in is ever overage: this is subtracted for that month and ignored after it.
   * Re-enabling later in the same month keeps it (never re-measured), so toggling cannot reset the cap.
   * Covers what the high-water mark cannot — a downgrade that happened BEFORE opting in, when no mark
   * was being kept.
   *
   * `poolAtOptInMicroUsd` is the month's pool the baseline was measured against. If the pool later grows
   * (an upgrade, a top-up), the standing overage shrinks by that growth on its own, so the baseline is
   * reduced by the same amount rather than subtracted twice (see `paygEffectiveBaselineMicroUsd`).
   * Optional only for an opt-in written before it existed; such a baseline is treated as measured
   * against that month's pool high-water mark.
   */
  optIn?: { month: string; overageBaselineMicroUsd: number; poolAtOptInMicroUsd?: number };
  /**
   * The previous month's `poolHighWater` / `optIn`, kept when a new month's value replaces it (the gate
   * rolls the mark over on the first check of a month; the settings route rolls the opt-in on the first
   * opt-in of a month). Settlement runs after the month closes, by which time both may already belong to
   * the new month — without these it would measure the closed month against the wrong pool and baseline.
   * One month only; written in the same conditional update that replaces the live value.
   */
  poolHighWaterClosed?: { month: string; thresholdMicroUsd: number };
  optInClosed?: { month: string; overageBaselineMicroUsd: number; poolAtOptInMicroUsd?: number };
  /**
   * The months (newest first, at most `PAYG_ADMITTED_MONTHS_KEPT`) in which a gate admitted at least one turn on PAYG
   * (`reason: 'payg_overage'`), each with what was in force while it did. Settlement bills a month only
   * when it is listed — spend past the pool in a month PAYG never admitted anything is the ordinary
   * in-flight overrun every plan has, not overage the owner agreed to pay for — and bills it against
   * THIS record, never against settings or a tier read after the month ended. Written by the gate,
   * conditionally, only when an admission changes it (see `PaygAdmittedMonth`).
   */
  admittedMonths?: PaygAdmittedMonth[];
  /** Who last changed the settings (a delegated admin's id when acting as the customer). */
  updatedBy: string;
  updatedAt: string;
  /** Optimistic-concurrency token; every settings write is conditional on the version it read. */
  version: number;
  /**
   * Set by settlement when an overage charge fails (`payment_failed`, lifted once no month's overage
   * invoice is still `failed`) or is disputed (`dispute`, lifted once every dispute on the account is
   * closed and none was lost). Blocks PAYG admission while present.
   */
  suspended?: PaygSuspension;
}

export interface PaygSuspension {
  reason: PaygSuspensionReason;
  at: string;
  invoiceId?: string;
  /** `dispute` only: the dispute that last (re)stamped the hold. */
  disputeId?: string;
  /** `dispute` only: a dispute was lost — never lifted automatically (a person removes the hold). */
  lost?: boolean;
  /**
   * `payment_failed` only: the payment was never confirmed by the owner (3-D Secure) within
   * `PAYG_PAYMENT_CONFIRMATION_GRACE_DAYS`. Lifted like any payment-failure hold: paying the invoice.
   */
  unconfirmed?: boolean;
  /**
   * `dispute` only: when a month last FAILED while the dispute hold covered it. Written so a dispute lift
   * that read the row before that failure cannot remove the hold (its `= :seen` condition fails and it
   * re-reads, then hands the hold to the failed month).
   */
  paymentFailedAt?: string;
}

/** What the 429 says about a hold: the stored reason, refined (an unconfirmed payment, a lost dispute). */
export function paygSuspendedReasonOf(suspended: PaygSuspension | undefined): PaygSuspendedReason | undefined {
  if (suspended?.reason === 'payment_failed') return suspended.unconfirmed ? 'payment_unconfirmed' : 'payment_failed';
  if (suspended?.reason === 'dispute') return suspended.lost ? 'dispute_lost' : 'dispute';
  return undefined;
}

/** Why a PAYG-enabled account is still blocked, when the reason is PAYG's own: drives the 429 copy. */
export interface PaygBlock {
  reason: UsageBlockReason;
  /** Only with `payg_suspended`: why, which decides what lifts it (see `PaygSuspendedReason`). */
  paygSuspendedReason?: PaygSuspendedReason;
  /** Only with `payg_suspended`, for a pooled member: the billing owner is the one who can resolve it. */
  paygOwnerResolves?: boolean;
  /** Only with `payg_inactive`: which admission prerequisite is missing. */
  paygInactiveReason?: PaygInactiveReason;
  /**
   * Only with `payg_suspended`, and only for the billing owner themselves: the Stripe-hosted page of the
   * unpaid overage invoice, where it can be paid with any card. Never sent to a pooled member.
   */
  openInvoiceUrl?: string;
}

/**
 * Whether the owner's subscription lets PAYG cover more usage: active or trialing, or `canceling` — a
 * cancellation scheduled for the period end, during which the plan itself stays fully usable — so PAYG
 * follows plan access and does not tell a paid-up customer to "reactivate".
 */
export function paygSubscriptionCovers(subscriptionStatus: unknown): boolean {
  return subscriptionStatus === 'canceling'
    || hasOwnLiveSubscription({ subscription_status: subscriptionStatus as string | null | undefined });
}

export interface PaygOverageStatus {
  /** Overage since opting in (baseline already subtracted). */
  overageMicroUsd: number;
  /** `capPercentOfPool` x the month's pool, derived for this check. */
  capMicroUsd: number;
  /** The month's pool this check measured overage (and the cap) against. */
  poolMicroUsd: number;
  /** Floor, so 100 is only ever reported once the cap is actually reached. */
  percentOfCap: number;
}

/**
 * What was in force during one month's PAYG admissions. Each figure only ever moves in the customer's
 * favour within the month, so a write is needed only when an admission sees a higher cap or plan pool,
 * or a lower markup:
 *   - `capHighWaterMicroUsd`: the highest cap (`capPercentOfPool` x that moment's pool) any admission
 *     was measured against — the most the owner agreed to be billed for that month. **The cap is a
 *     monthly total:** raising it during the month applies to the whole month, including overrun already
 *     admitted earlier in it (the consent copy says "Your limit applies to the whole month"); lowering it
 *     later does not un-agree to overage already admitted; and no change after the month reaches back.
 *   - `tierPoolHighWaterMicroUsd`: the highest plan pool (the tier's hard threshold, before credits) —
 *     settlement's pool for the month, so a plan change after the month cannot move its bill.
 *   - `markupBps`: the lowest tier markup seen; null when the tier had none (settlement holds the month).
 *   - `spendBasis`: which spend figure the gate measured the month's admissions on — the spend ledger
 *     (what settlement bills) or the legacy LLM-only counter; `mixed` once both were seen. Settlement
 *     bills only a month measured on the ledger throughout, whatever the cutover setting is by then.
 */
export interface PaygAdmittedMonth {
  month: string;
  capHighWaterMicroUsd: number;
  tierPoolHighWaterMicroUsd: number;
  markupBps: number | null;
  spendBasis: PaygSpendBasis;
}

export type PaygSpendBasis = 'spend_ledger' | 'legacy' | 'mixed';

/**
 * Months of `admittedMonths` kept: the current month plus the 12 before it, so every month settlement
 * can still act on (its 12-month window, including a held month set to `retry`) keeps its terms.
 */
export const PAYG_ADMITTED_MONTHS_KEPT = 13;

/** The stored record for `month`, or undefined. Tolerates a malformed list (it bills nothing). */
export function paygAdmittedMonth(
  account: Pick<PaygOverageSettings, 'admittedMonths'> | null | undefined,
  month: string,
): PaygAdmittedMonth | undefined {
  const months = account?.admittedMonths;
  if (!Array.isArray(months)) return undefined;
  return months.find((entry) => entry && typeof entry === 'object' && entry.month === month);
}

/**
 * `admittedMonths` after an admission measured against `seen`, or null when that admission changes
 * nothing (the common case: no write). Newest month first, bounded.
 */
export function withPaygAdmission(
  months: readonly PaygAdmittedMonth[] | null | undefined,
  seen: PaygAdmittedMonth,
): PaygAdmittedMonth[] | null {
  const current = Array.isArray(months) ? months.filter((entry) => entry && typeof entry === 'object') : [];
  const stored = current.find((entry) => entry.month === seen.month);
  const lowerMarkup = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));
  const merged: PaygAdmittedMonth = stored
    ? {
        month: seen.month,
        capHighWaterMicroUsd: Math.max(stored.capHighWaterMicroUsd, seen.capHighWaterMicroUsd),
        tierPoolHighWaterMicroUsd: Math.max(stored.tierPoolHighWaterMicroUsd, seen.tierPoolHighWaterMicroUsd),
        markupBps: lowerMarkup(stored.markupBps, seen.markupBps),
        spendBasis: stored.spendBasis === seen.spendBasis ? stored.spendBasis : 'mixed',
      }
    : seen;
  if (
    stored
    && merged.capHighWaterMicroUsd === stored.capHighWaterMicroUsd
    && merged.tierPoolHighWaterMicroUsd === stored.tierPoolHighWaterMicroUsd
    && merged.markupBps === stored.markupBps
    && merged.spendBasis === stored.spendBasis
  ) {
    return null;
  }
  return [merged, ...current.filter((entry) => entry.month !== seen.month)].slice(0, PAYG_ADMITTED_MONTHS_KEPT);
}

/**
 * The month-scoped PAYG state for `month`: its pool high-water mark and opt-in, from the live fields or
 * the closed-month copies, whichever belongs to that month. Missing for that month = undefined.
 */
export function paygMonthState(
  account: Pick<PaygOverageSettings, 'poolHighWater' | 'poolHighWaterClosed' | 'optIn' | 'optInClosed'> | null | undefined,
  month: string,
): { poolHighWater: PaygOverageSettings['poolHighWater']; optIn: PaygOverageSettings['optIn'] } {
  const pick = <T extends { month: string }>(...candidates: Array<T | undefined>) =>
    candidates.find((candidate) => candidate?.month === month);
  return {
    poolHighWater: pick(account?.poolHighWater, account?.poolHighWaterClosed),
    optIn: pick(account?.optIn, account?.optInClosed),
  };
}

export interface PaygAdmission {
  decision: LlmUsageModeDecision;
  /** Non-null once the account is past its pool with PAYG live (switch, tier and opt-in all on). */
  overage: PaygOverageStatus | null;
  block: PaygBlock | null;
}

/** The month's pool: today's effective threshold or this month's high-water, whichever is higher. */
export function paygOverageThresholdMicroUsd(input: {
  effectiveHardThresholdMicroUsd: number;
  poolHighWater: PaygOverageSettings['poolHighWater'] | null | undefined;
  month: string;
}): number {
  const highWater = input.poolHighWater?.month === input.month
    && Number.isFinite(input.poolHighWater.thresholdMicroUsd)
    ? input.poolHighWater.thresholdMicroUsd
    : 0;
  return Math.max(input.effectiveHardThresholdMicroUsd, highWater);
}

/** `capPercentOfPool` x the pool threshold, in whole micro-USD. */
export function paygCapMicroUsd(capPercentOfPool: PaygCapPercent, poolThresholdMicroUsd: number): number {
  return Math.floor((poolThresholdMicroUsd * capPercentOfPool) / 100);
}

/** Overage above the month's pool before any opt-in baseline: what the baseline is recorded from. */
export function paygGrossOverageMicroUsd(costUsedMicroUsd: number, poolMicroUsd: number): number {
  return Math.max(0, Math.round(costUsedMicroUsd) - Math.round(poolMicroUsd));
}

/**
 * The opt-in baseline that still applies at this check, given the month's pool now.
 *
 * The baseline is the overage standing at opt-in, measured against the pool THEN. Growth of the pool
 * since (an upgrade, a top-up) already lowers today's gross overage by exactly that growth, so
 * subtracting the full baseline as well would discount the same dollars twice and hide real
 * post-opt-in usage from the cap. The baseline shrinks by the growth instead, never below 0. The pool
 * only shrinks below the opt-in pool within the month when a top-up is refunded or disputed (opting in
 * raises the high-water mark to the rest of it); then the revoked capacity rightly stops covering usage.
 *
 * An opt-in from another month contributes nothing. One written before `poolAtOptInMicroUsd` existed is
 * read as measured against the month's high-water mark (or today's pool when there is none, i.e. no
 * growth). Returns NaN for an unreadable stored baseline, which the caller treats as unreadable input.
 */
export function paygEffectiveBaselineMicroUsd(input: {
  optIn: PaygOverageSettings['optIn'] | null | undefined;
  poolHighWater: PaygOverageSettings['poolHighWater'] | null | undefined;
  month: string;
  poolMicroUsd: number;
}): number {
  const optIn = input.optIn;
  if (!optIn || optIn.month !== input.month) return 0;
  const baseline = optIn.overageBaselineMicroUsd;
  if (!Number.isFinite(baseline) || baseline < 0) return Number.NaN;
  const legacyPoolAtOptIn = input.poolHighWater?.month === input.month && Number.isFinite(input.poolHighWater.thresholdMicroUsd)
    ? input.poolHighWater.thresholdMicroUsd
    : input.poolMicroUsd;
  const poolAtOptIn = Number.isFinite(optIn.poolAtOptInMicroUsd) ? (optIn.poolAtOptInMicroUsd as number) : legacyPoolAtOptIn;
  const poolGrowth = Math.max(0, Math.round(input.poolMicroUsd) - Math.round(poolAtOptIn));
  return Math.max(0, Math.round(baseline) - poolGrowth);
}

/**
 * Overage since opting in (gross overage above the month's pool, less the opt-in baseline that still
 * applies), or NaN when an input is unreadable. The one definition the gates admit against and
 * settlement bills from (`paygSettlement.ts`), so the two cannot disagree for the same inputs.
 */
export function paygNetOverageMicroUsd(input: {
  optIn: PaygOverageSettings['optIn'] | null | undefined;
  poolHighWater: PaygOverageSettings['poolHighWater'] | null | undefined;
  costUsedMicroUsd: number;
  /** From `paygOverageThresholdMicroUsd`: the month's pool. */
  overageThresholdMicroUsd: number;
  /** UTC `YYYY-MM`; the opt-in baseline applies only in its own month. */
  month: string;
}): number {
  if (!Number.isFinite(input.costUsedMicroUsd) || !Number.isFinite(input.overageThresholdMicroUsd)) return Number.NaN;
  const baseline = paygEffectiveBaselineMicroUsd({
    optIn: input.optIn,
    poolHighWater: input.poolHighWater,
    month: input.month,
    poolMicroUsd: input.overageThresholdMicroUsd,
  });
  if (!Number.isFinite(baseline)) return Number.NaN;
  return Math.max(0, paygGrossOverageMicroUsd(input.costUsedMicroUsd, input.overageThresholdMicroUsd) - baseline);
}

/**
 * The gate's measurement: overage since opting in, the cap, and the pool both are measured on. Null
 * when it cannot be measured (unreadable spend, pool or stored baseline, no cap) — the gate then keeps
 * the 429.
 */
export function measurePaygOverage(input: {
  capPercentOfPool: unknown;
  optIn: PaygOverageSettings['optIn'] | null | undefined;
  poolHighWater: PaygOverageSettings['poolHighWater'] | null | undefined;
  costUsedMicroUsd: number;
  /** From `paygOverageThresholdMicroUsd`: the month's pool, which overage AND the cap are measured on. */
  overageThresholdMicroUsd: number;
  /** UTC `YYYY-MM`; the opt-in baseline applies only in its own month. */
  month: string;
}): PaygOverageStatus | null {
  if (!isPaygCapPercent(input.capPercentOfPool)) return null;
  if (!Number.isFinite(input.costUsedMicroUsd) || !Number.isFinite(input.overageThresholdMicroUsd)) return null;

  const capMicroUsd = paygCapMicroUsd(input.capPercentOfPool, input.overageThresholdMicroUsd);
  if (capMicroUsd <= 0) return null;
  const overageMicroUsd = paygNetOverageMicroUsd(input);
  if (!Number.isFinite(overageMicroUsd)) return null;
  return {
    overageMicroUsd,
    capMicroUsd,
    poolMicroUsd: Math.round(input.overageThresholdMicroUsd),
    percentOfCap: Math.floor((overageMicroUsd / capMicroUsd) * 100),
  };
}

/**
 * Admit a turn past the plan pool, or keep the 429.
 *
 * Acts ONLY on `hard_threshold_reached`; every other decision is returned as-is, so with the switch
 * off — or for any account that never opted in — the gates behave exactly as they did before PAYG.
 * Admits (reason `payg_overage`, mode `full_choice`) only when all of these hold:
 *   - the switch is on;
 *   - the tier allows PAYG (`allowed === true`);
 *   - the billing owner opted in (`enabled === true`) and is not suspended;
 *   - a payment method is on file (cached flag, `=== true`);
 *   - the subscription is active, trialing, or canceling at the period end (`paygSubscriptionCovers`);
 *   - overage since opting in is still below `capPercentOfPool` of the month's pool.
 */
export function evaluatePaygAdmission(input: {
  decision: LlmUsageModeDecision;
  switchOn: boolean;
  tier: SubscriptionPaygOverageConfig | null | undefined;
  account: PaygOverageSettings | null | undefined;
  hasPaymentMethod: unknown;
  subscriptionStatus: unknown;
  costUsedMicroUsd: number;
  /** From `paygOverageThresholdMicroUsd`: the month's pool, which overage AND the cap are measured on. */
  overageThresholdMicroUsd: number;
  /** UTC `YYYY-MM` of this check; the opt-in baseline applies only in its own month. */
  month: string;
}): PaygAdmission {
  const keep: PaygAdmission = { decision: input.decision, overage: null, block: null };
  if (input.decision.reason !== 'hard_threshold_reached') return keep;
  if (input.switchOn !== true) return keep;
  if (input.tier?.allowed !== true) return keep;
  const account = input.account;
  if (account?.enabled !== true) return keep;

  const overage = measurePaygOverage({
    capPercentOfPool: account.capPercentOfPool,
    optIn: account.optIn,
    poolHighWater: account.poolHighWater,
    costUsedMicroUsd: input.costUsedMicroUsd,
    overageThresholdMicroUsd: input.overageThresholdMicroUsd,
    month: input.month,
  });
  if (!overage) return keep;

  if (account.suspended) {
    const paygSuspendedReason = paygSuspendedReasonOf(account.suspended);
    return { ...keep, overage, block: { reason: 'payg_suspended', ...(paygSuspendedReason ? { paygSuspendedReason } : {}) } };
  }
  if (input.hasPaymentMethod !== true) {
    return { ...keep, overage, block: { reason: 'payg_inactive', paygInactiveReason: 'no_payment_method' } };
  }
  if (!paygSubscriptionCovers(input.subscriptionStatus)) {
    return { ...keep, overage, block: { reason: 'payg_inactive', paygInactiveReason: 'subscription_inactive' } };
  }
  if (overage.overageMicroUsd >= overage.capMicroUsd) return { ...keep, overage, block: { reason: 'payg_cap_reached' } };

  return {
    decision: { usageMode: 'full_choice', admissionAllowed: true, reason: 'payg_overage' },
    overage,
    block: null,
  };
}

/** The customer-safe view of a stored opt-in: no micro-USD (high-water mark, opt-in baseline). */
export function toCustomerPaygOverage(
  settings: Partial<PaygOverageSettings> | null | undefined,
): { enabled: boolean; capPercentOfPool: PaygCapPercent | null } | undefined {
  if (!settings || typeof settings !== 'object') return undefined;
  return {
    enabled: settings.enabled === true,
    capPercentOfPool: isPaygCapPercent(settings.capPercentOfPool) ? settings.capPercentOfPool : null,
  };
}

/**
 * Validates a tier's `paygOverage` block (admin save). Present-but-invalid is an error, never coerced.
 * `markupBps` is required only when the tier offers PAYG.
 */
export function validatePaygOverageTierConfig(config: SubscriptionPaygOverageConfig): string[] {
  const errors: string[] = [];
  if (typeof config.allowed !== 'boolean') errors.push('allowed must be boolean');
  // Same floor as llmUsageTopUp.minimumMarkupBps: overage is never sold below cost.
  if (
    (config.allowed === true || config.markupBps !== undefined)
    && (!Number.isInteger(config.markupBps) || (config.markupBps as number) < 10_000)
  ) {
    errors.push('markupBps must be an integer of at least 10000 (1x)');
  }
  return errors;
}

export interface ExactTrueSwitchDeps {
  getSetting(name: string): Promise<{ settingValue?: unknown } | null>;
  now(): number;
  log(message: string, fields?: Record<string, unknown>): void;
}

const CACHE_TTL_MS = 60_000;
/** After a failed refresh, retry sooner than a full window but not on every request. */
const ERROR_RETRY_MS = 5_000;

/**
 * A cached reader for one exact-'true' AW-Settings switch (the gate's `PAYG_OVERAGE_SETTING`, settlement's
 * `PAYG_SETTLEMENT_SETTING`): only the exact string 'true' turns it on; absent, anything else, or a
 * cold-start read failure is off; a read is cached ~60s and a failed refresh keeps the last-known value.
 */
export function createExactTrueSwitch(deps: ExactTrueSwitchDeps, settingName: string) {
  let known = false; // last successfully read value; cold start => off
  let validUntil = 0;
  let inFlight: Promise<void> | null = null; // one refresh at a time

  async function refresh(now: number): Promise<void> {
    try {
      const row = await deps.getSetting(settingName);
      known = row?.settingValue === 'true';
      validUntil = now + CACHE_TTL_MS;
    } catch (error) {
      deps.log('PaygOverage: failed to read a PAYG switch; keeping last-known value (off if none)', {
        setting: settingName,
        errorClass: (error as Error)?.name ?? 'Error',
        known,
      });
      validUntil = now + ERROR_RETRY_MS;
    }
  }

  async function isEnabled(): Promise<boolean> {
    const now = deps.now();
    if (now >= validUntil) {
      inFlight ??= refresh(now).finally(() => { inFlight = null; });
      await inFlight;
    }
    return known;
  }

  return { isEnabled };
}
