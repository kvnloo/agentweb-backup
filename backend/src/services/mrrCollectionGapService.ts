/**
 * MRR collection gap detector — diffs "should be collecting" against
 * "actually collecting" per Stripe subscription, so a leak like the
 * August 2026 audit's Story With AI / Corgi / PMPS trio surfaces on a
 * schedule instead of by hand.
 *
 * Three independent checks, run per active/trialing/past_due subscription:
 *   1. no_payment_method       — customer has no payment method on file at all.
 *   2. zero_successful_charges — customer has never had a single paid invoice.
 *   3. below_contracted_price  — billing below the subscription's configured
 *      contracted price (sourced from `subscription.metadata.contractedPriceCents`
 *      — the only place a contracted price is recorded anywhere in this
 *      codebase today; see ENG-1265 for the note that nothing currently
 *      populates it for real subscriptions).
 *
 * Checks 1 and 2 overlap (no payment method implies no successful charge),
 * so 2 is skipped once 1 has already flagged the subscription — one flag
 * per root cause, not two for the same account.
 *
 * All monetary values are in cents.
 */
import Stripe from 'stripe';
import { createStripeClient } from './stripeClientFactory';
import { getMonthlyAmount } from './revenueService';

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('Missing STRIPE_SECRET_KEY');
    _stripe = createStripeClient(key);
  }
  return _stripe;
}

export type MrrGapReason =
  | 'no_payment_method'
  | 'zero_successful_charges'
  | 'below_contracted_price';

export interface MrrGapFlag {
  customerId: string;
  customerEmail: string | null;
  subscriptionId: string;
  reason: MrrGapReason;
  /** The amount this subscription should be collecting, in cents. */
  contractedAmountCents: number;
  /** The amount actually being collected today, in cents. */
  actualAmountCents: number;
  detail: string;
}

// Subscriptions in these states are the ones that should be collecting money
// right now. `canceled`/`incomplete_expired`/etc are not live obligations.
const LIVE_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set([
  'active',
  'trialing',
  'past_due',
]);

async function fetchLiveSubscriptions(): Promise<Stripe.Subscription[]> {
  const stripe = getStripe();
  const subs: Stripe.Subscription[] = [];
  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const params: Stripe.SubscriptionListParams = {
      limit: 100,
      status: 'all',
      expand: ['data.items.data.price', 'data.customer', 'data.discounts'],
    };
    if (startingAfter) params.starting_after = startingAfter;

    const page = await stripe.subscriptions.list(params);
    subs.push(...page.data);
    hasMore = page.has_more;
    if (page.data.length > 0) {
      startingAfter = page.data[page.data.length - 1].id;
    }
  }

  return subs.filter(s => LIVE_STATUSES.has(s.status));
}

function hasPaymentMethodOnFile(customer: Stripe.Customer): boolean {
  return Boolean(customer.invoice_settings?.default_payment_method || customer.default_source);
}

async function hasEverSuccessfullyPaid(customerId: string): Promise<boolean> {
  const stripe = getStripe();
  const invoices = await stripe.invoices.list({ customer: customerId, status: 'paid', limit: 1 });
  return invoices.data.length > 0;
}

function getContractedPriceCents(sub: Stripe.Subscription): number | null {
  const raw = sub.metadata?.contractedPriceCents;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Diff every live subscription's contracted collection against what it is
 * actually collecting today. Returns one flag per subscription with a
 * detected gap; a healthy subscription produces no flag.
 */
export async function detectMrrCollectionGaps(
  toleranceCents: number = 100
): Promise<MrrGapFlag[]> {
  const subs = await fetchLiveSubscriptions();
  const flags: MrrGapFlag[] = [];

  for (const sub of subs) {
    const customer = sub.customer as Stripe.Customer;
    if (!customer || typeof customer === 'string' || customer.deleted) continue;

    const contractedAmount = getMonthlyAmount(sub);
    const customerEmail = customer.email ?? null;
    const customerLabel = customerEmail ?? customer.id;
    const base = {
      customerId: customer.id,
      customerEmail,
      subscriptionId: sub.id,
    };

    if (!hasPaymentMethodOnFile(customer)) {
      flags.push({
        ...base,
        reason: 'no_payment_method',
        contractedAmountCents: contractedAmount,
        actualAmountCents: 0,
        detail: `${customerLabel} has an active paid subscription (${sub.id}) with no payment method on file.`,
      });
      continue; // implies zero successful charges too — one flag, not two
    }

    if (!(await hasEverSuccessfullyPaid(customer.id))) {
      flags.push({
        ...base,
        reason: 'zero_successful_charges',
        contractedAmountCents: contractedAmount,
        actualAmountCents: 0,
        detail: `${customerLabel} has a payment method on file but has never had a successful invoice payment on subscription ${sub.id}.`,
      });
      continue;
    }

    const contractedPriceCents = getContractedPriceCents(sub);
    if (contractedPriceCents !== null && contractedAmount < contractedPriceCents - toleranceCents) {
      flags.push({
        ...base,
        reason: 'below_contracted_price',
        contractedAmountCents: contractedPriceCents,
        actualAmountCents: contractedAmount,
        detail: `${customerLabel} is billing $${(contractedAmount / 100).toFixed(2)}/mo on subscription ${sub.id}, below its configured contracted price of $${(contractedPriceCents / 100).toFixed(2)}/mo.`,
      });
    }
  }

  return flags;
}
