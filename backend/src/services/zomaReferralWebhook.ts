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
import { reverseReferralCommission, voidReferralReversal, type CreditNoteLike, type ReversalInvoice } from './zomaReferralReversal';

export interface ZomaReferralWebhookHandler {
  onInvoicePaid(invoice: AccrualInvoice): Promise<void>;
  onCreditNoteCreated(creditNote: CreditNoteLike): Promise<void>;
  onCreditNoteVoided(creditNote: CreditNoteLike): Promise<void>;
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

/** Stripe sends at most 10 lines inline; page the rest so a big invoice is computed, not dropped as unsafe. */
async function withAllLines<T extends { id?: string; lines?: { data?: unknown[]; has_more?: boolean } | null }>(invoice: T): Promise<T> {
  if (!invoice.lines?.has_more || !invoice.id) return invoice;
  const data = await stripe().invoices.listLineItems(invoice.id, { limit: 100 }).autoPagingToArray({ limit: 1000 });
  return { ...invoice, lines: { data, has_more: false } };
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
    const invoices = await stripe().invoices.list({ customer: customerId, status: 'paid', limit: 100 }).autoPagingToArray({ limit: 1000 });
    return Promise.all(invoices.map((i) => withAllLines(i))) as unknown as Promise<AccrualInvoice[]>;
  },
  now: () => new Date(),
});

const isMissing = (error: unknown) => (error as { code?: string })?.code === 'resource_missing';
const invoiceIdOf = (cn: CreditNoteLike) => (typeof cn.invoice === 'string' ? cn.invoice : cn.invoice?.id);

export function createZomaReferralWebhookHandler(opts: {
  isZomaPlanObject: (obj: unknown) => boolean;
  accrualDeps?: () => AccrualDeps;
  retrieveInvoice?: (invoiceId: string) => Promise<Stripe.Invoice | AccrualInvoice>;
  listCreditNotes?: (invoiceId: string) => Promise<CreditNoteLike[]>;
}): ZomaReferralWebhookHandler {
  const accrualDeps = opts.accrualDeps ?? productionAccrualDeps;
  const retrieveInvoice = opts.retrieveInvoice ?? (async (id: string): Promise<Stripe.Invoice> => withAllLines(await stripe().invoices.retrieve(id)));
  const listCreditNotes =
    opts.listCreditNotes ?? (async (id: string) => (await stripe().creditNotes.list({ invoice: id, limit: 100 }).autoPagingToArray({ limit: 1000 })) as unknown as CreditNoteLike[]);

  const asReversalInvoice = (invoice: Stripe.Invoice | AccrualInvoice): ReversalInvoice => ({
    userId: invoice.parent?.subscription_details?.metadata?.userId ?? undefined,
    lines: invoice.lines as ReversalInvoice['lines'],
  });

  /** The invoice behind a credit note, or null when it is not a Zoma invoice (an Emma credit note is not ours). */
  async function zomaInvoiceOf(creditNote: CreditNoteLike): Promise<Stripe.Invoice | AccrualInvoice | null> {
    const invoiceId = invoiceIdOf(creditNote);
    if (!invoiceId) return null;
    try {
      const invoice = await retrieveInvoice(invoiceId);
      return opts.isZomaPlanObject(invoice) ? invoice : null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async function reverse(creditNote: CreditNoteLike, invoice: Stripe.Invoice | AccrualInvoice) {
    const deps = accrualDeps();
    const result = await reverseReferralCommission(creditNote, { ledger: deps.ledger, feePriceIds: deps.feePriceIds, getInvoice: async () => asReversalInvoice(invoice) });
    if (result.status === 'unsafe') console.error(`[ZOMA-REFERRAL] unsafe credit note ${creditNote.id}: ${result.reason}; reversal NOT recorded`);
    else if (result.status === 'reversed') console.log(`[ZOMA-REFERRAL] reversed ${result.entry.commissionCents}c on ${invoiceIdOf(creditNote)}${result.clamped ? ' (clamped)' : ''}`);
    else if (result.status === 'no_accrual') console.warn(`[ZOMA-REFERRAL] credit note ${creditNote.id} has no accrual yet; it is applied when the invoice accrues`);
  }

  return {
    async onInvoicePaid(invoice) {
      if (!getZomaReferralConfig().enabled) return;
      const full = await withAllLines(invoice);
      const result = await accrueReferralCommission(full, accrualDeps());
      if (result.status === 'unsafe') {
        console.error(`[ZOMA-REFERRAL] unsafe invoice ${invoice.id}: ${result.reason} (at ${result.invoiceId}); commission NOT recorded`);
        return;
      }
      if (result.status === 'accrued') console.log(`[ZOMA-REFERRAL] accrued ${result.entry.commissionCents}c on ${invoice.id} for referrer ${result.entry.referrerId}`);
      // Credit notes that arrived before this accrual (out-of-order events, pre-payment notes) found nothing to
      // reverse; apply them now. Reversal is idempotent per credit note, so a retry or a replay is a no-op.
      if (result.status === 'accrued' || (result.status === 'skipped' && result.reason === 'already_recorded')) {
        for (const note of await listCreditNotes(invoice.id)) await reverse(note, full);
      }
    },

    async onCreditNoteCreated(creditNote) {
      if (!getZomaReferralConfig().enabled) return;
      const invoice = await zomaInvoiceOf(creditNote);
      if (invoice) await reverse(creditNote, invoice);
    },

    async onCreditNoteVoided(creditNote) {
      if (!getZomaReferralConfig().enabled) return;
      const invoice = await zomaInvoiceOf(creditNote);
      if (!invoice) return;
      const result = await voidReferralReversal(creditNote, { ledger: accrualDeps().ledger, getInvoice: async () => asReversalInvoice(invoice) });
      if (result.status === 'unsafe') console.error(`[ZOMA-REFERRAL] unsafe voided credit note ${creditNote.id}: ${result.reason}`);
      else if (result.status === 'voided') console.log(`[ZOMA-REFERRAL] cancelled the reversal of credit note ${creditNote.id}`);
    },
  };
}
