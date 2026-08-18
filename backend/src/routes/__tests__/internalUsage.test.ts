/**
 * Tests for the internal usage-ingestion route (routes/internalUsage.ts).
 *
 * The agent-engine POSTs a batch of usage records at task end; the route
 * validates the batch and forwards each record to usageRecorderService.
 */

import express from 'express';
import request from 'supertest';

// Pass-through auth by default; individual tests flip behavior.
jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', email: 'user1@example.com', isAdmin: false };
    next();
  }),
}));

jest.mock('../../services/usageRecorderService', () => ({
  // ENG-1134: the route now prices each record to compute its quota charge, so
  // computeCostMicroUsd must stay real. Stubbing the whole module made every
  // request throw "computeCostMicroUsd is not a function" — which then surfaced
  // as the 500-path assertions failing with the wrong message.
  ...jest.requireActual('../../services/usageRecorderService'),
  recordUsage: jest.fn(),
}));
jest.mock('../../services/tokenUsageService', () => ({
  incrementUserTokenUsage: jest.fn().mockResolvedValue(undefined),
  // ENG-1251 Greptile P1: internalUsage.ts now resolves each contributing
  // actor's billing owner before recording the ledger row. Defaults to
  // "same as input" (no pooling) so every existing test in this file keeps
  // its current behavior unless a test opts into a different resolution.
  resolveBillingUserId: jest.fn((userId: string) => Promise.resolve(userId)),
}));
// ENG-1251 Greptile P1 ("Coverage suppresses unrelated aggregate usage"): for
// a CHARGED record, the route no longer writes its ledger row via plain
// recordUsage() at all in the steady state -- it writes the ledger
// contribution and the paired charge event atomically via
// usageRecordDb.incrementUsageWithChargeEvent(). Without this mock, every
// test in this file that submits a userId-attributed record silently hits
// the real, unmocked AWS SDK, which fails fast in this test env and is
// caught by the route's own try/catch, defaulting to the "conflict/error"
// fallback path. That made every existing assertion pass for the wrong
// reason. Default to "applied" (clean, non-atomic-fallback happy path) so
// existing behavior is unaffected; tests that care about the
// duplicate/conflict/fallback paths override this per-call. recordUsage()
// itself is now only reached for uncharged ("system") records and the
// conflict/error fallback -- see internalUsage.charging.test.ts for the
// atomic function's own coverage and the fallback paths' coverage.
const mockIncrementUsageWithChargeEvent = jest.fn().mockResolvedValue('applied');
jest.mock('../../services/usageRecordDb', () => ({
  usageRecordDb: {
    incrementUsageWithChargeEvent: (...args: unknown[]) => mockIncrementUsageWithChargeEvent(...args),
  },
}));

import internalUsageRoutes from '../internalUsage';
import { authenticateToken } from '../../middleware/auth';
import { recordUsage } from '../../services/usageRecorderService';

const mockAuth = authenticateToken as unknown as jest.Mock;
const mockRecordUsage = recordUsage as jest.Mock;

let app: express.Application;

const validRecord = {
  userId: 'user-1',
  taskId: 'task-42',
  model: 'anthropic.claude-sonnet-4-6',
  provider: 'anthropic',
  inputTokens: 1000,
  outputTokens: 250,
  cacheReadTokens: 100,
  feature: 'agent_task',
};

describe('POST /api/internal/usage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockImplementation((req: any, _res: any, next: any) => {
      req.user = { userId: 'user-1', email: 'user1@example.com', isAdmin: false };
      next();
    });
    mockRecordUsage.mockResolvedValue(undefined);
    mockIncrementUsageWithChargeEvent.mockResolvedValue('applied');
    app = express();
    app.use(express.json());
    app.use('/api/internal', internalUsageRoutes);
  });

  it('401s when the token is rejected', async () => {
    mockAuth.mockImplementation((_req: any, res: any) =>
      res.status(401).json({ message: 'Invalid token' })
    );
    await request(app)
      .post('/api/internal/usage')
      .send({ records: [validRecord] })
      .expect(401);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('400s when records is missing, empty, or not an array', async () => {
    await request(app).post('/api/internal/usage').send({}).expect(400);
    await request(app).post('/api/internal/usage').send({ records: [] }).expect(400);
    await request(app)
      .post('/api/internal/usage')
      .send({ records: 'not-an-array' })
      .expect(400);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('400s when there is no request body at all', async () => {
    // No body is sent and no JSON content-type, so express.json() leaves
    // req.body undefined — exercises the `(req.body || {})` fallback branch.
    await request(app).post('/api/internal/usage').expect(400);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('400s when the batch exceeds the size cap', async () => {
    const records = Array.from({ length: 501 }, () => ({ ...validRecord }));
    await request(app).post('/api/internal/usage').send({ records }).expect(400);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('skips malformed records but accepts valid ones in the same batch', async () => {
    const records = [
      validRecord,
      { ...validRecord, model: '' }, // missing model
      { ...validRecord, inputTokens: -5 }, // negative tokens
      { ...validRecord, outputTokens: 'lots' }, // non-numeric tokens
      null,
      'garbage',
    ];
    const res = await request(app)
      .post('/api/internal/usage')
      .send({ records })
      .expect(202);

    expect(res.body).toEqual({ accepted: 1, skipped: 5 });
    // The one valid record is charged (userId: 'user-1', not "system"), so
    // its ledger contribution goes through the atomic write, not recordUsage.
    expect(mockIncrementUsageWithChargeEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("forwards a valid record's ledger contribution via the atomic charge write, namespaced as engine spend", async () => {
    const minimal = {
      model: 'gemini-3.5-flash',
      inputTokens: 10,
      outputTokens: 5,
    };
    const res = await request(app)
      .post('/api/internal/usage')
      .send({ records: [validRecord, minimal] })
      .expect(202);

    expect(res.body).toEqual({ accepted: 2, skipped: 0 });
    // Two distinct models -> two distinct charge groups -> two atomic calls,
    // each pairing the ledger increment (1st arg) with its charge event (2nd).
    expect(mockIncrementUsageWithChargeEvent).toHaveBeenCalledTimes(2);
    expect(mockIncrementUsageWithChargeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        // ENG-1251 Greptile P1: billingUserId is now resolved per actor and
        // passed explicitly (default mock resolves to the same id -- no
        // pooling in this test).
        billingUserId: 'user-1',
        model: 'anthropic.claude-sonnet-4-6',
        provider: 'anthropic',
        feature: 'engine:agent_task',
        inputTokens: 1000,
        outputTokens: 250,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        costSource: 'allocated',
        calls: 1,
        // ENG-1251 Greptile P1: date is now captured once at the top of the
        // handler and shared with the paired charge event's occurredAt (both
        // must agree, or a UTC-midnight straddle breaks the itemization
        // reconciliation's key match). The value is today's date, which
        // this test doesn't control.
        date: expect.any(String),
      }),
      expect.objectContaining({
        billingUserId: 'user-1', actingUserId: 'user-1',
        model: 'anthropic.claude-sonnet-4-6', feature: 'engine:agent_task', calls: 1,
      })
    );
    expect(mockIncrementUsageWithChargeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        billingUserId: 'user-1',
        model: 'gemini-3.5-flash',
        provider: 'unknown',
        feature: 'engine:agent_task',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        calls: 1,
        date: expect.any(String),
      }),
      expect.objectContaining({ model: 'gemini-3.5-flash', feature: 'engine:agent_task' })
    );
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('forwards a valid cacheWriteTokens value instead of defaulting to 0', async () => {
    // validRecord omits cacheWriteTokens (defaults to 0). Provide a valid one
    // here to exercise the truthy side of the cacheWriteTokens ternary.
    const withCacheWrite = { ...validRecord, cacheWriteTokens: 42 };
    const res = await request(app)
      .post('/api/internal/usage')
      .send({ records: [withCacheWrite] })
      .expect(202);

    expect(res.body).toEqual({ accepted: 1, skipped: 0 });
    expect(mockIncrementUsageWithChargeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ cacheWriteTokens: 42, cacheReadTokens: 100 }),
      expect.anything()
    );
  });

  it('defaults cacheReadTokens to 0 when the value is invalid', async () => {
    // Provide a negative cacheReadTokens so isNonNegativeFiniteNumber returns
    // false — exercises the falsy side of the cacheReadTokens ternary.
    const badCacheRead = { ...validRecord, cacheReadTokens: -1 };
    const res = await request(app)
      .post('/api/internal/usage')
      .send({ records: [badCacheRead] })
      .expect(202);

    expect(res.body).toEqual({ accepted: 1, skipped: 0 });
    expect(mockIncrementUsageWithChargeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ cacheReadTokens: 0 }),
      expect.anything()
    );
  });

  it('re-attributes records claiming another userId to the authenticated user (non-admin)', async () => {
    const res = await request(app)
      .post('/api/internal/usage')
      .send({ records: [{ ...validRecord, userId: 'someone-else' }] })
      .expect(202);

    expect(res.body).toEqual({ accepted: 1, skipped: 0 });
    expect(mockIncrementUsageWithChargeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.anything()
    );
  });

  it('honors a foreign userId when the caller is an admin/service token', async () => {
    mockAuth.mockImplementation((req: any, _res: any, next: any) => {
      req.user = { userId: 'svc-1', email: 'svc@example.com', isAdmin: true };
      next();
    });
    await request(app)
      .post('/api/internal/usage')
      .send({ records: [{ ...validRecord, userId: 'customer-9' }] })
      .expect(202);

    expect(mockIncrementUsageWithChargeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'customer-9' }),
      expect.anything()
    );
  });

  it('500s (with a message) on unexpected failures', async () => {
    // A confirmed non-"applied"/"duplicate" outcome (the atomic call itself
    // throwing) falls back to the pre-atomic per-record recordUsage() path
    // -- so a genuine ledger-write failure now surfaces through THAT
    // fallback call, not the atomic call directly (which fails open by
    // design: see usageRecordDb.incrementUsageWithChargeEvent's docstring).
    mockIncrementUsageWithChargeEvent.mockRejectedValue(new Error('atomic write unavailable'));
    mockRecordUsage.mockRejectedValue(new Error('unexpected'));
    const res = await request(app)
      .post('/api/internal/usage')
      .send({ records: [validRecord] })
      .expect(500);
    expect(res.body.message).toBe('Failed to ingest usage records');
    expect(res.body.error).toBe('unexpected');
  });

  it('500s with "Unknown error" when a non-Error value is thrown', async () => {
    // Falsy side of `error instanceof Error ? error.message : "Unknown error"`.
    mockIncrementUsageWithChargeEvent.mockRejectedValue(new Error('atomic write unavailable'));
    mockRecordUsage.mockRejectedValue('boom-string');
    const res = await request(app)
      .post('/api/internal/usage')
      .send({ records: [validRecord] })
      .expect(500);
    expect(res.body.message).toBe('Failed to ingest usage records');
    expect(res.body.error).toBe('Unknown error');
  });
});
