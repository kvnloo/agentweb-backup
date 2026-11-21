/**
 * ENG-3132 slice B1: the money arithmetic for Zoma referral commission. Pure functions, no IO.
 *
 * Rule (decided by Anurag, 2026-11-18): the referrer earns a percentage of every PAID Zoma invoice
 * except the $1 trial fee, ex-tax, for the referred user's first N commissionable invoices.
 * The fee is excluded by its LINE (price id), never by "the first invoice": a returning user has no
 * trial, and a Stripe test-clock run is still needed to prove which invoice carries overage lines.
 */

export interface InvoiceLineLike {
  amount: number;
  discount_amounts?: Array<{ amount: number }> | null;
  pricing?: { price_details?: { price?: string } | null } | null;
  /** Pre-basil API versions put the price here. */
  price?: { id?: string } | null;
}

export interface InvoiceLike {
  id: string;
  status?: string | null;
  currency?: string | null;
  amount_paid?: number | null;
  total_excluding_tax?: number | null;
  lines?: { data?: InvoiceLineLike[]; has_more?: boolean } | null;
  status_transitions?: { paid_at?: number | null } | null;
}

export type CommissionBase =
  | { status: 'ok'; baseCents: number; feeCents: number; currency: 'usd'; paidAt: string }
  | { status: 'skip'; reason: 'not_paid' | 'not_usd' | 'nothing_commissionable' }
  /** Cannot be computed safely; the caller must retry or investigate, never guess. */
  | { status: 'unsafe'; reason: 'no_fee_price_configured' | 'lines_truncated' | 'missing_totals' | 'missing_paid_at' };

const linePriceId = (l: InvoiceLineLike) => l.pricing?.price_details?.price ?? l.price?.id;
const lineNet = (l: InvoiceLineLike) => l.amount - (l.discount_amounts ?? []).reduce((s, d) => s + d.amount, 0);

/**
 * Commissionable base of one invoice: ex-tax total minus the net (after discount) of the trial-fee
 * line(s). `feePriceIds` must hold every trial-fee price ever used (keep historical ids).
 */
export function commissionBase(invoice: InvoiceLike, feePriceIds: readonly string[]): CommissionBase {
  if (invoice.status !== 'paid' || !((invoice.amount_paid ?? 0) > 0)) return { status: 'skip', reason: 'not_paid' };
  if ((invoice.currency ?? '').toLowerCase() !== 'usd') return { status: 'skip', reason: 'not_usd' };
  if (feePriceIds.length === 0) return { status: 'unsafe', reason: 'no_fee_price_configured' };
  if (invoice.lines?.has_more || !invoice.lines?.data) return { status: 'unsafe', reason: 'lines_truncated' };
  if (typeof invoice.total_excluding_tax !== 'number') return { status: 'unsafe', reason: 'missing_totals' };
  const paidAt = invoice.status_transitions?.paid_at;
  if (typeof paidAt !== 'number') return { status: 'unsafe', reason: 'missing_paid_at' };

  const feeCents = invoice.lines.data.filter((l) => feePriceIds.includes(linePriceId(l) ?? '')).reduce((s, l) => s + lineNet(l), 0);
  const baseCents = invoice.total_excluding_tax - feeCents;
  if (baseCents <= 0) return { status: 'skip', reason: 'nothing_commissionable' };
  return { status: 'ok', baseCents, feeCents, currency: 'usd', paidAt: new Date(paidAt * 1000).toISOString() };
}

/** Commission in cents for a base, rounded half-up. `percentBps` is basis points (2000 = 20%). */
export const commissionCents = (baseCents: number, percentBps: number): number => Math.round((baseCents * percentBps) / 10000);

/** UTC calendar month of a paid timestamp, e.g. `2026-12`. The payout report groups on this. */
export const payoutMonth = (paidAtIso: string): string => new Date(paidAtIso).toISOString().slice(0, 7);

/**
 * Is `invoiceId` among the referred user's first `months` commissionable invoices? The caller passes
 * every commissionable paid invoice of the subscription (from Stripe, not from the ledger), so the
 * answer does not depend on the order webhooks arrive in. Ordered by paid time, then id.
 */
export function inCommissionWindow(invoiceId: string, commissionable: ReadonlyArray<{ id: string; paidAt: string }>, months: number): boolean {
  const ordered = [...commissionable].sort((a, b) => a.paidAt.localeCompare(b.paidAt) || a.id.localeCompare(b.id));
  const idx = ordered.findIndex((i) => i.id === invoiceId);
  return idx >= 0 && idx < months;
}
