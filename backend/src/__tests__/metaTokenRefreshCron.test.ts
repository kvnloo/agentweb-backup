/**
 * Tests for the proactive Meta token-refresh cron.
 *
 * Verifies the cron enumerates users, only attempts refresh for in-window Meta
 * ad accounts, tallies results correctly, and is resilient to per-user errors.
 */

jest.mock('../services/db', () => ({
  userDb: {
    getAllUsers: jest.fn(),
  },
}));

const mockSyncMetaAdsCapability = jest.fn().mockResolvedValue({ outcome: 'unchanged' });
jest.mock('../services/metaAdsCapabilitySync', () => ({
  syncMetaAdsCapability: (...args: any[]) => mockSyncMetaAdsCapability(...args),
}));

jest.mock('../services/metaTokenRefresh', () => {
  const actual = jest.requireActual('../services/metaTokenRefresh');
  return {
    ...actual,
    ensureFreshMetaAdAccountToken: jest.fn(),
  };
});

import { runMetaTokenRefresh } from '../cron/metaTokenRefreshCron';
import { userDb } from '../services/db';
import { ensureFreshMetaAdAccountToken } from '../services/metaTokenRefresh';

const FAR_FUTURE = Date.now() + 60 * 24 * 60 * 60 * 1000;
const SOON = Date.now() + 1000;

function metaAd(id: string, expiresAt: number, platform = 'meta') {
  return {
    platform,
    account_id: id,
    account_name: `Acct ${id}`,
    config: { account_type: 'ad_account', ad_account_id: id, access_token: 'tok', token_expires_at: expiresAt },
    created_at: '', updated_at: '',
  };
}

describe('runMetaTokenRefresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSyncMetaAdsCapability.mockResolvedValue({ outcome: 'unchanged' });
  });

  /**
   * ENG-1158. A token expires on a 60-day clock; an Ads permission grant can be
   * withdrawn or restored at any moment. Reconciling only the accounts due for a
   * token refresh would leave a connection that lost its ads scope today
   * undetected for up to 46 days.
   */
  describe('ads capability reconciliation', () => {
    it('reconciles every Meta ad account, including ones nowhere near expiry', async () => {
      (userDb.getAllUsers as jest.Mock).mockResolvedValue([
        { userId: 'u1', connected_accounts: [metaAd('act-fresh', FAR_FUTURE)] },
      ]);
      (ensureFreshMetaAdAccountToken as jest.Mock).mockResolvedValue({ attempted: false, refreshed: false });

      const summary = await runMetaTokenRefresh();

      expect(mockSyncMetaAdsCapability).toHaveBeenCalledTimes(1);
      expect(mockSyncMetaAdsCapability).toHaveBeenCalledWith(
        expect.objectContaining({ account_id: 'act-fresh' }),
        'u1'
      );
      // ...and it genuinely was not due for a token refresh.
      expect(summary.dueForRefresh).toBe(0);
      expect(ensureFreshMetaAdAccountToken).not.toHaveBeenCalled();
    });

    it('tallies revocations and recoveries separately', async () => {
      (userDb.getAllUsers as jest.Mock).mockResolvedValue([
        { userId: 'u1', connected_accounts: [metaAd('lost', FAR_FUTURE), metaAd('back', FAR_FUTURE)] },
      ]);
      mockSyncMetaAdsCapability
        .mockResolvedValueOnce({ outcome: 'revoked' })
        .mockResolvedValueOnce({ outcome: 'recovered' });

      const summary = await runMetaTokenRefresh();

      expect(summary.adsScopeRevoked).toBe(1);
      expect(summary.adsScopeRecovered).toBe(1);
    });

    it('still refreshes the token when the capability check blows up', async () => {
      // The capability check is an addition to this cron's job, not a gate on it.
      (userDb.getAllUsers as jest.Mock).mockResolvedValue([
        { userId: 'u1', connected_accounts: [metaAd('act1', SOON)] },
      ]);
      mockSyncMetaAdsCapability.mockRejectedValue(new Error('unexpected'));
      (ensureFreshMetaAdAccountToken as jest.Mock).mockResolvedValue({ attempted: true, refreshed: true });

      const summary = await runMetaTokenRefresh();

      expect(summary.refreshed).toBe(1);
      expect(summary.adsScopeRevoked).toBe(0);
    });
  });

  it('returns empty summary and does not throw when user enumeration fails', async () => {
    (userDb.getAllUsers as jest.Mock).mockRejectedValue(new Error('dynamo down'));
    const summary = await runMetaTokenRefresh();
    expect(summary.scannedUsers).toBe(0);
    expect(ensureFreshMetaAdAccountToken).not.toHaveBeenCalled();
  });

  it('skips non-Meta and far-from-expiry accounts; refreshes only those in window', async () => {
    (userDb.getAllUsers as jest.Mock).mockResolvedValue([
      {
        userId: 'u1',
        connected_accounts: [
          metaAd('act1', SOON), // due
          metaAd('act2', FAR_FUTURE), // not due
          { platform: 'gmail', account_id: 'g1', config: { account_type: 'personal', access_token: 't', token_expires_at: SOON } },
        ],
      },
      { userId: 'u2', connected_accounts: [metaAd('act3', SOON, 'facebook')] }, // legacy platform, due
      { userId: 'u3', connected_accounts: undefined },
    ]);
    (ensureFreshMetaAdAccountToken as jest.Mock).mockResolvedValue({ attempted: true, refreshed: true });

    const summary = await runMetaTokenRefresh();

    expect(summary.scannedUsers).toBe(3);
    expect(summary.metaAccounts).toBe(3); // act1, act2, act3
    expect(summary.dueForRefresh).toBe(2); // act1, act3
    expect(summary.refreshed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(ensureFreshMetaAdAccountToken).toHaveBeenCalledTimes(2);
  });

  it('counts failed refreshes', async () => {
    (userDb.getAllUsers as jest.Mock).mockResolvedValue([
      { userId: 'u1', connected_accounts: [metaAd('act1', SOON)] },
    ]);
    (ensureFreshMetaAdAccountToken as jest.Mock).mockResolvedValue({ attempted: true, refreshed: false, error: 'too old' });

    const summary = await runMetaTokenRefresh();
    expect(summary.dueForRefresh).toBe(1);
    expect(summary.refreshed).toBe(0);
    expect(summary.failed).toBe(1);
  });
});
