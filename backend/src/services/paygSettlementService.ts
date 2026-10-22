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
 * + one email, unless the bank only awaits the owner's confirmation (3-D Secure: not a failure);
 * dispute -> suspended `dispute` (lifted once every dispute is closed and none was lost); refund ->
 * recorded only, never resumes. None of them touch a subscription field —
 * `handleInvoicePaymentSucceeded/Failed` hand overage invoices here first.
 *
 * Rollback: set the switch to anything but 'true'. The cron stops; a `pending` month stays pending and
 * is resumed (same amount, Stripe searched first) only if the switch comes back — nothing is charged
 * twice. Invoice and dispute webhooks keep being handled either way (only new charges are switched);
 * refund recognition needs the switch on.
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
  paygPaymentConfirmationOverdue,
  paygSpendDriftTolerable,
  PAYG_PAYMENT_CONFIRMATION_GRACE_DAYS,
  previousUsageMonth,
  type PaygMonthInputs,
  type PaygDisputeRecord,
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
  status?: string | null;
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
  | 'paid'
  /** The sweep held PAYG for a payment left unconfirmed past the grace period (`expireUnconfirmedPayment`). */
  | 'payment_unconfirmed';

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
 * it to the sweep, which sends one alert for the whole run. The write that moved the month to `held` also
 * set its `alertPending`, which is cleared only once the alert went out (`alertAndClearHeld`): a sweep
 * that dies before alerting leaves it set, and the next sweep sends it.
 */
type HeldReporter = (held: HeldMonth) => Promise<void>;
const alertEachHeld: HeldReporter = (held) => alertAndClearHeld([held]);

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
  // Alerts an earlier sweep never sent (it died, or the alert failed): each such month still carries
  // `alertPending`. Sent first, so a crash later in this run cannot delay them again.
  await alertAndClearHeld(pendingHeldAlerts(owners as User[]));
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
    // A payment left waiting for the owner's confirmation past the grace period is treated as unpaid.
    for (const [unconfirmedMonth, record] of Object.entries(owner.paygSettlements ?? {})) {
      if (record?.status !== 'invoiced' || !paygPaymentConfirmationOverdue(record.actionRequiredAt, now)) continue;
      try {
        const outcome = await expireUnconfirmedPayment(billingUserId, unconfirmedMonth, now);
        if (outcome) summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
      } catch (error: unknown) {
        recordFailure(summary, billingUserId, unconfirmedMonth, error);
      }
    }
  }
  // One alert per run, however many months it held — turning settlement on after gate-only months
  // would otherwise page once per owner per month.
  await alertAndClearHeld(summary.held);
  return summary;
}

/** Held months whose alert has not gone out yet (`alertPending`), from the sweep's scan. */
function pendingHeldAlerts(owners: User[]): HeldMonth[] {
  const pending: HeldMonth[] = [];
  for (const owner of owners) {
    const billingUserId = String(owner?.userId || '');
    const settlements = owner?.paygSettlements;
    if (!billingUserId || !settlements || typeof settlements !== 'object') continue;
    for (const [month, record] of Object.entries(settlements)) {
      if (record && typeof record === 'object' && typeof record.alertPending === 'string') {
        pending.push({ billingUserId, month, record });
      }
    }
  }
  return pending;
}

/**
 * One on-call alert for `held`, then each month's `alertPending` is cleared — only if the alert went out,
 * and only if the flag is still the one alerted about. At least once: a crash between the two sends the
 * alert again next run, never loses it.
 */
async function alertAndClearHeld(held: HeldMonth[]): Promise<void> {
  if (!held.length) return;
  if (!(await alertHeldBatch(held))) return;
  for (const { billingUserId, month, record } of held) {
    if (typeof record.alertPending !== 'string') continue;
    try {
      await userDb.updateUser(billingUserId, {}, {
        pathRemoves: [{ path: ['paygSettlements', month, 'alertPending'] }],
        condition: {
          expression: '#settlements.#month.#alertPending = :alertPending',
          names: { '#settlements': 'paygSettlements', '#month': month, '#alertPending': 'alertPending' },
          values: { ':alertPending': record.alertPending },
        },
      });
    } catch (error: unknown) {
      // Already cleared (another sweep), or the record changed: nothing to clear. Anything else leaves
      // the flag set, so the next sweep alerts again rather than never.
      if (!isConditionalFailure(error)) {
        console.error(`${TAG} clearing the alert flag on ${billingUserId} ${month} failed:`, errorText(error));
      }
    }
  }
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
    ({ ...base, ...fields, status: 'held', heldReason, alertPending: at });

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
    recordCreatedAt: record.createdAt,
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
  // The month's invoice email goes out once, in the words of what was recorded, and only from the write
  // that recorded it: this run when it moved the month, else the webhook that beat it — `invoice.paid`
  // sends it in its paid wording; a failure or a void that landed first sends its own email or none, so
  // the owner never reads "Stripe will charge your card" after "your payment didn't go through".
  if (marked) {
    await sendInvoiceEmailOnce(user, billingUserId, month, invoice.id!, record.percentOfCap, invoice.hosted_invoice_url, alreadyPaid ? 'paid' : 'invoiced');
  }
  if (marked && alreadyPaid) await liftPaymentFailureSuspension(billingUserId);
  if (!marked) return 'raced';
  return alreadyPaid ? 'paid' : 'invoiced';
}

/**
 * Send the month's invoice email at most once: claimed with a conditional write on `emailedAt` (and the
 * invoice it is about, and the state it describes), so the run and a racing `invoice.paid` webhook cannot
 * both send it, a redelivery sends nothing, and a month that failed or was voided in the meantime gets no
 * "will charge your card" email. `paid`: Stripe already collected it (the paid wording).
 */
async function sendInvoiceEmailOnce(
  user: Pick<User, 'email'>,
  billingUserId: string,
  month: string,
  invoiceId: string,
  percentOfCap: number,
  invoiceUrl: string | null | undefined,
  state: 'invoiced' | 'paid',
): Promise<void> {
  if (!user.email) return;
  if (!(await claimSettlementFlag(billingUserId, month, invoiceId, 'emailedAt', state))) return;
  const { emailService } = await import('./emailService');
  await emailService.sendPaygOverageInvoiceEmail({ to: user.email, month, percentOfCap, invoiceUrl, paid: state === 'paid' });
}

/**
 * Set a once-only timestamp on the month's record (`emailedAt`, `actionRequiredEmailedAt`) if it is not
 * set yet, the record names `invoiceId` and (when given) the month is in `status`. True for the one
 * caller that set it.
 */
async function claimSettlementFlag(
  billingUserId: string,
  month: string,
  invoiceId: string,
  flag: 'emailedAt' | 'actionRequiredEmailedAt',
  status?: PaygSettlementStatus,
): Promise<boolean> {
  try {
    await userDb.updateUser(billingUserId, {}, {
      pathSets: [{ path: ['paygSettlements', month, flag], value: new Date().toISOString() }],
      condition: {
        expression: '#settlements.#month.#invoiceId = :invoiceId AND attribute_not_exists(#settlements.#month.#flag)'
          + (status ? ' AND #settlements.#month.#status = :status' : ''),
        names: {
          '#settlements': 'paygSettlements', '#month': month, '#invoiceId': 'invoiceId', '#flag': flag,
          ...(status ? { '#status': 'status' } : {}),
        },
        values: { ':invoiceId': invoiceId, ...(status ? { ':status': status } : {}) },
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
  // `alertPending` in the same write as the hold: the alert survives a crash before it is sent.
  const fields: Partial<PaygSettlement> = { status: 'held', heldReason, alertPending: new Date().toISOString(), ...extra };
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
 * One on-call alert for a batch of held months (a whole sweep's, or one month's on a direct call). True
 * when it went out. A month is alerted about until an alert for it went out (`alertPending`).
 */
async function alertHeldBatch(held: HeldMonth[]): Promise<boolean> {
  if (!held.length) return true;
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
    return true;
  } catch (error: unknown) {
    console.error(`${TAG} on-call alert for ${held.length} held month(s) failed; the next sweep sends it:`, errorText(error));
    return false;
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
  // A record that names no invoice yet (a `pending` re-created after a `retry`, say) owns only the invoice
  // its own run created: this record's key AND this record's `createdAt` in the metadata, and not void.
  // The key alone is the same for every record of the month, so it cannot tell an earlier record's
  // invoice from this one's. A late event about an older invoice of the month (a voided one, or a
  // redelivered failure from before the void) must never write off, fail or pay the new record. An older
  // live invoice the run's search adopts becomes this record's as soon as the run records its id.
  if (!record.invoiceId && (invoice.status === 'void' || invoice.metadata?.idempotencyKey !== record.idempotencyKey
    || invoice.metadata?.recordCreatedAt !== record.createdAt)) {
    console.warn(`${TAG} ${event}: settlement ${ref.month} for ${ref.billingUserId} names no invoice yet, and invoice ${ref.invoiceId} `
      + `(${invoice.status ?? 'status unknown'}) is not one it would adopt; ignored`);
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
  // Stripe can collect before the run records the month invoiced (a balance, an instant charge), or a
  // held month's invoice can be paid later: the month's one invoice email still goes out, from here, in
  // its paid wording, if the run has not sent it.
  await sendInvoiceEmailOnce(user, ref.billingUserId, ref.month, ref.invoiceId, record.percentOfCap, invoice.hosted_invoice_url, 'paid');
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

/**
 * `invoice.payment_failed` for an overage invoice: `failed`, PAYG suspended, one owner email — unless the
 * bank is only waiting for the owner to confirm the payment (3-D Secure, a mandate). Stripe reports that
 * attempt as failed too (the PaymentIntent goes to `requires_action`) next to
 * `invoice.payment_action_required`; it is not a decline, so nothing is suspended, no failure email is
 * sent, the month stays as it is, and the owner is asked once to confirm (whichever event lands first).
 * A decline — or an authentication the owner failed (`requires_payment_method`) — still fails the month.
 */
export async function handlePaygOverageInvoicePaymentFailed(invoice: OverageInvoiceEvent): Promise<void> {
  const loaded = await loadSettlementFor(invoice, 'invoice payment failed');
  if (!loaded) return;
  const { ref, user, record } = loaded;
  if (record.status === 'paid') return; // an out-of-order failure for an invoice already paid
  // A failed lookup throws: the webhook answers 500 and Stripe redelivers — never guess either way.
  const state = await stripeService.paygOverageInvoicePaymentState(ref.invoiceId);
  if (state === 'in_progress') {
    // The owner confirmed (or a debit is settling) after Stripe sent this: `invoice.paid` follows.
    console.log(`${TAG} overage invoice ${ref.invoiceId}: a failure was reported but its payment has gone through or is processing: ${ref.billingUserId} ${ref.month}; not a failure`);
    return;
  }
  if (state === 'action_required') {
    console.log(`${TAG} overage invoice ${ref.invoiceId} awaits the owner's confirmation (requires_action): ${ref.billingUserId} ${ref.month}; not a failure`);
    await noteActionRequired(ref);
    await sendActionRequiredEmailOnce(user, ref, record, invoice);
    return;
  }
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

/**
 * The expression names a condition actually uses, out of `names`: DynamoDB rejects a request carrying an
 * unused one, and the dispute writes below pick their clauses from what the read saw.
 */
function usedNames(expression: string, names: Record<string, string>): Record<string, string> {
  const used = new Set(expression.match(/#[A-Za-z0-9_]+/g) ?? []);
  return Object.fromEntries(Object.entries(names).filter(([placeholder]) => used.has(placeholder)));
}

const disputeNames = (month: string, disputeId: string): Record<string, string> => ({
  '#settlements': 'paygSettlements', '#month': month, '#disputes': 'disputes', '#dispute': disputeId, '#closedAt': 'closedAt',
  '#payg': 'paygOverage', '#suspended': 'suspended', '#lost': 'lost',
});

/**
 * `charge.dispute.created` on an overage charge: the dispute is recorded open on the month AND PAYG is
 * suspended (`dispute`), in ONE conditional write — so a won-dispute lift that read the row before this
 * dispute existed is always refused (the hold it compares against was re-stamped in the same write).
 *
 * A dispute already recorded CLOSED is final: a `created` that arrives after its `closed` (Stripe does not
 * order events; a retry or a resend can land later) changes nothing — no hold, no history row, no page.
 * A lost dispute's hold (`lost`) is never re-stamped: only a person lifts it.
 */
export async function handlePaygOverageChargeDisputed(
  dispute: OverageDisputeEvent,
  charge: OverageChargeEvent,
  invoice: OverageInvoiceEvent,
): Promise<void> {
  const loaded = await loadSettlementFor(invoice, 'charge disputed');
  if (!loaded) return;
  const { ref } = loaded;
  const disputeId = String(dispute?.id || '');
  if (!disputeId) {
    console.warn(`${TAG} charge disputed: a dispute on ${charge?.id} (invoice ${ref.invoiceId}) has no id; ignored`);
    return;
  }
  const at = new Date().toISOString();
  const opened = await recordDisputeOpened(ref, disputeId, at);
  if (opened === 'closed' || opened === 'missing') {
    console.warn(`${TAG} charge disputed: dispute ${disputeId} on ${ref.invoiceId} (${ref.billingUserId} ${ref.month}) is `
      + `${opened === 'closed' ? 'already closed' : 'on a month with no settlement record'}; ignored (nothing suspended)`);
    return;
  }
  const recorded = await paymentHistoryDb.record(
    {
      userId: ref.billingUserId,
      timestamp: at,
      eventType: 'dispute_opened',
      amount: Number(dispute?.amount) || 0,
      currency: dispute?.currency || charge?.currency || 'usd',
      status: 'disputed',
      stripeInvoiceId: ref.invoiceId,
      metadata: { chargeId: charge?.id, disputeId, disputeReason: dispute?.reason, purchaseType: PAYG_OVERAGE_PURCHASE_TYPE },
    },
    { dedupKey: `dispute:opened:${disputeId}` },
  );
  // A disputed overage suspends a customer until the dispute closes: someone has to know. Once per
  // dispute (the history row's dedupe is the gate).
  if (recorded.written) {
    await alertOnCall(
      `PAYG suspended: overage charge disputed (${ref.month})`,
      `Pay-as-you-go is suspended for ${ref.billingUserId}: the overage charge ${charge?.id} for ${ref.month} `
        + `(invoice ${ref.invoiceId}) is disputed (${disputeId}, reason ${dispute?.reason ?? 'unknown'}). Respond to the `
        + 'dispute in Stripe. Once every dispute on the account is won or withdrawn, pay-as-you-go resumes on its own; if '
        + 'one is lost, the month is written off and pay-as-you-go stays suspended until someone clears it.',
      { billingUserId: ref.billingUserId, month: ref.month, invoiceId: ref.invoiceId, disputeId },
    );
  }
  console.log(`${TAG} overage charge ${charge?.id} disputed (${disputeId}): ${ref.billingUserId} ${ref.month}; PAYG suspended`);
}

/**
 * Record dispute `disputeId` open on the month and (re-)stamp the dispute hold, in one write conditional
 * on what the read saw. `opened`: this call recorded it; `open`: already recorded open (a redelivery — the
 * hold was set with it); `closed`: already closed, nothing written; `missing`: no settlement record.
 */
async function recordDisputeOpened(ref: OverageInvoiceRef, disputeId: string, at: string): Promise<'opened' | 'open' | 'closed' | 'missing'> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const user = (await userDb.getUserByIdConsistent(ref.billingUserId)) as User | undefined;
    const record = user?.paygSettlements?.[ref.month];
    if (!user || !record) return 'missing';
    const existing = record.disputes?.[disputeId];
    if (existing) return existing.closedAt ? 'closed' : 'open';
    const hasMap = !!record.disputes && typeof record.disputes === 'object';
    const entry: PaygDisputeRecord = { at };
    const lostHold = user.paygOverage?.suspended?.lost === true;
    const clauses = [hasMap
      ? 'attribute_exists(#settlements.#month.#disputes) AND attribute_not_exists(#settlements.#month.#disputes.#dispute)'
      : 'attribute_exists(#settlements.#month) AND attribute_not_exists(#settlements.#month.#disputes)'];
    const values: Record<string, unknown> = {};
    const pathSets: Array<{ path: Array<string | number>; value: unknown }> = [
      hasMap
        ? { path: ['paygSettlements', ref.month, 'disputes', disputeId], value: entry }
        : { path: ['paygSettlements', ref.month, 'disputes'], value: { [disputeId]: entry } },
    ];
    if (user.paygOverage) {
      if (lostHold) {
        // A lost dispute's hold stays exactly as it is (only a person lifts it).
        clauses.push('#payg.#suspended.#lost = :lost');
        values[':lost'] = true;
      } else {
        // Replaces a payment-failure hold too: the stronger reason, which paying an invoice must not lift.
        pathSets.push({ path: ['paygOverage', 'suspended'], value: { reason: 'dispute', at, invoiceId: ref.invoiceId, disputeId } });
        clauses.push('attribute_exists(#payg) AND attribute_not_exists(#payg.#suspended.#lost)');
      }
    }
    const expression = clauses.join(' AND ');
    try {
      await userDb.updateUser(ref.billingUserId, {}, {
        pathSets,
        condition: { expression, names: usedNames(expression, disputeNames(ref.month, disputeId)), ...(Object.keys(values).length ? { values } : {}) },
      });
      return 'opened';
    } catch (error: unknown) {
      if (!isConditionalFailure(error)) throw error;
      // The row moved between the read and the write (another event about this account): read again.
    }
  }
  throw new Error(`charge disputed: could not record dispute ${disputeId} for ${ref.billingUserId} ${ref.month} after repeated conflicts; retry`);
}

/**
 * `charge.dispute.closed` on an overage charge. The dispute is recorded closed on the month (once: a
 * closed entry is final). Won (or a closed inquiry): the dispute hold is lifted once NO dispute on the
 * account is still open — handed to a still-failed month as a payment-failure hold if there is one, so
 * paying it lifts it. Lost: the money went back, so the month is written off (`dispute_lost`), PAYG is
 * held as a lost dispute (in the same write that closes it, so a crash cannot lose the hold), and on-call
 * is told. Handled whether or not settlement is switched on.
 */
export async function handlePaygOverageChargeDisputeClosed(
  dispute: OverageDisputeEvent & { status?: string },
  charge: OverageChargeEvent,
  invoice: OverageInvoiceEvent,
): Promise<void> {
  const loaded = await loadSettlementFor(invoice, 'dispute closed');
  if (!loaded) return;
  const { ref } = loaded;
  const disputeId = String(dispute?.id || '');
  if (!disputeId) {
    console.warn(`${TAG} dispute closed: a dispute on ${charge?.id} (invoice ${ref.invoiceId}) has no id; ignored`);
    return;
  }
  const at = new Date().toISOString();
  const status = String(dispute?.status || 'closed');
  const lost = status === 'lost';
  const newlyClosed = await recordDisputeClosed(ref, disputeId, status, at);
  if (status === 'won' || status === 'warning_closed') {
    // Idempotent, so a redelivery (the entry already closed) still lifts a hold a crash left behind.
    await liftDisputeSuspension(ref.billingUserId);
    console.log(`${TAG} dispute ${disputeId} on ${ref.invoiceId} closed ${status}: ${ref.billingUserId}; dispute hold lifted unless another dispute is open`);
    return;
  }
  if (lost) {
    const moved = await transitionSettlement(ref.billingUserId, ref.month, ['paid', 'invoiced', 'failed'], {
      status: 'written_off',
      writtenOffReason: 'dispute_lost',
      writtenOffAt: at,
    });
    if (newlyClosed || moved) {
      await alertOnCall(
        `PAYG dispute lost: ${ref.month} written off`,
        `The dispute ${disputeId} on ${ref.billingUserId}'s overage charge for ${ref.month} (invoice ${ref.invoiceId}) was `
          + 'lost: the money went back to the customer and the month is written off. Pay-as-you-go stays suspended (reason '
          + 'dispute, lost). Decide with the account owner; to resume it, remove paygOverage.suspended on the AW-Users row.',
        { billingUserId: ref.billingUserId, month: ref.month, invoiceId: ref.invoiceId, disputeId },
      );
    }
  }
}

/**
 * Record dispute `disputeId` closed (`status`) on the month — only if it is not recorded closed already
 * — and, for a lost dispute, hold PAYG as lost in the same write. True for the call that closed it.
 */
async function recordDisputeClosed(ref: OverageInvoiceRef, disputeId: string, status: string, at: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const user = (await userDb.getUserByIdConsistent(ref.billingUserId)) as User | undefined;
    const record = user?.paygSettlements?.[ref.month];
    if (!user || !record) return false;
    const existing = record.disputes?.[disputeId];
    if (existing?.closedAt) return false;
    const hasMap = !!record.disputes && typeof record.disputes === 'object';
    // Closed before (or without) its `created`: the entry is created closed, and a later `created` is ignored.
    const entry: PaygDisputeRecord = { at: existing?.at ?? at, status, closedAt: at };
    const clauses = [hasMap
      ? (existing
        ? 'attribute_exists(#settlements.#month.#disputes.#dispute) AND attribute_not_exists(#settlements.#month.#disputes.#dispute.#closedAt)'
        : 'attribute_exists(#settlements.#month.#disputes) AND attribute_not_exists(#settlements.#month.#disputes.#dispute)')
      : 'attribute_exists(#settlements.#month) AND attribute_not_exists(#settlements.#month.#disputes)'];
    const pathSets: Array<{ path: Array<string | number>; value: unknown }> = [
      hasMap
        ? { path: ['paygSettlements', ref.month, 'disputes', disputeId], value: entry }
        : { path: ['paygSettlements', ref.month, 'disputes'], value: { [disputeId]: entry } },
    ];
    if (status === 'lost' && user.paygOverage) {
      pathSets.push({ path: ['paygOverage', 'suspended'], value: { reason: 'dispute', at, invoiceId: ref.invoiceId, disputeId, lost: true } });
      clauses.push('attribute_exists(#payg)');
    }
    const expression = clauses.join(' AND ');
    try {
      await userDb.updateUser(ref.billingUserId, {}, {
        pathSets,
        condition: { expression, names: usedNames(expression, disputeNames(ref.month, disputeId)) },
      });
      return true;
    } catch (error: unknown) {
      if (!isConditionalFailure(error)) throw error;
    }
  }
  throw new Error(`dispute closed: could not record dispute ${disputeId} for ${ref.billingUserId} ${ref.month} after repeated conflicts; retry`);
}

/**
 * Lift the dispute hold once every dispute on the account is closed — only a hold a recorded dispute put
 * there (its `disputeId` is one of the account's disputes), never a lost one (`lost`). If a month is still
 * `failed`, the hold becomes a payment-failure hold on ITS invoice (which paying it lifts) instead of
 * being removed. The write is conditional on `suspended` being exactly what this read saw: a dispute
 * opened after the read re-stamps the hold in the same write that records it, and a month that fails
 * under a dispute hold stamps `paymentFailedAt` on it — either refuses this write, and the lift reads
 * again, so it never removes a hold an open dispute or a failed month still needs.
 */
async function liftDisputeSuspension(billingUserId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const user = (await userDb.getUserByIdConsistent(billingUserId)) as User | undefined;
    const suspended = user?.paygOverage?.suspended;
    if (suspended?.reason !== 'dispute' || suspended.lost) return;
    const records = Object.values(user?.paygSettlements ?? {}).filter((record): record is PaygSettlement => !!record && typeof record === 'object');
    const disputes = records.flatMap((record) => Object.entries(record.disputes ?? {}));
    if (!suspended.disputeId || !disputes.some(([id]) => id === suspended.disputeId)) return;
    if (disputes.some(([, entry]) => !entry?.closedAt)) return; // another dispute is still open
    const failed = Object.entries(user?.paygSettlements ?? {})
      .find(([, record]) => record?.status === 'failed' && record.invoiceId);
    const names = { '#payg': 'paygOverage', '#suspended': 'suspended' };
    const condition = { expression: '#payg.#suspended = :seen', names, values: { ':seen': suspended } };
    try {
      await userDb.updateUser(billingUserId, {}, failed
        ? {
            // A month failed because its payment was never confirmed keeps saying so (`unconfirmed`).
            pathSets: [{
              path: ['paygOverage', 'suspended'],
              value: {
                reason: 'payment_failed', at: new Date().toISOString(), invoiceId: failed[1].invoiceId,
                ...(failed[1].paymentUnconfirmedAt ? { unconfirmed: true } : {}),
              },
            }],
            // ...and only while THAT month is still failed on that invoice: paid or voided after this read,
            // it must not be handed a hold nothing would ever lift (the loop reads again).
            condition: {
              expression: '#payg.#suspended = :seen AND #settlements.#handedMonth.#status = :failed AND #settlements.#handedMonth.#invoiceId = :handedInvoice',
              names: { ...names, '#settlements': 'paygSettlements', '#handedMonth': failed[0], '#status': 'status', '#invoiceId': 'invoiceId' },
              values: { ':seen': suspended, ':failed': 'failed', ':handedInvoice': failed[1].invoiceId },
            },
          }
        : { pathRemoves: [{ path: ['paygOverage', 'suspended'] }], condition });
      return;
    } catch (error: unknown) {
      if (!isConditionalFailure(error)) throw error;
    }
  }
  throw new Error(`dispute closed: could not settle the dispute hold for ${billingUserId} after repeated conflicts; retry`);
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
  await noteActionRequired(ref);
  await sendActionRequiredEmailOnce(user, ref, record, invoice);
}

/**
 * Stamp `actionRequiredAt` the first time the month's payment is reported waiting for the owner's
 * confirmation — the start of `PAYG_PAYMENT_CONFIRMATION_GRACE_DAYS`. Only while the record names this
 * invoice and is still being collected; never moved by a later report.
 */
async function noteActionRequired(ref: OverageInvoiceRef): Promise<void> {
  try {
    await userDb.updateUser(ref.billingUserId, {}, {
      pathSets: [{ path: ['paygSettlements', ref.month, 'actionRequiredAt'], value: new Date().toISOString() }],
      condition: {
        expression: '#settlements.#month.#invoiceId = :invoiceId AND #settlements.#month.#status IN (:pending, :invoiced) '
          + 'AND attribute_not_exists(#settlements.#month.#actionRequiredAt)',
        names: { '#settlements': 'paygSettlements', '#month': ref.month, '#invoiceId': 'invoiceId', '#status': 'status', '#actionRequiredAt': 'actionRequiredAt' },
        values: { ':invoiceId': ref.invoiceId, ':pending': 'pending', ':invoiced': 'invoiced' },
      },
    });
  } catch (error: unknown) {
    if (!isConditionalFailure(error)) throw error;
  }
}

/**
 * The sweep's check of a month whose payment has waited for the owner's confirmation past
 * `PAYG_PAYMENT_CONFIRMATION_GRACE_DAYS`: if Stripe still has it waiting (or declined), the month is
 * treated as unpaid — `failed`, PAYG held (`payment_failed`, `unconfirmed`), one email with the invoice
 * to confirm it. Paying (confirming) it lifts the hold like any payment failure. A payment that went
 * through or is processing is left for its `invoice.paid`. The `invoiced -> failed` write is the dedupe.
 */
async function expireUnconfirmedPayment(billingUserId: string, month: string, now: Date): Promise<PaygSettlementOutcome | null> {
  const user = (await userDb.getUserByIdConsistent(billingUserId)) as User | undefined;
  const record = user?.paygSettlements?.[month];
  if (!user || !record || record.status !== 'invoiced' || !record.invoiceId) return null;
  if (!paygPaymentConfirmationOverdue(record.actionRequiredAt, now)) return null;
  const invoiceId = record.invoiceId;
  // The invoice first: one voided, paid or marked uncollectible in Stripe (its PaymentIntent then
  // canceled) before its webhook arrived is settled the way that webhook settles it — never held and
  // emailed "confirm your payment" for an invoice that cannot be paid any more.
  const invoice = await stripeService.retrievePaygOverageInvoice(invoiceId);
  if (!invoice) {
    console.warn(`${TAG} unconfirmed ${billingUserId} ${month}: invoice ${invoiceId} is deleted or unknown to Stripe; left for on-call`);
    return null;
  }
  if (invoice.status === 'paid') {
    await handlePaygOverageInvoicePaid(invoice);
    return null;
  }
  if (invoice.status === 'void') {
    await handlePaygOverageInvoiceVoided(invoice);
    return null;
  }
  if (invoice.status === 'uncollectible') {
    await handlePaygOverageInvoiceMarkedUncollectible(invoice);
    return null;
  }
  if (invoice.status !== 'open') return null;
  if ((await stripeService.paygOverageInvoicePaymentState(invoiceId)) === 'in_progress') return null;
  const at = now.toISOString();
  const moved = await transitionSettlement(billingUserId, month, ['invoiced'], { status: 'failed', failedAt: at, paymentUnconfirmedAt: at });
  if (!moved) return null;
  await suspendForPaymentFailure(billingUserId, month, invoiceId, true, { unconfirmed: true });
  const ref = { invoiceId, billingUserId, month };
  await recordOverageInvoicePayment(ref, { amount_due: record.amountCents, currency: 'usd' }, 'payg_overage_payment_failed');
  if (user.email) {
    const { emailService } = await import('./emailService');
    await emailService.sendPaygOveragePaymentUnconfirmedEmail({ to: user.email, month, invoiceUrl: record.hostedInvoiceUrl });
  }
  console.log(`${TAG} overage invoice ${invoiceId} still unconfirmed after ${PAYG_PAYMENT_CONFIRMATION_GRACE_DAYS} days: ${billingUserId} ${month}; PAYG held`);
  return 'payment_unconfirmed';
}

/** The "confirm your payment" email, once per month, while the month is still being collected. */
async function sendActionRequiredEmailOnce(user: User, ref: OverageInvoiceRef, record: PaygSettlement, invoice: OverageInvoiceEvent): Promise<void> {
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
 * `charge.refunded` on an overage charge. The settlement keeps the charge's cumulative refunded amount
 * (only ever raised, so an older event delivered late cannot lower it), and payment history gets ONE row
 * per Stripe refund with THAT refund's amount, deduped by refund id — two partial refunds of $12 and $8
 * are two rows summing to $20, and a redelivery adds nothing. (The refunds come from Stripe: since
 * 2022-11-15 a charge no longer carries them.) Never lifts a suspension. A failed lookup errors the
 * webhook so Stripe redelivers.
 */
export async function handlePaygOverageChargeRefunded(charge: OverageChargeEvent, invoice: OverageInvoiceEvent): Promise<void> {
  const loaded = await loadSettlementFor(invoice, 'charge refunded');
  if (!loaded) return;
  const { ref } = loaded;
  const refundedCents = Number(charge?.amount_refunded) || 0;
  try {
    await userDb.updateUser(ref.billingUserId, {}, {
      pathSets: [
        { path: ['paygSettlements', ref.month, 'refundedCents'], value: refundedCents },
        { path: ['paygSettlements', ref.month, 'updatedAt'], value: new Date().toISOString() },
      ],
      condition: {
        expression: 'attribute_exists(#settlements.#month) AND (attribute_not_exists(#settlements.#month.#refunded) OR #settlements.#month.#refunded < :refunded)',
        names: { '#settlements': 'paygSettlements', '#month': ref.month, '#refunded': 'refundedCents' },
        values: { ':refunded': refundedCents },
      },
    });
  } catch (error: unknown) {
    if (!isConditionalFailure(error)) throw error; // already at (or past) this figure
  }
  const refunds = charge?.id ? await stripeService.listChargeRefunds(charge.id) : [];
  for (const refund of refunds) {
    // A failed or canceled refund returned nothing.
    if (refund.status === 'failed' || refund.status === 'canceled') continue;
    await paymentHistoryDb.record({
      userId: ref.billingUserId,
      timestamp: new Date().toISOString(),
      eventType: 'refund',
      amount: refund.amount,
      currency: refund.currency || charge?.currency || 'usd',
      status: 'refunded',
      stripeInvoiceId: ref.invoiceId,
      metadata: { chargeId: charge?.id, refundId: refund.id, refundReason: refund.reason, fullRefund: charge?.refunded, purchaseType: PAYG_OVERAGE_PURCHASE_TYPE },
    }, { dedupKey: `refund:${refund.id}` }); // one row per refund; a redelivery adds none
  }
  console.log(`${TAG} overage charge ${charge?.id} refunded (${refundedCents}c over ${refunds.length} refund(s)): ${ref.billingUserId} ${ref.month}; PAYG not resumed`);
}

/**
 * Suspend PAYG for a failed overage charge — only while the month's record says THIS invoice failed
 * (`status = failed`, `invoiceId` = it), checked in the same write. That keeps a failure event that lost
 * a race with the payment (or arrived for an invoice settlement set aside) from suspending an account
 * with nothing unpaid. Never over a dispute.
 *
 * `restamp`: this event is the one that moved the month to `failed`, so `suspended` is re-stamped with
 * its time and invoice even if already set — a paid webhook that read the old value then cannot lift it
 * (`liftPaymentFailureSuspension`). Under a dispute hold it stamps `paymentFailedAt` on that hold instead,
 * so a won-dispute lift that read the row before this failure cannot remove it either. A redelivered or
 * retried failure for a month already `failed` changes nothing that is set, so it can never strand a
 * suspension that a payment is about to lift.
 */
async function suspendForPaymentFailure(
  billingUserId: string,
  month: string,
  invoiceId: string,
  restamp: boolean,
  options: { unconfirmed?: boolean } = {},
): Promise<void> {
  const failedOnThisInvoice = '#settlements.#month.#status = :failed AND #settlements.#month.#invoiceId = :invoiceId';
  try {
    await userDb.updateUser(billingUserId, {}, {
      pathSets: [{
        path: ['paygOverage', 'suspended'],
        value: { reason: 'payment_failed', at: new Date().toISOString(), invoiceId, ...(options.unconfirmed ? { unconfirmed: true } : {}) },
      }],
      condition: {
        expression: `attribute_exists(#payg) AND ${failedOnThisInvoice} AND `
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
    return;
  } catch (error: unknown) {
    // The month is not (or no longer) failed on this invoice, or a suspension already covers it.
    if (!isConditionalFailure(error)) throw error;
  }
  if (!restamp) return;
  try {
    await userDb.updateUser(billingUserId, {}, {
      pathSets: [{ path: ['paygOverage', 'suspended', 'paymentFailedAt'], value: new Date().toISOString() }],
      condition: {
        expression: `${failedOnThisInvoice} AND #payg.#suspended.#reason = :dispute`,
        names: {
          '#payg': 'paygOverage', '#suspended': 'suspended', '#settlements': 'paygSettlements', '#month': month,
          '#status': 'status', '#invoiceId': 'invoiceId', '#reason': 'reason',
        },
        values: { ':failed': 'failed', ':invoiceId': invoiceId, ':dispute': 'dispute' },
      },
    });
  } catch (error: unknown) {
    if (!isConditionalFailure(error)) throw error;
  }
}
