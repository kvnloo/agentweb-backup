/**
 * Tests for the Bulk Delete leads endpoint.
 *
 * Covers:
 * - Missing/empty leadIds → 400
 * - Unauthorized user → 403
 * - List not found → 404
 * - Successful bulk delete → 200 with counts
 * - Partial failure handling
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

// ─── Bulk delete endpoint tests ─────────────────────────────────────────────

describe('DELETE /lists/:listId/leads/bulk-delete', () => {
  let mockReq: any;
  let mockRes: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      params: { listId: 'list-123' },
      body: { leadIds: ['lead-1', 'lead-2', 'lead-3'] },
      user: { userId: 'test-user-id', email: 'test@example.com' },
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  const handler = findHandler(router, '/lists/:listId/leads/bulk-delete', 'delete');

  it('should return 400 when leadIds is missing', async () => {
    mockReq.body = {};
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('leadIds') })
    );
  });

  it('should return 400 when leadIds is empty array', async () => {
    mockReq.body = { leadIds: [] };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('leadIds') })
    );
  });

  it('should return 400 when leadIds is not an array', async () => {
    mockReq.body = { leadIds: 'not-an-array' };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
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
      expect.objectContaining({ message: expect.stringContaining('CRM editor') })
    );
  });

  it('should return 200 with correct counts on successful bulk delete', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
      listId: 'list-123',
      userId: 'test-user-id',
    });
    (crmDb.deleteLead as jest.Mock).mockResolvedValue(undefined);

    await handler!(mockReq, mockRes);

    expect(crmDb.deleteLead).toHaveBeenCalledTimes(3);
    expect(crmDb.deleteLead).toHaveBeenCalledWith('list-123', 'lead-1');
    expect(crmDb.deleteLead).toHaveBeenCalledWith('list-123', 'lead-2');
    expect(crmDb.deleteLead).toHaveBeenCalledWith('list-123', 'lead-3');
    expect(mockRes.json).toHaveBeenCalledWith({ deleted: 3, failed: 0, total: 3 });
  });

  it('should handle partial failures gracefully', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
      listId: 'list-123',
      userId: 'test-user-id',
    });
    (crmDb.deleteLead as jest.Mock)
      .mockResolvedValueOnce(undefined) // lead-1 succeeds
      .mockRejectedValueOnce(new Error('DB error')) // lead-2 fails
      .mockResolvedValueOnce(undefined); // lead-3 succeeds

    await handler!(mockReq, mockRes);

    expect(crmDb.deleteLead).toHaveBeenCalledTimes(3);
    expect(mockRes.json).toHaveBeenCalledWith({ deleted: 2, failed: 1, total: 3 });
  });

  it('should return 401 when user is not authenticated', async () => {
    mockReq.user = undefined;
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Unauthorized' })
    );
  });
});
