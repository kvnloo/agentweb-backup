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

describe('the optional write gate (ENG-2840 W2-2: the MCP tools add their cap and duplicate check through it)', () => {
  const gateAnswer = { success: true, saved: false, duplicate: true, memoryId: 'existing' };

  it('is called after the guards and the argument check with what a gate needs, and a returned answer replaces the write and the embedding', async () => {
    const gate = jest.fn().mockResolvedValue(gateAnswer);
    const out = await saveAccountMemory({ content: 'a fact', category: 'insight' }, ctx, gate);
    expect(out).toEqual(gateAnswer);
    expect(gate).toHaveBeenCalledWith({ scope: 'user', ownerId: 'u1', content: 'a fact', category: 'insight', chunkCount: 1, callerCanDelete: true });
    expect(mockEmbedText).not.toHaveBeenCalled();
    expect(mockAddAccount).not.toHaveBeenCalled();
  });

  it('a gate that returns nothing lets the save go on exactly as without a gate', async () => {
    const gate = jest.fn().mockResolvedValue(undefined);
    const out = await saveAccountMemory({ content: 'a fact', category: 'insight' }, ctx, gate);
    expect(out).toMatchObject({ success: true, memoryId: 'm1' });
    expect(mockAddAccount).toHaveBeenCalledWith('u1', 'insight', 'a fact', 's1', EMBEDDING);
  });

  it('is told how many rows the save needs (a split save)', async () => {
    const gate = jest.fn().mockResolvedValue(undefined);
    await saveAccountMemory({ content: longText(2500), category: 'insight' }, ctx, gate);
    expect(gate.mock.calls[0][0].chunkCount).toBeGreaterThan(1);
    expect(mockAddAccount.mock.calls.length).toBe(gate.mock.calls[0][0].chunkCount);
  });

  it('is NOT reached when memory is off or the arguments are bad (the shared checks come first, in the same order)', async () => {
    const gate = jest.fn();
    mockGetUserById.mockResolvedValue({ userId: 'u1', memoryEnabled: false });
    expect(await saveAccountMemory({ content: 'x', category: 'insight' }, ctx, gate)).toMatchObject({ success: false });
    mockGetUserById.mockResolvedValue({ userId: 'u1' });
    await expect(saveAccountMemory({ content: 'x', category: 'nope' }, ctx, gate)).rejects.toThrow(/Invalid category/);
    await expect(saveAccountMemory({ content: '  ', category: 'insight' }, ctx, gate)).rejects.toThrow(/Content is required/);
    expect(gate).not.toHaveBeenCalled();
  });

  it('org: owner id is the caller\'s org, and the org refusals come before the gate', async () => {
    const gate = jest.fn().mockResolvedValue(undefined);
    await saveOrgMemory({ content: 'org fact', category: 'workflow' }, ctx, gate);
    expect(gate).toHaveBeenCalledWith({ scope: 'org', ownerId: 'org1', content: 'org fact', category: 'workflow', chunkCount: 1, callerCanDelete: false });
    expect(mockAddOrg).toHaveBeenCalledWith('org1', 'workflow', 'org fact', 'u1', EMBEDDING);
    const refused = jest.fn();
    mockGetUserById.mockResolvedValue({ userId: 'u1' });
    expect(await saveOrgMemory({ content: 'x', category: 'insight' }, ctx, refused)).toMatchObject({ success: false });
    mockGetUserById.mockResolvedValue({ userId: 'u1', orgId: 'org1' });
    mockGetOrgById.mockResolvedValue({ orgId: 'org1', orgMemoryEnabled: false });
    expect(await saveOrgMemory({ content: 'x', category: 'insight' }, ctx, refused)).toMatchObject({ success: false });
    expect(refused).not.toHaveBeenCalled();
  });

  it('a gate answer replaces the org write too, and a throwing gate stops the save before anything is embedded', async () => {
    expect(await saveOrgMemory({ content: 'x', category: 'insight' }, ctx, async () => gateAnswer)).toEqual(gateAnswer);
    expect(mockAddOrg).not.toHaveBeenCalled();
    await expect(saveAccountMemory({ content: 'x', category: 'insight' }, ctx, async () => { throw new Error('gate failed'); })).rejects.toThrow('gate failed');
    expect(mockEmbedText).not.toHaveBeenCalled();
    expect(mockAddAccount).not.toHaveBeenCalled();
  });

  it('Emma\'s own call (no gate) is unchanged', async () => {
    expect(await saveAccountMemory({ content: 'a fact', category: 'insight' }, ctx)).toMatchObject({ success: true, memoryId: 'm1' });
  });
});

describe('embedTimeoutMs: a hung embedding does not hold a save forever (ENG-2840 W2-2, second review)', () => {
  const hung = () => new Promise<never>(() => {});

  it('with the option, a hung embedding is given up on and the row is saved without one', async () => {
    mockEmbedText.mockReturnValue(hung());
    const out = await saveAccountMemory({ content: 'a fact', category: 'insight' }, ctx, undefined, { embedTimeoutMs: 20 });
    expect(out).toMatchObject({ success: true });
    expect(mockAddAccount).toHaveBeenCalledWith('u1', 'insight', 'a fact', 's1', undefined);
  });

  it('the same for the org save', async () => {
    mockEmbedText.mockReturnValue(hung());
    expect(await saveOrgMemory({ content: 'org fact', category: 'insight' }, ctx, undefined, { embedTimeoutMs: 20 })).toMatchObject({ success: true });
    expect(mockAddOrg).toHaveBeenCalledWith('org1', 'insight', 'org fact', 'u1', undefined);
  });

  it('an embedding that arrives in time is used, with the option set', async () => {
    mockEmbedText.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(EMBEDDING), 5)));
    await saveAccountMemory({ content: 'a fact', category: 'insight' }, ctx, undefined, { embedTimeoutMs: 500 });
    expect(mockAddAccount).toHaveBeenCalledWith('u1', 'insight', 'a fact', 's1', EMBEDDING);
  });

  it('without the option nothing changes: Emma\'s own call waits for the embedding as before', async () => {
    mockEmbedText.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(EMBEDDING), 40)));
    await saveAccountMemory({ content: 'a fact', category: 'insight' }, ctx);
    expect(mockAddAccount).toHaveBeenCalledWith('u1', 'insight', 'a fact', 's1', EMBEDDING);
  });

  it('the timer is cleared when the embedding arrives in time (nothing is left to keep the process waiting)', async () => {
    jest.useFakeTimers();
    try {
      mockEmbedText.mockResolvedValue(EMBEDDING);
      await saveAccountMemory({ content: 'a fact', category: 'insight' }, ctx, undefined, { embedTimeoutMs: 60_000 });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('ONE deadline per save: after the first timeout the remaining parts are saved without asking for an embedding or waiting again', async () => {
    // Fake timers, so the proof is not a wall-clock margin: the clock is advanced past ONE deadline only. A save that waited again for a
    // second part would still be pending afterwards (no timer would fire for it) and `await save` would never return.
    jest.useFakeTimers();
    try {
      mockEmbedText.mockReturnValue(hung());
      const save = saveAccountMemory({ content: longText(7000), category: 'insight' }, ctx, undefined, { embedTimeoutMs: 60 });
      await jest.advanceTimersByTimeAsync(61);
      const out = await save;
      expect(out).toMatchObject({ success: true, memoryIds: expect.any(Array) });
      expect(mockAddAccount.mock.calls.length).toBeGreaterThan(2); // a text of 7,000 characters is at least four parts
      expect(mockAddAccount.mock.calls.every((c) => c[4] === undefined)).toBe(true);
      expect(mockEmbedText).toHaveBeenCalledTimes(1); // not once per part
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a part whose embedding arrives in time is embedded; the first part that times out ends the asking', async () => {
    mockEmbedText.mockResolvedValueOnce(EMBEDDING).mockReturnValueOnce(hung());
    await saveAccountMemory({ content: longText(7000), category: 'insight' }, ctx, undefined, { embedTimeoutMs: 30 });
    expect(mockEmbedText).toHaveBeenCalledTimes(2);
    const embeddings = mockAddAccount.mock.calls.map((c) => c[4]);
    expect(embeddings[0]).toEqual(EMBEDDING);
    expect(embeddings.slice(1).every((e) => e === undefined)).toBe(true);
  });

  it.each([[0], [-5], [NaN], [Infinity], [-Infinity]])('a timeout of %p means no bound: a slow embedding is waited for and used, not dropped', async (ms) => {
    mockEmbedText.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(EMBEDDING), 40)));
    await saveAccountMemory({ content: 'a fact', category: 'insight' }, ctx, undefined, { embedTimeoutMs: ms });
    expect(mockAddAccount).toHaveBeenCalledWith('u1', 'insight', 'a fact', 's1', EMBEDDING);
  });

  it('a timeout above the timer limit is held to it instead of firing at once', async () => {
    mockEmbedText.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(EMBEDDING), 30)));
    await saveAccountMemory({ content: 'a fact', category: 'insight' }, ctx, undefined, { embedTimeoutMs: 2 ** 31 });
    expect(mockAddAccount).toHaveBeenCalledWith('u1', 'insight', 'a fact', 's1', EMBEDDING);
  });

  it('an abandoned embedding that fails later does not become an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const listener = (reason: unknown) => { seen.push(reason); };
    process.on('unhandledRejection', listener);
    try {
      mockEmbedText.mockImplementation(() => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('late failure')), 40)));
      await saveAccountMemory({ content: 'a fact', category: 'insight' }, ctx, undefined, { embedTimeoutMs: 10 });
      await new Promise((r) => setTimeout(r, 90));
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});

describe('a split save that fails part-way removes the parts it already wrote (so a retry does not duplicate them)', () => {
  it('account: the second write fails, the first part is removed from the caller\'s own account, and the original error comes out', async () => {
    mockAddAccount.mockReset();
    mockAddAccount.mockResolvedValueOnce({ memoryId: 'part-1' }).mockRejectedValueOnce(new Error('write failed'));
    await expect(saveAccountMemory({ content: longText(2500), category: 'insight' }, ctx)).rejects.toThrow('write failed');
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
    expect(mockDeleteAccount).toHaveBeenCalledWith('u1', 'part-1');
  });

  it('org: the same, against the org\'s table', async () => {
    mockAddOrg.mockReset();
    mockAddOrg.mockResolvedValueOnce({ memoryId: 'org-part-1' }).mockRejectedValueOnce(new Error('write failed'));
    await expect(saveOrgMemory({ content: longText(2500), category: 'insight' }, ctx)).rejects.toThrow('write failed');
    expect(mockDeleteOrg).toHaveBeenCalledWith('org1', 'org-part-1');
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it('defensive: a throw from the embedding step after the first part (embedText catches everything today) is cleaned up the same way', async () => {
    mockEmbedText.mockResolvedValueOnce(EMBEDDING).mockRejectedValueOnce(new Error('embedding service down'));
    await expect(saveAccountMemory({ content: longText(2500), category: 'insight' }, ctx)).rejects.toThrow('embedding service down');
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
  });

  it('a part that could not be removed is logged by id and does not hide the original error', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockAddAccount.mockReset();
    mockAddAccount.mockResolvedValueOnce({ memoryId: 'part-1' }).mockRejectedValueOnce(new Error('write failed'));
    mockDeleteAccount.mockRejectedValueOnce(new Error('delete failed too'));
    await expect(saveAccountMemory({ content: longText(2500), category: 'insight' }, ctx)).rejects.toThrow('write failed');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/1 could not be removed again: part-1/);
    warn.mockRestore();
  });

  it('the cleanup is finished BEFORE the error comes out (a retry cannot start while a removal is still pending)', async () => {
    mockAddAccount.mockReset();
    mockAddAccount.mockResolvedValueOnce({ memoryId: 'part-1' }).mockRejectedValueOnce(new Error('write failed'));
    let removed = false;
    mockDeleteAccount.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => { removed = true; resolve(true); }, 40)));
    await expect(saveAccountMemory({ content: longText(2500), category: 'insight' }, ctx)).rejects.toThrow('write failed');
    expect(removed).toBe(true);
  });

  it('a failure on the FIRST part removes nothing, and a save that succeeds removes nothing', async () => {
    mockAddAccount.mockReset();
    mockAddAccount.mockRejectedValueOnce(new Error('first write failed'));
    await expect(saveAccountMemory({ content: longText(2500), category: 'insight' }, ctx)).rejects.toThrow('first write failed');
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    mockAddAccount.mockReset();
    mockAddAccount.mockResolvedValue({ memoryId: 'ok' });
    await saveAccountMemory({ content: longText(2500), category: 'insight' }, ctx);
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });
});

describe('the gate is told whether the caller can delete (so a refusal can say who can make room)', () => {
  const asRole = (orgRole: string) => mockGetUserById.mockResolvedValue({ userId: 'u1', orgId: 'org1', orgRole });

  it.each([['member', false], ['admin', true], ['owner', true]])('org save by a %s: callerCanDelete is %s', async (role, expected) => {
    asRole(role);
    const gate = jest.fn().mockResolvedValue(undefined);
    await saveOrgMemory({ content: 'x', category: 'insight' }, ctx, gate);
    expect(gate.mock.calls[0][0].callerCanDelete).toBe(expected);
  });

  it('a user\'s own memory can always be deleted by them', async () => {
    const gate = jest.fn().mockResolvedValue(undefined);
    await saveAccountMemory({ content: 'x', category: 'insight' }, ctx, gate);
    expect(gate.mock.calls[0][0].callerCanDelete).toBe(true);
  });
});

