// ENG-787: reconcileSentInvitationsToCrm imports an account's PENDING LinkedIn
// sent-invitations (ENG-182's live cache) into a CRM lead list — the one-way
// backfill/sync that closes the CRM↔LinkedIn attribution gap for historical,
// list_id-less, and dedup-skipped invites.

const getLeadById = jest.fn();
const findLeadsByLinkedin = jest.fn();
const createLead = jest.fn();
const updateLead = jest.fn();
const addLeadEngagement = jest.fn();
const getAllSentInvitationsByAccount = jest.fn();
const syncSentInvitationsForAccount = jest.fn();

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadById: (...a: any[]) => getLeadById(...a),
    findLeadsByLinkedin: (...a: any[]) => findLeadsByLinkedin(...a),
    createLead: (...a: any[]) => createLead(...a),
    updateLead: (...a: any[]) => updateLead(...a),
    addLeadEngagement: (...a: any[]) => addLeadEngagement(...a),
  },
}));

jest.mock('../services/unipileSentInvitationsDb', () => ({
  getAllSentInvitationsByAccount: (...a: any[]) => getAllSentInvitationsByAccount(...a),
}));

jest.mock('../cron/linkedInConnectionSyncCron', () => ({
  syncSentInvitationsForAccount: (...a: any[]) => syncSentInvitationsForAccount(...a),
}));

import { reconcileSentInvitationsToCrm } from '../services/linkedInInviteCrmMirror';

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
    findLeadsByLinkedin.mockResolvedValue([]);
    createLead.mockResolvedValue({ leadId: 'lead_new' });
    updateLead.mockResolvedValue({});
    addLeadEngagement.mockResolvedValue({});
    getLeadById.mockResolvedValue(null);
    syncSentInvitationsForAccount.mockResolvedValue(0);
    getAllSentInvitationsByAccount.mockResolvedValue([]);
  });

  // ---- FAIL / no-op guards ----

  it('returns zeros and touches nothing when accountId or listId is missing', async () => {
    expect(await reconcileSentInvitationsToCrm({ accountId: '', listId: LIST })).toEqual({
      total: 0, created: 0, updated: 0, skipped: 0,
    });
    expect(await reconcileSentInvitationsToCrm({ accountId: ACCOUNT, listId: '' })).toEqual({
      total: 0, created: 0, updated: 0, skipped: 0,
    });
    expect(getAllSentInvitationsByAccount).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
  });

  it('reports zeros when there are no pending invitations', async () => {
    getAllSentInvitationsByAccount.mockResolvedValue([]);
    const res = await reconcileSentInvitationsToCrm({ accountId: ACCOUNT, listId: LIST });
    expect(res).toEqual({ total: 0, created: 0, updated: 0, skipped: 0 });
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
    findLeadsByLinkedin.mockImplementation(async (url: string) =>
      url.includes('/in/existing')
        ? [{ leadId: 'lead_existing', listId: LIST, status: 'new' }]
        : [],
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

  it('refreshes the live cache before reconciling by default, and skips the refresh when disabled', async () => {
    getAllSentInvitationsByAccount.mockResolvedValue([]);

    await reconcileSentInvitationsToCrm({ accountId: ACCOUNT, listId: LIST });
    expect(syncSentInvitationsForAccount).toHaveBeenCalledWith(ACCOUNT);

    syncSentInvitationsForAccount.mockClear();
    await reconcileSentInvitationsToCrm({ accountId: ACCOUNT, listId: LIST, refreshFromLive: false });
    expect(syncSentInvitationsForAccount).not.toHaveBeenCalled();
  });

  it('dry-run computes created/updated counts but writes nothing', async () => {
    getAllSentInvitationsByAccount.mockResolvedValue([
      invite('new-person', 'New Person'),  // absent → would create
      invite('existing', 'Existing Lead'), // present → would update
    ]);
    findLeadsByLinkedin.mockImplementation(async (url: string) =>
      url.includes('/in/existing')
        ? [{ leadId: 'lead_existing', listId: LIST, status: 'new' }]
        : [],
    );

    const res = await reconcileSentInvitationsToCrm({
      accountId: ACCOUNT, listId: LIST, refreshFromLive: false, dryRun: true,
    });

    expect(res).toEqual({ total: 2, created: 1, updated: 1, skipped: 0 });
    // No writes whatsoever.
    expect(createLead).not.toHaveBeenCalled();
    expect(updateLead).not.toHaveBeenCalled();
    expect(addLeadEngagement).not.toHaveBeenCalled();
  });

  it('still reconciles from cache when the live refresh throws', async () => {
    syncSentInvitationsForAccount.mockRejectedValue(new Error('unipile down'));
    getAllSentInvitationsByAccount.mockResolvedValue([invite('carol', 'Carol C.')]);
    const res = await reconcileSentInvitationsToCrm({ accountId: ACCOUNT, listId: LIST });
    expect(res.total).toBe(1);
    expect(res.created).toBe(1);
  });
});
