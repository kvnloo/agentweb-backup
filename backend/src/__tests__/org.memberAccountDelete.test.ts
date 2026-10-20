/**
 * ENG-2595: DELETE /org/connected-accounts/:platform/:accountId/member
 * Org owner/admin disconnects a member's connected account.
 */
import request from 'supertest';
import express from 'express';
import orgRoutes from '../routes/org';
import { userDb } from '../services/db';

let mockCurrentUser: any = null;
let mockUsers: Record<string, any> = {};
let mockOrgs: Record<string, any> = {};

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: mockCurrentUser.userId, email: mockCurrentUser.email, isAdmin: false };
    next();
  },
  AuthenticatedRequest: {},
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn((userId: string) => Promise.resolve(mockUsers[userId] || null)),
    updateUser: jest.fn((userId: string, updates: any) => {
      if (mockUsers[userId]) Object.assign(mockUsers[userId], updates);
      return Promise.resolve(mockUsers[userId]);
    }),
  },
  orgDb: {
    getOrgById: jest.fn((orgId: string) => Promise.resolve(mockOrgs[orgId] || null)),
    getOrgMembers: jest.fn((orgId: string) =>
      Promise.resolve(Object.values(mockUsers).filter((u: any) => u.orgId === orgId))
    ),
  },
}));

jest.mock('../services/emailService', () => ({
  emailService: { sendEmail: jest.fn().mockResolvedValue(undefined) },
}));

const ORG_ID = 'org-abc';
const account = (platform: string, account_id: string) => ({
  platform,
  account_id,
  account_name: `${platform} ${account_id}`,
  config: { account_type: 'personal', access_token: 'tok', scopes: [] },
  sharedWithOrg: false,
});

let app: express.Application;

beforeEach(() => {
  jest.clearAllMocks();
  mockOrgs = { [ORG_ID]: { orgId: ORG_ID, name: 'Test Org', ownerUserId: 'user-owner', connected_accounts: [] } };
  mockUsers = {
    'user-owner': {
      userId: 'user-owner', email: 'owner@example.com', orgId: ORG_ID, orgRole: 'owner',
      connected_accounts: [account('linkedin', 'li-owner')],
    },
    'user-member': {
      userId: 'user-member', email: 'member@example.com', orgId: ORG_ID, orgRole: 'member',
      connected_accounts: [account('twitter', 'tw-001'), account('google_ads', 'ga-001')],
    },
    'user-member2': {
      userId: 'user-member2', email: 'member2@example.com', orgId: ORG_ID, orgRole: 'member',
      connected_accounts: [account('meta', 'meta-002')],
    },
  };
  mockCurrentUser = mockUsers['user-owner'];
  app = express();
  app.use(express.json());
  app.use('/org', orgRoutes);
});

describe('DELETE /org/connected-accounts/:platform/:accountId/member', () => {
  it('lets the org owner remove exactly one member account and logs an audit line', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    const res = await request(app).delete('/org/connected-accounts/twitter/tw-001/member');

    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledTimes(1);
    expect(userDb.updateUser).toHaveBeenCalledWith('user-member', {
      connected_accounts: [expect.objectContaining({ platform: 'google_ads', account_id: 'ga-001' })],
    });
    expect(mockUsers['user-member'].connected_accounts).toHaveLength(1);
    expect(mockUsers['user-member2'].connected_accounts).toHaveLength(1);
    expect(info).toHaveBeenCalledWith(expect.stringContaining(
      '[org-account-delete] actor=user-owner member=user-member platform=twitter account=tw-001 org=org-abc'
    ));
    info.mockRestore();
  });

  it('returns 403 for a non-manager member and does not write', async () => {
    mockCurrentUser = mockUsers['user-member2'];
    const res = await request(app).delete('/org/connected-accounts/twitter/tw-001/member');

    expect(res.status).toBe(403);
    expect(userDb.updateUser).not.toHaveBeenCalled();
    expect(mockUsers['user-member'].connected_accounts).toHaveLength(2);
  });

  it('returns 404 when no member owns the account', async () => {
    const res = await request(app).delete('/org/connected-accounts/twitter/nope/member');

    expect(res.status).toBe(404);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it("returns 400 for the caller's own account, pointing at the normal DELETE", async () => {
    const res = await request(app).delete('/org/connected-accounts/linkedin/li-owner/member');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/DELETE/);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });
});
