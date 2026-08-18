/**
 * ENG-1197 — the cron's walk pacing and its accepted-invite cleanup.
 *
 * Both were shipped untested. The cleanup was worse than untested: every cron suite
 * mocked `unipileSentInvitationsDb` WITHOUT `deleteSentInvitationsByProfileUrls`, so
 * the call threw a TypeError that the surrounding catch swallowed. The suites stayed
 * green while the path never executed once.
 *
 * The walk pacing is the poll-load reduction this PR exists for: a full walk re-reads
 * the account's entire pending feed and is the only mode that prunes, so how often it
 * runs is the whole trade-off between load and cache staleness.
 */

const mockListConnections = jest.fn();
const mockListSentInvitations = jest.fn().mockResolvedValue({ items: [] });
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    listConnections: (...a: any[]) => mockListConnections(...a),
    listSentInvitations: (...a: any[]) => mockListSentInvitations(...a),
  },
}));

const mockUpsertConnections = jest.fn().mockResolvedValue(undefined);
const mockGetLatestConnectedAt = jest.fn();
const mockGetFullSyncCompletedAt = jest.fn();
const mockMarkFullSyncCompleted = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/unipileConnectionsDb', () => ({
  upsertConnections: (...a: any[]) => mockUpsertConnections(...a),
  getLatestConnectedAt: (...a: any[]) => mockGetLatestConnectedAt(...a),
  getFullSyncCompletedAt: (...a: any[]) => mockGetFullSyncCompletedAt(...a),
  markFullSyncCompleted: (...a: any[]) => mockMarkFullSyncCompleted(...a),
  normalizeLinkedInUrl: (url: string) => {
    let u = url.trim().toLowerCase();
    if (!u.endsWith('/')) u += '/';
    return u;
  },
}));

const mockUpsertSentInvitations = jest.fn().mockResolvedValue(undefined);
const mockPruneStaleSentInvitations = jest.fn().mockResolvedValue(0);
const mockDeleteSentInvitationsByProfileUrls = jest.fn().mockResolvedValue(0);
jest.mock('../services/unipileSentInvitationsDb', () => ({
  upsertSentInvitations: (...a: any[]) => mockUpsertSentInvitations(...a),
  pruneStaleSentInvitations: (...a: any[]) => mockPruneStaleSentInvitations(...a),
  profileUrlFromPublicId: (id: string) => `https://www.linkedin.com/in/${id}/`,
  deleteSentInvitationsByProfileUrls: (...a: any[]) => mockDeleteSentInvitationsByProfileUrls(...a),
}));

const mockGetAllSequencesByTriggerType = jest.fn().mockResolvedValue([]);
jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: { getAllSequencesByTriggerType: (...a: any[]) => mockGetAllSequencesByTriggerType(...a) },
}));

const mockFindLeadsByLinkedin = jest.fn().mockResolvedValue([]);
const mockGetAllUsers = jest.fn().mockResolvedValue([]);
jest.mock('../services/db', () => ({
  crmDb: { findLeadsByLinkedin: (...a: any[]) => mockFindLeadsByLinkedin(...a) },
  userDb: { getAllUsers: (...a: any[]) => mockGetAllUsers(...a) },
}));

const mockGetSetting = jest.fn().mockResolvedValue(null);
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: (...a: any[]) => mockGetSetting(...a) },
}));

const mockNotifyLinkedInConnectionAccepted = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: { notifyLinkedInConnectionAccepted: (...a: any[]) => mockNotifyLinkedInConnectionAccepted(...a) },
}));

// Mocked so the walk MODE can be asserted directly. Inferring it from whether a
// prune happened is unreliable: the prune also depends on the feed's shape and on
// whether the cache preload succeeded, so an empty feed prunes in either mode.
const mockSyncSentInvitationsForAccount = jest.fn().mockResolvedValue(0);
jest.mock('../services/linkedInSentInvitationsSyncService', () => ({
  syncSentInvitationsForAccount: (...a: any[]) => mockSyncSentInvitationsForAccount(...a),
}));

import { runLinkedInConnectionSync, __resetWalkPacingForTests } from '../cron/linkedInConnectionSyncCron';

/** The `mode` the cron asked for on each sent-invitation walk. */
const modes = () =>
  mockSyncSentInvitationsForAccount.mock.calls.map((c: any[]) => c[1]?.mode);

const TWO_CONNECTIONS = {
  items: [
    { member_id: 'm-1', public_identifier: 'alice', public_profile_url: 'https://www.linkedin.com/in/alice/', created_at: 1_700_000_000 },
    { member_id: 'm-2', public_identifier: 'bob', public_profile_url: 'https://www.linkedin.com/in/bob/', created_at: 1_700_000_001 },
  ],
  cursor: undefined,
};

beforeEach(() => {
  __resetWalkPacingForTests();
  jest.clearAllMocks();
  mockGetSetting.mockResolvedValue({ settingValue: JSON.stringify([{ account_id: 'acct-1', enabled: true }]) });
  mockGetAllUsers.mockResolvedValue([]);
  mockListConnections.mockResolvedValue(TWO_CONNECTIONS);
  mockListSentInvitations.mockResolvedValue({ items: [] });
  mockSyncSentInvitationsForAccount.mockResolvedValue(0);
  // Not a first-ever backfill unless a test says so.
  mockGetFullSyncCompletedAt.mockResolvedValue('2026-01-01T00:00:00.000Z');
  mockGetLatestConnectedAt.mockResolvedValue(1_600_000_000);
});

describe('accepted invitations are dropped from the cache', () => {
  it('calls the cleanup with the newly-connected profile URLs', async () => {
    await runLinkedInConnectionSync();

    expect(mockDeleteSentInvitationsByProfileUrls).toHaveBeenCalledTimes(1);
    const [accountId, urls] = mockDeleteSentInvitationsByProfileUrls.mock.calls[0];
    expect(accountId).toBe('acct-1');
    expect(urls).toEqual(expect.arrayContaining([
      'https://www.linkedin.com/in/alice/',
      'https://www.linkedin.com/in/bob/',
    ]));
  });

  it('does not run the cleanup when nothing new connected', async () => {
    mockListConnections.mockResolvedValue({ items: [], cursor: undefined });

    await runLinkedInConnectionSync();

    expect(mockDeleteSentInvitationsByProfileUrls).not.toHaveBeenCalled();
  });

  it('does not feed a one-time backfill\'s entire history into the cleanup', async () => {
    // A backfill returns every connection the account has ever made. Passing those to
    // a per-row cache scan turns a tidy-up into a full table scan on the cron path,
    // for people connected long before any invitation we track.
    mockGetFullSyncCompletedAt.mockResolvedValue(null);

    await runLinkedInConnectionSync();

    expect(mockDeleteSentInvitationsByProfileUrls).not.toHaveBeenCalled();
  });

  it('survives a cleanup failure without failing the sync', async () => {
    mockDeleteSentInvitationsByProfileUrls.mockRejectedValue(new Error('dynamo down'));

    await expect(runLinkedInConnectionSync()).resolves.toBeUndefined();
    // The pending-invitation walk still ran: tidying our own cache says nothing
    // about the LinkedIn session.
    expect(mockSyncSentInvitationsForAccount).toHaveBeenCalled();
  });
});

describe('full walks are paced, and only a completed one counts', () => {
  it('walks fully on the first tick', async () => {
    await runLinkedInConnectionSync();

    expect(modes()).toEqual(['full']);
  });

  it('goes incremental on the next tick inside the interval', async () => {
    await runLinkedInConnectionSync();
    await runLinkedInConnectionSync();

    expect(modes()).toEqual(['full', 'incremental']);
  });

  it('does not count a walk that threw, so the next tick retries the full one', async () => {
    // Stamping at selection time would mark the walk done even though it failed, and
    // since only a full walk prunes, one timeout would push the next prune out by
    // another whole interval — doubling the staleness the interval bounds.
    mockSyncSentInvitationsForAccount.mockRejectedValueOnce(new Error('unipile 503'));

    await runLinkedInConnectionSync();
    await runLinkedInConnectionSync();

    expect(modes()).toEqual(['full', 'full']);
  });

  it('paces each account independently', async () => {
    mockGetSetting.mockResolvedValue({
      settingValue: JSON.stringify([
        { account_id: 'acct-1', enabled: true },
        { account_id: 'acct-2', enabled: true },
      ]),
    });

    await runLinkedInConnectionSync();
    await runLinkedInConnectionSync();

    // Both full on the first pass, both incremental on the second — one account's
    // walk must not start another account's clock.
    expect(modes()).toEqual(['full', 'full', 'incremental', 'incremental']);
  });
});
