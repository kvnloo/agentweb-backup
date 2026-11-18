/**
 * ENG-3132 slice B4: reverse referral commission when Stripe credits a Zoma invoice (`credit_note.created`).
 *
 * The rate and attribution come from the invoice's accrual row, never from current config. Only the
 * commissionable part of a credit note reverses: the $1 trial-fee line never earned, so crediting it
 * reverses nothing. Reversals are cumulative (commission of the total credited base minus what was already
 * reversed), so rounding never drifts and a full refund returns exactly the accrued commission. The clamp
 * to the accrued base is safe because Stripe itself caps total credit at the invoice amount.
 *
 * Outages throw (the webhook must 5xx so Stripe retries). A shape we cannot read safely returns
 * `unsafe` with a reason for the caller to alert on; it never guesses.
 *
 * Not covered: a refund issued without a credit note (a charge refund); the reconcile script flags those.
 */
import { commissionCents } from './zomaReferralCommission';
import { accrualKey, buildReversalEntry, buildVoidEntry, reversalKey, voidKey, type ZomaLedgerEntry, type ZomaReferralLedgerStore } from './zomaReferralLedger';

export interface CreditNoteLike {
  id: string;
  status?: string | null;
  /** Unix seconds; the reversal is stamped in this month. */
  created?: number;
  invoice: string | { id: string };
  total_excluding_tax?: number | null;
  lines?: { data?: Array<{ invoice_line_item?: string | null; amount: number; discount_amount: number }>; has_more?: boolean } | null;
}

export interface ReversalInvoice {
  /** Zoma plan subscription metadata `userId`. */
  userId?: string;
  lines?: {
    data?: Array<{ id: string; pricing?: { price_details?: { price?: string } | null } | null; price?: { id?: string } | null }>;
    has_more?: boolean;
  } | null;
}

export interface ReversalDeps {
  ledger: ZomaReferralLedgerStore;
  getInvoice(invoiceId: string): Promise<ReversalInvoice>;
  feePriceIds: readonly string[];
  now?: () => Date;
}

export type ReversalResult =
  | { status: 'reversed'; entry: ZomaLedgerEntry; clamped: boolean }
  | { status: 'duplicate' }
  | { status: 'no_accrual' }
  | { status: 'nothing_to_reverse'; reason: 'fee_only' | 'fully_reversed' }
  | { status: 'ignored'; reason: 'not_issued' | 'not_void' }
  | { status: 'unsafe'; reason: 'no_fee_price_configured' | 'no_user' | 'missing_totals' | 'lines_truncated' | 'unmapped_line' };

export async function reverseReferralCommission(creditNote: CreditNoteLike, deps: ReversalDeps): Promise<ReversalResult> {
  if (creditNote.status !== 'issued') return { status: 'ignored', reason: 'not_issued' };
  if (deps.feePriceIds.length === 0) return { status: 'unsafe', reason: 'no_fee_price_configured' };
  if (typeof creditNote.total_excluding_tax !== 'number') return { status: 'unsafe', reason: 'missing_totals' };
  if (creditNote.lines?.has_more || !creditNote.lines?.data) return { status: 'unsafe', reason: 'lines_truncated' };

  const invoiceId = typeof creditNote.invoice === 'string' ? creditNote.invoice : creditNote.invoice.id;
  const invoice = await deps.getInvoice(invoiceId);
  if (!invoice.userId) return { status: 'unsafe', reason: 'no_user' };
  if (invoice.lines?.has_more || !invoice.lines?.data) return { status: 'unsafe', reason: 'lines_truncated' };

  const rows = await deps.ledger.listForReferredUser(invoice.userId);
  const accrual = rows.find((r) => r.entry === accrualKey(invoiceId));
  if (!accrual) return { status: 'no_accrual' };
  if (rows.some((r) => r.entry === reversalKey(invoiceId, creditNote.id))) return { status: 'duplicate' };

  const feeLineIds = new Set(
    invoice.lines.data.filter((l) => deps.feePriceIds.includes(l.pricing?.price_details?.price ?? l.price?.id ?? '')).map((l) => l.id),
  );
  const knownLineIds = new Set(invoice.lines.data.map((l) => l.id));
  let feeNet = 0;
  for (const line of creditNote.lines.data) {
    if (!line.invoice_line_item || !knownLineIds.has(line.invoice_line_item)) return { status: 'unsafe', reason: 'unmapped_line' };
    if (feeLineIds.has(line.invoice_line_item)) feeNet += line.amount - line.discount_amount;
  }

  const credited = creditNote.total_excluding_tax - feeNet;
  if (credited <= 0) return { status: 'nothing_to_reverse', reason: 'fee_only' };

  const reversalRows = rows.filter((r) => r.invoiceId === invoiceId && r.kind === 'reversal');
  const reversedBase = reversalRows.reduce((sum, r) => sum - r.baseCents, 0);
  const reversedCommission = reversalRows.reduce((sum, r) => sum - r.commissionCents, 0);
  const remaining = accrual.baseCents - reversedBase;
  if (remaining <= 0) return { status: 'nothing_to_reverse', reason: 'fully_reversed' };

  const creditedBaseCents = Math.min(credited, remaining);
  const totalBase = reversedBase + creditedBaseCents;
  const targetCommission = totalBase >= accrual.baseCents ? accrual.commissionCents : commissionCents(totalBase, accrual.percentBps);
  const now = (deps.now ?? (() => new Date()))();
  const entry = buildReversalEntry({
    referredUserId: accrual.referredUserId,
    referrerId: accrual.referrerId,
    code: accrual.code,
    percentBps: accrual.percentBps,
    invoiceId,
    paidAt: accrual.paidAt,
    now,
    creditNoteId: creditNote.id,
    creditedBaseCents,
    commissionCentsToReverse: Math.max(0, targetCommission - reversedCommission),
    creditedAt: (creditNote.created ? new Date(creditNote.created * 1000) : now).toISOString(),
  });
  return (await deps.ledger.append(entry)) ? { status: 'reversed', entry, clamped: creditedBaseCents < credited } : { status: 'duplicate' };
}

export type VoidResult =
  | { status: 'voided'; entry: ZomaLedgerEntry }
  | { status: 'duplicate' }
  | { status: 'no_reversal' }
  | { status: 'ignored'; reason: 'not_void' }
  | { status: 'unsafe'; reason: 'no_user' };

/**
 * `credit_note.voided`: cancel the reversal that credit note made, so the referrer keeps the commission on
 * money Stripe did not actually hand back. A note that never reversed anything (fee-only, no accrual) is a no-op.
 */
export async function voidReferralReversal(creditNote: CreditNoteLike, deps: Pick<ReversalDeps, 'ledger' | 'getInvoice' | 'now'>): Promise<VoidResult> {
  if (creditNote.status !== 'void') return { status: 'ignored', reason: 'not_void' };
  const invoiceId = typeof creditNote.invoice === 'string' ? creditNote.invoice : creditNote.invoice.id;
  const { userId } = await deps.getInvoice(invoiceId);
  if (!userId) return { status: 'unsafe', reason: 'no_user' };

  const rows = await deps.ledger.listForReferredUser(userId);
  const reversal = rows.find((r) => r.entry === reversalKey(invoiceId, creditNote.id));
  if (!reversal) return { status: 'no_reversal' };
  if (rows.some((r) => r.entry === voidKey(invoiceId, creditNote.id))) return { status: 'duplicate' };

  const now = (deps.now ?? (() => new Date()))();
  const entry = buildVoidEntry(reversal, now.toISOString(), now);
  return (await deps.ledger.append(entry)) ? { status: 'voided', entry } : { status: 'duplicate' };
}
