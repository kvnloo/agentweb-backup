/**
 * Unit tests for getAccountByCalendlyUserUri() — resolves which AgentWeb user
 * owns a given Calendly user_uri, for the incoming webhook receiver (ENG-524).
 * Mirrors getUserIdByHubSpotPortalId's full-scan pattern, but returns both the
 * userId and the matched account/config in one pass (the webhook handler needs
 * the account's webhook_signing_key immediately after resolving the user, and
 * a user could in principle have multiple Calendly accounts connected).
 */

let mockUsers: any[] = [];
let mockGetAllUsersImpl: () => Promise<any[]> = () => Promise.resolve(mockUsers);

jest.mock('../services/db', () => ({
  userDb: {
    getAllUsers: (...args: any[]) => mockGetAllUsersImpl(),
  },
}));

import { getAccountByCalendlyUserUri } from '../services/connectedAccountsDb';

const makeCalendlyAccount = (userUri: string) => ({
  platform: 'calendly',
  account_id: `${userUri}@example.com`,
  account_name: 'Test Calendly Account',
  config: {
    account_type: 'calendly',
    access_token: 'tok',
    token_expires_at: 9999999999999,
    user_uri: userUri,
    organization_uri: 'https://api.calendly.com/organizations/org-1',
    booking_tracking_active: true,
    webhook_signing_key: 'signing-key-abc',
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUsers = [];
  mockGetAllUsersImpl = () => Promise.resolve(mockUsers);
});

describe('getAccountByCalendlyUserUri', () => {
  it('returns null when there are no users', async () => {
    const result = await getAccountByCalendlyUserUri('https://api.calendly.com/users/target');
    expect(result).toBeNull();
  });

  it('returns null when users exist but none have a calendly account', async () => {
    mockUsers = [
      { userId: 'user-a', connected_accounts: [] },
      { userId: 'user-b', connected_accounts: [{ platform: 'gmail', account_id: 'x', account_name: 'x', config: {} }] },
    ];
    const result = await getAccountByCalendlyUserUri('https://api.calendly.com/users/target');
    expect(result).toBeNull();
  });

  it('returns null when a user has a calendly account with a different user_uri', async () => {
    mockUsers = [
      { userId: 'user-a', connected_accounts: [makeCalendlyAccount('https://api.calendly.com/users/other')] },
    ];
    const result = await getAccountByCalendlyUserUri('https://api.calendly.com/users/target');
    expect(result).toBeNull();
  });

  it('returns the userId and account when user_uri matches', async () => {
    const targetUri = 'https://api.calendly.com/users/target';
    mockUsers = [
      { userId: 'user-a', connected_accounts: [makeCalendlyAccount('https://api.calendly.com/users/other')] },
      { userId: 'user-b', connected_accounts: [makeCalendlyAccount(targetUri)] },
    ];
    const result = await getAccountByCalendlyUserUri(targetUri);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-b');
    expect(result!.account.platform).toBe('calendly');
    expect((result!.account.config as any).user_uri).toBe(targetUri);
  });

  it('returns null when userDb.getAllUsers throws', async () => {
    mockGetAllUsersImpl = () => Promise.reject(new Error('DynamoDB unavailable'));
    const result = await getAccountByCalendlyUserUri('https://api.calendly.com/users/target');
    expect(result).toBeNull();
  });
});
