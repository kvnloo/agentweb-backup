import {
  getWorkspaceSocialPosts,
  findWorkspaceAccountOwner,
} from '../workspaceSocialPosts';

const ORG = 'org-a';
const members = [
  { userId: 'louisa', orgId: ORG, displayName: 'Louisa' },
  { userId: 'lili', orgId: ORG, displayName: 'Lili' },
  // misindexed row from another org must never be merged
  { userId: 'mallory', orgId: 'org-b', displayName: 'Mallory' },
];
const postsFor: Record<string, any> = {
  louisa: { success: true, posts: [{ id: 'p1', accountId: 'acct-l', createdAt: '2026-11-01T00:00:00Z' }], accounts: [{ accountId: 'acct-l' }] },
  lili: { success: true, posts: [{ id: 'p2', accountId: 'acct-x', createdAt: '2026-11-10T00:00:00Z' }], accounts: [{ accountId: 'acct-x' }] },
  mallory: { success: true, posts: [{ id: 'p3', accountId: 'acct-m', createdAt: '2026-11-11T00:00:00Z' }], accounts: [{ accountId: 'acct-m' }] },
};

describe('ENG-2968 workspace social posts', () => {
  it('member B sees member A posts credited by displayName, newest first', async () => {
    const r = await getWorkspaceSocialPosts({ userId: 'louisa', orgId: ORG }, {
      getOrgMembers: async () => members,
      fetchOwn: async () => postsFor.louisa,
      fetchForMember: async (id) => postsFor[id],
    });
    expect(r.posts.map((p) => p.id)).toEqual(['p2', 'p1']);
    expect(r.posts[0].createdBy).toEqual({ userId: 'lili', name: 'Lili' });
    expect(r.posts[0].canModify).toBe(false);
    expect(r.posts[1].canModify).toBe(true);
  });

  it('never includes a cross-org user', async () => {
    const r = await getWorkspaceSocialPosts({ userId: 'louisa', orgId: ORG }, {
      getOrgMembers: async () => members,
      fetchOwn: async () => postsFor.louisa,
      fetchForMember: async (id) => postsFor[id],
    });
    expect(r.posts.find((p) => p.id === 'p3')).toBeUndefined();
    expect(r.accounts.find((a) => a.accountId === 'acct-m')).toBeUndefined();
  });

  it('teammate failure is swallowed; own failure propagates', async () => {
    const r = await getWorkspaceSocialPosts({ userId: 'louisa', orgId: ORG }, {
      getOrgMembers: async () => members,
      fetchOwn: async () => postsFor.louisa,
      fetchForMember: async () => { throw new Error('boom'); },
    });
    expect(r.posts.map((p) => p.id)).toEqual(['p1']);
    await expect(getWorkspaceSocialPosts({ userId: 'louisa', orgId: ORG }, {
      getOrgMembers: async () => members,
      fetchOwn: async () => { throw new Error('own'); },
      fetchForMember: async (id) => postsFor[id],
    })).rejects.toThrow('own');
  });

  it('dedupes a shared company page post, caller wins', async () => {
    const r = await getWorkspaceSocialPosts({ userId: 'louisa', orgId: ORG }, {
      getOrgMembers: async () => members,
      fetchOwn: async () => ({ success: true, posts: [{ id: 'p9', accountId: 'co' }], accounts: [{ accountId: 'co' }] }),
      fetchForMember: async () => ({ success: true, posts: [{ id: 'p9', accountId: 'co' }], accounts: [{ accountId: 'co' }] }),
    });
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0].canModify).toBe(true);
    expect(r.accounts).toHaveLength(1);
  });

  it('account owner lookup: same-org teammate found, cross-org returns null', async () => {
    const accts: Record<string, any[]> = {
      louisa: [{ account_id: 'acct-l' }], lili: [{ account_id: 'acct-x' }], mallory: [{ account_id: 'acct-m' }],
    };
    const deps = { getOrgMembers: async () => members, getConnectedAccounts: async (id: string) => accts[id] };
    expect((await findWorkspaceAccountOwner({ userId: 'louisa', orgId: ORG }, 'acct-x', deps))?.userId).toBe('lili');
    expect(await findWorkspaceAccountOwner({ userId: 'louisa', orgId: ORG }, 'acct-m', deps)).toBeNull();
    expect(await findWorkspaceAccountOwner({ userId: 'louisa' }, 'acct-x', deps)).toBeNull();
  });
});
