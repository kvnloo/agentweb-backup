/**
 * Tests for org-level sharing model:
 * - Tasks: org members see each other's tasks by default
 * - Configs: org members see each other's configs by default
 * - Connected accounts: private by default, opt-in sharedWithOrg flag
 */
import request from 'supertest';
import express from 'express';
import orgRoutes from '../routes/org';

// Mutable state shared across mocks
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
    getUserByEmail: jest.fn((email: string) =>
      Promise.resolve(Object.values(mockUsers).find((u: any) => u.email === email) || null)
    ),
    updateUser: jest.fn((userId: string, updates: any) => {
      if (mockUsers[userId]) Object.assign(mockUsers[userId], updates);
      return Promise.resolve(mockUsers[userId]);
    }),
  },
  orgDb: {
    createOrg: jest.fn((org: any) => { mockOrgs[org.orgId] = org; return Promise.resolve(org); }),
    getOrgById: jest.fn((orgId: string) => Promise.resolve(mockOrgs[orgId] || null)),
    updateOrg: jest.fn((orgId: string, updates: any) => {
      if (mockOrgs[orgId]) Object.assign(mockOrgs[orgId], updates);
      return Promise.resolve(mockOrgs[orgId]);
    }),
    deleteOrg: jest.fn((orgId: string) => { delete mockOrgs[orgId]; return Promise.resolve(); }),
    getOrgMembers: jest.fn((orgId: string) =>
      Promise.resolve(Object.values(mockUsers).filter((u: any) => u.orgId === orgId))
    ),
    getOrgMemberCount: jest.fn((orgId: string) =>
      Promise.resolve(Object.values(mockUsers).filter((u: any) => u.orgId === orgId).length)
    ),
    ORG_MAX_MEMBERS: 5,
  },
}));

jest.mock('../services/emailService', () => ({
  emailService: { sendEmail: jest.fn().mockResolvedValue(undefined) },
}));

let app: express.Application;

const ORG_ID = 'org-abc';

beforeEach(() => {
  mockOrgs = {
    [ORG_ID]: {
      orgId: ORG_ID,
      name: 'Test Org',
      ownerUserId: 'user-owner',
      maxMembers: 5,
      pendingInvites: [],
      connected_accounts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };

  mockUsers = {
    'user-owner': {
      userId: 'user-owner',
      email: 'owner@example.com',
      displayName: 'Owner',
      orgId: ORG_ID,
      orgRole: 'owner',
      connected_accounts: [
        {
          platform: 'linkedin',
          account_id: 'li-001',
          account_name: 'Owner LinkedIn',
          config: { account_type: 'personal', access_token: 'tok', token_expires_at: 9999999999, scopes: [] },
          sharedWithOrg: false,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
        {
          platform: 'gmail',
          account_id: 'gmail-001',
          account_name: 'Owner Gmail',
          config: { account_type: 'personal', access_token: 'tok2', token_expires_at: 9999999999, scopes: [] },
          sharedWithOrg: true,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      ],
    },
    'user-member': {
      userId: 'user-member',
      email: 'member@example.com',
      displayName: 'Member',
      orgId: ORG_ID,
      orgRole: 'member',
      connected_accounts: [
        {
          platform: 'twitter',
          account_id: 'tw-001',
          account_name: 'Member Twitter',
          config: { account_type: 'personal', access_token: 'tok3', token_expires_at: 9999999999, scopes: [] },
          sharedWithOrg: false,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
        {
          platform: 'google_ads',
          account_id: 'google-ads-001',
          account_name: 'Member Google Ads',
          config: { account_type: 'ad_account', access_token: 'tok4', token_expires_at: 9999999999, scopes: [] },
          sharedWithOrg: false,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      ],
    },
  };

  mockCurrentUser = mockUsers['user-member'];

  app = express();
  app.use(express.json());
  app.use('/org', orgRoutes);
});

// ─── Connected Accounts ───────────────────────────────────────────────────────

describe('GET /org/:orgId/connected-accounts — privacy model', () => {
  it('does NOT include personal accounts where sharedWithOrg is false', async () => {
    const res = await request(app).get(`/org/${ORG_ID}/connected-accounts`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((a: any) => a.account_id);
    // li-001 (owner, sharedWithOrg: false) and tw-001 (member, sharedWithOrg: false) must be absent
    expect(ids).not.toContain('li-001');
    expect(ids).not.toContain('tw-001');
  });

  it('includes personal accounts where sharedWithOrg is true', async () => {
    const res = await request(app).get(`/org/${ORG_ID}/connected-accounts`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((a: any) => a.account_id);
    // gmail-001 (owner, sharedWithOrg: true) must be present
    expect(ids).toContain('gmail-001');
  });

  it('includes org-level accounts regardless of sharedWithOrg', async () => {
    mockOrgs[ORG_ID].connected_accounts = [{
      platform: 'instagram',
      account_id: 'ig-org-001',
      account_name: 'Org Instagram',
      config: { account_type: 'personal', access_token: 'tok', token_expires_at: 9999999999, scopes: [] },
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    }];
    const res = await request(app).get(`/org/${ORG_ID}/connected-accounts`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((a: any) => a.account_id);
    expect(ids).toContain('ig-org-001');
  });

  it('lets the org owner see private member-owned ad accounts with connector metadata', async () => {
    mockCurrentUser = mockUsers['user-owner'];

    const res = await request(app).get(`/org/${ORG_ID}/connected-accounts`);

    expect(res.status).toBe(200);
    const memberAdAccount = res.body.data.find((a: any) => a.account_id === 'google-ads-001');
    expect(memberAdAccount).toEqual(expect.objectContaining({
      account_id: 'google-ads-001',
      platform: 'google_ads',
      sharedWithOrg: false,
      addedBy: 'user-member',
      addedByName: 'Member',
      canManageSharing: true,
    }));
    expect(memberAdAccount.config.access_token).toBeUndefined();
  });

  it('lets the org owner see private member-owned non-ad accounts too', async () => {
    mockCurrentUser = mockUsers['user-owner'];

    const res = await request(app).get(`/org/${ORG_ID}/connected-accounts`);

    expect(res.status).toBe(200);
    const ids = res.body.data.map((a: any) => a.account_id);
    expect(ids).toContain('tw-001');
  });

  it('returns 403 if requester is not an org member', async () => {
    mockCurrentUser = { userId: 'outsider', email: 'outsider@example.com' };
    mockUsers['outsider'] = { userId: 'outsider', email: 'outsider@example.com', orgId: 'other-org' };
    const res = await request(app).get(`/org/${ORG_ID}/connected-accounts`);
    expect(res.status).toBe(403);
  });
});

// ─── Toggle sharedWithOrg ─────────────────────────────────────────────────────

describe('PATCH /org/connected-accounts/:platform/:accountId/share', () => {
  it('sets sharedWithOrg to true for a personal account', async () => {
    mockCurrentUser = mockUsers['user-owner'];
    const res = await request(app)
      .patch('/org/connected-accounts/linkedin/li-001/share')
      .send({ sharedWithOrg: true });
    expect(res.status).toBe(200);
    expect(res.body.sharedWithOrg).toBe(true);
    // The mock updateUser should have been called and applied
    expect(mockUsers['user-owner'].connected_accounts[0].sharedWithOrg).toBe(true);
  });

  it('sets sharedWithOrg to false (unshare)', async () => {
    mockCurrentUser = mockUsers['user-owner'];
    // Start with sharedWithOrg: true on gmail
    const res = await request(app)
      .patch('/org/connected-accounts/gmail/gmail-001/share')
      .send({ sharedWithOrg: false });
    expect(res.status).toBe(200);
    expect(res.body.sharedWithOrg).toBe(false);
    expect(mockUsers['user-owner'].connected_accounts[1].sharedWithOrg).toBe(false);
  });

  it('returns 400 if sharedWithOrg is not a boolean', async () => {
    mockCurrentUser = mockUsers['user-owner'];
    const res = await request(app)
      .patch('/org/connected-accounts/linkedin/li-001/share')
      .send({ sharedWithOrg: 'yes' });
    expect(res.status).toBe(400);
  });

  it('returns 404 if account does not exist', async () => {
    mockCurrentUser = mockUsers['user-owner'];
    const res = await request(app)
      .patch('/org/connected-accounts/linkedin/nonexistent/share')
      .send({ sharedWithOrg: true });
    expect(res.status).toBe(404);
  });

  it('returns 403 if user is not in any org', async () => {
    mockUsers['no-org-user'] = { userId: 'no-org-user', email: 'noorg@example.com', connected_accounts: [] };
    mockCurrentUser = mockUsers['no-org-user'];
    const res = await request(app)
      .patch('/org/connected-accounts/linkedin/li-001/share')
      .send({ sharedWithOrg: true });
    expect(res.status).toBe(403);
  });

  it('lets the org owner share a member-owned business ad account', async () => {
    mockCurrentUser = mockUsers['user-owner'];

    const res = await request(app)
      .patch('/org/connected-accounts/google_ads/google-ads-001/share')
      .send({ sharedWithOrg: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      sharedWithOrg: true,
      ownerUserId: 'user-member',
      adminManaged: true,
    }));
    const memberAdAccount = mockUsers['user-member'].connected_accounts.find((a: any) => a.account_id === 'google-ads-001');
    expect(memberAdAccount.sharedWithOrg).toBe(true);
  });

  it('lets the org owner share a member-owned personal account', async () => {
    mockCurrentUser = mockUsers['user-owner'];

    const res = await request(app)
      .patch('/org/connected-accounts/twitter/tw-001/share')
      .send({ sharedWithOrg: true });

    expect(res.status).toBe(200);
    expect(mockUsers['user-member'].connected_accounts[0].sharedWithOrg).toBe(true);
  });

  it('does not let an org member unshare an admin-managed business ad account', async () => {
    mockCurrentUser = mockUsers['user-owner'];
    await request(app)
      .patch('/org/connected-accounts/google_ads/google-ads-001/share')
      .send({ sharedWithOrg: true });

    mockCurrentUser = mockUsers['user-member'];
    const res = await request(app)
      .patch('/org/connected-accounts/google_ads/google-ads-001/share')
      .send({ sharedWithOrg: false });

    expect(res.status).toBe(403);
    const memberAdAccount = mockUsers['user-member'].connected_accounts.find((a: any) => a.account_id === 'google-ads-001');
    expect(memberAdAccount.sharedWithOrg).toBe(true);
  });
});
