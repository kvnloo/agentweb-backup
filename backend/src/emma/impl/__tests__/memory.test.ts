/**
 * ENG-2840 (W2-1): the four memory tool bodies in emma/impl/memory.ts.
 *
 * Two kinds of test. The guards Emma already had (identity from context, memory switched off, no org, the role check, the 2,000
 * character split) must be unchanged. The five defects found on 2026-11-23 must stay fixed: each has a test that fails on the old
 * behaviour (checked by putting the old behaviour back, see the PR).
 */
const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();
const mockAddAccount = jest.fn();
const mockDeleteAccount = jest.fn();
const mockAddOrg = jest.fn();
const mockDeleteOrg = jest.fn();
const mockEmbedText = jest.fn();

jest.mock('../../../services/db', () => ({
  userDb: { getUserById: (...a: any[]) => mockGetUserById(...a) },
  orgDb: { getOrgById: (...a: any[]) => mockGetOrgById(...a) },
  accountMemoryDb: {
    addMemory: (...a: any[]) => mockAddAccount(...a),
    deleteMemory: (...a: any[]) => mockDeleteAccount(...a),
  },
  orgMemoryDb: {
    addMemory: (...a: any[]) => mockAddOrg(...a),
    deleteMemory: (...a: any[]) => mockDeleteOrg(...a),
  },
}));
jest.mock('../../../utils/embeddings', () => ({ embedText: (...a: any[]) => mockEmbedText(...a) }));

import * as contentLimit from '../../../utils/memoryContentLimit';
import { deleteAccountMemory, deleteOrgMemory, saveAccountMemory, saveOrgMemory } from '../memory';

const ctx = { userId: 'u1', sessionId: 's1' };
const EMBEDDING = [0.1, 0.2];

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserById.mockResolvedValue({ userId: 'u1', orgId: 'org1', orgRole: 'member' });
  mockGetOrgById.mockResolvedValue({ orgId: 'org1', ownerUserId: 'owner1' });
  mockEmbedText.mockResolvedValue(EMBEDDING);
  let n = 0;
  mockAddAccount.mockImplementation(async () => ({ memoryId: `m${++n}` }));
  mockAddOrg.mockImplementation(async () => ({ memoryId: `o${++n}` }));
  mockDeleteAccount.mockResolvedValue(true);
  mockDeleteOrg.mockResolvedValue(true);
});

const longText = (n: number) => `${'word '.repeat(Math.ceil(n / 5))}`.slice(0, n);

describe('saveAccountMemory: guards that must not change', () => {
  it('needs an identity from the session context', async () => {
    await expect(saveAccountMemory({ content: 'x', category: 'insight' }, {})).rejects.toThrow('Authentication required');
    await expect(saveAccountMemory({ content: 'x', category: 'insight' }, undefined)).rejects.toThrow('Authentication required');
  });

  it('takes the identity from agentUserId when userId is absent, and never from an argument', async () => {
    await saveAccountMemory({ content: 'fact', category: 'insight', userId: 'attacker' } as any, { agentUserId: 'agent-u' });
    expect(mockAddAccount).toHaveBeenCalledWith('agent-u', 'insight', 'fact', undefined, EMBEDDING);
  });

  it('refuses when the user switched memory off, and spends nothing', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1', memoryEnabled: false });
    const res = await saveAccountMemory({ content: 'fact', category: 'insight' }, ctx);
    expect(res).toEqual({ success: false, message: 'Memory is disabled for this account.' });
    expect(mockEmbedText).not.toHaveBeenCalled();
    expect(mockAddAccount).not.toHaveBeenCalled();
  });

  it('saves one row with the embedding and the session id, and answers as before', async () => {
    const res = await saveAccountMemory({ content: 'Prefers short emails', category: 'preference' }, ctx);
    expect(mockEmbedText).toHaveBeenCalledWith('Prefers short emails', { userId: 'u1', feature: 'embeddings' });
    expect(mockAddAccount).toHaveBeenCalledWith('u1', 'preference', 'Prefers short emails', 's1', EMBEDDING);
    expect(res).toEqual({ success: true, memoryId: 'm1', message: 'Saved memory: "Prefers short emails"' });
  });

  it('saves a row without an embedding when embedding fails (best effort)', async () => {
    mockEmbedText.mockResolvedValue(null);
    const res = await saveAccountMemory({ content: 'fact', category: 'history' }, ctx);
    expect(mockAddAccount).toHaveBeenCalledWith('u1', 'history', 'fact', 's1', undefined);
    expect(res.success).toBe(true);
  });

  it('splits content over 2,000 characters into several rows and reports every id', async () => {
    const res: any = await saveAccountMemory({ content: longText(2500), category: 'workflow' }, ctx);
    expect(mockAddAccount.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of mockAddAccount.mock.calls) expect(Array.from(call[2]).length).toBeLessThanOrEqual(2000);
    expect(res.success).toBe(true);
    expect(res.memoryIds).toHaveLength(mockAddAccount.mock.calls.length);
    expect(res.memoryId).toBe(res.memoryIds[0]);
    expect(res.message).toMatch(/^Saved memory as \d+ parts \(content exceeded 2000 characters\)/);
  });
});

describe('saveAccountMemory: the defects fixed in W2-1', () => {
  it('refuses an invalid category BEFORE embedding it (the embedding used to be billed first)', async () => {
    await expect(saveAccountMemory({ content: 'fact', category: 'nonsense' }, ctx)).rejects.toThrow(
      'Invalid category: nonsense. Must be one of: preference, history, insight, workflow',
    );
    expect(mockEmbedText).not.toHaveBeenCalled();
    expect(mockAddAccount).not.toHaveBeenCalled();
  });

  it('refuses a missing category the same way', async () => {
    await expect(saveAccountMemory({ content: 'fact' }, ctx)).rejects.toThrow('Invalid category: undefined');
    expect(mockEmbedText).not.toHaveBeenCalled();
  });

  it('refuses whitespace-only content over 2,000 characters instead of answering success with no row', async () => {
    await expect(saveAccountMemory({ content: ' \n\t'.repeat(1000), category: 'insight' }, ctx)).rejects.toThrow('Content is required');
    expect(mockAddAccount).not.toHaveBeenCalled();
  });

  it('refuses short whitespace-only content too', async () => {
    await expect(saveAccountMemory({ content: '   ', category: 'insight' }, ctx)).rejects.toThrow('Content is required');
    expect(mockEmbedText).not.toHaveBeenCalled();
  });

  it.each([[42], [{ text: 'x' }], [['a', 'b']]])(
    'refuses content that is not text (%p) before anything is saved (a throw after saving made a retry save twice)',
    async (content) => {
      await expect(saveAccountMemory({ content, category: 'insight' }, ctx)).rejects.toThrow('Content must be text');
      expect(mockAddAccount).not.toHaveBeenCalled();
    },
  );

  it.each([[null], [undefined]])('answers "Content is required", as the database layer always did, when content is missing (%p)', async (content) => {
    await expect(saveAccountMemory({ content, category: 'insight' }, ctx)).rejects.toThrow('Content is required');
    expect(mockAddAccount).not.toHaveBeenCalled();
  });

  it('refuses content over 8,000 characters with the length in the message (the limit used to live only in the agent-mode schema)', async () => {
    await expect(saveAccountMemory({ content: 'a'.repeat(8001), category: 'insight' }, ctx)).rejects.toThrow(
      /Content must be 8000 characters or less — this content is 8001 characters, 1 over the limit/,
    );
    expect(mockEmbedText).not.toHaveBeenCalled();
    expect(mockAddAccount).not.toHaveBeenCalled();
  });

  it('accepts exactly 8,000 characters', async () => {
    const res: any = await saveAccountMemory({ content: 'a'.repeat(8000), category: 'insight' }, ctx);
    expect(res.success).toBe(true);
    expect(mockAddAccount).toHaveBeenCalledTimes(4);
  });

  it('counts the 8,000 limit in characters, not UTF-16 units (an emoji is one)', async () => {
    const res: any = await saveAccountMemory({ content: '😀'.repeat(8000), category: 'insight' }, ctx);
    expect(res.success).toBe(true);
  });
});

describe('a split that comes back empty (defensive: the argument check makes it unreachable today)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is refused instead of answering success with nothing saved (account)', async () => {
    jest.spyOn(contentLimit, 'splitMemoryContent').mockReturnValueOnce([]);
    await expect(saveAccountMemory({ content: 'a real fact', category: 'insight' }, ctx)).rejects.toThrow('Content is required');
    expect(mockAddAccount).not.toHaveBeenCalled();
  });

  it('is refused instead of answering success with nothing saved (org)', async () => {
    jest.spyOn(contentLimit, 'splitMemoryContent').mockReturnValueOnce([]);
    await expect(saveOrgMemory({ content: 'a real fact', category: 'insight' }, ctx)).rejects.toThrow('Content is required');
    expect(mockAddOrg).not.toHaveBeenCalled();
  });
});

describe('deleteAccountMemory', () => {
  it('needs an identity', async () => {
    await expect(deleteAccountMemory({ memoryId: 'm1' }, {})).rejects.toThrow('Authentication required');
  });

  it('deletes the caller\'s own memory and says so', async () => {
    const res = await deleteAccountMemory({ memoryId: 'm1' }, ctx);
    expect(mockDeleteAccount).toHaveBeenCalledWith('u1', 'm1');
    expect(res).toEqual({ success: true, message: 'Memory m1 deleted.' });
  });

  it('says "not found" when there was no such memory (it used to answer "deleted")', async () => {
    mockDeleteAccount.mockResolvedValue(false);
    const res = await deleteAccountMemory({ memoryId: 'gone' }, ctx);
    expect(res).toEqual({ success: false, message: 'Memory gone was not found; nothing was deleted.' });
  });

  it('treats a delete that returns nothing as deleted (callers that predate the boolean)', async () => {
    mockDeleteAccount.mockResolvedValue(undefined);
    expect((await deleteAccountMemory({ memoryId: 'm1' }, ctx)).success).toBe(true);
  });

  it.each([[undefined], [''], ['   '], [7]])('refuses a bad memoryId (%p) with a clear message', async (memoryId) => {
    await expect(deleteAccountMemory({ memoryId }, ctx)).rejects.toThrow('memoryId is required');
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });
});

describe('saveOrgMemory', () => {
  it('refuses a caller with no org, a missing org and a switched-off org, with the same messages as before', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1' });
    expect(await saveOrgMemory({ content: 'x', category: 'insight' }, ctx)).toEqual({ success: false, message: 'User is not a member of any organization.' });
    mockGetUserById.mockResolvedValue({ userId: 'u1', orgId: 'org1' });
    mockGetOrgById.mockResolvedValue(null);
    expect(await saveOrgMemory({ content: 'x', category: 'insight' }, ctx)).toEqual({ success: false, message: 'Organization not found.' });
    mockGetOrgById.mockResolvedValue({ orgId: 'org1', orgMemoryEnabled: false });
    expect(await saveOrgMemory({ content: 'x', category: 'insight' }, ctx)).toEqual({ success: false, message: 'Organization memory is disabled.' });
    expect(mockEmbedText).not.toHaveBeenCalled();
  });

  it('lets any org member save (no role check) and records the author', async () => {
    const res = await saveOrgMemory({ content: 'Team standup is 9am', category: 'workflow' }, ctx);
    expect(mockAddOrg).toHaveBeenCalledWith('org1', 'workflow', 'Team standup is 9am', 'u1', EMBEDDING);
    expect(res).toEqual({ success: true, memoryId: 'o1', message: 'Saved org memory: "Team standup is 9am"' });
  });

  it('takes the org from the caller\'s own record, never from an argument', async () => {
    await saveOrgMemory({ content: 'x', category: 'insight', orgId: 'other-org' } as any, ctx);
    expect(mockAddOrg.mock.calls[0][0]).toBe('org1');
  });

  it('refuses an invalid category, blank content, non-text content and over-long content before embedding', async () => {
    await expect(saveOrgMemory({ content: 'x', category: 'zzz' }, ctx)).rejects.toThrow('Invalid category: zzz');
    await expect(saveOrgMemory({ content: ' \n'.repeat(1500), category: 'insight' }, ctx)).rejects.toThrow('Content is required');
    await expect(saveOrgMemory({ content: 5 as any, category: 'insight' }, ctx)).rejects.toThrow('Content must be text');
    await expect(saveOrgMemory({ content: 'a'.repeat(8001), category: 'insight' }, ctx)).rejects.toThrow(/8000 characters or less/);
    expect(mockEmbedText).not.toHaveBeenCalled();
    expect(mockAddOrg).not.toHaveBeenCalled();
  });

  it('splits long org content like account content', async () => {
    const res: any = await saveOrgMemory({ content: longText(2500), category: 'insight' }, ctx);
    expect(res.memoryIds.length).toBeGreaterThanOrEqual(2);
    expect(res.message).toMatch(/^Saved org memory as \d+ parts/);
  });
});

describe('deleteOrgMemory', () => {
  it('refuses a plain member and deletes nothing', async () => {
    const res = await deleteOrgMemory({ memoryId: 'o1' }, ctx);
    expect(res).toEqual({ success: false, message: 'Only org owners and admins can delete org memories.' });
    expect(mockDeleteOrg).not.toHaveBeenCalled();
  });

  it('lets an admin delete (org:configure belongs to admins as well as owners)', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1', orgId: 'org1', orgRole: 'admin' });
    const res = await deleteOrgMemory({ memoryId: 'o1' }, ctx);
    expect(mockDeleteOrg).toHaveBeenCalledWith('org1', 'o1');
    expect(res).toEqual({ success: true, message: 'Org memory o1 deleted.' });
  });

  it('lets the org owner delete', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'owner1', orgId: 'org1' });
    expect((await deleteOrgMemory({ memoryId: 'o1' }, { userId: 'owner1' })).success).toBe(true);
  });

  it('acts on the caller\'s own org only: the org id comes from the caller\'s record, never from an argument', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1', orgId: 'org-mine', orgRole: 'admin' });
    mockGetOrgById.mockResolvedValue({ orgId: 'org-mine', ownerUserId: 'x' });
    await deleteOrgMemory({ memoryId: 'o1', orgId: 'org-someone-elses' } as any, ctx);
    expect(mockGetOrgById).toHaveBeenCalledWith('org-mine');
    expect(mockDeleteOrg).toHaveBeenCalledWith('org-mine', 'o1');
  });

  it('says "not found" when there was no such org memory', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1', orgId: 'org1', orgRole: 'admin' });
    mockDeleteOrg.mockResolvedValue(false);
    expect(await deleteOrgMemory({ memoryId: 'gone' }, ctx)).toEqual({ success: false, message: 'Org memory gone was not found; nothing was deleted.' });
  });

  it('refuses a bad memoryId only after the permission check (a member still gets the permission message)', async () => {
    expect(await deleteOrgMemory({ memoryId: '' }, ctx)).toEqual({ success: false, message: 'Only org owners and admins can delete org memories.' });
    mockGetUserById.mockResolvedValue({ userId: 'u1', orgId: 'org1', orgRole: 'admin' });
    await expect(deleteOrgMemory({ memoryId: '' }, ctx)).rejects.toThrow('memoryId is required');
  });
});
