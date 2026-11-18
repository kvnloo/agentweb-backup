/**
 * ENG-3132 slice B4: reverse referral commission when Stripe credits a Zoma invoice (`credit_note.created`).
 *
 * The rate and attribution come from the invoice's accrual row, never from current config. Only the
 * commissionable part of a credit note reverses: the $1 trial-fee line never earned, so crediting it
 * reverses nothing. Total reversals for an invoice never exceed what it accrued on.
 *
 * Outages throw (the webhook must 5xx so Stripe retries). A shape we cannot read safely returns
 * `unsafe` with a reason for the caller to alert on; it never guesses.
 *
 * Not covered: a refund issued without a credit note (charge refund) and `credit_note.voided`.
 */
import { buildReversalEntry, reversalKey, accrualKey, type ZomaLedgerEntry, type ZomaReferralLedgerStore } from './zomaReferralLedger';

export interface CreditNoteLike {
  id: string;
  status?: string | null;
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
  | { status: 'ignored'; reason: 'not_issued' }
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

  const alreadyReversed = rows.filter((r) => r.invoiceId === invoiceId && r.kind === 'reversal').reduce((s, r) => s - r.baseCents, 0);
  const remaining = accrual.baseCents - alreadyReversed;
  if (remaining <= 0) return { status: 'nothing_to_reverse', reason: 'fully_reversed' };

  const creditedBaseCents = Math.min(credited, remaining);
  const entry = buildReversalEntry({
    referredUserId: accrual.referredUserId,
    referrerId: accrual.referrerId,
    code: accrual.code,
    percentBps: accrual.percentBps,
    invoiceId,
    paidAt: accrual.paidAt,
    now: (deps.now ?? (() => new Date()))(),
    creditNoteId: creditNote.id,
    creditedBaseCents,
  });
  return (await deps.ledger.append(entry)) ? { status: 'reversed', entry, clamped: creditedBaseCents < credited } : { status: 'duplicate' };
}
