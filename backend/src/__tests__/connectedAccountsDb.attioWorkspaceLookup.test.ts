/**
 * Unit tests for getAccountsByAttioWorkspaceId() — resolves every AgentWeb
 * account matching a given Attio workspace_id, for the incoming shared
 * webhook receiver (ENG-1380). Mirrors getAccountsByCalendlyUserUri's
 * multi-match pattern (ENG-994): returns every match, not just the first,
 * so the webhook receiver can try each candidate's own webhook_signing_key
 * against a delivery's signature rather than committing to a single guess.
 */

let mockUsers: any[] = [];
let mockScanWithFilterImpl: () => Promise<any[]> = () => Promise.resolve(mockUsers);

jest.mock('../services/db', () => ({
  userDb: {
    // Deliberately scanWithFilter, not getAllUsers() — the latter also starts
    // three count queries per user (tasks/workflows/chat sessions), an
    // unnecessary N+1 on this webhook-triggered lookup.
    scanWithFilter: (...args: any[]) => mockScanWithFilterImpl(),
  },
}));

import { getAccountsByAttioWorkspaceId } from '../services/connectedAccountsDb';

const makeAttioAccount = (workspaceId: string, signingKey = 'signing-key-abc') => ({
  platform: 'attio',
  account_id: `attio-${workspaceId}`,
  account_name: 'Test Attio Workspace',
  config: {
    account_type: 'oauth',
    access_token: 'tok',
    token_expires_at: 9999999999999,
    workspace_id: workspaceId,
    workspace_name: 'Test Workspace',
    webhook_id: 'wh_1',
    webhook_signing_key: signingKey,
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUsers = [];
  mockScanWithFilterImpl = () => Promise.resolve(mockUsers);
});

describe('getAccountsByAttioWorkspaceId', () => {
  it('returns an empty array when there are no users', async () => {
    const result = await getAccountsByAttioWorkspaceId('ws-target');
    expect(result).toEqual([]);
  });

  it('returns an empty array when users exist but none have an attio account', async () => {
    mockUsers = [
      { userId: 'user-a', connected_accounts: [] },
      { userId: 'user-b', connected_accounts: [{ platform: 'gmail', account_id: 'x', account_name: 'x', config: {} }] },
    ];
    const result = await getAccountsByAttioWorkspaceId('ws-target');
    expect(result).toEqual([]);
  });

  it('returns an empty array when a user has an attio account with a different workspace_id', async () => {
    mockUsers = [
      { userId: 'user-a', connected_accounts: [makeAttioAccount('ws-other')] },
    ];
    const result = await getAccountsByAttioWorkspaceId('ws-target');
    expect(result).toEqual([]);
  });

  it('returns the userId and account when workspace_id matches exactly one account', async () => {
    mockUsers = [
      { userId: 'user-a', connected_accounts: [makeAttioAccount('ws-other')] },
      { userId: 'user-b', connected_accounts: [makeAttioAccount('ws-target')] },
    ];
    const result = await getAccountsByAttioWorkspaceId('ws-target');
    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe('user-b');
    expect(result[0].account.platform).toBe('attio');
    expect((result[0].account.config as any).workspace_id).toBe('ws-target');
  });

  it('returns every matching account across different tenants sharing the same workspace_id', async () => {
    mockUsers = [
      { userId: 'tenant-a', connected_accounts: [makeAttioAccount('ws-target', 'tenant-a-key')] },
      { userId: 'tenant-b', connected_accounts: [makeAttioAccount('ws-target', 'tenant-b-key')] },
    ];
    const result = await getAccountsByAttioWorkspaceId('ws-target');
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.userId).sort()).toEqual(['tenant-a', 'tenant-b']);
    expect(result.map((r) => (r.account.config as any).webhook_signing_key).sort()).toEqual(['tenant-a-key', 'tenant-b-key']);
  });

  it('returns an empty array when userDb.scanWithFilter throws', async () => {
    mockScanWithFilterImpl = () => Promise.reject(new Error('DynamoDB unavailable'));
    const result = await getAccountsByAttioWorkspaceId('ws-target');
    expect(result).toEqual([]);
  });
});
