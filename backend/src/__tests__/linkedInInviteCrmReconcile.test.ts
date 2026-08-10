// ENG-787: reconcileSentInvitationsToCrm imports an account's PENDING LinkedIn
// sent-invitations (ENG-182's live cache) into a CRM lead list — the one-way
// backfill/sync that closes the CRM↔LinkedIn attribution gap for historical,
// list_id-less, and dedup-skipped invites.

const getLeadById = jest.fn();
const findLeadByLinkedinInList = jest.fn();
const createLead = jest.fn();
const updateLead = jest.fn();
const addLeadEngagement = jest.fn();
const getLeadListsByUserId = jest.fn();
const getAllSentInvitationsByAccount = jest.fn();
const syncSentInvitationsForAccount = jest.fn();
const cronSyncSentInvitationsForAccount = jest.fn();

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadById: (...a: any[]) => getLeadById(...a),
    findLeadByLinkedinInList: (...a: any[]) => findLeadByLinkedinInList(...a),
    createLead: (...a: any[]) => createLead(...a),
    updateLead: (...a: any[]) => updateLead(...a),
    addLeadEngagement: (...a: any[]) => addLeadEngagement(...a),
    getLeadListsByUserId: (...a: any[]) => getLeadListsByUserId(...a),
  },
}));

jest.mock('../services/unipileSentInvitationsDb', () => ({
  getAllSentInvitationsByAccount: (...a: any[]) => getAllSentInvitationsByAccount(...a),
}));

jest.mock('../cron/linkedInConnectionSyncCron', () => ({
  syncSentInvitationsForAccount: (...a: any[]) => cronSyncSentInvitationsForAccount(...a),
}));

jest.mock('../services/linkedInSentInvitationsSyncService', () => ({
  syncSentInvitationsForAccount: (...a: any[]) => syncSentInvitationsForAccount(...a),
}));

import { reconcileSentInvitationsToCrm, resolveListIdForAccount } from '../services/linkedInInviteCrmMirror';

const ACCOUNT = 'tMgX8uZJTZWTG_mFY1aI2A';
const LIST = 'list_1782945941846_b0ptvsguv';

function invite(publicId: string, name: string, extra: any = {}) {
  return {
    accountId: ACCOUNT,
    invitedUserPublicId: publicId,
    publicProfileUrl: `https://www.linkedin.com/in/${publicId}/`,
    invitationId: `inv_${publicId}`,
    invitedUserName: name,
    invitationText: '',
    sentAt: '2026-07-01T00:00:00.000Z',
    syncedAt: '2026-07-01T00:00:00.000Z',
    ...extra,
  };
}

describe('reconcileSentInvitationsToCrm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findLeadByLinkedinInList.mockResolvedValue(null);
    createLead.mockResolvedValue({ leadId: 'lead_new' });
    updateLead.mockResolvedValue({});
    addLeadEngagement.mockResolvedValue({});
    getLeadById.mockResolvedValue(null);
    syncSentInvitationsForAccount.mockResolvedValue(0);
    cronSyncSentInvitationsForAccount.mockResolvedValue(0);
    getAllSentInvitationsByAccount.mockResolvedValue([]);
    getLeadListsByUserId.mockResolvedValue([]);
  });

  // ---- FAIL / no-op guards ----

  it('returns zeros and touches nothing when accountId or listId is missing', async () => {
    expect(await reconcileSentInvitationsToCrm({ accountId: '', listId: LIST })).toEqual({
      total: 0, created: 0, updated: 0, skipped: 0, alreadyRecorded: 0, matchedInOtherList: 0,
    });
    expect(await reconcileSentInvitationsToCrm({ accountId: ACCOUNT, listId: '' })).toEqual({
      total: 0, created: 0, updated: 0, skipped: 0, alreadyRecorded: 0, matchedInOtherList: 0,
    });
    expect(getAllSentInvitationsByAccount).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
  });

  it('reports zeros when there are no pending invitations', async () => {
    getAllSentInvitationsByAccount.mockResolvedValue([]);
    const res = await reconcileSentInvitationsToCrm({ accountId: ACCOUNT, listId: LIST });
    expect(res).toEqual({ total: 0, created: 0, updated: 0, skipped: 0, alreadyRecorded: 0, matchedInOtherList: 0 });
  });

  it('does not abort the batch when one invite fails to mirror', async () => {
    getAllSentInvitationsByAccount.mockResolvedValue([
      invite('alice', 'Alice A.'),
      invite('bob', 'Bob B.'),
    ]);
    // First createLead throws, second succeeds.
    createLead
      .mockRejectedValueOnce(new Error('dynamo blip'))
      .mockResolvedValueOnce({ leadId: 'lead_bob' });
    const res = await reconcileSentInvitationsToCrm({ accountId: ACCOUNT, listId: LIST, refreshFromLive: false });
    expect(res.total).toBe(2);
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(1);
  });

  // ---- SUCCESS ----

  it('creates absent leads, updates existing ones, and counts skips', async () => {
    getAllSentInvitationsByAccount.mockResolvedValue([
      invite('new-person', 'New Person'),  // absent → created
      invite('existing', 'Existing Lead'), // present in list → updated
      invite('', 'No Id'),                 // no /in/ URL keyable → skipped
    ]);
    // 'existing' already lives in the target list.
    findLeadByLinkedinInList.mockImplementation(async (_listId: string, url: string) =>
      url.includes('/in/existing')
        ? { leadId: 'lead_existing', listId: LIST, status: 'new' }
        : null,
    );

    const res = await reconcileSentInvitationsToCrm({ accountId: ACCOUNT, listId: LIST, refreshFromLive: false });

    expect(res.total).toBe(3);
    expect(res.created).toBe(1);
    expect(res.updated).toBe(1);
    expect(res.skipped).toBe(1);
    // engagement logged for the two keyable invites
    expect(addLeadEngagement).toHaveBeenCalledTimes(2);
  });

  it('splits the invited display name into first/last on newly-created leads', async () => {
    getAllSentInvitationsByAccount.mockResolvedValue([invite('bala-s', 'Bala S.')]);
    await reconcileSentInvitationsToCrm({ accountId: ACCOUNT, listId: LIST, refreshFromLive: false });
    expect(createLead).toHaveBeenCalledWith(
      LIST,
      expect.objectContaining({ firstName: 'Bala', lastName: 'S.', status: 'contacted' }),
    );
  });

  it('ENG-876: refreshes through the lean sync service before reconciling', async () => {
    getAllSentInvitationsByAccount.mockResolvedValue([]);

    await reconcileSentInvitationsToCrm({ accountId: ACCOUNT, listId: LIST });
    expect(syncSentInvitationsForAccount).toHaveBeenCalledWith(ACCOUNT);

    syncSentInvitationsForAccount.mockClear();
    await reconcileSentInvitationsToCrm({ accountId: ACCOUNT, listId: LIST, refreshFromLive: false });
    expect(syncSentInvitationsForAccount).not.toHaveBeenCalled();
  });

  it('ENG-876: does not reach through the cron import graph for a live refresh', async () => {
    getAllSentInvitationsByAccount.mockResolvedValue([]);

    await reconcileSentInvitationsToCrm({ accountId: ACCOUNT, listId: LIST });
    expect(cronSyncSentInvitationsForAccount).not.toHaveBeenCalled();
  });

  it('ENG-876: reports cache provenance and the newest cached timestamp after refresh failure', async () => {
    syncSentInvitationsForAccount.mockRejectedValue(new Error('unipile down'));
    cronSyncSentInvitationsForAccount.mockRejectedValue(new Error('unipile down'));
    getAllSentInvitationsByAccount.mockResolvedValue([
      invite('older', 'Older Cache', { syncedAt: '2026-07-01T00:00:00.000Z' }),
      invite('newer', 'Newer Cache', { syncedAt: '2026-08-03T14:58:58.000Z' }),
    ]);

    const res = await reconcileSentInvitationsToCrm({ accountId: ACCOUNT, listId: LIST, dryRun: true });
    expect(res).toEqual(expect.objectContaining({
      liveRefreshFailed: true,
      newestCachedSyncedAt: '2026-08-03T14:58:58.000Z',
    }));
  });

  it('ENG-876 characterization: dry-run still performs no CRM writes', async () => {
    getAllSentInvitationsByAccount.mockResolvedValue([invite('new-person', 'New Person')]);

    await reconcileSentInvitationsToCrm({
      accountId: ACCOUNT, listId: LIST, refreshFromLive: false, dryRun: true,
    });

    expect(createLead).not.toHaveBeenCalled();
    expect(updateLead).not.toHaveBeenCalled();
    expect(addLeadEngagement).not.toHaveBeenCalled();
  });

  it('dry-run computes created/updated counts but writes nothing', async () => {
    getAllSentInvitationsByAccount.mockResolvedValue([
      invite('new-person', 'New Person'),  // absent → would create
      invite('existing', 'Existing Lead'), // present → would update
    ]);
    findLeadByLinkedinInList.mockImplementation(async (_listId: string, url: string) =>
      url.includes('/in/existing')
        ? { leadId: 'lead_existing', listId: LIST, status: 'new' }
        : null,
    );

    const res = await reconcileSentInvitationsToCrm({
      accountId: ACCOUNT, listId: LIST, refreshFromLive: false, dryRun: true,
    });

    expect(res).toEqual({ total: 2, created: 1, updated: 1, skipped: 0, alreadyRecorded: 0, matchedInOtherList: 0 });
    // No writes whatsoever.
    expect(createLead).not.toHaveBeenCalled();
    expect(updateLead).not.toHaveBeenCalled();
    expect(addLeadEngagement).not.toHaveBeenCalled();
  });

  it('is re-runnable: a second pass over the same backlog logs no duplicate engagements', async () => {
    // The script is documented as a repeatable backstop, so a repeat run must not
    // re-append linkedin.invite.sent to every already-mirrored lead (ENG-787).
    const pending = invite('existing', 'Existing Lead');
    getAllSentInvitationsByAccount.mockResolvedValue([pending]);
    findLeadByLinkedinInList.mockResolvedValue({
      leadId: 'lead_existing',
      listId: LIST,
      status: 'contacted',
      engagements: [{
        eventType: 'linkedin.invite.sent',
        createdAt: pending.sentAt,
        // A prior reconcile pass records the invitation id (the pending cache is
        // keyed by it), so a re-run matches by id and skips re-appending.
        eventData: { note: '', accountId: ACCOUNT, linkedin: 'https://www.linkedin.com/in/existing', invitationId: pending.invitationId },
      }],
    });

    const res = await reconcileSentInvitationsToCrm({ accountId: ACCOUNT, listId: LIST, refreshFromLive: false });

    expect(res).toEqual({ total: 1, created: 0, updated: 1, skipped: 0, alreadyRecorded: 1, matchedInOtherList: 0 });
    expect(addLeadEngagement).not.toHaveBeenCalled();
  });

  it('still reconciles from cache when the live refresh throws', async () => {
    syncSentInvitationsForAccount.mockRejectedValue(new Error('unipile down'));
    getAllSentInvitationsByAccount.mockResolvedValue([invite('carol', 'Carol C.')]);
    const res = await reconcileSentInvitationsToCrm({ accountId: ACCOUNT, listId: LIST });
    expect(res.total).toBe(1);
    expect(res.created).toBe(1);
  });
  it('attributes an invitee already tracked in another of the owner lists to that list', async () => {
    // One LinkedIn account often drives outreach for several lists; a blind backfill
    // into the supplied list would duplicate people the CRM already tracks elsewhere.
    const OTHER = 'list_other';
    getLeadListsByUserId.mockResolvedValue([{ listId: LIST }, { listId: OTHER }]);
    getAllSentInvitationsByAccount.mockResolvedValue([invite('elsewhere', 'Else Where')]);
    findLeadByLinkedinInList.mockImplementation(async (listId: string) =>
      listId === OTHER ? { leadId: 'lead_elsewhere', listId: OTHER, status: 'new' } : null,
    );

    const res = await reconcileSentInvitationsToCrm({
      accountId: ACCOUNT, listId: LIST, userId: 'user_1', refreshFromLive: false,
    });

    expect(res.created).toBe(0);
    expect(res.updated).toBe(1);
    expect(res.matchedInOtherList).toBe(1);
    expect(createLead).not.toHaveBeenCalled();
    expect(addLeadEngagement).toHaveBeenCalledWith(OTHER, 'lead_elsewhere', expect.anything(), expect.anything());
  });

  it('reconciles into the target list only when searchOwnerLists is disabled', async () => {
    getLeadListsByUserId.mockResolvedValue([{ listId: LIST }, { listId: 'list_other' }]);
    getAllSentInvitationsByAccount.mockResolvedValue([invite('elsewhere', 'Else Where')]);
    findLeadByLinkedinInList.mockResolvedValue(null);

    await reconcileSentInvitationsToCrm({
      accountId: ACCOUNT, listId: LIST, userId: 'user_1', refreshFromLive: false, searchOwnerLists: false,
    });

    expect(getLeadListsByUserId).not.toHaveBeenCalled();
    expect(createLead).toHaveBeenCalledWith(LIST, expect.anything());
  });

  it('still reconciles when the owner list lookup fails', async () => {
    getLeadListsByUserId.mockRejectedValue(new Error('dynamo down'));
    getAllSentInvitationsByAccount.mockResolvedValue([invite('carol', 'Carol C.')]);
    const res = await reconcileSentInvitationsToCrm({
      accountId: ACCOUNT, listId: LIST, userId: 'user_1', refreshFromLive: false,
    });
    expect(res.created).toBe(1);
  });
});

describe('resolveListIdForAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getLeadListsByUserId.mockResolvedValue([]);
  });

  it('returns null without a userId or accountId', async () => {
    expect(await resolveListIdForAccount('', 'acct')).toBeNull();
    expect(await resolveListIdForAccount('user_1', '')).toBeNull();
    expect(getLeadListsByUserId).not.toHaveBeenCalled();
  });

  it('returns null when no list is bound to the account', async () => {
    getLeadListsByUserId.mockResolvedValue([{ listId: 'a' }, { listId: 'b', linkedInAccountId: 'other' }]);
    expect(await resolveListIdForAccount('user_1', ACCOUNT)).toBeNull();
  });

  it('returns null when several lists are bound — guessing would mis-attribute', async () => {
    getLeadListsByUserId.mockResolvedValue([
      { listId: 'a', linkedInAccountId: ACCOUNT },
      { listId: 'b', linkedInAccountId: ACCOUNT },
    ]);
    expect(await resolveListIdForAccount('user_1', ACCOUNT)).toBeNull();
  });

  it('returns null when the lookup fails rather than throwing into the send path', async () => {
    getLeadListsByUserId.mockRejectedValue(new Error('dynamo down'));
    expect(await resolveListIdForAccount('user_1', ACCOUNT)).toBeNull();
  });

  it('resolves the single list bound to the account', async () => {
    getLeadListsByUserId.mockResolvedValue([
      { listId: 'unbound' },
      { listId: 'bound', linkedInAccountId: ACCOUNT },
      { listId: 'other', linkedInAccountId: 'acct_2' },
    ]);
    expect(await resolveListIdForAccount('user_1', ACCOUNT)).toBe('bound');
  });
});
