/**
 * Per-user Stripe reconcile tests.
 *
 * reconcileStripeUser() / reconcileStripeUserById() are AUTHORITATIVE — Stripe
 * wins. Unlike the additive-only syncSubscriptionFromStripe() (used by the
 * /auth/me lazy login sync), this path MUST overwrite a stale local
 * subscription_status so an admin can unstick an account whose recovery webhook
 * never landed (e.g. stuck on "past_due" while Stripe shows "active").
 */

// --- Mocks ---

const mockSubscriptionsList = jest.fn();
const mockPaymentMethodsList = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    subscriptions: { list: mockSubscriptionsList },
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

jest.mock('../services/crmAutoSyncService', () => ({
  syncUserUpdateToLeadList: jest.fn(),
}));

process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_STARTER_PRICE_ID = 'price_starter';
process.env.STRIPE_COMPLETE_PRICE_ID = 'price_complete';

import { reconcileStripeUserById } from '../services/stripeService';

function makeStripeSub(overrides: Record<string, any> = {}) {
  return {
    id: 'sub_stripe_123',
    status: 'active',
    cancel_at_period_end: false,
    default_payment_method: 'pm_abc',
    current_period_end: 1700000000,
    items: { data: [{ price: { id: 'price_complete' } }] },
    ...overrides,
  };
}

describe('reconcileStripeUserById — authoritative (Stripe wins)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPaymentMethodsList.mockResolvedValue({ data: [] });
  });

  // ─── Test 1 (the bug): overwrites a stale past_due with active ───
  it('overwrites stale past_due subscription_status when Stripe says active', async () => {
    const user = {
      userId: 'user-stuck',
      email: 'admin@rankai.ai',
      stripe_customer_id: 'cus_stuck',
      subscription_status: 'past_due', // stuck — recovery webhook never landed
      stripe_subscription_id: 'sub_stripe_123',
      subscriptionType: 'Pro',
      has_payment_method: false,
      current_period_end: '2025-01-01T00:00:00.000Z',
    };
    mockGetUserById.mockResolvedValue(user);
    mockSubscriptionsList.mockResolvedValue({ data: [makeStripeSub({ status: 'active' })] });

    const updates = await reconcileStripeUserById('user-stuck');

    expect(updates).not.toBeNull();
    expect(mockUpdateUser).toHaveBeenCalledWith(
      'user-stuck',
      expect.objectContaining({ subscription_status: 'active' })
    );
  });

  // ─── Test 2: returns null when user not found ───
  it('returns null when the user does not exist', async () => {
    mockGetUserById.mockResolvedValue(null);

    const updates = await reconcileStripeUserById('nope');

    expect(updates).toBeNull();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  // ─── Test 3: returns null when user has no stripe_customer_id ───
  it('returns null when the user has no stripe_customer_id', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u', email: 'x@y.z', stripe_customer_id: '' });

    const updates = await reconcileStripeUserById('u');

    expect(updates).toBeNull();
    expect(mockSubscriptionsList).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  // ─── Test 4: does NOT clobber the "canceling" pseudo-status ───
  it('preserves "canceling" when Stripe sub is active but cancel_at_period_end', async () => {
    const user = {
      userId: 'user-cancel',
      email: 'c@y.z',
      stripe_customer_id: 'cus_c',
      subscription_status: 'canceling',
      stripe_subscription_id: 'sub_stripe_123',
      subscriptionType: 'Pro',
      has_payment_method: true,
      current_period_end: '2025-01-01T00:00:00.000Z',
    };
    mockGetUserById.mockResolvedValue(user);
    mockPaymentMethodsList.mockResolvedValue({ data: [{ id: 'pm_1' }] });
    mockSubscriptionsList.mockResolvedValue({
      data: [makeStripeSub({ status: 'active', cancel_at_period_end: true })],
    });

    const updates = await reconcileStripeUserById('user-cancel');

    // status was already the correct effective value ("canceling") → not rewritten
    if (updates) {
      expect(updates).not.toHaveProperty('subscription_status');
    }
  });

  // ─── Test 5: happy path — no changes returns null ───
  it('returns null when local data already matches Stripe', async () => {
    const user = {
      userId: 'user-ok',
      email: 'ok@y.z',
      stripe_customer_id: 'cus_ok',
      subscription_status: 'active',
      stripe_subscription_id: 'sub_stripe_123',
      subscriptionType: 'Pro',
      has_payment_method: true,
      current_period_end: new Date(1700000000 * 1000).toISOString(),
      activeOffer: null,
    };
    mockGetUserById.mockResolvedValue(user);
    mockPaymentMethodsList.mockResolvedValue({ data: [{ id: 'pm_1' }] });
    mockSubscriptionsList.mockResolvedValue({ data: [makeStripeSub({ status: 'active' })] });

    const updates = await reconcileStripeUserById('user-ok');

    expect(updates).toBeNull();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });
});
