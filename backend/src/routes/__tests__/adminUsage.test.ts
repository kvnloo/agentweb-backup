/**
 * Tests for the admin shadow-usage routes (routes/adminUsage.ts).
 */

import express from 'express';
import request from 'supertest';

// Pass-through auth by default; individual tests flip behavior.
jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', email: 'admin@example.com', isAdmin: true };
    next();
  }),
}));

jest.mock('../../middleware/admin', () => ({
  isAdmin: jest.fn((req: any, res: any, next: any) => {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
    }
    next();
  }),
}));

jest.mock('../../services/usageAnalyticsService', () => ({
  getUserUsageByModelDay: jest.fn(),
  getUsageComparison: jest.fn(),
  getUserXBreakdown: jest.fn(),
}));

// The spend-breakdown route (ENG-1250 §7) has no route-level coverage: the read
// model is unit-tested as pure functions, but the route's COMPOSITION -- billing
// resolution, guards, and stitching breakdown+allowance+projection+pause into one
// payload -- was asserted nowhere. Only the true boundaries are mocked below;
// spendReadModel and spendProjection run for real, so these exercise the
// composition rather than a restatement of it.
jest.mock('../../services/spendEventDb', () => ({ listSpendEvents: jest.fn() }));
jest.mock('../../services/tokenUsageService', () => ({ resolveBillingUserId: jest.fn() }));
jest.mock('../../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../../services/subscriptionService', () => ({ getSubscriptionTypeConfig: jest.fn() }));
jest.mock('../../services/llmUsageCreditService', () => ({ getLlmUsageCreditAdjustment: jest.fn() }));

import adminUsageRoutes from '../adminUsage';
import { authenticateToken } from '../../middleware/auth';
import {
  getUserUsageByModelDay,
  getUsageComparison,
  getUserXBreakdown,
} from '../../services/usageAnalyticsService';
import { listSpendEvents } from '../../services/spendEventDb';
import { resolveBillingUserId } from '../../services/tokenUsageService';
import { userDb } from '../../services/db';
import { getSubscriptionTypeConfig } from '../../services/subscriptionService';
import { getLlmUsageCreditAdjustment } from '../../services/llmUsageCreditService';

const mockByModelDay = getUserUsageByModelDay as jest.Mock;
const mockComparison = getUsageComparison as jest.Mock;
const mockXBreakdown = getUserXBreakdown as jest.Mock;
const mockAuth = authenticateToken as unknown as jest.Mock;
const mockListSpendEvents = listSpendEvents as jest.Mock;
const mockResolveBilling = resolveBillingUserId as jest.Mock;
const mockGetUserById = userDb.getUserById as jest.Mock;
const mockTierConfig = getSubscriptionTypeConfig as jest.Mock;
const mockCreditAdjustment = getLlmUsageCreditAdjustment as jest.Mock;

/** A settled spend event, overridable per test. */
const spendEvent = (over: Record<string, unknown> = {}) => ({
  billingUserId: 'owner-1',
  eventId: `evt-${Math.random().toString(36).slice(2)}`,
  occurredAt: '2026-09-04T10:00:00.000Z',
  billingMonth: '2026-09',
  actingUserId: 'member-1',
  provider: 'apollo',
  operation: 'email_reveal',
  feature: 'lead-finder',
  unit: 'reveal',
  quantity: 1,
  costMicroUsd: 49_500,
  costSource: 'allocated' as const,
  lifecycle: 'settled' as const,
  ...over,
});

let app: express.Application;

describe('admin usage routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockImplementation((req: any, _res: any, next: any) => {
      req.user = { userId: 'admin-1', email: 'admin@example.com', isAdmin: true };
      next();
    });
    app = express();
    app.use(express.json());
    app.use('/api/admin', adminUsageRoutes);
  });

  describe('GET /api/admin/users/:billingUserId/spend/breakdown', () => {
    beforeEach(() => {
      mockResolveBilling.mockImplementation(async (id: string) => id);
      mockGetUserById.mockResolvedValue({ userId: 'owner-1', subscriptionType: 'Pro' });
      // A Pro tier with a $200 hard cap, so the projection has something real to
      // measure against. `null` here would make the account UNLIMITED, which
      // silently makes every pause assertion vacuous.
      mockTierConfig.mockResolvedValue({
        llmUsagePolicy: { hardCostThresholdMicroUsd: 200_000_000 },
      });
      // resolveAllowanceInputs reads three fields off this unconditionally — a
      // bare null is not a valid "no credits" value.
      mockCreditAdjustment.mockReturnValue({
        purchasedMicroUsd: 0,
        adminGrantedMicroUsd: 0,
        migrationOffsetMicroUsd: 0,
      });
      mockListSpendEvents.mockResolvedValue([]);
    });

    it('400s on a malformed month, before reading the ledger', async () => {
      for (const month of ['', '2026-13', '2026-00', 'nope']) {
        const res = await request(app).get('/api/admin/users/owner-1/spend/breakdown').query({ month });
        expect(res.status).toBe(400);
      }
      expect(mockListSpendEvents).not.toHaveBeenCalled();
    });

    it('400s on an identifier that is not a plausible id', async () => {
      const res = await request(app)
        .get('/api/admin/users/not%20an%20id/spend/breakdown')
        .query({ month: '2026-09' });
      expect(res.status).toBe(400);
      expect(mockListSpendEvents).not.toHaveBeenCalled();
    });

    it('403s for a non-admin', async () => {
      mockAuth.mockImplementation((req: any, _res: any, next: any) => {
        req.user = { userId: 'u-1', isAdmin: false };
        next();
      });
      const res = await request(app)
        .get('/api/admin/users/owner-1/spend/breakdown')
        .query({ month: '2026-09' });
      expect(res.status).toBe(403);
    });

    // The trap this route's parameter name invites: spend events are partitioned
    // by billing root, so a member id matches nothing and returns a complete,
    // well-formed, EMPTY breakdown -- "this account spent nothing" about an
    // account that spent plenty. The admin cost tables are keyed by acting user,
    // so a member id arrives here routinely (ENG-1838).
    it('resolves an org member to the billing root before reading the ledger', async () => {
      mockResolveBilling.mockResolvedValue('owner-1');
      mockListSpendEvents.mockResolvedValue([spendEvent()]);

      const res = await request(app)
        .get('/api/admin/users/member-1/spend/breakdown')
        .query({ month: '2026-09' });

      expect(res.status).toBe(200);
      expect(mockResolveBilling).toHaveBeenCalledWith('member-1');
      expect(mockListSpendEvents).toHaveBeenCalledWith('owner-1', '2026-09-01', '2026-09-31');
      // Both ids are reported, so the UI can say whose ledger this is.
      expect(res.body.billingUserId).toBe('owner-1');
      expect(res.body.requestedUserId).toBe('member-1');
      expect(res.body.settledMicroUsd).toBe(49_500);
    });

    it('is a no-op for a billing root', async () => {
      mockResolveBilling.mockResolvedValue('owner-1');
      mockListSpendEvents.mockResolvedValue([spendEvent()]);

      const res = await request(app)
        .get('/api/admin/users/owner-1/spend/breakdown')
        .query({ month: '2026-09' });

      expect(res.body.billingUserId).toBe('owner-1');
      expect(res.body.requestedUserId).toBe('owner-1');
    });

    it('composes breakdown, allowance, projection and pause into one payload', async () => {
      mockResolveBilling.mockResolvedValue('owner-1');
      mockListSpendEvents.mockResolvedValue([
        spendEvent({ provider: 'apollo', costMicroUsd: 40_000 }),
        spendEvent({ provider: 'twitter', operation: 'post', costMicroUsd: 15_000 }),
      ]);

      const res = await request(app)
        .get('/api/admin/users/owner-1/spend/breakdown')
        .query({ month: '2026-09' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          billingUserId: 'owner-1',
          billingMonth: '2026-09',
          settledMicroUsd: 55_000,
          eventCount: 2,
          allowance: expect.any(Object),
          projection: expect.objectContaining({ settledMicroUsd: 55_000 }),
          pause: expect.objectContaining({ paused: expect.any(Boolean) }),
        }),
      );
      expect(res.body.byProvider.map((s: any) => s.key).sort()).toEqual(['apollo', 'twitter']);
    });

    // AC2: committed money must never read as spent money.
    it('reports a reservation separately from settled spend', async () => {
      mockResolveBilling.mockResolvedValue('owner-1');
      mockListSpendEvents.mockResolvedValue([
        spendEvent({ costMicroUsd: 10_000, lifecycle: 'settled' }),
        spendEvent({ eventId: 'evt-r', costMicroUsd: 90_000, lifecycle: 'reserved' }),
      ]);

      const res = await request(app)
        .get('/api/admin/users/owner-1/spend/breakdown')
        .query({ month: '2026-09' });

      expect(res.body.settledMicroUsd).toBe(10_000);
      expect(res.body.inFlightMicroUsd).toBe(90_000);
      expect(res.body.inFlight).toHaveLength(1);
      expect(res.body.inFlight[0].eventId).toBe('evt-r');
    });

    // AC6: a slice that silently drops rows makes the parts sum to less than the
    // whole, and the gap looks like missing spend rather than missing metadata.
    it('buckets a missing dimension explicitly instead of dropping the event', async () => {
      mockResolveBilling.mockResolvedValue('owner-1');
      mockListSpendEvents.mockResolvedValue([
        spendEvent({ costMicroUsd: 20_000, feature: undefined }),
      ]);

      const res = await request(app)
        .get('/api/admin/users/owner-1/spend/breakdown')
        .query({ month: '2026-09' });

      expect(res.body.byFeature).toHaveLength(1);
      expect(res.body.byFeature[0].key).toBe('(unattributed)');
      expect(res.body.byFeature[0].settledMicroUsd).toBe(20_000);
      // bySession has no session on this event either -- same rule.
      expect(res.body.bySession[0].key).toBe('(unattributed)');
    });

    // AC5: absence must be stated, not rendered as a zero-dollar month.
    it('returns an explicit empty breakdown for a month with no events', async () => {
      mockResolveBilling.mockResolvedValue('owner-1');
      mockListSpendEvents.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/admin/users/owner-1/spend/breakdown')
        .query({ month: '2026-09' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          settledMicroUsd: 0,
          eventCount: 0,
          daily: [],
          byProvider: [],
          inFlight: [],
        }),
      );
    });

    it('500s when the ledger read throws', async () => {
      mockResolveBilling.mockResolvedValue('owner-1');
      mockListSpendEvents.mockRejectedValue(new Error('dynamo down'));

      const res = await request(app)
        .get('/api/admin/users/owner-1/spend/breakdown')
        .query({ month: '2026-09' });

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/Failed to build spend breakdown/i);
    });
  });

  describe('GET /api/admin/users/:userId/usage/by-model-day', () => {
    it('400s when start/end are missing or malformed', async () => {
      await request(app).get('/api/admin/users/u1/usage/by-model-day').expect(400);
      await request(app)
        .get('/api/admin/users/u1/usage/by-model-day?start=June&end=2026-06-30')
        .expect(400);
      expect(mockByModelDay).not.toHaveBeenCalled();
    });

    it('400s when start > end', async () => {
      await request(app)
        .get('/api/admin/users/u1/usage/by-model-day?start=2026-06-30&end=2026-06-01')
        .expect(400);
      expect(mockByModelDay).not.toHaveBeenCalled();
    });

    it('403s for non-admin users', async () => {
      mockAuth.mockImplementation((req: any, _res: any, next: any) => {
        req.user = { userId: 'basic-1', email: 'basic@example.com', isAdmin: false };
        next();
      });
      await request(app)
        .get('/api/admin/users/u1/usage/by-model-day?start=2026-06-01&end=2026-06-30')
        .expect(403);
      expect(mockByModelDay).not.toHaveBeenCalled();
    });

    it('returns the analytics payload for valid requests', async () => {
      const payload = { userId: 'u1', start: '2026-06-01', end: '2026-06-30', rows: [], totals: {} };
      mockByModelDay.mockResolvedValue(payload);

      const res = await request(app)
        .get('/api/admin/users/u1/usage/by-model-day?start=2026-06-01&end=2026-06-30')
        .expect(200);

      expect(res.body).toEqual(payload);
      expect(mockByModelDay).toHaveBeenCalledWith('u1', '2026-06-01', '2026-06-30');
    });

    it('500s (with a message) when the service throws', async () => {
      mockByModelDay.mockRejectedValue(new Error('dynamo down'));
      const res = await request(app)
        .get('/api/admin/users/u1/usage/by-model-day?start=2026-06-01&end=2026-06-30')
        .expect(500);
      expect(res.body.message).toBe('Failed to load usage');
      expect(res.body.error).toBe('dynamo down');
    });

    it('500s with "Unknown error" when a non-Error value is thrown', async () => {
      // The catch block does `error instanceof Error ? error.message : "Unknown error"`.
      // Rejecting with a non-Error exercises the falsy side of that ternary.
      mockByModelDay.mockRejectedValue('plain string failure');
      const res = await request(app)
        .get('/api/admin/users/u1/usage/by-model-day?start=2026-06-01&end=2026-06-30')
        .expect(500);
      expect(res.body.message).toBe('Failed to load usage');
      expect(res.body.error).toBe('Unknown error');
    });
  });

  describe('GET /api/admin/users/:userId/usage/comparison', () => {
    it('400s when month is missing or malformed', async () => {
      await request(app).get('/api/admin/users/u1/usage/comparison').expect(400);
      await request(app).get('/api/admin/users/u1/usage/comparison?month=2026-6').expect(400);
      expect(mockComparison).not.toHaveBeenCalled();
    });

    it('returns the comparison payload for valid requests', async () => {
      const payload = {
        userId: 'u1',
        month: '2026-06',
        shadow: { totalTokens: 10, costUsd: 0.1, callCount: 2 },
        legacy: { totalTokens: 8, costUsd: 0.08, source: 'current' },
        delta: { totalTokens: 2, costUsd: 0.02 },
      };
      mockComparison.mockResolvedValue(payload);

      const res = await request(app)
        .get('/api/admin/users/u1/usage/comparison?month=2026-06')
        .expect(200);

      expect(res.body).toEqual(payload);
      expect(mockComparison).toHaveBeenCalledWith('u1', '2026-06');
    });

    it('500s when the service throws', async () => {
      mockComparison.mockRejectedValue(new Error('boom'));
      const res = await request(app)
        .get('/api/admin/users/u1/usage/comparison?month=2026-06')
        .expect(500);
      expect(res.body.message).toBe('Failed to load usage comparison');
      expect(res.body.error).toBe('boom');
    });

    it('500s with "Unknown error" when a non-Error value is thrown', async () => {
      // Falsy side of `error instanceof Error ? error.message : "Unknown error"`.
      mockComparison.mockRejectedValue({ code: 'WEIRD' });
      const res = await request(app)
        .get('/api/admin/users/u1/usage/comparison?month=2026-06')
        .expect(500);
      expect(res.body.message).toBe('Failed to load usage comparison');
      expect(res.body.error).toBe('Unknown error');
    });
  });

  describe('GET /api/admin/users/:userId/usage/x-breakdown', () => {
    it('400s without valid start/end', async () => {
      await request(app)
        .get('/api/admin/users/u1/usage/x-breakdown?start=nope&end=2026-07-31')
        .expect(400);
      expect(mockXBreakdown).not.toHaveBeenCalled();
    });

    it('returns the per-user X breakdown for an admin', async () => {
      const payload = {
        userId: 'u1', start: '2026-07-01', end: '2026-07-31', costUsd: 0.065, callCount: 6,
        byOperation: [{ operation: 'search_tweets', callCount: 5, quantity: 10, costUsd: 0.05 }],
      };
      mockXBreakdown.mockResolvedValue(payload);
      const res = await request(app)
        .get('/api/admin/users/u1/usage/x-breakdown?start=2026-07-01&end=2026-07-31')
        .expect(200);
      expect(res.body).toEqual(payload);
      expect(mockXBreakdown).toHaveBeenCalledWith('u1', '2026-07-01', '2026-07-31');
    });

    it('403s for non-admin users', async () => {
      mockAuth.mockImplementation((req: any, _res: any, next: any) => {
        req.user = { userId: 'basic-1', email: 'basic@example.com', isAdmin: false };
        next();
      });
      await request(app)
        .get('/api/admin/users/u1/usage/x-breakdown?start=2026-07-01&end=2026-07-31')
        .expect(403);
      expect(mockXBreakdown).not.toHaveBeenCalled();
    });
  });

});
