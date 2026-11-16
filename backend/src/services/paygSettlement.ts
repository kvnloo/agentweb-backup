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
export type PaygSettlementStatus =
  | 'pending' | 'invoiced' | 'paid' | 'failed' | 'held' | 'nothing_to_bill' | 'retry' | 'written_off';

/**
 * Why a month is `written_off` — final, nothing more is collected for it: its invoice was voided in
 * Stripe (support forgave it), or a dispute on its charge was lost (the money went back).
 */
export type PaygWrittenOffReason = 'invoice_voided' | 'dispute_lost';

export type PaygSettlementHeldReason =
  /** Settled spend events and the persisted projection disagree beyond the §3 tolerance. */
  | 'spend_drift'
  /**
   * The gate measured some or all of the month's PAYG admissions on the legacy LLM-only counter, not on
   * the spend ledger being billed (recorded per month at admission; see `PaygAdmittedMonth.spendBasis`).
   */
  | 'legacy_spend_basis'
  /** Stripe holds more than one live invoice for the month: a person decides which one stands. */
  | 'multiple_invoices'
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
  /** The Stripe-hosted invoice page, kept so the owner can be pointed at an unpaid invoice. */
  hostedInvoiceUrl?: string;
  /** When the owner was sent the invoice email — once per month, whichever of the run or `paid` got there first. */
  emailedAt?: string;
  /** When the owner was asked to complete a payment their bank held for authentication (once). */
  actionRequiredEmailedAt?: string;
  /**
   * When Stripe first reported this month's payment waiting for the owner's confirmation (3-D Secure, a
   * mandate). Still unconfirmed `PAYG_PAYMENT_CONFIRMATION_GRACE_DAYS` later, the sweep treats it as a
   * failed payment (`paymentUnconfirmedAt`).
   */
  actionRequiredAt?: string;
  /** When the sweep failed the month because its payment was never confirmed. */
  paymentUnconfirmedAt?: string;
  /** Stripe gave up collecting automatically; the invoice can still be paid (the month stays `failed`). */
  uncollectibleAt?: string;
  writtenOffReason?: PaygWrittenOffReason;
  writtenOffAt?: string;
  /**
   * Every dispute on this month's charge, by Stripe dispute id. An entry without `closedAt` is open, and
   * a dispute suspension lasts while ANY month has one open (or one was lost). A closed entry is final:
   * a `charge.dispute.created` that arrives after it (reordered, retried, resent) changes nothing.
   */
  disputes?: Record<string, PaygDisputeRecord>;
  /**
   * Set in the same write that moves the month to `held`; cleared only after the on-call alert about it
   * went out. A sweep that dies before alerting leaves it set, and the next sweep sends it.
   */
  alertPending?: string;
  /** On `multiple_invoices`: the live invoices Stripe holds for the month. */
  conflictingInvoiceIds?: string[];
}

/** One dispute on a month's overage charge. `status` is Stripe's closing status (won, lost, warning_closed). */
export interface PaygDisputeRecord {
  at: string;
  status?: string;
  closedAt?: string;
}

/** AW-Users `paygSettlements`, keyed by UTC `YYYY-MM`. */
export type PaygSettlements = Record<string, PaygSettlement>;

/** Months of `paygSettlements` kept on the row: the month being written and the 11 before it. */
export const PAYG_SETTLEMENT_MONTHS_KEPT = 12;

/**
 * How long a payment may wait for the owner's confirmation (3-D Secure, a mandate) before the month is
 * treated as unpaid: pay-as-you-go is put on hold and the owner is emailed the invoice to confirm it.
 */
export const PAYG_PAYMENT_CONFIRMATION_GRACE_DAYS = 7;

/** Whether a payment first reported waiting for confirmation at `actionRequiredAt` is past the grace period. */
export function paygPaymentConfirmationOverdue(actionRequiredAt: string | undefined, now: Date): boolean {
  const since = actionRequiredAt ? Date.parse(actionRequiredAt) : NaN;
  return Number.isFinite(since) && now.getTime() - since >= PAYG_PAYMENT_CONFIRMATION_GRACE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Stripe cannot charge less than $0.50 USD; an invoice under it is marked paid and the amount is pushed
 * onto the customer's NEXT invoice — the subscription's. A month under it is not billed at all.
 */
export const PAYG_MIN_INVOICE_CENTS = 50;

/**
 * How far settled AW-SpendEvents may differ from the persisted projection the gate read before the month
 * is held as `spend_drift`: the larger of 50 cents and 1% of the month's settled spend.
 *
 * Why not exact: the projection is not written in the same transaction as the events. It is kept by a
 * best-effort atomic ADD per batch of settled events (`applySettledSpendEvents`, whose failures are logged
 * and swallowed), so a throttled write leaves it a few events' cost behind, and a reservation settled after
 * its month lands in the events before (or without) its projection update. Those are cents-sized and leave
 * the bill — which is computed from the events — untouched. A broken ledger (events lost, double counted,
 * written to the wrong month) moves a month by whole events per call and quickly passes 1%; that is what
 * this still holds. 50 cents is Stripe's minimum charge: below it nothing is billable anyway.
 */
export function paygSpendDriftTolerable(settledMicroUsd: number, projectedMicroUsd: number): boolean {
  const toleranceMicroUsd = Math.max(500_000, Math.floor(Math.abs(settledMicroUsd) / 100));
  return Math.abs(settledMicroUsd - projectedMicroUsd) <= toleranceMicroUsd;
}

/** A dispute hold (open or lost): paying an invoice does not lift it, so no invoice link is offered. */
export function isPaygDisputeHold(paygSuspendedReason: string | undefined): boolean {
  return paygSuspendedReason === 'dispute' || paygSuspendedReason === 'dispute_lost';
}

/**
 * The gate's PAYG block, made specific to who is asking. Only for a `payg_suspended` block:
 *   - a pooled member (not the billing owner) is told the owner can resolve it (`paygOwnerResolves`),
 *     and is never shown the owner's invoice;
 *   - the billing owner gets the unpaid invoice's page — never for a dispute hold (paying an invoice
 *     does not lift it; its copy asks the owner to contact us).
 */
export function withOwnerOpenInvoice<T extends { reason: string; paygSuspendedReason?: string; paygOwnerResolves?: boolean; openInvoiceUrl?: string }>(
  block: T | null | undefined,
  callerIsBillingOwner: boolean,
  settlements: PaygSettlements | null | undefined,
): T | null | undefined {
  if (!block || block.reason !== 'payg_suspended') return block;
  if (!callerIsBillingOwner) return { ...block, paygOwnerResolves: true };
  if (isPaygDisputeHold(block.paygSuspendedReason)) return block;
  const openInvoiceUrl = paygOpenInvoiceUrl(settlements);
  return openInvoiceUrl ? { ...block, openInvoiceUrl } : block;
}

/**
 * The hosted page of the owner's newest unpaid overage invoice (a month still `failed`), or undefined.
 * Read from settlement records only — no Stripe call on a settings view or a 429.
 */
export function paygOpenInvoiceUrl(settlements: PaygSettlements | null | undefined): string | undefined {
  const failed = Object.entries(settlements ?? {})
    .filter(([, record]) => record?.status === 'failed' && typeof record.hostedInvoiceUrl === 'string'
      && record.hostedInvoiceUrl.startsWith('https://'))
    .sort(([a], [b]) => (a < b ? 1 : -1));
  return failed[0]?.[1].hostedInvoiceUrl;
}

export function paygSettlementIdempotencyKey(billingUserId: string, month: string): string {
  return `payg:${billingUserId}:${month}`;
}

/** The UTC month before `now`'s. */
export function previousUsageMonth(now: Date): string {
  return getCurrentUsageMonth(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
}

/** The first month of the retention window ending at `month` (`month` and the 11 before it). */
export function paygSettlementWindowStart(month: string): string {
  const [year, monthNum] = month.split('-').map(Number);
  return getCurrentUsageMonth(new Date(Date.UTC(year, monthNum - PAYG_SETTLEMENT_MONTHS_KEPT, 1)));
}

/** Months of a stored `paygSettlements` map older than the retention window ending at `month`. */
export function paygSettlementMonthsToPrune(settlements: PaygSettlements | null | undefined, month: string): string[] {
  const oldestKept = paygSettlementWindowStart(month);
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
