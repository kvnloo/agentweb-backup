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
    updateUser: jest.fn(async (id: string, patch: any) => {
      users[id] = { ...users[id], ...patch };
      return users[id];
    }),
  };
  const accountMemoryDb = { deleteMemory: jest.fn().mockResolvedValue(undefined) };
  const orgMemoryDb = { deleteMemory: jest.fn().mockResolvedValue(undefined) };
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
});
