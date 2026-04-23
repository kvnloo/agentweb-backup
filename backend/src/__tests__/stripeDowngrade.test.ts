/**
 * Stripe Subscription Downgrade Tests
 *
 * Tests that subscription downgrades (price changes, partial refunds) do NOT
 * incorrectly mark the subscription as "canceled". Only genuine cancellations
 * (no remaining active subscription) should set status to "canceled".
 *
 * Root cause: When a downgrade is performed by canceling the old subscription
 * and creating a new cheaper one, Stripe fires `customer.subscription.deleted`
 * on the OLD subscription. Without checking for a remaining active sub, this
 * was incorrectly setting the user to "canceled" / "Free" tier.
 */

// --- Mocks ---

const mockSubscriptionsList = jest.fn();
const mockPaymentMethodsList = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    subscriptions: {
      list: mockSubscriptionsList,
      retrieve: jest.fn(),
      update: jest.fn(),
      cancel: jest.fn(),
    },
    paymentMethods: {
      list: mockPaymentMethodsList,
    },
    checkout: {
      sessions: { create: jest.fn(), retrieve: jest.fn() },
    },
    billingPortal: {
      sessions: { create: jest.fn() },
    },
    products: { list: jest.fn() },
    webhooks: { constructEvent: jest.fn() },
    customers: { retrieve: jest.fn() },
  }));
});

const mockGetUserById = jest.fn();
const mockUpdateUser = jest.fn();
const mockScanWithFilter = jest.fn();
const mockGetUserByEmail = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: mockGetUserById,
    getUserByEmail: mockGetUserByEmail,
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

// Mock settingsService for tier config
//
// PR #1261 renamed the Stripe price → tier mapping so the derived tier names
// ("Starter" / "Pro") now match what the pricing page already shows the user.
// The fixture below uses those canonical names so getTierConfig(derivedType)
// resolves correctly in the downgrade/update handlers under test.
const mockSubscriptionTypes = [
  { name: 'Free', allowedPages: ['/', '/agent-mode', '/settings', '/guide'], allowedSkills: [] },
  { name: 'Starter', allowedPages: ['/', '/agent-mode', '/settings', '/guide', '/brand-guidelines', '/market-strategy', '/knowledge-base', '/email-templates', '/tasks', '/research-reports'], allowedSkills: ['*'] },
  { name: 'Pro', allowedPages: ['*'], allowedSkills: ['*'] },
];

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockImplementation((key: string) => {
      if (key === 'subscription_types') {
        return Promise.resolve({
          settingName: 'subscription_types',
          settingValue: JSON.stringify(mockSubscriptionTypes),
          updatedAt: new Date().toISOString(),
          updatedBy: 'test',
        });
      }
      return Promise.resolve(null);
    }),
  },
}));

// Set env vars before importing
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
process.env.STRIPE_STARTER_PRICE_ID = 'price_starter_123';
process.env.STRIPE_COMPLETE_PRICE_ID = 'price_complete_456';

import {
  handleSubscriptionDeleted,
  handleSubscriptionUpdated,
} from '../services/stripeService';

describe('Stripe subscription downgrade handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateUser.mockResolvedValue({});
    mockPaymentMethodsList.mockResolvedValue({ data: [] });
  });

  // ===== FAILING TESTS (before the fix, these would fail) =====

  describe('handleSubscriptionDeleted — downgrade scenario', () => {
    it('should NOT cancel when customer has another active subscription (downgrade)', async () => {
      // User has an active subscription on a cheaper plan
      const mockUser = {
        userId: 'user-goalden',
        email: 'goalden@example.com',
        stripe_customer_id: 'cus_goalden',
        subscriptionType: 'Pro',
        subscription_status: 'active',
        stripe_subscription_id: 'sub_old_expensive',
      };

      mockScanWithFilter.mockResolvedValue([mockUser]);

      // When checking for remaining active subscriptions, return the new cheaper one
      mockSubscriptionsList.mockImplementation(({ status }: any) => {
        if (status === 'active') {
          return Promise.resolve({
            data: [{
              id: 'sub_new_cheaper',
              status: 'active',
              items: { data: [{ price: { id: 'price_starter_123' } }] },
              current_period_end: 1700000000,
            }],
          });
        }
        return Promise.resolve({ data: [] });
      });

      await handleSubscriptionDeleted({
        id: 'sub_old_expensive',
        customer: 'cus_goalden',
        status: 'canceled',
      });

      // Should sync to the new active subscription, NOT set to canceled/Free
      expect(mockUpdateUser).toHaveBeenCalledWith('user-goalden', expect.objectContaining({
        subscription_status: 'active',
        stripe_subscription_id: 'sub_new_cheaper',
        subscriptionType: 'Starter',
      }));

      // Should NOT contain 'canceled' or 'Free'
      const updateCall = mockUpdateUser.mock.calls[0][1];
      expect(updateCall.subscription_status).not.toBe('canceled');
      expect(updateCall.subscriptionType).not.toBe('Free');
    });

    it('should NOT cancel when customer has a trialing subscription after deletion', async () => {
      const mockUser = {
        userId: 'user-trial',
        email: 'trial@example.com',
        stripe_customer_id: 'cus_trial',
        subscriptionType: 'Pro',
        subscription_status: 'active',
        stripe_subscription_id: 'sub_old',
      };

      mockScanWithFilter.mockResolvedValue([mockUser]);

      // No active subs, but there IS a trialing one
      mockSubscriptionsList.mockImplementation(({ status }: any) => {
        if (status === 'active') {
          return Promise.resolve({ data: [] });
        }
        if (status === 'trialing') {
          return Promise.resolve({
            data: [{
              id: 'sub_new_trial',
              status: 'trialing',
              items: { data: [{ price: { id: 'price_complete_456' } }] },
              current_period_end: 1700000000,
            }],
          });
        }
        return Promise.resolve({ data: [] });
      });

      await handleSubscriptionDeleted({
        id: 'sub_old',
        customer: 'cus_trial',
        status: 'canceled',
      });

      expect(mockUpdateUser).toHaveBeenCalledWith('user-trial', expect.objectContaining({
        subscription_status: 'trialing',
        stripe_subscription_id: 'sub_new_trial',
        subscriptionType: 'Pro',
      }));
    });

    it('should update tier-specific allowedPages when downgrading from Pro to Starter', async () => {
      const mockUser = {
        userId: 'user-downgrade',
        email: 'downgrade@example.com',
        stripe_customer_id: 'cus_downgrade',
        subscriptionType: 'Pro',
        subscription_status: 'active',
        stripe_subscription_id: 'sub_premium',
      };

      mockScanWithFilter.mockResolvedValue([mockUser]);

      mockSubscriptionsList.mockImplementation(({ status }: any) => {
        if (status === 'active') {
          return Promise.resolve({
            data: [{
              id: 'sub_basic',
              status: 'active',
              items: { data: [{ price: { id: 'price_starter_123' } }] },
              current_period_end: 1700000000,
            }],
          });
        }
        return Promise.resolve({ data: [] });
      });

      await handleSubscriptionDeleted({
        id: 'sub_premium',
        customer: 'cus_downgrade',
        status: 'canceled',
      });

      const updateCall = mockUpdateUser.mock.calls[0][1];
      expect(updateCall.subscriptionType).toBe('Starter');
      expect(updateCall.allowedPages).toEqual(expect.arrayContaining(['/brand-guidelines', '/market-strategy']));
      expect(updateCall.allowedPages).not.toContain('*'); // No longer has wildcard access
    });
  });

  // ===== SUCCESS TESTS (genuine cancellations should still work) =====

  describe('handleSubscriptionDeleted — genuine cancellation', () => {
    it('should cancel and downgrade to Free when NO other subscriptions exist', async () => {
      const mockUser = {
        userId: 'user-cancel',
        email: 'cancel@example.com',
        stripe_customer_id: 'cus_cancel',
        subscriptionType: 'Pro',
        subscription_status: 'active',
        stripe_subscription_id: 'sub_canceled',
      };

      mockScanWithFilter.mockResolvedValue([mockUser]);

      // No remaining subscriptions
      mockSubscriptionsList.mockResolvedValue({ data: [] });

      await handleSubscriptionDeleted({
        id: 'sub_canceled',
        customer: 'cus_cancel',
        status: 'canceled',
      });

      expect(mockUpdateUser).toHaveBeenCalledWith('user-cancel', expect.objectContaining({
        subscription_status: 'canceled',
        subscriptionType: 'Free',
        allowedPages: ['/', '/agent-mode', '/settings', '/guide'],
      }));
    });
  });

  // ===== handleSubscriptionUpdated — downgrade via price change =====

  describe('handleSubscriptionUpdated — downgrade via price change', () => {
    it('should update tier when subscription is updated with a cheaper price (same sub ID)', async () => {
      const mockUser = {
        userId: 'user-pricechange',
        email: 'pricechange@example.com',
        stripe_customer_id: 'cus_pricechange',
        subscriptionType: 'Pro',
        subscription_status: 'active',
        stripe_subscription_id: 'sub_same',
      };

      mockScanWithFilter.mockResolvedValue([mockUser]);
      mockPaymentMethodsList.mockResolvedValue({ data: [{ id: 'pm_123' }] });

      await handleSubscriptionUpdated({
        id: 'sub_same',
        customer: 'cus_pricechange',
        status: 'active', // Still active after downgrade
        items: { data: [{ price: { id: 'price_starter_123' } }] }, // Cheaper price
        current_period_end: 1700000000,
      });

      expect(mockUpdateUser).toHaveBeenCalledWith('user-pricechange', expect.objectContaining({
        subscription_status: 'active',
        subscriptionType: 'Starter', // Downgraded tier
      }));

      // Should NOT be canceled
      const updateCall = mockUpdateUser.mock.calls[0][1];
      expect(updateCall.subscription_status).toBe('active');
    });
  });
});
