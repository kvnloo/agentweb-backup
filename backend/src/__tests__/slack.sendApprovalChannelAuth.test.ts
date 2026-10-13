// ENG-2413: POST /api/slack/send-approval must only post to caller-entitled channels.
import express from 'express';
import request from 'supertest';

let mockUser: any = { userId: 'u1', isAdmin: false };

jest.mock('../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = mockUser;
    next();
  }),
  isRealAdmin: jest.fn((req: any) => !!req.user?.isAdmin),
}));
jest.mock('../services/approvalDb');
jest.mock('../services/slackService');
jest.mock('../services/db', () => ({
  taskDb: {},
  subscriberDb: {},
  userDb: { getUserById: jest.fn() },
}));
jest.mock('../services/chatbotService', () => ({ chatbotDb: {} }));
jest.mock('../controllers/agentModeController', () => ({ runVerifiedChat: jest.fn() }));
jest.mock('../controllers/tasks', () => ({ createRevisionExecutionFromSlack: jest.fn() }));

import { userDb } from '../services/db';
import { approvalDb } from '../services/approvalDb';
import { sendApprovalRequestWithTracking, getEffectiveAllowedChannels } from '../services/slackService';

const slackRouter = require('../routes/slack').default;
const app = express();
app.use(express.json());
app.use('/api/slack', slackRouter);

const body = (channel: any) => ({ channel, assetUrl: 'https://cdn/a.png', filename: 'a.png', note: 'hi' });

describe('POST /api/slack/send-approval channel entitlement (ENG-2413)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { userId: 'u1', isAdmin: false };
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'u1' });
    (getEffectiveAllowedChannels as jest.Mock).mockResolvedValue(['C_OWN']);
    (sendApprovalRequestWithTracking as jest.Mock).mockResolvedValue({ messageTs: '1.2', approvalId: 'a1' });
  });

  const expectNoSideEffects = () => {
    expect(sendApprovalRequestWithTracking).not.toHaveBeenCalled();
    expect(approvalDb.createApproval).not.toHaveBeenCalled();
  };

  it('403s a non-entitled user targeting another channel, with no Slack call or DB write', async () => {
    await request(app).post('/api/slack/send-approval').send(body('C_OTHER')).expect(403);
    expectNoSideEffects();
  });

  it('400s a non-string channel', async () => {
    await request(app).post('/api/slack/send-approval').send(body(['C_OWN'])).expect(400);
    expectNoSideEffects();
  });

  it('allows an entitled channel', async () => {
    await request(app).post('/api/slack/send-approval').send(body('C_OWN')).expect(200);
    expect(sendApprovalRequestWithTracking).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C_OWN' }));
  });

  it('does not refuse a WhatsApp customer whose task still names an old Slack channel', async () => {
    // They are entitled to no Slack channel by design, and requestApproval ignores the
    // channel for them — a 403 here would stop them being asked and hold their output.
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'u1',
      messagingChannels: [
        {
          channel: 'whatsapp',
          destination: '+14155550123',
          enabled: true,
          optIn: { at: '2026-10-01T00:00:00Z', source: 'inbound_verification', verifiedAt: '2026-10-01T00:01:00Z' },
        },
      ],
    });
    (getEffectiveAllowedChannels as jest.Mock).mockResolvedValue([]);
    await request(app).post('/api/slack/send-approval').send(body('C_OLD_TASK_CHANNEL')).expect(200);
    // No channel is handed on: if requestApproval's own read of the account disagrees, it
    // must fail closed rather than post to the channel the caller named.
    expect(sendApprovalRequestWithTracking).toHaveBeenCalledWith(expect.objectContaining({ channel: '' }));
  });

  it('answers 403, not 500, when the approval belongs to another account', async () => {
    const err = Object.assign(new Error('That asset belongs to a different account.'), {
      name: 'ApprovalForbiddenError',
    });
    (sendApprovalRequestWithTracking as jest.Mock).mockRejectedValue(err);
    await request(app).post('/api/slack/send-approval').send(body('C_OWN')).expect(403);
  });

  it('allows a real admin to any channel without resolving the allowlist', async () => {
    mockUser = { userId: 'u1', isAdmin: true };
    await request(app).post('/api/slack/send-approval').send(body('C_OTHER')).expect(200);
    expect(getEffectiveAllowedChannels).not.toHaveBeenCalled();
  });
});
