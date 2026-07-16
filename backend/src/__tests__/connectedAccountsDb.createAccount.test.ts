/**
 * Unit tests for createAccount() — reconnect path field preservation (ENG-348).
 *
 * Bug context: createAccount rebuilt the stored ConnectedAccountConfig from scratch
 * when an existing platform+account_id entry was found (reconnect/re-OAuth path).
 * The rebuilt object only carried platform/account_id/account_name/config/created_at/
 * updated_at — sharedWithOrg (and any other top-level fields like engagementMemory)
 * were silently dropped, so an org-shared account reverted to private on re-OAuth.
 *
 * Fix: spread the existing account into the rebuilt object, then override the
 * refreshed fields (config, account_name, updated_at).
 */

let mockUsers: Record<string, any> = {};
let updateUserCalls: Array<{ userId: string; updates: any }> = [];

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn((id: string) => Promise.resolve(mockUsers[id] ?? null)),
    updateUser: jest.fn((userId: string, updates: any) => {
      updateUserCalls.push({ userId, updates });
      return Promise.resolve({ ...mockUsers[userId], ...updates });
    }),
  },
  orgDb: {
    getOrgMembers: jest.fn(() => Promise.resolve([])),
  },
}));

import { createAccount } from '../services/connectedAccountsDb';

const USER_ID = 'user-reconnect-test';

const existingGmailAccount = () => ({
  platform: 'gmail',
  account_id: 'acc-gmail-1',
  account_name: 'Old Name',
  config: { email: 'old@example.com', access_token: 'old-token' },
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
});

const reconnectInput = () => ({
  account_id: 'acc-gmail-1',
  account_name: 'New Name',
  config: { email: 'old@example.com', access_token: 'fresh-token' } as any,
});

/** The connected_accounts array written by the last updateUser call. */
const storedAccounts = (): any[] => {
  expect(updateUserCalls.length).toBeGreaterThan(0);
  return updateUserCalls[updateUserCalls.length - 1].updates.connected_accounts;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUsers = {};
  updateUserCalls = [];
});

describe('createAccount — reconnect preserves existing top-level fields (ENG-348)', () => {
  it('preserves sharedWithOrg: true when reconnecting the same platform+account_id', async () => {
    mockUsers[USER_ID] = {
      userId: USER_ID,
      connected_accounts: [{ ...existingGmailAccount(), sharedWithOrg: true }],
    };

    const result = await createAccount(USER_ID, 'gmail' as any, reconnectInput());

    expect(result.sharedWithOrg).toBe(true);
    const stored = storedAccounts();
    expect(stored).toHaveLength(1);
    expect(stored[0].sharedWithOrg).toBe(true);
  });

  it('preserves engagementMemory when reconnecting', async () => {
    const engagementMemory = {
      content: '# Persona',
      lastSyncedAt: '2024-06-01T00:00:00.000Z',
      createdAt: '2024-06-01T00:00:00.000Z',
      updatedAt: '2024-06-01T00:00:00.000Z',
    };
    mockUsers[USER_ID] = {
      userId: USER_ID,
      connected_accounts: [{ ...existingGmailAccount(), engagementMemory }],
    };

    const result = await createAccount(USER_ID, 'gmail' as any, reconnectInput());

    expect(result.engagementMemory).toEqual(engagementMemory);
    expect(storedAccounts()[0].engagementMemory).toEqual(engagementMemory);
  });

  it('preserves unknown top-level fields on the existing entry (forward compatibility)', async () => {
    mockUsers[USER_ID] = {
      userId: USER_ID,
      connected_accounts: [{ ...existingGmailAccount(), futureFlag: 'keep-me' }],
    };

    const result = await createAccount(USER_ID, 'gmail' as any, reconnectInput());

    expect((result as any).futureFlag).toBe('keep-me');
    expect(storedAccounts()[0].futureFlag).toBe('keep-me');
  });

  it('still overrides the refreshed fields on reconnect (config, account_name, updated_at)', async () => {
    mockUsers[USER_ID] = {
      userId: USER_ID,
      connected_accounts: [{ ...existingGmailAccount(), sharedWithOrg: true }],
    };

    const result = await createAccount(USER_ID, 'gmail' as any, reconnectInput());

    expect(result.account_name).toBe('New Name');
    expect((result.config as any).access_token).toBe('fresh-token');
    expect(result.created_at).toBe('2024-01-01T00:00:00.000Z'); // original creation time kept
    expect(result.updated_at).not.toBe('2024-01-01T00:00:00.000Z'); // refreshed
  });

  it('a brand-new account still defaults to private (sharedWithOrg unset)', async () => {
    mockUsers[USER_ID] = {
      userId: USER_ID,
      connected_accounts: [],
    };

    const result = await createAccount(USER_ID, 'gmail' as any, reconnectInput());

    expect(result.sharedWithOrg).toBeUndefined();
    const stored = storedAccounts();
    expect(stored).toHaveLength(1);
    expect(stored[0].sharedWithOrg).toBeUndefined();
  });

  it('does not leak fields across accounts — only the matching platform+account_id entry is updated', async () => {
    const otherAccount = {
      ...existingGmailAccount(),
      account_id: 'acc-gmail-2',
      sharedWithOrg: true,
    };
    mockUsers[USER_ID] = {
      userId: USER_ID,
      connected_accounts: [otherAccount, existingGmailAccount()],
    };

    const result = await createAccount(USER_ID, 'gmail' as any, reconnectInput());

    // acc-gmail-1 had no sharedWithOrg — reconnect must not inherit acc-gmail-2's flag
    expect(result.sharedWithOrg).toBeUndefined();
    const stored = storedAccounts();
    expect(stored).toHaveLength(2);
    expect(stored.find((a: any) => a.account_id === 'acc-gmail-2').sharedWithOrg).toBe(true);
    expect(stored.find((a: any) => a.account_id === 'acc-gmail-1').sharedWithOrg).toBeUndefined();
  });

  it('throws when the user does not exist', async () => {
    await expect(createAccount('missing-user', 'gmail' as any, reconnectInput())).rejects.toThrow(
      'User not found'
    );
  });
});
