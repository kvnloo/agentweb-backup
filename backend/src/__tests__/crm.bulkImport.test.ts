/**
 * Tests for POST /lists/:listId/leads/bulk-import endpoint.
 *
 * Covers:
 * - Missing leads array → 400
 * - Empty leads array → 400
 * - leads is not an array → 400
 * - Unauthorized → 401
 * - List not found → 404
 * - Access denied → 403
 * - Successful bulk import → 201 with counts
 * - Partial dedup: skips leads whose email already exists in list
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

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
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailDomain: jest.fn(),
    getEventsByEmailDomainAndLeadEmail: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: { searchWeb: jest.fn() },
}));

jest.mock('../utils/llmService', () => ({
  createLLMService: jest.fn(),
}));

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(), setSetting: jest.fn() },
}));

jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn() },
}));

jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: { handleLeadEvent: jest.fn() },
}));

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com' };
    next();
  },
  AuthenticatedRequest: {},
}));

import { crmDb } from '../services/db';
import router from '../routes/crm';

// Helper to find route handler
const findHandler = (routerObj: any, path: string, method: string) => {
  const layer = routerObj.stack.find(
    (r: any) => r.route?.path === path && r.route?.methods?.[method]
  );
  if (!layer?.route) return null;
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  return (req: any, res: any) => handle(req, res, jest.fn());
};

// ─── POST /lists/:listId/leads/bulk-import ───────────────────────────────────

describe('POST /lists/:listId/leads/bulk-import', () => {
  let mockReq: any;
  let mockRes: any;

  const validLeads = [
    { firstName: 'Alice', lastName: 'Smith', email: 'alice@example.com', company: 'Acme', title: 'CEO' },
    { firstName: 'Bob', lastName: 'Jones', email: 'bob@example.com', company: 'BetaCo', title: 'CTO' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      params: { listId: 'list-123' },
      body: { leads: validLeads },
      user: { userId: 'test-user-id', email: 'test@example.com' },
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  const handler = findHandler(router, '/lists/:listId/leads/bulk-import', 'post');

  it('route handler exists', () => {
    expect(handler).not.toBeNull();
  });

  it('should return 400 when leads is missing', async () => {
    mockReq.body = {};
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('leads') })
    );
  });

  it('should return 400 when leads is empty array', async () => {
    mockReq.body = { leads: [] };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('leads') })
    );
  });

  it('should return 400 when leads is not an array', async () => {
    mockReq.body = { leads: 'not-an-array' };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('should return 401 when user is not authenticated', async () => {
    mockReq.user = undefined;
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Unauthorized' })
    );
  });

  it('should return 404 when list is not found', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Lead list not found' })
    );
  });

  it('should return 403 when user does not own the list', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
      listId: 'list-123',
      userId: 'other-user-id',
    });
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Access denied' })
    );
  });

  it('should return 201 with counts on successful import', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
      listId: 'list-123',
      userId: 'test-user-id',
    });
    (crmDb.batchCreateLeads as jest.Mock).mockResolvedValue({
      successCount: 2,
      newCount: 2,
      mergedCount: 0,
      errorCount: 0,
      errors: [],
    });

    await handler!(mockReq, mockRes);

    expect(crmDb.batchCreateLeads).toHaveBeenCalledWith('list-123', validLeads);
    expect(mockRes.status).toHaveBeenCalledWith(201);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ imported: 2, skipped: 0, errors: [] })
    );
  });

  it('should report skipped leads when batchCreateLeads merges duplicates', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
      listId: 'list-123',
      userId: 'test-user-id',
    });
    (crmDb.batchCreateLeads as jest.Mock).mockResolvedValue({
      successCount: 1,
      newCount: 1,
      mergedCount: 1,
      errorCount: 0,
      errors: [],
    });

    await handler!(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(201);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ imported: 1, skipped: 1 })
    );
  });

  it('should map linkedin_url field from Unipile search results', async () => {
    const unipileStyleLeads = [
      {
        firstName: 'Carol',
        lastName: 'White',
        email: 'carol@example.com',
        company: 'GammaCo',
        title: 'VP Sales',
        linkedin_url: 'https://www.linkedin.com/in/carolwhite',
      },
    ];
    mockReq.body = { leads: unipileStyleLeads };

    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
      listId: 'list-123',
      userId: 'test-user-id',
    });
    (crmDb.batchCreateLeads as jest.Mock).mockResolvedValue({
      successCount: 1,
      newCount: 1,
      mergedCount: 0,
      errorCount: 0,
      errors: [],
    });

    await handler!(mockReq, mockRes);

    // Verify linkedin_url was mapped to linkedin field
    const callArg = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0][1];
    expect(callArg[0]).toHaveProperty('linkedin', 'https://www.linkedin.com/in/carolwhite');
    expect(callArg[0]).not.toHaveProperty('linkedin_url');
  });
});
