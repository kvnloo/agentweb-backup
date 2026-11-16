import {
  resolveWorkspaceMembers,
  mergeWorkspaceAssets,
  getWorkspaceAssets,
  getWorkspaceApprovalStatusByUrl,
} from '../workspaceAssets';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

const membersA = [
  { userId: 'alice', orgId: ORG_A, name: 'Alice' },
  { userId: 'bob', orgId: ORG_A, email: 'bob@a.test' },
];

const assetsByUser: Record<string, Record<string, any>> = {
  alice: { t1: { taskId: 't1', executions: [{ executionId: 'e1', result_files: [{ url: 'u/alice.png' }] }] } },
  bob: { t2: { taskId: 't2', executions: [{ executionId: 'e2', result_files: [{ url: 'u/bob.png' }] }] } },
  mallory: { t3: { taskId: 't3', executions: [{ executionId: 'e3', result_files: [{ url: 'u/mallory.png' }] }] } },
};

const fetchForUser = jest.fn(async (id: string) => assetsByUser[id] || {});

beforeEach(() => fetchForUser.mockClear());

describe('ENG-2874 workspace creative sharing', () => {
  it('same-org members see each other\'s assets with creator attribution', async () => {
    const out = await getWorkspaceAssets({ userId: 'bob', orgId: ORG_A }, {
      getOrgMembers: async () => membersA,
      fetchForUser,
    });
    expect(Object.keys(out).sort()).toEqual(['t1', 't2']);
    expect(out.t1.createdBy).toEqual({ userId: 'alice', name: 'Alice' });
    expect(out.t1.executions[0].result_files[0].createdBy.userId).toBe('alice');
    expect(out.t2.createdBy).toEqual({ userId: 'bob', name: 'bob@a.test' });
  });

  it('never includes a member from another org (cross-org denial)', async () => {
    const out = await getWorkspaceAssets({ userId: 'alice', orgId: ORG_A }, {
      getOrgMembers: async () => [...membersA, { userId: 'mallory', orgId: ORG_B }],
      fetchForUser,
    });
    expect(out.t3).toBeUndefined();
    expect(fetchForUser).not.toHaveBeenCalledWith('mallory');
  });

  it('a user without an org falls back to own assets only', async () => {
    const getOrgMembers = jest.fn();
    const out = await getWorkspaceAssets({ userId: 'alice' }, { getOrgMembers, fetchForUser });
    expect(Object.keys(out)).toEqual(['t1']);
    expect(getOrgMembers).not.toHaveBeenCalled();
  });

  it('caller absent from their org member list is treated as org-less', async () => {
    const members = await resolveWorkspaceMembers({ userId: 'mallory', orgId: ORG_A }, {
      getOrgMembers: async () => membersA,
    });
    expect(members.map((m) => m.userId)).toEqual(['mallory']);
  });

  it('member lookup failure falls back to own assets', async () => {
    const members = await resolveWorkspaceMembers({ userId: 'alice', orgId: ORG_A }, {
      getOrgMembers: async () => { throw new Error('ddb down'); },
    });
    expect(members.map((m) => m.userId)).toEqual(['alice']);
  });

  it('a failing teammate fetch does not break the caller; caller failure still throws', async () => {
    const flaky = jest.fn(async (id: string) => {
      if (id === 'bob') throw new Error('boom');
      return assetsByUser[id];
    });
    const out = await getWorkspaceAssets({ userId: 'alice', orgId: ORG_A }, {
      getOrgMembers: async () => membersA, fetchForUser: flaky,
    });
    expect(Object.keys(out)).toEqual(['t1']);
    await expect(getWorkspaceAssets({ userId: 'bob', orgId: ORG_A }, {
      getOrgMembers: async () => membersA, fetchForUser: flaky,
    })).rejects.toThrow('boom');
  });

  it('merge keeps caller entry on key collision', () => {
    const out = mergeWorkspaceAssets([
      { member: { userId: 'alice' }, result: { k: { v: 1 } } },
      { member: { userId: 'bob' }, result: { k: { v: 2 } } },
    ]);
    expect(out.k.v).toBe(1);
  });

  it('favorites view only reflects the caller\'s own favorites (Opslane P1 regression)', async () => {
    const favAssets: Record<string, Record<string, any>> = {
      alice: { t1: { executions: [{ executionId: 'e1', result_files: [{ url: 'u/a.png', is_favorited: true }] }] } },
      bob: { t2: { executions: [{ executionId: 'e2', result_files: [{ url: 'u/b.png', is_favorited: true }] }] } },
    };
    const out = await getWorkspaceAssets({ userId: 'alice', orgId: ORG_A }, {
      getOrgMembers: async () => membersA,
      fetchForUser: async (id) => favAssets[id] || {},
    });
    const own = out.t1.executions[0].result_files[0];
    const mate = out.t2.executions[0].result_files[0];
    expect(own.is_favorited).toBe(true);
    expect(own.canModify).toBe(true);
    expect(mate.is_favorited).toBe(false);
    expect(mate.canModify).toBe(false);
    expect(out.t2.canModify).toBe(false);
    expect(mate.createdBy.userId).toBe('bob');
  });

  it('credits a teammate by displayName before email (Opslane P2 regression)', () => {
    const out = mergeWorkspaceAssets([
      { member: { userId: 'bob', displayName: 'Bob B', email: 'bob@a.test' }, result: { k: { v: 1 } } },
    ], 'alice');
    expect(out.k.createdBy).toEqual({ userId: 'bob', name: 'Bob B' });
  });

  it('approval statuses merge across members', async () => {
    const map = await getWorkspaceApprovalStatusByUrl(membersA, async (id) =>
      id === 'alice' ? [{ assetUrl: 'u/alice.png', status: 'approved' }] : [{ assetUrl: 'u/bob.png', status: 'draft' }]);
    expect(map).toEqual({ 'u/alice.png': 'approved', 'u/bob.png': 'draft' });
  });
});
