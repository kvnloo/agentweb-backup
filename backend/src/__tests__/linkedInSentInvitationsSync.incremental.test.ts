/**
 * ENG-1197 — the incremental sent-invitation walk.
 *
 * This feed was walked in full every ten minutes on every instance, with no early
 * exit even when the previous cycle had just proved nothing changed: 16 pages for a
 * 1,540-invitation account, 144 times a day, against LinkedIn, with nobody using the
 * product. Load scaled with backlog size, so the accounts hit hardest were exactly
 * the ones whose sessions kept being revoked.
 *
 * The invariant that must survive the optimisation: pruning requires having seen the
 * COMPLETE pending set, so an early exit must never prune.
 */

jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: jest.fn() } },
})));

const mockListSentInvitations = jest.fn();
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: { listSentInvitations: (...a: any[]) => mockListSentInvitations(...a) },
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

import { syncSentInvitationsForAccount } from '../services/linkedInSentInvitationsSyncService';

const ACCOUNT = 'tMgX8uZJTZWTG_mFY1aI2A';

const invitation = (publicId: string, name = 'Jane Doe') => ({
  object: 'InvitationSent',
  id: `inv-${publicId}`,
  invited_user: name,
  invited_user_public_id: publicId,
  invitation_text: `Hi ${name}`,
  parsed_datetime: '2026-05-31T14:40:05.959Z',
});

/** The shape the cache holds for an invitation the feed also returns unchanged. */
const cachedRow = (publicId: string, name = 'Jane Doe') => ({
  accountId: ACCOUNT,
  invitedUserPublicId: publicId,
  publicProfileUrl: `https://www.linkedin.com/in/${publicId}/`,
  invitationId: `inv-${publicId}`,
  invitedUserName: name,
  invitationText: `Hi ${name}`,
  sentAt: '2026-05-31T14:40:05.959Z',
  syncedAt: '2026-08-01T00:00:00.000Z',
});

/** Serve `pages` in order, each with a cursor except the last. */
function servePages(pages: any[][]) {
  mockListSentInvitations.mockReset();
  pages.forEach((items, index) => {
    mockListSentInvitations.mockResolvedValueOnce({
      items,
      cursor: index < pages.length - 1 ? `cursor-${index}` : undefined,
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAllSentInvitationsByAccount.mockResolvedValue([]);
  mockPruneStaleSentInvitations.mockResolvedValue(0);
});

describe('incremental mode', () => {
  it('stops after TWO consecutive fully-known pages', async () => {
    // Two, not one: the early exit rests on Unipile ordering the feed newest-first,
    // which is observed rather than contractual, and the cost of being wrong is a
    // pending invitation missing from the cache — which reads as "never invited"
    // and can re-invite someone. One extra page is the insurance.
    const known = ['a', 'b', 'c', 'd'];
    mockGetAllSentInvitationsByAccount.mockResolvedValue(known.map((id) => cachedRow(id)));
    servePages([
      [invitation('a'), invitation('b')],
      [invitation('c'), invitation('d')],
      [invitation('e')],
    ]);

    await syncSentInvitationsForAccount(ACCOUNT, { mode: 'incremental' });

    expect(mockListSentInvitations).toHaveBeenCalledTimes(2);
  });

  it('keeps walking when only ONE page was fully known', async () => {
    // A single known page is exactly the out-of-order case the two-page rule guards.
    mockGetAllSentInvitationsByAccount.mockResolvedValue([cachedRow('a')]);
    servePages([[invitation('a')], [invitation('new')], [invitation('z')]]);

    await syncSentInvitationsForAccount(ACCOUNT, { mode: 'incremental' });

    expect(mockListSentInvitations).toHaveBeenCalledTimes(3);
  });

  it('never prunes when it stopped early', async () => {
    // The pages it did not read still hold pending invitations; pruning against a
    // partial set would delete every one of them.
    mockGetAllSentInvitationsByAccount.mockResolvedValue([cachedRow('a'), cachedRow('b')]);
    servePages([[invitation('a')], [invitation('b')], [invitation('c')]]);

    await syncSentInvitationsForAccount(ACCOUNT, { mode: 'incremental' });

    expect(mockPruneStaleSentInvitations).not.toHaveBeenCalled();
  });

  it('keeps walking past a page that contains a new invitation', async () => {
    mockGetAllSentInvitationsByAccount.mockResolvedValue([cachedRow('b'), cachedRow('c')]);
    servePages([[invitation('new-1')], [invitation('b')], [invitation('c')], [invitation('d')]]);

    await syncSentInvitationsForAccount(ACCOUNT, { mode: 'incremental' });

    // Page 1 had something new; pages 2 and 3 were known — stops after the pair.
    expect(mockListSentInvitations).toHaveBeenCalledTimes(3);
  });

  it('keeps walking past a page whose invitation text changed', async () => {
    mockGetAllSentInvitationsByAccount.mockResolvedValue([cachedRow('a', 'Old Name')]);
    servePages([[invitation('a', 'New Name')], [invitation('b')]]);

    await syncSentInvitationsForAccount(ACCOUNT, { mode: 'incremental' });

    expect(mockListSentInvitations).toHaveBeenCalledTimes(2);
  });

  it('walks the whole feed when the cache preload failed', async () => {
    // Without a trustworthy cache there is no basis for "unchanged", so the early
    // exit would be guessing.
    mockGetAllSentInvitationsByAccount.mockRejectedValue(new Error('dynamo unavailable'));
    servePages([[invitation('a')], [invitation('b')]]);

    await syncSentInvitationsForAccount(ACCOUNT, { mode: 'incremental' });

    expect(mockListSentInvitations).toHaveBeenCalledTimes(2);
    expect(mockPruneStaleSentInvitations).toHaveBeenCalledTimes(1);
  });

  it('walks the whole feed on a cold cache', async () => {
    mockGetAllSentInvitationsByAccount.mockResolvedValue([]);
    servePages([[invitation('a')], [invitation('b')]]);

    await syncSentInvitationsForAccount(ACCOUNT, { mode: 'incremental' });

    expect(mockListSentInvitations).toHaveBeenCalledTimes(2);
  });

  it('still upserts what it did read before stopping', async () => {
    // Page 1 mixes one new invitation with a known one, so the walk continues;
    // page 2 is entirely known, so it stops there and never reads page 3.
    mockGetAllSentInvitationsByAccount.mockResolvedValue([cachedRow('b'), cachedRow('known'), cachedRow('known2')]);
    servePages([
      [invitation('new-1'), invitation('b')],
      [invitation('known')],
      [invitation('known2')],
      [invitation('c')],
    ]);

    const upserted = await syncSentInvitationsForAccount(ACCOUNT, { mode: 'incremental' });

    expect(mockListSentInvitations).toHaveBeenCalledTimes(3);
    expect(upserted).toBe(1);
    expect(mockUpsertSentInvitations).toHaveBeenCalledWith([
      expect.objectContaining({ invitedUserPublicId: 'new-1' }),
    ]);
  });
});

describe('full mode is unchanged', () => {
  it('walks every page and prunes', async () => {
    mockGetAllSentInvitationsByAccount.mockResolvedValue([cachedRow('a'), cachedRow('b')]);
    servePages([[invitation('a')], [invitation('b')]]);

    await syncSentInvitationsForAccount(ACCOUNT, { mode: 'full' });

    expect(mockListSentInvitations).toHaveBeenCalledTimes(2);
    expect(mockPruneStaleSentInvitations).toHaveBeenCalledTimes(1);
  });

  it('is the default, so existing callers keep their exact semantics', async () => {
    mockGetAllSentInvitationsByAccount.mockResolvedValue([cachedRow('a'), cachedRow('b')]);
    servePages([[invitation('a')], [invitation('b')]]);

    await syncSentInvitationsForAccount(ACCOUNT);

    expect(mockListSentInvitations).toHaveBeenCalledTimes(2);
    expect(mockPruneStaleSentInvitations).toHaveBeenCalledTimes(1);
  });

  it('prunes against the complete pending set it observed', async () => {
    mockGetAllSentInvitationsByAccount.mockResolvedValue([cachedRow('a'), cachedRow('gone')]);
    servePages([[invitation('a')]]);

    await syncSentInvitationsForAccount(ACCOUNT, { mode: 'full' });

    const [, stillPending] = mockPruneStaleSentInvitations.mock.calls[0];
    expect(Array.from(stillPending)).toEqual(['a']);
  });
});
