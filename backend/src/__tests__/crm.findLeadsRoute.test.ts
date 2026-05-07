/**
 * Tests for POST /api/crm/lists/:listId/leads/find route.
 *
 * Covers:
 * - Body destructure widening (Phase 1): also forwards location/location_id,
 *   industry/industry_id, school/school_id, cursor, auto_enrich.
 * - Validation gate widening: any of keywords/title/company/search_url/location/
 *   industry/school/cursor passes; only "all absent" returns 400.
 * - Limit cap raised from 100 to 500.
 * - Existing 403/404 access-control regression coverage.
 */

// ─── Mocks (must be set before importing the router) ─────────────────────────

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

jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn() },
}));

jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: { handleLeadEvent: jest.fn() },
}));

jest.mock('../utils/s3Utils', () => ({ uploadFileToS3: jest.fn() }));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com' };
    next();
  },
  AuthenticatedRequest: {},
}));

import { crmDb } from '../services/db';
import router from '../routes/crm';

// Helper to find route handler — same pattern as crm.bulkImport.test.ts
const findHandler = (routerObj: any, path: string, method: string) => {
  const layer = routerObj.stack.find(
    (r: any) => r.route?.path === path && r.route?.methods?.[method]
  );
  if (!layer?.route) return null;
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  return (req: any, res: any) => handle(req, res, jest.fn());
};

describe('POST /api/crm/lists/:listId/leads/find', () => {
  let mockReq: any;
  let mockRes: any;
  const handler = findHandler(router, '/lists/:listId/leads/find', 'post');

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      params: { listId: 'list-1' },
      body: {},
      user: { userId: 'test-user-id', email: 'test@example.com' },
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
    mockImportLeadsFromSearch.mockResolvedValue({ success: true, imported: 0, skipped: 0 });
  });

  it('route handler exists', () => {
    expect(handler).not.toBeNull();
  });

  it('forwards keywords/title/company to the service (regression)', async () => {
    mockReq.body = { keywords: 'engineer', title: 'CTO', company: 'Acme' };
    await handler!(mockReq, mockRes);
    expect(mockImportLeadsFromSearch).toHaveBeenCalledWith(
      'test-user-id',
      expect.objectContaining({
        listId: 'list-1',
        keywords: 'engineer',
        title: 'CTO',
        company: 'Acme',
      }),
    );
  });

  it('forwards location/location_id/industry/industry_id/school/school_id', async () => {
    mockReq.body = {
      title: 'CTO',
      location: 'San Francisco Bay Area',
      location_id: '90000084',
      industry: 'Software',
      industry_id: '4',
      school: 'Stanford',
      school_id: '1234',
    };
    await handler!(mockReq, mockRes);
    expect(mockImportLeadsFromSearch).toHaveBeenCalledWith(
      'test-user-id',
      expect.objectContaining({
        listId: 'list-1',
        title: 'CTO',
        location: 'San Francisco Bay Area',
        location_id: '90000084',
        industry: 'Software',
        industry_id: '4',
        school: 'Stanford',
        school_id: '1234',
      }),
    );
  });

  it('forwards cursor for pagination (and accepts cursor as the sole filter)', async () => {
    mockReq.body = { cursor: 'next-page-token' };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).not.toHaveBeenCalledWith(400);
    expect(mockImportLeadsFromSearch).toHaveBeenCalledWith(
      'test-user-id',
      expect.objectContaining({
        listId: 'list-1',
        cursor: 'next-page-token',
      }),
    );
  });

  it('forwards auto_enrich=true', async () => {
    mockReq.body = { title: 'CTO', auto_enrich: true };
    await handler!(mockReq, mockRes);
    expect(mockImportLeadsFromSearch).toHaveBeenCalledWith(
      'test-user-id',
      expect.objectContaining({
        listId: 'list-1',
        title: 'CTO',
        auto_enrich: true,
      }),
    );
  });

  it('accepts search_url alone (no other filters required)', async () => {
    mockReq.body = { search_url: 'https://www.linkedin.com/search/results/people/?keywords=eng' };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).not.toHaveBeenCalledWith(400);
    expect(mockImportLeadsFromSearch).toHaveBeenCalled();
  });

  it('accepts location alone as the only filter (no keywords/title/company)', async () => {
    mockReq.body = { location: 'San Francisco Bay Area' };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).not.toHaveBeenCalledWith(400);
    expect(mockImportLeadsFromSearch).toHaveBeenCalledWith(
      'test-user-id',
      expect.objectContaining({ location: 'San Francisco Bay Area' }),
    );
  });

  it('400 when no filter, no cursor, and no search_url', async () => {
    mockReq.body = {};
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockImportLeadsFromSearch).not.toHaveBeenCalled();
  });

  it('caps limit at 500 (501 → forwarded as 500)', async () => {
    mockReq.body = { title: 'CTO', limit: 501 };
    await handler!(mockReq, mockRes);
    expect(mockImportLeadsFromSearch).toHaveBeenCalledWith(
      'test-user-id',
      expect.objectContaining({ limit: 500 }),
    );
  });

  it('caps limit at 500 even when limit=10000', async () => {
    mockReq.body = { title: 'CTO', limit: 10000 };
    await handler!(mockReq, mockRes);
    expect(mockImportLeadsFromSearch).toHaveBeenCalledWith(
      'test-user-id',
      expect.objectContaining({ limit: 500 }),
    );
  });

  it('defaults limit to 20 when omitted', async () => {
    mockReq.body = { title: 'CTO' };
    await handler!(mockReq, mockRes);
    expect(mockImportLeadsFromSearch).toHaveBeenCalledWith(
      'test-user-id',
      expect.objectContaining({ limit: 20 }),
    );
  });

  it('accepts limit as a string number "50" → forwarded as 50', async () => {
    mockReq.body = { title: 'CTO', limit: '50' };
    await handler!(mockReq, mockRes);
    expect(mockImportLeadsFromSearch).toHaveBeenCalledWith(
      'test-user-id',
      expect.objectContaining({ limit: 50 }),
    );
  });

  it('403 when user cannot access list (canAccessCrmList false)', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'other-user' });
    mockReq.body = { title: 'CTO' };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockImportLeadsFromSearch).not.toHaveBeenCalled();
  });

  it('404 when list missing', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);
    mockReq.body = { title: 'CTO' };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
    expect(mockImportLeadsFromSearch).not.toHaveBeenCalled();
  });
});
