/**
 * ENG-3132 slice D: READ-ONLY reconcile of the referral ledger against Stripe. It never writes.
 *
 * It exists for the refund the webhook path cannot see: a refund issued on a charge with no credit note.
 * (A credit note with a refund also fires `charge.refunded`, so reversing from charge events would
 * double-reverse; counting Stripe's refunds here and comparing is safe because it only reports.)
 *
 * Per invoice, the ledger should net to the commission on the base that was not refunded. The refunded
 * share is taken from the gross amounts (`refunded / amountPaid`), which applies equally to the ex-tax base.
 */
import { commissionCents } from './zomaReferralCommission';
import type { ZomaLedgerEntry, ZomaReferralLedgerStore } from './zomaReferralLedger';

export interface InvoiceFacts {
  status: string | null;
  amountPaidCents: number;
  /** Every succeeded refund on the invoice's payments, including refunds with no credit note. */
  refundedCents: number;
}

export interface ReconcileDeps {
  ledger: Pick<ZomaReferralLedgerStore, 'listAll'>;
  /** null when Stripe has no such invoice. */
  getInvoiceFacts(invoiceId: string): Promise<InvoiceFacts | null>;
}

export type DiscrepancyKind = 'refund_not_reversed' | 'over_reversed' | 'accrual_without_paid_invoice' | 'invoice_missing_in_stripe' | 'net_mismatch';

export interface Discrepancy {
  kind: DiscrepancyKind;
  invoiceId: string;
  referredUserId: string;
  referrerId: string;
  /** The accrual's payout month (the invoice's paid month). */
  payoutMonth: string;
  expectedCommissionCents: number;
  actualCommissionCents: number;
  /** actual - expected: positive means the ledger owes the referrer more than Stripe's money supports. */
  differenceCents: number;
}

export interface ReconcileReport {
  checkedInvoices: number;
  discrepancies: Discrepancy[];
  totals: { actualCommissionCents: number; expectedCommissionCents: number; byKind: Partial<Record<DiscrepancyKind, number>> };
}

/** Rounding between credit-note amounts and Stripe's gross refunds can differ by a cent. */
export const RECONCILE_TOLERANCE_CENTS = 1;

const net = (rows: ZomaLedgerEntry[]) => rows.reduce((sum, r) => sum + r.commissionCents, 0);

function expectedNet(accrual: ZomaLedgerEntry, facts: InvoiceFacts): number {
  const refunded = Math.min(Math.max(facts.refundedCents, 0), facts.amountPaidCents);
  const refundedBase = refunded >= facts.amountPaidCents ? accrual.baseCents : Math.round((accrual.baseCents * refunded) / facts.amountPaidCents);
  const reversed = refundedBase >= accrual.baseCents ? accrual.commissionCents : commissionCents(refundedBase, accrual.percentBps);
  return accrual.commissionCents - reversed;
}

export async function reconcileReferralLedger(deps: ReconcileDeps, opts: { month?: string } = {}): Promise<ReconcileReport> {
  const byInvoice = new Map<string, ZomaLedgerEntry[]>();
  for (const row of await deps.ledger.listAll()) {
    const key = `${row.referredUserId}|${row.invoiceId}`;
    byInvoice.set(key, [...(byInvoice.get(key) ?? []), row]);
  }

  const discrepancies: Discrepancy[] = [];
  let checkedInvoices = 0;
  let expectedTotal = 0;
  let actualTotal = 0;

  for (const rows of byInvoice.values()) {
    const accrual = rows.find((r) => r.kind === 'accrual');
    const sample = accrual ?? rows[0];
    // The month is the invoice's accrual month; later reversals of that invoice still count in its net.
    if (opts.month && sample.payoutMonth !== opts.month) continue;

    const actual = net(rows);
    let expected = 0;
    let kind: DiscrepancyKind | null = null;
    if (!accrual) {
      kind = 'over_reversed'; // reversal rows with nothing to reverse
    } else {
      const facts = await deps.getInvoiceFacts(accrual.invoiceId);
      if (!facts) kind = 'invoice_missing_in_stripe';
      else if (facts.status !== 'paid' || facts.amountPaidCents <= 0) kind = 'accrual_without_paid_invoice';
      else {
        expected = expectedNet(accrual, facts);
        if (Math.abs(actual - expected) > RECONCILE_TOLERANCE_CENTS) {
          kind = actual < expected ? 'over_reversed' : facts.refundedCents > 0 ? 'refund_not_reversed' : 'net_mismatch';
        }
      }
    }

    checkedInvoices += 1;
    expectedTotal += expected;
    actualTotal += actual;
    if (kind) {
      discrepancies.push({
        kind,
        invoiceId: sample.invoiceId,
        referredUserId: sample.referredUserId,
        referrerId: sample.referrerId,
        payoutMonth: sample.payoutMonth,
        expectedCommissionCents: expected,
        actualCommissionCents: actual,
        differenceCents: actual - expected,
      });
    }
  }

  const byKind: Partial<Record<DiscrepancyKind, number>> = {};
  for (const d of discrepancies) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  return { checkedInvoices, discrepancies, totals: { actualCommissionCents: actualTotal, expectedCommissionCents: expectedTotal, byKind } };
}
