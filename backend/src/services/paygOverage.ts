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
 *   - `User.paygOverage` on the BILLING OWNER's row — the opt-in, the frozen cap, the month's pool
 *     high-water mark, and a suspension set by settlement when a charge fails.
 *
 * Every input that is missing or unreadable keeps the 429. Being paused by mistake is recoverable; an
 * uncapped account billed for usage it did not agree to is not.
 */
import type { LlmUsageModeDecision } from './llmUsagePolicyService';
import { hasOwnLiveSubscription } from './orgAuthz';
import type { UsageBlockReason } from '../utils/usageBlockCopy';

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
  /** Customer price / provider cost, in basis points (10_000 = 1x). Read by settlement (PR-2). */
  markupBps: number;
}

export type PaygSuspensionReason = 'payment_failed' | 'dispute';

/** Per-account opt-in, stored on the billing owner's AW-Users row. */
export interface PaygOverageSettings {
  enabled: boolean;
  capPercentOfPool: PaygCapPercent;
  /**
   * The cap in micro-USD, frozen when it was set: `capPercentOfPool` x the account's effective pool
   * threshold (after credits) at that moment. Frozen so a later top-up or plan change cannot silently
   * move a ceiling the customer agreed to. Never shown to the customer.
   */
  capMicroUsd: number;
  /**
   * The highest effective pool threshold seen in `month` (UTC `YYYY-MM`). Overage is measured above
   * this, not above today's threshold, so a mid-month downgrade never turns usage the customer already
   * had included into retroactive overage. Written only when it rises.
   */
  poolHighWater?: { month: string; thresholdMicroUsd: number };
  enabledBy: string;
  updatedAt: string;
  /** Optimistic-concurrency token; every settings write is conditional on the version it read. */
  version: number;
  /** Set by settlement when an overage charge fails. Blocks PAYG admission until cleared. */
  suspended?: { reason: PaygSuspensionReason; at: string; invoiceId?: string };
}

/** Why a PAYG-enabled account is still blocked, when the reason is PAYG's own (the 429 copy variant). */
export type PaygBlockReason = UsageBlockReason;

export interface PaygOverageStatus {
  overageMicroUsd: number;
  capMicroUsd: number;
  /** Floor, so 100 is only ever reported once the cap is actually reached. */
  percentOfCap: number;
}

export interface PaygAdmission {
  decision: LlmUsageModeDecision;
  /** Non-null once the account is past its pool with PAYG live (switch, tier and opt-in all on). */
  overage: PaygOverageStatus | null;
  blockReason: PaygBlockReason | null;
}

/** The threshold overage is measured from: today's effective threshold or this month's high-water. */
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
 *   - overage above the pool is still below the frozen cap.
 */
export function evaluatePaygAdmission(input: {
  decision: LlmUsageModeDecision;
  switchOn: boolean;
  tier: SubscriptionPaygOverageConfig | null | undefined;
  account: PaygOverageSettings | null | undefined;
  hasPaymentMethod: unknown;
  subscriptionStatus: unknown;
  costUsedMicroUsd: number;
  /** From `paygOverageThresholdMicroUsd`: today's effective threshold or the month's high-water. */
  overageThresholdMicroUsd: number;
}): PaygAdmission {
  const keep: PaygAdmission = { decision: input.decision, overage: null, blockReason: null };
  if (input.decision.reason !== 'hard_threshold_reached') return keep;
  if (input.switchOn !== true) return keep;
  if (input.tier?.allowed !== true) return keep;
  const account = input.account;
  if (account?.enabled !== true) return keep;

  const capMicroUsd = account.capMicroUsd;
  if (!Number.isInteger(capMicroUsd) || capMicroUsd <= 0) return keep;
  if (!Number.isFinite(input.costUsedMicroUsd) || !Number.isFinite(input.overageThresholdMicroUsd)) return keep;

  const overageMicroUsd = Math.max(0, Math.round(input.costUsedMicroUsd) - Math.round(input.overageThresholdMicroUsd));
  const overage: PaygOverageStatus = {
    overageMicroUsd,
    capMicroUsd,
    percentOfCap: Math.floor((overageMicroUsd / capMicroUsd) * 100),
  };

  if (account.suspended) return { ...keep, overage, blockReason: 'payg_suspended' };
  if (input.hasPaymentMethod !== true) return { ...keep, overage };
  if (!hasOwnLiveSubscription({ subscription_status: input.subscriptionStatus as string | null | undefined })) {
    return { ...keep, overage };
  }
  if (overageMicroUsd >= capMicroUsd) return { ...keep, overage, blockReason: 'payg_cap_reached' };

  return {
    decision: { usageMode: 'full_choice', admissionAllowed: true, reason: 'payg_overage' },
    overage,
    blockReason: null,
  };
}

/** Validates a tier's `paygOverage` block (admin save). Present-but-invalid is an error, never coerced. */
export function validatePaygOverageTierConfig(config: SubscriptionPaygOverageConfig): string[] {
  const errors: string[] = [];
  if (typeof config.allowed !== 'boolean') errors.push('allowed must be boolean');
  // Same floor as llmUsageTopUp.minimumMarkupBps: overage is never sold below cost.
  if (!Number.isInteger(config.markupBps) || config.markupBps < 10_000) {
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
