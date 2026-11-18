/**
 * ENG-3132 slice D: read-only referral ledger vs Stripe reconcile. Never writes to the ledger or Stripe.
 *
 *   cd backend
 *   STRIPE_SECRET_KEY=... npx ts-node --transpile-only src/scripts/zomaReferralReconcile.ts [--month YYYY-MM]
 *
 * Reads the ledger table of the environment it runs against (TABLE_PREFIX / AWS credentials as for any
 * script). Exit 0 = clean, 1 = discrepancies found, 2 = could not run. Prints ids and amounts only.
 */
import type Stripe from 'stripe';
import { createStripeClient } from '../services/stripeClientFactory';
import { getZomaReferralLedgerStore } from '../services/zomaReferralLedger';
import { reconcileReferralLedger, type InvoiceFacts } from '../services/zomaReferralReconcile';

const isMissing = (error: unknown) => (error as { code?: string })?.code === 'resource_missing';

export function invoiceFactsFrom(stripe: Stripe) {
  return async (invoiceId: string): Promise<InvoiceFacts | null> => {
    let invoice: Stripe.Invoice;
    try {
      invoice = await stripe.invoices.retrieve(invoiceId);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    // Invoice -> its payments -> refunds on each payment. A refund made on the charge has no credit note,
    // so only the payment's own refund list sees it.
    const refunds = new Map<string, Stripe.Refund>();
    for (const p of await stripe.invoicePayments.list({ invoice: invoiceId, limit: 100 }).autoPagingToArray({ limit: 100 })) {
      const ref = p.payment.type === 'payment_intent' ? { payment_intent: idOf(p.payment.payment_intent) } : { charge: idOf(p.payment.charge) };
      if (!Object.values(ref)[0]) continue;
      for (const r of await stripe.refunds.list({ ...ref, limit: 100 }).autoPagingToArray({ limit: 1000 })) refunds.set(r.id, r);
    }
    const refundedCents = [...refunds.values()].filter((r) => r.status === 'succeeded').reduce((sum, r) => sum + r.amount, 0);
    return { status: invoice.status, amountPaidCents: invoice.amount_paid, refundedCents };
  };
}

const idOf = (v: string | { id: string } | undefined | null) => (typeof v === 'string' ? v : v?.id);

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is required');
  const monthIdx = process.argv.indexOf('--month');
  const month = monthIdx > -1 ? process.argv[monthIdx + 1] : undefined;
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('--month must look like 2026-12');

  const report = await reconcileReferralLedger({ ledger: getZomaReferralLedgerStore(), getInvoiceFacts: invoiceFactsFrom(createStripeClient(key)) }, { month });

  const dollars = (c: number) => (c / 100).toFixed(2);
  console.log(`checked ${report.checkedInvoices} invoice(s)${month ? ` for ${month}` : ''}; ${report.discrepancies.length} discrepancy(ies)`);
  for (const d of report.discrepancies) {
    console.log(`${d.kind.padEnd(30)} ${d.invoiceId.padEnd(28)} referrer=${d.referrerId} month=${d.payoutMonth} expected=$${dollars(d.expectedCommissionCents)} ledger=$${dollars(d.actualCommissionCents)} diff=$${dollars(d.differenceCents)}`);
  }
  console.log(JSON.stringify(report.totals));
  process.exit(report.discrepancies.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('reconcile aborted:', e?.raw?.message ?? e?.message ?? e);
    process.exit(2);
  });
}
