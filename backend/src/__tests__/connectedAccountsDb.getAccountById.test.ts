/**
 * Unit tests for getAccountById() platform disambiguation.
 *
 * Bug context: getAccountById(accountId, userId) matched only by account_id, with
 * no platform check. A user who connects both Gmail and Google Drive under the
 * same account_id (same Google email) gets whichever entry happens to appear
 * first in connected_accounts — e.g. a Gmail send call could silently receive
 * the google_drive account's config, failing scope checks like gmail.send even
 * though the real Gmail account has it.
 *
 * Fix: getAccountById gains an optional 3rd `platform` param (single value or
 * array). Callers that pass it get the correctly-disambiguated account; callers
 * that omit it keep today's exact (ambiguous) behavior, so no existing call site
 * breaks.
 */

let mockUsers: Record<string, any> = {};

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn((id: string) => Promise.resolve(mockUsers[id] ?? null)),
  },
}));

import { getAccountById } from '../services/connectedAccountsDb';

const makeAccount = (platform: string, accountId: string) => ({
  platform,
  account_id: accountId,
  account_name: `${platform}-account`,
  config: { account_type: 'personal', access_token: 'tok', token_expires_at: 9999999999999 },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUsers = {};
});

describe('getAccountById', () => {
  it('returns null when user does not exist', async () => {
    const result = await getAccountById('acct-1', 'unknown-user', 'gmail');
    expect(result).toBeNull();
  });

  it('returns null when no account matches the given account_id', async () => {
    mockUsers['user-a'] = {
      userId: 'user-a',
      connected_accounts: [makeAccount('gmail', 'acct-1')],
    };
    const result = await getAccountById('acct-missing', 'user-a', 'gmail');
    expect(result).toBeNull();
  });

  it('returns null when account_id matches but platform does not', async () => {
    mockUsers['user-a'] = {
      userId: 'user-a',
      connected_accounts: [makeAccount('google_drive', 'shared-acct')],
    };
    const result = await getAccountById('shared-acct', 'user-a', 'gmail');
    expect(result).toBeNull();
  });

  it('returns the correctly-disambiguated account when platform is given, even with a collision', async () => {
    mockUsers['user-a'] = {
      userId: 'user-a',
      connected_accounts: [
        makeAccount('google_drive', 'shared-acct'),
        makeAccount('gmail', 'shared-acct'),
      ],
    };
    const result = await getAccountById('shared-acct', 'user-a', 'gmail');
    expect(result).not.toBeNull();
    expect(result!.platform).toBe('gmail');
  });

  it('accepts an array of platforms and matches any of them', async () => {
    mockUsers['user-a'] = {
      userId: 'user-a',
      connected_accounts: [
        makeAccount('google_drive', 'shared-acct'),
        makeAccount('outlook', 'shared-acct'),
      ],
    };
    const result = await getAccountById('shared-acct', 'user-a', ['gmail', 'outlook']);
    expect(result).not.toBeNull();
    expect(result!.platform).toBe('outlook');
  });

  it('preserves today\'s ambiguous first-match behavior when platform is omitted', async () => {
    mockUsers['user-a'] = {
      userId: 'user-a',
      connected_accounts: [
        makeAccount('google_drive', 'shared-acct'),
        makeAccount('gmail', 'shared-acct'),
      ],
    };
    const result = await getAccountById('shared-acct', 'user-a');
    expect(result).not.toBeNull();
    expect(result!.platform).toBe('google_drive');
  });
});
