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
import { settingsService } from '../services/settingsService';
import { io } from '../server';
import { senderUsageTracker } from '../services/senderUsageTrackerFactory';
import { SenderDailyLimitExceededError } from '../services/senderUsageTracker';
import { getPendingBatch, upsertPendingBatch, deletePendingBatch, PendingBatchConflictError } from '../services/groupEmailPendingBatchService';
import router, { runMailboxGroupEmailBackground } from '../routes/crm';
import * as sendAsSenderModule from '../services/sendAsSender';

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

jest.mock('../services/senderUsageTrackerFactory', () => ({
  senderUsageTracker: {
    reserveSend: jest.fn().mockResolvedValue(undefined),
    releaseSend: jest.fn().mockResolvedValue(undefined),
    getUsage: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn(),
  },
}));

const mockGetEmailProvider = jest.fn();
jest.mock('../services/emailProviderService', () => ({
  getEmailProvider: (...args: any[]) => mockGetEmailProvider(...args),
  bootstrapEmailProviders: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: { handleLeadEvent: jest.fn() },
}));

jest.mock('../services/groupEmailPendingBatchService', () => ({
  ...jest.requireActual('../services/groupEmailPendingBatchService'),
  getPendingBatch: jest.fn().mockResolvedValue(null),
  upsertPendingBatch: jest.fn().mockResolvedValue(undefined),
  deletePendingBatch: jest.fn().mockResolvedValue(undefined),
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
        smartleadCount: 0,
        noEmailCount: 1,
        undeliverableCount: 0,
        riskyCount: 0,
        invalidCount: 0,
        undeliverableEmails: [],
        riskyEmails: [],
        invalidEmails: [],
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
        smartleadCount: 0,
        noEmailCount: 0,
        undeliverableCount: 0,
        riskyCount: 0,
        invalidCount: 0,
        undeliverableEmails: [],
        riskyEmails: [],
        invalidEmails: [],
      });
    });

    it('ENG-1194: reports malformed and provider-disallowed test-domain rows as invalid, excluded from eligible', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: '1', email: 'valid@agentweb.pro' },
          { leadId: '2', email: 'queue-verify@example.com' }, // provider-disallowed test domain
          { leadId: '3', email: 'noTld@updates' }, // missing/invalid domain
          { leadId: '4', email: 'harsha..v@agentweb.pro' }, // repeated-dot local part
        ],
        lastEvaluatedKey: undefined,
      });

      const handler = findHandler('/lists/:listId/group-email/preview', 'post');
      await handler!(mockReq, mockRes);

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(response.totalLeads).toBe(4);
      expect(response.invalidCount).toBe(3);
      expect(response.eligibleLeads).toBe(1);
      expect(response.invalidEmails.sort()).toEqual(
        ['queue-verify@example.com', 'noTld@updates', 'harsha..v@agentweb.pro'].sort(),
      );
    });
  });

  describe('ENG-673 — leads pushed to a customer\'s Smartlead campaign', () => {
    it('preview leaves pushed (and withdrawn) leads out of the eligible count and reports them; a released marker is eligible again', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: '1', email: 'plain@agentweb.pro' },
          { leadId: '2', email: 'pushed@agentweb.pro', system: { smartlead_77: { state: 'pushed', pushedAt: 'x', runId: 'r', payloadHash: 'h' } } },
          { leadId: '3', email: 'withdrawn@agentweb.pro', system: { smartlead_77: { state: 'withdrawn', pushedAt: 'x', runId: 'r', payloadHash: 'h' } } },
          { leadId: '4', email: 'released@agentweb.pro', system: { smartlead_77: { state: 'released', pushedAt: 'x', runId: 'r', payloadHash: 'h' } } },
        ],
        lastEvaluatedKey: undefined,
      });
      const handler = findHandler('/lists/:listId/group-email/preview', 'post');
      await handler!(mockReq, mockRes);
      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(response.totalLeads).toBe(4);
      expect(response.smartleadCount).toBe(2);
      expect(response.eligibleLeads).toBe(2);
    });

    it('a lead that is both do-not-contact and pushed is counted once (as do-not-contact), not twice', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: '1', email: 'both@agentweb.pro', contactStatus: 'unsubscribed', system: { smartlead_77: { state: 'pushed', pushedAt: 'x', runId: 'r', payloadHash: 'h' } } },
          { leadId: '2', email: 'plain@agentweb.pro' },
        ],
        lastEvaluatedKey: undefined,
      });
      const handler = findHandler('/lists/:listId/group-email/preview', 'post');
      await handler!(mockReq, mockRes);
      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(response.doNotContactCount).toBe(1);
      expect(response.smartleadCount).toBe(0);
      expect(response.eligibleLeads).toBe(1);
    });

    it('send to an explicit selection still leaves a selected pushed lead out', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: '1', email: 'plain@agentweb.pro' },
          { leadId: '2', email: 'pushed@agentweb.pro', system: { smartlead_77: { state: 'pushed', pushedAt: 'x', runId: 'r', payloadHash: 'h' } } },
          { leadId: '3', email: 'other@agentweb.pro' },
        ],
        lastEvaluatedKey: undefined,
      });
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'msg-1' });
      mockReq.body = { senderEmail: 'me@test.com', senderName: 'Me', subject: 'Hi', htmlContent: '<p>Hello</p>', leadIds: ['1', '2'] };
      const handler = findHandler('/lists/:listId/group-email/send', 'post');
      await handler!(mockReq, mockRes);
      expect((resendService.sendEmail as jest.Mock).mock.calls.map(c => c[0].to)).toEqual(['plain@agentweb.pro']);
      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(response.total).toBe(1);
      expect(response.skippedSmartlead).toBe(1);
    });

    it('prepare counts the same recipients as preview', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: '1', email: 'plain@agentweb.pro' },
          { leadId: '2', email: 'pushed@agentweb.pro', system: { smartlead_77: { state: 'pushed', pushedAt: 'x', runId: 'r', payloadHash: 'h' } } },
          { leadId: '3', email: 'withdrawn@agentweb.pro', system: { smartlead_77: { state: 'withdrawn', pushedAt: 'x', runId: 'r', payloadHash: 'h' } } },
          { leadId: '4', email: 'released@agentweb.pro', system: { smartlead_77: { state: 'released', pushedAt: 'x', runId: 'r', payloadHash: 'h' } } },
        ],
        lastEvaluatedKey: undefined,
      });
      mockReq.body = { subject: 'Hello', htmlContent: '<p>No variables here</p>' };
      const handler = findHandler('/lists/:listId/group-email/prepare', 'post');
      await handler!(mockReq, mockRes);
      const result = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(result.eligibleCount).toBe(2);
      expect(result.readyCount).toBe(2);
    });

    it('send never emails a pushed or withdrawn lead, and reports how many it left out', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: '1', email: 'plain@agentweb.pro' },
          { leadId: '2', email: 'pushed@agentweb.pro', system: { smartlead_77: { state: 'pushed', pushedAt: 'x', runId: 'r', payloadHash: 'h' } } },
          { leadId: '3', email: 'withdrawn@agentweb.pro', system: { smartlead_77: { state: 'withdrawn', pushedAt: 'x', runId: 'r', payloadHash: 'h' } } },
          { leadId: '4', email: 'released@agentweb.pro', system: { smartlead_77: { state: 'released', pushedAt: 'x', runId: 'r', payloadHash: 'h' } } },
        ],
        lastEvaluatedKey: undefined,
      });
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'msg-1' });
      mockReq.body = { senderEmail: 'me@test.com', senderName: 'Me', subject: 'Hi', htmlContent: '<p>Hello</p>' };
      const handler = findHandler('/lists/:listId/group-email/send', 'post');
      await handler!(mockReq, mockRes);
      const sentTo = (resendService.sendEmail as jest.Mock).mock.calls.map(c => c[0].to).sort();
      expect(sentTo).toEqual(['plain@agentweb.pro', 'released@agentweb.pro']);
      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(response.skippedSmartlead).toBe(2);
      expect(response.sent).toBe(2);
      expect(response.total).toBe(2);
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

    it('ENG-1194: excludes malformed and provider-disallowed test-domain rows from eligibleCount/readyCount', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: '1', email: 'valid@agentweb.pro' },
          { leadId: '2', email: 'queue-verify@example.com' }, // provider-disallowed test domain
          { leadId: '3', email: 'noTld@updates' }, // missing/invalid domain
          { leadId: '4', email: 'harsha..v@agentweb.pro' }, // repeated-dot local part
        ],
        lastEvaluatedKey: undefined,
      });

      mockReq.body = { subject: 'Hello', htmlContent: '<p>No variables here</p>' };

      const handler = findHandler('/lists/:listId/group-email/prepare', 'post');
      await handler!(mockReq, mockRes);

      const result = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(result.eligibleCount).toBe(1);
      expect(result.readyCount).toBe(1);
      expect(result.notReadyCount).toBe(0);
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

    describe('ENG-2367 — RFC 8058 List-Unsubscribe headers', () => {
      // clearMocks keeps implementations; don't leak the mailbox sender into later tests.
      afterEach(() => {
        (settingsService.getSetting as jest.Mock).mockReset();
        mockGetEmailProvider.mockReset();
      });
      const leadsSetup = () => {
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
        (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
          items: [{ leadId: 'lead-9', email: 'a@test.com', firstName: 'A' }],
          lastEvaluatedKey: undefined,
        });
        mockReq.body = { senderEmail: 'me@test.com', senderName: 'Me', subject: 'Hi', htmlContent: '<p>Hi</p>' };
      };

      it('Resend group send carries List-Unsubscribe + One-Click headers signed like the body link', async () => {
        leadsSetup();
        (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'msg-1' });
        await findHandler('/lists/:listId/group-email/send', 'post')!(mockReq, mockRes);

        const call = (resendService.sendEmail as jest.Mock).mock.calls[0][0];
        expect(call.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
        const m = /^<(https:\/\/[^>]+)>$/.exec(call.headers['List-Unsubscribe']);
        expect(m).not.toBeNull();
        const headerUrl = new URL(m![1]);
        expect(headerUrl.pathname).toBe('/api/crm/public/lists/list-1/leads/lead-9/group-email-unsubscribe');
        const bodySig = /[?&]sig=([0-9a-f]+)/.exec(call.html)![1];
        expect(headerUrl.searchParams.get('sig')).toBe(bodySig);
        expect(headerUrl.searchParams.get('email')).toBe('a@test.com');
      });

      it('mailbox (Outlook/Gmail) group send passes the same headers to the provider', async () => {
        leadsSetup();
        (settingsService.getSetting as jest.Mock).mockResolvedValue({
          settingValue: JSON.stringify({
            senders: [{ id: 'g-1', email: 'me@test.com', senderType: 'gmail', connectedAccountId: 'acct-1' }],
          }),
        });
        const sendEmail = jest.fn().mockResolvedValue({ messageId: 'g-1', threadId: '' });
        mockGetEmailProvider.mockReturnValue({ sendEmail });
        mockReq.body.senderId = 'g-1';
        await findHandler('/lists/:listId/group-email/send', 'post')!(mockReq, mockRes);

        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(sendEmail.mock.calls[0][2].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      });
    });

    it('ENG-1194: skips malformed and provider-disallowed test-domain leads by default, never attempting them', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: '1', email: 'valid@agentweb.pro' },
          { leadId: '2', email: 'queue-verify@example.com' },
          { leadId: '3', email: 'noTld@updates' },
          { leadId: '4', email: 'harsha..v@agentweb.pro' },
        ],
        lastEvaluatedKey: undefined,
      });
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'msg-1' });

      mockReq.body = {
        senderEmail: 'me@test.com',
        senderName: 'Me',
        subject: 'Hi',
        htmlContent: '<p>Hello</p>',
      };

      const handler = findHandler('/lists/:listId/group-email/send', 'post');
      await handler!(mockReq, mockRes);

      expect(resendService.sendEmail).toHaveBeenCalledTimes(1);
      const call = (resendService.sendEmail as jest.Mock).mock.calls[0][0];
      expect(call.to).toBe('valid@agentweb.pro');

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(response.sent).toBe(1);
      expect(response.total).toBe(1);
      expect(response.skippedInvalid).toBe(3);
    });

    // ENG-1194 code review: a provider-flagged-undeliverable lead (heuristic
    // status, no syntax/test-domain issue) must still be skipped by default —
    // this is the overridable case, distinct from the non-overridable one below.
    it('should skip a provider-flagged-undeliverable address by default', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: '1', email: 'valid@acmecorp.com' },
          { leadId: '2', email: 'flagged@acmecorp.com', customFields: { email_validation: { status: 'undeliverable' } } },
        ],
        lastEvaluatedKey: undefined,
      });
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'msg-1' });

      mockReq.body = {
        senderEmail: 'me@test.com',
        senderName: 'Me',
        subject: 'Hi',
        htmlContent: '<p>Hello</p>',
      };

      const handler = findHandler('/lists/:listId/group-email/send', 'post');
      await handler!(mockReq, mockRes);

      expect(resendService.sendEmail).toHaveBeenCalledTimes(1);
      const call = (resendService.sendEmail as jest.Mock).mock.calls[0][0];
      expect(call.to).toBe('valid@acmecorp.com');

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(response.sent).toBe(1);
      expect(response.skippedUndeliverable).toBe(1);
    });

    // ENG-1194 code review: malformed-syntax/test-domain rows must never be
    // overridable via includeUndeliverable or includeUndeliverableEmails — a
    // provider rejects them regardless of caller intent, which is exactly the
    // bug this ticket reports.
    it('should still skip a malformed/test-domain address even with includeUndeliverable=true (blanket override)', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: '1', email: 'valid@acmecorp.com' },
          { leadId: '2', email: 'user@example.com' },
        ],
        lastEvaluatedKey: undefined,
      });
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'msg-1' });

      mockReq.body = {
        senderEmail: 'me@test.com',
        senderName: 'Me',
        subject: 'Hi',
        htmlContent: '<p>Hello</p>',
        includeUndeliverable: true,
      };

      const handler = findHandler('/lists/:listId/group-email/send', 'post');
      await handler!(mockReq, mockRes);

      expect(resendService.sendEmail).toHaveBeenCalledTimes(1);
      const call = (resendService.sendEmail as jest.Mock).mock.calls[0][0];
      expect(call.to).toBe('valid@acmecorp.com');

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(response.sent).toBe(1);
      expect(response.skippedInvalid).toBe(1);
    });

    it('should still skip a malformed/test-domain address even when whitelisted via includeUndeliverableEmails', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: '1', email: 'valid@acmecorp.com' },
          { leadId: '2', email: 'user@example.com' },
        ],
        lastEvaluatedKey: undefined,
      });
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'msg-1' });

      mockReq.body = {
        senderEmail: 'me@test.com',
        senderName: 'Me',
        subject: 'Hi',
        htmlContent: '<p>Hello</p>',
        includeUndeliverableEmails: ['user@example.com'],
      };

      const handler = findHandler('/lists/:listId/group-email/send', 'post');
      await handler!(mockReq, mockRes);

      expect(resendService.sendEmail).toHaveBeenCalledTimes(1);
      const call = (resendService.sendEmail as jest.Mock).mock.calls[0][0];
      expect(call.to).toBe('valid@acmecorp.com');

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(response.sent).toBe(1);
      expect(response.skippedInvalid).toBe(1);
    });

    // Confirms the overridable path still works: a provider-flagged-undeliverable
    // (heuristic-only, no syntax/test-domain issue) address CAN be whitelisted.
    it('should send a provider-flagged-undeliverable address when whitelisted via includeUndeliverableEmails', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: '1', email: 'flagged@acmecorp.com', customFields: { email_validation: { status: 'undeliverable' } } },
        ],
        lastEvaluatedKey: undefined,
      });
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'msg-1' });

      mockReq.body = {
        senderEmail: 'me@test.com',
        senderName: 'Me',
        subject: 'Hi',
        htmlContent: '<p>Hello</p>',
        includeUndeliverableEmails: ['flagged@acmecorp.com'],
      };

      const handler = findHandler('/lists/:listId/group-email/send', 'post');
      await handler!(mockReq, mockRes);

      expect(resendService.sendEmail).toHaveBeenCalledTimes(1);
      const call = (resendService.sendEmail as jest.Mock).mock.calls[0][0];
      expect(call.to).toBe('flagged@acmecorp.com');

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(response.sent).toBe(1);
      expect(response.skippedUndeliverable).toBe(0);
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

    describe('ENG-266 Part 3 — routes through the sender\'s real provider', () => {
      const mailboxSenderConfig = () =>
        (settingsService.getSetting as jest.Mock).mockResolvedValue({
          settingValue: JSON.stringify({
            senders: [{ id: 'ol-1', email: 'hunter@baldwin.com', fromName: 'Hunter', senderType: 'outlook', connectedAccountId: 'acct-1' }],
          }),
        });

      const manyLeads = (count: number) =>
        Array.from({ length: count }, (_, i) => ({ leadId: `${i}`, email: `lead${i}@test.com` }));

      it('ENG-2929: a mailbox send over 50 leads is accepted (202) and runs in the background, sending all 300', async () => {
        mailboxSenderConfig();
        // Bypass the real 300ms mailbox throttle; this test is about orchestration, not pacing.
        const providerSend = jest.spyOn(sendAsSenderModule, 'sendAsSender').mockResolvedValue(undefined as any);
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
        (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({ items: manyLeads(300), lastEvaluatedKey: undefined });

        // In-memory CAS store standing in for the pending-batch record.
        let record: any = null;
        let tick = 0;
        (getPendingBatch as jest.Mock).mockImplementation(async () => (record ? { ...record } : null));
        (upsertPendingBatch as jest.Mock).mockImplementation(async (_u: string, b: any, expected: string | null) => {
          if ((record?.updatedAt ?? null) !== expected) throw new PendingBatchConflictError('list-1');
          record = { ...b, updatedAt: `t${++tick}` };
        });
        (deletePendingBatch as jest.Mock).mockImplementation(async () => { record = null; });

        mockReq.body = { senderId: 'ol-1', senderEmail: 'hunter@baldwin.com', senderName: 'Hunter', subject: 'Hi', htmlContent: '<p>Hello</p>' };
        const handler = findHandler('/lists/:listId/group-email/send', 'post');
        await handler!(mockReq, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(202);
        const body = (mockRes.json as jest.Mock).mock.calls[0][0];
        expect(body).toEqual(expect.objectContaining({ background: true, total: 300, sent: 0 }));
        expect(record?.backgroundRunId).toBeTruthy();

        // Let the fire-and-forget loop drain.
        for (let i = 0; i < 50 && record !== null; i++) await new Promise((r) => setImmediate(r));
        await new Promise((r) => setTimeout(r, 50));
        expect(providerSend).toHaveBeenCalledTimes(300);
        const recipients = providerSend.mock.calls.map((c: any[]) => c[2].to);
        expect(new Set(recipients).size).toBe(300);
        expect(record).toBeNull();
        expect(resendService.sendEmail).not.toHaveBeenCalled();
        providerSend.mockRestore();
        (getPendingBatch as jest.Mock).mockResolvedValue(null);
        (upsertPendingBatch as jest.Mock).mockResolvedValue(undefined);
        (deletePendingBatch as jest.Mock).mockResolvedValue(undefined);
      });

      it('ENG-2929: refuses a second send while a live background run owns the list', async () => {
        mailboxSenderConfig();
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
        (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({ items: manyLeads(60), lastEvaluatedKey: undefined });
        (getPendingBatch as jest.Mock).mockResolvedValue({
          listId: 'list-1', skippedLeadIds: ['1'], sentSoFar: 5, totalOriginal: 60,
          backgroundRunId: 'other-run', backgroundHeartbeatAt: new Date().toISOString(), updatedAt: 'x',
        });

        mockReq.body = { senderId: 'ol-1', senderEmail: 'hunter@baldwin.com', senderName: 'Hunter', subject: 'Hi', htmlContent: '<p>Hello</p>' };
        const handler = findHandler('/lists/:listId/group-email/send', 'post');
        await handler!(mockReq, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(409);
        expect(mockGetEmailProvider).not.toHaveBeenCalled();
        (getPendingBatch as jest.Mock).mockResolvedValue(null);
      });

      it('ENG-2929: background run marks each lead attempted before sending and stops (no resend) when superseded', async () => {
        const providerSend = jest.spyOn(sendAsSenderModule, 'sendAsSender').mockResolvedValue(undefined as any);
        let record: any = { listId: 'list-1', skippedLeadIds: ['0', '1', '2'], sentSoFar: 0, totalOriginal: 3, backgroundRunId: 'run-a', backgroundHeartbeatAt: new Date().toISOString(), updatedAt: 't0', createdAt: 'c' };
        let tick = 0;
        const writes: string[][] = [];
        (getPendingBatch as jest.Mock).mockImplementation(async () => (record ? { ...record } : null));
        (upsertPendingBatch as jest.Mock).mockImplementation(async (_u: string, b: any, expected: string | null) => {
          if ((record?.updatedAt ?? null) !== expected) throw new PendingBatchConflictError('list-1');
          writes.push(b.skippedLeadIds);
          record = { ...b, updatedAt: `t${++tick}` };
        });
        providerSend.mockImplementationOnce(async () => {
          // Another run takes over after the first send.
          record = { ...record, backgroundRunId: 'run-b' };
          return undefined as any;
        });
        const sender = { id: 'ol-1', email: 'hunter@baldwin.com', fromName: 'Hunter', senderProvider: 'outlook' } as any;
        const result = await runMailboxGroupEmailBackground({
          userId: 'test-user-id', listId: 'list-1', sender, subject: 'Hi', htmlContent: '<p/>',
          leads: manyLeads(3), buildMessage: (l: any) => ({ to: l.email, subject: 'Hi', html: '<p/>', headers: {} }),
        }, 'run-a');
        expect(writes[0]).toEqual(['1', '2']);
        expect(providerSend).toHaveBeenCalledTimes(1);
        expect(result.aborted).toBe(true);
        providerSend.mockRestore();
        (getPendingBatch as jest.Mock).mockResolvedValue(null);
        (upsertPendingBatch as jest.Mock).mockResolvedValue(undefined);
        (deletePendingBatch as jest.Mock).mockResolvedValue(undefined);
      });

      const casStore = (initial: any) => {
        const st: any = { record: initial, tick: 0 };
        (getPendingBatch as jest.Mock).mockImplementation(async () => (st.record ? { ...st.record } : null));
        (upsertPendingBatch as jest.Mock).mockImplementation(async (_u: string, b: any, expected: string | null) => {
          if ((st.record?.updatedAt ?? null) !== expected) throw new PendingBatchConflictError('list-1');
          st.record = { ...b, updatedAt: `t${++st.tick}` };
        });
        (deletePendingBatch as jest.Mock).mockImplementation(async () => { st.record = null; });
        return st;
      };
      const resetStore = () => {
        (getPendingBatch as jest.Mock).mockResolvedValue(null);
        (upsertPendingBatch as jest.Mock).mockResolvedValue(undefined);
        (deletePendingBatch as jest.Mock).mockResolvedValue(undefined);
      };

      it('ENG-2929: failed background sends stay owed in the pending record (not dropped)', async () => {
        const providerSend = jest.spyOn(sendAsSenderModule, 'sendAsSender').mockRejectedValue(new Error('gmail 500'));
        const st = casStore({ listId: 'list-1', skippedLeadIds: ['0', '1', '2'], sentSoFar: 0, totalOriginal: 3, backgroundRunId: 'run-a', backgroundHeartbeatAt: new Date().toISOString(), updatedAt: 't0', createdAt: 'c' });
        const sender = { id: 'ol-1', email: 'hunter@baldwin.com', fromName: 'Hunter', senderProvider: 'outlook' } as any;
        const result = await runMailboxGroupEmailBackground({
          userId: 'test-user-id', listId: 'list-1', sender, subject: 'Hi', htmlContent: '<p/>',
          leads: manyLeads(3), buildMessage: (l: any) => ({ to: l.email, subject: 'Hi', html: '<p/>', headers: {} }),
        }, 'run-a');
        expect(result.failed).toBe(3);
        expect(st.record).not.toBeNull();
        expect(st.record.skippedLeadIds).toEqual(['0', '1', '2']);
        expect(st.record.backgroundRunId).toBeUndefined();
        providerSend.mockRestore();
        resetStore();
      });

      it('ENG-2929: a new send to a half-sent list only emails leads still owed', async () => {
        mailboxSenderConfig();
        const providerSend = jest.spyOn(sendAsSenderModule, 'sendAsSender').mockResolvedValue(undefined as any);
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
        (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({ items: manyLeads(60), lastEvaluatedKey: undefined });
        const owed = Array.from({ length: 40 }, (_, i) => `${i + 20}`);
        const st = casStore({ listId: 'list-1', skippedLeadIds: owed, sentSoFar: 20, totalOriginal: 60, updatedAt: 't0', createdAt: 'c' });
        mockReq.body = { senderId: 'ol-1', senderEmail: 'hunter@baldwin.com', senderName: 'Hunter', subject: 'Hi', htmlContent: '<p>Hello</p>' };
        const handler = findHandler('/lists/:listId/group-email/send', 'post');
        await handler!(mockReq, mockRes);
        expect(mockRes.status).toHaveBeenCalledWith(202);
        expect((mockRes.json as jest.Mock).mock.calls[0][0].total).toBe(40);
        for (let i = 0; i < 50 && st.record !== null; i++) await new Promise((r) => setImmediate(r));
        await new Promise((r) => setTimeout(r, 50));
        const recipients = providerSend.mock.calls.map((c: any[]) => c[2].to);
        expect(recipients).toHaveLength(40);
        expect(recipients).not.toContain('lead0@test.com');
        expect(recipients).not.toContain('lead19@test.com');
        providerSend.mockRestore();
        resetStore();
      });

      it('ENG-2929: dismissing the pending record is refused while a background run is live', async () => {
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
        (getPendingBatch as jest.Mock).mockResolvedValue({ listId: 'list-1', skippedLeadIds: ['1'], backgroundRunId: 'r', backgroundHeartbeatAt: new Date().toISOString(), updatedAt: 'x' });
        const handler = findHandler('/lists/:listId/group-email/pending', 'delete');
        await handler!(mockReq, mockRes);
        expect(mockRes.status).toHaveBeenCalledWith(409);
        expect(deletePendingBatch).not.toHaveBeenCalled();
        resetStore();
      });

      it('FAIL: a thrown send counts as failed instead of crashing the request', async () => {
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
        (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
          items: [{ leadId: '1', email: 'a@test.com' }, { leadId: '2', email: 'b@test.com' }],
          lastEvaluatedKey: undefined,
        });
        (resendService.sendEmail as jest.Mock)
          .mockResolvedValueOnce({ id: 'msg-1' })
          .mockRejectedValueOnce(new Error('resend down'));

        mockReq.body = {
          senderEmail: 'me@test.com',
          senderName: 'Me',
          subject: 'Hi',
          htmlContent: '<p>Hello</p>',
        };

        const handler = findHandler('/lists/:listId/group-email/send', 'post');
        await handler!(mockReq, mockRes);

        const response = (mockRes.json as jest.Mock).mock.calls[0][0];
        expect(response.sent).toBe(1);
        expect(response.failed).toBe(1);
      });

      it('FAIL: surfaces the actual failure reason per address, not just a bare count', async () => {
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
        (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
          items: [{ leadId: '1', email: 'a@test.com' }],
          lastEvaluatedKey: undefined,
        });
        (resendService.sendEmail as jest.Mock).mockRejectedValueOnce(
          new Error('Gmail access was revoked. Please reconnect your Gmail account in Settings → Connected Accounts.'),
        );

        mockReq.body = {
          senderEmail: 'me@test.com',
          senderName: 'Me',
          subject: 'Hi',
          htmlContent: '<p>Hello</p>',
        };

        const handler = findHandler('/lists/:listId/group-email/send', 'post');
        await handler!(mockReq, mockRes);

        const response = (mockRes.json as jest.Mock).mock.calls[0][0];
        expect(response.failureReasons).toEqual([
          { email: 'a@test.com', reason: expect.stringContaining('Gmail access was revoked') },
        ]);
      });

      it('SUCCESS: a mailbox sender under the cap sends via its real provider, not Resend', async () => {
        mailboxSenderConfig();
        mockGetEmailProvider.mockReturnValue({
          sendEmail: jest.fn().mockResolvedValue({ messageId: 'ol-msg-1', threadId: '' }),
        });
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
        (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
          items: [{ leadId: '1', email: 'a@test.com', firstName: 'A' }],
          lastEvaluatedKey: undefined,
        });

        mockReq.body = {
          senderId: 'ol-1',
          senderEmail: 'hunter@baldwin.com',
          senderName: 'Hunter',
          subject: 'Hi {{firstName}}',
          htmlContent: '<p>Hello</p>',
        };

        const handler = findHandler('/lists/:listId/group-email/send', 'post');
        await handler!(mockReq, mockRes);

        expect(resendService.sendEmail).not.toHaveBeenCalled();
        expect(mockGetEmailProvider).toHaveBeenCalledWith('outlook');
        const response = (mockRes.json as jest.Mock).mock.calls[0][0];
        expect(response.sent).toBe(1);
        expect(response.failed).toBe(0);
      });
    });

    describe('ENG-265 — stops cleanly when the sender hits its daily limit', () => {
      const cappedSenderConfig = () =>
        (settingsService.getSetting as jest.Mock).mockResolvedValue({
          settingValue: JSON.stringify({
            senders: [{ id: 'r-1', email: 'me@test.com', fromName: 'Me', dailyLimit: 2 }],
          }),
        });

      it('stops the batch at the limit instead of attempting (and failing) every remaining lead', async () => {
        cappedSenderConfig();
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
        (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
          items: [
            { leadId: '1', email: 'a@test.com' },
            { leadId: '2', email: 'b@test.com' },
            { leadId: '3', email: 'c@test.com' },
            { leadId: '4', email: 'd@test.com' },
            { leadId: '5', email: 'e@test.com' },
          ],
          lastEvaluatedKey: undefined,
        });
        (resendService.sendEmail as jest.Mock)
          .mockResolvedValueOnce({ id: 'msg-1' })
          .mockResolvedValueOnce({ id: 'msg-2' });
        (senderUsageTracker.reserveSend as jest.Mock)
          .mockResolvedValueOnce(undefined) // lead a — ok
          .mockResolvedValueOnce(undefined) // lead b — ok
          .mockRejectedValueOnce(new SenderDailyLimitExceededError('r-1', 2)); // lead c — over the cap

        mockReq.body = {
          senderId: 'r-1',
          senderEmail: 'me@test.com',
          senderName: 'Me',
          subject: 'Hi',
          htmlContent: '<p>Hello</p>',
        };

        const handler = findHandler('/lists/:listId/group-email/send', 'post');
        await handler!(mockReq, mockRes);

        // Only the first 2 leads (under the cap) were attempted at all.
        expect(resendService.sendEmail).toHaveBeenCalledTimes(2);
        const response = (mockRes.json as jest.Mock).mock.calls[0][0];
        expect(response.sent).toBe(2);
        expect(response.failed).toBe(0); // hitting the cap is not counted as a per-lead failure
        expect(response.skippedDueToLimit).toBe(3); // c, d, e never attempted
        expect(response.stoppedEarlyReason).toMatch(/daily sending limit/);
        // A resend is never recorded back onto the lead — retrying the full list later
        // would re-email a and b. skippedLeadIds is what makes a safe, scoped resend
        // possible: the caller can re-POST with leadIds: skippedLeadIds.
        expect(response.skippedLeadIds).toEqual(['3', '4', '5']);
      });

      it('a subsequent send scoped to skippedLeadIds only attempts those leads, not the whole list again', async () => {
        cappedSenderConfig();
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
        (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
          items: [
            { leadId: '1', email: 'a@test.com' },
            { leadId: '2', email: 'b@test.com' },
            { leadId: '3', email: 'c@test.com' },
            { leadId: '4', email: 'd@test.com' },
            { leadId: '5', email: 'e@test.com' },
          ],
          lastEvaluatedKey: undefined,
        });
        (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'msg' });
        (senderUsageTracker.reserveSend as jest.Mock).mockResolvedValue(undefined);

        mockReq.body = {
          senderId: 'r-1',
          senderEmail: 'me@test.com',
          senderName: 'Me',
          subject: 'Hi',
          htmlContent: '<p>Hello</p>',
          leadIds: ['3', '4', '5'],
        };

        const handler = findHandler('/lists/:listId/group-email/send', 'post');
        await handler!(mockReq, mockRes);

        expect(resendService.sendEmail).toHaveBeenCalledTimes(3);
        const attemptedAddresses = (resendService.sendEmail as jest.Mock).mock.calls.map((c) => c[0].to);
        expect(attemptedAddresses.sort()).toEqual(['c@test.com', 'd@test.com', 'e@test.com']);
        const response = (mockRes.json as jest.Mock).mock.calls[0][0];
        expect(response.sent).toBe(3);
        expect(response.total).toBe(3);
      });
    });

    describe('ENG-265 — durable pending-batch record (survives closing the tab)', () => {
      const cappedSenderConfig = () =>
        (settingsService.getSetting as jest.Mock).mockResolvedValue({
          settingValue: JSON.stringify({
            senders: [{ id: 'r-1', email: 'me@test.com', fromName: 'Me', dailyLimit: 2 }],
          }),
        });

      it('persists skippedLeadIds when a fresh send stops early, with totalOriginal/sentSoFar seeded from this call', async () => {
        cappedSenderConfig();
        (getPendingBatch as jest.Mock).mockResolvedValue(null); // no prior batch
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
        (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
          items: [
            { leadId: '1', email: 'a@test.com' },
            { leadId: '2', email: 'b@test.com' },
            { leadId: '3', email: 'c@test.com' },
          ],
          lastEvaluatedKey: undefined,
        });
        (resendService.sendEmail as jest.Mock)
          .mockResolvedValueOnce({ id: 'msg-1' })
          .mockResolvedValueOnce({ id: 'msg-2' });
        (senderUsageTracker.reserveSend as jest.Mock)
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new SenderDailyLimitExceededError('r-1', 2));

        mockReq.body = { senderId: 'r-1', senderEmail: 'me@test.com', senderName: 'Me', subject: 'Hi', htmlContent: '<p>Hello</p>' };
        const handler = findHandler('/lists/:listId/group-email/send', 'post');
        await handler!(mockReq, mockRes);

        expect(upsertPendingBatch).toHaveBeenCalledWith('test-user-id', expect.objectContaining({
          listId: 'list-1',
          skippedLeadIds: ['3'],
          sentSoFar: 2,
          totalOriginal: 3,
        }), null);
        expect(deletePendingBatch).not.toHaveBeenCalled();
      });

      it('accumulates sentSoFar and preserves totalOriginal when a resume also stops early', async () => {
        cappedSenderConfig();
        (getPendingBatch as jest.Mock).mockResolvedValue({
          listId: 'list-1', senderId: 'r-1', senderEmail: 'me@test.com', senderName: 'Me',
          subject: 'Hi', htmlContent: '<p>Hello</p>', skippedLeadIds: ['3', '4', '5'],
          sentSoFar: 2, totalOriginal: 5, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        });
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
        (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
          items: [
            { leadId: '3', email: 'c@test.com' },
            { leadId: '4', email: 'd@test.com' },
            { leadId: '5', email: 'e@test.com' },
          ],
          lastEvaluatedKey: undefined,
        });
        (resendService.sendEmail as jest.Mock).mockResolvedValueOnce({ id: 'msg-3' });
        (senderUsageTracker.reserveSend as jest.Mock)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new SenderDailyLimitExceededError('r-1', 2));

        mockReq.body = {
          senderId: 'r-1', senderEmail: 'me@test.com', senderName: 'Me', subject: 'Hi', htmlContent: '<p>Hello</p>',
          leadIds: ['3', '4', '5'],
        };
        const handler = findHandler('/lists/:listId/group-email/send', 'post');
        await handler!(mockReq, mockRes);

        // 1 more sent this call (2 previously + 1 now = 3), original total of 5 preserved,
        // and the remaining set shrinks to just what's still outstanding.
        expect(upsertPendingBatch).toHaveBeenCalledWith('test-user-id', expect.objectContaining({
          skippedLeadIds: ['4', '5'],
          sentSoFar: 3,
          totalOriginal: 5,
        }), '2026-01-01T00:00:00.000Z');
      });

      it('reloads and retries on a concurrent-write conflict instead of losing this send\'s progress', async () => {
        cappedSenderConfig();
        const staleBatch = {
          listId: 'list-1', senderId: 'r-1', senderEmail: 'me@test.com', senderName: 'Me',
          subject: 'Hi', htmlContent: '<p>Hello</p>', skippedLeadIds: ['3', '4', '5'],
          sentSoFar: 2, totalOriginal: 5, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        };
        const freshBatch = { ...staleBatch, sentSoFar: 3, updatedAt: '2026-01-01T00:05:00.000Z' }; // written by a concurrent request
        (getPendingBatch as jest.Mock)
          .mockResolvedValueOnce(staleBatch) // ENG-2929 live-background-run check (not a live run)
          .mockResolvedValueOnce(staleBatch) // this request's initial read
          .mockResolvedValueOnce(freshBatch); // reload after the conflict
        (upsertPendingBatch as jest.Mock)
          .mockRejectedValueOnce(new PendingBatchConflictError('list-1'))
          .mockResolvedValueOnce(undefined);
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
        (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
          items: [
            { leadId: '3', email: 'c@test.com' },
            { leadId: '4', email: 'd@test.com' },
          ],
          lastEvaluatedKey: undefined,
        });
        (resendService.sendEmail as jest.Mock).mockResolvedValueOnce({ id: 'msg-3' });
        (senderUsageTracker.reserveSend as jest.Mock)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new SenderDailyLimitExceededError('r-1', 2));

        mockReq.body = {
          senderId: 'r-1', senderEmail: 'me@test.com', senderName: 'Me', subject: 'Hi', htmlContent: '<p>Hello</p>',
          leadIds: ['3', '4'],
        };
        const handler = findHandler('/lists/:listId/group-email/send', 'post');
        await handler!(mockReq, mockRes);

        expect(upsertPendingBatch).toHaveBeenCalledTimes(2);
        // Second attempt folds this send's +1 onto the reloaded freshBatch.sentSoFar (3), not
        // the stale first-read value (2) — the retry must be based on the reloaded record.
        expect(upsertPendingBatch).toHaveBeenNthCalledWith(2, 'test-user-id', expect.objectContaining({
          sentSoFar: 4,
        }), '2026-01-01T00:05:00.000Z');
      });

      it('clears the pending-batch record once a resume finishes everyone', async () => {
        cappedSenderConfig();
        (getPendingBatch as jest.Mock).mockResolvedValue({
          listId: 'list-1', senderId: 'r-1', senderEmail: 'me@test.com', senderName: 'Me',
          subject: 'Hi', htmlContent: '<p>Hello</p>', skippedLeadIds: ['4', '5'],
          sentSoFar: 3, totalOriginal: 5, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        });
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
        (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
          items: [
            { leadId: '4', email: 'd@test.com' },
            { leadId: '5', email: 'e@test.com' },
          ],
          lastEvaluatedKey: undefined,
        });
        (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'msg' });
        (senderUsageTracker.reserveSend as jest.Mock).mockResolvedValue(undefined);

        mockReq.body = {
          senderId: 'r-1', senderEmail: 'me@test.com', senderName: 'Me', subject: 'Hi', htmlContent: '<p>Hello</p>',
          leadIds: ['4', '5'],
        };
        const handler = findHandler('/lists/:listId/group-email/send', 'post');
        await handler!(mockReq, mockRes);

        expect(deletePendingBatch).toHaveBeenCalledWith('test-user-id', 'list-1');
        expect(upsertPendingBatch).not.toHaveBeenCalled();
      });
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

    it('ENG-266 Part 3: routes a mailbox sender through its real provider, not Resend', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list-1',
        userId: 'test-user-id',
      });
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify({
          senders: [{ id: 'ol-1', email: 'hunter@baldwin.com', fromName: 'Hunter', senderType: 'outlook', connectedAccountId: 'acct-1' }],
        }),
      });
      mockGetEmailProvider.mockReturnValue({
        sendEmail: jest.fn().mockResolvedValue({ messageId: 'ol-msg-1', threadId: '' }),
      });

      mockReq.body = {
        senderId: 'ol-1',
        senderEmail: 'hunter@baldwin.com',
        senderName: 'Hunter',
        subject: 'Test',
        htmlContent: '<p>Hi</p>',
        recipients: ['test@recipient.com'],
      };

      const handler = findHandler('/lists/:listId/group-email/test', 'post');
      await handler!(mockReq, mockRes);

      expect(resendService.sendEmail).not.toHaveBeenCalled();
      expect(mockGetEmailProvider).toHaveBeenCalledWith('outlook');
      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(response.sent).toBe(1);
    });
  });

  describe('GET /lists/:listId/group-email/pending', () => {
    it('returns the durable pending batch for this list', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
      const batch = { listId: 'list-1', skippedLeadIds: ['4', '5'], sentSoFar: 3, totalOriginal: 5 };
      (getPendingBatch as jest.Mock).mockResolvedValue(batch);

      const handler = findHandler('/lists/:listId/group-email/pending', 'get');
      await handler!(mockReq, mockRes);

      expect(getPendingBatch).toHaveBeenCalledWith('test-user-id', 'list-1');
      expect(mockRes.json).toHaveBeenCalledWith({ batch });
    });

    it('returns { batch: null } when there is nothing pending', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });
      (getPendingBatch as jest.Mock).mockResolvedValue(null);

      const handler = findHandler('/lists/:listId/group-email/pending', 'get');
      await handler!(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith({ batch: null });
    });
  });

  describe('DELETE /lists/:listId/group-email/pending', () => {
    it('dismisses the pending batch', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test-user-id' });

      const handler = findHandler('/lists/:listId/group-email/pending', 'delete');
      await handler!(mockReq, mockRes);

      expect(deletePendingBatch).toHaveBeenCalledWith('test-user-id', 'list-1');
      expect(mockRes.json).toHaveBeenCalledWith({ message: 'Pending group email dismissed.' });
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
