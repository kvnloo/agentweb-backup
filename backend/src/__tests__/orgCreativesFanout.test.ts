// ENG-2834: org members see each other's Creatives when `creatives` sharing is on.
import { getOrgVisibleAssets, mergeAssetGroups, CreativesFanoutDeps } from '../utils/orgCreativesFanout';
import { defaultShareSettings, OWNED_FEATURES, TOGGLEABLE_FEATURES } from '../services/orgShareService';

const assets: Record<string, Record<string, any>> = {
  userA: { taskA: { taskId: 'taskA', executions: [{ result_files: [{ filename: 'a.png' }] }] } },
  userB: { taskB: { taskId: 'taskB', executions: [{ result_files: [{ filename: 'b.png' }] }] } },
  userX: { taskX: { taskId: 'taskX', executions: [{ result_files: [{ filename: 'x.png' }] }] } },
};
const users: Record<string, any> = {
  userA: { orgId: 'org1', orgRole: 'owner' },
  userB: { orgId: 'org1', orgRole: 'member' },
  userX: { orgId: 'org2', orgRole: 'owner' },
  solo: {},
};
const members: Record<string, string[]> = { org1: ['userA', 'userB'], org2: ['userX'] };

function deps(shareSettings?: any): CreativesFanoutDeps & { getAssetsForUser: jest.Mock } {
  return {
    getUser: async (id) => users[id],
    getOrg: async (orgId) => ({ orgId, ownerUserId: orgId === 'org1' ? 'userA' : 'userX', shareSettings }),
    getOrgMemberIds: async (orgId) => members[orgId] ?? [],
    getAssetsForUser: jest.fn(async (id: string) => assets[id] ?? {}),
  };
}

describe('Creatives org fan-out (ENG-2834)', () => {
  it('member B sees member A images when sharing is on (default, no stored key)', async () => {
    const r = await getOrgVisibleAssets('userB', deps(undefined));
    expect(Object.keys(r).sort()).toEqual(['taskA', 'taskB']);
    expect(r.taskA.ownerUserId).toBe('userA');
    expect(r.taskB.ownerUserId).toBeUndefined();
  });

  it('member B sees only own images when sharing is off', async () => {
    const ss = { ...defaultShareSettings(), creatives: { enabled: false, editors: [] } };
    const r = await getOrgVisibleAssets('userB', deps(ss));
    expect(Object.keys(r)).toEqual(['taskB']);
  });

  it('owner also sees only own images when sharing is off (member-owned toggle)', async () => {
    const ss = { ...defaultShareSettings(), creatives: { enabled: false, editors: [] } };
    expect(Object.keys(await getOrgVisibleAssets('userA', deps(ss)))).toEqual(['taskA']);
  });

  it('never includes another org\'s assets', async () => {
    const d = deps(undefined);
    const r = await getOrgVisibleAssets('userB', d);
    expect(r.taskX).toBeUndefined();
    expect(d.getAssetsForUser).not.toHaveBeenCalledWith('userX');
  });

  it('user without an org gets caller-only', async () => {
    const d = deps(undefined);
    await getOrgVisibleAssets('solo', d);
    expect(d.getAssetsForUser).toHaveBeenCalledTimes(1);
  });

  it('degrades to caller-only when org lookup throws', async () => {
    const d = { ...deps(undefined), getOrg: async () => { throw new Error('boom'); } };
    expect(Object.keys(await getOrgVisibleAssets('userB', d))).toEqual(['taskB']);
  });

  it('teammate stars never show as the caller\'s favorites', () => {
    const m = mergeAssetGroups(
      { mine: { result_files: [{ url: 'a', is_favorited: true }] } },
      [{ ownerUserId: 'o', groups: { theirs: { result_files: [{ url: 'b', is_favorited: true }] } } }],
    );
    expect(m.mine.result_files[0].is_favorited).toBe(true);
    expect(m.theirs.result_files[0].is_favorited).toBe(false);
    expect(m.theirs.sharedFromOrg).toBe(true);
  });

  it('own entry wins on key collision', () => {
    const m = mergeAssetGroups({ k: { mine: true } }, [{ ownerUserId: 'o', groups: { k: { mine: false } } }]);
    expect(m.k).toEqual({ mine: true });
  });

  it('creatives is toggleable but excluded from member-removal ownership cleanup', () => {
    expect(TOGGLEABLE_FEATURES).toContain('creatives');
    expect(OWNED_FEATURES).not.toContain('creatives' as any);
    expect(defaultShareSettings().creatives.enabled).toBe(true);
  });
});
