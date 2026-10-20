/**
 * ENG-668 PR-2: month-end settlement of pay-as-you-go overage through Stripe, and the webhooks that
 * follow an overage invoice. Shipped dark behind its own switch (`payg_settlement_enabled`).
 *
 * Once a day from day 2 (UTC) of month M+1, `runPaygSettlement` settles M for every billing owner whose
 * `paygOverage.admittedMonths` has a record for M (a gate admitted at least one turn on PAYG in M), and
 * resumes any month of the last 12 still `pending`:
 *
 *   1. Measure (`paygSettlement.ts`): authoritative settled spend summed from AW-SpendEvents, the closed
 *      month's credits / pool mark / opt-in, and the plan pool, cap and markup that month's admissions
 *      recorded — the same measurement the gates admit against, on inputs nothing after M can change.
 *   2. Reconcile that spend against the persisted projection the gate read. Drift beyond the §3
 *      tolerance (or no projection behind real spend) means the gate and the bill would disagree:
 *      the month is recorded `held`, nothing is charged, and on-call is alerted once (the conditional
 *      write that records `held` is the dedupe — a rerun skips it).
 *   3. Record `paygSettlements[M]` with a conditional write BEFORE calling Stripe: `pending` with the
 *      amount fixed, or `nothing_to_bill`. Only `pending` is ever resumed, and always with the stored
 *      amount, so a crash anywhere after this point retries the same charge, never a recomputed one.
 *   4. Issue the invoice (`stripeService.issuePaygOverageInvoice`): Stripe is searched for the month's
 *      invoice before anything is created, writes carry keys derived from `payg:{billingUserId}:{M}`,
 *      the invoice id is recorded as soon as it is known, and a draft whose Stripe total is not the
 *      recorded amount is deleted before it is finalized (held; nothing collected).
 *   5. Mark `invoiced`; the owner gets one email (percent of cap, no dollars).
 *
 * Webhooks: paid -> `paid` (the payment-failure suspension is lifted once no month is `failed`);
 * failed -> `failed` + `paygOverage.suspended = payment_failed` (the gate refuses PAYG while suspended)
 * + one email; dispute -> suspended `dispute` (never lifted automatically); refund -> recorded only, never
 * resumes. None of them touch a subscription field — `handleInvoicePaymentSucceeded/Failed` hand
 * overage invoices here first.
 *
 * Rollback: set the switch to anything but 'true'. The cron stops; a `pending` month stays pending and
 * is resumed (same amount, Stripe searched first) only if the switch comes back — nothing is charged
 * twice. Invoice webhooks keep being recorded either way; refund/dispute recognition needs the switch on.
 */
import { userDb, type User } from './db';
import { getUserSubscriptionType } from './subscriptionService';
import { listSpendEvents, sumSettledMicroUsd } from './spendEventDb';
import { getProjection } from './spendProjectionDb';
import { reconcileProjection } from './spendProjection';
import { isSpendLedgerEnforcementEnabled } from './spendEnforcementBasis';
import { getLlmUsageCreditLedgerForMonth } from './llmUsageCreditService';
import { paygSettlementSwitch } from './paygOverageService';
import { paymentHistoryDb } from './paymentHistoryDb';
import { stripeService, PAYG_OVERAGE_PURCHASE_TYPE, type PaygOverageInvoiceMetadata } from './stripeService';
import {
  computePaygSettlementAmount,
  PAYG_MIN_INVOICE_CENTS,
  PAYG_SETTLEMENT_MONTHS_KEPT,
  paygSettlementIdempotencyKey,
  paygSettlementMonthsToPrune,
  paygSettlementPrice,
  previousUsageMonth,
  type PaygSettlement,
  type PaygSettlementHeldReason,
  type PaygSettlementStatus,
} from './paygSettlement';
import type { PaygOverageSettings } from './paygOverage';
import { paygOverageInvoiceCopy } from '../utils/paygSettlementCopy';

const TAG = '[paygSettlement]';
/** One intake class for every held month, so alerts cluster on one canonical issue. */
export const PAYG_SETTLEMENT_ALERT_CLASS = 'payg-settlement-held';

export type PaygSettlementOutcome =
  | 'not_admitted'
  | 'already_recorded'
  | 'raced'
  | 'held'
  | 'nothing_to_bill'
  | 'invoiced';

export interface PaygSettlementRunSummary {
  /** Why nothing ran, when nothing did. */
  skipped?: 'switch_off' | 'before_day_2';
  month: string;
  scanned: number;
  outcomes: Partial<Record<PaygSettlementOutcome, number>>;
  failed: number;
  errors: Array<{ billingUserId: string; error: string }>;
}

/** The daily sweep. Off switch or day 1 of the month => no reads, no writes, no Stripe. */
export async function runPaygSettlement(now: Date = new Date()): Promise<PaygSettlementRunSummary> {
  const month = previousUsageMonth(now);
  const summary: PaygSettlementRunSummary = { month, scanned: 0, outcomes: {}, failed: 0, errors: [] };
  if (!(await paygSettlementSwitch.isEnabled())) return { ...summary, skipped: 'switch_off' };
  // Day 1 is the seat-credit sweep's (10:00 UTC) and the month's last spend events still settling.
  if (now.getUTCDate() < 2) return { ...summary, skipped: 'before_day_2' };

  // Every owner with a PAYG record: a scan reads the whole table whatever the filter, and the months to
  // look at (the closing one, and any earlier one left `pending`) are decided per row below.
  const owners = await userDb.scanWithFilter('attribute_exists(paygOverage)', {});
  summary.scanned = owners.length;
  // One owner-month at a time: a handful of Stripe calls each, and a failure stays one owner's.
  for (const owner of owners) {
    const billingUserId = String(owner?.userId || '');
    if (!billingUserId) continue;
    for (const settleMonth of monthsToSettle(owner as User, month)) {
      try {
        const outcome = await settlePaygOverageMonth(billingUserId, settleMonth, now);
        summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
      } catch (error: any) {
        summary.failed++;
        summary.errors.push({ billingUserId, error: error?.message || String(error) });
        console.error(`${TAG} settling ${settleMonth} for ${billingUserId} failed; the next run retries:`, error?.message || error);
      }
    }
  }
  return summary;
}

/**
 * The closing month when PAYG admitted in it, plus any month of the retention window still `pending` —
 * a draft from a run that died must never be orphaned just because the calendar moved on.
 */
function monthsToSettle(owner: User, closingMonth: string): string[] {
  const months = new Set<string>();
  if (owner.paygOverage && paygSettlementPrice(owner.paygOverage, closingMonth) !== 'not_admitted') months.add(closingMonth);
  const [year, monthNum] = closingMonth.split('-').map(Number);
  const oldest = new Date(Date.UTC(year, monthNum - PAYG_SETTLEMENT_MONTHS_KEPT, 1)).toISOString().slice(0, 7);
  for (const [settledMonth, record] of Object.entries(owner.paygSettlements ?? {})) {
    if (record?.status === 'pending' && settledMonth >= oldest && settledMonth <= closingMonth) months.add(settledMonth);
  }
  return [...months].sort();
}

/**
 * Settle one owner's closed month: record it, then (for a `pending` record, new or left by an earlier
 * run) invoice it. Idempotent — every step is either conditional on the record's state or keyed.
 */
export async function settlePaygOverageMonth(
  billingUserId: string,
  month: string,
  now: Date = new Date(),
): Promise<PaygSettlementOutcome> {
  const user = (await userDb.getUserByIdConsistent(billingUserId)) as User | undefined;
  const account = user?.paygOverage;
  if (!user || !account) return 'not_admitted';

  let record = user.paygSettlements?.[month];
  if (record && record.status !== 'pending') return 'already_recorded';
  if (!record) {
    if (paygSettlementPrice(account, month) === 'not_admitted') return 'not_admitted';
    const decided = await decideSettlement(user, billingUserId, account, month, now);
    if (!(await recordNewSettlement(user, billingUserId, month, decided))) return 'raced';
    if (decided.status === 'held') {
      await alertHeld(billingUserId, month, decided);
      return 'held';
    }
    if (decided.status === 'nothing_to_bill') return 'nothing_to_bill';
    record = decided;
  }
  return invoicePendingSettlement(user, billingUserId, month, record);
}

async function decideSettlement(
  user: User,
  billingUserId: string,
  account: PaygOverageSettings,
  month: string,
  now: Date,
): Promise<PaygSettlement> {
  const at = now.toISOString();
  const price = paygSettlementPrice(account, month);
  const markupBps = typeof price === 'number' ? price : null;
  const base: PaygSettlement = {
    status: 'held',
    idempotencyKey: paygSettlementIdempotencyKey(billingUserId, month),
    overageCostMicroUsd: 0,
    billedMicroUsd: 0,
    amountCents: 0,
    markupBps,
    percentOfCap: 0,
    settledMicroUsd: 0,
    projectedMicroUsd: null,
    createdAt: at,
    updatedAt: at,
  };
  const held = (heldReason: PaygSettlementHeldReason, fields: Partial<PaygSettlement> = {}): PaygSettlement =>
    ({ ...base, ...fields, status: 'held', heldReason });

  // The gate measured this owner on the spend ledger only if the cutover covers them; billing ledger
  // spend for an owner the gate measured on the legacy LLM-only counter would bill what it never saw.
  const tierName = await getUserSubscriptionType(billingUserId);
  if (!isSpendLedgerEnforcementEnabled(billingUserId, tierName)) return held('legacy_spend_basis');

  const events = (await listSpendEvents(billingUserId, `${month}-01`, `${month}-31`))
    .filter((event) => event.billingMonth === month);
  const settledMicroUsd = sumSettledMicroUsd(events);
  const projection = await getProjection(billingUserId, month, /* consistentRead */ true);
  const measured = { settledMicroUsd, projectedMicroUsd: projection ? projection.settledMicroUsd : null };
  const reconciled = projection ? reconcileProjection(events, projection).ok : settledMicroUsd === 0;
  if (!reconciled) return held('spend_drift', measured);
  if (markupBps === null) return held('no_price', measured);

  const amount = computePaygSettlementAmount({
    month,
    account,
    creditLedger: getLlmUsageCreditLedgerForMonth(user, month),
    settledMicroUsd,
  });
  if (!amount) return held('unmeasurable', measured);

  const priced: PaygSettlement = {
    ...base,
    ...measured,
    overageCostMicroUsd: amount.overageCostMicroUsd,
    billedMicroUsd: amount.billedMicroUsd,
    amountCents: amount.amountCents,
    percentOfCap: amount.percentOfCap,
  };
  if (amount.amountCents <= 0) return { ...priced, status: 'nothing_to_bill', nothingToBillReason: 'no_overage' };
  if (amount.amountCents < PAYG_MIN_INVOICE_CENTS) {
    return { ...priced, status: 'nothing_to_bill', nothingToBillReason: 'below_minimum' };
  }
  return { ...priced, status: 'pending' };
}

/**
 * Write the month's first record, only if there is none yet. False when another run got there first.
 * Prunes months past the retention window in the same write.
 */
async function recordNewSettlement(
  user: User,
  billingUserId: string,
  month: string,
  record: PaygSettlement,
): Promise<boolean> {
  try {
    if (!user.paygSettlements) {
      await userDb.updateUser(billingUserId, { paygSettlements: { [month]: record } }, {
        condition: { expression: 'attribute_not_exists(#settlements)', names: { '#settlements': 'paygSettlements' } },
      });
    } else {
      await userDb.updateUser(billingUserId, {}, {
        pathSets: [{ path: ['paygSettlements', month], value: record }],
        pathRemoves: paygSettlementMonthsToPrune(user.paygSettlements, month)
          .map((old) => ({ path: ['paygSettlements', old] })),
        condition: {
          expression: 'attribute_exists(#settlements) AND attribute_not_exists(#settlements.#month)',
          names: { '#settlements': 'paygSettlements', '#month': month },
        },
      });
    }
    return true;
  } catch (error: any) {
    if (error?.code === 'ConditionalCheckFailedException') return false;
    throw error;
  }
}

/**
 * Move the month's record from one of `from` to `fields.status`, setting `fields` alongside. False when
 * the record is no longer in one of those states (another run or webhook moved it).
 */
async function transitionSettlement(
  billingUserId: string,
  month: string,
  from: PaygSettlementStatus[],
  fields: Partial<PaygSettlement>,
  remove: Array<keyof PaygSettlement> = [],
): Promise<boolean> {
  const values: Record<string, string> = {};
  from.forEach((status, i) => { values[`:from${i}`] = status; });
  try {
    await userDb.updateUser(billingUserId, {}, {
      pathSets: Object.entries({ ...fields, updatedAt: new Date().toISOString() })
        .map(([key, value]) => ({ path: ['paygSettlements', month, key], value })),
      ...(remove.length ? { pathRemoves: remove.map((key) => ({ path: ['paygSettlements', month, key] })) } : {}),
      condition: {
        expression: `#settlements.#month.#status IN (${Object.keys(values).join(', ')})`,
        names: { '#settlements': 'paygSettlements', '#month': month, '#status': 'status' },
        values,
      },
    });
    return true;
  } catch (error: any) {
    if (error?.code === 'ConditionalCheckFailedException') return false;
    throw error;
  }
}

async function invoicePendingSettlement(
  user: User,
  billingUserId: string,
  month: string,
  record: PaygSettlement,
): Promise<PaygSettlementOutcome> {
  let customerId: string | null = null;
  let paymentMethodId: string | null = null;
  if (!record.invoiceId) {
    // ENG-2571: charge the customer that holds the card, which is not always the row's customer.
    const resolved = await stripeService.resolveUserPaymentMethod(user, billingUserId);
    customerId = resolved.customerId ?? (await stripeService.findLiveCustomerIdForUser(user, billingUserId));
    paymentMethodId = resolved.paymentMethodId ?? null;
  }

  const copy = paygOverageInvoiceCopy(month);
  const metadata: PaygOverageInvoiceMetadata = {
    purchaseType: PAYG_OVERAGE_PURCHASE_TYPE,
    billingUserId,
    month,
    idempotencyKey: record.idempotencyKey,
  };
  const issued = await stripeService.issuePaygOverageInvoice({
    // Scoped to this record: retries of it replay Stripe's answers, while a record re-created after a
    // held month was cleared starts fresh instead of replaying a draft that was deleted.
    idempotencyKey: `${record.idempotencyKey}:${record.createdAt}`,
    customerId,
    paymentMethodId,
    amountCents: record.amountCents,
    description: copy.description,
    lineDescription: copy.lineDescription,
    metadata,
    invoiceId: record.invoiceId ?? null,
    recordInvoiceId: async (invoiceId) => {
      // Recorded before the line item, so a retry retrieves this invoice instead of searching for it.
      await transitionSettlement(billingUserId, month, ['pending'], { status: 'pending', invoiceId });
    },
  });
  if (issued.outcome === 'no_customer') return holdPending(billingUserId, month, record, 'no_stripe_customer');
  if (issued.outcome === 'mismatch') {
    // A deleted draft collected nothing and leaves no invoice behind; a finalized one is Stripe's.
    return issued.draftDeleted
      ? holdPending(billingUserId, month, record, 'invoice_mismatch', { deletedDraftInvoiceId: issued.invoiceId }, ['invoiceId'])
      : holdPending(billingUserId, month, record, 'invoice_mismatch', { invoiceId: issued.invoiceId });
  }

  const { invoice } = issued;
  const marked = await transitionSettlement(billingUserId, month, ['pending'], {
    status: 'invoiced',
    invoiceId: invoice.id,
    invoicedAt: new Date().toISOString(),
  });
  if (marked && user.email) {
    const { emailService } = await import('./emailService');
    await emailService.sendPaygOverageInvoiceEmail({
      to: user.email,
      month,
      percentOfCap: record.percentOfCap,
      invoiceUrl: invoice.hosted_invoice_url,
    });
  }
  return marked ? 'invoiced' : 'raced';
}

async function holdPending(
  billingUserId: string,
  month: string,
  record: PaygSettlement,
  heldReason: PaygSettlementHeldReason,
  extra: Partial<PaygSettlement> = {},
  remove: Array<keyof PaygSettlement> = [],
): Promise<PaygSettlementOutcome> {
  const fields: Partial<PaygSettlement> = { status: 'held', heldReason, ...extra };
  if (!(await transitionSettlement(billingUserId, month, ['pending'], fields, remove))) return 'raced';
  const after = { ...record, ...fields } as PaygSettlement;
  for (const key of remove) delete after[key];
  await alertHeld(billingUserId, month, after);
  return 'held';
}

/**
 * What on-call should do about a held month. Never "remove the record" while an invoice exists: the
 * record is what stops the month from being invoiced again.
 */
function heldRunbook(month: string, record: PaygSettlement): string {
  if (record.invoiceId) {
    return `Stripe invoice ${record.invoiceId} exists for this month. Do NOT remove paygSettlements.${month}. `
      + 'Open the invoice in Stripe: if its amount is right it is being collected and the paid/failed webhook '
      + 'records the outcome on this record; if it must not be collected, void it in Stripe. Nothing will '
      + 'invoice this month again while the record exists.';
  }
  const deleted = record.deletedDraftInvoiceId
    ? ` The draft invoice ${record.deletedDraftInvoiceId} was deleted before it was finalized — check why Stripe's total differed (a customer discount, coupon or balance).`
    : '';
  return `No invoice was finalized and nothing was collected.${deleted} Check in Stripe that no live invoice has `
    + `metadata purchaseType=payg_overage, billingUserId and month=${month}; once the cause is fixed, remove `
    + `paygSettlements.${month} on the AW-Users row to let the next daily run settle it again (it searches `
    + 'Stripe before creating anything), or leave it held to never bill that month.';
}

/** One on-call alert per held month: only the write that moved the month to `held` sends it. */
async function alertHeld(billingUserId: string, month: string, record: PaygSettlement): Promise<void> {
  try {
    const { emailService } = await import('./emailService');
    await emailService.sendOncallAlert(
      `PAYG settlement held for ${month}: ${record.heldReason}`,
      `Month-end pay-as-you-go settlement held ${billingUserId} for ${month} (${record.heldReason}). `
        + heldRunbook(month, record),
      {
        'Alert Class': PAYG_SETTLEMENT_ALERT_CLASS,
        billingUserId,
        month,
        heldReason: record.heldReason,
        settledMicroUsd: record.settledMicroUsd,
        projectedMicroUsd: record.projectedMicroUsd,
        invoiceId: record.invoiceId ?? null,
        deletedDraftInvoiceId: record.deletedDraftInvoiceId ?? null,
      },
    );
  } catch (error: any) {
    console.error(`${TAG} on-call alert for held ${month} / ${billingUserId} failed:`, error?.message || error);
  }
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

interface OverageInvoiceRef {
  invoiceId: string;
  billingUserId: string;
  month: string;
}

function overageInvoiceRef(invoice: any): OverageInvoiceRef | null {
  const metadata = invoice?.metadata || {};
  if (metadata.purchaseType !== PAYG_OVERAGE_PURCHASE_TYPE) return null;
  const billingUserId = String(metadata.billingUserId || '');
  const month = String(metadata.month || '');
  if (!invoice?.id || !billingUserId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  return { invoiceId: invoice.id, billingUserId, month };
}

/** The owner and the settlement an overage invoice belongs to, or null (logged) when it is not ours. */
async function loadSettlementFor(invoice: any, event: string): Promise<{ ref: OverageInvoiceRef; user: User; record: PaygSettlement } | null> {
  const ref = overageInvoiceRef(invoice);
  if (!ref) {
    console.warn(`${TAG} ${event}: overage invoice ${invoice?.id} has unreadable metadata; ignored`);
    return null;
  }
  const user = (await userDb.getUserByIdConsistent(ref.billingUserId)) as User | undefined;
  const record = user?.paygSettlements?.[ref.month];
  if (!user || !record) {
    console.warn(`${TAG} ${event}: no settlement ${ref.month} for ${ref.billingUserId} (invoice ${ref.invoiceId}); ignored`);
    return null;
  }
  if (record.invoiceId && record.invoiceId !== ref.invoiceId) {
    console.warn(`${TAG} ${event}: invoice ${ref.invoiceId} is not the one settlement ${ref.month} issued (${record.invoiceId}); ignored`);
    return null;
  }
  return { ref, user, record };
}

/**
 * The states a paid/failed webhook may move this month's record out of. A `held` record moves only when
 * it names this very invoice (held after Stripe already had a finalized invoice — Stripe still collects
 * it, and the record must say what happened).
 */
function webhookSources(record: PaygSettlement, invoiceId: string, base: PaygSettlementStatus[]): PaygSettlementStatus[] {
  return record.status === 'held' && record.invoiceId === invoiceId ? [...base, 'held'] : base;
}

/** `invoice.paid` / `invoice.payment_succeeded` for an overage invoice. */
export async function handlePaygOverageInvoicePaid(invoice: any): Promise<void> {
  const loaded = await loadSettlementFor(invoice, 'invoice paid');
  if (!loaded) return;
  const { ref, user, record } = loaded;
  await transitionSettlement(ref.billingUserId, ref.month, webhookSources(record, ref.invoiceId, ['pending', 'invoiced', 'failed']), {
    status: 'paid',
    invoiceId: ref.invoiceId,
    paidAt: new Date().toISOString(),
  });
  await liftPaymentFailureSuspension(ref.billingUserId, user, ref.month);
  console.log(`${TAG} overage invoice ${ref.invoiceId} paid: ${ref.billingUserId} ${ref.month}`);
}

/**
 * A payment-failure suspension lasts while ANY month's overage invoice is `failed`: paying one month
 * lifts it only if no other month is still unpaid. Conditional on the reason (a dispute suspension is
 * never lifted here) and on every other month the row holds still not being `failed` at write time.
 */
async function liftPaymentFailureSuspension(billingUserId: string, user: User, paidMonth: string): Promise<void> {
  if (user.paygOverage?.suspended?.reason !== 'payment_failed') return;
  const otherMonths = Object.keys(user.paygSettlements ?? {}).filter((m) => m !== paidMonth);
  if (otherMonths.some((m) => user.paygSettlements![m]?.status === 'failed')) return;
  const names: Record<string, string> = {
    '#payg': 'paygOverage', '#suspended': 'suspended', '#reason': 'reason', '#settlements': 'paygSettlements', '#status': 'status',
  };
  const clauses = ['#payg.#suspended.#reason = :paymentFailed'];
  otherMonths.forEach((m, i) => {
    names[`#m${i}`] = m;
    clauses.push(`#settlements.#m${i}.#status <> :failed`);
  });
  try {
    await userDb.updateUser(billingUserId, {}, {
      pathRemoves: [{ path: ['paygOverage', 'suspended'] }],
      condition: {
        expression: clauses.join(' AND '),
        names,
        values: { ':paymentFailed': 'payment_failed', ...(otherMonths.length ? { ':failed': 'failed' } : {}) },
      },
    });
  } catch (error: any) {
    if (error?.code !== 'ConditionalCheckFailedException') throw error;
  }
}

/** `invoice.payment_failed` for an overage invoice: `failed`, PAYG suspended, one owner email. */
export async function handlePaygOverageInvoicePaymentFailed(invoice: any): Promise<void> {
  const loaded = await loadSettlementFor(invoice, 'invoice payment failed');
  if (!loaded) return;
  const { ref, user, record } = loaded;
  if (record.status === 'paid') return; // an out-of-order failure for an invoice already paid
  const moved = await transitionSettlement(ref.billingUserId, ref.month, webhookSources(record, ref.invoiceId, ['pending', 'invoiced']), {
    status: 'failed',
    invoiceId: ref.invoiceId,
    failedAt: new Date().toISOString(),
  });
  await suspendPayg(ref.billingUserId, { reason: 'payment_failed', at: new Date().toISOString(), invoiceId: ref.invoiceId });
  if (moved && user.email) {
    const { emailService } = await import('./emailService');
    await emailService.sendPaygOveragePaymentFailedEmail({ to: user.email, month: ref.month, invoiceUrl: invoice.hosted_invoice_url });
  }
  console.log(`${TAG} overage invoice ${ref.invoiceId} payment failed: ${ref.billingUserId} ${ref.month}; PAYG suspended`);
}

/** `charge.dispute.created` on an overage charge: PAYG suspended (`dispute`), recorded on the settlement. */
export async function handlePaygOverageChargeDisputed(dispute: any, charge: any, invoice: any): Promise<void> {
  const loaded = await loadSettlementFor(invoice, 'charge disputed');
  if (!loaded) return;
  const { ref } = loaded;
  const at = new Date().toISOString();
  await suspendPayg(ref.billingUserId, { reason: 'dispute', at, invoiceId: ref.invoiceId });
  await userDb.updateUser(ref.billingUserId, {}, {
    pathSets: [{ path: ['paygSettlements', ref.month, 'dispute'], value: { disputeId: String(dispute?.id || ''), at } }],
    condition: { expression: 'attribute_exists(#settlements.#month)', names: { '#settlements': 'paygSettlements', '#month': ref.month } },
  });
  await paymentHistoryDb.record(
    {
      userId: ref.billingUserId,
      timestamp: at,
      eventType: 'dispute_opened',
      amount: Number(dispute?.amount) || 0,
      currency: dispute?.currency || charge?.currency || 'usd',
      status: 'disputed',
      stripeInvoiceId: ref.invoiceId,
      metadata: { chargeId: charge?.id, disputeId: dispute?.id, disputeReason: dispute?.reason, purchaseType: PAYG_OVERAGE_PURCHASE_TYPE },
    },
    { dedupKey: `dispute:opened:${dispute?.id}` },
  );
  console.log(`${TAG} overage charge ${charge?.id} disputed (${dispute?.id}): ${ref.billingUserId} ${ref.month}; PAYG suspended`);
}

/**
 * `charge.refunded` on an overage charge: the cumulative refunded amount is recorded on the settlement
 * (so a redelivery lands on the same figure) and in payment history. Never lifts a suspension.
 */
export async function handlePaygOverageChargeRefunded(charge: any, invoice: any): Promise<void> {
  const loaded = await loadSettlementFor(invoice, 'charge refunded');
  if (!loaded) return;
  const { ref } = loaded;
  const refundedCents = Number(charge?.amount_refunded) || 0;
  await userDb.updateUser(ref.billingUserId, {}, {
    pathSets: [
      { path: ['paygSettlements', ref.month, 'refundedCents'], value: refundedCents },
      { path: ['paygSettlements', ref.month, 'updatedAt'], value: new Date().toISOString() },
    ],
    condition: { expression: 'attribute_exists(#settlements.#month)', names: { '#settlements': 'paygSettlements', '#month': ref.month } },
  });
  await paymentHistoryDb.record({
    userId: ref.billingUserId,
    timestamp: new Date().toISOString(),
    eventType: 'refund',
    amount: refundedCents,
    currency: charge?.currency || 'usd',
    status: 'refunded',
    stripeInvoiceId: ref.invoiceId,
    metadata: { chargeId: charge?.id, fullRefund: charge?.refunded, purchaseType: PAYG_OVERAGE_PURCHASE_TYPE },
  });
  console.log(`${TAG} overage charge ${charge?.id} refunded (${refundedCents}c): ${ref.billingUserId} ${ref.month}; PAYG not resumed`);
}

/**
 * Set `paygOverage.suspended`. A dispute replaces a payment-failure suspension (it is the stronger
 * reason, and paying the invoice must not lift it); an existing dispute is never replaced.
 */
async function suspendPayg(billingUserId: string, suspended: NonNullable<PaygOverageSettings['suspended']>): Promise<void> {
  try {
    await userDb.updateUser(billingUserId, {}, {
      pathSets: [{ path: ['paygOverage', 'suspended'], value: suspended }],
      condition: suspended.reason === 'dispute'
        ? {
            expression: 'attribute_exists(#payg) AND (attribute_not_exists(#payg.#suspended) OR #payg.#suspended.#reason <> :dispute)',
            names: { '#payg': 'paygOverage', '#suspended': 'suspended', '#reason': 'reason' },
            values: { ':dispute': 'dispute' },
          }
        : {
            expression: 'attribute_exists(#payg) AND attribute_not_exists(#payg.#suspended)',
            names: { '#payg': 'paygOverage', '#suspended': 'suspended' },
          },
    });
  } catch (error: any) {
    // Already suspended (or no PAYG record at all): nothing to add.
    if (error?.code !== 'ConditionalCheckFailedException') throw error;
  }
}
