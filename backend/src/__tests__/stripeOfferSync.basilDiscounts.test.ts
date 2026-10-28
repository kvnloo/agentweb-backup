/**
 * ENG-2599 (Basil `discounts` move): activeOffer sync on the pinned API version 2025-05-28.basil.
 *
 * Basil removed `subscription.discount`; a subscription carries `discounts: Array<string | Stripe.Discount>`
 * (stripe/types/Subscriptions.d.ts), ids unless expanded, and a Discount embeds `coupon: Stripe.Coupon`
 * (stripe/types/Discounts.d.ts). The old code read `subscription.discount` and expanded `discount.coupon`,
 * so every offer was stored as null. Legacy-shaped coverage stays in stripeOfferSync.test.ts.
 *
 * Rules under test: the first listed entry of `discounts` wins (deterministic); the legacy `discount` is the
 * fallback when that entry is not expanded; an id-only discount in a webhook payload is fetched expanded,
 * and a failed fetch leaves activeOffer unchanged rather than clearing it.
 */
const mockRetrieve = jest.fn();
const mockList = jest.fn();

const mockStripe = {
  subscriptions: { retrieve: mockRetrieve, list: mockList },
  customers: { retrieve: jest.fn().mockResolvedValue({ deleted: false, invoice_settings: {} }) },
  paymentMethods: { list: jest.fn().mockResolvedValue({ data: [{ id: 'pm_test' }] }) },
  invoices: { list: jest.fn() },
};

jest.mock('stripe', () => jest.fn().mockImplementation(() => mockStripe));

const mockUpdateUser = jest.fn();
const mockScanWithFilter = jest.fn();
const mockGetUserById = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: (...a: unknown[]) => mockGetUserById(...a),
    updateUser: (...a: unknown[]) => mockUpdateUser(...a),
    scanWithFilter: (...a: unknown[]) => mockScanWithFilter(...a),
  },
  orgDb: {},
}));
jest.mock('../services/subscriptionService', () => ({
  getTierConfig: jest.fn().mockResolvedValue({ allowedPages: ['/'], allowedSkills: ['*'] }),
  DEFAULT_PAGES: ['/'],
}));
jest.mock('../services/paymentHistoryDb', () => ({ paymentHistoryDb: { record: jest.fn() } }));
jest.mock('../services/crmAutoSyncService', () => ({ syncUserUpdateToLeadList: jest.fn() }));
jest.mock('../services/waitlistDb', () => ({ waitlistDb: {} }));

process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_STARTER_PRICE_ID = 'price_starter_test';

import type Stripe from 'stripe';
import {
  handleCheckoutSessionCompleted,
  handleInvoicePaymentSucceeded,
  handleSubscriptionUpdated,
  reconcileStripeUser,
  syncSubscriptionFromStripe,
} from '../services/stripeService';

const END = 1782864000; // 2026-07-01T00:00:00Z

function coupon(id: string, overrides: Partial<Stripe.Coupon> = {}): Stripe.Coupon {
  return {
    id,
    object: 'coupon',
    name: `${id} name`,
    percent_off: 90,
    amount_off: null,
    duration: 'repeating',
    duration_in_months: 6,
    ...overrides,
  } as Stripe.Coupon;
}

/** A Basil Discount as `expand: ['discounts']` returns it: the coupon is embedded. */
function discount(id: string, c: Stripe.Coupon = coupon('coup_90off_6mo')): Stripe.Discount {
  return { id, object: 'discount', coupon: c, end: END, start: 0 } as Stripe.Discount;
}

/** A Basil subscription: `discounts` only, no `discount`. */
function basilSubscription(discounts: Array<string | Stripe.Discount>) {
  return {
    id: 'sub_test123',
    object: 'subscription',
    status: 'active',
    customer: 'cus_test123',
    cancel_at_period_end: false,
    default_payment_method: 'pm_test',
    items: { data: [{ current_period_end: END, price: { id: 'price_starter_test' } }] },
    discounts,
  };
}

const EXPECTED_OFFER = {
  couponId: 'coup_90off_6mo',
  couponName: 'coup_90off_6mo name',
  percentOff: 90,
  amountOff: null,
  duration: 'repeating',
  durationInMonths: 6,
  endsAt: new Date(END * 1000).toISOString(),
};

function user(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-abc',
    email: 'owner@example.com',
    stripe_customer_id: 'cus_test123',
    stripe_subscription_id: 'sub_test123',
    subscription_status: 'active',
    subscriptionType: 'Starter',
    activeOffer: null,
    ...overrides,
  };
}

// ENG-2724: status/offer and tier are written in two updates; assert the merged stored fields.
const lastUpdate = () => Object.assign({}, ...mockUpdateUser.mock.calls.map((c: unknown[]) => c[1] as object));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  mockUpdateUser.mockResolvedValue(undefined);
  mockScanWithFilter.mockResolvedValue([user()]);
  mockGetUserById.mockResolvedValue(user());
});

describe('handleSubscriptionUpdated — Basil discounts', () => {
  it('expanded discount: stores the offer with the same shape as before, no extra fetch', async () => {
    await handleSubscriptionUpdated(basilSubscription([discount('di_1')]));

    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(lastUpdate().activeOffer).toEqual(EXPECTED_OFFER);
  });

  it('id-only discount (webhook payload): fetches the subscription with discounts expanded', async () => {
    mockRetrieve.mockResolvedValue(basilSubscription([discount('di_1')]));

    await handleSubscriptionUpdated(basilSubscription(['di_1']));

    expect(mockRetrieve).toHaveBeenCalledWith('sub_test123', { expand: ['discounts'] });
    expect(lastUpdate().activeOffer).toEqual(EXPECTED_OFFER);
  });

  it('id-only discount and the fetch fails: activeOffer is left unchanged, the webhook still succeeds', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockRetrieve.mockRejectedValue(new Error('stripe down'));

    await expect(handleSubscriptionUpdated(basilSubscription(['di_1']))).resolves.toBeUndefined();

    expect(lastUpdate()).not.toHaveProperty('activeOffer');
    expect(lastUpdate().subscription_status).toBe('active');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('activeOffer left unchanged'));
  });

  it('several discounts: the first listed wins, deterministically', async () => {
    await handleSubscriptionUpdated(basilSubscription([
      discount('di_first', coupon('coup_first', { percent_off: 20 })),
      discount('di_second', coupon('coup_second', { percent_off: 50 })),
    ]));

    expect(lastUpdate().activeOffer).toMatchObject({ couponId: 'coup_first', percentOff: 20 });
  });

  it('no discount: activeOffer is cleared to null', async () => {
    mockScanWithFilter.mockResolvedValue([user({ activeOffer: { couponId: 'coup_old' } })]);

    await handleSubscriptionUpdated(basilSubscription([]));

    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(lastUpdate().activeOffer).toBeNull();
  });

  it('legacy payload (expanded `discount`, `discounts` as ids): uses the legacy discount, no fetch', async () => {
    const legacy = { ...basilSubscription(['di_1']), discount: discount('di_1') };

    await handleSubscriptionUpdated(legacy);

    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(lastUpdate().activeOffer).toEqual(EXPECTED_OFFER);
  });

  it('both shapes expanded: the Basil `discounts` list wins over the legacy single `discount`', async () => {
    await handleSubscriptionUpdated({
      ...basilSubscription([discount('di_basil', coupon('coup_basil'))]),
      discount: discount('di_legacy', coupon('coup_legacy')),
    });

    expect(lastUpdate().activeOffer).toMatchObject({ couponId: 'coup_basil' });
  });

  it('legacy payload with only `discount` (no `discounts` field) still works', async () => {
    const { discounts: _ignored, ...withoutDiscounts } = basilSubscription([]);
    void _ignored;

    await handleSubscriptionUpdated({ ...withoutDiscounts, discount: discount('di_1') });

    expect(lastUpdate().activeOffer).toEqual(EXPECTED_OFFER);
  });
});

describe('Basil discounts on the fetch-and-sync paths', () => {
  it('handleInvoicePaymentSucceeded expands `discounts` and stores the offer', async () => {
    mockRetrieve.mockResolvedValue(basilSubscription([discount('di_1')]));

    await handleInvoicePaymentSucceeded({
      customer: 'cus_test123',
      parent: { subscription_details: { subscription: 'sub_test123' } },
    });

    expect(mockRetrieve).toHaveBeenCalledWith('sub_test123', { expand: ['discounts'] });
    expect(lastUpdate().activeOffer).toEqual(EXPECTED_OFFER);
  });

  it('a fetched subscription whose discounts came back unexpanded stores null, never throws', async () => {
    mockRetrieve.mockResolvedValue(basilSubscription(['di_1']));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleInvoicePaymentSucceeded({
      customer: 'cus_test123',
      parent: { subscription_details: { subscription: 'sub_test123' } },
    });

    expect(lastUpdate().activeOffer).toBeNull();
    expect(lastUpdate().current_period_end).toBe(new Date(END * 1000).toISOString());
    expect(warn).not.toHaveBeenCalled();
  });

  it('handleCheckoutSessionCompleted expands `discounts` and stores the offer', async () => {
    mockRetrieve.mockResolvedValue(basilSubscription([discount('di_1')]));

    await handleCheckoutSessionCompleted({
      id: 'cs_test',
      customer: 'cus_test123',
      subscription: 'sub_test123',
      metadata: { userId: 'user-abc' },
      customer_details: { email: 'owner@example.com' },
    });

    expect(mockRetrieve).toHaveBeenCalledWith('sub_test123', { expand: ['discounts'] });
    expect(lastUpdate().activeOffer).toEqual(EXPECTED_OFFER);
  });

  it('reconcileStripeUser lists with `data.discounts` and stores the offer', async () => {
    mockList.mockResolvedValue({ data: [basilSubscription([discount('di_1')])] });

    await reconcileStripeUser(user());

    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ expand: ['data.discounts'] }));
    expect(lastUpdate().activeOffer).toEqual(EXPECTED_OFFER);
  });

  it('syncSubscriptionFromStripe lists with `data.discounts` and returns the offer', async () => {
    mockGetUserById.mockResolvedValue(user({ activeOffer: undefined }));
    mockList.mockResolvedValue({ data: [basilSubscription([discount('di_1')])] });

    const result = await syncSubscriptionFromStripe('user-abc', 'cus_test123');

    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ expand: ['data.discounts'] }));
    expect(result?.activeOffer).toEqual(EXPECTED_OFFER);
  });
});
