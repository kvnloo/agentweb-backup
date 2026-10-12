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

  it('allows a real admin to any channel without resolving the allowlist', async () => {
    mockUser = { userId: 'u1', isAdmin: true };
    await request(app).post('/api/slack/send-approval').send(body('C_OTHER')).expect(200);
    expect(getEffectiveAllowedChannels).not.toHaveBeenCalled();
  });
});
