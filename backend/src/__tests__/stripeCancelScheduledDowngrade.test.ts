/**
 * Cancel-scheduled-downgrade + subscription_schedule webhook tests.
 *
 * Covers both halves of the "user changes their mind about a queued
 * downgrade" flow:
 *
 *   1. POST /api/stripe/cancel-scheduled-downgrade
 *      - Happy path: releases the Stripe schedule + clears scheduledChange
 *      - No scheduledChange on user → 404
 *      - Auth required → 401
 *
 *   2. subscription_schedule.{released,canceled,completed} webhook handler
 *      - Clears scheduledChange when the schedule ID matches
 *      - Does NOT clobber scheduledChange when the schedule ID is stale
 *        (prevents an out-of-order webhook from nuking a newer queued change)
 */

import express from 'express';
import request from 'supertest';

// --- Stripe SDK mock --------------------------------------------------------

const mockStripe = {
  subscriptions: {
    list: jest.fn(),
    update: jest.fn(),
    retrieve: jest.fn(),
    cancel: jest.fn(),
  },
  customers: {
    create: jest.fn(),
    retrieve: jest.fn(),
    search: jest.fn().mockResolvedValue({ data: [] }),
  },
  prices: {
    retrieve: jest.fn(),
  },
  subscriptionSchedules: {
    create: jest.fn(),
    update: jest.fn(),
    release: jest.fn(),
  },
  checkout: {
    sessions: { create: jest.fn() },
  },
  webhooks: {
    constructEvent: jest.fn(),
  },
};

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => mockStripe);
});

// --- userDb mock ------------------------------------------------------------

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

// --- Auth middleware mock --------------------------------------------------

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

jest.mock('../controllers/stripeController', () => ({
  handleWebhook: jest.fn(),
  listProducts: jest.fn(),
  reconcile: jest.fn((_req: any, res: any) => res.json({ ok: true })),
  getPaymentHistory: jest.fn((_req: any, res: any) => res.json([])),
}));

// Env vars before importing the route / service
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
process.env.STRIPE_STARTER_PRICE_ID = 'price_starter_123';
process.env.STRIPE_COMPLETE_PRICE_ID = 'price_complete_456';

import stripeRouter from '../routes/stripe';
import { handleSubscriptionScheduleEnded } from '../services/stripeService';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/stripe', stripeRouter);
  return app;
}

describe('POST /api/stripe/cancel-scheduled-downgrade', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/stripe/cancel-scheduled-downgrade')
      .set('Authorization', 'Bearer bad-token')
      .send({});
    expect(res.status).toBe(401);
    // Must NOT try to call Stripe when auth fails
    expect(mockStripe.subscriptionSchedules.release).not.toHaveBeenCalled();
  });

  it('returns 404 when user has no scheduledChange cached', async () => {
    mockGetUserById.mockResolvedValue({
      userId: 'user-123',
      email: 'test@example.com',
      stripe_customer_id: 'cus_abc123',
      // no scheduledChange
    });

    const app = createApp();
    const res = await request(app)
      .post('/api/stripe/cancel-scheduled-downgrade')
      .set('Authorization', 'Bearer valid-token')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no scheduled change/i);
    expect(mockStripe.subscriptionSchedules.release).not.toHaveBeenCalled();
    // And crucially, do NOT blindly clear scheduledChange on a no-op call
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('releases the Stripe schedule AND clears scheduledChange on success', async () => {
    mockGetUserById.mockResolvedValue({
      userId: 'user-123',
      email: 'test@example.com',
      stripe_customer_id: 'cus_abc123',
      scheduledChange: {
        stripeScheduleId: 'sub_sched_xyz',
        toPriceId: 'price_starter_123',
        toTier: 'Starter',
        effectiveAt: '2026-05-14T22:13:20.000Z',
      },
    });
    mockStripe.subscriptionSchedules.release.mockResolvedValue({
      id: 'sub_sched_xyz',
      status: 'released',
    });
    mockUpdateUser.mockResolvedValue({});

    const app = createApp();
    const res = await request(app)
      .post('/api/stripe/cancel-scheduled-downgrade')
      .set('Authorization', 'Bearer valid-token')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/canceled/i);
    // Stripe API called with the correct schedule ID
    expect(mockStripe.subscriptionSchedules.release).toHaveBeenCalledWith(
      'sub_sched_xyz'
    );
    // scheduledChange explicitly cleared (null, not undefined — updateUser
    // filters undefined but persists null as "remove this field")
    expect(mockUpdateUser).toHaveBeenCalledWith('user-123', {
      scheduledChange: null,
    });
  });

  it('returns 500 when Stripe release fails (and does NOT clear scheduledChange)', async () => {
    mockGetUserById.mockResolvedValue({
      userId: 'user-123',
      email: 'test@example.com',
      stripe_customer_id: 'cus_abc123',
      scheduledChange: {
        stripeScheduleId: 'sub_sched_xyz',
        toPriceId: 'price_starter_123',
        toTier: 'Starter',
        effectiveAt: '2026-05-14T22:13:20.000Z',
      },
    });
    mockStripe.subscriptionSchedules.release.mockRejectedValue(
      new Error('Stripe is down')
    );

    const app = createApp();
    const res = await request(app)
      .post('/api/stripe/cancel-scheduled-downgrade')
      .set('Authorization', 'Bearer valid-token')
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to cancel/i);
    // scheduledChange must NOT be cleared if Stripe rejected — otherwise
    // the user ends up with a dangling schedule in Stripe but no cached
    // hint locally, and the next webhook / UI state goes out of sync.
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });
});

describe('handleSubscriptionScheduleEnded (webhook)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('clears scheduledChange when the schedule ID matches the cached one', async () => {
    mockScanWithFilter.mockResolvedValue([
      {
        userId: 'user-123',
        email: 'test@example.com',
        stripe_customer_id: 'cus_abc123',
        scheduledChange: {
          stripeScheduleId: 'sub_sched_xyz',
          toPriceId: 'price_starter_123',
          toTier: 'Starter',
          effectiveAt: '2026-05-14T22:13:20.000Z',
        },
      },
    ]);
    mockUpdateUser.mockResolvedValue({});

    await handleSubscriptionScheduleEnded({
      id: 'sub_sched_xyz',
      customer: 'cus_abc123',
      status: 'released',
    });

    expect(mockUpdateUser).toHaveBeenCalledWith('user-123', {
      scheduledChange: null,
    });
  });

  it('fires for subscription_schedule.completed too (not just released)', async () => {
    mockScanWithFilter.mockResolvedValue([
      {
        userId: 'user-123',
        stripe_customer_id: 'cus_abc123',
        scheduledChange: {
          stripeScheduleId: 'sub_sched_xyz',
          toPriceId: 'price_starter_123',
          toTier: 'Starter',
          effectiveAt: '2026-05-14T22:13:20.000Z',
        },
      },
    ]);

    await handleSubscriptionScheduleEnded({
      id: 'sub_sched_xyz',
      customer: 'cus_abc123',
      status: 'completed',
    });

    expect(mockUpdateUser).toHaveBeenCalledWith('user-123', {
      scheduledChange: null,
    });
  });

  it('does NOT clear when schedule ID is stale (prevents clobbering newer queued change)', async () => {
    // User has since queued a DIFFERENT schedule. A late/out-of-order
    // webhook for the old schedule must not nuke the new one.
    mockScanWithFilter.mockResolvedValue([
      {
        userId: 'user-123',
        stripe_customer_id: 'cus_abc123',
        scheduledChange: {
          stripeScheduleId: 'sub_sched_NEW', // <- user's current pending change
          toPriceId: 'price_starter_123',
          toTier: 'Starter',
          effectiveAt: '2026-06-01T00:00:00.000Z',
        },
      },
    ]);

    await handleSubscriptionScheduleEnded({
      id: 'sub_sched_OLD', // <- stale event for a long-gone schedule
      customer: 'cus_abc123',
      status: 'canceled',
    });

    // Critical: scheduledChange must be untouched
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('is a no-op when no user matches the Stripe customer', async () => {
    mockScanWithFilter.mockResolvedValue([]);

    await handleSubscriptionScheduleEnded({
      id: 'sub_sched_xyz',
      customer: 'cus_unknown',
      status: 'released',
    });

    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('is a no-op when the event has no customer', async () => {
    await handleSubscriptionScheduleEnded({
      id: 'sub_sched_xyz',
      customer: null,
      status: 'released',
    });

    expect(mockScanWithFilter).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('handles customer object form (not just string ID)', async () => {
    mockScanWithFilter.mockResolvedValue([
      {
        userId: 'user-123',
        stripe_customer_id: 'cus_abc123',
        scheduledChange: {
          stripeScheduleId: 'sub_sched_xyz',
          toPriceId: 'price_starter_123',
          toTier: 'Starter',
          effectiveAt: '2026-05-14T22:13:20.000Z',
        },
      },
    ]);

    await handleSubscriptionScheduleEnded({
      id: 'sub_sched_xyz',
      customer: { id: 'cus_abc123', object: 'customer' },
      status: 'released',
    });

    expect(mockUpdateUser).toHaveBeenCalledWith('user-123', {
      scheduledChange: null,
    });
  });
});
