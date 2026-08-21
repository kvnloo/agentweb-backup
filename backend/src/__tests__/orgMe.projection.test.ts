/**
 * ENG-953 + ENG-954 — what GET /api/org/me is allowed to return.
 *
 * It used to spread the entire Organization record to any member, including
 * org-level connected_accounts with unredacted config and the encrypted per-org
 * `secrets` map. The redactor already existed in the same file and was applied
 * to the sibling connected-accounts routes — just never to this one.
 */
import request from 'supertest';
import express from 'express';
import orgRoutes from '../routes/org';

let actingUserId = 'u-member';
let mockUsers: Record<string, any> = {};
let mockOrgs: Record<string, any> = {};

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: actingUserId, email: 'x@x.com', isAdmin: false };
    next();
  },
  AuthenticatedRequest: {},
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn((id: string) => Promise.resolve(mockUsers[id] || null)) },
  orgDb: {
    getOrgById: jest.fn((id: string) => Promise.resolve(mockOrgs[id] || null)),
    getOrgMembers: jest.fn(() => Promise.resolve(Object.values(mockUsers).filter((u: any) => u.orgId === 'org-1'))),
  },
  Organization: {},
}));

let app: express.Express;
beforeEach(() => {
  mockUsers = {
    'u-owner':  { userId: 'u-owner',  email: 'o@x.com', orgId: 'org-1', orgRole: 'owner' },
    'u-admin':  { userId: 'u-admin',  email: 'a@x.com', orgId: 'org-1', orgRole: 'admin' },
    'u-member': { userId: 'u-member', email: 'm@x.com', orgId: 'org-1', orgRole: 'member' },
  };
  mockOrgs = {
    'org-1': {
      orgId: 'org-1', name: 'Acme', ownerUserId: 'u-owner',
      secrets: { CLICKUP_TOKEN: 'enc:super-secret', FOREPLAY_KEY: 'enc:also-secret' },
      connected_accounts: [{
        platform: 'clickup', account_id: 'a1',
        config: { workspace: 'ws-1', access_token: 'tok-LEAK', refresh_token: 'r-LEAK', api_key: 'k-LEAK' },
      }],
      shareSettings: { knowledgeBase: { enabled: true, editors: [] } },
      pendingInvites: [],
      createdAt: 'now', updatedAt: 'now',
    },
  };
  actingUserId = 'u-member';
  app = express(); app.use(express.json()); app.use('/api/org', orgRoutes);
});

const me = () => request(app).get('/api/org/me');

describe('GET /api/org/me does not leak org credentials', () => {
  it('never returns the encrypted org secrets map', async () => {
    const res = await me();
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('secrets');
    expect(JSON.stringify(res.body)).not.toMatch(/super-secret|also-secret/);
  });

  it('redacts credential-shaped keys from org connected accounts', async () => {
    const res = await me();
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/tok-LEAK|r-LEAK|k-LEAK/);
    // Non-credential config survives, so the feature still works.
    expect(res.body.data.connected_accounts[0].config.workspace).toBe('ws-1');
  });

  it('leaks nothing to an owner either — the projection is not role-dependent', async () => {
    actingUserId = 'u-owner';
    const res = await me();
    expect(res.body.data).not.toHaveProperty('secrets');
    expect(JSON.stringify(res.body)).not.toMatch(/super-secret/);
  });

  it('is an allowlist: an unknown Organization field is not passed through', async () => {
    (mockOrgs['org-1'] as any).someFutureSecretField = 'must-not-appear';
    const res = await me();
    expect(JSON.stringify(res.body)).not.toMatch(/must-not-appear/);
  });

  it('still returns the fields the portal actually reads', async () => {
    const res = await me();
    for (const f of ['orgId', 'name', 'ownerUserId', 'members', 'shareSettings', 'pendingInvites']) {
      expect(res.body.data).toHaveProperty(f);
    }
  });
});

describe('GET /api/org/me exposes server-computed capabilities', () => {
  it('an owner gets every capability', async () => {
    actingUserId = 'u-owner';
    const { capabilities, callerRole } = (await me()).body.data;
    expect(callerRole).toBe('owner');
    expect(capabilities).toEqual({
      canManageOrg: true, canManageMembers: true, canManageContent: true,
      canSeeAllAccounts: true, canDeleteOrg: true,
    });
  });

  it('an admin gets everything except deleting the org', async () => {
    actingUserId = 'u-admin';
    const { capabilities, callerRole } = (await me()).body.data;
    expect(callerRole).toBe('admin');
    expect(capabilities.canManageOrg).toBe(true);
    expect(capabilities.canManageMembers).toBe(true);
    expect(capabilities.canDeleteOrg).toBe(false);
  });

  it('a member gets none', async () => {
    const { capabilities, callerRole } = (await me()).body.data;
    expect(callerRole).toBe('member');
    expect(Object.values(capabilities).every((v) => v === false)).toBe(true);
  });
});
