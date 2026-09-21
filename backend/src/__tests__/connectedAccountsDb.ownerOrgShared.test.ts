/**
 * Unit tests for getAccountsWithOwnerIncludingOrgShared().
 *
 * Bug context: org-shared connected accounts (sharedWithOrg: true) were VISIBLE to
 * other org members (the Settings list used getAccountsByUserIdIncludingOrgShared)
 * but not USABLE — every credential-consumption path read only the caller's own
 * user.connected_accounts. This helper exposes shared accounts to consumers while
 * preserving the OWNER's userId so token refreshes target the owner's record.
 */

let mockUsers: Record<string, any> = {};
let mockOrgMembers: any[] = [];

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn((id: string) => Promise.resolve(mockUsers[id] ?? null)),
  },
  orgDb: {
    getOrgMembers: jest.fn((_orgId: string) => Promise.resolve(mockOrgMembers)),
  },
}));

import { getAccountsWithOwnerIncludingOrgShared } from '../services/connectedAccountsDb';

const ORG_ID = 'org-test-123';

const makeAccount = (id: string, platform: string, sharedWithOrg: boolean) => ({
  platform,
  account_id: id,
  account_name: `Account ${id}`,
  config: { account_type: 'ad_account', access_token: 'tok', token_expires_at: 9999999999999 },
  sharedWithOrg,
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUsers = {};
  mockOrgMembers = [];
});

describe('getAccountsWithOwnerIncludingOrgShared', () => {
  it('returns empty array when user does not exist', async () => {
    expect(await getAccountsWithOwnerIncludingOrgShared('nope')).toEqual([]);
  });

  it('tags own accounts with the caller userId when user has no org', async () => {
    mockUsers['solo'] = { userId: 'solo', connected_accounts: [makeAccount('a1', 'google_ads', false)] };
    const result = await getAccountsWithOwnerIncludingOrgShared('solo');
    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe('solo');
    expect(result[0].account_id).toBe('a1');
  });

  it('includes org-shared accounts tagged with the OWNER userId', async () => {
    mockUsers['caller'] = {
      userId: 'caller', orgId: ORG_ID,
      connected_accounts: [makeAccount('own', 'gmail', false)],
    };
    mockOrgMembers = [
      { userId: 'caller', connected_accounts: [makeAccount('own', 'gmail', false)] },
      { userId: 'owner-b', connected_accounts: [makeAccount('shared', 'linkedin_ads', true)] },
    ];
    const result = await getAccountsWithOwnerIncludingOrgShared('caller');
    const shared = result.find(a => a.account_id === 'shared');
    expect(shared).toBeDefined();
    expect(shared!.userId).toBe('owner-b'); // owner, NOT caller — critical for token refresh
    const own = result.find(a => a.account_id === 'own');
    expect(own!.userId).toBe('caller');
  });

  it('excludes non-shared accounts from other members', async () => {
    mockUsers['caller'] = { userId: 'caller', orgId: ORG_ID, connected_accounts: [] };
    mockOrgMembers = [
      { userId: 'caller', connected_accounts: [] },
      { userId: 'owner-b', connected_accounts: [makeAccount('private', 'linkedin_ads', false)] },
    ];
    const result = await getAccountsWithOwnerIncludingOrgShared('caller');
    expect(result.map(a => a.account_id)).not.toContain('private');
  });

  it('dedupes by account_id — own account (and its userId) wins', async () => {
    const own = { ...makeAccount('dup', 'meta', false), account_name: 'Mine' };
    const shared = { ...makeAccount('dup', 'meta', true), account_name: 'Theirs' };
    mockUsers['caller'] = { userId: 'caller', orgId: ORG_ID, connected_accounts: [own] };
    mockOrgMembers = [
      { userId: 'caller', connected_accounts: [own] },
      { userId: 'owner-b', connected_accounts: [shared] },
    ];
    const result = await getAccountsWithOwnerIncludingOrgShared('caller');
    const matches = result.filter(a => a.account_id === 'dup');
    expect(matches).toHaveLength(1);
    expect(matches[0].account_name).toBe('Mine');
    expect(matches[0].userId).toBe('caller');
  });
});

/**
 * One Google account connected for both Gmail and Drive carries the SAME address
 * as account_id on both rows — that is the real shape of the account ENG-943 was
 * filed about. Own accounts were never deduped at all, so a caller has always
 * seen both of their own; only a teammate's shared accounts were squeezed through
 * an account_id-only key, which silently dropped whichever came second.
 *
 * For a mailbox that is not cosmetic: drop the Gmail row and the mailbox becomes
 * invisible to resolution again — ENG-943's exact symptom, from a different
 * cause, and past the reach of the resolver's own "prefer the email platform"
 * guard because the row never arrives.
 */
describe('getAccountsWithOwnerIncludingOrgShared — one address, two platforms', () => {
  it('keeps a teammate’s shared Gmail and Drive that share one address', async () => {
    const drive = makeAccount('them@example.com', 'google_drive', true);
    const gmail = makeAccount('them@example.com', 'gmail', true);
    mockUsers['caller'] = { userId: 'caller', orgId: ORG_ID, connected_accounts: [] };
    mockOrgMembers = [
      { userId: 'caller', connected_accounts: [] },
      // Drive first: an account_id-only key lets it swallow the mailbox.
      { userId: 'owner-b', connected_accounts: [drive, gmail] },
    ];

    const result = await getAccountsWithOwnerIncludingOrgShared('caller');

    expect(result.map(a => a.platform).sort()).toEqual(['gmail', 'google_drive']);
    expect(result.every(a => a.userId === 'owner-b')).toBe(true);
  });

  it('does not let the caller’s own Drive shadow a teammate’s shared Gmail', async () => {
    // `seen` is seeded from the caller's own accounts across every platform, so
    // an unrelated own account at the same address hid the shared mailbox.
    const ownDrive = makeAccount('shared@example.com', 'google_drive', false);
    const theirGmail = makeAccount('shared@example.com', 'gmail', true);
    mockUsers['caller'] = { userId: 'caller', orgId: ORG_ID, connected_accounts: [ownDrive] };
    mockOrgMembers = [
      { userId: 'caller', connected_accounts: [ownDrive] },
      { userId: 'owner-b', connected_accounts: [theirGmail] },
    ];

    const result = await getAccountsWithOwnerIncludingOrgShared('caller');

    const mailbox = result.find(a => a.platform === 'gmail');
    expect(mailbox).toBeDefined();
    expect(mailbox!.userId).toBe('owner-b');
    expect(result.find(a => a.platform === 'google_drive')!.userId).toBe('caller');
  });

  it('still collapses two members sharing the same account on the same platform', async () => {
    // Unchanged: same platform AND same id is the same account, first wins.
    mockUsers['caller'] = { userId: 'caller', orgId: ORG_ID, connected_accounts: [] };
    mockOrgMembers = [
      { userId: 'caller', connected_accounts: [] },
      { userId: 'owner-b', connected_accounts: [{ ...makeAccount('acct', 'linkedin_ads', true), account_name: 'First' }] },
      { userId: 'owner-c', connected_accounts: [{ ...makeAccount('acct', 'linkedin_ads', true), account_name: 'Second' }] },
    ];

    const result = await getAccountsWithOwnerIncludingOrgShared('caller');

    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe('owner-b');
  });
});
