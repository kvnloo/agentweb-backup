// ENG-3059: an org owner or admin may edit a same-org teammate's account
// memory; a plain member, a cross-org caller and an org-less caller may not.
import express from 'express';
import request from 'supertest';

let callerId = 'owner-1';

jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: callerId };
    next();
    return undefined;
  }),
}));

jest.mock('../../services/socialPostsService', () => ({
  getPostsForUser: jest.fn(),
  getSocialAccountIds: jest.fn(),
  generateEngagementMemory: jest.fn(),
}));

jest.mock('../../services/connectedAccountsDb', () => ({
  getEngagementMemory: jest.fn(),
  saveEngagementMemory: jest.fn(),
}));

jest.mock('../../services/db', () => ({
  userDb: { getUserById: jest.fn(), updateUser: jest.fn() },
  orgDb: { getOrgMembers: jest.fn(), getOrgById: jest.fn() },
  scheduleDb: { getScheduleById: jest.fn() },
  socialEngagementTrackingDb: { getEngagementsByAccount: jest.fn(), getEngagementsByPost: jest.fn() },
}));

import socialPostsRouter from '../socialPosts';
import { userDb, orgDb } from '../../services/db';
import { generateEngagementMemory } from '../../services/socialPostsService';
import { getEngagementMemory, saveEngagementMemory } from '../../services/connectedAccountsDb';

const mockGetUser = userDb.getUserById as jest.Mock;
const mockOrgDb = orgDb as any;
const mockGenerate = generateEngagementMemory as jest.Mock;
const mockGetMemory = getEngagementMemory as jest.Mock;
const mockSaveMemory = saveEngagementMemory as jest.Mock;

const acct = (id: string, platform = 'linkedin') => ({ account_id: id, account_name: id, platform, config: {} });

const USERS: Record<string, any> = {
  'owner-1': { userId: 'owner-1', orgId: 'org-a', orgRole: 'owner', connected_accounts: [acct('acc-owner')] },
  'admin-1': { userId: 'admin-1', orgId: 'org-a', orgRole: 'admin', connected_accounts: [] },
  'member-1': { userId: 'member-1', orgId: 'org-a', orgRole: 'member', connected_accounts: [acct('acc-member')] },
  'member-2': { userId: 'member-2', orgId: 'org-a', orgRole: 'member', connected_accounts: [acct('acc-member-2')] },
  // owner of a different org: an owner role must not carry across orgs
  'outsider-1': { userId: 'outsider-1', orgId: 'org-b', orgRole: 'owner', connected_accounts: [acct('acc-outsider')] },
  'solo-1': { userId: 'solo-1', connected_accounts: [acct('acc-solo')] },
};
const ORGS: Record<string, any> = {
  'org-a': { orgId: 'org-a', ownerUserId: 'owner-1' },
  'org-b': { orgId: 'org-b', ownerUserId: 'outsider-1' },
};

let app: express.Application;

beforeEach(() => {
  jest.clearAllMocks();
  callerId = 'owner-1';
  mockGetUser.mockImplementation(async (id: string) => USERS[id] ?? null);
  mockOrgDb.getOrgById.mockImplementation(async (id: string) => ORGS[id] ?? null);
  mockOrgDb.getOrgMembers.mockImplementation(async (orgId: string) =>
    Object.values(USERS).filter((u: any) => u.orgId === orgId).map((u: any) => ({ userId: u.userId, orgId: u.orgId })),
  );
  mockGetMemory.mockResolvedValue({ content: 'old', lastSyncedAt: 't0', createdAt: 't0', updatedAt: 't0' });
  mockSaveMemory.mockResolvedValue(undefined);
  mockGenerate.mockResolvedValue({ content: 'generated' });
  app = express();
  app.use(express.json());
  app.use('/api', socialPostsRouter);
});

const put = (accountId: string) => request(app).put(`/api/social-posts/memory/${accountId}`).send({ content: 'new' });
const sync = (accountId: string) => request(app).post(`/api/social-posts/memory/${accountId}/sync`);
const get = (accountId: string) => request(app).get(`/api/social-posts/memory/${accountId}`);

describe('ENG-3059 PUT /social-posts/memory/:accountId', () => {
  it('org owner edits a teammate account memory; it is saved under the teammate', async () => {
    const res = await put('acc-member');
    expect(res.status).toBe(200);
    expect(mockGetMemory).toHaveBeenCalledWith('member-1', 'acc-member');
    expect(mockSaveMemory).toHaveBeenCalledWith('member-1', 'acc-member', expect.objectContaining({ content: 'new', createdAt: 't0' }));
  });

  it('org admin edits a teammate account memory', async () => {
    callerId = 'admin-1';
    const res = await put('acc-member');
    expect(res.status).toBe(200);
    expect(mockSaveMemory).toHaveBeenCalledWith('member-1', 'acc-member', expect.anything());
  });

  it('plain member is refused 403 on a teammate account and nothing is written', async () => {
    callerId = 'member-2';
    const res = await put('acc-member');
    expect(res.status).toBe(403);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('plain member cannot edit the org owner account either', async () => {
    callerId = 'member-1';
    const res = await put('acc-owner');
    expect(res.status).toBe(403);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('creator keeps access to their own account', async () => {
    callerId = 'member-1';
    const res = await put('acc-member');
    expect(res.status).toBe(200);
    expect(mockSaveMemory).toHaveBeenCalledWith('member-1', 'acc-member', expect.anything());
  });

  it('owner of another org gets 404 for this org account, as before', async () => {
    callerId = 'outsider-1';
    const res = await put('acc-member');
    expect(res.status).toBe(404);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('org owner gets 404 for an account in another org', async () => {
    const res = await put('acc-outsider');
    expect(res.status).toBe(404);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('a misindexed cross-org member row never grants access', async () => {
    mockOrgDb.getOrgMembers.mockResolvedValue([
      { userId: 'owner-1', orgId: 'org-a' },
      { userId: 'outsider-1', orgId: 'org-a' }, // stale row; the user record says org-b
    ]);
    const res = await put('acc-outsider');
    expect([403, 404]).toContain(res.status);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('org-less user: own account works, any other account is 404 with no org lookup', async () => {
    callerId = 'solo-1';
    expect((await put('acc-solo')).status).toBe(200);
    expect((await put('acc-member')).status).toBe(404);
    expect(mockOrgDb.getOrgMembers).not.toHaveBeenCalled();
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
  });

  it('an unreadable org record is an absence of authority, not a grant', async () => {
    mockOrgDb.getOrgById.mockRejectedValue(new Error('ddb down'));
    const res = await put('acc-member');
    expect(res.status).toBe(403);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });
});

describe('ENG-3059 POST /social-posts/memory/:accountId/sync', () => {
  it('org owner syncs a teammate account; it runs as the account owner with their account record', async () => {
    const res = await sync('acc-member');
    expect(res.status).toBe(200);
    expect(mockGenerate).toHaveBeenCalledWith('member-1', USERS['member-1'].connected_accounts[0], expect.anything());
  });

  it('plain member is refused 403 and no generation runs', async () => {
    callerId = 'member-2';
    const res = await sync('acc-member');
    expect(res.status).toBe(403);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('cross-org caller gets 404 and no generation runs', async () => {
    callerId = 'outsider-1';
    const res = await sync('acc-member');
    expect(res.status).toBe(404);
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});

describe('ENG-3059 GET /social-posts/memory/:accountId canModify', () => {
  it.each([
    ['owner-1', 'acc-member', true],
    ['admin-1', 'acc-member', true],
    ['member-2', 'acc-member', false],
    ['member-1', 'acc-member', true],
  ])('%s reading %s gets canModify=%s', async (caller, accountId, expected) => {
    callerId = caller;
    const res = await get(accountId);
    expect(res.status).toBe(200);
    expect(res.body.canModify).toBe(expected);
  });

  it('cross-org read stays 404', async () => {
    callerId = 'outsider-1';
    expect((await get('acc-member')).status).toBe(404);
  });
});
