/**
 * ENG-3021: no-inference authenticated readback of the get_leads and get_lead_details
 * projections, so a verifier can read stored suppression status without an Emma model run.
 * The routes must call the real handlers as the authenticated caller and nobody else.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'caller-1', email: 'qa-user@agentweb.pro', isAdmin: false };
    next();
  },
  AuthenticatedRequest: jest.fn(),
}));
jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({ allowed: true, warning: false, used: 0, allowance: null,
    bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-11' }),
}));

const mockCrmDb = {
  getLeadListById: jest.fn(),
  canOrgMemberAccessList: jest.fn(),
  getLeadById: jest.fn(),
  getLeadEngagements: jest.fn(),
  getLeadEngagementCount: jest.fn(),
};
jest.mock('../services/db', () => ({ crmDb: mockCrmDb }));

const mockService = {
  searchLeads: jest.fn(),
  getLeads: jest.fn(),
  // The real handler, so the ownership check under test is the production one.
  getLeadDetails: jest.fn((listId: string, leadId: string, userId: string) =>
    jest.requireActual('../emma/impl/leads').getLeadDetails(listId, leadId, userId)),
  // ENG-2840 (W2-5a): the real handlers again, so the list access check under test is the production one.
  getLeadEngagements: jest.fn((listId: string, leadId: string, userId: string, limit?: number) =>
    jest.requireActual('../emma/impl/leads').getLeadEngagements(listId, leadId, userId, limit)),
  getLeadListStatuses: jest.fn((listId: string, userId: string) =>
    jest.requireActual('../emma/impl/leads').getLeadListStatuses(listId, userId)),
};
jest.mock('../services/agentModeService', () => ({ agentModeService: mockService }));

import emmaApiRouter from '../routes/emmaApi';
import { classifyEmmaRoute } from '../middleware/emmaTokenBudget';

const app = express();
app.use(express.json());
app.use('/api/emma', emmaApiRouter);

beforeEach(() => {
  mockService.searchLeads.mockReset();
  mockService.getLeads.mockReset();
  mockService.getLeadDetails.mockClear();
  mockService.getLeadEngagements.mockClear();
  mockService.getLeadListStatuses.mockClear();
  Object.values(mockCrmDb).forEach(fn => fn.mockReset());
});

describe('POST /api/emma/leads (get_leads projection)', () => {
  it('calls getLeads for the list as the authenticated caller with only the known options', async () => {
    mockService.getLeads.mockResolvedValue({ success: true, leads: [{ leadId: 'l1', contactStatus: 'unsubscribed' }] });
    const res = await request(app).post('/api/emma/leads').send({
      list_id: 'list-1', limit: 3, cursor: 'c1', status: 'new', search: 'acme', include_all_fields: true,
      userId: 'someone-else', user_id: 'someone-else', unknown_option: 'x',
    });
    expect(res.status).toBe(200);
    expect(res.body.leads[0].contactStatus).toBe('unsubscribed');
    expect(mockService.getLeads).toHaveBeenCalledWith('list-1', 'caller-1',
      { limit: 3, cursor: 'c1', status: 'new', search: 'acme', includeAllFields: true });
  });

  it('rejects a request without a list_id before reaching the handler', async () => {
    const res = await request(app).post('/api/emma/leads').send({ limit: 3 });
    expect(res.status).toBe(400);
    expect(mockService.getLeads).not.toHaveBeenCalled();
  });
});

describe('POST /api/emma/lead-details (get_lead_details projection)', () => {
  it('calls getLeadDetails as the authenticated caller, ignoring any identity in the body', async () => {
    mockService.getLeadDetails.mockResolvedValueOnce({ success: true, lead: { leadId: 'l1', contactStatus: 'do-not-contact' } });
    const res = await request(app).post('/api/emma/lead-details')
      .send({ list_id: 'list-1', lead_id: 'l1', userId: 'someone-else', user_id: 'someone-else' });
    expect(res.status).toBe(200);
    expect(res.body.lead.contactStatus).toBe('do-not-contact');
    expect(mockService.getLeadDetails).toHaveBeenCalledWith('list-1', 'l1', 'caller-1');
  });

  it("does not return another user's lead: the real handler denies a list the caller cannot access", async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'foreign-list', userId: 'owner-2' });
    mockCrmDb.canOrgMemberAccessList.mockResolvedValue(false);
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'foreign-lead', email: 'private@customer.example', contactStatus: 'active' });
    const res = await request(app).post('/api/emma/lead-details').send({ list_id: 'foreign-list', lead_id: 'foreign-lead' });
    expect(mockCrmDb.canOrgMemberAccessList).toHaveBeenCalledWith('caller-1', expect.objectContaining({ listId: 'foreign-list' }));
    expect(res.body.success).toBe(false);
    expect(res.body.lead).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('private@customer.example');
    expect(mockCrmDb.getLeadById).not.toHaveBeenCalled();
  });

  it('rejects a request missing list_id or lead_id, or with non-string ids', async () => {
    for (const body of [{ list_id: 'list-1' }, { lead_id: 'l1' }, { list_id: { $ne: '' }, lead_id: 'l1' }, { list_id: 'list-1', lead_id: ['l1'] }]) {
      const res = await request(app).post('/api/emma/lead-details').send(body);
      expect(res.status).toBe(400);
    }
    expect(mockService.getLeadDetails).not.toHaveBeenCalled();
  });
});

describe('POST /api/emma/search-leads (unchanged)', () => {
  it('still calls searchLeads as the authenticated caller', async () => {
    mockService.searchLeads.mockResolvedValue({ leads: [] });
    const res = await request(app).post('/api/emma/search-leads').send({ list_id: 'list-1', filters: [], limit: 5 });
    expect(res.status).toBe(200);
    expect(mockService.searchLeads).toHaveBeenCalledWith('list-1', [], 'caller-1', 5);
  });
});

// ENG-2840 (W2-5a): the two routes the MCP tools get_lead_engagements and get_lead_list_statuses call.
describe('the lead read routes count against the monthly token quota', () => {
  it('the CRM read routes are metered: an agent that reads leads is counted (an account over its quota is refused on them)', () => {
    for (const path of ['/leads', '/lead-details', '/lead-engagements', '/lead-list-statuses', '/search-leads']) {
      expect({ path, budget: classifyEmmaRoute('POST', path) }).toEqual({ path, budget: 'metered' });
    }
  });
});

describe('POST /api/emma/lead-engagements (get_lead_engagements projection)', () => {
  it('calls getLeadEngagements as the authenticated caller, ignoring any identity in the body, and passes a numeric limit', async () => {
    mockService.getLeadEngagements.mockResolvedValueOnce({ success: true, engagements: [{ eventId: 'e1' }] });
    const res = await request(app).post('/api/emma/lead-engagements')
      .send({ list_id: 'list-1', lead_id: 'l1', limit: 7, userId: 'someone-else', user_id: 'someone-else' });
    expect(res.status).toBe(200);
    expect(res.body.engagements[0].eventId).toBe('e1');
    expect(mockService.getLeadEngagements).toHaveBeenCalledWith('list-1', 'l1', 'caller-1', 7);
  });

  it('a limit that is not a number is not passed on (the handler default applies)', async () => {
    mockService.getLeadEngagements.mockResolvedValueOnce({ success: true, engagements: [] });
    await request(app).post('/api/emma/lead-engagements').send({ list_id: 'list-1', lead_id: 'l1', limit: '500' });
    expect(mockService.getLeadEngagements).toHaveBeenCalledWith('list-1', 'l1', 'caller-1', undefined);
  });

  it('rejects a request missing list_id or lead_id, or with non-string ids, before the handler', async () => {
    for (const body of [{ list_id: 'list-1' }, { lead_id: 'l1' }, { list_id: { $ne: '' }, lead_id: 'l1' }, { list_id: 'list-1', lead_id: ['l1'] }, { list_id: '  ', lead_id: 'l1' }]) {
      const res = await request(app).post('/api/emma/lead-engagements').send(body);
      expect(res.status).toBe(400);
    }
    expect(mockService.getLeadEngagements).not.toHaveBeenCalled();
  });

  it("does not return another user's engagements: the real handler denies a list the caller cannot access, before touching the lead", async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'foreign-list', userId: 'owner-2' });
    mockCrmDb.canOrgMemberAccessList.mockResolvedValue(false);
    mockCrmDb.getLeadEngagements.mockResolvedValue({ engagements: [{ eventType: 'email.received', eventData: { from: 'private@customer.example' } }] });
    const res = await request(app).post('/api/emma/lead-engagements').send({ list_id: 'foreign-list', lead_id: 'foreign-lead' });
    expect(mockCrmDb.canOrgMemberAccessList).toHaveBeenCalledWith('caller-1', expect.objectContaining({ listId: 'foreign-list' }));
    expect(res.body.success).toBe(false);
    expect(res.body.engagements).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('private@customer.example');
    expect(mockCrmDb.getLeadById).not.toHaveBeenCalled();
    expect(mockCrmDb.getLeadEngagements).not.toHaveBeenCalled();
  });
});

describe('POST /api/emma/lead-list-statuses (get_lead_list_statuses projection)', () => {
  it('calls getLeadListStatuses as the authenticated caller, ignoring any identity in the body', async () => {
    mockService.getLeadListStatuses.mockResolvedValueOnce({ success: true, statuses: [{ id: 'new' }], listName: 'Mine' });
    const res = await request(app).post('/api/emma/lead-list-statuses').send({ list_id: 'list-1', userId: 'someone-else', user_id: 'someone-else' });
    expect(res.status).toBe(200);
    expect(res.body.listName).toBe('Mine');
    expect(mockService.getLeadListStatuses).toHaveBeenCalledWith('list-1', 'caller-1');
  });

  it('rejects a request without a usable list_id before the handler', async () => {
    for (const body of [{}, { list_id: 7 }, { list_id: ['a'] }, { list_id: '' }]) {
      const res = await request(app).post('/api/emma/lead-list-statuses').send(body);
      expect(res.status).toBe(400);
    }
    expect(mockService.getLeadListStatuses).not.toHaveBeenCalled();
  });

  it("does not return another user's list stages: the real handler denies a list the caller cannot access", async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'foreign-list', userId: 'owner-2', name: 'Private pipeline', statusConfig: [{ id: 'secret-stage' }] });
    mockCrmDb.canOrgMemberAccessList.mockResolvedValue(false);
    const res = await request(app).post('/api/emma/lead-list-statuses').send({ list_id: 'foreign-list' });
    expect(res.body.success).toBe(false);
    expect(res.body.statuses).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('Private pipeline');
    expect(JSON.stringify(res.body)).not.toContain('secret-stage');
  });
});
