// Tests for POST /api/crm/lists/:listId/leads/find/from-icp.
//
// Phase 2 entry-point: pre-fills find-leads filters from one of the
// user's ICPPersona records (icpResult[]) and passes the persona name
// through to lead.system.icpSource for attribution.

jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../controllers/templates', () => ({
  createTemplate: jest.fn(),
  getTemplates: jest.fn(),
  getTemplate: jest.fn(),
  updateTemplate: jest.fn(),
  deleteTemplate: jest.fn(),
  publishTemplate: jest.fn(),
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListsByUserId: jest.fn(),
    createLeadList: jest.fn(),
    getLeadListById: jest.fn(),
    updateLeadList: jest.fn(),
    deleteLeadList: jest.fn(),
    getLeadsByListId: jest.fn(),
    getLeadsByICPFlag: jest.fn(),
    getLeadsByEngagedFlag: jest.fn(),
    getLeadsByStatus: jest.fn(),
    createLead: jest.fn(),
    getLeadById: jest.fn(),
    getLeadByEmail: jest.fn(),
    updateLead: jest.fn(),
    deleteLead: jest.fn(),
    batchCreateLeads: jest.fn(),
    getLeadEngagements: jest.fn(),
    addLeadEngagement: jest.fn(),
    updateLeadEngagement: jest.fn(),
    deleteLeadEngagement: jest.fn(),
    getLeadEngagementCount: jest.fn(),
  },
  taskDb: { getTaskById: jest.fn() },
  subscriberDb: { getAllTaskSubscribers: jest.fn() },
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
  dealDb: {},
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailDomain: jest.fn(),
    getEventsByEmailDomainAndLeadEmail: jest.fn(),
  },
}));

const mockImportLeadsFromSearch = jest.fn();
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    searchWeb: jest.fn(),
    importLeadsFromSearch: (...args: any[]) => mockImportLeadsFromSearch(...args),
  },
}));

jest.mock('../utils/llmService', () => ({ createLLMService: jest.fn() }));
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(), setSetting: jest.fn() },
}));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: { handleLeadEvent: jest.fn() },
}));
jest.mock('../utils/s3Utils', () => ({ uploadFileToS3: jest.fn() }));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u1', email: 'u1@example.com' };
    next();
  },
  AuthenticatedRequest: {},
}));

import { crmDb, userDb } from '../services/db';
import router from '../routes/crm';

const findHandler = (routerObj: any, path: string, method: string) => {
  const layer = routerObj.stack.find(
    (r: any) => r.route?.path === path && r.route?.methods?.[method],
  );
  if (!layer?.route) return null;
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  return (req: any, res: any) => handle(req, res, jest.fn());
};

const persona = (over: any = {}) => ({
  name: 'Mid-market RevOps Leaders',
  pain: 'data hand-offs',
  desire: 'pipeline visibility',
  objection: 'switching cost',
  meta_targeting_brief:
    'RevOps managers at SaaS companies in North America who use Salesforce.',
  ...over,
});

describe('POST /api/crm/lists/:listId/leads/find/from-icp', () => {
  let mockReq: any;
  let mockRes: any;
  const handler = findHandler(router, '/lists/:listId/leads/find/from-icp', 'post');

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = { params: { listId: 'list_1' }, body: {}, user: { userId: 'u1' } };
    mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_1', userId: 'u1' });
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'u1', icpResult: [persona()] });
    mockImportLeadsFromSearch.mockResolvedValue({
      success: true, imported: 3, skipped: 0, list_total_after_import: 3, errors: [], total: 3,
    });
  });

  it('route handler is registered', () => {
    expect(handler).not.toBeNull();
  });

  it('400 when icpIndex is missing', async () => {
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('400 when icpIndex is negative', async () => {
    mockReq.body = { icpIndex: -1 };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('400 when icpIndex is not a number', async () => {
    mockReq.body = { icpIndex: 'first' };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('404 when list does not exist', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);
    mockReq.body = { icpIndex: 0 };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it('403 when list belongs to another user', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_1', userId: 'u_other' });
    mockReq.body = { icpIndex: 0 };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(403);
  });

  it('404 when user has no icpResult personas', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'u1', icpResult: [] });
    mockReq.body = { icpIndex: 0 };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it('404 when user has no icpResult field at all', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'u1' });
    mockReq.body = { icpIndex: 0 };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it('404 when icpIndex is out of range', async () => {
    mockReq.body = { icpIndex: 5 };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it('happy path: forwards extracted filters + icpSource to importLeadsFromSearch', async () => {
    mockReq.body = { icpIndex: 0 };
    await handler!(mockReq, mockRes);
    expect(mockImportLeadsFromSearch).toHaveBeenCalledTimes(1);
    const args = mockImportLeadsFromSearch.mock.calls[0][1];
    expect(args.icpSource).toBe('Mid-market RevOps Leaders');
    expect(args.title).toBe('RevOps Leaders');
    expect(args.industry).toBe('SaaS');
    expect(args.location).toBe('North America');
    expect(mockRes.status).toHaveBeenCalledWith(201);
    const body = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(body.persona).toEqual({ name: 'Mid-market RevOps Leaders', index: 0 });
  });

  it('caps limit at 500 and forwards auto_enrich', async () => {
    mockReq.body = { icpIndex: 0, limit: 1000, auto_enrich: true };
    await handler!(mockReq, mockRes);
    const args = mockImportLeadsFromSearch.mock.calls[0][1];
    expect(args.limit).toBe(500);
    expect(args.auto_enrich).toBe(true);
  });

  it('defaults limit to 20 when omitted', async () => {
    mockReq.body = { icpIndex: 0 };
    await handler!(mockReq, mockRes);
    const args = mockImportLeadsFromSearch.mock.calls[0][1];
    expect(args.limit).toBe(20);
  });

  it('returns 400 when service reports failure', async () => {
    mockImportLeadsFromSearch.mockResolvedValueOnce({ success: false, error: 'No LinkedIn account' });
    mockReq.body = { icpIndex: 0 };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  // Phase 2 follow-up: keywords field from the regex extractor is the full
  // first sentence of meta_targeting_brief, which behaves as an AND-of-words
  // search in LinkedIn and kills recall. When a title was extractable, the
  // route should suppress keywords so title + industry + location carry the
  // search.
  it('does NOT forward keywords when title was extracted', async () => {
    mockReq.body = { icpIndex: 0 };
    await handler!(mockReq, mockRes);
    const args = mockImportLeadsFromSearch.mock.calls[0][1];
    expect(args.title).toBe('RevOps Leaders');
    expect(args.keywords).toBeUndefined();
  });

  it('forwards keywords as fallback when title could NOT be extracted', async () => {
    // Persona with empty name → extractor returns no title, keywords falls
    // back to first sentence of brief. In that case the route should still
    // pass keywords through (it is the only signal).
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'u1',
      icpResult: [persona({ name: '' })],
    });
    mockReq.body = { icpIndex: 0 };
    await handler!(mockReq, mockRes);
    const args = mockImportLeadsFromSearch.mock.calls[0][1];
    expect(args.title).toBeUndefined();
    expect(args.keywords).toContain('RevOps managers at SaaS');
  });
});
