/**
 * Lazy Sync Additive-Only Tests
 *
 * Verifies that syncSubscriptionFromStripe() only fills NULL fields
 * and never overwrites existing (webhook-written) data in DynamoDB.
 */

// --- Mocks ---

const mockSubscriptionsList = jest.fn();
const mockCustomersRetrieve = jest.fn();
const mockPaymentMethodsList = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    subscriptions: { list: mockSubscriptionsList },
    customers: { retrieve: mockCustomersRetrieve },
    paymentMethods: { list: mockPaymentMethodsList },
  }));
});

const mockGetUserById = jest.fn();
const mockUpdateUser = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: mockGetUserById,
    getUserByEmail: jest.fn(),
    updateUser: mockUpdateUser,
    getAllUsers: jest.fn(),
    scanWithFilter: jest.fn(),
  },
  User: {},
}));

jest.mock('../services/waitlistDb', () => ({
  waitlistDb: { getByEmail: jest.fn(), updateDetails: jest.fn(), add: jest.fn() },
  WaitlistEntry: {},
}));

jest.mock('../services/subscriptionService', () => ({
  getTierConfig: jest.fn().mockResolvedValue({
    allowedPages: ['dashboard', 'agent'],
    allowedSkills: ['*'],
  }),
  DEFAULT_PAGES: ['dashboard'],
}));

// Set env vars before importing
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_STARTER_PRICE_ID = 'price_starter';
process.env.STRIPE_COMPLETE_PRICE_ID = 'price_complete';

import { syncSubscriptionFromStripe } from '../services/stripeService';

// Helper: build a Stripe subscription object
function makeStripeSub(overrides: Record<string, any> = {}) {
  return {
    id: 'sub_stripe_123',
    status: 'active',
    default_payment_method: 'pm_abc',
    current_period_end: 1700000000, // epoch seconds
    items: { data: [{ price: { id: 'price_complete' } }] },
    ...overrides,
  };
}

describe('syncSubscriptionFromStripe — additive-only', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPaymentMethodsList.mockResolvedValue({ data: [] });
    mockCustomersRetrieve.mockResolvedValue({ deleted: false });
  });

  // ─── Test 1: Fills null subscription_status from Stripe ───
  it('fills null subscription_status from Stripe', async () => {
    const user = {
      userId: 'user-1',
      stripe_customer_id: 'cus_1',
      subscription_status: null,
      stripe_subscription_id: null,
      subscriptionType: null,
      has_payment_method: null,
      current_period_end: null,
    };
    mockGetUserById.mockResolvedValue(user);
    mockSubscriptionsList.mockResolvedValue({ data: [makeStripeSub()] });

    const result = await syncSubscriptionFromStripe('user-1', 'cus_1');

    expect(result).not.toBeNull();
    expect(mockUpdateUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ subscription_status: 'active' })
    );
  });

  // ─── Test 2: Does NOT overwrite existing subscription_status, but DOES overwrite current_period_end ───
  it('does NOT overwrite existing subscription_status but always overwrites current_period_end', async () => {
    const user = {
      userId: 'user-2',
      stripe_customer_id: 'cus_2',
      subscription_status: 'past_due', // webhook wrote this — should be preserved
      stripe_subscription_id: 'sub_webhook_456',
      subscriptionType: 'Super Premium',
      has_payment_method: true,
      current_period_end: '2025-01-01T00:00:00.000Z', // stale — should be overwritten
    };
    mockGetUserById.mockResolvedValue(user);
    mockSubscriptionsList.mockResolvedValue({
      data: [makeStripeSub({ status: 'active' })],
    });

    const result = await syncSubscriptionFromStripe('user-2', 'cus_2');

    // current_period_end is always overwritten with Stripe's live value
    expect(result).not.toBeNull();
    const updateCall = mockUpdateUser.mock.calls[0][1];
    expect(updateCall).toHaveProperty('current_period_end');
    // subscription_status must NOT be overwritten — webhook value wins
    expect(updateCall).not.toHaveProperty('subscription_status');
  });

  // ─── Test 3: Fills null stripe_subscription_id but skips non-null ───
  it('fills null stripe_subscription_id but skips non-null', async () => {
    const user = {
      userId: 'user-3',
      stripe_customer_id: 'cus_3',
      subscription_status: 'active', // already set
      stripe_subscription_id: null,  // missing — should be filled
      subscriptionType: 'Super Premium',
      has_payment_method: true,
      current_period_end: '2025-01-01T00:00:00.000Z',
    };
    mockGetUserById.mockResolvedValue(user);
    mockSubscriptionsList.mockResolvedValue({ data: [makeStripeSub()] });

    const result = await syncSubscriptionFromStripe('user-3', 'cus_3');

    expect(result).not.toBeNull();
    expect(mockUpdateUser).toHaveBeenCalledWith(
      'user-3',
      expect.objectContaining({ stripe_subscription_id: 'sub_stripe_123' })
    );
    // Should NOT have overwritten subscription_status since it was already set
    const updateCall = mockUpdateUser.mock.calls[0][1];
    expect(updateCall).not.toHaveProperty('subscription_status');
  });

  // ─── Test 4: Full sync when ALL subscription fields are null ───
  it('does full sync when ALL subscription fields are null', async () => {
    const user = {
      userId: 'user-4',
      stripe_customer_id: 'cus_4',
      subscription_status: null,
      stripe_subscription_id: null,
      subscriptionType: null,
      has_payment_method: null,
      current_period_end: null,
    };
    mockGetUserById.mockResolvedValue(user);
    mockSubscriptionsList.mockResolvedValue({ data: [makeStripeSub()] });

    const result = await syncSubscriptionFromStripe('user-4', 'cus_4');

    expect(result).not.toBeNull();
    const updateCall = mockUpdateUser.mock.calls[0][1];
    // All fields should be written when everything is null. PR #1261 renamed
    // the derived tier for the complete/pro Stripe price from "Super Premium"
    // to "Pro" — the pricing page name the customer actually sees.
    expect(updateCall).toHaveProperty('subscription_status', 'active');
    expect(updateCall).toHaveProperty('stripe_subscription_id', 'sub_stripe_123');
    expect(updateCall).toHaveProperty('subscriptionType', 'Pro');
    expect(updateCall).toHaveProperty('has_payment_method');
    expect(updateCall).toHaveProperty('current_period_end');
  });

  // ─── Test 5: Lazy sync after webhook — webhook data preserved except current_period_end ───
  it('preserves webhook-written status/type but always refreshes current_period_end', async () => {
    // Simulate: webhook already wrote correct state
    const user = {
      userId: 'user-5',
      stripe_customer_id: 'cus_5',
      subscription_status: 'trialing',
      stripe_subscription_id: 'sub_webhook_789',
      subscriptionType: 'Basic',
      has_payment_method: false,
      current_period_end: '2025-06-01T00:00:00.000Z', // stale — always overwritten
    };
    mockGetUserById.mockResolvedValue(user);
    // Stripe API returns slightly different data (e.g., active instead of trialing)
    mockSubscriptionsList.mockResolvedValue({
      data: [makeStripeSub({
        id: 'sub_webhook_789',
        status: 'active',
        items: { data: [{ price: { id: 'price_starter' } }] },
      })],
    });

    const result = await syncSubscriptionFromStripe('user-5', 'cus_5');

    // current_period_end is always overwritten — even when set by a webhook
    expect(result).not.toBeNull();
    const updateCall = mockUpdateUser.mock.calls[0][1];
    expect(updateCall).toHaveProperty('current_period_end');
    // Webhook-written fields for status/type must NOT be touched
    expect(updateCall).not.toHaveProperty('subscription_status');
    expect(updateCall).not.toHaveProperty('subscriptionType');
  });

  // ─── Test 6: Partial null — only null fields get filled ───
  it('only fills the specific fields that are null, skips the rest', async () => {
    const user = {
      userId: 'user-6',
      stripe_customer_id: 'cus_6',
      subscription_status: 'active',         // set — skip
      stripe_subscription_id: 'sub_existing', // set — skip
      subscriptionType: null,                 // null — fill
      has_payment_method: true,               // set — skip
      current_period_end: null,               // null — fill
    };
    mockGetUserById.mockResolvedValue(user);
    mockSubscriptionsList.mockResolvedValue({ data: [makeStripeSub()] });

    const result = await syncSubscriptionFromStripe('user-6', 'cus_6');

    expect(result).not.toBeNull();
    const updateCall = mockUpdateUser.mock.calls[0][1];
    // Should only update null fields. Complete/pro price derives to "Pro"
    // since PR #1261 — the same name the pricing page surfaces to customers.
    expect(updateCall).toHaveProperty('subscriptionType', 'Pro');
    expect(updateCall).toHaveProperty('current_period_end');
    // Should NOT update already-set fields
    expect(updateCall).not.toHaveProperty('subscription_status');
    expect(updateCall).not.toHaveProperty('stripe_subscription_id');
    expect(updateCall).not.toHaveProperty('has_payment_method');
  });
});
