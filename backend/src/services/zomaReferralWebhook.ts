/**
 * ENG-3132 slice B5 — Stripe webhook entry points for Zoma referral commission.
 *
 * Dark: every entry returns at once unless ZOMA_REFERRAL_ENABLED is exactly `true` and its values are
 * valid. Store and Stripe failures THROW so the webhook answers 5xx and Stripe retries; accrual and
 * reversal are idempotent per invoice / credit note, so a retry or the duplicate `invoice.payment_succeeded`
 * never pays twice. `unsafe` results are logged at error level for an operator, never dropped.
 *
 * Takes `isZomaPlanObject` as an argument instead of importing mcp/zomaBilling, which imports this file.
 */
import type Stripe from 'stripe';
import { userDb } from './db';
import { createStripeClient } from './stripeClientFactory';
import { accrueReferralCommission, type AccrualDeps, type AccrualInvoice } from './zomaReferralAccrual';
import { getZomaReferralLedgerStore } from './zomaReferralLedger';
import { getZomaReferralConfig, getZomaReferralStore } from './zomaReferralRegistry';
import { reverseReferralCommission, type CreditNoteLike } from './zomaReferralReversal';

export interface ZomaReferralWebhookHandler {
  onInvoicePaid(invoice: AccrualInvoice): Promise<void>;
  onCreditNoteCreated(creditNote: CreditNoteLike): Promise<void>;
}

/** The current trial-fee price plus any retired ones (comma separated), so old fee lines never earn. */
export function trialFeePriceIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const ids = [env.ZOMA_STRIPE_TRIAL_FEE_PRICE_ID, ...(env.ZOMA_STRIPE_TRIAL_FEE_PRICE_IDS_HISTORICAL ?? '').split(',')];
  return [...new Set(ids.map((i) => i?.trim()).filter((i): i is string => !!i))];
}

let stripeClient: Stripe | null = null;
function stripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY).');
    stripeClient = createStripeClient(key);
  }
  return stripeClient;
}

const productionAccrualDeps = (): AccrualDeps => ({
  config: getZomaReferralConfig(),
  registry: getZomaReferralStore(),
  ledger: getZomaReferralLedgerStore(),
  feePriceIds: trialFeePriceIds(),
  async getReferredUser(userId) {
    const user = await userDb.getUserById(userId);
    return user ? { signupRef: user.signupRef, createdAt: user.createdAt } : null;
  },
  async listPaidInvoices(customerId) {
    return (await stripe().invoices.list({ customer: customerId, status: 'paid', limit: 100 }).autoPagingToArray({ limit: 1000 })) as unknown as AccrualInvoice[];
  },
  now: () => new Date(),
});

export function createZomaReferralWebhookHandler(opts: {
  isZomaPlanObject: (obj: unknown) => boolean;
  accrualDeps?: () => AccrualDeps;
  retrieveInvoice?: (invoiceId: string) => Promise<Stripe.Invoice>;
}): ZomaReferralWebhookHandler {
  const accrualDeps = opts.accrualDeps ?? productionAccrualDeps;
  const retrieveInvoice = opts.retrieveInvoice ?? ((id: string) => stripe().invoices.retrieve(id));

  return {
    async onInvoicePaid(invoice) {
      if (!getZomaReferralConfig().enabled) return;
      const result = await accrueReferralCommission(invoice, accrualDeps());
      if (result.status === 'unsafe') {
        console.error(`[ZOMA-REFERRAL] unsafe invoice ${invoice.id}: ${result.reason} (at ${result.invoiceId}); commission NOT recorded`);
      } else if (result.status === 'accrued') {
        console.log(`[ZOMA-REFERRAL] accrued ${result.entry.commissionCents}c on ${invoice.id} for referrer ${result.entry.referrerId}`);
      }
    },

    async onCreditNoteCreated(creditNote) {
      if (!getZomaReferralConfig().enabled) return;
      const invoiceId = typeof creditNote.invoice === 'string' ? creditNote.invoice : creditNote.invoice.id;
      const invoice = await retrieveInvoice(invoiceId);
      if (!opts.isZomaPlanObject(invoice)) return; // an Emma invoice: not ours
      const deps = accrualDeps();
      const result = await reverseReferralCommission(creditNote, {
        ledger: deps.ledger,
        feePriceIds: deps.feePriceIds,
        getInvoice: async () => ({
          userId: invoice.parent?.subscription_details?.metadata?.userId,
          lines: invoice.lines,
        }),
      });
      if (result.status === 'unsafe') {
        console.error(`[ZOMA-REFERRAL] unsafe credit note ${creditNote.id}: ${result.reason}; reversal NOT recorded`);
      } else if (result.status === 'reversed') {
        console.log(`[ZOMA-REFERRAL] reversed ${result.entry.commissionCents}c on ${invoiceId}${result.clamped ? ' (clamped)' : ''}`);
      }
    },
  };
}
