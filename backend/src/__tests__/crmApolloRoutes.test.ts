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
    setLeadFields: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));

const mockApollo = {
  matchPerson: jest.fn(),
};
jest.mock('../services/apolloService', () => ({
  isApolloServiceReady: () => true,
  getApolloService: () => mockApollo,
}));

import crmApolloRouter, { __resetBulkEnrichLockForTesting } from '../routes/crmApollo';
import { crmDb, userDb, orgDb } from '../services/db';
import { authenticateToken } from '../middleware/auth';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;

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

describe('Bulk Apollo enrich — race-safe writes', () => {
  it('writes via setLeadFields with targeted keys, not updateLead with a stale customFields spread', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'u1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [{
        leadId: 'L1',
        linkedin: 'https://linkedin.com/in/jane',
        // Pre-existing customFields that must NOT be re-spread by the writer
        // (would clobber a concurrent worker's writes to the same map).
        customFields: { stale_concurrent_field: 'do_not_resend' },
      }],
      lastEvaluatedKey: undefined,
    } as any);
    mockApollo.matchPerson.mockResolvedValue({
      found: true,
      match: {
        person: {
          firstName: 'Jane',
          lastName: 'Doe',
          email: 'jane@acme.com',
          emailStatus: 'verified',
          title: 'VP Eng',
          linkedin: 'https://linkedin.com/in/jane',
          apolloPersonId: 'apollo_p1',
          city: 'San Francisco',
          state: 'CA',
          country: 'United States',
          fieldConfidence: {},
        },
        organization: {
          name: 'Acme',
          linkedinUrl: 'https://linkedin.com/company/acme',
        },
      },
    } as any);

    const res = await request(app).post('/api/crm/lists/L1/leads/enrich-with-apollo').send({});
    expect(res.status).toBe(202);

    // Yield so the background fan-out completes.
    await new Promise((r) => setTimeout(r, 30));

    // updateLead must NOT be used for the bulk-enrich write — that path spreads
    // a stale customFields snapshot and races with concurrent workers.
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();

    // setLeadFields must receive only the projection's targeted keys.
    expect(mockCrmDb.setLeadFields).toHaveBeenCalledTimes(1);
    const [listIdArg, leadIdArg, optsArg] = (mockCrmDb.setLeadFields as jest.Mock).mock.calls[0];
    expect(listIdArg).toBe('L1');
    expect(leadIdArg).toBe('L1');

    // topLevel: identity fields only (email/firstName/lastName/title/company/linkedin/companyLinkedin in minimal mode).
    expect(optsArg.topLevel).toEqual(expect.objectContaining({
      email: 'jane@acme.com',
      firstName: 'Jane',
      lastName: 'Doe',
      title: 'VP Eng',
      company: 'Acme',
    }));
    // The stale lead.customFields snapshot must NOT be re-sent — only the
    // projection's own customFields should appear (e.g. location).
    expect(optsArg.customFields).toBeDefined();
    expect(optsArg.customFields).not.toHaveProperty('stale_concurrent_field');
    expect(optsArg.customFields).toEqual(expect.objectContaining({
      location: 'San Francisco, CA, United States',
    }));
    // enrichmentMetadata is per-key, never the full map.
    expect(optsArg.enrichmentMetadata).toBeDefined();
    expect(typeof optsArg.enrichmentMetadata).toBe('object');
  });
});

describe('POST /api/crm/lists/:listId/leads/enrich-with-apollo — org-aware access control (ENG-686)', () => {
  // authenticateToken (mocked above) always authenticates as 'u1'. The list is
  // owned by a different same-org member, 'owner-2'.
  function setSameOrgUsers() {
    mockUserDb.getUserById.mockImplementation((id: string) =>
      Promise.resolve(id === 'owner-2' ? ({ userId: 'owner-2', orgId: 'org-A' } as any) : ({ userId: 'u1', orgId: 'org-A' } as any))
    );
  }
  function orgWithCrm(overrides: Record<string, any> = {}) {
    return {
      orgId: 'org-A',
      ownerUserId: 'org-owner-id',
      shareSettings: { crm: { enabled: true, editors: [] as string[] } },
      ...overrides,
    };
  }

  it('returns 403 for a same-org member who is not the owner and not a CRM editor', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'owner-2' } as any);
    setSameOrgUsers();
    mockOrgDb.getOrgById.mockResolvedValue(orgWithCrm() as any);

    const res = await request(app).post('/api/crm/lists/L1/leads/enrich-with-apollo').send({});

    expect(res.status).toBe(403);
    expect(mockCrmDb.setLeadFields).not.toHaveBeenCalled();
  });

  it('allows a listed crm.editor to bulk-enrich another member\'s list', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'owner-2' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: undefined } as any);
    setSameOrgUsers();
    mockOrgDb.getOrgById.mockResolvedValue(orgWithCrm({ shareSettings: { crm: { enabled: true, editors: ['u1'] } } }) as any);

    const res = await request(app).post('/api/crm/lists/L1/leads/enrich-with-apollo').send({});

    expect(res.status).toBe(202);
  });

  it('allows the org owner to bulk-enrich another member\'s list', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ userId: 'owner-2' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: undefined } as any);
    setSameOrgUsers();
    mockOrgDb.getOrgById.mockResolvedValue(orgWithCrm({ ownerUserId: 'u1' }) as any);

    const res = await request(app).post('/api/crm/lists/L1/leads/enrich-with-apollo').send({});

    expect(res.status).toBe(202);
  });
});
