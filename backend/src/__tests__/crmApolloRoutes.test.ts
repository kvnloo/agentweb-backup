/**
 * Tests for the bulk Apollo enrichment route's per-user lock.
 * Covers C6 — replays of POST /lists/:listId/leads/enrich-with-apollo
 * during an in-flight job must return 409, not multiply background workers.
 */
import request from 'supertest';
import express from 'express';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u1', email: 'u1@example.com' };
    next();
  },
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadsByListId: jest.fn(),
    updateLead: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
}));

const mockApollo = {
  matchPerson: jest.fn(),
};
jest.mock('../services/apolloService', () => ({
  isApolloServiceReady: () => true,
  getApolloService: () => mockApollo,
}));

import crmApolloRouter, { __resetBulkEnrichLockForTesting } from '../routes/crmApollo';
import { crmDb } from '../services/db';
import { authenticateToken } from '../middleware/auth';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

const app = express();
app.use(express.json());
app.use('/api/crm', authenticateToken, crmApolloRouter);

beforeEach(() => {
  jest.clearAllMocks();
  __resetBulkEnrichLockForTesting();
});

describe('POST /api/crm/lists/:listId/leads/enrich-with-apollo — lock (C6)', () => {
  it('returns 409 when a bulk enrich is already running for the same (user, list)', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [{ leadId: '1', linkedin: 'https://linkedin.com/in/x' }],
      lastEvaluatedKey: undefined,
    } as any);
    // Slow Apollo call so the first request's background job stays in-flight.
    mockApollo.matchPerson.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ found: false } as any), 100)),
    );

    const first = await request(app).post('/api/crm/lists/L1/leads/enrich-with-apollo').send({});
    expect(first.status).toBe(202);

    // The first 202 was sent before the background fan-out resolves; the lock
    // is still held by the in-flight matchPerson call.
    const second = await request(app).post('/api/crm/lists/L1/leads/enrich-with-apollo').send({});
    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/already running|in progress/i);

    // Let the background drain so the lock releases before the next test.
    await new Promise((r) => setTimeout(r, 150));
  });

  it('allows a new bulk enrich after the previous one finishes', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: undefined } as any);

    const first = await request(app).post('/api/crm/lists/L1/leads/enrich-with-apollo').send({});
    expect(first.status).toBe(202);

    // Yield so the background runs to completion (no leads → resolves immediately).
    await new Promise((r) => setImmediate(r));

    const second = await request(app).post('/api/crm/lists/L1/leads/enrich-with-apollo').send({});
    expect(second.status).toBe(202);
  });

  it('locks per (userId, listId), so different lists for the same user can run in parallel', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
    mockCrmDb.getLeadsByListId.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ items: [], lastEvaluatedKey: undefined } as any), 50)),
    );

    const a = await request(app).post('/api/crm/lists/LIST_A/leads/enrich-with-apollo').send({});
    expect(a.status).toBe(202);
    // Different listId — lock key differs, second request goes through.
    const b = await request(app).post('/api/crm/lists/LIST_B/leads/enrich-with-apollo').send({});
    expect(b.status).toBe(202);

    await new Promise((r) => setTimeout(r, 80));
  });
});
