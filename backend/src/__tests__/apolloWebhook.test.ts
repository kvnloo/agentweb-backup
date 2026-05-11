/**
 * Tests for the Apollo waterfall webhook handler.
 *
 * Covers:
 *   - Path-based auth via /api/crm/webhooks/apollo/<secret>
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
    setLeadEmailIfMissing: jest.fn(),
    putEnrichmentCacheItem: jest.fn(),
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
  it('returns 404 when no path secret is supplied (route does not match)', async () => {
    const res = await request(app).post('/api/crm/webhooks/apollo').send({ request_id: 'r1' });
    expect(res.status).toBe(404);
    expect(mockCrmDb.getEnrichmentCacheItem).not.toHaveBeenCalled();
  });

  it('rejects with 401 when path secret is wrong (different length)', async () => {
    const res = await request(app)
      .post('/api/crm/webhooks/apollo/short')
      .send({ request_id: 'r1' });
    expect(res.status).toBe(401);
    expect(mockCrmDb.getEnrichmentCacheItem).not.toHaveBeenCalled();
  });

  it('rejects with 401 when path secret is wrong (same length)', async () => {
    const wrong = 'X'.repeat(SECRET.length);
    const res = await request(app)
      .post(`/api/crm/webhooks/apollo/${wrong}`)
      .send({ request_id: 'r1' });
    expect(res.status).toBe(401);
  });

  it('rejects with 503 when the secret cannot be loaded', async () => {
    mockGetWebhookSecret.mockRejectedValue(new Error('SM down'));
    const res = await request(app)
      .post(`/api/crm/webhooks/apollo/${SECRET}`)
      .send({ request_id: 'r1' });
    expect(res.status).toBe(503);
  });

  it('ignores the legacy X-Apollo-Webhook-Secret header (path is the source of truth)', async () => {
    // Header form is dead — Apollo never echoed it back. Sending it with no
    // path secret must not authenticate the request.
    const res = await request(app)
      .post('/api/crm/webhooks/apollo')
      .set('X-Apollo-Webhook-Secret', SECRET)
      .send({ request_id: 'r1' });
    expect(res.status).toBe(404);
  });

  it('does NOT accept the secret via a ?secret= query param', async () => {
    const res = await request(app)
      .post(`/api/crm/webhooks/apollo?secret=${encodeURIComponent(SECRET)}`)
      .send({ request_id: 'r1' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/crm/webhooks/apollo — payload handling', () => {
  function send(body: any) {
    return request(app)
      .post(`/api/crm/webhooks/apollo/${SECRET}`)
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

  it('writes the email via the conditional setLeadEmailIfMissing path', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
      cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
    } as any);
    (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue({ listId: 'L1', userId: 'u1' });
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'LD1', email: '', enrichmentMetadata: {},
    } as any);
    (mockCrmDb as any).setLeadEmailIfMissing.mockResolvedValue({ written: true });

    const res = await send({ request_id: 'r1', person: { email: 'apollo@b.com', email_status: 'verified' } });
    expect(res.status).toBe(200);
    expect(res.body.written).toBe(true);
    // Must NOT call the unconditional updateLead path.
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
    expect((mockCrmDb as any).setLeadEmailIfMissing).toHaveBeenCalledTimes(1);
    const [listId, leadId, email, meta] = (mockCrmDb as any).setLeadEmailIfMissing.mock.calls[0];
    expect(listId).toBe('L1');
    expect(leadId).toBe('LD1');
    expect(email).toBe('apollo@b.com');
    expect(meta.confidence).toBe('high');
    expect(meta.apolloRequestId).toBe('r1');
  });

  it('reports written:false when the conditional update silently lost the race', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
      cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
    } as any);
    (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue({ listId: 'L1', userId: 'u1' });
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'LD1', email: '', enrichmentMetadata: {},
    } as any);
    // Simulate Tier 1/2/4 filling the email between our read and DDB conditional.
    (mockCrmDb as any).setLeadEmailIfMissing.mockResolvedValue({ written: false });

    const res = await send({ request_id: 'r1', person: { email: 'apollo@b.com' } });
    expect(res.status).toBe(200);
    expect(res.body.written).toBe(false);
    // Still 200 — the lead has an email, the request was attributed, the
    // result just didn't apply (which is fine).
  });

  // The shape Apollo actually sends for run_waterfall_email — captured live
  // 2026-05-08. The flat `person.email` shape we previously read never appears
  // here in async mode, so the route used to silently lose every Tier 3 hit.
  describe('async waterfall payload shape', () => {
    function emptyLeadFixtures() {
      mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
        cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
      } as any);
      (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue({ listId: 'L1', userId: 'u1' });
      mockCrmDb.getLeadById.mockResolvedValue({
        leadId: 'LD1', email: '', enrichmentMetadata: {},
      } as any);
      (mockCrmDb as any).setLeadEmailIfMissing.mockResolvedValue({ written: true });
    }

    it('extracts email + verified status from people[].waterfall.emails[].vendors[]', async () => {
      emptyLeadFixtures();
      const res = await send({
        request_id: 'r1',
        people: [{
          id: 'p1',
          waterfall: {
            emails: [{
              vendors: [
                { name: 'FindyMail', status: 'SKIPPED', emails: [], usedForVerification: false },
                { name: 'Apollo', status: 'VERIFIED', emails: ['ruiw@agentweb.pro'], usedForVerification: false },
                { name: 'ZeroBounce', status: 'validated', usedForVerification: true },
              ],
            }],
          },
        }],
      });
      expect(res.status).toBe(200);
      expect(res.body.written).toBe(true);
      const [, , email, meta] = (mockCrmDb as any).setLeadEmailIfMissing.mock.calls[0];
      expect(email).toBe('ruiw@agentweb.pro');
      expect(meta.confidence).toBe('high');
    });

    it('upgrades to verified/high when a verifier reports validated even if finder is GUESSED', async () => {
      emptyLeadFixtures();
      const res = await send({
        request_id: 'r1',
        people: [{
          waterfall: {
            emails: [{
              vendors: [
                { name: 'FindyMail', status: 'GUESSED', emails: ['guess@b.com'], usedForVerification: false },
                { name: 'ZeroBounce', status: 'validated', usedForVerification: true },
              ],
            }],
          },
        }],
      });
      expect(res.status).toBe(200);
      const [, , email, meta] = (mockCrmDb as any).setLeadEmailIfMissing.mock.calls[0];
      expect(email).toBe('guess@b.com');
      expect(meta.confidence).toBe('high');
    });

    it('returns hadEmail:false when every finder vendor SKIPPED with empty emails[]', async () => {
      emptyLeadFixtures();
      const res = await send({
        request_id: 'r1',
        people: [{
          waterfall: {
            emails: [{
              vendors: [
                { name: 'FindyMail', status: 'SKIPPED', emails: [] },
                { name: 'Apollo', status: 'SKIPPED', emails: [] },
              ],
            }],
          },
        }],
      });
      expect(res.status).toBe(200);
      expect(res.body.hadEmail).toBe(false);
      expect((mockCrmDb as any).setLeadEmailIfMissing).not.toHaveBeenCalled();
    });

    it('passes force:true on the placeholder put — without it ConditionExpression silently no-ops the update', async () => {
      // Regression: putEnrichmentCacheItem defaults to ConditionExpression
      // "attribute_not_exists(canonicalId) OR expiresAt < :now". Since the
      // placeholder was written by Tier 3 and is fresh (TTL 7d), the put
      // would silently fail with ConditionalCheckFailedException unless
      // force:true is passed. This test pins that contract.
      const placeholderRow = {
        canonicalId: 'cid', fieldGroup: 'sk',
        cacheType: 'apollo' as const,
        rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1', status: 'pending' },
      };
      mockCrmDb.getEnrichmentCacheItem.mockResolvedValue(placeholderRow as any);
      (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue({ listId: 'L1', userId: 'u1' });
      mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'LD1', email: '', enrichmentMetadata: {} } as any);
      (mockCrmDb as any).setLeadEmailIfMissing.mockResolvedValue({ written: true });
      (mockCrmDb as any).putEnrichmentCacheItem.mockResolvedValue(undefined);

      await send({
        request_id: 'r1',
        people: [{ waterfall: { emails: [{ vendors: [
          { name: 'Apollo', status: 'VERIFIED', emails: ['ok@x.com'] },
        ] }] } }],
      });
      const callArgs = (mockCrmDb as any).putEnrichmentCacheItem.mock.calls[0];
      expect(callArgs[1]).toEqual(expect.objectContaining({ force: true }));
    });

    it('stamps rawData.result onto the placeholder so the waterfall poller sees the email', async () => {
      const placeholderRow = {
        canonicalId: 'cid', fieldGroup: 'sk',
        cacheType: 'apollo' as const,
        rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1', status: 'pending' },
      };
      mockCrmDb.getEnrichmentCacheItem.mockResolvedValue(placeholderRow as any);
      (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue({ listId: 'L1', userId: 'u1' });
      mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'LD1', email: '', enrichmentMetadata: {} } as any);
      (mockCrmDb as any).setLeadEmailIfMissing.mockResolvedValue({ written: true });
      (mockCrmDb as any).putEnrichmentCacheItem.mockResolvedValue(undefined);

      const res = await send({
        request_id: 'r1',
        people: [{
          waterfall: { emails: [{ vendors: [
            { name: 'Apollo', status: 'VERIFIED', emails: ['polled@x.com'] },
            { name: 'ZeroBounce', status: 'validated', usedForVerification: true },
          ] }] },
        }],
      });
      expect(res.status).toBe(200);
      expect((mockCrmDb as any).putEnrichmentCacheItem).toHaveBeenCalled();
      const written = (mockCrmDb as any).putEnrichmentCacheItem.mock.calls[0][0];
      expect(written.rawData.status).toBe('completed');
      expect(written.rawData.result.email).toBe('polled@x.com');
      expect(written.rawData.result.emailStatus).toBe('verified');
      // Original placeholder fields preserved (listId/leadId/userId untouched).
      expect(written.rawData.listId).toBe('L1');
      expect(written.rawData.leadId).toBe('LD1');
      expect(written.rawData.userId).toBe('u1');
    });

    it('stamps no_email status when payload yields no email (broker chain dry)', async () => {
      const placeholderRow = {
        canonicalId: 'cid', fieldGroup: 'sk',
        cacheType: 'apollo' as const,
        rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1', status: 'pending' },
      };
      mockCrmDb.getEnrichmentCacheItem.mockResolvedValue(placeholderRow as any);
      (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue({ listId: 'L1', userId: 'u1' });
      mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'LD1', email: '', enrichmentMetadata: {} } as any);
      (mockCrmDb as any).putEnrichmentCacheItem.mockResolvedValue(undefined);

      const res = await send({
        request_id: 'r1',
        people: [{ waterfall: { emails: [{ vendors: [
          { name: 'Apollo', status: 'SKIPPED', emails: [] },
        ] }] } }],
      });
      expect(res.status).toBe(200);
      expect(res.body.hadEmail).toBe(false);
      expect((mockCrmDb as any).putEnrichmentCacheItem).toHaveBeenCalled();
      const written = (mockCrmDb as any).putEnrichmentCacheItem.mock.calls[0][0];
      expect(written.rawData.status).toBe('no_email');
      expect(written.rawData.result.status).toBe('no_email');
    });

    it('picks the first finder vendor with a non-empty emails[] (preserves chain order)', async () => {
      emptyLeadFixtures();
      const res = await send({
        request_id: 'r1',
        people: [{
          waterfall: {
            emails: [{
              vendors: [
                { name: 'Apollo', status: 'VERIFIED', emails: ['first@b.com'] },
                { name: 'Hunter', status: 'VERIFIED', emails: ['second@b.com'] },
              ],
            }],
          },
        }],
      });
      const [, , email] = (mockCrmDb as any).setLeadEmailIfMissing.mock.calls[0];
      expect(email).toBe('first@b.com');
    });
  });
});

describe('POST /api/crm/webhooks/apollo — ownership reverification (C1)', () => {
  function send(body: any) {
    return request(app)
      .post(`/api/crm/webhooks/apollo/${SECRET}`)
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
