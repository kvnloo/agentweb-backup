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
};
jest.mock('../services/db', () => ({ crmDb: mockCrmDb }));

const mockService = {
  searchLeads: jest.fn(),
  getLeads: jest.fn(),
  // The real handler, so the ownership check under test is the production one.
  getLeadDetails: jest.fn((listId: string, leadId: string, userId: string) =>
    jest.requireActual('../emma/impl/leads').getLeadDetails(listId, leadId, userId)),
};
jest.mock('../services/agentModeService', () => ({ agentModeService: mockService }));

import emmaApiRouter from '../routes/emmaApi';

const app = express();
app.use(express.json());
app.use('/api/emma', emmaApiRouter);

beforeEach(() => {
  mockService.searchLeads.mockReset();
  mockService.getLeads.mockReset();
  mockService.getLeadDetails.mockClear();
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
