/**
 * Unit tests for AgentModeService.listConnectedAccounts() — specifically the
 * is_active field for platform === 'unipile'.
 *
 * Bug context: Unipile (LinkedIn Outreach) accounts are stored with
 * token_expires_at = Number.MAX_SAFE_INTEGER (see linkedInOutreachAuth.ts),
 * since Unipile — not us — owns the session lifecycle. isTokenValid() only
 * performs a live API check for platform === 'linkedin'; for 'unipile' it
 * fell through to the timestamp-only check, which never expires. That made
 * this tool always report is_active: true for Unipile accounts even after
 * the underlying LinkedIn session had died on Unipile's side, so an agent
 * would call search-people against a dead session and get an opaque error
 * ("No client session" / "Unknown error") with no signal that the account
 * needed reconnecting.
 *
 * Fix: for platform === 'unipile', use linkedInOutreachService.getStatusesForAccounts()
 * (the same live check already used by GET /api/oauth/connected-accounts)
 * instead of isTokenValid().
 */

jest.mock('unipile-node-sdk', () => ({
  UnipileClient: jest.fn().mockImplementation(() => ({})),
}), { virtual: true });

jest.mock('../utils/secretsManager', () => ({
  getUnipileCredentials: jest.fn().mockResolvedValue({ dsn: 'https://api.unipile.com', apiKey: 'test-key' }),
  getJwtSecret: jest.fn().mockResolvedValue('test-jwt-secret'),
}));

const mockGetAccountsByUserIdIncludingOrgShared = jest.fn();
const mockIsTokenValid = jest.fn();
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserIdIncludingOrgShared: (...args: any[]) => mockGetAccountsByUserIdIncludingOrgShared(...args),
  isTokenValid: (...args: any[]) => mockIsTokenValid(...args),
}));

const mockGetStatusesForAccounts = jest.fn();
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    getStatusesForAccounts: (...args: any[]) => mockGetStatusesForAccounts(...args),
  },
}));

import { AgentModeService } from '../services/agentModeService';

describe('AgentModeService.listConnectedAccounts', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
  });

  it('reports is_active: false for a unipile account whose Unipile session has died, even though token_expires_at never expires', async () => {
    mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([
      {
        platform: 'unipile',
        account_id: '6JLCSQqJS9-QRADzlcRJcA',
        account_name: 'Fangfang Tan',
        config: { account_type: 'personal', token_expires_at: Number.MAX_SAFE_INTEGER },
      },
    ]);
    mockGetStatusesForAccounts.mockResolvedValue(new Map([['6JLCSQqJS9-QRADzlcRJcA', 'ERROR']]));

    const result = await service.listConnectedAccounts('user-1', 'unipile');

    expect(result.success).toBe(true);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].is_active).toBe(false);
    // The stale timestamp-only check must not be consulted for unipile accounts.
    expect(mockIsTokenValid).not.toHaveBeenCalled();
    expect(mockGetStatusesForAccounts).toHaveBeenCalledWith(['6JLCSQqJS9-QRADzlcRJcA']);
  });

  it('reports is_active: true for a unipile account with a live Unipile session', async () => {
    mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([
      {
        platform: 'unipile',
        account_id: 'acct-live',
        account_name: 'Live Account',
        config: { account_type: 'personal', token_expires_at: Number.MAX_SAFE_INTEGER },
      },
    ]);
    mockGetStatusesForAccounts.mockResolvedValue(new Map([['acct-live', 'OK']]));

    const result = await service.listConnectedAccounts('user-1', 'unipile');

    expect(result.accounts[0].is_active).toBe(true);
  });

  it('does not call getStatusesForAccounts when there are no unipile accounts', async () => {
    mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([
      {
        platform: 'gmail',
        account_id: 'gmail-1',
        account_name: 'user@example.com',
        config: { account_type: 'personal', token_expires_at: Date.now() + 3_600_000 },
      },
    ]);
    mockIsTokenValid.mockResolvedValue(true);

    const result = await service.listConnectedAccounts('user-1', 'all');

    expect(mockGetStatusesForAccounts).not.toHaveBeenCalled();
    expect(mockIsTokenValid).toHaveBeenCalledTimes(1);
    expect(result.accounts[0].is_active).toBe(true);
  });

  it('checks each platform through its own path in a mixed account list', async () => {
    mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([
      {
        platform: 'unipile',
        account_id: 'acct-dead',
        account_name: 'Dead LinkedIn',
        config: { account_type: 'personal', token_expires_at: Number.MAX_SAFE_INTEGER },
      },
      {
        platform: 'gmail',
        account_id: 'gmail-1',
        account_name: 'user@example.com',
        config: { account_type: 'personal', token_expires_at: Date.now() + 3_600_000 },
      },
    ]);
    mockGetStatusesForAccounts.mockResolvedValue(new Map([['acct-dead', 'ERROR']]));
    mockIsTokenValid.mockResolvedValue(true);

    const result = await service.listConnectedAccounts('user-1', 'all');

    const unipileAccount = result.accounts.find((a: any) => a.platform === 'unipile');
    const gmailAccount = result.accounts.find((a: any) => a.platform === 'gmail');
    expect(unipileAccount.is_active).toBe(false);
    expect(gmailAccount.is_active).toBe(true);
  });
});
