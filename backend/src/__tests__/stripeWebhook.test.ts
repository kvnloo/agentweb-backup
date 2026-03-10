import express from 'express';
import request from 'supertest';

// Mock Stripe
const mockConstructEvent = jest.fn();
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    webhooks: {
      constructEvent: (...args: any[]) => mockConstructEvent(...args),
    },
  }));
});

// Mock userDb
const mockGetUserByStripeCustomerId = jest.fn();
const mockUpdateUser = jest.fn();
const mockDeactivateUser = jest.fn();
jest.mock('../services/db', () => ({
  userDb: {
    getUserByStripeCustomerId: (...args: any[]) => mockGetUserByStripeCustomerId(...args),
    updateUser: (...args: any[]) => mockUpdateUser(...args),
    deactivateUser: (...args: any[]) => mockDeactivateUser(...args),
  },
}));

// Must set env vars before importing the service
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

import { handleWebhookEvent } from '../services/stripeWebhookService';
import stripeRoutes from '../routes/stripe';

// Build a minimal app that mimics the raw body setup for webhook
function buildApp() {
  const app = express();
  // Webhook route needs raw body — mimic what app.ts does
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use('/api/stripe', stripeRoutes);
  return app;
}

describe('Stripe Webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── FAIL TESTS ───

  describe('POST /api/stripe/webhook - validation', () => {
    it('should return 400 when stripe-signature header is missing', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/api/stripe/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ type: 'test' }));

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('signature');
    });

    it('should return 400 when signature is invalid', async () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      const app = buildApp();
      const res = await request(app)
        .post('/api/stripe/webhook')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 'invalid_sig')
        .send(JSON.stringify({ type: 'test' }));

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('signature');
    });

    it('should return 200 when stripe_customer_id has no matching user (warning logged)', async () => {
      mockConstructEvent.mockReturnValue({
        type: 'customer.subscription.created',
        data: {
          object: {
            customer: 'cus_unknown',
            id: 'sub_123',
            status: 'active',
            current_period_end: 1700000000,
            cancel_at_period_end: false,
          },
        },
      });
      mockGetUserByStripeCustomerId.mockResolvedValue(null);

      const app = buildApp();
      const res = await request(app)
        .post('/api/stripe/webhook')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 'valid_sig')
        .send(JSON.stringify({ type: 'test' }));

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    it('should return 200 for unsupported event types (no-op)', async () => {
      mockConstructEvent.mockReturnValue({
        type: 'payment_method.attached',
        data: { object: {} },
      });

      const app = buildApp();
      const res = await request(app)
        .post('/api/stripe/webhook')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 'valid_sig')
        .send(JSON.stringify({ type: 'test' }));

      expect(res.status).toBe(200);
      expect(mockGetUserByStripeCustomerId).not.toHaveBeenCalled();
    });
  });

  // ─── SUCCESS TESTS ───

  describe('handleWebhookEvent - subscription lifecycle', () => {
    const mockUser = {
      userId: 'user-123',
      email: 'test@example.com',
      stripe_customer_id: 'cus_abc',
      isActive: true,
    };

    it('should populate subscription fields on subscription.created', async () => {
      mockGetUserByStripeCustomerId.mockResolvedValue(mockUser);
      mockUpdateUser.mockResolvedValue(undefined);

      await handleWebhookEvent({
        type: 'customer.subscription.created',
        data: {
          object: {
            customer: 'cus_abc',
            id: 'sub_new',
            status: 'active',
            current_period_end: 1700000000,
            cancel_at_period_end: false,
          },
        },
      });

      expect(mockUpdateUser).toHaveBeenCalledWith('user-123', expect.objectContaining({
        stripeSubscriptionId: 'sub_new',
        stripeSubscriptionStatus: 'active',
        stripeCurrentPeriodEnd: '2023-11-14T22:13:20.000Z',
      }));
    });

    it('should deactivate user and set stripeChurnedAt on subscription.deleted', async () => {
      mockGetUserByStripeCustomerId.mockResolvedValue(mockUser);
      mockUpdateUser.mockResolvedValue(undefined);
      mockDeactivateUser.mockResolvedValue(undefined);

      await handleWebhookEvent({
        type: 'customer.subscription.deleted',
        data: {
          object: {
            customer: 'cus_abc',
            id: 'sub_new',
            status: 'canceled',
            current_period_end: 1700000000,
            cancel_at_period_end: false,
          },
        },
      });

      expect(mockUpdateUser).toHaveBeenCalledWith('user-123', expect.objectContaining({
        stripeSubscriptionStatus: 'canceled',
        stripeChurnedAt: expect.any(String),
      }));
      expect(mockDeactivateUser).toHaveBeenCalledWith('user-123');
    });

    it('should update payment fields on invoice.paid', async () => {
      mockGetUserByStripeCustomerId.mockResolvedValue(mockUser);
      mockUpdateUser.mockResolvedValue(undefined);

      await handleWebhookEvent({
        type: 'invoice.paid',
        data: {
          object: {
            customer: 'cus_abc',
            amount_paid: 2999,
            subscription: 'sub_new',
          },
        },
      });

      expect(mockUpdateUser).toHaveBeenCalledWith('user-123', expect.objectContaining({
        stripeLastPaymentAt: expect.any(String),
        stripeLastPaymentAmount: 2999,
        stripeSubscriptionStatus: 'active',
      }));
    });

    it('should set status to past_due on invoice.payment_failed', async () => {
      mockGetUserByStripeCustomerId.mockResolvedValue(mockUser);
      mockUpdateUser.mockResolvedValue(undefined);

      await handleWebhookEvent({
        type: 'invoice.payment_failed',
        data: {
          object: {
            customer: 'cus_abc',
            subscription: 'sub_new',
          },
        },
      });

      expect(mockUpdateUser).toHaveBeenCalledWith('user-123', expect.objectContaining({
        stripeFailedPaymentAt: expect.any(String),
        stripeSubscriptionStatus: 'past_due',
      }));
    });

    it('should set stripeCanceledAt when cancel_at_period_end is true on subscription.updated', async () => {
      mockGetUserByStripeCustomerId.mockResolvedValue(mockUser);
      mockUpdateUser.mockResolvedValue(undefined);

      await handleWebhookEvent({
        type: 'customer.subscription.updated',
        data: {
          object: {
            customer: 'cus_abc',
            id: 'sub_new',
            status: 'active',
            current_period_end: 1700000000,
            cancel_at_period_end: true,
            canceled_at: 1699900000,
          },
        },
      });

      expect(mockUpdateUser).toHaveBeenCalledWith('user-123', expect.objectContaining({
        stripeSubscriptionStatus: 'active',
        stripeCanceledAt: expect.any(String),
      }));
    });

    it('should reactivate user and clear stripeChurnedAt on subscription.resumed', async () => {
      const inactiveUser = { ...mockUser, isActive: false, stripeChurnedAt: '2023-01-01' };
      mockGetUserByStripeCustomerId.mockResolvedValue(inactiveUser);
      mockUpdateUser.mockResolvedValue(undefined);

      await handleWebhookEvent({
        type: 'customer.subscription.resumed',
        data: {
          object: {
            customer: 'cus_abc',
            id: 'sub_new',
            status: 'active',
            current_period_end: 1700000000,
            cancel_at_period_end: false,
          },
        },
      });

      expect(mockUpdateUser).toHaveBeenCalledWith('user-123', expect.objectContaining({
        stripeSubscriptionStatus: 'active',
        isActive: true,
      }));
      // stripeChurnedAt should be removed (set to empty string or undefined)
      const updateCall = mockUpdateUser.mock.calls[0][1];
      expect(updateCall.stripeChurnedAt).toBeFalsy();
    });
  });
});
