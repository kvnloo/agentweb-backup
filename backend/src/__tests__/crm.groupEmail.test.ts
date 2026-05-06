// Unit tests for CRM group email endpoints

jest.mock('../server', () => ({
  io: {
    to: jest.fn().mockReturnValue({
      emit: jest.fn(),
    }),
    emit: jest.fn(),
  },
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

import { Request, Response } from 'express';
import { crmDb } from '../services/db';
import { resendService } from '../services/resendService';
import { io } from '../server';
import router from '../routes/crm';

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
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn(),
  },
}));

jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: { handleLeadEvent: jest.fn() },
}));

const mockUploadFileToS3 = jest.fn();
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: (...args: any[]) => mockUploadFileToS3(...args),
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com' };
    next();
  },
  AuthenticatedRequest: {},
}));

// Helper to find route handler
const findHandler = (path: string, method: string) => {
  const layer = (router as any).stack.find(
    (r: any) => r.route?.path === path && r.route?.methods?.[method]
  );
  if (!layer?.route) return null;
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  // Wrap to match (req, res) signature for test convenience
  return (req: any, res: any) => handle(req, res, jest.fn());
};

describe('CRM Group Email Endpoints', () => {
  let mockReq: any;
  let mockRes: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      user: { userId: 'test-user-id', email: 'test@example.com' },
      params: { listId: 'list-1' },
      query: {},
      body: {},
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  // --- FAIL tests: validation and error cases ---

  describe('POST /lists/:listId/group-email/preview', () => {
    it('should return 404 if list not found', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);

      const handler = findHandler('/lists/:listId/group-email/preview', 'post');
      expect(handler).toBeTruthy();
      await handler!(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(404);
    });

    it('should return 403 if list belongs to another user', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'other-user',
      });

      const handler = findHandler('/lists/:listId/group-email/preview', 'post');
      await handler!(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    it('should return correct counts with unsubscribed and no-email leads', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: '1', email: 'a@test.com' },
          { leadId: '2', email: 'b@test.com', unsubscribedFromGroupEmail: true },
          { leadId: '3' }, // no email
          { leadId: '4', email: 'c@test.com' },
        ],
        lastEvaluatedKey: undefined,
      });

      const handler = findHandler('/lists/:listId/group-email/preview', 'post');
      await handler!(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith({
        totalLeads: 4,
        eligibleLeads: 2,
        unsubscribedCount: 1,
        doNotContactCount: 1,
        noEmailCount: 1,
        undeliverableCount: 0,
        riskyCount: 0,
        undeliverableEmails: [],
        riskyEmails: [],
      });
    });

    it('should filter by leadIds when provided', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: '1', email: 'a@test.com' },
          { leadId: '2', email: 'b@test.com' },
          { leadId: '3', email: 'c@test.com' },
        ],
        lastEvaluatedKey: undefined,
      });

      mockReq.body = { leadIds: ['1', '3'] };
      const handler = findHandler('/lists/:listId/group-email/preview', 'post');
      await handler!(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith({
        totalLeads: 2,
        eligibleLeads: 2,
        unsubscribedCount: 0,
        doNotContactCount: 0,
        noEmailCount: 0,
        undeliverableCount: 0,
        riskyCount: 0,
        undeliverableEmails: [],
        riskyEmails: [],
      });
    });
  });

  describe('POST /lists/:listId/group-email/prepare', () => {
    it('should return readiness with all leads ready when no variables used', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: '1', email: 'a@test.com' },
          { leadId: '2', email: 'b@test.com' },
        ],
        lastEvaluatedKey: undefined,
      });

      mockReq.body = { subject: 'Hello', htmlContent: '<p>No variables here</p>' };

      const handler = findHandler('/lists/:listId/group-email/prepare', 'post');
      expect(handler).toBeTruthy();
      await handler!(mockReq, mockRes);

      const result = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(result.readyCount).toBe(2);
      expect(result.notReadyCount).toBe(0);
      expect(result.variables).toEqual([]);
    });

    it('should detect leads missing required variable values', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: '1', email: 'a@test.com', firstName: 'Alice', company: 'Acme' },
          { leadId: '2', email: 'b@test.com', firstName: 'Bob' }, // missing company
          { leadId: '3', email: 'c@test.com' }, // missing both firstName and company
          { leadId: '4', email: 'd@test.com', unsubscribedFromGroupEmail: true, firstName: 'Dan', company: 'Corp' }, // unsubscribed
          { leadId: '5' }, // no email
        ],
        lastEvaluatedKey: undefined,
      });

      mockReq.body = {
        subject: 'Hello {{firstName}}',
        htmlContent: '<p>Hi {{firstName}} at {{company}}</p>',
      };

      const handler = findHandler('/lists/:listId/group-email/prepare', 'post');
      await handler!(mockReq, mockRes);

      const result = (mockRes.json as jest.Mock).mock.calls[0][0];
      // Only eligible leads (have email, not unsubscribed): leads 1, 2, 3
      expect(result.eligibleCount).toBe(3);
      // Lead 1 has both firstName + company → ready
      // Lead 2 has firstName but not company → not ready
      // Lead 3 has neither → not ready
      expect(result.readyCount).toBe(1);
      expect(result.notReadyCount).toBe(2);
      expect(result.variables).toEqual(expect.arrayContaining(['firstName', 'company']));
      expect(result.variableCoverage).toEqual(
        expect.objectContaining({
          firstName: { present: 2, missing: 1 },
          company: { present: 1, missing: 2 },
        })
      );
    });

    it('should return 400 if subject and htmlContent are missing', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });

      mockReq.body = {};

      const handler = findHandler('/lists/:listId/group-email/prepare', 'post');
      await handler!(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });

  describe('POST /lists/:listId/group-email/send', () => {
    it('should return 400 if required fields missing', async () => {
      mockReq.body = { subject: 'Hi' }; // missing senderEmail, htmlContent
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });

      const handler = findHandler('/lists/:listId/group-email/send', 'post');
      await handler!(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should return 404 if list not found', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);
      mockReq.body = {
        senderEmail: 'me@test.com',
        senderName: 'Me',
        subject: 'Hi',
        htmlContent: '<p>Hello</p>',
      };

      const handler = findHandler('/lists/:listId/group-email/send', 'post');
      await handler!(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(404);
    });

    it('should skip unsubscribed leads and leads without email', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: '1', email: 'a@test.com', firstName: 'A' },
          { leadId: '2', email: 'b@test.com', unsubscribedFromGroupEmail: true },
          { leadId: '3' }, // no email
        ],
        lastEvaluatedKey: undefined,
      });
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'msg-1' });

      mockReq.body = {
        senderEmail: 'me@test.com',
        senderName: 'Me',
        subject: 'Hello {{firstName}}',
        htmlContent: '<p>Hi {{firstName}}</p>',
      };

      const handler = findHandler('/lists/:listId/group-email/send', 'post');
      await handler!(mockReq, mockRes);

      // Only 1 email should be sent (a@test.com)
      expect(resendService.sendEmail).toHaveBeenCalledTimes(1);
      const call = (resendService.sendEmail as jest.Mock).mock.calls[0][0];
      expect(call.to).toBe('a@test.com');
      // Subject should have variable substituted
      expect(call.subject).toBe('Hello A');
      // HTML should contain unsubscribe link
      expect(call.html).toContain('Unsubscribe');

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(response.sent).toBe(1);
      expect(response.skippedUnsubscribed).toBe(1);
    });

    it('should emit progress via socket when socketId provided', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: '1', email: 'a@test.com' },
          { leadId: '2', email: 'b@test.com' },
        ],
        lastEvaluatedKey: undefined,
      });
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'msg-1' });

      mockReq.body = {
        socketId: 'socket-123',
        senderEmail: 'me@test.com',
        senderName: 'Me',
        subject: 'Hi',
        htmlContent: '<p>Hello</p>',
      };

      const handler = findHandler('/lists/:listId/group-email/send', 'post');
      await handler!(mockReq, mockRes);

      expect(io.to).toHaveBeenCalledWith('socket-123');
    });
  });

  describe('POST /lists/:listId/group-email/test', () => {
    it('should return 400 if no recipients provided', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });
      mockReq.body = {
        senderEmail: 'me@test.com',
        senderName: 'Me',
        subject: 'Test',
        htmlContent: '<p>Hi</p>',
        recipients: [],
      };

      const handler = findHandler('/lists/:listId/group-email/test', 'post');
      await handler!(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should prepend test banner and [TEST] to subject', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'msg-1' });

      mockReq.body = {
        senderEmail: 'me@test.com',
        senderName: 'Me',
        subject: 'Newsletter',
        htmlContent: '<p>Content</p>',
        recipients: ['test@recipient.com'],
      };

      const handler = findHandler('/lists/:listId/group-email/test', 'post');
      await handler!(mockReq, mockRes);

      const call = (resendService.sendEmail as jest.Mock).mock.calls[0][0];
      expect(call.subject).toBe('[TEST] Newsletter');
      expect(call.html).toContain('TEST EMAIL');
      expect(call.to).toBe('test@recipient.com');
    });

    it('should skip invalid email addresses', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'msg-1' });

      mockReq.body = {
        senderEmail: 'me@test.com',
        senderName: 'Me',
        subject: 'Test',
        htmlContent: '<p>Hi</p>',
        recipients: ['valid@test.com', 'not-an-email', 'also@valid.com'],
      };

      const handler = findHandler('/lists/:listId/group-email/test', 'post');
      await handler!(mockReq, mockRes);

      expect(resendService.sendEmail).toHaveBeenCalledTimes(2);
    });
  });
});

describe('CRM Public Unsubscribe Endpoints', () => {
  // We test the public routes by importing crmPublic router
  let publicRouter: any;
  let mockReq: any;
  let mockRes: any;

  beforeEach(() => {
    jest.clearAllMocks();
    // Import fresh each time
    publicRouter = require('../routes/crmPublic').default;
    mockReq = {
      params: { listId: 'list-1', leadId: 'lead-1' },
      query: {},
      body: {},
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  const findPublicHandler = (path: string, method: string) => {
    const layer = publicRouter.stack.find(
      (r: any) => r.route?.path === path && r.route?.methods?.[method]
    );
    if (!layer?.route) return null;
    const handle = layer.route.stack[layer.route.stack.length - 1].handle;
    return (req: any, res: any) => handle(req, res, jest.fn());
  };

  describe('GET /lists/:listId/leads/:leadId/group-email-status', () => {
    it('should return 400 if email query param missing', async () => {
      const handler = findPublicHandler(
        '/lists/:listId/leads/:leadId/group-email-status',
        'get'
      );
      expect(handler).toBeTruthy();
      await handler!(mockReq, mockRes);
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should return 404 if lead not found', async () => {
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(null);
      mockReq.query = { email: 'a@test.com' };

      const handler = findPublicHandler(
        '/lists/:listId/leads/:leadId/group-email-status',
        'get'
      );
      await handler!(mockReq, mockRes);
      expect(mockRes.status).toHaveBeenCalledWith(404);
    });

    it('should return 403 if email does not match lead', async () => {
      (crmDb.getLeadById as jest.Mock).mockResolvedValue({
        leadId: 'lead-1',
        email: 'different@test.com',
      });
      mockReq.query = { email: 'a@test.com' };

      const handler = findPublicHandler(
        '/lists/:listId/leads/:leadId/group-email-status',
        'get'
      );
      await handler!(mockReq, mockRes);
      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    it('should return unsubscribe status when email matches', async () => {
      (crmDb.getLeadById as jest.Mock).mockResolvedValue({
        leadId: 'lead-1',
        email: 'a@test.com',
        unsubscribedFromGroupEmail: true,
      });
      mockReq.query = { email: 'a@test.com' };

      const handler = findPublicHandler(
        '/lists/:listId/leads/:leadId/group-email-status',
        'get'
      );
      await handler!(mockReq, mockRes);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        unsubscribed: true,
      }));
    });
  });

  describe('POST /lists/:listId/leads/:leadId/group-email-unsubscribe', () => {
    it('should return 400 if email missing from body', async () => {
      const handler = findPublicHandler(
        '/lists/:listId/leads/:leadId/group-email-unsubscribe',
        'post'
      );
      expect(handler).toBeTruthy();
      await handler!(mockReq, mockRes);
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should return 403 if email does not match lead', async () => {
      (crmDb.getLeadById as jest.Mock).mockResolvedValue({
        leadId: 'lead-1',
        email: 'different@test.com',
      });
      mockReq.body = { email: 'wrong@test.com' };

      const handler = findPublicHandler(
        '/lists/:listId/leads/:leadId/group-email-unsubscribe',
        'post'
      );
      await handler!(mockReq, mockRes);
      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    it('should unsubscribe lead when email matches', async () => {
      (crmDb.getLeadById as jest.Mock).mockResolvedValue({
        leadId: 'lead-1',
        email: 'a@test.com',
      });
      (crmDb.updateLead as jest.Mock).mockResolvedValue({});
      mockReq.body = { email: 'a@test.com' };

      const handler = findPublicHandler(
        '/lists/:listId/leads/:leadId/group-email-unsubscribe',
        'post'
      );
      await handler!(mockReq, mockRes);

      expect(crmDb.updateLead).toHaveBeenCalledWith('list-1', 'lead-1', expect.objectContaining({
        unsubscribedFromGroupEmail: true,
        unsubscribedFromGroupEmailAt: expect.any(String),
        contactStatus: 'unsubscribed',
        contactStatusReason: 'opted-out',
        contactStatusUpdatedBy: 'lead-self',
      }));
      expect(mockRes.json).toHaveBeenCalledWith({
        message: 'Successfully unsubscribed',
      });
    });
  });

  describe('POST /lists/:listId/leads/:leadId/group-email-resubscribe', () => {
    it('should resubscribe lead when email matches', async () => {
      (crmDb.getLeadById as jest.Mock).mockResolvedValue({
        leadId: 'lead-1',
        email: 'a@test.com',
        unsubscribedFromGroupEmail: true,
      });
      (crmDb.updateLead as jest.Mock).mockResolvedValue({});
      mockReq.body = { email: 'a@test.com' };

      const handler = findPublicHandler(
        '/lists/:listId/leads/:leadId/group-email-resubscribe',
        'post'
      );
      expect(handler).toBeTruthy();
      await handler!(mockReq, mockRes);

      expect(crmDb.updateLead).toHaveBeenCalledWith('list-1', 'lead-1', expect.objectContaining({
        unsubscribedFromGroupEmail: false,
        contactStatus: 'active',
        contactStatusReason: null,
        contactStatusNote: null,
        contactStatusUpdatedBy: 'lead-self',
      }));
      expect(mockRes.json).toHaveBeenCalledWith({
        message: 'Successfully resubscribed',
      });
    });
  });
});
