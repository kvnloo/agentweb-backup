/**
 * ENG-875 — the sent-invitation sync must stop rewriting rows that did not change.
 *
 * On 2026-08-03 a single production instance sat at ~93% CPU for 85 minutes.
 * `syncSentInvitationsForAccount` rewrote EVERY pending invitation on every
 * 10-minute cycle, changed or not: for an account with 700+ pending invites that
 * is 700+ DynamoDB writes every ten minutes, forever, for no change in content.
 * It also read the account's full row set TWICE per cycle — once to preload
 * `sentAt`, once inside `pruneStaleSentInvitations`.
 *
 * The fix that is NOT correct, and which this file guards against:
 * narrowing the pagination. `stillPendingPublicIds` is built from the walk and
 * `pruneStaleSentInvitations` DELETES every cached row absent from it, so a
 * short walk silently deletes valid CRM rows — destroying exactly what ENG-787
 * built. The full walk is load-bearing. Only the WRITE is skipped.
 */

jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: jest.fn() } },
})));

jest.mock('../services/agentModeService', () => ({
  agentModeService: { readBrandGuidelines: jest.fn(), readMarketStrategy: jest.fn() },
}));

const mockListConnections = jest.fn().mockResolvedValue({ items: [], cursor: undefined });
const mockListSentInvitations = jest.fn();
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    listConnections: (...a: any[]) => mockListConnections(...a),
    listSentInvitations: (...a: any[]) => mockListSentInvitations(...a),
  },
}));

jest.mock('../services/unipileConnectionsDb', () => ({
  upsertConnections: jest.fn().mockResolvedValue(undefined),
  getLatestConnectedAt: jest.fn().mockResolvedValue(1_700_000_000),
  getFullSyncCompletedAt: jest.fn().mockResolvedValue('2026-01-01T00:00:00.000Z'),
  markFullSyncCompleted: jest.fn().mockResolvedValue(undefined),
  normalizeLinkedInUrl: (url: string) => url.trim().toLowerCase(),
}));

const mockUpsertSentInvitations = jest.fn().mockResolvedValue(undefined);
const mockPruneStaleSentInvitations = jest.fn().mockResolvedValue(0);
const mockGetAllSentInvitationsByAccount = jest.fn().mockResolvedValue([]);
const mockDeleteSentInvitationsByProfileUrls = jest.fn().mockResolvedValue(0);
jest.mock('../services/unipileSentInvitationsDb', () => ({
  upsertSentInvitations: (...a: any[]) => mockUpsertSentInvitations(...a),
  pruneStaleSentInvitations: (...a: any[]) => mockPruneStaleSentInvitations(...a),
  getAllSentInvitationsByAccount: (...a: any[]) => mockGetAllSentInvitationsByAccount(...a),
  profileUrlFromPublicId: (id: string) => `https://www.linkedin.com/in/${id}/`,
  deleteSentInvitationsByProfileUrls: (...a: any[]) => mockDeleteSentInvitationsByProfileUrls(...a),
}));

jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: { getAllSequencesByTriggerType: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../services/db', () => ({
  crmDb: { findLeadsByLinkedin: jest.fn().mockResolvedValue([]) },
  userDb: { getAllUsers: jest.fn().mockResolvedValue([]) },
}));

const mockGetSetting = jest.fn();
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: (...a: any[]) => mockGetSetting(...a) },
}));

jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: { notifyLinkedInConnectionAccepted: jest.fn().mockResolvedValue(undefined) },
}));

import {
  runLinkedInConnectionSync,
  __resetDisconnectBackoffForTests,
  __resetWalkPacingForTests,
} from '../cron/linkedInConnectionSyncCron';

const ACCOUNT = 'acct-1';

/** A Unipile feed item as the API returns it. */
const feedItem = (publicId: string, over: Record<string, unknown> = {}) => ({
  id: `inv-${publicId}`,
  invited_user_public_id: publicId,
  invited_user: `Name ${publicId}`,
  invitation_text: `hello ${publicId}`,
  parsed_datetime: '2026-07-01T00:00:00.000Z',
  ...over,
});

/** The cached row that item would already have produced. */
const cachedRow = (publicId: string, over: Record<string, unknown> = {}) => ({
  accountId: ACCOUNT,
  invitedUserPublicId: publicId,
  publicProfileUrl: `https://www.linkedin.com/in/${publicId}/`,
  invitationId: `inv-${publicId}`,
  invitedUserName: `Name ${publicId}`,
  invitationText: `hello ${publicId}`,
  sentAt: '2026-07-01T00:00:00.000Z',
  // Deliberately an OLD syncedAt. It must not, by itself, force a rewrite.
  syncedAt: '2026-07-01T00:00:00.000Z',
  ...over,
});

/** Serves the feed across `pages` pages of one item each, cursor-driven. */
const feedOverPages = (ids: string[]) => {
  mockListSentInvitations.mockImplementation((_acct: string, cursor?: string) => {
    const idx = cursor ? Number(cursor) : 0;
    if (idx >= ids.length) return Promise.resolve({ items: [], cursor: undefined });
    return Promise.resolve({
      items: [feedItem(ids[idx])],
      cursor: idx + 1 < ids.length ? String(idx + 1) : undefined,
    });
  });
};

const upsertedIds = () =>
  mockUpsertSentInvitations.mock.calls.flatMap(([rows]) =>
    (rows as any[]).map((r) => r.invitedUserPublicId));

beforeEach(() => {
  // ENG-1197: the cron paces both its dead-account re-checks and its full
  // walk in module state.
  __resetDisconnectBackoffForTests();
  __resetWalkPacingForTests();
  jest.clearAllMocks();
  mockGetSetting.mockResolvedValue({
    settingValue: JSON.stringify([{ account_id: ACCOUNT, enabled: true }]),
  });
  mockListConnections.mockResolvedValue({ items: [], cursor: undefined });
  mockPruneStaleSentInvitations.mockResolvedValue(0);
});

describe('ENG-875 — sent-invitation sync write amplification', () => {
  it('does NOT rewrite invitations whose content is unchanged', async () => {
    feedOverPages(['alice', 'bob']);
    mockGetAllSentInvitationsByAccount.mockResolvedValue([cachedRow('alice'), cachedRow('bob')]);

    await runLinkedInConnectionSync();

    // The whole point: an identical feed costs zero writes.
    expect(upsertedIds()).toEqual([]);
  });

  it('still marks unchanged invitations as pending, so the prune does not delete them', async () => {
    feedOverPages(['alice', 'bob']);
    mockGetAllSentInvitationsByAccount.mockResolvedValue([cachedRow('alice'), cachedRow('bob')]);

    await runLinkedInConnectionSync();

    // This is the assertion that stops "skip the write" turning into data loss.
    const [, stillPending] = mockPruneStaleSentInvitations.mock.calls[0];
    expect(Array.from(stillPending as Set<string>).sort()).toEqual(['alice', 'bob']);
  });

  it('walks EVERY page, so an invitation on the last page is never pruned', async () => {
    // Three pages, one invite each. A narrowed walk would omit the last and the
    // prune would delete it — the failure mode this fix must not introduce.
    feedOverPages(['alice', 'bob', 'carol']);
    mockGetAllSentInvitationsByAccount.mockResolvedValue([
      cachedRow('alice'), cachedRow('bob'), cachedRow('carol'),
    ]);

    await runLinkedInConnectionSync();

    const [, stillPending] = mockPruneStaleSentInvitations.mock.calls[0];
    expect((stillPending as Set<string>).has('carol')).toBe(true);
    expect(mockListSentInvitations).toHaveBeenCalledTimes(3);
  });

  it('DOES upsert an invitation whose content changed', async () => {
    feedOverPages(['alice']);
    mockGetAllSentInvitationsByAccount.mockResolvedValue([
      cachedRow('alice', { invitationText: 'something different' }),
    ]);

    await runLinkedInConnectionSync();

    expect(upsertedIds()).toEqual(['alice']);
  });

  it('DOES upsert an invitation that is not cached at all', async () => {
    feedOverPages(['alice', 'newcomer']);
    mockGetAllSentInvitationsByAccount.mockResolvedValue([cachedRow('alice')]);

    await runLinkedInConnectionSync();

    expect(upsertedIds()).toEqual(['newcomer']);
  });

  it('does not treat a stale syncedAt as a change', async () => {
    // syncedAt is stamped `now` every run. If it counted, nothing would ever be
    // skipped and the fix would be inert.
    feedOverPages(['alice']);
    mockGetAllSentInvitationsByAccount.mockResolvedValue([
      cachedRow('alice', { syncedAt: '2020-01-01T00:00:00.000Z' }),
    ]);

    await runLinkedInConnectionSync();

    expect(upsertedIds()).toEqual([]);
  });

  it('reads the account rows once per cycle, not twice', async () => {
    feedOverPages(['alice']);
    mockGetAllSentInvitationsByAccount.mockResolvedValue([cachedRow('alice')]);

    await runLinkedInConnectionSync();

    expect(mockGetAllSentInvitationsByAccount).toHaveBeenCalledTimes(1);
    // The preloaded rows are handed to the prune so it need not re-read.
    const [, , known] = mockPruneStaleSentInvitations.mock.calls[0];
    expect(known).toHaveLength(1);
  });

  it('does not treat a DRIFTING parsed_datetime as a change (the bug that made the first fix inert)', async () => {
    // The production failure, reproduced. LinkedIn reports invitation age
    // relatively ("3 months ago") and Unipile resolves it to an absolute
    // datetime at request time, so parsed_datetime moves on every single call.
    // The first version of this fix compared sentAt and preferred the incoming
    // value, so every row differed every cycle and the skip never fired:
    // "1547 upserted, 0 unchanged (skipped)" on every account in prod.
    mockListSentInvitations.mockImplementation(() =>
      Promise.resolve({
        items: [feedItem('alice', { parsed_datetime: '2026-05-04T04:38:52.378Z' })],
        cursor: undefined,
      }));
    mockGetAllSentInvitationsByAccount.mockResolvedValue([
      cachedRow('alice', { sentAt: '2026-05-04T04:31:10.002Z' }),
    ]);

    await runLinkedInConnectionSync();

    expect(upsertedIds()).toEqual([]);
  });

  it('falls back to rewriting everything when the preload fails, rather than skipping writes blind', async () => {
    feedOverPages(['alice', 'bob']);
    mockGetAllSentInvitationsByAccount.mockRejectedValue(new Error('dynamo unavailable'));

    await runLinkedInConnectionSync();

    // No cache means no basis for "unchanged" — write both, exactly as before.
    expect(upsertedIds().sort()).toEqual(['alice', 'bob']);
    // And the prune must re-read for itself rather than trust an empty preload,
    // or it would delete every row it failed to load.
    const [, , known] = mockPruneStaleSentInvitations.mock.calls[0];
    expect(known).toBeUndefined();
  });
});
