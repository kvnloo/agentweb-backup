// ENG-265: GET /api/crm/sender-emails must surface each sender's effective
// daily cap and today's usage, without touching the tracker at all for
// senders that have no cap configured (the common case — must not add a
// DynamoDB read to every existing sender's settings load).

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

import { Request, Response } from 'express';
import { userDb } from '../services/db';
import { settingsService } from '../services/settingsService';
import { senderUsageTracker } from '../services/senderUsageTrackerFactory';
import router from '../routes/crm';

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListsByUserId: jest.fn(), createLeadList: jest.fn(), getLeadListById: jest.fn(),
    updateLeadList: jest.fn(), deleteLeadList: jest.fn(), getLeadsByListId: jest.fn(),
    getLeadsByICPFlag: jest.fn(), getLeadsByEngagedFlag: jest.fn(), getLeadsByStatus: jest.fn(),
    createLead: jest.fn(), getLeadById: jest.fn(), updateLead: jest.fn(), deleteLead: jest.fn(),
    batchCreateLeads: jest.fn(), getLeadEngagements: jest.fn(), addLeadEngagement: jest.fn(),
    updateLeadEngagement: jest.fn(), deleteLeadEngagement: jest.fn(), getLeadEngagementCount: jest.fn(),
  },
  taskDb: { getTaskById: jest.fn() },
  subscriberDb: { getAllTaskSubscribers: jest.fn() },
  userDb: { getUserById: jest.fn(), getUsersByEmailDomain: jest.fn(), updateUser: jest.fn() },
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: { getEventsByEmailDomain: jest.fn(), getEventsByEmailDomainAndLeadEmail: jest.fn() },
}));

jest.mock('../services/agentModeService', () => ({ agentModeService: { searchWeb: jest.fn() } }));
jest.mock('../utils/llmService', () => ({ createLLMService: jest.fn() }));

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(), setSetting: jest.fn() },
}));

jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn(), createDomain: jest.fn(), getDomain: jest.fn(), verifyDomain: jest.fn(), listDomains: jest.fn() },
}));

jest.mock('../utils/s3Utils', () => ({ uploadFileToS3: jest.fn() }));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: 'test-user-id', email: 'test@example.com' }; next(); },
  AuthenticatedRequest: {},
}));

jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: { processEmailReceivedEvent: jest.fn() } }));
jest.mock('../utils/emailVariables', () => ({ substituteVariables: jest.fn(), extractVariables: jest.fn(), leadHasVariable: jest.fn() }));
jest.mock('../config/aws', () => ({ dynamodb: { query: jest.fn().mockReturnValue({ promise: jest.fn() }) } }));
jest.mock('../utils/leadContactStatus', () => ({ isDoNotContact: jest.fn().mockReturnValue(false) }));

jest.mock('../services/senderUsageTrackerFactory', () => ({
  senderUsageTracker: { getUsage: jest.fn(), reserveSend: jest.fn(), releaseSend: jest.fn() },
}));

function getHandler(path: string, method: string) {
  const layer = router.stack.find((r: any) => r.route?.path === path && r.route?.methods?.[method]);
  if (!layer || !layer.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack[0].handle;
}

describe('GET /api/crm/sender-emails — usage surfacing (ENG-265)', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequest = { user: { userId: 'test-user-id', email: 'test@example.com' }, params: {}, query: {}, body: {} };
    mockResponse = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    mockNext = jest.fn();
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'test-user-id', connected_accounts: [] });
  });

  it('does not call the usage tracker for a sender with no dailyLimit/warmupStartedAt', async () => {
    (settingsService.getSetting as jest.Mock).mockResolvedValue({
      settingValue: JSON.stringify({ senders: [{ id: '1', email: 'a@b.com', fromName: 'A' }], defaultSenderId: '1' }),
    });

    const handle = getHandler('/sender-emails', 'get');
    await handle(mockRequest as Request, mockResponse as Response, mockNext);

    expect(senderUsageTracker.getUsage).not.toHaveBeenCalled();
    const jsonCall = (mockResponse.json as jest.Mock).mock.calls[0][0];
    expect(jsonCall.senders[0].effectiveDailyLimit).toBeNull();
    expect(jsonCall.senders[0].sentToday).toBe(0);
  });

  it('surfaces effectiveDailyLimit and sentToday for a capped sender', async () => {
    (settingsService.getSetting as jest.Mock).mockResolvedValue({
      settingValue: JSON.stringify({ senders: [{ id: '1', email: 'a@b.com', fromName: 'A', dailyLimit: 50 }], defaultSenderId: '1' }),
    });
    (senderUsageTracker.getUsage as jest.Mock).mockResolvedValue({ date: '2026-08-25', sentCount: 12 });

    const handle = getHandler('/sender-emails', 'get');
    await handle(mockRequest as Request, mockResponse as Response, mockNext);

    expect(senderUsageTracker.getUsage).toHaveBeenCalledWith('test-user-id', '1');
    const jsonCall = (mockResponse.json as jest.Mock).mock.calls[0][0];
    expect(jsonCall.senders[0].effectiveDailyLimit).toBe(50);
    expect(jsonCall.senders[0].sentToday).toBe(12);
  });

  it('computes the warmup-ramped limit (not the raw dailyLimit) for a warming-up sender', async () => {
    (settingsService.getSetting as jest.Mock).mockResolvedValue({
      settingValue: JSON.stringify({
        senders: [{ id: '1', email: 'a@b.com', fromName: 'A', dailyLimit: 200, warmupStartedAt: new Date().toISOString() }],
        defaultSenderId: '1',
      }),
    });
    (senderUsageTracker.getUsage as jest.Mock).mockResolvedValue({ date: '2026-08-25', sentCount: 3 });

    const handle = getHandler('/sender-emails', 'get');
    await handle(mockRequest as Request, mockResponse as Response, mockNext);

    const jsonCall = (mockResponse.json as jest.Mock).mock.calls[0][0];
    // Day 1 of warmup caps at 10, not the sender's eventual dailyLimit of 200.
    expect(jsonCall.senders[0].effectiveDailyLimit).toBe(10);
  });

  it('one sender\'s usage lookup failing does not blank the whole sender list (CodeRabbit)', async () => {
    (settingsService.getSetting as jest.Mock).mockResolvedValue({
      settingValue: JSON.stringify({
        senders: [
          { id: '1', email: 'a@b.com', fromName: 'A', dailyLimit: 50 },
          { id: '2', email: 'c@d.com', fromName: 'C', dailyLimit: 50 },
        ],
        defaultSenderId: '1',
      }),
    });
    (senderUsageTracker.getUsage as jest.Mock)
      .mockRejectedValueOnce(new Error('DynamoDB timed out'))
      .mockResolvedValueOnce({ date: '2026-08-25', sentCount: 7 });

    const handle = getHandler('/sender-emails', 'get');
    await handle(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockResponse.status).not.toHaveBeenCalledWith(500);
    const jsonCall = (mockResponse.json as jest.Mock).mock.calls[0][0];
    expect(jsonCall.senders).toHaveLength(2);
    expect(jsonCall.senders[0].sentToday).toBe(0); // fell back on the failed lookup
    expect(jsonCall.senders[1].sentToday).toBe(7); // unaffected by sender 1's failure
  });
});
