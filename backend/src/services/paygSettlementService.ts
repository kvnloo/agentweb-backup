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
import { listSpendEvents, sumSettledMicroUsd } from './spendEventDb';
import { getProjection } from './spendProjectionDb';
import { paygSettlementSwitch } from './paygOverageService';
import { paymentHistoryDb } from './paymentHistoryDb';
import { stripeService, PAYG_OVERAGE_PURCHASE_TYPE, type PaygOverageInvoiceMetadata } from './stripeService';
import {
  computePaygSettlementAmount,
  PAYG_MIN_INVOICE_CENTS,
  paygSettlementWindowStart,
  paygSettlementIdempotencyKey,
  paygSettlementMonthsToPrune,
  paygAdmittedMarkupBps,
  paygMonthInputsFromRow,
  paygSpendDriftTolerable,
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
  amount_paid?: number;
  amount_due?: number;
  currency?: string;
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
  | 'invoiced'
  | 'paid';

export interface PaygSettlementRunSummary {
  /** Why nothing ran, when nothing did. */
  skipped?: 'switch_off' | 'before_day_2';
  month: string;
  scanned: number;
  outcomes: Partial<Record<PaygSettlementOutcome, number>>;
  failed: number;
  errors: Array<{ billingUserId: string; month: string; error: string }>;
  /** Months this run moved to `held` — on-call gets ONE alert listing all of them. */
  held: HeldMonth[];
}

/** A month a run moved to `held`, for the run's single on-call alert. */
export interface HeldMonth {
  billingUserId: string;
  month: string;
  record: PaygSettlement;
}

/**
 * What a settle does with a month it just moved to `held`: alert on-call at once (a direct call), or hand
 * it to the sweep, which sends one alert for the whole run (`alertHeldBatch`). Either way a month is
 * reported exactly once — only the write that moved it to `held` reports it.
 */
type HeldReporter = (held: HeldMonth) => Promise<void>;
const alertEachHeld: HeldReporter = (held) => alertHeldBatch([held]);

/** The daily sweep. Off switch or day 1 of the month => no reads, no writes, no Stripe. */
export async function runPaygSettlement(now: Date = new Date()): Promise<PaygSettlementRunSummary> {
  const month = previousUsageMonth(now);
  const summary: PaygSettlementRunSummary = { month, scanned: 0, outcomes: {}, failed: 0, errors: [], held: [] };
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
        const outcome = await settlePaygOverageMonth(billingUserId, settleMonth, now, async (held) => {
          summary.held.push(held);
        });
        summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
      } catch (error: unknown) {
        recordFailure(summary, billingUserId, settleMonth, error);
      }
    }
  }
  // One alert per run, however many months it held — turning settlement on after gate-only months
  // would otherwise page once per owner per month.
  if (summary.held.length) await alertHeldBatch(summary.held);
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
  const oldest = paygSettlementWindowStart(closingMonth);
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
  reportHeld: HeldReporter = alertEachHeld,
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
      await reportHeld({ billingUserId, month, record: decided });
      return 'held';
    }
    if (decided.status === 'nothing_to_bill') return 'nothing_to_bill';
    record = decided;
  }
  return invoicePendingSettlement(user, billingUserId, month, record, reportHeld);
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

  // Ledger spend is billed only for a month whose admissions the gate measured on the ledger, as recorded
  // at admission — never the cutover setting as it stands now. A month admitted on the legacy LLM-only
  // counter (or partly) would bill what the gate never saw.
  if (admitted && admitted.spendBasis !== 'spend_ledger') return held('legacy_spend_basis');
  if (!inputs) return held('inputs_unavailable');

  const events = (await listSpendEvents(billingUserId, `${month}-01`, `${month}-31`))
    .filter((event) => event.billingMonth === month);
  const settledMicroUsd = sumSettledMicroUsd(events);
  const projection = await getProjection(billingUserId, month, /* consistentRead */ true);
  const measured = { settledMicroUsd, projectedMicroUsd: projection ? projection.settledMicroUsd : null };
  // A projection that trails the events by the normal write lag is fine; a broken ledger is not
  // (`paygSpendDriftTolerable`). No projection behind real spend means its writer is missing: held.
  const reconciled = projection ? paygSpendDriftTolerable(settledMicroUsd, projection.settledMicroUsd) : settledMicroUsd === 0;
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
  reportHeld: HeldReporter,
): Promise<PaygSettlementOutcome> {
  const hold = (reason: PaygSettlementHeldReason, extra: Partial<PaygSettlement> = {}, remove: Array<keyof PaygSettlement> = []) =>
    holdPending(billingUserId, month, record, reason, reportHeld, extra, remove);
  let customerId: string | null = null;
  let fallbackPaymentMethodId: string | null = null;
  if (!record.invoiceId) {
    // ENG-2571: charge the customer that holds the card, which is not always the row's customer.
    const resolved = await stripeService.resolveUserPaymentMethod(user, billingUserId);
    customerId = resolved.customerId ?? (await stripeService.findLiveCustomerIdForUser(user, billingUserId));
    fallbackPaymentMethodId = resolved.fallbackPaymentMethodId ?? null;
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
    fallbackPaymentMethodId,
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
  if (issued.outcome === 'no_customer') return hold('no_stripe_customer');
  if (issued.outcome === 'multiple') return hold('multiple_invoices', { conflictingInvoiceIds: issued.invoiceIds }, ['invoiceId']);
  if (issued.outcome === 'mismatch') {
    // A finalized invoice at another total is Stripe's to collect: its id stays on the record. Anything
    // else collected nothing and is no longer this month's invoice (a deleted draft, or a recorded
    // invoice Stripe reports void or missing): it is set aside, never invoiced over automatically.
    return issued.reason === 'total_differs'
      ? hold('invoice_mismatch', { invoiceId: issued.invoiceId })
      : hold('invoice_mismatch', { uncollectedInvoice: { invoiceId: issued.invoiceId, reason: issued.reason } }, ['invoiceId']);
  }

  const { invoice } = issued;
  const at = new Date().toISOString();
  // An invoice Stripe has already collected (a balance covered it, or a search found one paid earlier)
  // is recorded as paid, not left `invoiced` waiting for a webhook that came and went.
  const alreadyPaid = invoice.status === 'paid';
  const marked = await transitionSettlement(billingUserId, month, ['pending'], {
    status: alreadyPaid ? 'paid' : 'invoiced',
    invoiceId: invoice.id,
    invoicedAt: at,
    ...(alreadyPaid ? { paidAt: at } : {}),
    ...(invoice.hosted_invoice_url ? { hostedInvoiceUrl: invoice.hosted_invoice_url } : {}),
  });
  // The month's invoice email goes out once, whichever got there first — this run, or an `invoice.paid`
  // webhook that beat its write (that webhook then sends it; see `sendInvoiceEmailOnce`).
  await sendInvoiceEmailOnce(user, billingUserId, month, invoice.id!, record.percentOfCap, invoice.hosted_invoice_url);
  if (marked && alreadyPaid) await liftPaymentFailureSuspension(billingUserId);
  if (!marked) return 'raced';
  return alreadyPaid ? 'paid' : 'invoiced';
}

/**
 * Send the month's invoice email at most once: claimed with a conditional write on `emailedAt` (and the
 * invoice it is about), so the run and a racing `invoice.paid` webhook cannot both send it, and a
 * redelivery sends nothing.
 */
async function sendInvoiceEmailOnce(
  user: Pick<User, 'email'>,
  billingUserId: string,
  month: string,
  invoiceId: string,
  percentOfCap: number,
  invoiceUrl: string | null | undefined,
): Promise<void> {
  if (!user.email) return;
  if (!(await claimSettlementFlag(billingUserId, month, invoiceId, 'emailedAt'))) return;
  const { emailService } = await import('./emailService');
  await emailService.sendPaygOverageInvoiceEmail({ to: user.email, month, percentOfCap, invoiceUrl });
}

/**
 * Set a once-only timestamp on the month's record (`emailedAt`, `actionRequiredEmailedAt`) if it is not
 * set yet and the record names `invoiceId`. True for the one caller that set it.
 */
async function claimSettlementFlag(
  billingUserId: string,
  month: string,
  invoiceId: string,
  flag: 'emailedAt' | 'actionRequiredEmailedAt',
): Promise<boolean> {
  try {
    await userDb.updateUser(billingUserId, {}, {
      pathSets: [{ path: ['paygSettlements', month, flag], value: new Date().toISOString() }],
      condition: {
        expression: '#settlements.#month.#invoiceId = :invoiceId AND attribute_not_exists(#settlements.#month.#flag)',
        names: { '#settlements': 'paygSettlements', '#month': month, '#invoiceId': 'invoiceId', '#flag': flag },
        values: { ':invoiceId': invoiceId },
      },
    });
    return true;
  } catch (error: unknown) {
    if (isConditionalFailure(error)) return false;
    throw error;
  }
}

async function holdPending(
  billingUserId: string,
  month: string,
  record: PaygSettlement,
  heldReason: PaygSettlementHeldReason,
  reportHeld: HeldReporter,
  extra: Partial<PaygSettlement> = {},
  remove: Array<keyof PaygSettlement> = [],
): Promise<PaygSettlementOutcome> {
  const fields: Partial<PaygSettlement> = { status: 'held', heldReason, ...extra };
  if (!(await transitionSettlement(billingUserId, month, ['pending'], fields, remove))) return 'raced';
  const after = { ...record, ...fields } as PaygSettlement;
  for (const key of remove) delete after[key];
  await reportHeld({ billingUserId, month, record: after });
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
      + 'records the outcome on this record. If it must not be collected, void it in Stripe: that writes the month '
      + 'off (status written_off — never billed again) and, once no other month is unpaid, lifts a payment-failure '
      + 'hold on pay-as-you-go. Nothing will invoice this month again while the record exists.';
  }
  if (record.conflictingInvoiceIds?.length) {
    return `Stripe holds ${record.conflictingInvoiceIds.length} live invoices for this month (${record.conflictingInvoiceIds.join(', ')}). `
      + 'Nothing new was created. Decide which one stands and void the others in Stripe (refund any payment taken on '
      + `them). ${retry}`;
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

/**
 * One on-call alert for a batch of months just moved to `held` (a whole sweep's, or one month's on a
 * direct call). Each month appears once in its life: only the write that moved it to `held` reports it.
 */
async function alertHeldBatch(held: HeldMonth[]): Promise<void> {
  if (!held.length) return;
  const lines = held.map(({ billingUserId, month, record }) =>
    `- ${billingUserId} ${month} (${record.heldReason}): ${heldRunbook(month, record)}`);
  const first = held[0];
  const subject = held.length === 1
    ? `PAYG settlement held for ${first.month}: ${first.record.heldReason}`
    : `PAYG settlement held ${held.length} months this run`;
  try {
    const { emailService } = await import('./emailService');
    await emailService.sendOncallAlert(
      subject,
      `Month-end pay-as-you-go settlement held ${held.length === 1 ? 'a month' : `${held.length} months`}; nothing was charged for them.\n`
        + lines.join('\n'),
      {
        'Alert Class': PAYG_SETTLEMENT_ALERT_CLASS,
        heldCount: held.length,
        held: held.map(({ billingUserId, month, record }) => ({
          billingUserId,
          month,
          heldReason: record.heldReason,
          settledMicroUsd: record.settledMicroUsd,
          projectedMicroUsd: record.projectedMicroUsd,
          invoiceId: record.invoiceId ?? null,
          uncollectedInvoiceId: record.uncollectedInvoice?.invoiceId ?? null,
          conflictingInvoiceIds: record.conflictingInvoiceIds ?? null,
        })),
      },
    );
  } catch (error: unknown) {
    console.error(`${TAG} on-call alert for ${held.length} held month(s) failed:`, errorText(error));
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
  // Stripe can collect before the run records the month invoiced (a balance, an instant charge): the
  // month's one invoice email still goes out, from here if the run has not sent it.
  await sendInvoiceEmailOnce(user, ref.billingUserId, ref.month, ref.invoiceId, record.percentOfCap, invoice.hosted_invoice_url);
  await recordOverageInvoicePayment(ref, invoice, 'payg_overage_payment_succeeded');
  await liftPaymentFailureSuspension(ref.billingUserId);
  console.log(`${TAG} overage invoice ${ref.invoiceId} paid: ${ref.billingUserId} ${ref.month}`);
}

/**
 * A payment-failure suspension lasts while ANY month's overage invoice is `failed`. Called after this
 * month's own `paid` write: it reads the row strongly consistent THEN, so of two months paid at once at
 * least one webhook sees both paid, and lifts only if no month is still failed and `suspended` is still
 * EXACTLY the value that read saw. A month that newly fails re-stamps `suspended`
 * (`suspendForPaymentFailure`), so a failure landing after the read stops the lift; a redelivered
 * failure for a month already failed changes nothing. A dispute suspension is never lifted here.
 */
async function liftPaymentFailureSuspension(billingUserId: string): Promise<void> {
  const user = (await userDb.getUserByIdConsistent(billingUserId)) as User | undefined;
  const suspended = user?.paygOverage?.suspended;
  if (suspended?.reason !== 'payment_failed') return;
  const stillFailed = Object.values(user?.paygSettlements ?? {}).some((record) => record?.status === 'failed');
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

/**
 * The payment-history row for an overage invoice's payment outcome, under its own event types (the
 * webhook controller does not record overage invoices as subscription payments). Deduped atomically per
 * invoice and type, so a redelivery (or Stripe's next retry of a failed charge) adds nothing.
 */
async function recordOverageInvoicePayment(
  ref: OverageInvoiceRef,
  invoice: OverageInvoiceEvent,
  eventType: 'payg_overage_payment_succeeded' | 'payg_overage_payment_failed',
): Promise<void> {
  await paymentHistoryDb.record({
    userId: ref.billingUserId,
    timestamp: new Date().toISOString(),
    eventType,
    amount: (eventType === 'payg_overage_payment_succeeded' ? invoice.amount_paid : invoice.amount_due) ?? 0,
    currency: invoice.currency || 'usd',
    status: eventType === 'payg_overage_payment_succeeded' ? 'paid' : 'failed',
    stripeInvoiceId: ref.invoiceId,
    metadata: { purchaseType: PAYG_OVERAGE_PURCHASE_TYPE, month: ref.month },
  }, { dedupKey: `${eventType}:${ref.invoiceId}` });
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
    // Where the owner can pay it with any card (GET /payg and the 429 point here while it is unpaid).
    ...(invoice.hosted_invoice_url ? { hostedInvoiceUrl: invoice.hosted_invoice_url } : {}),
  });
  await suspendForPaymentFailure(ref.billingUserId, ref.month, ref.invoiceId, moved);
  await recordOverageInvoicePayment(ref, invoice, 'payg_overage_payment_failed');
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
  const recorded = await paymentHistoryDb.record(
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
  // A disputed overage suspends a customer until the dispute closes: someone has to know. Once per
  // dispute (the history row's dedupe is the gate).
  if (recorded.written) {
    await alertOnCall(
      `PAYG suspended: overage charge disputed (${ref.month})`,
      `Pay-as-you-go is suspended for ${ref.billingUserId}: the overage charge ${charge?.id} for ${ref.month} `
        + `(invoice ${ref.invoiceId}) is disputed (${dispute?.id}, reason ${dispute?.reason ?? 'unknown'}). Respond to the `
        + 'dispute in Stripe. If it is won or withdrawn, pay-as-you-go resumes on its own when the dispute closes; if it '
        + 'is lost, the month is written off and pay-as-you-go stays suspended until someone clears it.',
      { billingUserId: ref.billingUserId, month: ref.month, invoiceId: ref.invoiceId, disputeId: dispute?.id ?? null },
    );
  }
  console.log(`${TAG} overage charge ${charge?.id} disputed (${dispute?.id}): ${ref.billingUserId} ${ref.month}; PAYG suspended`);
}

/**
 * `charge.dispute.closed` on an overage charge. Won (or a closed inquiry): the dispute suspension it
 * caused is lifted — replaced by a payment-failure suspension if another month is still unpaid, so paying
 * that one lifts it. Lost: the money went back, so the month is written off (`dispute_lost`), PAYG stays
 * suspended, and on-call is told. Either way the outcome is recorded on the month.
 */
export async function handlePaygOverageChargeDisputeClosed(
  dispute: OverageDisputeEvent & { status?: string },
  charge: OverageChargeEvent,
  invoice: OverageInvoiceEvent,
): Promise<void> {
  const loaded = await loadSettlementFor(invoice, 'dispute closed');
  if (!loaded) return;
  const { ref, record } = loaded;
  const at = new Date().toISOString();
  const status = String(dispute?.status || 'closed');
  await userDb.updateUser(ref.billingUserId, {}, {
    pathSets: [{
      path: ['paygSettlements', ref.month, 'dispute'],
      value: { disputeId: String(dispute?.id || record.dispute?.disputeId || ''), at: record.dispute?.at ?? at, status, closedAt: at },
    }],
    condition: { expression: 'attribute_exists(#settlements.#month)', names: { '#settlements': 'paygSettlements', '#month': ref.month } },
  });
  if (status === 'won' || status === 'warning_closed') {
    await liftDisputeSuspension(ref.billingUserId, ref.invoiceId);
    console.log(`${TAG} dispute ${dispute?.id} on ${ref.invoiceId} closed ${status}: ${ref.billingUserId}; dispute hold lifted`);
    return;
  }
  if (status === 'lost') {
    const moved = await transitionSettlement(ref.billingUserId, ref.month, ['paid', 'invoiced', 'failed'], {
      status: 'written_off',
      writtenOffReason: 'dispute_lost',
      writtenOffAt: at,
    });
    if (moved) {
      await alertOnCall(
        `PAYG dispute lost: ${ref.month} written off`,
        `The dispute ${dispute?.id} on ${ref.billingUserId}'s overage charge for ${ref.month} (invoice ${ref.invoiceId}) was `
          + 'lost: the money went back to the customer and the month is written off. Pay-as-you-go stays suspended (reason '
          + 'dispute). Decide with the account owner; to resume it, remove paygOverage.suspended on the AW-Users row.',
        { billingUserId: ref.billingUserId, month: ref.month, invoiceId: ref.invoiceId, disputeId: dispute?.id ?? null },
      );
    }
  }
}

/**
 * Lift the dispute suspension a won dispute leaves behind — only the one this invoice caused, and only
 * if `suspended` is still exactly what this read saw. If another month is still `failed`, the account
 * stays suspended for THAT (as a payment failure on its invoice, which paying it lifts).
 */
async function liftDisputeSuspension(billingUserId: string, invoiceId: string): Promise<void> {
  const user = (await userDb.getUserByIdConsistent(billingUserId)) as User | undefined;
  const suspended = user?.paygOverage?.suspended;
  if (suspended?.reason !== 'dispute' || suspended.invoiceId !== invoiceId) return;
  const failed = Object.values(user?.paygSettlements ?? {}).find((record) => record?.status === 'failed' && record.invoiceId);
  const names = { '#payg': 'paygOverage', '#suspended': 'suspended' };
  try {
    await userDb.updateUser(billingUserId, {}, failed
      ? {
          pathSets: [{ path: ['paygOverage', 'suspended'], value: { reason: 'payment_failed', at: new Date().toISOString(), invoiceId: failed.invoiceId } }],
          condition: { expression: '#payg.#suspended = :seen', names, values: { ':seen': suspended } },
        }
      : {
          pathRemoves: [{ path: ['paygOverage', 'suspended'] }],
          condition: { expression: '#payg.#suspended = :seen', names, values: { ':seen': suspended } },
        });
  } catch (error: unknown) {
    if (!isConditionalFailure(error)) throw error;
  }
}

/**
 * `invoice.voided` for an overage invoice (support forgave it in Stripe): nothing is collected for the
 * month any more, so it is written off (`invoice_voided`, invoice id kept for audit), a payment-failure
 * suspension is lifted once no other month is still unpaid (never a dispute), and on-call is told once.
 */
export async function handlePaygOverageInvoiceVoided(invoice: OverageInvoiceEvent): Promise<void> {
  const loaded = await loadSettlementFor(invoice, 'invoice voided');
  if (!loaded) return;
  const { ref, record } = loaded;
  const at = new Date().toISOString();
  const moved = await transitionSettlement(ref.billingUserId, ref.month, webhookSources(record, ref.invoiceId, ['pending', 'invoiced', 'failed']), {
    status: 'written_off',
    writtenOffReason: 'invoice_voided',
    writtenOffAt: at,
    invoiceId: ref.invoiceId,
  });
  await liftPaymentFailureSuspension(ref.billingUserId);
  if (moved) {
    await alertOnCall(
      `PAYG overage invoice voided: ${ref.month} written off`,
      `Invoice ${ref.invoiceId} (${ref.billingUserId}, ${ref.month}) was voided in Stripe: the month is written off and `
        + 'will not be billed again. If it was the only unpaid month, pay-as-you-go resumed. If this was not intended, '
        + `bill the customer by hand; settlement will not re-invoice it (set paygSettlements.${ref.month}.status to "retry" `
        + 'only if a new invoice should be issued — it searches Stripe first and ignores void invoices).',
      { billingUserId: ref.billingUserId, month: ref.month, invoiceId: ref.invoiceId },
    );
  }
  console.log(`${TAG} overage invoice ${ref.invoiceId} voided: ${ref.billingUserId} ${ref.month} written off`);
}

/**
 * `invoice.marked_uncollectible`: Stripe stopped collecting automatically, but the invoice can still be
 * paid (hosted page). The month is (or becomes) `failed` with PAYG suspended, and `uncollectibleAt` is
 * recorded; a later `invoice.paid` still records it paid and lifts the suspension.
 */
export async function handlePaygOverageInvoiceMarkedUncollectible(invoice: OverageInvoiceEvent): Promise<void> {
  const loaded = await loadSettlementFor(invoice, 'invoice marked uncollectible');
  if (!loaded) return;
  const { ref, user, record } = loaded;
  if (record.status === 'paid' || record.status === 'written_off') return;
  const at = new Date().toISOString();
  const moved = await transitionSettlement(ref.billingUserId, ref.month, webhookSources(record, ref.invoiceId, ['pending', 'invoiced']), {
    status: 'failed',
    invoiceId: ref.invoiceId,
    failedAt: at,
    ...(invoice.hosted_invoice_url ? { hostedInvoiceUrl: invoice.hosted_invoice_url } : {}),
  });
  await transitionSettlement(ref.billingUserId, ref.month, ['failed'], { status: 'failed', uncollectibleAt: at });
  await suspendForPaymentFailure(ref.billingUserId, ref.month, ref.invoiceId, moved);
  if (moved && user.email) {
    const { emailService } = await import('./emailService');
    await emailService.sendPaygOveragePaymentFailedEmail({ to: user.email, month: ref.month, invoiceUrl: invoice.hosted_invoice_url });
  }
}

/**
 * `invoice.payment_action_required`: the bank held the charge for the owner to confirm (3-D Secure, a
 * mandate). The month stays `invoiced` and nothing is suspended; the owner is emailed once with the
 * hosted invoice page to confirm it.
 */
export async function handlePaygOverageInvoicePaymentActionRequired(invoice: OverageInvoiceEvent): Promise<void> {
  const loaded = await loadSettlementFor(invoice, 'invoice payment action required');
  if (!loaded) return;
  const { ref, user, record } = loaded;
  if (record.status !== 'pending' && record.status !== 'invoiced') return;
  if (!user.email) return;
  if (!(await claimSettlementFlag(ref.billingUserId, ref.month, ref.invoiceId, 'actionRequiredEmailedAt'))) return;
  const { emailService } = await import('./emailService');
  await emailService.sendPaygOveragePaymentActionRequiredEmail({ to: user.email, month: ref.month, invoiceUrl: invoice.hosted_invoice_url });
}

/** An on-call alert outside the held-month batch (disputes, voids). Never fails the webhook. */
async function alertOnCall(subject: string, message: string, context: Record<string, unknown>): Promise<void> {
  try {
    const { emailService } = await import('./emailService');
    await emailService.sendOncallAlert(subject, message, { 'Alert Class': PAYG_SETTLEMENT_ALERT_CLASS, ...context });
  } catch (error: unknown) {
    console.error(`${TAG} on-call alert "${subject}" failed:`, errorText(error));
  }
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
  }, { dedupKey: `refund:${charge?.id}:${refundedCents}` }); // a redelivery adds no second row
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
