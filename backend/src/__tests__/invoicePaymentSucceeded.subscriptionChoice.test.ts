/**
 * ENG-2599: which subscription a paid invoice syncs current_period_end / activeOffer from.
 *
 * Once the invoice's subscription is read correctly (Basil `parent.subscription_details`), it can differ
 * from the stored `stripe_subscription_id`:
 *   - resubscribe race: the stored id is the customer's canceled sub, and `invoice.paid` for the new sub
 *     arrives before checkout.session.completed / customer.subscription.created. Syncing the stored sub
 *     would write its ended period and wipe the new sub's offer, so the invoice's live sub is used;
 *   - an older, replaced sub's final invoice while the stored sub is current and live: the stored sub
 *     stays authoritative (and the old sub is never fetched);
 *   - two live subs on one customer (e.g. a custom subscription link): the stored one stays authoritative.
 * `stripe_subscription_id` itself is only ever backfilled when absent. Adapted from the PR #3680 review.
 */
const mockRetrieve = jest.fn();

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { retrieve: mockRetrieve, list: jest.fn() },
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
jest.mock('../services/waitlistDb', () => ({ waitlistDb: {} }));
jest.mock('../services/subscriptionService', () => ({ getTierConfig: jest.fn(), DEFAULT_PAGES: [] }));

process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key';

import { handleInvoicePaymentSucceeded } from '../services/stripeService';
import { userDb } from '../services/db';

const OLD_END = 1760000000; // 2025-10-09, ended
const NEW_END = 1790000000; // 2026-09-21
const OTHER_END = 1795000000;

const coupon = (id: string) => ({ id, object: 'coupon', name: id, percent_off: 50, amount_off: null, duration: 'repeating', duration_in_months: 3 });
const disc = (id: string, couponId: string) => ({ id, object: 'discount', coupon: coupon(couponId), end: null, start: 0 });
const sub = (id: string, status: string, end: number, discounts: unknown[] = []) => ({
  id, object: 'subscription', status, items: { data: [{ current_period_end: end, price: { id: 'price_pro' } }] }, discounts,
});

const subs: Record<string, ReturnType<typeof sub>> = {
  sub_old: sub('sub_old', 'canceled', OLD_END),
  sub_old_unpaid: sub('sub_old_unpaid', 'incomplete_expired', OLD_END + 86400),
  sub_new: sub('sub_new', 'active', NEW_END, [disc('di_new', 'coup_new')]),
  sub_trial: sub('sub_trial', 'trialing', NEW_END),
  sub_past_due: sub('sub_past_due', 'past_due', NEW_END),
  sub_other_live: sub('sub_other_live', 'active', OTHER_END, [disc('di_other', 'coup_other')]),
};

function basilInvoice(subscription: string | null) {
  return {
    id: 'in_1', object: 'invoice', customer: 'cus_1', status: 'paid', amount_paid: 2900, currency: 'usd',
    parent: subscription
      ? { type: 'subscription_details', quote_details: null, subscription_details: { metadata: {}, subscription } }
      : null,
  };
}
const givenUser = (stripe_subscription_id: string | null) =>
  (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
    { email: 'owner@example.com', userId: 'u1', stripe_customer_id: 'cus_1', stripe_subscription_id },
  ]);
const update = () => (userDb.updateUser as jest.Mock).mock.calls[0][1];
const retrievedIds = () => mockRetrieve.mock.calls.map((c) => c[0]);
const iso = (epoch: number) => new Date(epoch * 1000).toISOString();

let warn: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockRetrieve.mockImplementation(async (id: string) => {
    if (!subs[id]) throw new Error(`No such subscription: ${id}`);
    return subs[id];
  });
});

describe('handleInvoicePaymentSucceeded — which subscription is synced', () => {
  it('resubscribe race: stored sub canceled, invoice sub live ⇒ syncs the invoice sub, stored id untouched', async () => {
    givenUser('sub_old');

    await handleInvoicePaymentSucceeded(basilInvoice('sub_new'));

    expect(retrievedIds()).toEqual(['sub_old', 'sub_new']);
    expect(mockRetrieve).toHaveBeenCalledWith('sub_new', { expand: ['discounts'] });
    expect(update().current_period_end).toBe(iso(NEW_END));
    expect(update().activeOffer).toMatchObject({ couponId: 'coup_new' });
    expect(update()).not.toHaveProperty('stripe_subscription_id');
  });

  it.each([['trialing', 'sub_trial'], ['past_due', 'sub_past_due']])(
    'resubscribe race: an invoice sub that is %s counts as live',
    async (_status, invoiceSub) => {
      givenUser('sub_old');

      await handleInvoicePaymentSucceeded(basilInvoice(invoiceSub));

      expect(update().current_period_end).toBe(iso(NEW_END));
    }
  );

  it('old replaced sub final invoice: stored sub is current and live ⇒ stored synced, old sub never fetched', async () => {
    givenUser('sub_new');

    await handleInvoicePaymentSucceeded(basilInvoice('sub_old'));

    expect(retrievedIds()).toEqual(['sub_new']);
    expect(update().current_period_end).toBe(iso(NEW_END));
    expect(update().activeOffer).toMatchObject({ couponId: 'coup_new' });
  });

  it('two live subs on one customer: the stored one stays authoritative', async () => {
    givenUser('sub_new');

    await handleInvoicePaymentSucceeded(basilInvoice('sub_other_live'));

    expect(retrievedIds()).toEqual(['sub_new']);
    expect(update().activeOffer).toMatchObject({ couponId: 'coup_new' });
  });

  it('stored sub not live and the invoice sub not live either ⇒ stored synced (as before)', async () => {
    givenUser('sub_old');

    await handleInvoicePaymentSucceeded(basilInvoice('sub_old_unpaid'));

    expect(retrievedIds()).toEqual(['sub_old', 'sub_old_unpaid']);
    expect(update().current_period_end).toBe(iso(OLD_END));
  });

  it('equal ids ⇒ exactly one retrieve', async () => {
    givenUser('sub_new');

    await handleInvoicePaymentSucceeded(basilInvoice('sub_new'));

    expect(retrievedIds()).toEqual(['sub_new']);
    expect(update().current_period_end).toBe(iso(NEW_END));
  });

  it('equal ids on a canceled sub ⇒ still exactly one retrieve', async () => {
    givenUser('sub_old');

    await handleInvoicePaymentSucceeded(basilInvoice('sub_old'));

    expect(retrievedIds()).toEqual(['sub_old']);
  });

  it('invoice-sub retrieve fails ⇒ falls back to the stored sub (as before), with a warning', async () => {
    givenUser('sub_old');

    await handleInvoicePaymentSucceeded(basilInvoice('sub_missing'));

    expect(retrievedIds()).toEqual(['sub_old', 'sub_missing']);
    expect(update().current_period_end).toBe(iso(OLD_END));
    expect(update().subscription_status).toBe('active');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch invoice subscription sub_missing'));
  });

  it('stored-sub retrieve fails ⇒ no period-end sync, status still active (as before)', async () => {
    givenUser('sub_gone');

    await handleInvoicePaymentSucceeded(basilInvoice('sub_new'));

    expect(retrievedIds()).toEqual(['sub_gone']);
    expect(update()).not.toHaveProperty('current_period_end');
    expect(update().subscription_status).toBe('active');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('for period_end sync'));
  });

  it('no stored id ⇒ backfills from the invoice and syncs it with one retrieve', async () => {
    givenUser(null);

    await handleInvoicePaymentSucceeded(basilInvoice('sub_new'));

    expect(retrievedIds()).toEqual(['sub_new']);
    expect(update().stripe_subscription_id).toBe('sub_new');
    expect(update().current_period_end).toBe(iso(NEW_END));
  });

  it('non-subscription invoice (parent null) ⇒ stored sub synced, nothing backfilled', async () => {
    givenUser('sub_new');

    await handleInvoicePaymentSucceeded(basilInvoice(null));

    expect(retrievedIds()).toEqual(['sub_new']);
    expect(update()).not.toHaveProperty('stripe_subscription_id');
  });
});
