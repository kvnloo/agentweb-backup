/** ENG-3052: PUT/DELETE engagement routes map not-found to 404 and a lost race to 409. */
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


const db = crmDb as any;
const path = '/lists/:listId/leads/:leadId/engagements/:eventId';

describe.each([
  ['put', 'updateLeadEngagement'],
  ['delete', 'deleteLeadEngagement'],
])('%s engagement route error mapping (ENG-3052)', (method, dbFn) => {
  let req: any;
  let res: any;
  const handler = findHandler(router, path, method);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    req = {
      params: { listId: 'list-123', leadId: 'lead-1', eventId: 'e1' },
      body: { eventType: 'custom.note', eventData: {}, createdAt: '2026-11-01T00:00:00.000Z' },
      user: { userId: 'test-user-id', email: 'test@example.com' },
    };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    db.getLeadListById.mockResolvedValue({ listId: 'list-123', userId: 'test-user-id' });
  });

  it.each(['Lead not found', 'Engagement not found'])('AC3: "%s" is 404 with the same message', async (message) => {
    db[dbFn].mockRejectedValue(new Error(message));
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message });
  });

  it('AC3: a lost race is 409', async () => {
    db[dbFn].mockRejectedValue(Object.assign(new Error('Lead engagement precondition failed'), { preconditionFailed: true }));
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('any other error is still 500', async () => {
    db[dbFn].mockRejectedValue(new Error('throttled'));
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('success is unchanged', async () => {
    db[dbFn].mockResolvedValue({ listId: 'list-123', leadId: 'lead-1', engagements: [] });
    await handler!(req, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
