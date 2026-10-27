import {
  applyFathomOnboardingReviewAction,
  FathomOnboardingReviewError,
} from '../services/fathomOnboardingIngestionService';

jest.mock('../services/db', () => ({ userDb: {}, crmDb: {}, accountMemoryDb: {}, orgMemoryDb: {} }));
jest.mock('../utils/llmService', () => ({ LLMService: jest.fn() }));
jest.mock('../services/fathomApiService', () => ({ FathomApiService: jest.fn() }));
jest.mock('../services/fathomTokenService', () => ({ getFathomAccessToken: jest.fn() }));

const NOW = '2026-10-07T00:00:00.000Z';

function entry(overrides: Record<string, any> = {}) {
  return {
    recordingId: 'rec-1',
    status: 'needs_review',
    extractionState: 'auto_extracted',
    context: {},
    targetUserId: 'fathom-draft-rec-1',
    draftUserId: 'fathom-draft-rec-1',
    memoryIds: [],
    orgMemoryIds: [],
    reviewOwnerUserId: 'admin',
    createdAt: 'c',
    updatedAt: 'u',
    ...overrides,
  };
}

function setup(users: Record<string, any>) {
  const userDb = {
    getUserById: jest.fn(async (id: string) => users[id] ?? null),
    updateUser: jest.fn(async (id: string, patch: any, options?: any) => {
      for (const set of options?.elementSets || []) {
        const list = [...(users[id][set.path[0]] || [])];
        const before = list[set.index];
        // Mirror the service's slot condition: same recording, status, updatedAt.
        const v = options?.condition?.values || {};
        if (!before || before.recordingId !== v[':rid'] || before.status !== v[':st'] || before.updatedAt !== v[':upd']) {
          throw Object.assign(new Error('conditional'), { code: 'ConditionalCheckFailedException' });
        }
        list[set.index] = set.value;
        users[id] = { ...users[id], [set.path[0]]: list };
      }
      users[id] = { ...users[id], ...patch };
      return users[id];
    }),
  };
  const accountMemoryDb = { deleteMemory: jest.fn().mockResolvedValue(undefined) };
  const orgMemoryDb = { deleteMemory: jest.fn().mockResolvedValue(undefined), getMemory: jest.fn().mockResolvedValue({ memoryId: 'o1' }) };
  return { userDb, accountMemoryDb, orgMemoryDb, now: () => NOW } as any;
}

describe('applyFathomOnboardingReviewAction (ENG-270)', () => {
  it('discards a needs_review draft and keeps the draft account disabled', async () => {
    const users: Record<string, any> = {
      'fathom-draft-rec-1': { userId: 'fathom-draft-rec-1', fathomDraftAccount: true, isActive: false, fathomOnboardingIngestions: [entry()] },
    };
    const deps = setup(users);
    const out = await applyFathomOnboardingReviewAction(
      { userId: 'fathom-draft-rec-1', recordingId: 'rec-1', action: 'discard', actorUserId: 'admin' }, deps);
    expect(out.status).toBe('discarded');
    expect(users['fathom-draft-rec-1'].fathomDraftStatus).toBe('discarded');
    expect(users['fathom-draft-rec-1'].isActive).toBe(false);
    expect(users['fathom-draft-rec-1'].fathomOnboardingIngestions[0].status).toBe('discarded');
  });

  it('never touches a non-draft account when discarding', async () => {
    const users: Record<string, any> = {
      cust: { userId: 'cust', isActive: true, fathomOnboardingIngestions: [entry({ draftUserId: 'cust', targetUserId: 'cust' })] },
    };
    const deps = setup(users);
    await applyFathomOnboardingReviewAction({ userId: 'cust', recordingId: 'rec-1', action: 'discard', actorUserId: 'admin' }, deps);
    expect(users.cust.isActive).toBe(true);
    expect(users.cust.fathomDraftStatus).toBeUndefined();
  });

  it('refuses to discard a reviewed item (must roll back first)', async () => {
    const users: Record<string, any> = { u: { userId: 'u', fathomOnboardingIngestions: [entry({ status: 'reviewed' })] } };
    await expect(applyFathomOnboardingReviewAction(
      { userId: 'u', recordingId: 'rec-1', action: 'discard', actorUserId: 'admin' }, setup(users)))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('rolls back a reviewed item: deletes only its recorded memories and returns it to needs_review', async () => {
    const users: Record<string, any> = {
      cust: {
        userId: 'cust',
        orgId: 'org-1',
        fathomOnboardingIngestions: [
          entry({ status: 'reviewed', extractionState: 'human_reviewed', targetUserId: 'cust', draftUserId: null, memoryIds: ['m1'], orgMemoryIds: ['o1'] }),
          entry({ recordingId: 'rec-2', status: 'reviewed', memoryIds: ['m2'] }),
        ],
      },
    };
    const deps = setup(users);
    const out = await applyFathomOnboardingReviewAction({ userId: 'cust', recordingId: 'rec-1', action: 'rollback', actorUserId: 'admin' }, deps);
    expect(deps.accountMemoryDb.deleteMemory).toHaveBeenCalledTimes(1);
    expect(deps.accountMemoryDb.deleteMemory).toHaveBeenCalledWith('cust', 'm1');
    expect(deps.orgMemoryDb.deleteMemory).toHaveBeenCalledWith('org-1', 'o1');
    expect(out).toMatchObject({ status: 'needs_review', extractionState: 'auto_extracted', memoryIds: [], orgMemoryIds: [] });
    expect(users.cust.fathomOnboardingIngestions[1].memoryIds).toEqual(['m2']);
  });

  it('is idempotent: repeated rollback/discard performs no further writes', async () => {
    const users: Record<string, any> = {
      u: { userId: 'u', fathomOnboardingIngestions: [entry({ status: 'discarded' }), entry({ recordingId: 'rec-2' })] },
    };
    const deps = setup(users);
    await applyFathomOnboardingReviewAction({ userId: 'u', recordingId: 'rec-1', action: 'discard', actorUserId: 'a' }, deps);
    await applyFathomOnboardingReviewAction({ userId: 'u', recordingId: 'rec-2', action: 'rollback', actorUserId: 'a' }, deps);
    expect(deps.userDb.updateUser).not.toHaveBeenCalled();
    expect(deps.accountMemoryDb.deleteMemory).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown user or recording', async () => {
    const deps = setup({ u: { userId: 'u', fathomOnboardingIngestions: [] } });
    await expect(applyFathomOnboardingReviewAction({ userId: 'x', recordingId: 'rec-1', action: 'discard', actorUserId: 'a' }, deps))
      .rejects.toBeInstanceOf(FathomOnboardingReviewError);
    await expect(applyFathomOnboardingReviewAction({ userId: 'u', recordingId: 'rec-1', action: 'discard', actorUserId: 'a' }, deps))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses to discard a re-ingested needs_review item that still holds approved memories', async () => {
    const users: Record<string, any> = { u: { userId: 'u', fathomOnboardingIngestions: [entry({ memoryIds: ['m1'] })] } };
    await expect(applyFathomOnboardingReviewAction(
      { userId: 'u', recordingId: 'rec-1', action: 'discard', actorUserId: 'admin' }, setup(users)))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('rolls back approved memories left on a re-ingested needs_review item', async () => {
    const users: Record<string, any> = {
      cust: { userId: 'cust', orgId: 'org-1', fathomOnboardingIngestions: [entry({ targetUserId: 'cust', memoryIds: ['m1'], orgMemoryIds: ['o1'] })] },
    };
    const deps = setup(users);
    const out = await applyFathomOnboardingReviewAction({ userId: 'cust', recordingId: 'rec-1', action: 'rollback', actorUserId: 'admin' }, deps);
    expect(deps.accountMemoryDb.deleteMemory).toHaveBeenCalledWith('cust', 'm1');
    expect(deps.orgMemoryDb.deleteMemory).toHaveBeenCalledWith('org-1', 'o1');
    expect(out.memoryIds).toEqual([]);
    expect(out.orgMemoryIds).toEqual([]);
  });

  it('deletes org memories from the org they were written under, not the user\'s current org', async () => {
    const users: Record<string, any> = {
      cust: { userId: 'cust', orgId: 'org-new', fathomOnboardingIngestions: [entry({ status: 'reviewed', targetUserId: 'cust', orgMemoryIds: ['o1'], orgMemoryOrgId: 'org-old' })] },
    };
    const deps = setup(users);
    await applyFathomOnboardingReviewAction({ userId: 'cust', recordingId: 'rec-1', action: 'rollback', actorUserId: 'admin' }, deps);
    expect(deps.orgMemoryDb.deleteMemory).toHaveBeenCalledWith('org-old', 'o1');
    expect(deps.orgMemoryDb.deleteMemory).not.toHaveBeenCalledWith('org-new', 'o1');
  });

  it('refuses rollback (409) and keeps org memory ids when the org cannot be resolved', async () => {
    const users: Record<string, any> = {
      legacy: { userId: 'legacy', fathomOnboardingIngestions: [entry({ status: 'reviewed', targetUserId: 'legacy', orgMemoryIds: ['o1'] })] },
    };
    const deps = setup(users);
    await expect(applyFathomOnboardingReviewAction({ userId: 'legacy', recordingId: 'rec-1', action: 'rollback', actorUserId: 'admin' }, deps))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(users.legacy.fathomOnboardingIngestions[0]).toMatchObject({ status: 'reviewed', orgMemoryIds: ['o1'] });
  });

  it('a refused rollback deletes nothing, not even account memories (Opslane 355)', async () => {
    const users: Record<string, any> = {
      legacy: { userId: 'legacy', fathomOnboardingIngestions: [entry({ status: 'reviewed', targetUserId: 'legacy', memoryIds: ['m1'], orgMemoryIds: ['o1'] })] },
    };
    const deps = setup(users);
    await expect(applyFathomOnboardingReviewAction({ userId: 'legacy', recordingId: 'rec-1', action: 'rollback', actorUserId: 'admin' }, deps))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(deps.accountMemoryDb.deleteMemory).not.toHaveBeenCalled();
    expect(deps.orgMemoryDb.deleteMemory).not.toHaveBeenCalled();
  });

  it('discard never disables a draft an admin has since approved/activated (Opslane 355)', async () => {
    const users: Record<string, any> = {
      'fathom-draft-rec-1': { userId: 'fathom-draft-rec-1', fathomDraftAccount: true, isActive: true, fathomDraftStatus: 'approved', fathomOnboardingIngestions: [entry()] },
    };
    const deps = setup(users);
    const out = await applyFathomOnboardingReviewAction({ userId: 'fathom-draft-rec-1', recordingId: 'rec-1', action: 'discard', actorUserId: 'admin' }, deps);
    expect(out.status).toBe('discarded');
    expect(users['fathom-draft-rec-1']).toMatchObject({ fathomDraftStatus: 'approved', isActive: true });
  });

  it('retrying discard finishes flagging a draft left unflagged by a half-finished first try', async () => {
    const users: Record<string, any> = {
      'fathom-draft-rec-1': { userId: 'fathom-draft-rec-1', fathomDraftAccount: true, isActive: false, fathomDraftStatus: 'needs_review', fathomOnboardingIngestions: [entry({ status: 'discarded' })] },
    };
    const deps = setup(users);
    await applyFathomOnboardingReviewAction({ userId: 'fathom-draft-rec-1', recordingId: 'rec-1', action: 'discard', actorUserId: 'admin' }, deps);
    expect(users['fathom-draft-rec-1']).toMatchObject({ fathomDraftStatus: 'discarded', isActive: false });
  });

  it('does not overwrite a concurrent action on a different recording of the same user', async () => {
    const users: Record<string, any> = {
      u: { userId: 'u', fathomOnboardingIngestions: [
        entry({ recordingId: 'a', draftUserId: null }),
        entry({ recordingId: 'b', draftUserId: null }),
      ] },
    };
    const deps = setup(users);
    // Both actions read the same snapshot before either writes.
    const snapshot = JSON.parse(JSON.stringify(users.u));
    let reads = 0;
    deps.userDb.getUserById.mockImplementation(async (id: string) => (id === 'u' && reads++ < 2 ? snapshot : users[id] ?? null));
    await Promise.all([
      applyFathomOnboardingReviewAction({ userId: 'u', recordingId: 'a', action: 'discard', actorUserId: 'admin' }, deps),
      applyFathomOnboardingReviewAction({ userId: 'u', recordingId: 'b', action: 'discard', actorUserId: 'admin' }, deps),
    ]);
    expect(users.u.fathomOnboardingIngestions.map((e: any) => e.status)).toEqual(['discarded', 'discarded']);
  });

  it('re-reads and retries when the slot changed under it', async () => {
    const users: Record<string, any> = {
      u: { userId: 'u', fathomOnboardingIngestions: [entry({ recordingId: 'a', draftUserId: null })] },
    };
    const deps = setup(users);
    const stale = { userId: 'u', fathomOnboardingIngestions: [entry({ recordingId: 'a', draftUserId: null, updatedAt: 'old' })] };
    deps.userDb.getUserById.mockImplementationOnce(async () => stale);
    const out = await applyFathomOnboardingReviewAction({ userId: 'u', recordingId: 'a', action: 'discard', actorUserId: 'admin' }, deps);
    expect(out.status).toBe('discarded');
    expect(deps.userDb.updateUser).toHaveBeenCalledTimes(2);
    expect(users.u.fathomOnboardingIngestions[0].status).toBe('discarded');
  });

  it('refuses a legacy rollback when the user moved orgs and the current org lacks the memory (Opslane run 417)', async () => {
    const users: Record<string, any> = {
      legacy: { userId: 'legacy', orgId: 'org-new', fathomOnboardingIngestions: [entry({ status: 'reviewed', targetUserId: 'legacy', memoryIds: ['m1'], orgMemoryIds: ['o-legacy-1'] })] },
    };
    const deps = setup(users);
    deps.orgMemoryDb.getMemory.mockResolvedValue(null);
    await expect(applyFathomOnboardingReviewAction({ userId: 'legacy', recordingId: 'rec-1', action: 'rollback', actorUserId: 'admin' }, deps))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(deps.orgMemoryDb.getMemory).toHaveBeenCalledWith('org-new', 'o-legacy-1');
    expect(deps.orgMemoryDb.deleteMemory).not.toHaveBeenCalled();
    expect(deps.accountMemoryDb.deleteMemory).not.toHaveBeenCalled();
    expect(users.legacy.fathomOnboardingIngestions[0]).toMatchObject({ status: 'reviewed', memoryIds: ['m1'], orgMemoryIds: ['o-legacy-1'] });
  });

  it('rolls back a legacy entry in the admin-supplied original org when it holds every memory (Opslane run 1336, P2)', async () => {
    const users: Record<string, any> = {
      legacy: { userId: 'legacy', orgId: 'org-new', fathomOnboardingIngestions: [entry({ status: 'reviewed', targetUserId: 'legacy', memoryIds: ['m1'], orgMemoryIds: ['o-legacy-1'] })] },
    };
    const deps = setup(users);
    deps.orgMemoryDb.getMemory.mockImplementation(async (orgId: string) => (orgId === 'org-old' ? { memoryId: 'o-legacy-1' } : null));
    const out = await applyFathomOnboardingReviewAction({ userId: 'legacy', recordingId: 'rec-1', action: 'rollback', actorUserId: 'admin', orgMemoryOrgId: 'org-old' }, deps);
    expect(out).toMatchObject({ status: 'needs_review', memoryIds: [], orgMemoryIds: [] });
    expect(deps.orgMemoryDb.deleteMemory).toHaveBeenCalledWith('org-old', 'o-legacy-1');
    expect(deps.orgMemoryDb.deleteMemory).not.toHaveBeenCalledWith('org-new', expect.anything());
    expect(deps.accountMemoryDb.deleteMemory).toHaveBeenCalledWith('legacy', 'm1');
  });

  it('still refuses when the admin-supplied org does not hold the memories', async () => {
    const users: Record<string, any> = {
      legacy: { userId: 'legacy', orgId: 'org-new', fathomOnboardingIngestions: [entry({ status: 'reviewed', targetUserId: 'legacy', memoryIds: ['m1'], orgMemoryIds: ['o-legacy-1'] })] },
    };
    const deps = setup(users);
    deps.orgMemoryDb.getMemory.mockResolvedValue(null);
    await expect(applyFathomOnboardingReviewAction({ userId: 'legacy', recordingId: 'rec-1', action: 'rollback', actorUserId: 'admin', orgMemoryOrgId: 'org-wrong' }, deps))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(deps.orgMemoryDb.deleteMemory).not.toHaveBeenCalled();
    expect(deps.accountMemoryDb.deleteMemory).not.toHaveBeenCalled();
  });

  it('rollback undoes a mistaken discard: entry back to needs_review, draft un-flagged but still inactive (Opslane run 1336, P1)', async () => {
    const users: Record<string, any> = {
      'fathom-draft-rec-1': { userId: 'fathom-draft-rec-1', fathomDraftAccount: true, isActive: false, fathomOnboardingIngestions: [entry()] },
    };
    const deps = setup(users);
    const args = { userId: 'fathom-draft-rec-1', recordingId: 'rec-1', actorUserId: 'admin' };
    await applyFathomOnboardingReviewAction({ ...args, action: 'discard' }, deps);
    expect(users['fathom-draft-rec-1'].fathomDraftStatus).toBe('discarded');
    const out = await applyFathomOnboardingReviewAction({ ...args, action: 'rollback' }, deps);
    expect(out.status).toBe('needs_review');
    expect(users['fathom-draft-rec-1'].fathomOnboardingIngestions[0].status).toBe('needs_review');
    expect(users['fathom-draft-rec-1'].fathomDraftStatus).toBe('needs_review');
    expect(users['fathom-draft-rec-1'].isActive).toBe(false);
    expect(deps.accountMemoryDb.deleteMemory).not.toHaveBeenCalled();
  });
});
