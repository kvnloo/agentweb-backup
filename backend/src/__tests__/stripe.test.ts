/**
 * Stripe Backend Integration Tests
 *
 * Tests the Stripe service, controller, routes, and webhook handler.
 * All Stripe SDK and DynamoDB calls are mocked.
 */

// Mock Stripe SDK before any imports
const mockCheckoutSessionsCreate = jest.fn();
const mockCheckoutSessionsRetrieve = jest.fn();
const mockBillingPortalSessionsCreate = jest.fn();
const mockProductsList = jest.fn();
const mockWebhooksConstructEvent = jest.fn();
const mockPaymentMethodsList = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: {
      sessions: {
        create: mockCheckoutSessionsCreate,
        retrieve: mockCheckoutSessionsRetrieve,
      },
    },
    billingPortal: {
      sessions: {
        create: mockBillingPortalSessionsCreate,
      },
    },
    products: {
      list: mockProductsList,
    },
    webhooks: {
      constructEvent: mockWebhooksConstructEvent,
    },
    paymentMethods: {
      list: mockPaymentMethodsList,
    },
  }));
});

// Mock db service
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
    updateUser: jest.fn(),
    getAllUsers: jest.fn(),
    scanWithFilter: jest.fn(),
  },
}));

// Mock waitlistDb
jest.mock('../services/waitlistDb', () => ({
  waitlistDb: {
    getByEmail: jest.fn(),
    updateDetails: jest.fn(),
    add: jest.fn(),
  },
}));

// Mock settingsService so subscriptionService doesn't try to create a real DynamoDB DocumentClient
const mockSubscriptionTypes = [
  { name: 'Free', allowedPages: ['/', '/agent-mode', '/settings', '/guide'], allowedSkills: [] },
  { name: 'Basic', allowedPages: ['/', '/agent-mode', '/settings', '/guide', '/brand-guidelines', '/market-strategy', '/knowledge-base', '/email-templates', '/tasks', '/research-reports'], allowedSkills: ['*'] },
  { name: 'Super Premium', allowedPages: ['*'], allowedSkills: ['*'] },
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

import { stripeService } from '../services/stripeService';
import { userDb } from '../services/db';

// Set env vars before importing service
process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake_secret';
process.env.CUSTOMER_FRONTEND_URL = 'http://localhost:5174';

describe('Stripe Backend Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('StripeService', () => {
    // FAIL test 1: createCheckoutSession with missing priceId
    describe('createCheckoutSession', () => {
      it('should throw validation error when priceId is missing', async () => {
        await expect(
          stripeService.createCheckoutSession('user-123', '', 'http://success.com', 'http://cancel.com')
        ).rejects.toThrow('priceId is required');
      });

      it('should throw validation error when userId is missing', async () => {
        await expect(
          stripeService.createCheckoutSession('', 'price_123', 'http://success.com', 'http://cancel.com')
        ).rejects.toThrow('userId is required');
      });

      it('should throw validation error when successUrl is missing', async () => {
        await expect(
          stripeService.createCheckoutSession('user-123', 'price_123', '', 'http://cancel.com')
        ).rejects.toThrow('successUrl is required');
      });

      // SUCCESS: creates checkout session successfully
      it('should create checkout session with correct params', async () => {
        mockCheckoutSessionsCreate.mockResolvedValue({
          id: 'cs_test_123',
          url: 'https://checkout.stripe.com/session/cs_test_123',
        });

        const result = await stripeService.createCheckoutSession(
          'user-123',
          'price_abc',
          'http://localhost:5174/success',
          'http://localhost:5174/cancel'
        );

        expect(result.url).toBe('https://checkout.stripe.com/session/cs_test_123');
        expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            mode: 'subscription',
            line_items: [{ price: 'price_abc', quantity: 1 }],
            success_url: 'http://localhost:5174/success',
            cancel_url: 'http://localhost:5174/cancel',
            metadata: { userId: 'user-123' },
          })
        );
      });
    });

    // FAIL test 2: webhook with invalid signature
    describe('constructWebhookEvent', () => {
      it('should throw error with invalid signature', () => {
        mockWebhooksConstructEvent.mockImplementation(() => {
          throw new Error('Webhook signature verification failed');
        });

        expect(() =>
          stripeService.constructWebhookEvent('body', 'invalid_sig')
        ).toThrow('Webhook signature verification failed');
      });

      // SUCCESS: valid webhook signature
      it('should return event with valid signature', () => {
        const mockEvent = { type: 'checkout.session.completed', data: { object: {} } };
        mockWebhooksConstructEvent.mockReturnValue(mockEvent);

        const result = stripeService.constructWebhookEvent('body', 'valid_sig');
        expect(result).toEqual(mockEvent);
      });
    });

    describe('createCustomerPortalSession', () => {
      it('should throw error when stripeCustomerId is missing', async () => {
        await expect(
          stripeService.createCustomerPortalSession('', 'http://return.com')
        ).rejects.toThrow('stripeCustomerId is required');
      });

      it('should create portal session successfully', async () => {
        mockBillingPortalSessionsCreate.mockResolvedValue({
          url: 'https://billing.stripe.com/portal/session_test',
        });

        const result = await stripeService.createCustomerPortalSession(
          'cus_123',
          'http://localhost:5174/settings'
        );

        expect(result.url).toBe('https://billing.stripe.com/portal/session_test');
      });
    });

    describe('getCheckoutSession', () => {
      it('should throw error when sessionId is missing', async () => {
        await expect(
          stripeService.getCheckoutSession('')
        ).rejects.toThrow('sessionId is required');
      });

      it('should retrieve session successfully', async () => {
        const mockSession = {
          id: 'cs_test_123',
          customer_details: { email: 'user@example.com' },
        };
        mockCheckoutSessionsRetrieve.mockResolvedValue(mockSession);

        const result = await stripeService.getCheckoutSession('cs_test_123');
        expect(result.id).toBe('cs_test_123');
      });
    });

    describe('listProducts', () => {
      it('should return active products with prices', async () => {
        mockProductsList.mockResolvedValue({
          data: [
            { id: 'prod_1', name: 'Pro Plan', active: true, default_price: 'price_1' },
          ],
        });

        const result = await stripeService.listProducts();
        expect(result.data).toHaveLength(1);
        expect(result.data[0].name).toBe('Pro Plan');
      });
    });
  });

  // FAIL test 3: webhook checkout.session.completed updates user model
  describe('Webhook Handler - checkout.session.completed', () => {
    it('should update user with stripe fields when checkout completes (by metadata userId)', async () => {
      const mockUser = {
        userId: 'user-123',
        email: 'test@example.com',
        stripe_customer_id: undefined,
      };

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (userDb.updateUser as jest.Mock).mockResolvedValue({
        ...mockUser,
        stripe_customer_id: 'cus_stripe_123',
        stripe_subscription_id: 'sub_stripe_456',
        subscriptionType: 'pro',
        subscription_status: 'active',
      });

      // Import the handler
      const { handleCheckoutSessionCompleted } = await import('../services/stripeService');

      await handleCheckoutSessionCompleted({
        customer: 'cus_stripe_123',
        subscription: 'sub_stripe_456',
        metadata: { userId: 'user-123' },
        customer_details: { email: 'test@example.com' },
      });

      expect(userDb.updateUser).toHaveBeenCalledWith('user-123', expect.objectContaining({
        stripe_customer_id: 'cus_stripe_123',
        stripe_subscription_id: 'sub_stripe_456',
        subscriptionType: 'Super Premium',
        subscription_status: 'active',
        allowedPages: ['*'],
        allowedSkills: ['*'],
      }));
    });

    it('should find user by email when metadata.userId is missing', async () => {
      const mockUser = {
        userId: 'user-456',
        email: 'fallback@example.com',
        stripe_customer_id: undefined,
      };

      (userDb.getUserById as jest.Mock).mockResolvedValue(null);
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue(mockUser);
      (userDb.updateUser as jest.Mock).mockResolvedValue({
        ...mockUser,
        stripe_customer_id: 'cus_stripe_789',
        stripe_subscription_id: 'sub_stripe_abc',
        subscriptionType: 'Super Premium',
        subscription_status: 'active',
      });

      const { handleCheckoutSessionCompleted } = await import('../services/stripeService');

      await handleCheckoutSessionCompleted({
        customer: 'cus_stripe_789',
        subscription: 'sub_stripe_abc',
        metadata: {},
        customer_details: { email: 'fallback@example.com' },
      });

      expect(userDb.getUserByEmail).toHaveBeenCalledWith('fallback@example.com');
      expect(userDb.updateUser).toHaveBeenCalledWith('user-456', expect.objectContaining({
        stripe_customer_id: 'cus_stripe_789',
        stripe_subscription_id: 'sub_stripe_abc',
        subscriptionType: 'Super Premium',
        subscription_status: 'active',
        allowedPages: ['*'],
        allowedSkills: ['*'],
      }));
    });

    it('should log warning when no user found for checkout session', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue(null);

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const { handleCheckoutSessionCompleted } = await import('../services/stripeService');

      await handleCheckoutSessionCompleted({
        customer: 'cus_unknown',
        subscription: 'sub_unknown',
        metadata: {},
        customer_details: { email: 'nobody@example.com' },
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('No user found')
      );
      expect(userDb.updateUser).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('Webhook Handler - customer.subscription.updated', () => {
    it('should update subscription_status when subscription changes', async () => {
      const mockUser = {
        userId: 'user-123',
        email: 'test@example.com',
        stripe_customer_id: 'cus_123',
      };

      (userDb as any).scanWithFilter.mockResolvedValue([mockUser]);
      (userDb.updateUser as jest.Mock).mockResolvedValue({
        ...mockUser,
        subscription_status: 'past_due',
      });
      // Mock paymentMethods.list for has_payment_method backfill
      mockPaymentMethodsList.mockResolvedValue({ data: [] });

      const { handleSubscriptionUpdated } = await import('../services/stripeService');

      await handleSubscriptionUpdated({
        id: 'sub_123',
        customer: 'cus_123',
        status: 'past_due',
        metadata: {},
      });

      expect(userDb.updateUser).toHaveBeenCalledWith('user-123', {
        subscription_status: 'past_due',
        stripe_subscription_id: 'sub_123',
        has_payment_method: false,
      });
    });
  });

  describe('Webhook Handler - customer.subscription.deleted', () => {
    it('should downgrade to Free tier on subscription deletion', async () => {
      const mockUser = {
        userId: 'user-123',
        email: 'test@example.com',
        stripe_customer_id: 'cus_123',
        subscriptionType: 'Super Premium',
        subscription_status: 'active',
      };

      (userDb as any).scanWithFilter.mockResolvedValue([mockUser]);
      (userDb.updateUser as jest.Mock).mockResolvedValue({
        ...mockUser,
        subscription_status: 'canceled',
        subscriptionType: 'Free',
      });

      const { handleSubscriptionDeleted } = await import('../services/stripeService');

      await handleSubscriptionDeleted({
        id: 'sub_123',
        customer: 'cus_123',
        metadata: {},
      });

      expect(userDb.updateUser).toHaveBeenCalledWith('user-123', expect.objectContaining({
        subscription_status: 'canceled',
        subscriptionType: 'Free',
        allowedPages: ['/', '/agent-mode', '/settings', '/guide'],
      }));
    });
  });

  // SUCCESS test: Full checkout flow lifecycle
  describe('Full Checkout Flow Lifecycle', () => {
    it('should handle create checkout → webhook → portal session flow', async () => {
      // Step 1: Create checkout session
      mockCheckoutSessionsCreate.mockResolvedValue({
        id: 'cs_test_lifecycle',
        url: 'https://checkout.stripe.com/session/cs_test_lifecycle',
      });

      const session = await stripeService.createCheckoutSession(
        'user-lifecycle',
        'price_pro',
        'http://localhost:5174/success',
        'http://localhost:5174/cancel'
      );
      expect(session.url).toBeTruthy();

      // Step 2: Webhook fires after payment
      const mockUser = {
        userId: 'user-lifecycle',
        email: 'lifecycle@example.com',
      };
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (userDb.updateUser as jest.Mock).mockResolvedValue({
        ...mockUser,
        stripe_customer_id: 'cus_lifecycle',
        stripe_subscription_id: 'sub_lifecycle',
        subscriptionType: 'Super Premium',
        subscription_status: 'active',
      });

      const { handleCheckoutSessionCompleted } = await import('../services/stripeService');

      await handleCheckoutSessionCompleted({
        customer: 'cus_lifecycle',
        subscription: 'sub_lifecycle',
        metadata: { userId: 'user-lifecycle' },
        customer_details: { email: 'lifecycle@example.com' },
      });

      expect(userDb.updateUser).toHaveBeenCalledWith('user-lifecycle', expect.objectContaining({
        stripe_customer_id: 'cus_lifecycle',
        stripe_subscription_id: 'sub_lifecycle',
        subscriptionType: 'Super Premium',
        subscription_status: 'active',
        allowedPages: ['*'],
        allowedSkills: ['*'],
      }));

      // Step 3: User accesses billing portal
      mockBillingPortalSessionsCreate.mockResolvedValue({
        url: 'https://billing.stripe.com/portal/lifecycle',
      });

      const portalSession = await stripeService.createCustomerPortalSession(
        'cus_lifecycle',
        'http://localhost:5174/settings'
      );
      expect(portalSession.url).toBeTruthy();
    });
  });
});
