/**
 * Tests for the Do Not Contact / Contact Status feature.
 *
 * Covers:
 * - isDoNotContact() helper (unit tests)
 * - Bulk contact status update endpoint
 * - Group email preview/prepare/send filtering of DNC leads
 * - Public unsubscribe sets contactStatus
 * - Public resubscribe clears contactStatus
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

import { isDoNotContact, getDoNotContactReason } from '../utils/leadContactStatus';
import { crmDb } from '../services/db';
import router from '../routes/crm';
import publicRouter from '../routes/crmPublic';

// Helper to find route handler
const findHandler = (routerObj: any, path: string, method: string) => {
  const layer = routerObj.stack.find(
    (r: any) => r.route?.path === path && r.route?.methods?.[method]
  );
  if (!layer?.route) return null;
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  return (req: any, res: any) => handle(req, res, jest.fn());
};

// ─── isDoNotContact helper tests ─────────────────────────────────────────────

describe('isDoNotContact helper', () => {
  it('returns false for a lead with no contact status fields', () => {
    expect(isDoNotContact({ email: 'a@b.com' })).toBe(false);
  });

  it('returns false for contactStatus = active', () => {
    expect(isDoNotContact({ contactStatus: 'active' })).toBe(false);
  });

  it('returns true for contactStatus = do-not-contact', () => {
    expect(isDoNotContact({ contactStatus: 'do-not-contact' })).toBe(true);
  });

  it('returns true for contactStatus = unsubscribed', () => {
    expect(isDoNotContact({ contactStatus: 'unsubscribed' })).toBe(true);
  });

  it('returns true for legacy unsubscribedFromGroupEmail without contactStatus', () => {
    expect(isDoNotContact({ unsubscribedFromGroupEmail: true })).toBe(true);
  });

  it('returns false for legacy unsubscribedFromGroupEmail=false', () => {
    expect(isDoNotContact({ unsubscribedFromGroupEmail: false })).toBe(false);
  });

  it('returns false when contactStatus=active even if legacy flag is true', () => {
    // New field takes precedence
    expect(isDoNotContact({ contactStatus: 'active', unsubscribedFromGroupEmail: true })).toBe(false);
  });
});

describe('getDoNotContactReason helper', () => {
  it('returns null for an active lead', () => {
    expect(getDoNotContactReason({ contactStatus: 'active' })).toBeNull();
  });

  it('returns reason string for DNC lead', () => {
    const reason = getDoNotContactReason({
      contactStatus: 'do-not-contact',
      contactStatusReason: 'bounced',
      contactStatusNote: 'Hard bounce',
    });
    expect(reason).toBe('Do Not Contact (bounced): Hard bounce');
  });

  it('returns reason for unsubscribed lead', () => {
    const reason = getDoNotContactReason({
      contactStatus: 'unsubscribed',
      contactStatusReason: 'opted-out',
    });
    expect(reason).toBe('Unsubscribed (opted-out)');
  });

  it('returns legacy reason for old-style unsubscribed lead', () => {
    const reason = getDoNotContactReason({ unsubscribedFromGroupEmail: true });
    expect(reason).toBe('Unsubscribed from group email');
  });
});

// ─── Bulk contact status endpoint tests ──────────────────────────────────────

describe('PUT /lists/:listId/leads/bulk-contact-status', () => {
  let mockReq: any;
  let mockRes: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      user: { userId: 'test-user-id', email: 'test@example.com' },
      params: { listId: 'list-1' },
      body: {},
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  const handler = () => findHandler(router, '/lists/:listId/leads/bulk-contact-status', 'put');

  beforeEach(() => {
    // The route reads each lead before updating it (ENG-2840); by default every named lead exists.
    (crmDb.getLeadById as jest.Mock).mockImplementation(async (_listId: string, leadId: string) => ({ leadId }));
  });

  it('returns 400 if leadIds is missing', async () => {
    mockReq.body = { contactStatus: 'do-not-contact' };
    await handler()!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 if contactStatus is invalid', async () => {
    mockReq.body = { leadIds: ['lead-1'], contactStatus: 'invalid' };
    await handler()!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 if contactStatusReason is invalid', async () => {
    mockReq.body = { leadIds: ['lead-1'], contactStatus: 'do-not-contact', contactStatusReason: 'made-up' };
    await handler()!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 if list not found', async () => {
    mockReq.body = { leadIds: ['lead-1'], contactStatus: 'do-not-contact' };
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);
    await handler()!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it('returns 403 if list belongs to another user', async () => {
    mockReq.body = { leadIds: ['lead-1'], contactStatus: 'do-not-contact' };
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'other-user' });
    await handler()!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(403);
  });

  it('successfully bulk-updates leads to do-not-contact', async () => {
    mockReq.body = {
      leadIds: ['lead-1', 'lead-2'],
      contactStatus: 'do-not-contact',
      contactStatusReason: 'admin-flagged',
      contactStatusNote: 'Compliance cleanup',
    };
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
    (crmDb.updateLead as jest.Mock).mockResolvedValue({});

    await handler()!(mockReq, mockRes);

    expect(crmDb.updateLead).toHaveBeenCalledTimes(2);
    // Verify DNC leads also get legacy flag
    const firstCall = (crmDb.updateLead as jest.Mock).mock.calls[0];
    expect(firstCall[0]).toBe('list-1');
    expect(firstCall[1]).toBe('lead-1');
    expect(firstCall[2]).toMatchObject({
      contactStatus: 'do-not-contact',
      contactStatusReason: 'admin-flagged',
      contactStatusNote: 'Compliance cleanup',
      unsubscribedFromGroupEmail: true,
    });

    expect(mockRes.json).toHaveBeenCalledWith({ updated: 2, failed: 0, total: 2 });
  });

  it('successfully bulk-updates leads to active (clears DNC)', async () => {
    mockReq.body = { leadIds: ['lead-1'], contactStatus: 'active' };
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
    (crmDb.updateLead as jest.Mock).mockResolvedValue({});

    await handler()!(mockReq, mockRes);

    const call = (crmDb.updateLead as jest.Mock).mock.calls[0];
    expect(call[2]).toMatchObject({
      contactStatus: 'active',
      unsubscribedFromGroupEmail: false,
      contactStatusReason: null,
      contactStatusNote: null,
    });
    expect(mockRes.json).toHaveBeenCalledWith({ updated: 1, failed: 0, total: 1 });
  });

  // ENG-2840: updateLead is an upsert, so an unknown id used to create a stub lead in the list.
  it('never creates a lead for an id that is not in the list: it counts as failed', async () => {
    mockReq.body = { leadIds: ['lead-1', 'ghost-lead'], contactStatus: 'do-not-contact' };
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
    (crmDb.getLeadById as jest.Mock).mockImplementation(async (_listId: string, leadId: string) => (leadId === 'lead-1' ? { leadId } : null));
    (crmDb.updateLead as jest.Mock).mockResolvedValue({});

    await handler()!(mockReq, mockRes);

    expect(crmDb.getLeadById).toHaveBeenCalledWith('list-1', 'ghost-lead', { consistentRead: true });
    expect(crmDb.updateLead).toHaveBeenCalledTimes(1);
    expect((crmDb.updateLead as jest.Mock).mock.calls[0][1]).toBe('lead-1');
    expect(mockRes.json).toHaveBeenCalledWith({ updated: 1, failed: 1, total: 2 });
  });

  it('refuses more than 500 lead ids before touching the list', async () => {
    mockReq.body = { leadIds: Array.from({ length: 501 }, (_, i) => `lead-${i}`), contactStatus: 'do-not-contact' };
    await handler()!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(crmDb.getLeadListById).not.toHaveBeenCalled();
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('refuses lead ids that are not strings', async () => {
    mockReq.body = { leadIds: ['lead-1', { $ne: null }], contactStatus: 'do-not-contact' };
    await handler()!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('counts failed updates when updateLead throws', async () => {
    mockReq.body = { leadIds: ['lead-1', 'lead-2'], contactStatus: 'do-not-contact' };
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
    (crmDb.updateLead as jest.Mock)
      .mockRejectedValueOnce(new Error('DB error'))
      .mockResolvedValueOnce({});

    await handler()!(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith({ updated: 1, failed: 1, total: 2 });
  });
});

// ─── Group email preview with DNC leads ──────────────────────────────────────

describe('Group email preview respects contactStatus', () => {
  let mockReq: any;
  let mockRes: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      user: { userId: 'test-user-id', email: 'test@example.com' },
      params: { listId: 'list-1' },
      body: {},
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  it('excludes leads with contactStatus=do-not-contact from eligible count', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
    (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
      items: [
        { leadId: '1', email: 'active@test.com' },
        { leadId: '2', email: 'dnc@test.com', contactStatus: 'do-not-contact', contactStatusReason: 'bounced' },
        { leadId: '3', email: 'unsub@test.com', contactStatus: 'unsubscribed' },
        { leadId: '4', email: 'legacy@test.com', unsubscribedFromGroupEmail: true },
      ],
      lastEvaluatedKey: undefined,
    });

    const handler = findHandler(router, '/lists/:listId/group-email/preview', 'post');
    await handler!(mockReq, mockRes);

    const result = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(result.totalLeads).toBe(4);
    expect(result.eligibleLeads).toBe(1);
    expect(result.doNotContactCount).toBe(3);
  });
});

// ─── Public unsubscribe/resubscribe sets contactStatus ───────────────────────

describe('Public unsubscribe endpoint sets contactStatus', () => {
  let mockReq: any;
  let mockRes: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      params: { listId: 'list-1', leadId: 'lead-1' },
      body: { email: 'user@test.com', feedback: 'Not interested' },
      query: {},
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  it('sets contactStatus to unsubscribed with reason and feedback on unsubscribe', async () => {
    (crmDb.getLeadById as jest.Mock).mockResolvedValue({
      leadId: 'lead-1',
      email: 'user@test.com',
    });
    (crmDb.updateLead as jest.Mock).mockResolvedValue({});

    const handler = findHandler(publicRouter, '/lists/:listId/leads/:leadId/group-email-unsubscribe', 'post');
    await handler!(mockReq, mockRes);

    expect(crmDb.updateLead).toHaveBeenCalledWith('list-1', 'lead-1', expect.objectContaining({
      contactStatus: 'unsubscribed',
      contactStatusReason: 'opted-out',
      contactStatusNote: 'Not interested',
      contactStatusUpdatedBy: 'lead-self',
      unsubscribedFromGroupEmail: true,
    }));
    expect(mockRes.json).toHaveBeenCalledWith({ message: 'Successfully unsubscribed' });
  });

  it('clears contactStatus on resubscribe', async () => {
    (crmDb.getLeadById as jest.Mock).mockResolvedValue({
      leadId: 'lead-1',
      email: 'user@test.com',
    });
    (crmDb.updateLead as jest.Mock).mockResolvedValue({});

    mockReq.body = { email: 'user@test.com' };
    const handler = findHandler(publicRouter, '/lists/:listId/leads/:leadId/group-email-resubscribe', 'post');
    await handler!(mockReq, mockRes);

    expect(crmDb.updateLead).toHaveBeenCalledWith('list-1', 'lead-1', expect.objectContaining({
      contactStatus: 'active',
      contactStatusReason: null,
      contactStatusNote: null,
      contactStatusUpdatedBy: 'lead-self',
      unsubscribedFromGroupEmail: false,
    }));
    expect(mockRes.json).toHaveBeenCalledWith({ message: 'Successfully resubscribed' });
  });
});

// ─── Public status endpoint includes contactStatus ───────────────────────────

describe('Public status endpoint returns contactStatus', () => {
  it('returns contactStatus for a lead with new fields', async () => {
    const mockReq: any = {
      params: { listId: 'list-1', leadId: 'lead-1' },
      query: { email: 'user@test.com' },
    };
    const mockRes: any = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    (crmDb.getLeadById as jest.Mock).mockResolvedValue({
      leadId: 'lead-1',
      email: 'user@test.com',
      contactStatus: 'do-not-contact',
      contactStatusReason: 'bounced',
    });

    const handler = findHandler(publicRouter, '/lists/:listId/leads/:leadId/group-email-status', 'get');
    await handler!(mockReq, mockRes);

    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      unsubscribed: true,
      contactStatus: 'do-not-contact',
      contactStatusReason: 'bounced',
    }));
  });
});
