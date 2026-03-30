import express from 'express';
import request from 'supertest';

// --- Mocks ---

const mockStripe = {
  subscriptions: {
    list: jest.fn(),
    update: jest.fn(),
    retrieve: jest.fn(),
    cancel: jest.fn(),
  },
  customers: {
    create: jest.fn(),
  },
  checkout: {
    sessions: {
      create: jest.fn(),
    },
  },
  webhooks: {
    constructEvent: jest.fn(),
  },
};

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => mockStripe);
});

const mockGetUserById = jest.fn();
const mockUpdateUser = jest.fn();
const mockScanWithFilter = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: mockGetUserById,
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

// Mock authenticateToken
const mockAuth = jest.fn((req: any, _res: any, next: any) => {
  if (req.headers.authorization === 'Bearer valid-token') {
    req.user = { userId: 'user-123', email: 'test@example.com', isAdmin: false };
    next();
  } else {
    _res.status(401).json({ error: 'Unauthorized' });
  }
});

jest.mock('../middleware/auth', () => ({
  authenticateToken: mockAuth,
  AuthenticatedRequest: {},
}));

jest.mock('../controllers/stripeController', () => ({
  handleWebhook: jest.fn(),
  listProducts: jest.fn(),
}));

// Set env vars before importing route
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
process.env.STRIPE_STARTER_PRICE_ID = 'price_starter_123';
process.env.STRIPE_COMPLETE_PRICE_ID = 'price_complete_456';

import stripeRouter from '../routes/stripe';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/stripe', stripeRouter);
  return app;
}

describe('Stripe subscription upgrade', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- UPGRADE ENDPOINT TESTS ---

  describe('POST /api/stripe/upgrade', () => {
    it('should return 401 if not authenticated', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/api/stripe/upgrade')
        .set('Authorization', 'Bearer bad-token')
        .send({ plan: 'pro' });
      expect(res.status).toBe(401);
    });

    it('should return 400 if no plan or newPriceId provided', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/api/stripe/upgrade')
        .set('Authorization', 'Bearer valid-token')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/plan or newPriceId/i);
    });

    it('should return 400 if user has no Stripe customer', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'user-123', email: 'test@example.com' });
      const app = createApp();
      const res = await request(app)
        .post('/api/stripe/upgrade')
        .set('Authorization', 'Bearer valid-token')
        .send({ plan: 'pro' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no stripe customer/i);
    });

    it('should return 404 if no active subscription found', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'user-123',
        stripe_customer_id: 'cus_abc123',
      });
      // findActiveSubscription calls subscriptions.list twice (active then trialing)
      mockStripe.subscriptions.list.mockResolvedValue({ data: [] });

      const app = createApp();
      const res = await request(app)
        .post('/api/stripe/upgrade')
        .set('Authorization', 'Bearer valid-token')
        .send({ plan: 'pro' });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/no active subscription/i);
    });

    it('should return 400 if user is already on the requested plan', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'user-123',
        stripe_customer_id: 'cus_abc123',
      });
      mockStripe.subscriptions.list.mockResolvedValue({
        data: [{
          id: 'sub_existing',
          status: 'active',
          items: { data: [{ id: 'si_item1', price: { id: 'price_complete_456' } }] },
        }],
      });

      const app = createApp();
      const res = await request(app)
        .post('/api/stripe/upgrade')
        .set('Authorization', 'Bearer valid-token')
        .send({ plan: 'pro' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already on this plan/i);
    });

    it('should successfully upgrade from starter to pro', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'user-123',
        stripe_customer_id: 'cus_abc123',
      });
      // findActiveSubscription returns active subscription
      mockStripe.subscriptions.list.mockResolvedValue({
        data: [{
          id: 'sub_existing',
          status: 'active',
          items: { data: [{ id: 'si_item1', price: { id: 'price_starter_123' } }] },
        }],
      });
      // upgradeSubscription: retrieve then update
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_existing',
        items: { data: [{ id: 'si_item1', price: { id: 'price_starter_123' } }] },
      });
      mockStripe.subscriptions.update.mockResolvedValue({
        id: 'sub_existing',
        status: 'active',
        current_period_end: 1700000000,
        items: { data: [{ id: 'si_item1', price: { id: 'price_complete_456' } }] },
      });
      mockUpdateUser.mockResolvedValue({});

      const app = createApp();
      const res = await request(app)
        .post('/api/stripe/upgrade')
        .set('Authorization', 'Bearer valid-token')
        .send({ plan: 'pro' });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/upgraded successfully/i);
      expect(res.body.subscriptionType).toBe('Super Premium');
      expect(mockUpdateUser).toHaveBeenCalledWith('user-123', expect.objectContaining({
        stripe_subscription_id: 'sub_existing',
        subscription_status: 'active',
        subscriptionType: 'Super Premium',
      }));
    });

    it('should accept newPriceId directly', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'user-123',
        stripe_customer_id: 'cus_abc123',
      });
      mockStripe.subscriptions.list.mockResolvedValue({
        data: [{
          id: 'sub_existing',
          status: 'active',
          items: { data: [{ id: 'si_item1', price: { id: 'price_starter_123' } }] },
        }],
      });
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_existing',
        items: { data: [{ id: 'si_item1', price: { id: 'price_starter_123' } }] },
      });
      mockStripe.subscriptions.update.mockResolvedValue({
        id: 'sub_existing',
        status: 'active',
        current_period_end: 1700000000,
        items: { data: [{ id: 'si_item1', price: { id: 'price_complete_456' } }] },
      });
      mockUpdateUser.mockResolvedValue({});

      const app = createApp();
      const res = await request(app)
        .post('/api/stripe/upgrade')
        .set('Authorization', 'Bearer valid-token')
        .send({ newPriceId: 'price_complete_456' });

      expect(res.status).toBe(200);
    });
  });

  // --- HAS_USED_TRIAL TESTS ---

  describe('POST /api/stripe/create-checkout-session (trial gating)', () => {
    it('should include trial_period_days for new users without has_used_trial', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'user-123',
        email: 'test@example.com',
        stripe_customer_id: 'cus_abc123',
        has_used_trial: false,
      });
      mockStripe.checkout.sessions.create.mockResolvedValue({
        client_secret: 'cs_secret_123',
      });

      const app = createApp();
      const res = await request(app)
        .post('/api/stripe/create-checkout-session')
        .set('Authorization', 'Bearer valid-token')
        .send({ plan: 'starter' });

      expect(res.status).toBe(200);
      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_data: { trial_period_days: 14 },
        })
      );
    });

    it('should NOT include trial_period_days for users who have used trial', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'user-123',
        email: 'test@example.com',
        stripe_customer_id: 'cus_abc123',
        has_used_trial: true,
      });
      mockStripe.checkout.sessions.create.mockResolvedValue({
        client_secret: 'cs_secret_123',
      });

      const app = createApp();
      const res = await request(app)
        .post('/api/stripe/create-checkout-session')
        .set('Authorization', 'Bearer valid-token')
        .send({ plan: 'starter' });

      expect(res.status).toBe(200);
      // Should NOT have subscription_data with trial
      const callArgs = mockStripe.checkout.sessions.create.mock.calls[0][0];
      expect(callArgs.subscription_data).toBeUndefined();
    });
  });
});

// --- WEBHOOK HANDLER TESTS ---

describe('Stripe webhook handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('handleSubscriptionUpdated', () => {
    it('should ignore webhook for non-current subscription', async () => {
      // This tests the fix where stale subscription webhooks are ignored
      mockScanWithFilter.mockResolvedValue([{
        userId: 'user-123',
        stripe_customer_id: 'cus_abc',
        stripe_subscription_id: 'sub_current',
      }]);

      const { handleSubscriptionUpdated } = require('../services/stripeService');

      await handleSubscriptionUpdated({
        id: 'sub_old_duplicate',
        customer: 'cus_abc',
        status: 'canceled',
        items: { data: [{ price: { id: 'price_starter_123' } }] },
      });

      // Should NOT update user since the webhook is for an old subscription
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });

    it('should process webhook for the current subscription', async () => {
      mockScanWithFilter.mockResolvedValue([{
        userId: 'user-123',
        stripe_customer_id: 'cus_abc',
        stripe_subscription_id: 'sub_current',
      }]);

      const { handleSubscriptionUpdated } = require('../services/stripeService');

      await handleSubscriptionUpdated({
        id: 'sub_current',
        customer: 'cus_abc',
        status: 'active',
        current_period_end: 1700000000,
        items: { data: [{ price: { id: 'price_complete_456' } }] },
      });

      expect(mockUpdateUser).toHaveBeenCalledWith('user-123', expect.objectContaining({
        subscription_status: 'active',
      }));
    });
  });

  describe('handleCheckoutSessionCompleted', () => {
    it('should set has_used_trial on checkout completion', async () => {
      const mockGetUserByEmail = jest.fn().mockResolvedValue({
        userId: 'user-123',
        email: 'test@example.com',
      });

      jest.doMock('../services/db', () => ({
        userDb: {
          getUserById: jest.fn().mockResolvedValue({ userId: 'user-123', email: 'test@example.com' }),
          getUserByEmail: mockGetUserByEmail,
          updateUser: mockUpdateUser,
          scanWithFilter: mockScanWithFilter,
        },
      }));

      const { handleCheckoutSessionCompleted } = require('../services/stripeService');

      mockStripe.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_new',
        status: 'trialing',
        current_period_end: 1700000000,
      });
      mockStripe.subscriptions.list.mockResolvedValue({ data: [] });
      mockUpdateUser.mockResolvedValue({});

      await handleCheckoutSessionCompleted({
        metadata: { userId: 'user-123' },
        customer: 'cus_abc',
        subscription: 'sub_new',
        customer_details: { email: 'test@example.com' },
      });

      expect(mockUpdateUser).toHaveBeenCalledWith('user-123', expect.objectContaining({
        has_used_trial: true,
        stripe_subscription_id: 'sub_new',
      }));
    });
  });
});
