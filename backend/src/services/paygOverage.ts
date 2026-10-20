/**
 * ENG-668: opt-in pay-as-you-go overages for the Emma usage pool.
 *
 * Today an account that reaches its plan's hard cost threshold is paused (429 `usage_paused`) until the
 * month resets or it buys a top-up. With PAYG enabled, the billing owner instead keeps working past the
 * pool up to a cap they chose, and the overage is settled later (PR-2; this module charges nothing).
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
 *   - `SubscriptionType.paygOverage` — whether the tier may opt in, and the markup PR-2 will bill at.
 *   - `User.paygOverage` on the BILLING OWNER's row — the opt-in and its cap (a percentage only), the
 *     month's pool high-water mark, the overage already standing when the owner opted in, and a
 *     suspension set by settlement when a charge fails.
 *
 * Every input that is missing or unreadable keeps the 429. Being paused by mistake is recoverable; an
 * uncapped account billed for usage it did not agree to is not.
 */
import type { LlmUsageModeDecision } from './llmUsagePolicyService';
import { hasOwnLiveSubscription } from './orgAuthz';
import type { PaygInactiveReason, UsageBlockReason } from '../utils/usageBlockCopy';

export const PAYG_OVERAGE_SETTING = 'payg_overage_enabled';

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
  /** Who last changed the settings (a delegated admin's id when acting as the customer). */
  updatedBy: string;
  updatedAt: string;
  /** Optimistic-concurrency token; every settings write is conditional on the version it read. */
  version: number;
  /** Set by settlement when an overage charge fails. Blocks PAYG admission until cleared. */
  suspended?: { reason: PaygSuspensionReason; at: string; invoiceId?: string };
}

/** Why a PAYG-enabled account is still blocked, when the reason is PAYG's own: drives the 429 copy. */
export interface PaygBlock {
  reason: UsageBlockReason;
  /** Only with `payg_inactive`: which admission prerequisite is missing. */
  paygInactiveReason?: PaygInactiveReason;
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
 * Admit a turn past the plan pool, or keep the 429.
 *
 * Acts ONLY on `hard_threshold_reached`; every other decision is returned as-is, so with the switch
 * off — or for any account that never opted in — the gates behave exactly as they did before PAYG.
 * Admits (reason `payg_overage`, mode `full_choice`) only when all of these hold:
 *   - the switch is on;
 *   - the tier allows PAYG (`allowed === true`);
 *   - the billing owner opted in (`enabled === true`) and is not suspended;
 *   - a payment method is on file (cached flag, `=== true`);
 *   - the subscription is active or trialing;
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
  if (!isPaygCapPercent(account.capPercentOfPool)) return keep;
  if (!Number.isFinite(input.costUsedMicroUsd) || !Number.isFinite(input.overageThresholdMicroUsd)) return keep;

  const capMicroUsd = paygCapMicroUsd(account.capPercentOfPool, input.overageThresholdMicroUsd);
  if (capMicroUsd <= 0) return keep;
  const baseline = paygEffectiveBaselineMicroUsd({
    optIn: account.optIn,
    poolHighWater: account.poolHighWater,
    month: input.month,
    poolMicroUsd: input.overageThresholdMicroUsd,
  });
  if (!Number.isFinite(baseline)) return keep;

  const overageMicroUsd = Math.max(
    0,
    paygGrossOverageMicroUsd(input.costUsedMicroUsd, input.overageThresholdMicroUsd) - baseline,
  );
  const overage: PaygOverageStatus = {
    overageMicroUsd,
    capMicroUsd,
    poolMicroUsd: Math.round(input.overageThresholdMicroUsd),
    percentOfCap: Math.floor((overageMicroUsd / capMicroUsd) * 100),
  };

  if (account.suspended) return { ...keep, overage, block: { reason: 'payg_suspended' } };
  if (input.hasPaymentMethod !== true) {
    return { ...keep, overage, block: { reason: 'payg_inactive', paygInactiveReason: 'no_payment_method' } };
  }
  if (!hasOwnLiveSubscription({ subscription_status: input.subscriptionStatus as string | null | undefined })) {
    return { ...keep, overage, block: { reason: 'payg_inactive', paygInactiveReason: 'subscription_inactive' } };
  }
  if (overageMicroUsd >= capMicroUsd) return { ...keep, overage, block: { reason: 'payg_cap_reached' } };

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

export interface PaygOverageSwitchDeps {
  getSetting(name: string): Promise<{ settingValue?: unknown } | null>;
  now(): number;
  log(message: string, fields?: Record<string, unknown>): void;
}

const CACHE_TTL_MS = 60_000;
/** After a failed refresh, retry sooner than a full window but not on every request. */
const ERROR_RETRY_MS = 5_000;

export function createPaygOverageSwitch(deps: PaygOverageSwitchDeps) {
  let known = false; // last successfully read value; cold start => off
  let validUntil = 0;
  let inFlight: Promise<void> | null = null; // one refresh at a time

  async function refresh(now: number): Promise<void> {
    try {
      const row = await deps.getSetting(PAYG_OVERAGE_SETTING);
      known = row?.settingValue === 'true';
      validUntil = now + CACHE_TTL_MS;
    } catch (error) {
      deps.log('PaygOverage: failed to read the PAYG switch; keeping last-known value (off if none)', {
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
