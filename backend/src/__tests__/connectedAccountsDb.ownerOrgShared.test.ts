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
