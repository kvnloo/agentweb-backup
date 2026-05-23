/**
 * Unit tests for getAccountsByUserIdIncludingOrgShared().
 *
 * Bug context: list_connected_accounts(platform='unipile') called in a delegated
 * or different-team-member session only returned the calling user's personal accounts.
 * Org-shared accounts (sharedWithOrg: true) from other members were silently omitted.
 *
 * Fix: getAccountsByUserIdIncludingOrgShared() fetches all org members and merges
 * their sharedWithOrg accounts into the result set, deduplicating by account_id.
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

import { getAccountsByUserIdIncludingOrgShared } from '../services/connectedAccountsDb';

const ORG_ID = 'org-test-123';

const makeAccount = (id: string, platform: string, sharedWithOrg: boolean) => ({
  platform,
  account_id: id,
  account_name: `Account ${id}`,
  config: { account_type: 'personal', access_token: 'tok', token_expires_at: 9999999999999 },
  sharedWithOrg,
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUsers = {};
  mockOrgMembers = [];
});

describe('getAccountsByUserIdIncludingOrgShared', () => {
  it('returns empty array when user does not exist', async () => {
    const result = await getAccountsByUserIdIncludingOrgShared('unknown-user');
    expect(result).toEqual([]);
  });

  it('returns only own accounts when user has no orgId', async () => {
    mockUsers['user-solo'] = {
      userId: 'user-solo',
      connected_accounts: [makeAccount('acc-1', 'gmail', false)],
    };

    const result = await getAccountsByUserIdIncludingOrgShared('user-solo');
    expect(result).toHaveLength(1);
    expect(result[0].account_id).toBe('acc-1');
  });

  it('includes org-shared accounts from other members', async () => {
    mockUsers['user-a'] = {
      userId: 'user-a',
      orgId: ORG_ID,
      connected_accounts: [makeAccount('acc-own', 'gmail', false)],
    };
    mockOrgMembers = [
      {
        userId: 'user-a',
        connected_accounts: [makeAccount('acc-own', 'gmail', false)],
      },
      {
        userId: 'user-b',
        connected_accounts: [
          makeAccount('acc-shared', 'unipile', true),
          makeAccount('acc-private', 'linkedin', false),
        ],
      },
    ];

    const result = await getAccountsByUserIdIncludingOrgShared('user-a');
    const ids = result.map(a => a.account_id);

    expect(ids).toContain('acc-own');
    expect(ids).toContain('acc-shared');
    expect(ids).not.toContain('acc-private');
  });

  it('does not include non-shared accounts from org members', async () => {
    mockUsers['user-a'] = {
      userId: 'user-a',
      orgId: ORG_ID,
      connected_accounts: [],
    };
    mockOrgMembers = [
      { userId: 'user-a', connected_accounts: [] },
      {
        userId: 'user-b',
        connected_accounts: [makeAccount('acc-b-private', 'unipile', false)],
      },
    ];

    const result = await getAccountsByUserIdIncludingOrgShared('user-a');
    expect(result.map(a => a.account_id)).not.toContain('acc-b-private');
  });

  it('deduplicates by account_id — own account wins over shared', async () => {
    const ownVersion = { ...makeAccount('dup-id', 'unipile', false), account_name: 'Mine' };
    const sharedVersion = { ...makeAccount('dup-id', 'unipile', true), account_name: 'Theirs' };

    mockUsers['user-a'] = {
      userId: 'user-a',
      orgId: ORG_ID,
      connected_accounts: [ownVersion],
    };
    mockOrgMembers = [
      { userId: 'user-a', connected_accounts: [ownVersion] },
      { userId: 'user-b', connected_accounts: [sharedVersion] },
    ];

    const result = await getAccountsByUserIdIncludingOrgShared('user-a');
    const matches = result.filter(a => a.account_id === 'dup-id');
    expect(matches).toHaveLength(1);
    expect(matches[0].account_name).toBe('Mine');
  });

  it('skips the calling user when iterating org members', async () => {
    const ownAccount = makeAccount('acc-own', 'gmail', true);
    mockUsers['user-a'] = {
      userId: 'user-a',
      orgId: ORG_ID,
      connected_accounts: [ownAccount],
    };
    // user-a appears as a member; should not be double-counted
    mockOrgMembers = [
      { userId: 'user-a', connected_accounts: [ownAccount] },
    ];

    const result = await getAccountsByUserIdIncludingOrgShared('user-a');
    expect(result).toHaveLength(1);
  });

  it('handles org members with no connected_accounts', async () => {
    mockUsers['user-a'] = {
      userId: 'user-a',
      orgId: ORG_ID,
      connected_accounts: [makeAccount('acc-own', 'gmail', false)],
    };
    mockOrgMembers = [
      { userId: 'user-a', connected_accounts: [makeAccount('acc-own', 'gmail', false)] },
      { userId: 'user-b' }, // no connected_accounts field
    ];

    const result = await getAccountsByUserIdIncludingOrgShared('user-a');
    expect(result).toHaveLength(1);
    expect(result[0].account_id).toBe('acc-own');
  });
});
