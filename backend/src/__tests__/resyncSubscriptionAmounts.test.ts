/**
 * resyncAllSubscriptionAmounts tests.
 *
 * The admin "Resync Payments" button must now ALSO authoritatively reconcile
 * subscription_status / has_payment_method (Stripe wins), not just refresh
 * subscription_amount. This unsticks an overdue (stale past_due) account whose
 * recovery webhook never landed.
 */

// --- Mocks ---

const mockSubscriptionsList = jest.fn();
const mockPaymentMethodsList = jest.fn();
const mockInvoicesList = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    subscriptions: { list: mockSubscriptionsList },
    paymentMethods: { list: mockPaymentMethodsList },
    invoices: { list: mockInvoicesList },
  }));
});

const mockUpdateUser = jest.fn();
const mockScanWithFilter = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
    updateUser: mockUpdateUser,
    getAllUsers: jest.fn(),
    scanWithFilter: mockScanWithFilter,
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

import { resyncAllSubscriptionAmounts } from '../services/stripeService';

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

describe('resyncAllSubscriptionAmounts — reconciles status, not just amount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPaymentMethodsList.mockResolvedValue({ data: [] });
  });

  // ─── Test 1 (the bug): unsticks a stale past_due account ───
  it('reconciles a stale past_due status to active even when amount is unchanged', async () => {
    const user = {
      userId: 'user-stuck',
      email: 'admin@rankai.ai',
      stripe_customer_id: 'cus_stuck',
      subscription_status: 'past_due',
      stripe_subscription_id: 'sub_stripe_123',
      subscriptionType: 'Pro',
      has_payment_method: false,
      current_period_end: '2025-01-01T00:00:00.000Z',
      subscription_amount: 49900,
    };
    mockScanWithFilter.mockResolvedValue([user]);
    mockSubscriptionsList.mockResolvedValue({ data: [makeStripeSub({ status: 'active' })] });
    // Latest paid invoice matches the stored amount → amount step is a no-op
    mockInvoicesList.mockResolvedValue({ data: [{ amount_paid: 49900 }] });

    const summary = await resyncAllSubscriptionAmounts();

    expect(summary.reconciled).toBe(1);
    expect(mockUpdateUser).toHaveBeenCalledWith(
      'user-stuck',
      expect.objectContaining({ subscription_status: 'active', has_payment_method: true })
    );
  });

  // ─── Test 2: still updates subscription_amount when it changed ───
  it('still refreshes subscription_amount from the latest paid invoice', async () => {
    const user = {
      userId: 'user-amt',
      email: 'amt@y.z',
      stripe_customer_id: 'cus_amt',
      subscription_status: 'active',
      stripe_subscription_id: 'sub_stripe_123',
      subscriptionType: 'Pro',
      has_payment_method: true,
      current_period_end: new Date(1700000000 * 1000).toISOString(),
      activeOffer: null,
      subscription_amount: 100,
    };
    mockScanWithFilter.mockResolvedValue([user]);
    mockPaymentMethodsList.mockResolvedValue({ data: [{ id: 'pm_1' }] });
    mockSubscriptionsList.mockResolvedValue({ data: [makeStripeSub({ status: 'active' })] });
    mockInvoicesList.mockResolvedValue({ data: [{ amount_paid: 49900 }] });

    const summary = await resyncAllSubscriptionAmounts();

    expect(summary.updated).toBe(1);
    expect(mockUpdateUser).toHaveBeenCalledWith('user-amt', { subscription_amount: 49900 });
  });

  // ─── Test 3: fully in-sync user is skipped (no writes) ───
  it('skips a user already matching Stripe with an unchanged amount', async () => {
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
      subscription_amount: 49900,
    };
    mockScanWithFilter.mockResolvedValue([user]);
    mockPaymentMethodsList.mockResolvedValue({ data: [{ id: 'pm_1' }] });
    mockSubscriptionsList.mockResolvedValue({ data: [makeStripeSub({ status: 'active' })] });
    mockInvoicesList.mockResolvedValue({ data: [{ amount_paid: 49900 }] });

    const summary = await resyncAllSubscriptionAmounts();

    expect(summary.reconciled).toBe(0);
    expect(summary.updated).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  // ─── Test 4: a per-user error is counted, others still processed ───
  it('counts errors without aborting the whole sweep', async () => {
    const bad = { userId: 'bad', email: 'bad@y.z', stripe_customer_id: 'cus_bad' };
    const good = {
      userId: 'good',
      email: 'good@y.z',
      stripe_customer_id: 'cus_good',
      subscription_status: 'past_due',
      stripe_subscription_id: 'sub_stripe_123',
      subscriptionType: 'Pro',
      has_payment_method: false,
    };
    mockScanWithFilter.mockResolvedValue([bad, good]);
    mockSubscriptionsList
      .mockRejectedValueOnce(new Error('Stripe boom'))
      .mockResolvedValueOnce({ data: [makeStripeSub({ status: 'active' })] });
    mockInvoicesList.mockResolvedValue({ data: [{ amount_paid: 49900 }] });

    const summary = await resyncAllSubscriptionAmounts();

    expect(summary.checked).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.reconciled).toBe(1);
  });
});
