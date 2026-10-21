/**
 * ENG-2599 — the invoice fields `utils/stripeInvoiceFields` reads, against Stripe's own `stripe-mock`.
 *
 * Opt-in: runs only when STRIPE_API_BASE points at a stripe-mock whose bundled OpenAPI spec matches the
 * pinned API version (`STRIPE_API_VERSION`, 2025-05-28.basil, is what stripe-mock v0.195.0 bundles):
 *   docker run -d --rm --name smock -p 127.0.0.1:12111:12111 stripe/stripe-mock:v0.195.0
 *   STRIPE_API_BASE=http://127.0.0.1:12111 npx jest src/__tests__/stripeInvoiceFields.stripeMock.test.ts
 *   docker stop smock
 * Otherwise the suite is skipped, so CI never needs it. No Stripe account, key or network: the key is a
 * dummy and `createStripeClient` refuses STRIPE_API_BASE under NODE_ENV=production.
 *
 * What it proves: on Stripe's own Basil invoice fixture the legacy fields are gone (`invoice.subscription`,
 * `line.price`), the new ones exist where the helper reads them (`parent.subscription_details.subscription`
 * as an id or, expanded, an object; `line.pricing`), and the real paid-invoice handler resolves the
 * subscription from that payload and syncs it from stripe-mock's subscription fixture.
 * It also covers the Basil `discounts` move found while fixing ENG-2599: a subscription retrieved or
 * listed with the `discounts` / `data.discounts` expansion has a `discounts` array and no `discount`, a
 * Discount embeds `coupon` directly (no `source` wrapper in this version), and the real subscription
 * handler turns such a discount into the same activeOffer shape as before.
 * What it cannot prove: Stripe's behaviour — stripe-mock is stateless, its line fixture omits the
 * optional `pricing.price_details` (whose `price: string` comes from the SDK type,
 * stripe/types/InvoiceLineItems.d.ts `Pricing.PriceDetails`), its subscription fixture has no discounts
 * (`discounts: []`), and it does not validate `expand` paths on reads. So the Discount shape comes from
 * the discount fixture `DELETE /v1/subscriptions/:id/discount` returns, placed on the fixture subscription.
 */
import type Stripe from 'stripe';

const UPSTREAM = process.env.STRIPE_API_BASE;
const suite = UPSTREAM ? describe : describe.skip;

jest.mock('../services/db', () => ({
  userDb: { scanWithFilter: jest.fn(), updateUser: jest.fn(), getUserById: jest.fn() },
  orgDb: {},
}));
jest.mock('../services/paymentHistoryDb', () => ({ paymentHistoryDb: { record: jest.fn() } }));
jest.mock('../services/crmAutoSyncService', () => ({ syncUserUpdateToLeadList: jest.fn() }));
jest.mock('../services/waitlistDb', () => ({ waitlistDb: {} }));
jest.mock('../services/subscriptionService', () => ({ getTierConfig: jest.fn(), DEFAULT_PAGES: [] }));

process.env.STRIPE_SECRET_KEY = 'sk_test_123';

import { createStripeClient } from '../services/stripeClientFactory';
import { handleInvoicePaymentSucceeded, handleSubscriptionUpdated } from '../services/stripeService';
import { userDb } from '../services/db';
import { invoiceLinePriceId, invoiceSubscriptionId } from '../utils/stripeInvoiceFields';

suite('ENG-2599 Basil invoice fields on stripe-mock', () => {
  let stripe: Stripe;

  beforeAll(() => {
    stripe = createStripeClient('sk_test_123');
  });

  it('a Basil invoice has no top-level subscription; the helper reads parent.subscription_details', async () => {
    const invoice = await stripe.invoices.retrieve('in_123');
    const raw = invoice as unknown as Record<string, unknown>;

    expect(raw).not.toHaveProperty('subscription');
    const subscription = invoice.parent?.subscription_details?.subscription;
    expect(typeof subscription).toBe('string');
    expect(invoiceSubscriptionId(invoice)).toBe(subscription);
  });

  it('an expanded parent subscription is read as its id', async () => {
    const invoice = await stripe.invoices.retrieve('in_123', { expand: ['parent.subscription_details.subscription'] });
    const expanded = invoice.parent?.subscription_details?.subscription as Stripe.Subscription;

    expect(expanded).toEqual(expect.objectContaining({ object: 'subscription', id: expect.any(String) }));
    expect(invoiceSubscriptionId(invoice)).toBe(expanded.id);
  });

  it('a Basil line item has no price; it carries pricing (the helper finds no legacy price to misread)', async () => {
    const invoice = await stripe.invoices.retrieve('in_123');
    const line = invoice.lines.data[0];

    expect(line as unknown as Record<string, unknown>).not.toHaveProperty('price');
    expect(line.pricing).toEqual(expect.objectContaining({ type: 'price_details' }));
    expect(invoiceLinePriceId(line)).toBe(line.pricing?.price_details?.price ?? null);
  });

  it('the paid-invoice handler backfills the subscription from the raw Basil payload and syncs it', async () => {
    const invoice = await stripe.invoices.retrieve('in_123');
    const customer = invoice.customer as string;
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
      { userId: 'u1', email: 'owner@example.com', stripe_customer_id: customer, stripe_subscription_id: null },
    ]);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleInvoicePaymentSucceeded(invoice);

    const update = (userDb.updateUser as jest.Mock).mock.calls[0][1];
    expect(update.stripe_subscription_id).toBe(invoice.parent?.subscription_details?.subscription);
    // The sync ran (no sync-failure warning). stripe-mock accepts any expand path on reads, so this does
    // not validate `discounts` as an expansion; that rests on the SDK docs (Subscriptions.d.ts `discounts`).
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('period_end sync'));
    expect(update.current_period_end).toEqual(expect.any(String));
  });

  it('Basil subscription: `discounts` array (expanded or listed), no legacy `discount`', async () => {
    const retrieved = await stripe.subscriptions.retrieve('sub_123', { expand: ['discounts'] });
    const listed = await stripe.subscriptions.list({ customer: 'cus_123', status: 'all', limit: 10, expand: ['data.discounts'] });

    for (const sub of [retrieved, ...listed.data]) {
      expect(sub as unknown as Record<string, unknown>).not.toHaveProperty('discount');
      expect(Array.isArray(sub.discounts)).toBe(true);
    }
  });

  it('Basil Discount embeds `coupon` (no `source`), and becomes the same activeOffer shape', async () => {
    const deleted = await stripe.subscriptions.deleteDiscount('sub_123');
    const raw = deleted as unknown as Record<string, unknown>;
    expect(raw).not.toHaveProperty('source');
    expect(deleted.coupon).toEqual(expect.objectContaining({ object: 'coupon', id: expect.any(String), duration: expect.any(String) }));

    const { deleted: _deleted, ...live } = deleted;
    void _deleted;
    const sub = await stripe.subscriptions.retrieve('sub_123', { expand: ['discounts'] });
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
      { userId: 'u1', email: 'owner@example.com', stripe_customer_id: sub.customer, stripe_subscription_id: sub.id },
    ]);
    (userDb.updateUser as jest.Mock).mockClear();

    await handleSubscriptionUpdated({ ...sub, discounts: [live as unknown as Stripe.Discount] });

    const update = (userDb.updateUser as jest.Mock).mock.calls[0][1];
    expect(update.activeOffer).toEqual({
      couponId: deleted.coupon.id,
      couponName: deleted.coupon.name ?? null,
      percentOff: deleted.coupon.percent_off ?? null,
      amountOff: deleted.coupon.amount_off ?? null,
      duration: deleted.coupon.duration,
      durationInMonths: deleted.coupon.duration_in_months ?? null,
      endsAt: null,
    });
  });
});
