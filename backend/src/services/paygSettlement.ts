/**
 * ENG-668 PR-2: what month-end pay-as-you-go settlement bills for a closed month — pure, no I/O.
 *
 * The amount is measured with the SAME functions the admission gates use (`resolveLlmUsagePoolDecision`
 * -> `applyLlmUsageCredits` -> `paygOverageThresholdMicroUsd` -> `measurePaygOverage`), never a second
 * derivation: what the customer is billed for is exactly the overage the gates admitted them into. Only
 * the inputs differ, and only in being final:
 *   - spend is the AUTHORITATIVE settled total summed from AW-SpendEvents, not the gate's fail-open
 *     projection read (the caller cross-checks the two and holds the month if they drift);
 *   - credits, the pool high-water mark and the opt-in baseline are the closed month's, read from the
 *     live fields or the copies kept when the month rolled over (`llmUsageCreditsClosed`,
 *     `poolHighWaterClosed`, `optInClosed`).
 *
 * Billable = min(overage after the opt-in baseline, the month's cap) x (1 + markup), in whole cents,
 * rounded down. Every rounding goes the customer's way.
 */
import {
  applyLlmUsageCredits,
  getCurrentUsageMonth,
  getLlmUsageCreditAdjustment,
  type MonthlyLlmUsageCredits,
} from './llmUsageCreditService';
import type { LlmUsagePolicy } from './llmUsagePolicyService';
import {
  measurePaygOverage,
  paygMonthState,
  paygOverageThresholdMicroUsd,
  type PaygOverageSettings,
  type PaygOverageStatus,
} from './paygOverage';

/**
 * `pending` — recorded BEFORE any Stripe call, with the amount fixed; Stripe is (still) being asked.
 * `invoiced` — the invoice is finalized and Stripe is collecting it. `paid` / `failed` — from webhooks.
 * `held` — not billed, on purpose: the inputs did not reconcile (or could not be read); on-call was told
 * once. `nothing_to_bill` — no overage (or less than Stripe can charge). Only `pending` is ever resumed;
 * `held` stays held until someone removes the record after looking at it.
 */
export type PaygSettlementStatus = 'pending' | 'invoiced' | 'paid' | 'failed' | 'held' | 'nothing_to_bill';

export type PaygSettlementHeldReason =
  /** Settled spend events and the persisted projection disagree beyond the §3 tolerance. */
  | 'spend_drift'
  /** The gate measured this owner on the legacy LLM-only counter, not the spend ledger being billed. */
  | 'legacy_spend_basis'
  /** The tier has no usable pool or the stored PAYG state is unreadable. */
  | 'unmeasurable'
  /** The tier has no valid `paygOverage.markupBps`. */
  | 'no_price'
  /** No live Stripe customer to invoice. */
  | 'no_stripe_customer'
  /** The invoice Stripe holds does not match the record (voided, or a different amount). */
  | 'invoice_mismatch';

export interface PaygSettlement {
  status: PaygSettlementStatus;
  /** `payg:{billingUserId}:{month}`; Stripe's keys and the invoice's metadata are derived from it. */
  idempotencyKey: string;
  /** Provider cost billed: min(overage since opting in, the month's cap), micro-USD. */
  overageCostMicroUsd: number;
  /** `overageCostMicroUsd` x the tier markup, rounded down to whole micro-USD. */
  billedMicroUsd: number;
  /** What the invoice charges: `billedMicroUsd` in whole cents, rounded down. */
  amountCents: number;
  markupBps: number | null;
  /** The billed overage as a whole percentage of the month's cap — what the owner email shows. */
  percentOfCap: number;
  /** Settled spend summed from AW-SpendEvents for the month (the billing basis). */
  settledMicroUsd: number;
  /** The persisted projection it was reconciled against; null when there was none. */
  projectedMicroUsd: number | null;
  createdAt: string;
  updatedAt: string;
  heldReason?: PaygSettlementHeldReason;
  nothingToBillReason?: 'no_overage' | 'below_minimum';
  invoiceId?: string;
  invoicedAt?: string;
  paidAt?: string;
  failedAt?: string;
  /** Cumulative cents refunded on the overage charge (recorded only; a refund never resumes PAYG). */
  refundedCents?: number;
  dispute?: { disputeId: string; at: string };
}

/** AW-Users `paygSettlements`, keyed by UTC `YYYY-MM`. */
export type PaygSettlements = Record<string, PaygSettlement>;

/** Months of `paygSettlements` kept on the row: the month being written and the 11 before it. */
export const PAYG_SETTLEMENT_MONTHS_KEPT = 12;

/**
 * Stripe cannot charge less than $0.50 USD; an invoice under it is marked paid and the amount is pushed
 * onto the customer's NEXT invoice — the subscription's. A month under it is not billed at all.
 */
export const PAYG_MIN_INVOICE_CENTS = 50;

/** Stripe keeps an idempotency key for 24h; a `pending` record older than that is searched for first. */
export const PAYG_STRIPE_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function paygSettlementIdempotencyKey(billingUserId: string, month: string): string {
  return `payg:${billingUserId}:${month}`;
}

/** The UTC month before `now`'s. */
export function previousUsageMonth(now: Date): string {
  return getCurrentUsageMonth(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
}

/** Months of a stored `paygSettlements` map older than the retention window ending at `month`. */
export function paygSettlementMonthsToPrune(settlements: PaygSettlements | null | undefined, month: string): string[] {
  const [year, monthNum] = month.split('-').map(Number);
  const oldestKept = getCurrentUsageMonth(new Date(Date.UTC(year, monthNum - PAYG_SETTLEMENT_MONTHS_KEPT, 1)));
  return Object.keys(settlements ?? {}).filter((m) => m < oldestKept);
}

export interface PaygSettlementAmount {
  /** The gate's measurement for the closed month (overage, cap and pool). */
  overage: PaygOverageStatus;
  overageCostMicroUsd: number;
  billedMicroUsd: number;
  amountCents: number;
  percentOfCap: number;
}

/**
 * The amount owed for `month`, or null when it cannot be measured (no enforced pool, unreadable stored
 * PAYG state, invalid markup) — the caller holds the month rather than guess.
 */
export function computePaygSettlementAmount(input: {
  month: string;
  account: PaygOverageSettings;
  /** The tier's policy; its hard threshold is the plan pool before credits. */
  basePolicy: LlmUsagePolicy | null | undefined;
  /** That month's credit ledger (live or closed). */
  creditLedger: MonthlyLlmUsageCredits | null | undefined;
  /** Authoritative settled spend for the month, micro-USD. */
  settledMicroUsd: number;
  markupBps: unknown;
}): PaygSettlementAmount | null {
  const hardThreshold = input.basePolicy?.hardCostThresholdMicroUsd;
  if (!Number.isFinite(hardThreshold) || (hardThreshold as number) <= 0) return null;
  if (!Number.isInteger(input.markupBps) || (input.markupBps as number) < 10_000) return null;
  if (!Number.isFinite(input.settledMicroUsd) || input.settledMicroUsd < 0) return null;
  const markupBps = input.markupBps as number;

  // The gate's pipeline, in the gate's order (llmUsagePoolDecision.ts).
  const adjusted = applyLlmUsageCredits({
    rawCostUsedMicroUsd: input.settledMicroUsd,
    hardThresholdMicroUsd: hardThreshold as number,
    adjustment: getLlmUsageCreditAdjustment(input.creditLedger, input.month),
  });
  const { poolHighWater, optIn } = paygMonthState(input.account, input.month);
  const overage = measurePaygOverage({
    capPercentOfPool: input.account.capPercentOfPool,
    optIn,
    poolHighWater,
    costUsedMicroUsd: adjusted.policyCostUsedMicroUsd,
    overageThresholdMicroUsd: paygOverageThresholdMicroUsd({
      effectiveHardThresholdMicroUsd: adjusted.effectiveHardThresholdMicroUsd,
      poolHighWater,
      month: input.month,
    }),
    month: input.month,
  });
  if (!overage) return null;

  // The gate stops admitting at the cap, but work already in flight can run past it: never bill past it.
  const overageCostMicroUsd = Math.min(overage.overageMicroUsd, overage.capMicroUsd);
  const billedMicroUsd = Math.floor((overageCostMicroUsd * markupBps) / 10_000);
  return {
    overage,
    overageCostMicroUsd,
    billedMicroUsd,
    amountCents: Math.floor(billedMicroUsd / 10_000),
    percentOfCap: Math.floor((overageCostMicroUsd / overage.capMicroUsd) * 100),
  };
}
