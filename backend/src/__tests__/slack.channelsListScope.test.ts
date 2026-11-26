/**
 * ENG-2840 (W2-8): GET /api/slack/channels. The bot is in every client's channel, so only a real (non-delegated) admin gets the
 * whole list; anyone else gets only the channels getEffectiveAllowedChannels gives them (own, else the org's, none on WhatsApp).
 * Before, a non-admin with no personal channel got every channel (other clients' channel names).
 *
 * isRealAdmin (middleware/auth) and getEffectiveAllowedChannels (slackService) are the REAL functions here; only the token check,
 * the Slack API list and the database are stubbed.
 */
import express from 'express';
import request from 'supertest';

let mockReqUser: any;
let mockDelegateInfo: any;

jest.mock('../middleware/auth', () => ({
  ...jest.requireActual('../middleware/auth'),
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = mockReqUser;
    if (mockDelegateInfo) req.delegateInfo = mockDelegateInfo;
    next();
  }),
}));
jest.mock('../services/slackService', () => ({
  ...jest.requireActual('../services/slackService'),
  getSlackChannels: jest.fn(),
}));
jest.mock('../services/approvalDb');
jest.mock('../services/db', () => ({
  taskDb: {},
  subscriberDb: {},
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/chatbotService', () => ({ chatbotDb: {} }));
jest.mock('../controllers/agentModeController', () => ({ runVerifiedChat: jest.fn() }));
jest.mock('../controllers/tasks', () => ({ createRevisionExecutionFromSlack: jest.fn() }));

import { userDb, orgDb } from '../services/db';
import { getSlackChannels } from '../services/slackService';

const slackRouter = require('../routes/slack').default;
const app = express();
app.use(express.json());
app.use('/api/slack', slackRouter);

const mockGetChannels = getSlackChannels as jest.Mock;
const mockGetUser = userDb.getUserById as jest.Mock;
const mockGetOrg = orgDb.getOrgById as jest.Mock;

const ALL = [
  { id: 'C_OWN', name: 'own', displayName: '#own', isPrivate: false },
  { id: 'C_ORG', name: 'org', displayName: '#org', isPrivate: false },
  { id: 'C_CLIENT_A', name: 'client-a', displayName: '#client-a', isPrivate: false },
  { id: 'C_CLIENT_B', name: 'client-b', displayName: '#client-b', isPrivate: true },
];
const ids = (body: any[]) => body.map((c) => c.id).sort();

const WHATSAPP = [
  {
    channel: 'whatsapp',
    destination: '+14155550123',
    enabled: true,
    optIn: { at: '2026-10-01T00:00:00Z', source: 'inbound_verification', verifiedAt: '2026-10-01T00:01:00Z' },
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockGetChannels.mockReset();
  mockGetUser.mockReset();
  mockGetOrg.mockReset();
  mockReqUser = { userId: 'u1', isAdmin: false };
  mockDelegateInfo = undefined;
  mockGetChannels.mockResolvedValue(ALL);
});

describe('GET /api/slack/channels scope', () => {
  it('a real (non-delegated) admin gets every channel', async () => {
    mockReqUser = { userId: 'admin-1', isAdmin: true };

    const res = await request(app).get('/api/slack/channels').expect(200);

    expect(ids(res.body)).toEqual(ids(ALL));
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('a non-admin with NO personal channels and no org gets [] (before: the whole list)', async () => {
    mockGetUser.mockResolvedValueOnce({ userId: 'u1' });

    const res = await request(app).get('/api/slack/channels').expect(200);

    expect(res.body).toEqual([]);
  });

  it('a non-admin with their own channel gets only that one', async () => {
    mockGetUser.mockResolvedValueOnce({ userId: 'u1', slackChannel: 'C_OWN' });

    const res = await request(app).get('/api/slack/channels').expect(200);

    expect(ids(res.body)).toEqual(['C_OWN']);
  });

  it('a non-admin with several own channels gets exactly those', async () => {
    mockGetUser.mockResolvedValueOnce({ userId: 'u1', slackChannels: ['C_OWN', 'C_CLIENT_B'] });

    const res = await request(app).get('/api/slack/channels').expect(200);

    expect(ids(res.body)).toEqual(['C_CLIENT_B', 'C_OWN']);
  });

  it("a member with no personal channel whose org has a channel gets the org's channel", async () => {
    mockGetUser.mockResolvedValueOnce({ userId: 'u1', orgId: 'org-1' });
    mockGetOrg.mockResolvedValueOnce({ orgId: 'org-1', ownerUserId: 'owner-1', slackChannel: 'C_ORG' });

    const res = await request(app).get('/api/slack/channels').expect(200);

    expect(ids(res.body)).toEqual(['C_ORG']);
    expect(mockGetOrg).toHaveBeenCalledWith('org-1');
  });

  it("a member whose org record has no channel inherits the org owner's channels", async () => {
    mockGetUser
      .mockResolvedValueOnce({ userId: 'u1', orgId: 'org-1' })
      .mockResolvedValueOnce({ userId: 'owner-1', slackChannels: ['C_ORG'] });
    mockGetOrg.mockResolvedValueOnce({ orgId: 'org-1', ownerUserId: 'owner-1' });

    const res = await request(app).get('/api/slack/channels').expect(200);

    expect(ids(res.body)).toEqual(['C_ORG']);
  });

  it('a WhatsApp customer gets no Slack channel, even with a stale one on the record', async () => {
    mockGetUser.mockResolvedValueOnce({ userId: 'u1', slackChannel: 'C_OWN', messagingChannels: WHATSAPP });

    const res = await request(app).get('/api/slack/channels').expect(200);

    expect(res.body).toEqual([]);
  });

  it('a delegated admin session (isRealAdmin false) is filtered like any user', async () => {
    // Delegated: req.user is the target customer; even if that account is an admin, delegation never grants admin power.
    mockReqUser = { userId: 'customer-1', isAdmin: true };
    mockDelegateInfo = { adminUserId: 'admin-1', adminEmail: 'a@x.com', isDelegated: true };
    mockGetUser.mockResolvedValueOnce({ userId: 'customer-1', slackChannel: 'C_OWN' });

    const res = await request(app).get('/api/slack/channels').expect(200);

    expect(ids(res.body)).toEqual(['C_OWN']);
    expect(mockGetUser).toHaveBeenCalledWith('customer-1');
  });

  it('a delegated session into a customer with no channel gets []', async () => {
    mockReqUser = { userId: 'customer-2', isAdmin: false };
    mockDelegateInfo = { adminUserId: 'admin-1', adminEmail: 'a@x.com', isDelegated: true };
    mockGetUser.mockResolvedValueOnce({ userId: 'customer-2' });

    const res = await request(app).get('/api/slack/channels').expect(200);

    expect(res.body).toEqual([]);
  });

  it('a user record that cannot be found gets []', async () => {
    mockGetUser.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/slack/channels').expect(200);

    expect(res.body).toEqual([]);
  });

  it("an allowed channel the bot is not in is simply absent (no other client's channel fills in)", async () => {
    mockGetUser.mockResolvedValueOnce({ userId: 'u1', slackChannel: 'C_NOT_IN_BOT_LIST' });

    const res = await request(app).get('/api/slack/channels').expect(200);

    expect(res.body).toEqual([]);
  });
});
