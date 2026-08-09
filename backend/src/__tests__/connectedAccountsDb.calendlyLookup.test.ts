/**
 * Unit tests for getAccountsByCalendlyUserUri() — resolves every AgentWeb
 * account matching a given Calendly user_uri, for the incoming webhook
 * receiver (ENG-524). Mirrors getUserIdByHubSpotPortalId's full-scan pattern,
 * but returns every match (not just the first) alongside its userId and
 * config — two different tenants can independently connect the same
 * underlying Calendly identity, and the webhook receiver needs to try each
 * candidate's own webhook_signing_key against a delivery's signature (ENG-994).
 */

let mockUsers: any[] = [];
let mockGetAllUsersImpl: () => Promise<any[]> = () => Promise.resolve(mockUsers);

jest.mock('../services/db', () => ({
  userDb: {
    getAllUsers: (...args: any[]) => mockGetAllUsersImpl(),
  },
}));

import { getAccountsByCalendlyUserUri } from '../services/connectedAccountsDb';

const makeCalendlyAccount = (userUri: string, signingKey = 'signing-key-abc') => ({
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
    webhook_signing_key: signingKey,
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUsers = [];
  mockGetAllUsersImpl = () => Promise.resolve(mockUsers);
});

describe('getAccountsByCalendlyUserUri', () => {
  it('returns an empty array when there are no users', async () => {
    const result = await getAccountsByCalendlyUserUri('https://api.calendly.com/users/target');
    expect(result).toEqual([]);
  });

  it('returns an empty array when users exist but none have a calendly account', async () => {
    mockUsers = [
      { userId: 'user-a', connected_accounts: [] },
      { userId: 'user-b', connected_accounts: [{ platform: 'gmail', account_id: 'x', account_name: 'x', config: {} }] },
    ];
    const result = await getAccountsByCalendlyUserUri('https://api.calendly.com/users/target');
    expect(result).toEqual([]);
  });

  it('returns an empty array when a user has a calendly account with a different user_uri', async () => {
    mockUsers = [
      { userId: 'user-a', connected_accounts: [makeCalendlyAccount('https://api.calendly.com/users/other')] },
    ];
    const result = await getAccountsByCalendlyUserUri('https://api.calendly.com/users/target');
    expect(result).toEqual([]);
  });

  it('returns the userId and account when user_uri matches exactly one account', async () => {
    const targetUri = 'https://api.calendly.com/users/target';
    mockUsers = [
      { userId: 'user-a', connected_accounts: [makeCalendlyAccount('https://api.calendly.com/users/other')] },
      { userId: 'user-b', connected_accounts: [makeCalendlyAccount(targetUri)] },
    ];
    const result = await getAccountsByCalendlyUserUri(targetUri);
    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe('user-b');
    expect(result[0].account.platform).toBe('calendly');
    expect((result[0].account.config as any).user_uri).toBe(targetUri);
  });

  // ENG-994: the core case this function exists to fix — two different tenants
  // independently connecting the same underlying Calendly identity.
  it('returns every matching account across different tenants sharing the same user_uri', async () => {
    const targetUri = 'https://api.calendly.com/users/target';
    mockUsers = [
      { userId: 'tenant-a', connected_accounts: [makeCalendlyAccount(targetUri, 'tenant-a-key')] },
      { userId: 'tenant-b', connected_accounts: [makeCalendlyAccount(targetUri, 'tenant-b-key')] },
    ];
    const result = await getAccountsByCalendlyUserUri(targetUri);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.userId).sort()).toEqual(['tenant-a', 'tenant-b']);
    expect(result.map((r) => (r.account.config as any).webhook_signing_key).sort()).toEqual(['tenant-a-key', 'tenant-b-key']);
  });

  it('returns an empty array when userDb.getAllUsers throws', async () => {
    mockGetAllUsersImpl = () => Promise.reject(new Error('DynamoDB unavailable'));
    const result = await getAccountsByCalendlyUserUri('https://api.calendly.com/users/target');
    expect(result).toEqual([]);
  });
});
