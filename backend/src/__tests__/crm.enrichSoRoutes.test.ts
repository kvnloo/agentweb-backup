// Tests for the enrich.so CRM routes:
//   POST /lists/:listId/leads/:leadId/validate-email
//   POST /leads/lookup-by-email

import request from 'supertest';
import express from 'express';

// ─── Mocks (must be set before importing the router) ─────────────────────────

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u1', email: 'u1@example.com' };
    next();
  },
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadById: jest.fn(),
    updateLead: jest.fn(),
    setLeadEmailValidation: jest.fn(),
    getLeadsByListId: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
  },
}));

jest.mock('../services/enrichSoLeadValidation', () => ({
  validateLeadsInBackground: jest.fn(),
}));

const mockEnrichSo = {
  validateEmail: jest.fn(),
  reverseLookup: jest.fn(),
  findEmail: jest.fn(),
};
jest.mock('../services/enrichSoService', () => ({
  getEnrichSoService: () => mockEnrichSo,
}));

import enrichSoRouter, { setQuotaTrackerForLookupRoute } from '../routes/crmEnrichSo';
import { crmDb } from '../services/db';
import { authenticateToken } from '../middleware/auth';
import { LookupByEmailQuotaExceededError } from '../services/enrichSoQuota';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

const app = express();
app.use(express.json());
app.use('/api/crm', authenticateToken, enrichSoRouter);

beforeEach(() => {
  jest.clearAllMocks();
  setQuotaTrackerForLookupRoute(null);
});

// ─── validate-email ──────────────────────────────────────────────────────────

describe('POST /api/crm/lists/:listId/leads/:leadId/validate-email', () => {
  it('returns 404 when list not found', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue(null);
    const res = await request(app).post('/api/crm/lists/L1/leads/LD1/validate-email');
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/lead list/i);
  });

  it('returns 403 when user cannot access list', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'someone-else' } as any);
    // userDb mocks return undefined → no orgId match
    const res = await request(app).post('/api/crm/lists/L1/leads/LD1/validate-email');
    expect(res.status).toBe(403);
  });

  it('returns 404 when lead not found', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
    mockCrmDb.getLeadById.mockResolvedValue(null);
    const res = await request(app).post('/api/crm/lists/L1/leads/LD1/validate-email');
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/lead not found/i);
  });

  it('returns 400 when lead has no email', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'LD1', email: '' } as any);
    const res = await request(app).post('/api/crm/lists/L1/leads/LD1/validate-email');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no email/i);
  });

  it('happy path: calls validateEmail with forceRefresh and persists result', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'LD1', email: 'a@b.com', customFields: {}, enrichmentMetadata: {},
    } as any);
    mockEnrichSo.validateEmail.mockResolvedValue({
      status: 'deliverable', confidence: 'high', isCatchAll: false,
      provider: 'GOOGLE', message: 'ok', fromCache: false, checkedAt: '2026-05-04T00:00:00Z',
    });

    const res = await request(app).post('/api/crm/lists/L1/leads/LD1/validate-email');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('deliverable');

    expect(mockEnrichSo.validateEmail).toHaveBeenCalledWith('a@b.com', { forceRefresh: true, userId: 'u1' });

    // M4 fix: targeted setLeadEmailValidation, not full updateLead
    expect(mockCrmDb.setLeadEmailValidation).toHaveBeenCalledTimes(1);
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
    const [, , validation, metadata] = mockCrmDb.setLeadEmailValidation.mock.calls[0] as any;
    expect(validation).toMatchObject({
      status: 'deliverable',
      confidence: 'high',
      isCatchAll: false,
    });
    expect(metadata).toMatchObject({
      source: 'web_search',
      confidence: 'high',
    });
  });

  it('M4: uses targeted DB write — does NOT read-modify-write customFields', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'LD1', email: 'a@b.com', customFields: { other: 'value' },
    } as any);
    mockEnrichSo.validateEmail.mockResolvedValue({
      status: 'risky', confidence: 'medium', isCatchAll: true, fromCache: false, checkedAt: '2026-05-04T00:00:00Z',
    });

    await request(app).post('/api/crm/lists/L1/leads/LD1/validate-email');

    // The whole point of the M4 fix: the route does NOT call updateLead({customFields: ...})
    // because that would clobber concurrent edits. Instead it calls the targeted DB method.
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
    expect(mockCrmDb.setLeadEmailValidation).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when service throws', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'LD1', email: 'a@b.com' } as any);
    mockEnrichSo.validateEmail.mockRejectedValue(new Error('quota'));

    const res = await request(app).post('/api/crm/lists/L1/leads/LD1/validate-email');
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/quota/);
  });
});

// ─── find-email ──────────────────────────────────────────────────────────────

describe('POST /api/crm/leads/find-email', () => {
  it('returns 400 when no name is provided', async () => {
    const res = await request(app).post('/api/crm/leads/find-email').send({ domain: 'acme.com' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/firstName|lastName/);
  });

  it('returns 400 when no domain or company', async () => {
    const res = await request(app).post('/api/crm/leads/find-email').send({ firstName: 'A', lastName: 'B' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/domain|company/);
  });

  it('returns 400 for malformed domain', async () => {
    const res = await request(app).post('/api/crm/leads/find-email').send({ firstName: 'A', lastName: 'B', domain: 'not-a-domain' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/domain/);
  });

  it('strips https:// and www. prefixes from domain', async () => {
    mockEnrichSo.findEmail.mockResolvedValue({ found: true, email: 'a@acme.com', confidence: 'high', fromCache: false, checkedAt: 'x' });
    const res = await request(app).post('/api/crm/leads/find-email').send({
      firstName: 'A', lastName: 'B', domain: 'https://www.acme.com/about',
    });
    expect(res.status).toBe(200);
    expect(mockEnrichSo.findEmail).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'acme.com' }),
      expect.any(Object),
    );
  });

  it('happy path: returns found result', async () => {
    mockEnrichSo.findEmail.mockResolvedValue({
      found: true, email: 'alice@acme.com', confidence: 'high', isCatchAll: false,
      fromCache: false, checkedAt: '2026-05-04',
    });
    const res = await request(app).post('/api/crm/leads/find-email').send({
      firstName: 'Alice', lastName: 'Smith', domain: 'acme.com',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ found: true, email: 'alice@acme.com', confidence: 'high' });
  });

  it('returns found:false when no email found', async () => {
    mockEnrichSo.findEmail.mockResolvedValue({ found: false, fromCache: false, checkedAt: 'x' });
    const res = await request(app).post('/api/crm/leads/find-email').send({
      firstName: 'A', lastName: 'B', company: 'Nowhere',
    });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
  });

  it('falls back to company when domain absent', async () => {
    mockEnrichSo.findEmail.mockResolvedValue({ found: false, fromCache: false, checkedAt: 'x' });
    await request(app).post('/api/crm/leads/find-email').send({
      firstName: 'A', lastName: 'B', company: 'Acme Inc',
    });
    expect(mockEnrichSo.findEmail).toHaveBeenCalledWith(
      expect.objectContaining({ company: 'Acme Inc', domain: undefined }),
      expect.any(Object),
    );
  });

  it('returns 429 when shared lookup quota is exceeded', async () => {
    const tracker: any = {
      checkLookupByEmailQuota: jest.fn().mockRejectedValue(new LookupByEmailQuotaExceededError(50)),
      recordLookupByEmailUsage: jest.fn(),
    };
    setQuotaTrackerForLookupRoute(tracker);
    const res = await request(app).post('/api/crm/leads/find-email').send({
      firstName: 'A', lastName: 'B', domain: 'acme.com',
    });
    expect(res.status).toBe(429);
    expect(res.body.scope).toBe('lookup');
    expect(mockEnrichSo.findEmail).not.toHaveBeenCalled();
  });
});

// ─── validate-emails (bulk) ──────────────────────────────────────────────────

describe('POST /api/crm/lists/:listId/leads/validate-emails', () => {
  it('returns 404 when list not found', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue(null);
    const res = await request(app).post('/api/crm/lists/L1/leads/validate-emails').send({});
    expect(res.status).toBe(404);
  });

  it('returns 403 when user cannot access list', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'someone-else' } as any);
    const res = await request(app).post('/api/crm/lists/L1/leads/validate-emails').send({});
    expect(res.status).toBe(403);
  });

  it('returns 400 when leadIds is not an array', async () => {
    const res = await request(app).post('/api/crm/lists/L1/leads/validate-emails').send({ leadIds: 'not-array' });
    expect(res.status).toBe(400);
  });

  it('queues all leads in the list when leadIds omitted; skips ones with no email', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [
        { leadId: 'L1', email: 'a@b.com' },
        { leadId: 'L2', email: '' },
        { leadId: 'L3', email: 'c@d.com' },
      ],
      lastEvaluatedKey: undefined,
    } as any);

    const res = await request(app).post('/api/crm/lists/list-1/leads/validate-emails').send({});

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: 2, skipped: 1 });
  });

  it('queues only the selected leadIds when provided', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
    mockCrmDb.getLeadById.mockImplementation((_l: string, id: string) =>
      Promise.resolve({ leadId: id, email: id === 'X' ? 'x@y.com' : '' } as any),
    );
    const res = await request(app)
      .post('/api/crm/lists/list-1/leads/validate-emails')
      .send({ leadIds: ['X', 'Y'] });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: 1, skipped: 1 });
  });

  it('treats explicit empty leadIds: [] as a no-op (does NOT fall through to fetch-all)', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
    // Make getLeadsByListId return non-empty so a fall-through to "fetch all"
    // would be visible (queued > 0). With the fix, the route must short-circuit
    // before touching the list at all.
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [
        { leadId: 'L1', email: 'a@b.com' },
        { leadId: 'L2', email: 'c@d.com' },
      ],
      lastEvaluatedKey: undefined,
    } as any);

    const res = await request(app).post('/api/crm/lists/L1/leads/validate-emails').send({ leadIds: [] });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: 0, skipped: 0 });
    // Critical assertion: the route must NOT enumerate the list when [] is passed.
    expect(mockCrmDb.getLeadsByListId).not.toHaveBeenCalled();
    expect(mockCrmDb.getLeadById).not.toHaveBeenCalled();
  });

  it('treats omitted leadIds (undefined) as "validate all leads in list"', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [
        { leadId: 'L1', email: 'a@b.com' },
        { leadId: 'L2', email: 'c@d.com' },
      ],
      lastEvaluatedKey: undefined,
    } as any);

    // No leadIds in body — should fetch the whole list.
    const res = await request(app).post('/api/crm/lists/L1/leads/validate-emails').send({});
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: 2, skipped: 0 });
    expect(mockCrmDb.getLeadsByListId).toHaveBeenCalledTimes(1);
  });
});

// ─── lookup-by-email ─────────────────────────────────────────────────────────

describe('POST /api/crm/leads/lookup-by-email', () => {
  it('returns 400 when email is missing', async () => {
    const res = await request(app).post('/api/crm/leads/lookup-by-email').send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/email/i);
  });

  it('returns 400 when email is whitespace', async () => {
    const res = await request(app).post('/api/crm/leads/lookup-by-email').send({ email: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns found: false when reverse lookup is empty', async () => {
    mockEnrichSo.reverseLookup.mockResolvedValue({ found: false, fromCache: false, checkedAt: 'x' });
    const res = await request(app).post('/api/crm/leads/lookup-by-email').send({ email: 'a@b.com' });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
    expect(res.body.draft).toBeNull();
  });

  it('returns draft profile fields when found', async () => {
    mockEnrichSo.reverseLookup.mockResolvedValue({
      found: true,
      firstName: 'Alice',
      lastName: 'Smith',
      companyName: 'Acme',
      jobTitle: 'CEO',
      profileUrl: 'https://www.linkedin.com/in/alicesmith',
      location: 'SF',
      headline: 'CEO at Acme',
      fromCache: true,
      checkedAt: '2026-05-04',
    });
    const res = await request(app).post('/api/crm/leads/lookup-by-email').send({ email: 'a@b.com' });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.draft).toEqual({
      email: 'a@b.com',
      firstName: 'Alice',
      lastName: 'Smith',
      company: 'Acme',
      title: 'CEO',
      linkedin: 'https://www.linkedin.com/in/alicesmith',
      location: 'SF',
      headline: 'CEO at Acme',
    });
    expect(res.body.fromCache).toBe(true);
  });

  it('does not persist anything', async () => {
    mockEnrichSo.reverseLookup.mockResolvedValue({ found: true, firstName: 'X', fromCache: false, checkedAt: 'x' });
    await request(app).post('/api/crm/leads/lookup-by-email').send({ email: 'a@b.com' });
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it('returns 500 when service throws', async () => {
    mockEnrichSo.reverseLookup.mockRejectedValue(new Error('rate limit'));
    const res = await request(app).post('/api/crm/leads/lookup-by-email').send({ email: 'a@b.com' });
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/rate limit/);
  });

  // C4 — abuse-resistance gates
  describe('abuse gates', () => {
    it('returns 400 for invalid email format (no @)', async () => {
      const res = await request(app).post('/api/crm/leads/lookup-by-email').send({ email: 'notanemail' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/format/i);
      expect(mockEnrichSo.reverseLookup).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid email format (no TLD)', async () => {
      const res = await request(app).post('/api/crm/leads/lookup-by-email').send({ email: 'a@b' });
      expect(res.status).toBe(400);
      expect(mockEnrichSo.reverseLookup).not.toHaveBeenCalled();
    });

    it('rejects emails over 254 chars (RFC max)', async () => {
      const long = 'a'.repeat(250) + '@b.com';
      const res = await request(app).post('/api/crm/leads/lookup-by-email').send({ email: long });
      expect(res.status).toBe(400);
      expect(mockEnrichSo.reverseLookup).not.toHaveBeenCalled();
    });

    it('returns 429 when route-level lookup quota is exceeded', async () => {
      const tracker: any = {
        checkLookupByEmailQuota: jest.fn().mockRejectedValue(new LookupByEmailQuotaExceededError(50)),
        recordLookupByEmailUsage: jest.fn(),
      };
      setQuotaTrackerForLookupRoute(tracker);
      const res = await request(app).post('/api/crm/leads/lookup-by-email').send({ email: 'a@b.com' });
      expect(res.status).toBe(429);
      expect(res.body.scope).toBe('lookup-by-email');
      expect(res.body.limit).toBe(50);
      expect(mockEnrichSo.reverseLookup).not.toHaveBeenCalled();
    });

    it('records lookup usage on successful API call', async () => {
      const tracker: any = {
        checkLookupByEmailQuota: jest.fn().mockResolvedValue(undefined),
        recordLookupByEmailUsage: jest.fn().mockResolvedValue(undefined),
      };
      setQuotaTrackerForLookupRoute(tracker);
      mockEnrichSo.reverseLookup.mockResolvedValue({ found: true, firstName: 'X', fromCache: false, checkedAt: 'x' });
      await request(app).post('/api/crm/leads/lookup-by-email').send({ email: 'a@b.com' });
      expect(tracker.checkLookupByEmailQuota).toHaveBeenCalledWith('u1');
      expect(tracker.recordLookupByEmailUsage).toHaveBeenCalledWith('u1');
    });
  });
});
