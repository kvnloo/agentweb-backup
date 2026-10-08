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
  getUserXBreakdown: jest.fn(),
}));

// The spend-breakdown route (ENG-1250 §7) has no route-level coverage: the read
// model is unit-tested as pure functions, but the route's COMPOSITION -- billing
// resolution, guards, and stitching breakdown+allowance+projection+pause into one
// payload -- was asserted nowhere. Only the true boundaries are mocked below;
// spendReadModel and spendProjection run for real, so these exercise the
// composition rather than a restatement of it.
jest.mock('../../services/spendEventDb', () => {
  const listSpendEvents = jest.fn();
  return {
    listSpendEvents,
    // ENG-1841: the route reads through the bounded variant. Delegating to the
    // same mock keeps every existing test's event fixture in force; a test that
    // needs the ceiling overrides this.
    listSpendEventsBounded: jest.fn(async (...args: unknown[]) => ({ events: await listSpendEvents(...args.slice(0, 3)), exceeded: false })),
  };
});
const mockAggregateRows = jest.fn();
const mockQueryByBillingScan = jest.fn();
jest.mock('../../services/usageRecordDb', () => ({
  ...jest.requireActual('../../services/usageRecordDb'),
  usageRecordDb: {
    queryByUserDateRange: (...a: unknown[]) => mockAggregateRows(...a),
    queryByBillingUserDateRange: (...a: unknown[]) => mockQueryByBillingScan(...a),
  },
}));
jest.mock('../../services/tokenUsageService', () => ({ resolveBillingUserId: jest.fn(), checkTokenUsage: jest.fn() }));
jest.mock('../../services/db', () => ({ userDb: { getUserById: jest.fn() }, orgDb: { getOrgMembers: jest.fn() } }));
jest.mock('../../services/subscriptionService', () => ({ getSubscriptionTypeConfig: jest.fn() }));
jest.mock('../../services/llmUsageCreditService', () => ({ getLlmUsageCreditAdjustment: jest.fn() }));

import adminUsageRoutes, { AGGREGATE_READ_CONCURRENCY, SPEND_BREAKDOWN_MAX_EVENTS, SPEND_BREAKDOWN_ROWS_PER_CUT } from '../adminUsage';
import { authenticateToken } from '../../middleware/auth';
import {
  getUserUsageByModelDay,
  getUserXBreakdown,
} from '../../services/usageAnalyticsService';
import { listSpendEvents, listSpendEventsBounded } from '../../services/spendEventDb';
import { checkTokenUsage, resolveBillingUserId } from '../../services/tokenUsageService';
import { orgDb, userDb } from '../../services/db';
import { getSubscriptionTypeConfig } from '../../services/subscriptionService';
import { getLlmUsageCreditAdjustment } from '../../services/llmUsageCreditService';

const mockByModelDay = getUserUsageByModelDay as jest.Mock;
const mockXBreakdown = getUserXBreakdown as jest.Mock;
const mockAuth = authenticateToken as unknown as jest.Mock;
const mockListSpendEvents = listSpendEvents as jest.Mock;
const mockListSpendEventsBounded = listSpendEventsBounded as jest.Mock;
const mockResolveBilling = resolveBillingUserId as jest.Mock;
const mockCheckTokenUsage = checkTokenUsage as jest.Mock;
const mockGetUserById = userDb.getUserById as jest.Mock;
const mockOrgMembers = orgDb.getOrgMembers as jest.Mock;
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
      mockAggregateRows.mockResolvedValue([]);
      mockCheckTokenUsage.mockResolvedValue({
        allowed: true, warning: false, used: 0, allowance: null, bonus: 0, effectiveAllowance: null,
        percentUsed: 0, month: '2026-09', costUsed: 12.5, costAllowance: 200, costPercentUsed: 6.25,
        costEnforced: true, usageMode: 'full_choice', usagePolicyVersion: 'v1', alertThresholds: {},
      });
    });

    // ENG-1886: the real pause decision, straight from the enforcer.
    describe('enforcement state', () => {
      beforeEach(() => mockResolveBilling.mockResolvedValue('owner-1'));

      it('asks the enforcer about the BILLING subject, and returns its decision re-labelled', async () => {
        mockCheckTokenUsage.mockResolvedValueOnce({
          allowed: false, warning: false, used: 0, allowance: null, bonus: 0, effectiveAllowance: null,
          percentUsed: 0, month: '2026-09', costUsed: 204.1, costAllowance: 200, costPercentUsed: 102.05,
          costEnforced: true, usageMode: 'paused', usagePolicyVersion: 'v1', alertThresholds: {},
        });

        const res = await request(app).get('/api/admin/users/member-1/spend/breakdown').query({ month: '2026-09' });

        expect(mockCheckTokenUsage).toHaveBeenCalledWith('owner-1');
        expect(res.body.enforcement).toEqual({
          available: true, month: '2026-09', paused: true, usageMode: 'paused', gatedBy: 'cost',
          used: 204.1, limit: 200, percentUsed: 102.05, resetsOn: '2026-10-01', usagePolicyVersion: 'v1',
        });
      });

      it('reports a past month as not available rather than inferring a pause', async () => {
        const res = await request(app).get('/api/admin/users/owner-1/spend/breakdown').query({ month: '2026-08' });

        expect(res.body.enforcement).toEqual({ available: false, reason: 'not-current-month', currentMonth: '2026-09' });
      });

      it('a failed enforcer read degrades to unreadable — the breakdown still returns', async () => {
        mockCheckTokenUsage.mockRejectedValueOnce(new Error('User not found'));

        const res = await request(app).get('/api/admin/users/owner-1/spend/breakdown').query({ month: '2026-09' });

        expect(res.status).toBe(200);
        expect(res.body.enforcement).toMatchObject({ available: false, reason: 'unreadable' });
      });
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

    // ENG-1934 AC9: the allowance comparison is only honest beside what the
    // total covers, so the payload must say — measured, not assumed.
    describe('LLM ledger coverage', () => {
      const llmEvent = (costMicroUsd: number, month = '2026-09') =>
        spendEvent({
          provider: 'bedrock', operation: 'anthropic.claude-opus-5', unit: 'llm_token', costMicroUsd,
          billingMonth: month, occurredAt: `${month}-20T10:00:00.000Z`,
        });
      const llmRow = (date: string, costMicroUsd: number) => ({
        userId: 'owner-1', sk: 'x', date, model: 'anthropic.claude-opus-5', feature: 'agent_task',
        costMicroUsd, callCount: 1, billingUserId: 'owner-1', updatedAt: '', ttl: 0, provider: 'bedrock',
        costSource: 'allocated',
      });

      beforeEach(() => mockResolveBilling.mockResolvedValue('owner-1'));

      it('does not read the aggregate rail for a month before LLM events existed', async () => {
        mockListSpendEvents.mockResolvedValue([]);

        const res = await request(app).get('/api/admin/users/owner-1/spend/breakdown').query({ month: '2026-08' });

        expect(res.body.llmLedger).toMatchObject({ startedOn: '2026-09-14', month: 'none', missingLlmMicroUsd: null });
        expect(mockAggregateRows).not.toHaveBeenCalled();
      });

      it('reads each partition that can hold the subject\'s rows by KEYED query — never a table scan', async () => {
        mockGetUserById.mockResolvedValue({ userId: 'owner-1', subscriptionType: 'Pro', orgId: 'org-1' });
        mockOrgMembers.mockResolvedValue([{ userId: 'owner-1' }, { userId: 'member-2' }]);
        mockListSpendEvents.mockResolvedValue([{ ...llmEvent(1_000_000), actingUserId: 'member-3' }]);
        mockAggregateRows.mockImplementation(async (actor: string) =>
          actor === 'member-2'
            ? [llmRow('2026-09-04', 3_000_000), { ...llmRow('2026-09-05', 7_000_000), billingUserId: 'someone-else' }]
            : actor === 'member-3'
              ? [llmRow('2026-09-20', 1_000_000)]
              : [],
        );

        const res = await request(app).get('/api/admin/users/member-1/spend/breakdown').query({ month: '2026-09' });

        expect(mockQueryByBillingScan).not.toHaveBeenCalled();
        // The owner, every current org member, and every acting user the ledger saw.
        expect(mockAggregateRows.mock.calls.map((c) => c[0]).sort()).toEqual(['member-2', 'member-3', 'owner-1']);
        expect(mockAggregateRows).toHaveBeenCalledWith('member-2', '2026-09-01', '2026-09-31');
        // The row billed to someone else in a member's partition is not this subject's spend.
        expect(res.body.llmLedger).toMatchObject({ month: 'partial', aggregateLlmMicroUsd: 4_000_000, missingLlmMicroUsd: 3_000_000 });
      });

      it('never runs more than AGGREGATE_READ_CONCURRENCY partition queries at once, and still reads them all', async () => {
        mockGetUserById.mockResolvedValue({ userId: 'owner-1', subscriptionType: 'Pro', orgId: 'org-1' });
        mockOrgMembers.mockResolvedValue(Array.from({ length: 30 }, (_, i) => ({ userId: `m-${i}` })));
        mockListSpendEvents.mockResolvedValue([]);
        let inFlight = 0;
        let peak = 0;
        mockAggregateRows.mockImplementation(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setImmediate(r));
          inFlight -= 1;
          return [];
        });

        await request(app).get('/api/admin/users/owner-1/spend/breakdown').query({ month: '2026-09' });

        expect(mockAggregateRows).toHaveBeenCalledTimes(31);
        expect(peak).toBeLessThanOrEqual(AGGREGATE_READ_CONCURRENCY);
        expect(peak).toBeGreaterThan(1);
      });

      it('is full when the two rails agree', async () => {
        mockListSpendEvents.mockResolvedValue([llmEvent(1_000_000, '2026-10')]);
        // The acting member's partition holds the row; the owner's is empty.
        mockAggregateRows.mockImplementation(async (actor: string) =>
          actor === 'member-1' ? [llmRow('2026-10-02', 1_000_000)] : [],
        );

        const res = await request(app).get('/api/admin/users/owner-1/spend/breakdown').query({ month: '2026-10' });

        expect(res.body.llmLedger).toMatchObject({ month: 'full', missingLlmMicroUsd: 0 });
      });

      it('degrades to partial — not a 500, not full — when the aggregate read fails', async () => {
        mockListSpendEvents.mockResolvedValue([llmEvent(1_000_000, '2026-10')]);
        mockAggregateRows.mockRejectedValue(new Error('throttled'));

        const res = await request(app).get('/api/admin/users/owner-1/spend/breakdown').query({ month: '2026-10' });

        expect(res.status).toBe(200);
        expect(res.body.llmLedger).toMatchObject({ month: 'partial', missingLlmMicroUsd: null });
      });
    });

    // ENG-1841: bounded read and bounded rows, exact totals.
    describe('bounds (ENG-1841)', () => {
      beforeEach(() => mockResolveBilling.mockResolvedValue('owner-1'));

      it('reads with a ceiling, and answers 422 rather than a truncated total when it is exceeded', async () => {
        mockListSpendEventsBounded.mockResolvedValueOnce({ events: [spendEvent()], exceeded: true });

        const res = await request(app).get('/api/admin/users/owner-1/spend/breakdown').query({ month: '2026-09' });

        expect(mockListSpendEventsBounded).toHaveBeenCalledWith('owner-1', '2026-09-01', '2026-09-31', SPEND_BREAKDOWN_MAX_EVENTS);
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ code: 'spend_breakdown_too_large', eventLimit: SPEND_BREAKDOWN_MAX_EVENTS });
        expect(res.body).not.toHaveProperty('settledMicroUsd');
      });

      it('bounds each detail list but keeps every total over the whole month', async () => {
        const sessions = SPEND_BREAKDOWN_ROWS_PER_CUT + 7;
        mockListSpendEvents.mockResolvedValue(
          Array.from({ length: sessions }, (_, i) =>
            spendEvent({ eventId: `e${i}`, costMicroUsd: 1_000, references: { sessionId: `s${i}` } }),
          ),
        );

        const res = await request(app).get('/api/admin/users/owner-1/spend/breakdown').query({ month: '2026-09' });

        expect(res.status).toBe(200);
        expect(res.body.settledMicroUsd).toBe(sessions * 1_000);
        expect(res.body.eventCount).toBe(sessions);
        expect(res.body.bySession).toHaveLength(SPEND_BREAKDOWN_ROWS_PER_CUT);
        expect(res.body.omitted.bySession).toEqual({ rows: 7, eventCount: 7, settledMicroUsd: 7_000, reservedMicroUsd: 0 });
        // Listed + omitted reproduces the total exactly.
        const listed = res.body.bySession.reduce((t: number, r: any) => t + r.settledMicroUsd, 0);
        expect(listed + res.body.omitted.bySession.settledMicroUsd).toBe(res.body.settledMicroUsd);
      });
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
