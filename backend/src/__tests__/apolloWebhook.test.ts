/**
 * Tests for the Apollo waterfall webhook handler.
 *
 * Covers:
 *   - Header-based auth via X-Apollo-Webhook-Secret
 *   - Timing-safe compare (rejects wrong secrets, equal-length and not)
 *   - 503 when the secret can't load
 *   - Missing/invalid request_id
 *   - No placeholder cache row (replay or stale request_id)
 *   - Lead deleted before webhook arrives
 *   - Idempotent replay (apolloRequestId already stamped on the lead)
 *   - Successful write path
 */
import request from 'supertest';
import express from 'express';

const mockGetWebhookSecret = jest.fn();
jest.mock('../utils/secretsManager', () => ({
  getApolloWebhookSecret: () => mockGetWebhookSecret(),
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getEnrichmentCacheItem: jest.fn(),
    getLeadById: jest.fn(),
    updateLead: jest.fn(),
    getLeadListById: jest.fn(),
  },
}));

import apolloWebhookRouter from '../routes/apolloWebhook';
import { crmDb } from '../services/db';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

const app = express();
app.use(express.json());
app.use('/api/crm/webhooks/apollo', apolloWebhookRouter);

const SECRET = 'wh_secret_value_123';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetWebhookSecret.mockResolvedValue(SECRET);
  // Default ownership mock: list exists and is owned by u1 (matches the
  // userId stamped on placeholders in the happy-path fixtures).
  (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue({ listId: 'L1', userId: 'u1' });
});

describe('POST /api/crm/webhooks/apollo — auth', () => {
  it('rejects with 401 when secret header is missing', async () => {
    const res = await request(app).post('/api/crm/webhooks/apollo').send({ request_id: 'r1' });
    expect(res.status).toBe(401);
    expect(mockCrmDb.getEnrichmentCacheItem).not.toHaveBeenCalled();
  });

  it('rejects with 401 when secret header is wrong (different length)', async () => {
    const res = await request(app)
      .post('/api/crm/webhooks/apollo')
      .set('X-Apollo-Webhook-Secret', 'short')
      .send({ request_id: 'r1' });
    expect(res.status).toBe(401);
    expect(mockCrmDb.getEnrichmentCacheItem).not.toHaveBeenCalled();
  });

  it('rejects with 401 when secret header is wrong (same length)', async () => {
    const wrong = 'X'.repeat(SECRET.length);
    const res = await request(app)
      .post('/api/crm/webhooks/apollo')
      .set('X-Apollo-Webhook-Secret', wrong)
      .send({ request_id: 'r1' });
    expect(res.status).toBe(401);
  });

  it('rejects with 503 when the secret cannot be loaded', async () => {
    mockGetWebhookSecret.mockRejectedValue(new Error('SM down'));
    const res = await request(app)
      .post('/api/crm/webhooks/apollo')
      .set('X-Apollo-Webhook-Secret', SECRET)
      .send({ request_id: 'r1' });
    expect(res.status).toBe(503);
  });

  it('does NOT accept the secret via the legacy ?secret= query param', async () => {
    const res = await request(app)
      .post(`/api/crm/webhooks/apollo?secret=${encodeURIComponent(SECRET)}`)
      .send({ request_id: 'r1' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/crm/webhooks/apollo — payload handling', () => {
  function send(body: any) {
    return request(app)
      .post('/api/crm/webhooks/apollo')
      .set('X-Apollo-Webhook-Secret', SECRET)
      .send(body);
  }

  it('rejects with 400 when request_id is missing', async () => {
    const res = await send({ person: { email: 'a@b.com' } });
    expect(res.status).toBe(400);
  });

  it('returns 202 matched:false when no placeholder cache row exists', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue(null);
    const res = await send({ request_id: 'unknown-id', person: { email: 'a@b.com' } });
    expect(res.status).toBe(202);
    expect(res.body.matched).toBe(false);
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it('returns 202 leadDeleted:true when the lead has since been removed', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
      cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
    } as any);
    mockCrmDb.getLeadById.mockResolvedValue(null);
    const res = await send({ request_id: 'r1', person: { email: 'a@b.com' } });
    expect(res.status).toBe(202);
    expect(res.body.leadDeleted).toBe(true);
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it('is idempotent: returns alreadyProcessed when apolloRequestId matches', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
      cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
    } as any);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'LD1', email: 'old@b.com',
      enrichmentMetadata: { email: { apolloRequestId: 'r1' } },
    } as any);

    const res = await send({ request_id: 'r1', person: { email: 'new@b.com' } });
    expect(res.status).toBe(200);
    expect(res.body.alreadyProcessed).toBe(true);
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it('skips when lead already has a different email', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
      cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
    } as any);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'LD1', email: 'existing@b.com',
    } as any);

    const res = await send({ request_id: 'r1', person: { email: 'apollo@b.com', email_status: 'verified' } });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toMatch(/already has email/);
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it('writes the email and confidence metadata on the happy path', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
      cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
    } as any);
    (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue({ listId: 'L1', userId: 'u1' });
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'LD1', email: '', enrichmentMetadata: {},
    } as any);

    const res = await send({ request_id: 'r1', person: { email: 'apollo@b.com', email_status: 'verified' } });
    expect(res.status).toBe(200);
    expect(mockCrmDb.updateLead).toHaveBeenCalledTimes(1);
    const [listId, leadId, payload] = mockCrmDb.updateLead.mock.calls[0] as any;
    expect(listId).toBe('L1');
    expect(leadId).toBe('LD1');
    expect(payload.email).toBe('apollo@b.com');
    expect(payload.enrichmentMetadata.email.confidence).toBe('high');
    expect(payload.enrichmentMetadata.email.apolloRequestId).toBe('r1');
  });
});

describe('POST /api/crm/webhooks/apollo — ownership reverification (C1)', () => {
  function send(body: any) {
    return request(app)
      .post('/api/crm/webhooks/apollo')
      .set('X-Apollo-Webhook-Secret', SECRET)
      .send(body);
  }

  // All cases below use a real lead that WOULD be writable if ownership
  // wasn't enforced. The assertion that updateLead was NOT called is what
  // proves the ownership gate caught the request.
  beforeEach(() => {
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'LD1', email: '', enrichmentMetadata: {},
    } as any);
  });

  it('rejects when placeholder has no userId stamp (legacy/forged)', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
      cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1' /* no userId */ },
    } as any);
    const res = await send({ request_id: 'r1', person: { email: 'apollo@b.com' } });
    expect(res.body.matched).toBe(false);
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it('rejects when list owner no longer matches placeholder userId', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
      cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
    } as any);
    (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue({ listId: 'L1', userId: 'someone-else' });

    const res = await send({ request_id: 'r1', person: { email: 'apollo@b.com' } });
    expect(res.body.matched).toBe(false);
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it('rejects when the list itself has been deleted', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
      cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
    } as any);
    (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue(null);

    const res = await send({ request_id: 'r1', person: { email: 'apollo@b.com' } });
    expect(res.body.matched).toBe(false);
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });
});
