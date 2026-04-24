import express from 'express';
import request from 'supertest';

// --- Mocks ---

const mockStripe = {
  subscriptions: {
    list: jest.fn(),
    update: jest.fn(),
  },
  webhooks: {
    constructEvent: jest.fn(),
  },
  paymentMethods: {
    list: jest.fn().mockResolvedValue({ data: [] }),
  },
};

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => mockStripe);
});

const mockGetUserById = jest.fn();
const mockUpdateUser = jest.fn();
const mockGetAllUsers = jest.fn();

const mockScanWithFilter = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: mockGetUserById,
    getUserByEmail: jest.fn(),
    updateUser: mockUpdateUser,
    getAllUsers: mockGetAllUsers,
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

const mockRequireAdmin = jest.fn((_req: any, _res: any, next: any) => next());

jest.mock('../middleware/auth', () => ({
  authenticateToken: mockAuth,
  requireAdmin: mockRequireAdmin,
  AuthenticatedRequest: {},
}));

// Set env vars before importing route
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

import stripeRouter from '../routes/stripe';

function createApp() {
  const app = express();
  // Stripe webhook needs raw body, but for testing we can use json
  app.use(express.json());
  app.use('/api/stripe', stripeRouter);
  return app;
}

describe('Stripe subscription management', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- CANCEL TESTS ---

  describe('POST /api/stripe/cancel-subscription', () => {
    it('should return 400 if user has no stripe_customer_id', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'user-123', email: 'test@example.com' });
      const app = createApp();
      const res = await request(app)
        .post('/api/stripe/cancel-subscription')
        .set('Authorization', 'Bearer valid-token');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no.*subscription/i);
    });

    it('should return 404 if no active subscription found', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'user-123',
        stripe_customer_id: 'cus_abc123',
      });
      mockStripe.subscriptions.list.mockResolvedValue({ data: [] });

      const app = createApp();
      const res = await request(app)
        .post('/api/stripe/cancel-subscription')
        .set('Authorization', 'Bearer valid-token');
      expect(res.status).toBe(404);
    });

    it('should cancel subscription at period end and update user status', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'user-123',
        stripe_customer_id: 'cus_abc123',
      });
      mockStripe.subscriptions.list.mockResolvedValue({
        data: [{ id: 'sub_abc', status: 'active', current_period_end: 1700000000 }],
      });
      mockStripe.subscriptions.update.mockResolvedValue({
        id: 'sub_abc',
        cancel_at_period_end: true,
        current_period_end: 1700000000,
      });
      mockUpdateUser.mockResolvedValue({});

      const app = createApp();
      const res = await request(app)
        .post('/api/stripe/cancel-subscription')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.cancel_at_period_end).toBe(true);
      expect(mockStripe.subscriptions.update).toHaveBeenCalledWith('sub_abc', {
        cancel_at_period_end: true,
      });
      expect(mockUpdateUser).toHaveBeenCalledWith('user-123', expect.objectContaining({
        subscription_status: 'canceling',
      }));
    });
  });

  // --- REACTIVATE TESTS ---

  describe('POST /api/stripe/reactivate-subscription', () => {
    it('should return 400 if subscription is already active (not canceling)', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'user-123',
        stripe_customer_id: 'cus_abc123',
      });
      mockStripe.subscriptions.list.mockResolvedValue({
        data: [{ id: 'sub_abc', status: 'active', cancel_at_period_end: false }],
      });

      const app = createApp();
      const res = await request(app)
        .post('/api/stripe/reactivate-subscription')
        .set('Authorization', 'Bearer valid-token');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not.*cancel/i);
    });

    it('should reactivate a canceling subscription', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'user-123',
        stripe_customer_id: 'cus_abc123',
      });
      mockStripe.subscriptions.list.mockResolvedValue({
        data: [{ id: 'sub_abc', status: 'active', cancel_at_period_end: true, current_period_end: 1700000000 }],
      });
      mockStripe.subscriptions.update.mockResolvedValue({
        id: 'sub_abc',
        cancel_at_period_end: false,
        current_period_end: 1700000000,
      });
      mockUpdateUser.mockResolvedValue({});

      const app = createApp();
      const res = await request(app)
        .post('/api/stripe/reactivate-subscription')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.cancel_at_period_end).toBe(false);
      expect(mockStripe.subscriptions.update).toHaveBeenCalledWith('sub_abc', {
        cancel_at_period_end: false,
      });
      expect(mockUpdateUser).toHaveBeenCalledWith('user-123', expect.objectContaining({
        subscription_status: 'active',
      }));
    });

    it('should fall back to trialing subs when no active sub exists', async () => {
      // Regression: a user who canceled during a free trial had no
      // status=active sub and /reactivate-subscription returned 404.
      // Now it should discover the trialing sub the same way
      // /cancel-subscription does.
      mockGetUserById.mockResolvedValue({
        userId: 'user-123',
        stripe_customer_id: 'cus_abc123',
      });
      // First call (status=active) returns empty, second (status=trialing) returns the sub
      mockStripe.subscriptions.list
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({
          data: [{
            id: 'sub_trial',
            status: 'trialing',
            cancel_at_period_end: true,
            items: { data: [{ current_period_end: 1700000000 }] },
          }],
        });
      mockStripe.subscriptions.update.mockResolvedValue({
        id: 'sub_trial',
        cancel_at_period_end: false,
        items: { data: [{ current_period_end: 1700000000 }] },
      });
      mockUpdateUser.mockResolvedValue({});

      const app = createApp();
      const res = await request(app)
        .post('/api/stripe/reactivate-subscription')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(mockStripe.subscriptions.update).toHaveBeenCalledWith('sub_trial', {
        cancel_at_period_end: false,
      });
      expect(mockStripe.subscriptions.list).toHaveBeenCalledTimes(2);
    });

    it('should not crash when current_period_end is null on reactivated sub', async () => {
      // Same defensive null-period_end pattern PR #1262 applied to
      // /cancel-subscription. Before this, `new Date(null * 1000).toISOString()`
      // threw "Invalid time value" and the whole request 500'd.
      mockGetUserById.mockResolvedValue({
        userId: 'user-123',
        stripe_customer_id: 'cus_abc123',
      });
      mockStripe.subscriptions.list.mockResolvedValue({
        data: [{
          id: 'sub_abc',
          status: 'active',
          cancel_at_period_end: true,
          current_period_end: null,
        }],
      });
      mockStripe.subscriptions.update.mockResolvedValue({
        id: 'sub_abc',
        cancel_at_period_end: false,
        current_period_end: null,
        items: { data: [{}] }, // no current_period_end anywhere
      });
      mockUpdateUser.mockResolvedValue({});

      const app = createApp();
      const res = await request(app)
        .post('/api/stripe/reactivate-subscription')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.current_period_end).toBeNull();
      // updateUser should be called with subscription_status=active but
      // WITHOUT current_period_end (since it could not be derived).
      const updateArgs = mockUpdateUser.mock.calls[0][1];
      expect(updateArgs.subscription_status).toBe('active');
      expect(updateArgs).not.toHaveProperty('current_period_end');
    });
  });

  // --- WEBHOOK TESTS ---

  describe('POST /api/stripe/webhook', () => {
    it('should reject webhook with invalid signature', async () => {
      mockStripe.webhooks.constructEvent.mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      const app = createApp();
      const res = await request(app)
        .post('/api/stripe/webhook')
        .set('stripe-signature', 'invalid-sig')
        .send({ type: 'test' });
      expect(res.status).toBe(400);
    });

    it('should update user subscription_status on customer.subscription.updated', async () => {
      const event = {
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_abc',
            customer: 'cus_abc123',
            status: 'past_due',
            current_period_end: 1700000000,
            cancel_at_period_end: false,
          },
        },
      };
      mockStripe.webhooks.constructEvent.mockReturnValue(event);
      // findUserByStripeCustomerId uses scanWithFilter to find user by stripe_customer_id
      mockScanWithFilter.mockResolvedValue([
        { userId: 'user-123', stripe_customer_id: 'cus_abc123' },
      ]);
      mockUpdateUser.mockResolvedValue({});

      const app = createApp();
      const res = await request(app)
        .post('/api/stripe/webhook')
        .set('stripe-signature', 'valid-sig')
        .send(event);

      expect(res.status).toBe(200);
      expect(mockUpdateUser).toHaveBeenCalledWith('user-123', expect.objectContaining({
        subscription_status: 'past_due',
      }));
    });
  });
});
