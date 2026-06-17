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
const mockUpdateUser = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn((id: string) => Promise.resolve(mockUsers[id] ?? null)),
    updateUser: (...args: any[]) => mockUpdateUser(...args),
  },
  orgDb: {
    getOrgMembers: jest.fn((_orgId: string) => Promise.resolve(mockOrgMembers)),
  },
}));

import { createAccount, getAccountsByUserIdIncludingOrgShared } from '../services/connectedAccountsDb';

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
  mockUpdateUser.mockResolvedValue(undefined);
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

describe('createAccount org sharing defaults', () => {
  it('defaults LinkedIn Ads accounts to org-shared so teammates can use agency-created ad connections', async () => {
    mockUsers['seth-user'] = {
      userId: 'seth-user',
      orgId: ORG_ID,
      connected_accounts: [],
    };

    await createAccount('seth-user', 'linkedin_ads', {
      account_id: 'urn:li:sponsoredAccount:111',
      account_name: 'Sarah LinkedIn Ads',
      config: {
        account_type: 'ad_account',
        currency: 'USD',
        status: 'ACTIVE',
        access_token: 'li-token',
        token_expires_at: 9999999999999,
      },
    });

    expect(mockUpdateUser).toHaveBeenCalledWith('seth-user', {
      connected_accounts: [
        expect.objectContaining({
          platform: 'linkedin_ads',
          account_id: 'urn:li:sponsoredAccount:111',
          sharedWithOrg: true,
        }),
      ],
    });
  });

  it('defaults Google Ads accounts to org-shared so the selected customer account is visible to org members', async () => {
    mockUsers['seth-user'] = {
      userId: 'seth-user',
      orgId: ORG_ID,
      connected_accounts: [],
    };

    await createAccount('seth-user', 'google_ads', {
      account_id: '1234567890',
      account_name: 'Sarah Google Ads',
      config: {
        account_type: 'google_ads',
        customer_id: '1234567890',
        currency: 'USD',
        access_token: 'google-token',
        token_expires_at: 9999999999999,
      },
    });

    expect(mockUpdateUser).toHaveBeenCalledWith('seth-user', {
      connected_accounts: [
        expect.objectContaining({
          platform: 'google_ads',
          account_id: '1234567890',
          sharedWithOrg: true,
        }),
      ],
    });
  });

  it('defaults Meta ad accounts to org-shared while leaving non-ad Meta assets private', async () => {
    mockUsers['seth-user'] = {
      userId: 'seth-user',
      orgId: ORG_ID,
      connected_accounts: [],
    };

    await createAccount('seth-user', 'meta', {
      account_id: 'act_123',
      account_name: 'Sarah Meta Ads',
      config: {
        account_type: 'ad_account',
        ad_account_id: 'act_123',
        currency: 'USD',
        access_token: 'meta-token',
        token_expires_at: 9999999999999,
      },
    });

    expect(mockUpdateUser).toHaveBeenCalledWith('seth-user', {
      connected_accounts: [
        expect.objectContaining({
          platform: 'meta',
          account_id: 'act_123',
          sharedWithOrg: true,
        }),
      ],
    });
  });

  it('keeps personal Gmail accounts private by default', async () => {
    mockUsers['seth-user'] = {
      userId: 'seth-user',
      orgId: ORG_ID,
      connected_accounts: [],
    };

    await createAccount('seth-user', 'gmail', {
      account_id: 'seth@example.com',
      account_name: 'Seth Gmail',
      config: {
        account_type: 'gmail',
        email: 'seth@example.com',
        access_token: 'gmail-token',
        token_expires_at: 9999999999999,
        granted_scopes: [],
      },
    });

    expect(mockUpdateUser).toHaveBeenCalledWith('seth-user', {
      connected_accounts: [
        expect.objectContaining({
          platform: 'gmail',
          account_id: 'seth@example.com',
          sharedWithOrg: false,
        }),
      ],
    });
  });

  it('preserves an existing explicit private setting when refreshing an ads account', async () => {
    const existing = {
      ...makeAccount('urn:li:sponsoredAccount:111', 'linkedin_ads', false),
      created_at: '2024-01-01T00:00:00.000Z',
    };
    mockUsers['seth-user'] = {
      userId: 'seth-user',
      orgId: ORG_ID,
      connected_accounts: [existing],
    };

    await createAccount('seth-user', 'linkedin_ads', {
      account_id: 'urn:li:sponsoredAccount:111',
      account_name: 'Sarah LinkedIn Ads',
      config: {
        account_type: 'ad_account',
        currency: 'USD',
        status: 'ACTIVE',
        access_token: 'new-token',
        token_expires_at: 9999999999999,
      },
    });

    expect(mockUpdateUser).toHaveBeenCalledWith('seth-user', {
      connected_accounts: [
        expect.objectContaining({
          platform: 'linkedin_ads',
          account_id: 'urn:li:sponsoredAccount:111',
          sharedWithOrg: false,
          created_at: '2024-01-01T00:00:00.000Z',
        }),
      ],
    });
  });
});
