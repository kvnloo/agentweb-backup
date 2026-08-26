/**
 * leadRecovery — unit tests for the extracted ENG-969 follow-up cross-list
 * recovery (CodeRabbit finding on PR #2611: this logic previously lived
 * inline in agentModeService.ts, growing the monolith the repo's
 * subtraction-biased restructure policy asks to shrink).
 *
 * Covers the same scenarios as the getLeadDetails integration tests in
 * agentModeService.crmTools.test.ts, but exercises the pure function
 * directly against a minimal fake db, with no jest.mock('../../services/db').
 */

import { recoverLeadFromWrongList } from '../leadRecovery';

function fakeDb(overrides: Partial<{
  getLeadListsByUserId: jest.Mock;
  getLeadListsForUser: jest.Mock;
  getLeadByIdAcrossLists: jest.Mock;
}> = {}) {
  return {
    getLeadListsByUserId: jest.fn().mockResolvedValue([]),
    getLeadListsForUser: jest.fn().mockResolvedValue([]),
    getLeadByIdAcrossLists: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('recoverLeadFromWrongList', () => {
  const userId = 'user-1';
  const requestedListId = 'list-requested';
  const leadId = 'lead-1';

  it('resolves via tier 1 (own lists) without ever calling the org-wide fan-out', async () => {
    const otherListId = 'list-own-other';
    const found = { listId: otherListId, leadId };
    const db = fakeDb({
      getLeadListsByUserId: jest.fn().mockResolvedValue([{ listId: requestedListId }, { listId: otherListId }]),
      getLeadByIdAcrossLists: jest.fn().mockResolvedValue(found),
    });

    const result = await recoverLeadFromWrongList(db, userId, requestedListId, leadId);

    expect(result).toBe(found);
    expect(db.getLeadByIdAcrossLists).toHaveBeenCalledWith([otherListId], leadId);
    expect(db.getLeadListsForUser).not.toHaveBeenCalled();
  });

  it('falls back to tier 2 (org-wide) when the lead is not in any of the caller\'s own lists', async () => {
    const peerListId = 'list-peer';
    const found = { listId: peerListId, leadId };
    const db = fakeDb({
      getLeadListsByUserId: jest.fn().mockResolvedValue([{ listId: requestedListId }]),
      getLeadListsForUser: jest.fn().mockResolvedValue([{ listId: requestedListId }, { listId: peerListId }]),
      getLeadByIdAcrossLists: jest.fn()
        .mockResolvedValueOnce(null) // tier 1 miss
        .mockResolvedValueOnce(found), // tier 2 hit
    });

    const result = await recoverLeadFromWrongList(db, userId, requestedListId, leadId);

    expect(result).toBe(found);
    expect(db.getLeadByIdAcrossLists).toHaveBeenNthCalledWith(1, [], leadId);
    expect(db.getLeadByIdAcrossLists).toHaveBeenNthCalledWith(2, [peerListId], leadId);
  });

  it('returns null when the lead is not in any accessible list', async () => {
    const db = fakeDb();

    const result = await recoverLeadFromWrongList(db, userId, requestedListId, leadId);

    expect(result).toBeNull();
  });

  it('retries the whole recovery once after a throttle, and returns the result if the retry succeeds', async () => {
    const found = { listId: 'list-recovered', leadId };
    let call = 0;
    const db = fakeDb({
      getLeadListsByUserId: jest.fn().mockImplementation(() => {
        call += 1;
        if (call === 1) return Promise.reject(new Error('ProvisionedThroughputExceededException'));
        return Promise.resolve([{ listId: 'list-recovered' }]);
      }),
      getLeadByIdAcrossLists: jest.fn().mockResolvedValue(found),
    });

    const result = await recoverLeadFromWrongList(db, userId, requestedListId, leadId);

    expect(result).toBe(found);
    expect(db.getLeadListsByUserId).toHaveBeenCalledTimes(2);
  });

  it('gives up and returns null when the recovery fails on both attempts (never throws)', async () => {
    const db = fakeDb({
      getLeadListsByUserId: jest.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException')),
    });

    const result = await recoverLeadFromWrongList(db, userId, requestedListId, leadId);

    expect(result).toBeNull();
    expect(db.getLeadListsByUserId).toHaveBeenCalledTimes(2);
  });
});
