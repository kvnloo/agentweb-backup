/**
 * ENG-787: the sync cron mirrors pending invitations into the CRM on every run.
 *
 * A pending invitation is the only window in which an invite is recoverable —
 * acceptance drops it from Unipile's feed and the prune deletes it — so these tests
 * pin both that the window is used and that it is fenced: muted by default, never
 * for an ownerless (site-wide) account, and never able to break the sync.
 */

jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: jest.fn() } },
})));

jest.mock('../services/agentModeService', () => ({
  agentModeService: { readBrandGuidelines: jest.fn(), readMarketStrategy: jest.fn() },
}));

const mockListConnections = jest.fn();
const mockListSentInvitations = jest.fn();
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    listConnections: (...a: any[]) => mockListConnections(...a),
    listSentInvitations: (...a: any[]) => mockListSentInvitations(...a),
  },
}));

jest.mock('../services/unipileConnectionsDb', () => ({
  upsertConnections: jest.fn().mockResolvedValue(undefined),
  getLatestConnectedAt: jest.fn().mockResolvedValue(0),
  getFullSyncCompletedAt: jest.fn().mockResolvedValue('2026-01-01T00:00:00.000Z'),
  markFullSyncCompleted: jest.fn().mockResolvedValue(undefined),
  normalizeLinkedInUrl: (url: string) => (url || '').trim().toLowerCase(),
}));

jest.mock('../services/unipileSentInvitationsDb', () => ({
  upsertSentInvitations: jest.fn().mockResolvedValue(undefined),
  pruneStaleSentInvitations: jest.fn().mockResolvedValue(0),
  getAllSentInvitationsByAccount: jest.fn().mockResolvedValue([]),
  profileUrlFromPublicId: (id: string) => `https://www.linkedin.com/in/${id}/`,
}));

const mockResolveListIdForAccount = jest.fn();
const mockReconcileSentInvitationsToCrm = jest.fn();
jest.mock('../services/linkedInInviteCrmMirror', () => ({
  resolveListIdForAccount: (...a: any[]) => mockResolveListIdForAccount(...a),
  reconcileSentInvitationsToCrm: (...a: any[]) => mockReconcileSentInvitationsToCrm(...a),
}));

const mockGetSetting = jest.fn();
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: (...a: any[]) => mockGetSetting(...a) },
}));

const mockGetAllUsers = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: {},
  userDb: { getAllUsers: (...a: any[]) => mockGetAllUsers(...a) },
}));

jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: { getAllSequencesByTriggerType: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: {} }));

import { runLinkedInConnectionSync, __resetWalkPacingForTests } from '../cron/linkedInConnectionSyncCron';

const ACCOUNT = 'tMgX8uZJTZWTG_mFY1aI2A';
const OWNER = 'user_1';
const LIST = 'list_1782945941846_b0ptvsguv';

const OK = { total: 3, created: 1, updated: 2, skipped: 0, alreadyRecorded: 2, matchedInOtherList: 0 };

describe('sync cron → invite CRM reconciliation', () => {
  const originalFlag = process.env.LINKEDIN_INVITE_CRM_RECONCILE;

  beforeEach(() => {
  // ENG-1197: the cron paces its full walk per account in module state.
  __resetWalkPacingForTests();
    jest.clearAllMocks();
    process.env.LINKEDIN_INVITE_CRM_RECONCILE = 'true';
    // One per-user Unipile account, no site-wide accounts.
    mockGetSetting.mockResolvedValue(null);
    mockGetAllUsers.mockResolvedValue([
      { userId: OWNER, connected_accounts: [{ platform: 'unipile', account_id: ACCOUNT }] },
    ]);
    mockListConnections.mockResolvedValue({ items: [], cursor: undefined });
    mockListSentInvitations.mockResolvedValue({ items: [], cursor: undefined });
    mockResolveListIdForAccount.mockResolvedValue(LIST);
    mockReconcileSentInvitationsToCrm.mockResolvedValue(OK);
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.LINKEDIN_INVITE_CRM_RECONCILE;
    else process.env.LINKEDIN_INVITE_CRM_RECONCILE = originalFlag;
  });

  // ---- fenced off ----

  it('is muted unless the kill-switch is explicitly on', async () => {
    delete process.env.LINKEDIN_INVITE_CRM_RECONCILE;
    await runLinkedInConnectionSync();
    expect(mockReconcileSentInvitationsToCrm).not.toHaveBeenCalled();
  });

  it('is muted when the flag is set to anything other than "true"', async () => {
    process.env.LINKEDIN_INVITE_CRM_RECONCILE = '1';
    await runLinkedInConnectionSync();
    expect(mockReconcileSentInvitationsToCrm).not.toHaveBeenCalled();
  });

  it('never writes for a site-wide account, which belongs to no single customer', async () => {
    mockGetAllUsers.mockResolvedValue([]);
    mockGetSetting.mockResolvedValue({
      settingValue: JSON.stringify([{ account_id: 'shared-pool-account', enabled: true }]),
    });

    await runLinkedInConnectionSync();

    expect(mockResolveListIdForAccount).not.toHaveBeenCalled();
    expect(mockReconcileSentInvitationsToCrm).not.toHaveBeenCalled();
  });

  it('does nothing when no list is bound to the account', async () => {
    mockResolveListIdForAccount.mockResolvedValue(null);
    await runLinkedInConnectionSync();
    expect(mockReconcileSentInvitationsToCrm).not.toHaveBeenCalled();
  });

  it('does not break the sync when the reconciliation throws', async () => {
    mockReconcileSentInvitationsToCrm.mockRejectedValue(new Error('dynamo down'));
    await expect(runLinkedInConnectionSync()).resolves.not.toThrow();
  });

  // ---- happy path ----

  it('reconciles the account into its bound list on every sync', async () => {
    await runLinkedInConnectionSync();

    expect(mockResolveListIdForAccount).toHaveBeenCalledWith(OWNER, ACCOUNT);
    expect(mockReconcileSentInvitationsToCrm).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT, listId: LIST, userId: OWNER }),
    );
  });

  it('does not re-pull the live feed — the cron already refreshed the cache', async () => {
    await runLinkedInConnectionSync();
    expect(mockReconcileSentInvitationsToCrm).toHaveBeenCalledWith(
      expect.objectContaining({ refreshFromLive: false }),
    );
  });

  it('runs per account, so one owner-less account does not suppress the others', async () => {
    mockGetAllUsers.mockResolvedValue([
      { userId: OWNER, connected_accounts: [{ platform: 'unipile', account_id: ACCOUNT }] },
      { userId: 'user_2', connected_accounts: [{ platform: 'unipile', account_id: 'acct_2' }] },
    ]);
    mockGetSetting.mockResolvedValue({
      settingValue: JSON.stringify([{ account_id: 'shared-pool-account', enabled: true }]),
    });

    await runLinkedInConnectionSync();

    expect(mockReconcileSentInvitationsToCrm).toHaveBeenCalledTimes(2);
    const accounts = mockReconcileSentInvitationsToCrm.mock.calls.map((c) => c[0].accountId);
    expect(accounts).toEqual(expect.arrayContaining([ACCOUNT, 'acct_2']));
    expect(accounts).not.toContain('shared-pool-account');
  });
});
