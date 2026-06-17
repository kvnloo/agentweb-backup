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
  recordUsage: jest.fn(),
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
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
  });

  it('forwards a valid record to recordUsage with agent_task defaults', async () => {
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
    expect(mockRecordUsage).toHaveBeenCalledWith({
      userId: 'user-1',
      taskId: 'task-42',
      model: 'anthropic.claude-sonnet-4-6',
      provider: 'anthropic',
      feature: 'agent_task',
      inputTokens: 1000,
      outputTokens: 250,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    });
    expect(mockRecordUsage).toHaveBeenCalledWith({
      userId: 'user-1',
      taskId: undefined,
      model: 'gemini-3.5-flash',
      provider: 'unknown',
      feature: 'agent_task',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
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
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ cacheWriteTokens: 42, cacheReadTokens: 100 })
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
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ cacheReadTokens: 0 })
    );
  });

  it('re-attributes records claiming another userId to the authenticated user (non-admin)', async () => {
    const res = await request(app)
      .post('/api/internal/usage')
      .send({ records: [{ ...validRecord, userId: 'someone-else' }] })
      .expect(202);

    expect(res.body).toEqual({ accepted: 1, skipped: 0 });
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' })
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

    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'customer-9' })
    );
  });

  it('500s (with a message) on unexpected failures', async () => {
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
    mockRecordUsage.mockRejectedValue('boom-string');
    const res = await request(app)
      .post('/api/internal/usage')
      .send({ records: [validRecord] })
      .expect(500);
    expect(res.body.message).toBe('Failed to ingest usage records');
    expect(res.body.error).toBe('Unknown error');
  });
});
