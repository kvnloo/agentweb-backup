/**
 * ENG-668 PR-2: what month-end pay-as-you-go settlement bills for a closed month — pure, no I/O.
 *
 * The overage is measured with the SAME functions the admission gates use (`resolveLlmUsagePoolDecision`
 * -> `applyLlmUsageCredits` -> `paygOverageThresholdMicroUsd` -> `paygNetOverageMicroUsd`), never a
 * second derivation: what the customer is billed for is exactly the overage the gates admitted them
 * into. Every input belongs to the month being billed — nothing written after it ends can move its bill:
 *   - spend is the AUTHORITATIVE settled total summed from AW-SpendEvents, not the gate's fail-open
 *     projection read (the caller cross-checks the two and holds the month if they drift);
 *   - credits, the pool high-water mark and the opt-in baseline are the month's own, read from the live
 *     fields or the copies kept when the month rolled over (`llmUsageCreditsClosed`,
 *     `poolHighWaterClosed`, `optInClosed`) while it is the month that just closed, and frozen on the
 *     settlement record (`inputs`) for any later re-measurement (`retry`);
 *   - the plan pool, the cap and the markup are the month's `admittedMonths` record, written by the gate
 *     at admission — never the tier or the cap setting as they stand at settlement.
 *
 * Billable = min(overage after the opt-in baseline, the highest cap in force at an admission that month)
 * x (1 + markup), in whole cents, rounded down. Every rounding goes the customer's way.
 */
import {
  applyLlmUsageCredits,
  getCurrentUsageMonth,
  getLlmUsageCreditAdjustment,
  getLlmUsageCreditLedgerForMonth,
  type LlmUsageCreditAdjustment,
} from './llmUsageCreditService';
import type { User } from './db';
import {
  paygMonthState,
  paygNetOverageMicroUsd,
  paygOverageThresholdMicroUsd,
  type PaygAdmittedMonth,
} from './paygOverage';

/**
 * `pending` — recorded BEFORE any Stripe call, with the amount fixed; Stripe is (still) being asked.
 * `invoiced` — the invoice is finalized and Stripe is collecting it. `paid` / `failed` — from webhooks.
 * `held` — not billed, on purpose: the inputs did not reconcile (or could not be read); on-call was told
 * once. `nothing_to_bill` — no overage (or less than Stripe can charge). `retry` — set BY HAND on a held
 * month once its cause is fixed: the next daily run measures the month again from the inputs frozen on
 * the record (`inputs`) and fresh spend, and searches Stripe before creating anything. Only `pending`
 * and `retry` are ever acted on by the sweep; everything else is final.
 */
export type PaygSettlementStatus = 'pending' | 'invoiced' | 'paid' | 'failed' | 'held' | 'nothing_to_bill' | 'retry';

export type PaygSettlementHeldReason =
  /** Settled spend events and the persisted projection disagree beyond the §3 tolerance. */
  | 'spend_drift'
  /** The gate measured this owner on the legacy LLM-only counter, not the spend ledger being billed. */
  | 'legacy_spend_basis'
  /** The month's admission record or the stored PAYG state is unreadable. */
  | 'unmeasurable'
  /** The tier had no valid `paygOverage.markupBps` when PAYG admitted in the month. */
  | 'no_price'
  /** No live Stripe customer to invoice. */
  | 'no_stripe_customer'
  /**
   * The month's credits, pool mark and opt-in are no longer on the row (each is kept one month past its
   * own) and no earlier settlement froze them: the month cannot be measured safely, so it is not billed.
   */
  | 'inputs_unavailable'
  /**
   * The invoice is not the one the record expects: its total is not the recorded amount (a customer
   * discount or coupon — a credit balance lowers what is due, not the total), or the invoice the record
   * names is void, deleted or unknown to Stripe. A draft is deleted before it is ever finalized, so
   * nothing is collected; a finalized one is left to Stripe and its id kept on the record.
   */
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
  /**
   * The month's own inputs, frozen when the month was first measured — the row only keeps them one month
   * past their own, so a `retry` months later measures against these, not against what the row holds now.
   */
  inputs?: PaygMonthInputs;
  /** When a `retry` re-measured this month (the record was re-created in place). */
  retriedAt?: string;
  heldReason?: PaygSettlementHeldReason;
  nothingToBillReason?: 'no_overage' | 'below_minimum';
  invoiceId?: string;
  /**
   * On `invoice_mismatch`, an invoice that collected nothing and is no longer the record's: a draft
   * deleted before finalizing, or one Stripe reports void or missing. Audit only.
   */
  uncollectedInvoice?: { invoiceId: string; reason: 'draft_deleted' | 'void' | 'missing' };
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

/** What a month is measured against besides spend and its admission record: its credits, pool mark, opt-in. */
export interface PaygMonthInputs {
  credits: LlmUsageCreditAdjustment;
  poolHighWater?: { month: string; thresholdMicroUsd: number };
  optIn?: { month: string; overageBaselineMicroUsd: number; poolAtOptInMicroUsd?: number };
}

/**
 * `month`'s inputs from the row (live fields or the closed-month copies), or null when the row no longer
 * holds them. They are reliable only while `month` is the month that just closed (`closingMonth`): each
 * closed copy is kept one month, and an absent ledger then means "no credits", not "already dropped".
 */
export function paygMonthInputsFromRow(
  user: Pick<User, 'llmUsageCredits' | 'llmUsageCreditsClosed' | 'paygOverage'>,
  month: string,
  closingMonth: string,
): PaygMonthInputs | null {
  if (month !== closingMonth) return null;
  const { poolHighWater, optIn } = paygMonthState(user.paygOverage, month);
  return {
    credits: getLlmUsageCreditAdjustment(getLlmUsageCreditLedgerForMonth(user, month), month),
    ...(poolHighWater ? { poolHighWater } : {}),
    ...(optIn ? { optIn } : {}),
  };
}

export interface PaygSettlementAmount {
  /** Overage since opting in, above the month's pool (before the cap). */
  netOverageMicroUsd: number;
  /** The month's pool: its plan pool plus its credits, or its high-water mark, whichever is higher. */
  poolMicroUsd: number;
  /** The highest cap in force at any admission in the month. */
  capMicroUsd: number;
  markupBps: number;
  overageCostMicroUsd: number;
  billedMicroUsd: number;
  amountCents: number;
  percentOfCap: number;
}

/** The month's recorded markup when it is a usable price (at least 1x, whole basis points), else null. */
export function paygAdmittedMarkupBps(admitted: PaygAdmittedMonth): number | null {
  const markup = admitted.markupBps;
  return typeof markup === 'number' && Number.isInteger(markup) && markup >= 10_000 ? markup : null;
}

/**
 * The amount owed for `month`, or null when it cannot be measured (an unusable admission record or no
 * price, unreadable stored PAYG state) — the caller holds the month rather than guess.
 */
export function computePaygSettlementAmount(input: {
  month: string;
  /** The month's admission record: its plan pool, cap and markup. */
  admitted: PaygAdmittedMonth;
  /** The month's credits, pool mark and opt-in (`paygMonthInputsFromRow`, or frozen on the record). */
  inputs: PaygMonthInputs;
  /** Authoritative settled spend for the month, micro-USD. */
  settledMicroUsd: number;
}): PaygSettlementAmount | null {
  const { admitted, inputs } = input;
  const markupBps = paygAdmittedMarkupBps(admitted);
  const { tierPoolHighWaterMicroUsd: tierPool, capHighWaterMicroUsd: capMicroUsd } = admitted;
  if (markupBps === null) return null;
  if (!Number.isFinite(tierPool) || tierPool <= 0 || !Number.isFinite(capMicroUsd) || capMicroUsd <= 0) return null;
  if (!Number.isFinite(input.settledMicroUsd) || input.settledMicroUsd < 0) return null;

  // The gate's pipeline, in the gate's order (llmUsagePoolDecision.ts), on the month's own inputs.
  const adjusted = applyLlmUsageCredits({
    rawCostUsedMicroUsd: input.settledMicroUsd,
    hardThresholdMicroUsd: tierPool,
    adjustment: inputs.credits,
  });
  const poolMicroUsd = paygOverageThresholdMicroUsd({
    effectiveHardThresholdMicroUsd: adjusted.effectiveHardThresholdMicroUsd,
    poolHighWater: inputs.poolHighWater,
    month: input.month,
  });
  const netOverageMicroUsd = paygNetOverageMicroUsd({
    optIn: inputs.optIn,
    poolHighWater: inputs.poolHighWater,
    costUsedMicroUsd: adjusted.policyCostUsedMicroUsd,
    overageThresholdMicroUsd: poolMicroUsd,
    month: input.month,
  });
  if (!Number.isFinite(netOverageMicroUsd)) return null;

  // The cap is a MONTHLY total: the highest cap in force during the month covers the whole month,
  // including overrun admitted earlier in it, and nothing after the month reaches back. The gate stops
  // admitting at the cap, but work already in flight can run past it: never bill past it.
  const overageCostMicroUsd = Math.min(netOverageMicroUsd, capMicroUsd);
  const billedMicroUsd = Math.floor((overageCostMicroUsd * markupBps) / 10_000);
  return {
    netOverageMicroUsd,
    poolMicroUsd: Math.round(poolMicroUsd),
    capMicroUsd,
    markupBps,
    overageCostMicroUsd,
    billedMicroUsd,
    amountCents: Math.floor(billedMicroUsd / 10_000),
    percentOfCap: Math.floor((overageCostMicroUsd / capMicroUsd) * 100),
  };
}
