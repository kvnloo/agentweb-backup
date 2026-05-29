/**
 * Tests for Stripe activeOffer sync — verifies that coupon/discount info from
 * a Stripe subscription is captured on the user record across all sync paths:
 *   - handleCheckoutSessionCompleted
 *   - handleSubscriptionUpdated
 *   - handleInvoicePaymentSucceeded
 *   - reconcileAllStripeUsers
 *   - syncSubscriptionFromStripe
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockRetrieve = jest.fn();
const mockList = jest.fn();

const mockStripe = {
  subscriptions: { retrieve: mockRetrieve, list: mockList },
  customers: { retrieve: jest.fn().mockResolvedValue({ deleted: false, invoice_settings: {} }) },
  paymentMethods: { list: jest.fn().mockResolvedValue({ data: [{ id: 'pm_test' }] }) },
  invoices: { list: jest.fn() },
  prices: { retrieve: jest.fn() },
};

jest.mock('stripe', () => jest.fn().mockImplementation(() => mockStripe));

const mockGetUserById = jest.fn();
const mockUpdateUser = jest.fn().mockResolvedValue(undefined);
const mockScanWithFilter = jest.fn();
const mockGetUserByEmail = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: mockGetUserById,
    getUserByEmail: mockGetUserByEmail,
    updateUser: mockUpdateUser,
    scanWithFilter: mockScanWithFilter,
  },
}));

jest.mock('../services/subscriptionService', () => ({
  getTierConfig: jest.fn().mockResolvedValue({ allowedPages: ['/'], allowedSkills: ['*'] }),
  DEFAULT_PAGES: ['/'],
}));

jest.mock('../services/paymentHistoryDb', () => ({
  paymentHistoryDb: { record: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../services/crmAutoSyncService', () => ({
  syncUserUpdateToLeadList: jest.fn(),
}));

process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
process.env.STRIPE_STARTER_PRICE_ID = 'price_starter_test';
process.env.STRIPE_COMPLETE_PRICE_ID = 'price_complete_test';

import {
  handleCheckoutSessionCompleted,
  handleSubscriptionUpdated,
  handleInvoicePaymentSucceeded,
  reconcileAllStripeUsers,
  syncSubscriptionFromStripe,
} from '../services/stripeService';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDiscount(overrides: Partial<any> = {}) {
  return {
    coupon: {
      id: 'coup_90off_6mo',
      name: '90% off for 6 months',
      percent_off: 90,
      amount_off: null,
      duration: 'repeating',
      duration_in_months: 6,
    },
    end: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 180, // ~6 months from now
    ...overrides,
  };
}

function makeSubscription(discount: any = makeDiscount()) {
  return {
    id: 'sub_test123',
    status: 'active',
    customer: 'cus_test123',
    cancel_at_period_end: false,
    current_period_end: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
    default_payment_method: 'pm_test',
    items: { data: [{ price: { id: 'price_starter_test' } }] },
    discount,
  };
}

function makeUser(overrides: Partial<any> = {}) {
  return {
    userId: 'user-abc',
    email: 'info@pmps.ai',
    stripe_customer_id: 'cus_test123',
    stripe_subscription_id: 'sub_test123',
    subscription_status: 'active',
    subscriptionType: 'Starter',
    activeOffer: null,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => jest.clearAllMocks());

describe('extractActiveOffer — via handleSubscriptionUpdated', () => {
  it('writes activeOffer when subscription has a discount', async () => {
    const discount = makeDiscount();
    const sub = makeSubscription(discount);

    mockScanWithFilter.mockResolvedValue([makeUser()]);
    mockUpdateUser.mockResolvedValue(undefined);

    await handleSubscriptionUpdated(sub);

    const call = mockUpdateUser.mock.calls[0];
    const updates = call[1];
    expect(updates.activeOffer).toMatchObject({
      couponId: 'coup_90off_6mo',
      couponName: '90% off for 6 months',
      percentOff: 90,
      amountOff: null,
      duration: 'repeating',
      durationInMonths: 6,
      endsAt: expect.any(String),
    });
  });

  it('sets activeOffer to null when subscription has no discount', async () => {
    const sub = makeSubscription(null);

    mockScanWithFilter.mockResolvedValue([makeUser({ activeOffer: { couponId: 'coup_old' } })]);
    mockUpdateUser.mockResolvedValue(undefined);

    await handleSubscriptionUpdated(sub);

    const updates = mockUpdateUser.mock.calls[0][1];
    expect(updates.activeOffer).toBeNull();
  });

  it('sets activeOffer to null when discount has no coupon', async () => {
    const sub = makeSubscription({ end: null }); // discount object but coupon stripped
    (sub as any).discount = { end: null, coupon: null };

    mockScanWithFilter.mockResolvedValue([makeUser()]);

    await handleSubscriptionUpdated(sub);

    const updates = mockUpdateUser.mock.calls[0][1];
    expect(updates.activeOffer).toBeNull();
  });
});

describe('handleCheckoutSessionCompleted — activeOffer', () => {
  it('syncs activeOffer when subscription has a discount at checkout', async () => {
    const discount = makeDiscount();
    const sub = makeSubscription(discount);

    mockRetrieve.mockResolvedValue(sub);
    mockGetUserById.mockResolvedValue(makeUser());
    mockUpdateUser.mockResolvedValue(undefined);

    const session = {
      id: 'cs_test',
      customer: 'cus_test123',
      subscription: 'sub_test123',
      metadata: { userId: 'user-abc' },
      customer_details: { email: 'info@pmps.ai' },
    };

    await handleCheckoutSessionCompleted(session);

    const updates = mockUpdateUser.mock.calls[0][1];
    expect(updates.activeOffer).toMatchObject({
      couponId: 'coup_90off_6mo',
      percentOff: 90,
      duration: 'repeating',
      durationInMonths: 6,
    });
  });

  it('sets activeOffer to null when checkout subscription has no discount', async () => {
    const sub = makeSubscription(null);

    mockRetrieve.mockResolvedValue(sub);
    mockGetUserById.mockResolvedValue(makeUser());

    const session = {
      id: 'cs_test',
      customer: 'cus_test123',
      subscription: 'sub_test123',
      metadata: { userId: 'user-abc' },
      customer_details: { email: 'info@pmps.ai' },
    };

    await handleCheckoutSessionCompleted(session);

    const updates = mockUpdateUser.mock.calls[0][1];
    expect(updates.activeOffer).toBeNull();
  });
});

describe('handleInvoicePaymentSucceeded — activeOffer', () => {
  it('syncs activeOffer when fetching subscription after payment', async () => {
    const discount = makeDiscount();
    const sub = makeSubscription(discount);

    mockScanWithFilter.mockResolvedValue([makeUser()]);
    mockRetrieve.mockResolvedValue(sub);

    const invoice = {
      customer: 'cus_test123',
      subscription: 'sub_test123',
      amount_paid: 490,
      currency: 'usd',
    };

    await handleInvoicePaymentSucceeded(invoice);

    const updates = mockUpdateUser.mock.calls[0][1];
    expect(updates.activeOffer).toMatchObject({ couponId: 'coup_90off_6mo', percentOff: 90 });
  });
});

describe('reconcileAllStripeUsers — activeOffer', () => {
  it('syncs activeOffer for a user whose subscription has a discount', async () => {
    const discount = makeDiscount();
    const sub = makeSubscription(discount);
    const user = makeUser();

    mockScanWithFilter.mockResolvedValue([user]);
    mockList.mockResolvedValue({ data: [sub] });
    mockStripe.paymentMethods.list.mockResolvedValue({ data: [{ id: 'pm_test' }] });

    const result = await reconcileAllStripeUsers();

    expect(result.fixed).toBe(1);
    const updates = mockUpdateUser.mock.calls[0][1];
    expect(updates.activeOffer).toMatchObject({ couponId: 'coup_90off_6mo', percentOff: 90 });
  });

  it('clears activeOffer when discount is removed from subscription', async () => {
    const sub = makeSubscription(null); // no discount
    const user = makeUser({ activeOffer: { couponId: 'coup_old', percentOff: 50 } });

    mockScanWithFilter.mockResolvedValue([user]);
    mockList.mockResolvedValue({ data: [sub] });
    mockStripe.paymentMethods.list.mockResolvedValue({ data: [{ id: 'pm_test' }] });

    const result = await reconcileAllStripeUsers();

    expect(result.fixed).toBe(1);
    const updates = mockUpdateUser.mock.calls[0][1];
    expect(updates.activeOffer).toBeNull();
  });
});

describe('syncSubscriptionFromStripe — activeOffer', () => {
  it('backfills activeOffer when user record has none', async () => {
    const discount = makeDiscount();
    const sub = makeSubscription(discount);
    const user = makeUser({ activeOffer: undefined });

    mockGetUserById.mockResolvedValue(user);
    mockList.mockResolvedValue({ data: [sub] });
    mockStripe.customers.retrieve.mockResolvedValue({ deleted: false, invoice_settings: { default_payment_method: 'pm_test' } });

    const result = await syncSubscriptionFromStripe('user-abc', 'cus_test123');

    expect(result).not.toBeNull();
    expect(result!.activeOffer).toMatchObject({ couponId: 'coup_90off_6mo', percentOff: 90 });
  });
});

describe('amountOff coupon variant', () => {
  it('captures amountOff instead of percentOff', async () => {
    const discount = {
      coupon: {
        id: 'coup_100off',
        name: '$100 off',
        percent_off: null,
        amount_off: 10000,
        duration: 'once',
        duration_in_months: null,
      },
      end: null,
    };
    const sub = makeSubscription(discount);

    mockScanWithFilter.mockResolvedValue([makeUser()]);

    await handleSubscriptionUpdated(sub);

    const updates = mockUpdateUser.mock.calls[0][1];
    expect(updates.activeOffer).toMatchObject({
      couponId: 'coup_100off',
      percentOff: null,
      amountOff: 10000,
      duration: 'once',
      durationInMonths: null,
      endsAt: null,
    });
  });
});
