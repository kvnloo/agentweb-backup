/**
 * ENG-1197 — targeted deletion of pending-invitation rows.
 *
 * Moving the full feed walk to hourly made that walk a poor freshness mechanism: the
 * CRM reads this cache to show "invite pending" on a lead, so an invitation that was
 * accepted or withdrawn could keep showing as pending for up to an hour.
 *
 * The fix is to stop depending on the walk for freshness. An invitation leaves the
 * pending set in exactly two ways and we observe both directly — the recipient
 * accepts (the 10-minute connection sync sees the new connection) or we withdraw it
 * ourselves — so each event deletes its own row and the walk is left as a backstop
 * for the residue.
 */

const mockDelete = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
const mockQuery = jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) });
const mockBatchWrite = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });

jest.mock('aws-sdk', () => ({
  __esModule: true,
  default: {
    config: { update: jest.fn() },
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        delete: (...a: any[]) => mockDelete(...a),
        query: (...a: any[]) => mockQuery(...a),
        batchWrite: (...a: any[]) => mockBatchWrite(...a),
      })),
    },
  },
}));

import {
  deleteSentInvitationByInvitationId,
  deleteSentInvitationsByProfileUrls,
} from '../services/unipileSentInvitationsDb';

const ACCOUNT = 'tMgX8uZJTZWTG_mFY1aI2A';

const row = (publicId: string) => ({
  accountId: ACCOUNT,
  invitedUserPublicId: publicId,
  publicProfileUrl: `https://www.linkedin.com/in/${publicId}/`,
  invitationId: `inv-${publicId}`,
  invitedUserName: 'Jane Doe',
  invitationText: '',
  sentAt: '2026-05-31T14:40:05.959Z',
  syncedAt: '2026-08-01T00:00:00.000Z',
});

/** The account partition read that both helpers do before deleting. */
function givenCached(rows: any[]) {
  mockQuery.mockReturnValue({ promise: () => Promise.resolve({ Items: rows }) });
}

/** Sort keys passed to delete(), in call order. */
function deletedIds(): string[] {
  return mockDelete.mock.calls.map((c) => c[0].Key.invitedUserPublicId);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDelete.mockReturnValue({ promise: () => Promise.resolve({}) });
  givenCached([]);
});

describe('deleteSentInvitationsByProfileUrls — the accepted-invitation path', () => {
  it('deletes the row for a profile that just became a connection', async () => {
    givenCached([row('alice'), row('bob')]);

    const removed = await deleteSentInvitationsByProfileUrls(ACCOUNT, [
      'https://www.linkedin.com/in/alice/',
    ]);

    expect(removed).toBe(1);
    expect(deletedIds()).toEqual(['alice']);
  });

  it('matches regardless of trailing slash or query string', async () => {
    // The connection cache and the invitation cache normalize independently, so the
    // two sides must not have to agree on formatting for the match to land.
    givenCached([row('alice')]);

    await deleteSentInvitationsByProfileUrls(ACCOUNT, [
      'https://www.linkedin.com/in/alice?trk=search',
    ]);

    expect(deletedIds()).toEqual(['alice']);
  });

  it('leaves rows for profiles that are still pending', async () => {
    givenCached([row('alice'), row('bob')]);

    await deleteSentInvitationsByProfileUrls(ACCOUNT, [
      'https://www.linkedin.com/in/bob/',
    ]);

    expect(deletedIds()).toEqual(['bob']);
  });

  it('does nothing, and does not read the store, for an empty list', async () => {
    await expect(deleteSentInvitationsByProfileUrls(ACCOUNT, [])).resolves.toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('ignores blank urls rather than matching everything', async () => {
    givenCached([row('alice')]);

    await expect(deleteSentInvitationsByProfileUrls(ACCOUNT, ['', undefined as any])).resolves.toBe(0);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('deletes nothing when the accepted profile was never invited by us', async () => {
    givenCached([row('alice')]);

    const removed = await deleteSentInvitationsByProfileUrls(ACCOUNT, [
      'https://www.linkedin.com/in/stranger/',
    ]);

    expect(removed).toBe(0);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('handles more rows than one delete batch', async () => {
    const many = Array.from({ length: 60 }, (_, i) => row(`user-${i}`));
    givenCached(many);

    const removed = await deleteSentInvitationsByProfileUrls(
      ACCOUNT,
      many.map((r) => r.publicProfileUrl),
    );

    expect(removed).toBe(60);
    expect(mockDelete).toHaveBeenCalledTimes(60);
  });
});

describe('deleteSentInvitationByInvitationId — the withdrawal path', () => {
  it('deletes the row for the invitation we just withdrew', async () => {
    // Keyed by invitation id because that is what the withdraw call carries; the
    // table is keyed by the invitee's public id, so it resolves one from the other.
    givenCached([row('alice'), row('bob')]);

    const removed = await deleteSentInvitationByInvitationId(ACCOUNT, 'inv-bob');

    expect(removed).toBe(1);
    expect(deletedIds()).toEqual(['bob']);
  });

  it('does nothing, and does not read the store, for a missing id', async () => {
    await expect(deleteSentInvitationByInvitationId(ACCOUNT, '')).resolves.toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('deletes nothing when the id is not in the cache', async () => {
    givenCached([row('alice')]);

    await expect(deleteSentInvitationByInvitationId(ACCOUNT, 'inv-nobody')).resolves.toBe(0);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
