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
    updateLeadList: jest.fn(),
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

  // ─── persistToListId/persistToLeadId authorization ─────────────────────────
  describe('persistTo* authorization', () => {
    it('returns 403 when persistToListId references a list owned by another user', async () => {
      mockEnrichSo.findEmail.mockResolvedValue({
        found: true, email: 'a@acme.com', confidence: 'high', fromCache: false, checkedAt: 'x',
      });
      // List belongs to a different user, no shared org.
      mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'someone-else' } as any);

      const res = await request(app).post('/api/crm/leads/find-email').send({
        firstName: 'A', lastName: 'B', domain: 'acme.com',
        persistToListId: 'L1', persistToLeadId: 'LD1',
      });

      expect(res.status).toBe(403);
      expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
    });

    it('returns 404 when persistToListId references a list that does not exist', async () => {
      mockEnrichSo.findEmail.mockResolvedValue({
        found: true, email: 'a@acme.com', confidence: 'high', fromCache: false, checkedAt: 'x',
      });
      mockCrmDb.getLeadListById.mockResolvedValue(null);

      const res = await request(app).post('/api/crm/leads/find-email').send({
        firstName: 'A', lastName: 'B', domain: 'acme.com',
        persistToListId: 'missing-list', persistToLeadId: 'LD1',
      });

      expect(res.status).toBe(404);
      expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
    });

    it('persists when caller owns the list', async () => {
      mockEnrichSo.findEmail.mockResolvedValue({
        found: true, email: 'a@acme.com', confidence: 'high', fromCache: false, checkedAt: 'x',
      });
      mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
      mockCrmDb.getLeadById.mockResolvedValue({
        leadId: 'LD1', email: '', customFields: {}, enrichmentMetadata: {},
      } as any);

      const res = await request(app).post('/api/crm/leads/find-email').send({
        firstName: 'A', lastName: 'B', domain: 'acme.com',
        persistToListId: 'L1', persistToLeadId: 'LD1',
      });

      expect(res.status).toBe(200);
      expect(mockCrmDb.updateLead).toHaveBeenCalledTimes(1);
      const [listId, leadId, payload] = mockCrmDb.updateLead.mock.calls[0] as any;
      expect(listId).toBe('L1');
      expect(leadId).toBe('LD1');
      expect(payload.email).toBe('a@acme.com');
    });

    it('skips recordLookupByEmailUsage when result is a cache hit (C8)', async () => {
      const tracker: any = {
        checkLookupByEmailQuota: jest.fn(),
        recordLookupByEmailUsage: jest.fn(),
      };
      setQuotaTrackerForLookupRoute(tracker);
      mockEnrichSo.findEmail.mockResolvedValue({
        found: true, email: 'a@acme.com', confidence: 'high', fromCache: true, checkedAt: 'x',
      });
      const res = await request(app).post('/api/crm/leads/find-email').send({
        firstName: 'A', lastName: 'B', domain: 'acme.com',
      });
      expect(res.status).toBe(200);
      expect(tracker.checkLookupByEmailQuota).toHaveBeenCalled();
      expect(tracker.recordLookupByEmailUsage).not.toHaveBeenCalled();
    });

    it('records lookup usage when the call hit a provider (cache miss)', async () => {
      const tracker: any = {
        checkLookupByEmailQuota: jest.fn(),
        recordLookupByEmailUsage: jest.fn(),
      };
      setQuotaTrackerForLookupRoute(tracker);
      mockEnrichSo.findEmail.mockResolvedValue({
        found: true, email: 'a@acme.com', confidence: 'high', fromCache: false, checkedAt: 'x',
      });
      const res = await request(app).post('/api/crm/leads/find-email').send({
        firstName: 'A', lastName: 'B', domain: 'acme.com',
      });
      expect(res.status).toBe(200);
      expect(tracker.recordLookupByEmailUsage).toHaveBeenCalledTimes(1);
    });

    it('does not call getLeadListById / updateLead when persistTo* is omitted', async () => {
      mockEnrichSo.findEmail.mockResolvedValue({
        found: true, email: 'a@acme.com', confidence: 'high', fromCache: false, checkedAt: 'x',
      });

      const res = await request(app).post('/api/crm/leads/find-email').send({
        firstName: 'A', lastName: 'B', domain: 'acme.com',
      });

      expect(res.status).toBe(200);
      expect(mockCrmDb.getLeadListById).not.toHaveBeenCalled();
      expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
    });
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
    expect(res.body).toEqual({ queued: 2, skipped: 1, alreadyDone: 0 });
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
    expect(res.body).toEqual({ queued: 1, skipped: 1, alreadyDone: 0 });
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
    expect(res.body).toEqual({ queued: 0, skipped: 0, alreadyDone: 0 });
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
    expect(res.body).toEqual({ queued: 2, skipped: 0, alreadyDone: 0 });
    expect(mockCrmDb.getLeadsByListId).toHaveBeenCalledTimes(1);
  });

  it('reports alreadyDone count for leads that already carry email_validation', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [
        // already validated
        { leadId: 'L1', email: 'a@b.com',
          customFields: { email_validation: { status: 'deliverable' } } },
        // not yet validated
        { leadId: 'L2', email: 'c@d.com' },
        // no email — counted in skipped
        { leadId: 'L3', email: '' },
      ],
      lastEvaluatedKey: undefined,
    } as any);

    const res = await request(app).post('/api/crm/lists/L1/leads/validate-emails').send({});
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: 2, skipped: 1, alreadyDone: 1 });
  });
});

// ─── bulk find-emails / lookup-emails / counts ───────────────────────────────

describe('GET /api/crm/lists/:listId/leads/enrichment-counts', () => {
  it('returns 404 when list missing', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue(null);
    const res = await request(app).get('/api/crm/lists/L1/leads/enrichment-counts');
    expect(res.status).toBe(404);
  });

  it('tallies validate / find / lookup buckets', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [
        // Has email + validation + all profile fields → counted in alreadyDone for everything
        { leadId: '1', email: 'a@b.com', firstName: 'A', lastName: 'B', company: 'X', title: 'T', linkedin: 'l',
          customFields: { email_validation: { status: 'deliverable' } } },
        // Has email but no validation yet → validate.pending
        { leadId: '2', email: 'c@d.com', firstName: 'C', lastName: 'D', company: 'Y' },
        // No email but has name+company → find.pending
        { leadId: '3', firstName: 'E', lastName: 'F', company: 'Z' },
        // Skipped — has nothing
        { leadId: '4' },
      ],
      lastEvaluatedKey: undefined,
    } as any);
    const res = await request(app).get('/api/crm/lists/L1/leads/enrichment-counts');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.validate.pending).toBe(1);   // lead 2
    expect(res.body.find.pending).toBe(1);       // lead 3
    expect(res.body.lookup.pending).toBe(1);     // lead 2 (missing title/linkedin)
    expect(res.body.lookup.alreadyDone).toBe(1); // lead 1
  });
});

describe('POST /api/crm/lists/:listId/leads/find-emails (bulk)', () => {
  it('returns 202 + counts; queues only applicable leads (name+company, no email)', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [
        { leadId: '1', firstName: 'A', lastName: 'B', company: 'Acme' },     // applicable
        { leadId: '2', email: 'has@email.com', firstName: 'X' },              // alreadyDone
        { leadId: '3', firstName: 'C' },                                       // skipped (no company)
      ],
      lastEvaluatedKey: undefined,
    } as any);
    const res = await request(app).post('/api/crm/lists/L1/leads/find-emails').send({});
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: 1, skipped: 1, alreadyDone: 1 });
  });

  it('returns 403 on cross-tenant access', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'someone-else' } as any);
    const res = await request(app).post('/api/crm/lists/L1/leads/find-emails').send({});
    expect(res.status).toBe(403);
  });
});

describe('POST /api/crm/lists/:listId/leads/lookup-emails (bulk)', () => {
  it('returns 202 + counts; queues only leads with email AND missing profile fields', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [
        // Complete profile → alreadyDone (lookup), skipped from queue
        { leadId: '1', email: 'a@b.com', firstName: 'A', lastName: 'B', company: 'X', title: 'T', linkedin: 'l' },
        // Has email but missing fields → applicable
        { leadId: '2', email: 'c@d.com', firstName: 'C' },
        // No email → skipped entirely (counts as neither applicable nor alreadyDone)
        { leadId: '3', firstName: 'E', company: 'Y' },
      ],
      lastEvaluatedKey: undefined,
    } as any);
    const res = await request(app).post('/api/crm/lists/L1/leads/lookup-emails').send({});
    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(1);
    expect(res.body.alreadyDone).toBe(1);
  });

  it('returns 404 when list missing', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue(null);
    const res = await request(app).post('/api/crm/lists/L1/leads/lookup-emails').send({});
    expect(res.status).toBe(404);
  });

  it('writes only standard fields when no extended fields enabled (default config)', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [{ leadId: '1', email: 'a@b.com' }],
      lastEvaluatedKey: undefined,
    } as any);
    mockEnrichSo.reverseLookup.mockResolvedValue({
      found: true,
      firstName: 'Alice',
      lastName: 'Smith',
      companyName: 'Acme',
      jobTitle: 'CEO',
      profileUrl: 'https://www.linkedin.com/in/alice',
      summary: 'Bio.',
      skills: ['A', 'B'],
      pastCompanies: ['Old Co'],
      fromCache: false, checkedAt: 'x',
    });
    await request(app).post('/api/crm/lists/L1/leads/lookup-emails').send({});
    // Background runs after response; flush microtasks.
    await new Promise((r) => setImmediate(r));
    expect(mockCrmDb.updateLead).toHaveBeenCalledTimes(1);
    const payload = mockCrmDb.updateLead.mock.calls[0][2] as any;
    expect(payload.firstName).toBe('Alice');
    expect(payload.lastName).toBe('Smith');
    expect(payload.company).toBe('Acme');
    expect(payload.title).toBe('CEO');
    expect(payload.linkedin).toContain('linkedin.com/in/alice');
    // Extended fields disabled by default → not written.
    expect(payload.customFields).toBeUndefined();
  });

  it('writes extended fields to customFields when enabled in config', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({
      userId: 'u1',
      enrichmentFieldConfig: { skills: true, summary: true, pastCompanies: true },
    } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [{ leadId: '1', email: 'a@b.com' }],
      lastEvaluatedKey: undefined,
    } as any);
    mockEnrichSo.reverseLookup.mockResolvedValue({
      found: true,
      firstName: 'Alice', lastName: 'Smith', companyName: 'Acme', jobTitle: 'CEO',
      profileUrl: 'https://www.linkedin.com/in/alice',
      summary: 'Designer who ships.',
      skills: ['Figma', 'UX', 'Prototyping'],
      pastCompanies: ['Airbnb', 'Stripe'],
      fromCache: false, checkedAt: 'x',
    });
    await request(app).post('/api/crm/lists/L1/leads/lookup-emails').send({});
    await new Promise((r) => setImmediate(r));
    expect(mockCrmDb.updateLead).toHaveBeenCalledTimes(1);
    const payload = mockCrmDb.updateLead.mock.calls[0][2] as any;
    expect(payload.customFields).toEqual({
      summary: 'Designer who ships.',
      skills: 'Figma, UX, Prototyping',
      pastCompanies: 'Airbnb; Stripe',
    });
    // Provenance metadata also tagged for each new field.
    expect(payload.enrichmentMetadata.skills.provider).toBe('enrich.so');
    expect(payload.enrichmentMetadata.summary.provider).toBe('enrich.so');
  });

  it('does not overwrite existing customFields entries', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({
      userId: 'u1',
      enrichmentFieldConfig: { skills: true },
    } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [{
        leadId: '1', email: 'a@b.com',
        customFields: { skills: 'pre-existing value' },
      }],
      lastEvaluatedKey: undefined,
    } as any);
    mockEnrichSo.reverseLookup.mockResolvedValue({
      found: true, firstName: 'A',
      skills: ['Should', 'Not', 'Overwrite'],
      fromCache: false, checkedAt: 'x',
    });
    await request(app).post('/api/crm/lists/L1/leads/lookup-emails').send({});
    await new Promise((r) => setImmediate(r));
    if (mockCrmDb.updateLead.mock.calls.length > 0) {
      const payload = mockCrmDb.updateLead.mock.calls[0][2] as any;
      // Either no customFields write (because nothing new), or skills preserved
      if (payload.customFields) {
        expect(payload.customFields.skills).toBe('pre-existing value');
      }
    }
    // Whatever happens, the pre-existing value must not be replaced.
    for (const call of mockCrmDb.updateLead.mock.calls) {
      const cf = (call[2] as any).customFields;
      if (cf && 'skills' in cf) expect(cf.skills).toBe('pre-existing value');
    }
  });

  it('queues a lead with all 5 standards filled when an extended field is enabled and missing', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({
      userId: 'u1',
      enrichmentFieldConfig: { skills: true },   // skills extended, on
    } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [{
        leadId: '1', email: 'a@b.com',
        firstName: 'A', lastName: 'B', company: 'X', title: 'T', linkedin: 'l',
        customFields: {},   // skills not yet set
      }],
      lastEvaluatedKey: undefined,
    } as any);
    const res = await request(app).post('/api/crm/lists/L1/leads/lookup-emails').send({});
    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(1);   // applicable because skills missing
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

    it('rejects single-character TLD (e.g., a@b.c)', async () => {
      // The TLD floor of 2 ASCII letters keeps us aligned with real-world
      // domains and excludes single-letter junk like `a@b.c` that would
      // otherwise pass `\.[^\s@]+$`.
      const res = await request(app).post('/api/crm/leads/lookup-by-email').send({ email: 'a@b.c' });
      expect(res.status).toBe(400);
      expect(mockEnrichSo.reverseLookup).not.toHaveBeenCalled();
    });

    it('rejects numeric/IP-literal TLDs', async () => {
      const res = await request(app).post('/api/crm/leads/lookup-by-email').send({ email: 'a@b.123' });
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

// ─── enrichment-field-config (per-list) ──────────────────────────────────────

describe('GET /lists/:listId/enrichment-field-config', () => {
  it('returns 404 when list does not exist', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue(undefined as any);
    const res = await request(app).get('/api/crm/lists/missing/enrichment-field-config');
    expect(res.status).toBe(404);
  });

  it('returns 403 when user does not own the list and is not in same org', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'l1', userId: 'other' } as any);
    // both users have no orgId → not in same org
    require('../services/db').userDb.getUserById.mockResolvedValue({ userId: 'x' } as any);
    const res = await request(app).get('/api/crm/lists/l1/enrichment-field-config');
    expect(res.status).toBe(403);
  });

  it('returns defaults (standards on, extended off) when list has no config saved', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'l1', userId: 'u1' } as any);
    const res = await request(app).get('/api/crm/lists/l1/enrichment-field-config');
    expect(res.status).toBe(200);
    expect(res.body.config).toEqual({
      firstName: true, lastName: true, company: true, title: true, linkedin: true,
      summary: false, skills: false, connectionCount: false, location: false,
      headline: false, pastCompanies: false, education: false,
    });
  });

  it('returns the merged config when list has partial values saved', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: 'l1', userId: 'u1',
      enrichmentFieldConfig: { skills: true, summary: true, firstName: false },
    } as any);
    const res = await request(app).get('/api/crm/lists/l1/enrichment-field-config');
    expect(res.body.config.skills).toBe(true);
    expect(res.body.config.summary).toBe(true);
    expect(res.body.config.firstName).toBe(false);
    expect(res.body.config.lastName).toBe(true);   // unset → standard default
    expect(res.body.config.education).toBe(false); // unset → extended default
  });
});

describe('PATCH /lists/:listId/enrichment-field-config', () => {
  it('empty body is a no-op — returns current config without an update', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: 'l1', userId: 'u1',
      enrichmentFieldConfig: { skills: true },
    } as any);
    mockCrmDb.updateLeadList.mockResolvedValue(undefined as any);
    const res = await request(app).patch('/api/crm/lists/l1/enrichment-field-config').send({});
    expect(res.status).toBe(200);
    expect(res.body.config.skills).toBe(true);
  });

  it('persists only known boolean keys, drops unknowns silently', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'l1', userId: 'u1' } as any);
    mockCrmDb.updateLeadList.mockResolvedValue(undefined as any);
    const res = await request(app)
      .patch('/api/crm/lists/l1/enrichment-field-config')
      .send({ config: { skills: true, banana: 'yes', firstName: 'not-bool' } });
    expect(res.status).toBe(200);
    const written = mockCrmDb.updateLeadList.mock.calls[0][1].enrichmentFieldConfig as any;
    expect(written.skills).toBe(true);
    expect(written.banana).toBeUndefined();
    expect(written.firstName).toBe(true); // unchanged from default (string ignored)
  });

  it('partial PATCH preserves previously-saved values that the client did not send', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: 'l1', userId: 'u1',
      enrichmentFieldConfig: { summary: true, skills: true },
    } as any);
    mockCrmDb.updateLeadList.mockResolvedValue(undefined as any);
    const res = await request(app)
      .patch('/api/crm/lists/l1/enrichment-field-config')
      .send({ config: { education: true } });    // only toggling education on
    expect(res.status).toBe(200);
    const written = mockCrmDb.updateLeadList.mock.calls[0][1].enrichmentFieldConfig as any;
    expect(written.education).toBe(true);   // toggled
    expect(written.summary).toBe(true);     // preserved
    expect(written.skills).toBe(true);      // preserved
  });

  it('accepts the config-without-wrapper shape (body IS the config)', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'l1', userId: 'u1' } as any);
    mockCrmDb.updateLeadList.mockResolvedValue(undefined as any);
    const res = await request(app)
      .patch('/api/crm/lists/l1/enrichment-field-config')
      .send({ skills: true });
    expect(res.status).toBe(200);
    const written = mockCrmDb.updateLeadList.mock.calls[0][1].enrichmentFieldConfig as any;
    expect(written.skills).toBe(true);
  });

  it('returns 404 when list missing, 403 when not authorized', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue(undefined as any);
    let res = await request(app).patch('/api/crm/lists/l1/enrichment-field-config').send({ config: { skills: true } });
    expect(res.status).toBe(404);

    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'l1', userId: 'someone-else' } as any);
    require('../services/db').userDb.getUserById.mockResolvedValue({ userId: 'x' } as any);
    res = await request(app).patch('/api/crm/lists/l1/enrichment-field-config').send({ config: { skills: true } });
    expect(res.status).toBe(403);
  });
});
