/**
 * ENG-2599: invoice webhooks on the pinned Basil API (2025-05-28.basil).
 *
 * Basil removed `invoice.subscription` (now `invoice.parent.subscription_details.subscription`)
 * and `invoice_line_item.price` (now `line.pricing.price_details.price`). Before the fix every
 * invoice webhook read undefined for both: payment history rows had no subscription or price id,
 * the paid-invoice `stripe_subscription_id` backfill never ran, the failed-invoice history row had
 * no subscription id, and the CRM mirror lost the subscription id.
 *
 * Drives the real webhook controller and the real stripeService handlers; only the Stripe SDK,
 * DynamoDB, payment history, the lead-list sync and the CRM hook are mocked. A legacy-shaped
 * payload (webhook endpoint pinned to a pre-Basil version) must keep working.
 */
const mockSubscriptionsRetrieve = jest.fn();
const mockConstructEvent = jest.fn();

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { retrieve: mockSubscriptionsRetrieve, list: jest.fn() },
    webhooks: { constructEvent: mockConstructEvent },
    paymentMethods: { list: jest.fn() },
    customers: { retrieve: jest.fn() },
  }))
);
jest.mock('../services/db', () => ({
  userDb: { scanWithFilter: jest.fn(), updateUser: jest.fn(), getUserById: jest.fn() },
  orgDb: {},
}));
jest.mock('../services/paymentHistoryDb', () => ({ paymentHistoryDb: { record: jest.fn() } }));
jest.mock('../services/crmAutoSyncService', () => ({ syncUserUpdateToLeadList: jest.fn() }));
jest.mock('../services/crmSignalHooks', () => ({ onStripeSubscriptionEvent: jest.fn() }));
jest.mock('../services/waitlistDb', () => ({ waitlistDb: {} }));
jest.mock('../services/subscriptionService', () => ({ getTierConfig: jest.fn(), DEFAULT_PAGES: [] }));

process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake_secret';

import type { Request, Response } from 'express';
import { handleWebhook } from '../controllers/stripeController';
import { userDb } from '../services/db';
import { paymentHistoryDb } from '../services/paymentHistoryDb';
import { onStripeSubscriptionEvent } from '../services/crmSignalHooks';

const PERIOD_END = 1767225600; // 2026-01-01T00:00:00Z

/** A paid subscription invoice exactly as Basil renders it: no `subscription`, no line `price`. */
function basilInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'in_basil',
    object: 'invoice',
    customer: 'cus_1',
    status: 'paid',
    amount_paid: 2900,
    amount_due: 2900,
    currency: 'usd',
    attempt_count: 1,
    next_payment_attempt: null,
    parent: {
      type: 'subscription_details',
      quote_details: null,
      subscription_details: { metadata: {}, subscription: 'sub_basil' },
    },
    lines: {
      object: 'list',
      data: [{
        id: 'il_1',
        object: 'line_item',
        description: '1 × Pro (at $29.00 / month)',
        parent: {
          type: 'subscription_item_details',
          subscription_item_details: { subscription: 'sub_basil', subscription_item: 'si_1', proration: false },
        },
        pricing: { type: 'price_details', unit_amount_decimal: '2900', price_details: { price: 'price_pro', product: 'prod_pro' } },
      }],
    },
    ...overrides,
  };
}

/** The same invoice as a pre-Basil webhook endpoint renders it. */
function legacyInvoice() {
  const invoice: Record<string, unknown> = basilInvoice({
    id: 'in_legacy',
    subscription: 'sub_legacy',
    lines: { object: 'list', data: [{ id: 'il_1', description: 'Pro', price: { id: 'price_legacy' } }] },
  });
  delete invoice.parent;
  return invoice;
}

function res() {
  const r = { status: jest.fn(), json: jest.fn() };
  r.status.mockReturnValue(r);
  r.json.mockReturnValue(r);
  return r;
}
const req = () => ({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') }) as unknown as Request;

async function deliver(type: string, object: unknown) {
  mockConstructEvent.mockReturnValue({ id: `evt_${type}`, type, data: { object } });
  const r = res();
  await handleWebhook(req(), r as unknown as Response);
  expect(r.json).toHaveBeenCalledWith({ received: true });
  // The CRM mirror is fire-and-forget; let it settle before asserting on it.
  await new Promise((resolve) => setImmediate(resolve));
}

function givenUser(user: Record<string, unknown>) {
  (userDb.scanWithFilter as jest.Mock).mockResolvedValue([{ email: 'owner@example.com', ...user }]);
}

const historyRows = () => (paymentHistoryDb.record as jest.Mock).mock.calls.map((c) => c[0]);

describe('ENG-2599 invoice webhooks read Basil subscription and price fields', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    // Stripe returns the subscription that was asked for.
    mockSubscriptionsRetrieve.mockImplementation(async (id: string) => ({
      id,
      status: 'active',
      items: { data: [{ current_period_end: PERIOD_END, price: { id: 'price_pro' } }] },
      discounts: [],
    }));
  });

  it('paid Basil invoice, user WITHOUT stripe_subscription_id: backfills it and syncs period end', async () => {
    givenUser({ userId: 'u1', stripe_customer_id: 'cus_1', stripe_subscription_id: null });

    await deliver('invoice.paid', basilInvoice());

    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith('sub_basil', { expand: ['discounts'] });
    expect(userDb.updateUser).toHaveBeenCalledWith('u1', expect.objectContaining({
      subscription_status: 'active',
      stripe_subscription_id: 'sub_basil',
      current_period_end: new Date(PERIOD_END * 1000).toISOString(),
    }));
  });

  it('paid Basil invoice: the payment history row carries the subscription and price ids', async () => {
    givenUser({ userId: 'u1', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_basil' });

    await deliver('invoice.payment_succeeded', basilInvoice());

    expect(historyRows()).toEqual([expect.objectContaining({
      eventType: 'payment_succeeded',
      stripeInvoiceId: 'in_basil',
      stripeSubscriptionId: 'sub_basil',
      priceId: 'price_pro',
      planName: '1 × Pro (at $29.00 / month)',
    })]);
  });

  it('paid Basil invoice: the CRM mirror carries the subscription id', async () => {
    givenUser({ userId: 'u1', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_basil' });

    await deliver('invoice.paid', basilInvoice());

    expect(onStripeSubscriptionEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'invoice.paid',
      stripeSubscriptionId: 'sub_basil',
    }));
  });

  it('a user who already has a subscription keeps it authoritative (no backfill, its period end is synced)', async () => {
    givenUser({ userId: 'u1', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_current' });

    // e.g. the final invoice of an older, replaced subscription
    await deliver('invoice.paid', basilInvoice({
      parent: { type: 'subscription_details', quote_details: null, subscription_details: { metadata: {}, subscription: 'sub_old' } },
    }));

    expect(mockSubscriptionsRetrieve).toHaveBeenCalledTimes(1);
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith('sub_current', expect.anything());
    const update = (userDb.updateUser as jest.Mock).mock.calls[0][1];
    expect(update.stripe_subscription_id).toBeUndefined();
  });

  it('failed Basil invoice: both payment history rows carry the subscription id', async () => {
    givenUser({ userId: 'u1', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_basil' });

    await deliver('invoice.payment_failed', basilInvoice({ status: 'open', amount_paid: 0 }));

    expect(userDb.updateUser).toHaveBeenCalledWith('u1', { subscription_status: 'past_due' });
    const rows = historyRows();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual([
      expect.objectContaining({ eventType: 'payment_failed', status: 'failed', stripeSubscriptionId: 'sub_basil' }),
      expect.objectContaining({ eventType: 'payment_failed', stripeSubscriptionId: 'sub_basil', priceId: 'price_pro' }),
    ]);
  });

  it('a non-subscription invoice (null parent) records no subscription and backfills nothing', async () => {
    givenUser({ userId: 'u1', stripe_customer_id: 'cus_1', stripe_subscription_id: null });

    await deliver('invoice.paid', basilInvoice({ parent: null }));

    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect((userDb.updateUser as jest.Mock).mock.calls[0][1].stripe_subscription_id).toBeUndefined();
    expect(historyRows()[0].stripeSubscriptionId).toBeUndefined();
  });

  it('legacy-shaped payload (pre-Basil webhook endpoint) still works end to end', async () => {
    givenUser({ userId: 'u1', stripe_customer_id: 'cus_1', stripe_subscription_id: null });

    await deliver('invoice.payment_succeeded', legacyInvoice());

    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith('sub_legacy', expect.anything());
    expect(userDb.updateUser).toHaveBeenCalledWith('u1', expect.objectContaining({ stripe_subscription_id: 'sub_legacy' }));
    expect(historyRows()).toEqual([expect.objectContaining({
      stripeInvoiceId: 'in_legacy',
      stripeSubscriptionId: 'sub_legacy',
      priceId: 'price_legacy',
    })]);
    expect(onStripeSubscriptionEvent).toHaveBeenCalledWith(expect.objectContaining({ stripeSubscriptionId: 'sub_legacy' }));
  });

  it('legacy-shaped failed invoice still records the subscription id', async () => {
    givenUser({ userId: 'u1', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_legacy' });

    await deliver('invoice.payment_failed', legacyInvoice());

    expect(historyRows().map((r) => r.stripeSubscriptionId)).toEqual(['sub_legacy', 'sub_legacy']);
  });
});
