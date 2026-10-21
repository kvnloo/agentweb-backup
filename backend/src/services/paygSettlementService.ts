/**
 * ENG-668 PR-2: month-end settlement of pay-as-you-go overage through Stripe, and the webhooks that
 * follow an overage invoice. Shipped dark behind its own switch (`payg_settlement_enabled`).
 *
 * Once a day from day 2 (UTC) of month M+1, `runPaygSettlement` settles M for every billing owner whose
 * `paygOverage.admittedMonths` has a record for M (a gate admitted at least one turn on PAYG in M), and,
 * within the last 12 months, resumes any month still `pending`, re-measures any month set to `retry` by
 * hand, and settles any admitted month that has no record at all:
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
import { paygSettlementSwitch } from './paygOverageService';
import { paymentHistoryDb } from './paymentHistoryDb';
import { stripeService, PAYG_OVERAGE_PURCHASE_TYPE, type PaygOverageInvoiceMetadata } from './stripeService';
import {
  computePaygSettlementAmount,
  PAYG_MIN_INVOICE_CENTS,
  PAYG_SETTLEMENT_MONTHS_KEPT,
  paygSettlementIdempotencyKey,
  paygSettlementMonthsToPrune,
  paygAdmittedMarkupBps,
  paygMonthInputsFromRow,
  previousUsageMonth,
  type PaygMonthInputs,
  type PaygSettlement,
  type PaygSettlementHeldReason,
  type PaygSettlementStatus,
} from './paygSettlement';
import { paygAdmittedMonth, type PaygAdmittedMonth } from './paygOverage';
import { paygOverageInvoiceCopy } from '../utils/paygSettlementCopy';

const TAG = '[paygSettlement]';

const errorCode = (error: unknown): unknown => (error as { code?: unknown } | null | undefined)?.code;
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isConditionalFailure = (error: unknown): boolean => errorCode(error) === 'ConditionalCheckFailedException';

/** The parts of Stripe's invoice, charge and dispute objects the webhooks read (Basil field names). */
interface OverageInvoiceEvent {
  id?: string;
  metadata?: Record<string, string> | null;
  hosted_invoice_url?: string | null;
}
interface OverageChargeEvent {
  id?: string;
  amount_refunded?: number;
  refunded?: boolean;
  currency?: string;
}
interface OverageDisputeEvent {
  id?: string;
  amount?: number;
  currency?: string;
  reason?: string;
}
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
  errors: Array<{ billingUserId: string; month: string; error: string }>;
}

/** The daily sweep. Off switch or day 1 of the month => no reads, no writes, no Stripe. */
export async function runPaygSettlement(now: Date = new Date()): Promise<PaygSettlementRunSummary> {
  const month = previousUsageMonth(now);
  const summary: PaygSettlementRunSummary = { month, scanned: 0, outcomes: {}, failed: 0, errors: [] };
  if (!(await paygSettlementSwitch.isEnabled())) return { ...summary, skipped: 'switch_off' };
  // Day 1 is the seat-credit sweep's (10:00 UTC) and the month's last spend events still settling.
  if (now.getUTCDate() < 2) return { ...summary, skipped: 'before_day_2' };

  // Every owner with a PAYG record: a scan reads the whole table whatever the filter, and the months to
  // look at (see `monthsToSettle`) are decided per row below.
  const owners = await userDb.scanWithFilter('attribute_exists(paygOverage)', {});
  summary.scanned = owners.length;
  // One owner-month at a time: a handful of Stripe calls each, and a failure stays one owner's.
  for (const owner of owners as User[]) {
    const billingUserId = String(owner?.userId || '');
    if (!billingUserId) continue;
    let months: string[];
    // Scan rows are untyped storage: a malformed one must cost only its own owner, never the sweep.
    try {
      months = monthsToSettle(owner, month);
    } catch (error: unknown) {
      recordFailure(summary, billingUserId, month, error);
      continue;
    }
    for (const settleMonth of months) {
      try {
        const outcome = await settlePaygOverageMonth(billingUserId, settleMonth, now);
        summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
      } catch (error: unknown) {
        recordFailure(summary, billingUserId, settleMonth, error);
      }
    }
  }
  return summary;
}

/** One owner-month's failure: counted and logged, never allowed to stop the rest of the sweep. */
function recordFailure(summary: PaygSettlementRunSummary, billingUserId: string, month: string, error: unknown): void {
  summary.failed++;
  summary.errors.push({ billingUserId, month, error: errorText(error) });
  console.error(`${TAG} settling ${month} for ${billingUserId} failed; the next run retries:`, errorText(error));
}

/**
 * The months of the retention window (the closing month and the 11 before it) this owner needs: one
 * PAYG admitted in that has no settlement record yet (normally just the closing month; an older one only
 * when a record went missing), and any month left `pending` (a dead run's draft is never orphaned) or set
 * to `retry` by hand.
 */
function monthsToSettle(owner: User, closingMonth: string): string[] {
  const [year, monthNum] = closingMonth.split('-').map(Number);
  const oldest = new Date(Date.UTC(year, monthNum - PAYG_SETTLEMENT_MONTHS_KEPT, 1)).toISOString().slice(0, 7);
  const inWindow = (month: unknown): month is string =>
    typeof month === 'string' && month >= oldest && month <= closingMonth;
  const settlements = owner.paygSettlements ?? {};
  const months = new Set<string>();
  const admitted = Array.isArray(owner.paygOverage?.admittedMonths) ? owner.paygOverage!.admittedMonths : [];
  for (const entry of admitted) {
    if (inWindow(entry?.month) && !settlements[entry.month]) months.add(entry.month);
  }
  for (const [month, record] of Object.entries(settlements)) {
    if (inWindow(month) && (record?.status === 'pending' || record?.status === 'retry')) months.add(month);
  }
  return [...months].sort();
}

/**
 * Settle one owner's month: measure and record it (a month with no record, or one set to `retry`), then
 * invoice a `pending` record, new or left by an earlier run. Idempotent — every step is either
 * conditional on the record's state or keyed, and Stripe is searched before anything is created.
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
  if (record && record.status !== 'pending' && record.status !== 'retry') return 'already_recorded';
  if (!record || record.status === 'retry') {
    const retrying = record?.status === 'retry';
    const admitted = paygAdmittedMonth(account, month);
    if (!admitted && !retrying) return 'not_admitted';
    // The month's credits, pool mark and opt-in: frozen on the record by its first measurement, or
    // read from the row while it is the month that just closed — never guessed.
    const inputs = record?.inputs ?? paygMonthInputsFromRow(user, month, previousUsageMonth(now));
    const decided = await decideSettlement(billingUserId, month, now, admitted, inputs);
    const written = retrying
      ? await replaceRetriedSettlement(billingUserId, month, { ...decided, retriedAt: now.toISOString() })
      : await recordNewSettlement(user, billingUserId, month, decided, previousUsageMonth(now));
    if (!written) return 'raced';
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
  billingUserId: string,
  month: string,
  now: Date,
  admitted: PaygAdmittedMonth | undefined,
  inputs: PaygMonthInputs | null,
): Promise<PaygSettlement> {
  const at = now.toISOString();
  const markupBps = admitted ? paygAdmittedMarkupBps(admitted) : null;
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
    ...(inputs ? { inputs } : {}),
  };
  const held = (heldReason: PaygSettlementHeldReason, fields: Partial<PaygSettlement> = {}): PaygSettlement =>
    ({ ...base, ...fields, status: 'held', heldReason });

  // The gate measured this owner on the spend ledger only if the cutover covers them; billing ledger
  // spend for an owner the gate measured on the legacy LLM-only counter would bill what it never saw.
  const tierName = await getUserSubscriptionType(billingUserId);
  if (!isSpendLedgerEnforcementEnabled(billingUserId, tierName)) return held('legacy_spend_basis');
  if (!inputs) return held('inputs_unavailable');

  const events = (await listSpendEvents(billingUserId, `${month}-01`, `${month}-31`))
    .filter((event) => event.billingMonth === month);
  const settledMicroUsd = sumSettledMicroUsd(events);
  const projection = await getProjection(billingUserId, month, /* consistentRead */ true);
  const measured = { settledMicroUsd, projectedMicroUsd: projection ? projection.settledMicroUsd : null };
  const reconciled = projection ? reconcileProjection(events, projection).ok : settledMicroUsd === 0;
  if (!reconciled) return held('spend_drift', measured);
  if (!admitted) return held('unmeasurable', measured);
  if (markupBps === null) return held('no_price', measured);

  const amount = computePaygSettlementAmount({ month, admitted, inputs, settledMicroUsd });
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
  closingMonth: string,
): Promise<boolean> {
  try {
    if (!user.paygSettlements) {
      await userDb.updateUser(billingUserId, { paygSettlements: { [month]: record } }, {
        condition: { expression: 'attribute_not_exists(#settlements)', names: { '#settlements': 'paygSettlements' } },
      });
    } else {
      await userDb.updateUser(billingUserId, {}, {
        pathSets: [{ path: ['paygSettlements', month], value: record }],
        pathRemoves: paygSettlementMonthsToPrune(user.paygSettlements, closingMonth)
          .filter((old) => old !== month)
          .map((old) => ({ path: ['paygSettlements', old] })),
        condition: {
          expression: 'attribute_exists(#settlements) AND attribute_not_exists(#settlements.#month)',
          names: { '#settlements': 'paygSettlements', '#month': month },
        },
      });
    }
    return true;
  } catch (error: unknown) {
    if (isConditionalFailure(error)) return false;
    throw error;
  }
}

/** Re-create a month set to `retry` in place, only if it is still `retry`. False when another run got there. */
async function replaceRetriedSettlement(billingUserId: string, month: string, record: PaygSettlement): Promise<boolean> {
  try {
    await userDb.updateUser(billingUserId, {}, {
      pathSets: [{ path: ['paygSettlements', month], value: record }],
      condition: {
        expression: '#settlements.#month.#status = :retry',
        names: { '#settlements': 'paygSettlements', '#month': month, '#status': 'status' },
        values: { ':retry': 'retry' },
      },
    });
    return true;
  } catch (error: unknown) {
    if (isConditionalFailure(error)) return false;
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
  } catch (error: unknown) {
    if (isConditionalFailure(error)) return false;
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
    // A finalized invoice at another total is Stripe's to collect: its id stays on the record. Anything
    // else collected nothing and is no longer this month's invoice (a deleted draft, or a recorded
    // invoice Stripe reports void or missing): it is set aside, never invoiced over automatically.
    return issued.reason === 'total_differs'
      ? holdPending(billingUserId, month, record, 'invoice_mismatch', { invoiceId: issued.invoiceId })
      : holdPending(billingUserId, month, record, 'invoice_mismatch', {
          uncollectedInvoice: { invoiceId: issued.invoiceId, reason: issued.reason },
        }, ['invoiceId']);
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
  const retry = `Once the cause is fixed, set paygSettlements.${month}.status to "retry" on the AW-Users row: the `
    + 'next daily run measures the month again from the inputs frozen on the record and fresh spend, and searches '
    + 'Stripe for this month\'s invoice before creating anything. Do not delete the record (it holds those '
    + 'inputs; without it the month can only be held again). Or leave it held to never bill that month.';
  if (record.invoiceId) {
    return `Stripe invoice ${record.invoiceId} exists for this month. Do NOT remove or retry paygSettlements.${month}. `
      + 'Open the invoice in Stripe: if its amount is right it is being collected and the paid/failed webhook '
      + 'records the outcome on this record; if it must not be collected, void it in Stripe. Nothing will '
      + 'invoice this month again while the record exists.';
  }
  const uncollected = record.uncollectedInvoice;
  if (uncollected?.reason === 'void') {
    return `Stripe invoice ${uncollected.invoiceId} for this month was finalized and later voided — by someone in `
      + 'Stripe, not by settlement. Check in Stripe whether any payment was taken on it before it was voided (refund '
      + `it there if so) and why it was voided. ${retry}`;
  }
  if (uncollected?.reason === 'missing') {
    return `Stripe reports invoice ${uncollected.invoiceId} for this month deleted or unknown, so nothing was collected `
      + `on it — check why (only a draft can be deleted). ${retry}`;
  }
  if (uncollected?.reason === 'draft_deleted') {
    return `No invoice was finalized and nothing was collected: the draft ${uncollected.invoiceId} was deleted before `
      + `finalizing because Stripe's total differed (a customer discount or coupon). ${retry}`;
  }
  return `No invoice was created and nothing was collected. ${retry}`;
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
        uncollectedInvoiceId: record.uncollectedInvoice?.invoiceId ?? null,
      },
    );
  } catch (error: unknown) {
    console.error(`${TAG} on-call alert for held ${month} / ${billingUserId} failed:`, errorText(error));
  }
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

interface OverageInvoiceRef {
  invoiceId: string;
  billingUserId: string;
  month: string;
}

function overageInvoiceRef(invoice: OverageInvoiceEvent): OverageInvoiceRef | null {
  const metadata = invoice?.metadata || {};
  if (metadata.purchaseType !== PAYG_OVERAGE_PURCHASE_TYPE) return null;
  const billingUserId = String(metadata.billingUserId || '');
  const month = String(metadata.month || '');
  if (!invoice?.id || !billingUserId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  return { invoiceId: invoice.id, billingUserId, month };
}

/** The owner and the settlement an overage invoice belongs to, or null (logged) when it is not ours. */
async function loadSettlementFor(invoice: OverageInvoiceEvent, event: string): Promise<{ ref: OverageInvoiceRef; user: User; record: PaygSettlement } | null> {
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
  // An invoice settlement set aside (void, deleted, deleted draft) is no longer the month's: whatever
  // Stripe says about it later must not move the record or suspend PAYG.
  if (record.uncollectedInvoice?.invoiceId === ref.invoiceId) {
    console.warn(`${TAG} ${event}: invoice ${ref.invoiceId} was set aside for settlement ${ref.month} (${record.uncollectedInvoice.reason}); ignored`);
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
export async function handlePaygOverageInvoicePaid(invoice: OverageInvoiceEvent): Promise<void> {
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
 * lifts it only if, at the read, no other month was failed — and only if `suspended` is still EXACTLY
 * the value that read saw. Every month that newly fails re-stamps `suspended` (`suspendForPaymentFailure`),
 * so a month that fails after the read — even one created after it — changes the value and the lift does
 * not happen, while a redelivered failure for a month already failed changes nothing. A dispute
 * suspension is never lifted here.
 */
async function liftPaymentFailureSuspension(billingUserId: string, user: User, paidMonth: string): Promise<void> {
  const suspended = user.paygOverage?.suspended;
  if (suspended?.reason !== 'payment_failed') return;
  const stillFailed = Object.entries(user.paygSettlements ?? {})
    .some(([month, record]) => month !== paidMonth && record?.status === 'failed');
  if (stillFailed) return;
  try {
    await userDb.updateUser(billingUserId, {}, {
      pathRemoves: [{ path: ['paygOverage', 'suspended'] }],
      condition: {
        expression: '#payg.#suspended = :seen',
        names: { '#payg': 'paygOverage', '#suspended': 'suspended' },
        values: { ':seen': suspended },
      },
    });
  } catch (error: unknown) {
    if (!isConditionalFailure(error)) throw error;
  }
}

/** `invoice.payment_failed` for an overage invoice: `failed`, PAYG suspended, one owner email. */
export async function handlePaygOverageInvoicePaymentFailed(invoice: OverageInvoiceEvent): Promise<void> {
  const loaded = await loadSettlementFor(invoice, 'invoice payment failed');
  if (!loaded) return;
  const { ref, user, record } = loaded;
  if (record.status === 'paid') return; // an out-of-order failure for an invoice already paid
  const moved = await transitionSettlement(ref.billingUserId, ref.month, webhookSources(record, ref.invoiceId, ['pending', 'invoiced']), {
    status: 'failed',
    invoiceId: ref.invoiceId,
    failedAt: new Date().toISOString(),
  });
  await suspendForPaymentFailure(ref.billingUserId, ref.month, ref.invoiceId, moved);
  if (moved && user.email) {
    const { emailService } = await import('./emailService');
    await emailService.sendPaygOveragePaymentFailedEmail({ to: user.email, month: ref.month, invoiceUrl: invoice.hosted_invoice_url });
  }
  console.log(`${TAG} overage invoice ${ref.invoiceId} payment failed: ${ref.billingUserId} ${ref.month}; PAYG suspended`);
}

/** `charge.dispute.created` on an overage charge: PAYG suspended (`dispute`), recorded on the settlement. */
export async function handlePaygOverageChargeDisputed(
  dispute: OverageDisputeEvent,
  charge: OverageChargeEvent,
  invoice: OverageInvoiceEvent,
): Promise<void> {
  const loaded = await loadSettlementFor(invoice, 'charge disputed');
  if (!loaded) return;
  const { ref } = loaded;
  const at = new Date().toISOString();
  await suspendForDispute(ref.billingUserId, ref.invoiceId, at);
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
export async function handlePaygOverageChargeRefunded(charge: OverageChargeEvent, invoice: OverageInvoiceEvent): Promise<void> {
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
 * Suspend PAYG for a failed overage charge — only while the month's record says THIS invoice failed
 * (`status = failed`, `invoiceId` = it), checked in the same write. That keeps a failure event that lost
 * a race with the payment (or arrived for an invoice settlement set aside) from suspending an account
 * with nothing unpaid. Never over a dispute.
 *
 * `restamp`: this event is the one that moved the month to `failed`, so `suspended` is re-stamped with
 * its time and invoice even if already set — a paid webhook that read the old value then cannot lift it
 * (`liftPaymentFailureSuspension`). A redelivered or retried failure for a month already `failed`
 * changes nothing that is set, so it can never strand a suspension that a payment is about to lift.
 */
async function suspendForPaymentFailure(billingUserId: string, month: string, invoiceId: string, restamp: boolean): Promise<void> {
  try {
    await userDb.updateUser(billingUserId, {}, {
      pathSets: [{ path: ['paygOverage', 'suspended'], value: { reason: 'payment_failed', at: new Date().toISOString(), invoiceId } }],
      condition: {
        expression: 'attribute_exists(#payg) AND #settlements.#month.#status = :failed AND #settlements.#month.#invoiceId = :invoiceId AND '
          + (restamp
            ? '(attribute_not_exists(#payg.#suspended) OR #payg.#suspended.#reason <> :dispute)'
            : 'attribute_not_exists(#payg.#suspended)'),
        names: {
          '#payg': 'paygOverage', '#suspended': 'suspended', '#settlements': 'paygSettlements', '#month': month,
          '#status': 'status', '#invoiceId': 'invoiceId', ...(restamp ? { '#reason': 'reason' } : {}),
        },
        values: { ':failed': 'failed', ':invoiceId': invoiceId, ...(restamp ? { ':dispute': 'dispute' } : {}) },
      },
    });
  } catch (error: unknown) {
    // The month is not (or no longer) failed on this invoice, or a suspension already covers it.
    if (!isConditionalFailure(error)) throw error;
  }
}

/**
 * Suspend PAYG for a disputed overage charge. It replaces a payment-failure suspension (the stronger
 * reason, and paying an invoice must not lift it) but never an existing dispute.
 */
async function suspendForDispute(billingUserId: string, invoiceId: string, at: string): Promise<void> {
  try {
    await userDb.updateUser(billingUserId, {}, {
      pathSets: [{ path: ['paygOverage', 'suspended'], value: { reason: 'dispute', at, invoiceId } }],
      condition: {
        expression: 'attribute_exists(#payg) AND (attribute_not_exists(#payg.#suspended) OR #payg.#suspended.#reason <> :dispute)',
        names: { '#payg': 'paygOverage', '#suspended': 'suspended', '#reason': 'reason' },
        values: { ':dispute': 'dispute' },
      },
    });
  } catch (error: unknown) {
    if (!isConditionalFailure(error)) throw error;
  }
}
