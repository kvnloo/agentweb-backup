/**
 * Tests for syncSentInvitationsForAccount — caches PENDING LinkedIn sent
 * invitations and prunes rows that are no longer pending.
 */

jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: jest.fn() } },
})));

jest.mock('../services/agentModeService', () => ({
  agentModeService: { readBrandGuidelines: jest.fn(), readMarketStrategy: jest.fn() },
}));

const mockListSentInvitations = jest.fn();
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: { listSentInvitations: (...a: any[]) => mockListSentInvitations(...a) },
}));

jest.mock('../services/unipileConnectionsDb', () => ({
  upsertConnections: jest.fn(),
  getLatestConnectedAt: jest.fn().mockResolvedValue(null),
  normalizeLinkedInUrl: (url: string) => {
    let u = url.trim().toLowerCase();
    if (!u.endsWith('/')) u += '/';
    return u;
  },
}));

const mockUpsertSentInvitations = jest.fn().mockResolvedValue(undefined);
const mockPruneStaleSentInvitations = jest.fn().mockResolvedValue(0);
const mockGetAllSentInvitationsByAccount = jest.fn().mockResolvedValue([]);
jest.mock('../services/unipileSentInvitationsDb', () => ({
  upsertSentInvitations: (...a: any[]) => mockUpsertSentInvitations(...a),
  pruneStaleSentInvitations: (...a: any[]) => mockPruneStaleSentInvitations(...a),
  getAllSentInvitationsByAccount: (...a: any[]) => mockGetAllSentInvitationsByAccount(...a),
  profileUrlFromPublicId: (id: string) => `https://www.linkedin.com/in/${id}/`,
}));

jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: { getAllSequencesByTriggerType: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../services/db', () => ({ crmDb: {}, userDb: { getAllUsers: jest.fn() } }));
jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn() } }));
jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: {} }));

import { syncSentInvitationsForAccount } from '../cron/linkedInConnectionSyncCron';

const invitation = (publicId: string, name = 'Jane Doe') => ({
  object: 'InvitationSent',
  id: `inv-${publicId}`,
  invited_user: name,
  invited_user_public_id: publicId,
  invitation_text: `Hi ${name}`,
  parsed_datetime: '2026-05-31T14:40:05.959Z',
});

describe('syncSentInvitationsForAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllSentInvitationsByAccount.mockResolvedValue([]);
  });

  // ENG-787: sentAt is the identity of an invitation for downstream consumers (the
  // CRM invite mirror dedupes an engagement by send time). Re-stamping it every
  // ~10-min sync would make one invitation look like a new one on every run.
  describe('sentAt stability when Unipile omits parsed_datetime', () => {
    const undated = (publicId: string) => {
      const { parsed_datetime, ...rest } = invitation(publicId);
      return rest;
    };

    it('carries the previously cached sentAt forward', async () => {
      mockGetAllSentInvitationsByAccount.mockResolvedValue([
        { invitedUserPublicId: 'jane-doe', sentAt: '2026-01-02T03:04:05.000Z' },
      ]);
      mockListSentInvitations.mockResolvedValue({ items: [undated('jane-doe')], cursor: undefined });

      await syncSentInvitationsForAccount('acct-1');

      const [upserted] = mockUpsertSentInvitations.mock.calls[0];
      expect(upserted[0].sentAt).toBe('2026-01-02T03:04:05.000Z');
    });

    it('falls back to now for an invitation seen for the first time', async () => {
      mockGetAllSentInvitationsByAccount.mockResolvedValue([]);
      mockListSentInvitations.mockResolvedValue({ items: [undated('brand-new')], cursor: undefined });

      await syncSentInvitationsForAccount('acct-1');

      const [upserted] = mockUpsertSentInvitations.mock.calls[0];
      expect(upserted[0].sentAt).toBe(upserted[0].syncedAt);
    });

    it('still prefers Unipile parsed_datetime over the cached value when present', async () => {
      mockGetAllSentInvitationsByAccount.mockResolvedValue([
        { invitedUserPublicId: 'jane-doe', sentAt: '2020-01-01T00:00:00.000Z' },
      ]);
      mockListSentInvitations.mockResolvedValue({ items: [invitation('jane-doe')], cursor: undefined });

      await syncSentInvitationsForAccount('acct-1');

      const [upserted] = mockUpsertSentInvitations.mock.calls[0];
      expect(upserted[0].sentAt).toBe('2026-05-31T14:40:05.959Z');
    });

    it('still syncs when the cache preload fails', async () => {
      mockGetAllSentInvitationsByAccount.mockRejectedValue(new Error('dynamo down'));
      mockListSentInvitations.mockResolvedValue({ items: [invitation('jane-doe')], cursor: undefined });

      const count = await syncSentInvitationsForAccount('acct-1');

      expect(count).toBe(1);
      expect(mockUpsertSentInvitations).toHaveBeenCalledTimes(1);
    });
  });

  it('upserts all pending invitations from a single page', async () => {
    mockListSentInvitations.mockResolvedValue({
      items: [invitation('jane-doe'), invitation('john-smith', 'John Smith')],
      cursor: undefined,
    });

    const count = await syncSentInvitationsForAccount('acct-1');

    expect(count).toBe(2);
    expect(mockUpsertSentInvitations).toHaveBeenCalledTimes(1);
    const upserted = mockUpsertSentInvitations.mock.calls[0][0];
    expect(upserted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountId: 'acct-1',
        invitedUserPublicId: 'jane-doe',
        publicProfileUrl: 'https://www.linkedin.com/in/jane-doe/',
        sentAt: '2026-05-31T14:40:05.959Z',
      }),
    ]));
  });

  it('paginates across multiple pages via cursor', async () => {
    mockListSentInvitations
      .mockResolvedValueOnce({ items: [invitation('a')], cursor: 'c1' })
      .mockResolvedValueOnce({ items: [invitation('b')], cursor: 'c2' })
      .mockResolvedValueOnce({ items: [invitation('c')], cursor: undefined });

    const count = await syncSentInvitationsForAccount('acct-1');

    expect(count).toBe(3);
    expect(mockListSentInvitations).toHaveBeenCalledTimes(3);
  });

  it('prunes cached invitations no longer present in the feed (accepted/withdrawn)', async () => {
    mockListSentInvitations.mockResolvedValue({ items: [invitation('still-pending')], cursor: undefined });

    await syncSentInvitationsForAccount('acct-1');

    // The set passed to prune must contain exactly the still-pending public ids.
    expect(mockPruneStaleSentInvitations).toHaveBeenCalledTimes(1);
    const [acct, pendingSet] = mockPruneStaleSentInvitations.mock.calls[0];
    expect(acct).toBe('acct-1');
    expect(pendingSet.has('still-pending')).toBe(true);
    expect(pendingSet.size).toBe(1);
  });

  it('skips items without a public id and still prunes', async () => {
    mockListSentInvitations.mockResolvedValue({
      items: [{ object: 'InvitationSent', id: 'x', invited_user: 'No Id' }],
      cursor: undefined,
    });

    const count = await syncSentInvitationsForAccount('acct-1');

    expect(count).toBe(0);
    expect(mockPruneStaleSentInvitations).toHaveBeenCalledWith('acct-1', expect.any(Set));
  });
});
