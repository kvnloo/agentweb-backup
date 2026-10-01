/**
 * Tests for client health assessment tools:
 * - assessClientHealth(callerUserId, clientNameOrEmail)
 * - listAllClients(callerUserId)
 */

// Mock dependencies
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
    getAllUsers: jest.fn(),
  },
}));

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
}));

jest.mock('../services/v0Service', () => ({
  getLandingPagesByOwner: jest.fn().mockResolvedValue([]),
  getLandingPagesByOrg: jest.fn().mockResolvedValue([]),
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-token'),
}));

jest.mock('../utils/metaApiFetch', () => ({
  fetchWithRetryAndPaging: jest.fn().mockResolvedValue({ data: [] }),
}));

jest.mock('../services/adsThresholdsDb', () => ({
  getThresholdsForAccount: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/metaTokenRefresh', () => ({
  ensureFreshMetaAdAccountToken: jest.fn().mockResolvedValue({ attempted: false, refreshed: false }),
}));

import { assessClientHealth, listAllClients, classifyMetaAdConnection } from '../services/clientHealthService';
import { fetchWithRetryAndPaging as metaFetch } from '../utils/metaApiFetch';

const mockedMetaFetch = jest.mocked(metaFetch);

const { userDb } = require('../services/db');
const { getAccountsByUserId } = require('../services/connectedAccountsDb');
const { getLandingPagesByOwner, getLandingPagesByOrg } = require('../services/v0Service');
const { ensureFreshMetaAdAccountToken } = require('../services/metaTokenRefresh');

describe('Client Health - assessClientHealth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // FAIL test 1: Non-admin user should be rejected
  it('should reject non-admin users', async () => {
    const callerUserId = 'non-admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: callerUserId,
      email: 'user@example.com',
      isAdmin: false,
    });

    const result = await assessClientHealth(callerUserId, 'client@example.com');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/admin/i);
  });

  // FAIL test 2: Client not found
  it('should return error when client is not found', async () => {
    const adminUserId = 'admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce(undefined);
    (userDb.getAllUsers as jest.Mock).mockResolvedValueOnce([]);

    const result = await assessClientHealth(adminUserId, 'nonexistent@example.com');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('never treats a sandbox principal found by email as a client (ENG-1907)', async () => {
    const adminUserId = 'admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: adminUserId, email: 'admin@example.com', isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({ userId: 'eval_take-home', email: 'candidate@example.invalid', connected_accounts: [] });
    (userDb.getAllUsers as jest.Mock).mockResolvedValueOnce([]);

    const result = await assessClientHealth(adminUserId, 'candidate@example.invalid');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  // ENG-2133 (ENG-2128 T1): never connecting an ad account is an activation state,
  // not a blocked/at-risk (churn) state. This test previously asserted /blocked|at-risk/.
  it('reports onboarding (activation), not blocked/at-risk, when the client never connected an ad account', async () => {
    const adminUserId = 'admin-user';
    const clientUserId = 'client-user';

    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: clientUserId,
      email: 'client@example.com',
      displayName: 'Client User',
      isAdmin: false,
      adAccount: '',
    });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);

    const result = await assessClientHealth(adminUserId, 'client@example.com');

    expect(result.success).toBe(true);
    expect(result.health.ads_layer.connected).toBe(false);
    expect(result.health.ads_layer.connection).toBe('never_connected');
    expect(result.health.status).toBe('onboarding');
    expect(result.health.status_reasons.join(' ')).toMatch(/activation/i);
  });

  // ENG-2188: an expired connection is reconnect work, not churn evidence. This test previously
  // asserted 'at-risk'.
  it('reports needs-attention (not at-risk) with the expiry date when the only Meta ad account token has expired', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: 'admin-user', isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: 'client-user',
      email: 'client@example.com',
      displayName: 'Client User',
      adAccount: '',
    });
    const expiredAt = Date.parse('2026-09-15T20:52:34.993Z');
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
      {
        platform: 'meta',
        config: { account_type: 'ad_account', ad_account_id: 'act_1', access_token: 'tok', token_expires_at: expiredAt },
      },
    ]);

    const result = await assessClientHealth('admin-user', 'client@example.com');

    expect(result.success).toBe(true);
    expect(result.health.ads_layer.connection).toBe('expired');
    expect(result.health.ads_layer.connection_all_platforms).toBe('expired');
    expect(result.health.status).toBe('needs-attention');
    expect(result.health.status_reasons.join(' ')).toContain('2026-09-15T20:52:34.993Z');
    expect(result.health.status_reasons.join(' ')).toMatch(/reconnect needed/);
  });

  it('ENG-2188: an expired Meta token is not a whole-account expiry while Google Ads is still connected', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: 'admin-user', isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: 'client-user', email: 'client@example.com', adAccount: '', productDomain: 'client.example', emailDomain: 'client.example',
    });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
      { platform: 'meta', config: { account_type: 'ad_account', ad_account_id: 'act_1', access_token: 'tok', token_expires_at: 1 } },
      { platform: 'google_ads', config: { account_type: 'google_ads', refresh_token: 'r', token_expires_at: 1 } },
    ]);

    const result = await assessClientHealth('admin-user', 'client@example.com');

    expect(result.health.ads_layer.connection).toBe('expired');
    expect(result.health.ads_layer.connection_all_platforms).toBe('connected');
    expect(['at-risk', 'needs-attention']).not.toContain(result.health.status);
    expect(result.health.status_reasons.join(' ')).toMatch(/Meta ad account connection expired .* still connected on another platform/);
  });

  it('ENG-2188: an expired Google Ads-only connection needs attention (every platform is checked, not just Meta)', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: 'admin-user', isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({ userId: 'client-user', email: 'client@example.com', adAccount: '' });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
      { platform: 'google_ads', config: { account_type: 'google_ads', token_expires_at: Date.parse('2026-09-01T00:00:00.000Z') } },
    ]);

    const result = await assessClientHealth('admin-user', 'client@example.com');

    expect(result.health.ads_layer.connection).toBe('other_platform');
    expect(result.health.ads_layer.connection_all_platforms).toBe('expired');
    expect(result.health.ads_layer.all_platforms_expired_at).toBe('2026-09-01T00:00:00.000Z');
    expect(result.health.status).toBe('needs-attention');
  });

  it('does not call a Google/LinkedIn Ads client onboarding or blocked when Meta is absent', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: 'admin-user', isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({ userId: 'client-user', email: 'client@example.com', adAccount: '' });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
      { platform: 'google_ads', config: { account_type: 'google_ads', refresh_token: 'r', token_expires_at: 1 } },
      { platform: 'linkedin_ads', config: { account_type: 'ad_account', refresh_token: 'r', token_expires_at: 1 } },
    ]);

    const result = await assessClientHealth('admin-user', 'client@example.com');

    expect(result.health.ads_layer.connection).toBe('other_platform');
    expect(['onboarding', 'blocked', 'at-risk']).not.toContain(result.health.status);
    expect(result.health.status_reasons.join(' ')).not.toMatch(/activation|ad account/i);
    expect(mockedMetaFetch).not.toHaveBeenCalled();
  });

  it('reads campaigns through the first usable Meta account, not a stale first record (#3070 review)', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: 'admin-user', isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({ userId: 'client-user', email: 'client@example.com', adAccount: '' });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
      { platform: 'meta', config: { account_type: 'ad_account', ad_account_id: '111111', access_token: 'stale', token_expires_at: 1 } },
      { platform: 'meta', config: { account_type: 'ad_account', ad_account_id: '222222', access_token: 'fresh', token_expires_at: Date.now() + 86_400_000 } },
    ]);
    mockedMetaFetch.mockResolvedValueOnce({ data: [] });

    const result = await assessClientHealth('admin-user', 'client@example.com');

    expect(result.health.ads_layer.connection).toBe('connected');
    expect(mockedMetaFetch).toHaveBeenCalledWith(expect.stringContaining('act_222222/campaigns'));
    expect(mockedMetaFetch).toHaveBeenCalledWith(expect.stringContaining('access_token=fresh'));
    expect(result.health.ads_layer.ad_account_id).toBe('222222');
  });

  it('skips an unexpired record that lacks fetch credentials for a later complete one (#3070 review)', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: 'admin-user', isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({ userId: 'client-user', email: 'client@example.com', adAccount: '' });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
      { platform: 'meta', config: { account_type: 'ad_account', ad_account_id: '444444' } },
      { platform: 'meta', config: { account_type: 'ad_account', ad_account_id: '666666', access_token: 'complete' } },
    ]);
    mockedMetaFetch.mockResolvedValueOnce({ data: [] });

    const result = await assessClientHealth('admin-user', 'client@example.com');

    expect(mockedMetaFetch).toHaveBeenCalledWith(expect.stringContaining('act_666666/campaigns'));
    expect(mockedMetaFetch).toHaveBeenCalledWith(expect.stringContaining('access_token=complete'));
    expect(result.health.ads_layer.ad_account_id).toBe('666666');
  });

  it('reads through the legacy adAccount when the only connected account has expired', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: 'admin-user', isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({ userId: 'client-user', email: 'client@example.com', adAccount: '555555' });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
      { platform: 'meta', config: { account_type: 'ad_account', ad_account_id: '111111', access_token: 'stale', token_expires_at: 1 } },
    ]);
    mockedMetaFetch.mockResolvedValueOnce({ data: [] });

    const result = await assessClientHealth('admin-user', 'client@example.com');

    expect(result.health.ads_layer.connection).toBe('connected');
    expect(mockedMetaFetch).toHaveBeenCalledWith(expect.stringContaining('act_555555/campaigns'));
    expect(mockedMetaFetch).not.toHaveBeenCalledWith(expect.stringContaining('access_token=stale'));
  });

  it('does not report a confirmed zero-campaign status when the campaign read failed (#3070 review)', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: 'admin-user', isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({ userId: 'client-user', email: 'client@example.com', adAccount: '' });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
      { platform: 'meta', config: { account_type: 'ad_account', ad_account_id: '333333', access_token: 'tok' } },
    ]);
    mockedMetaFetch.mockResolvedValueOnce({ error: { message: 'permission denied' } });

    const result = await assessClientHealth('admin-user', 'client@example.com');

    expect(result.health.ads_layer.campaigns_complete).toBe(false);
    expect(result.health.status).not.toBe('blocked');
    expect(result.health.status_reasons.join(' ')).toMatch(/could not be read/i);
    expect(result.health.status_reasons).not.toContain('No active ad campaigns');
  });


  // SUCCESS test: Full health assessment for a client with connected accounts
  it('should return full health assessment for a connected client', async () => {
    const adminUserId = 'admin-user';
    const clientUserId = 'client-user';

    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });

    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: clientUserId,
      email: 'client@example.com',
      displayName: 'Client User',
      isAdmin: false,
      adAccount: '123456',
    });

    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
      {
        platform: 'meta',
        account_id: 'meta-123',
        account_name: 'Meta Ads',
        config: { account_type: 'ad_account', ad_account_id: '123456', access_token: 'tok' },
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
      },
      {
        platform: 'linkedin',
        account_id: 'li-123',
        account_name: 'LinkedIn',
        config: { account_type: 'personal', access_token: 'tok' },
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
      },
    ]);

    // Mock the campaigns list and ad-level data fetches
    const { fetchWithRetryAndPaging } = require('../utils/metaApiFetch');
    (fetchWithRetryAndPaging as jest.Mock)
      .mockResolvedValueOnce({
        data: [
          { id: 'camp1', name: 'Campaign 1', status: 'ACTIVE', objective: 'OUTCOME_LEADS' },
          { id: 'camp2', name: 'Campaign 2', status: 'ACTIVE', objective: 'OUTCOME_TRAFFIC' },
        ],
      })
      .mockResolvedValueOnce({
        data: [
          { id: 'ad1', name: 'Ad 1', creative: { id: 'cr1' }, status: 'ACTIVE', insights: { data: [{ spend: '50' }] } },
          { id: 'ad2', name: 'Ad 2', creative: { id: 'cr2' }, status: 'ACTIVE', insights: { data: [{ spend: '40' }] } },
          { id: 'ad3', name: 'Ad 3', creative: { id: 'cr3' }, status: 'ACTIVE', insights: { data: [{ spend: '10' }] } },
        ],
      });

    const result = await assessClientHealth(adminUserId, 'client@example.com');

    expect(result.success).toBe(true);
    expect(result.health).toBeDefined();
    expect(result.health.client).toEqual({
      userId: clientUserId,
      email: 'client@example.com',
      displayName: 'Client User',
    });
    expect(result.health.ads_layer.connected).toBe(true);
    expect(result.health.ads_layer.active_campaigns).toBe(2);
    expect(result.health.ads_layer.campaigns_complete).toBe(true);
    expect(result.health.creative_variety.distinct_creatives).toBe(3);
    expect(result.health.status).toBeDefined();
    expect(['healthy', 'mediocre', 'at-risk', 'blocked']).toContain(result.health.status);
  });

  // ENG-1767: the client's OWN connected Meta token, account id resolution, and precedence
  // against the legacy `adAccount` field.
  describe('ENG-1767 — connected-account token and account-id precedence', () => {
    const { getMetaAccessToken } = require('../utils/secretsManager');
    const { fetchWithRetryAndPaging } = require('../utils/metaApiFetch');

    function mockAdmin() {
      (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: 'admin-user', isAdmin: true });
    }

    it('uses the client\'s own connected token, not the shared app-wide token', async () => {
      mockAdmin();
      (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
        userId: 'client-user',
        email: 'client@example.com',
        displayName: 'Client User',
        isAdmin: false,
        adAccount: '',
      });
      (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
        {
          platform: 'meta',
          account_id: 'meta-999',
          account_name: 'Client Meta Ads',
          config: { account_type: 'ad_account', ad_account_id: '999999', access_token: 'clients-own-token' },
          created_at: '2024-01-01',
          updated_at: '2024-01-01',
        },
      ]);
      (fetchWithRetryAndPaging as jest.Mock).mockResolvedValueOnce({ data: [] });

      const result = await assessClientHealth('admin-user', 'client@example.com');

      expect(result.success).toBe(true);
      expect(getMetaAccessToken).not.toHaveBeenCalled();
      expect(fetchWithRetryAndPaging).toHaveBeenCalledWith(
        expect.stringContaining('act_999999/campaigns')
      );
      expect(fetchWithRetryAndPaging).toHaveBeenCalledWith(
        expect.stringContaining('access_token=clients-own-token')
      );
      expect(result.health.ads_layer.ad_account_id).toBe('999999');
    });

    it('falls back to the shared token only when there is no connected Meta account (legacy-only)', async () => {
      mockAdmin();
      (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
        userId: 'client-user',
        email: 'client@example.com',
        displayName: 'Client User',
        isAdmin: false,
        adAccount: '777777',
      });
      (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);
      (fetchWithRetryAndPaging as jest.Mock).mockResolvedValueOnce({ data: [] });

      const result = await assessClientHealth('admin-user', 'client@example.com');

      expect(result.success).toBe(true);
      expect(getMetaAccessToken).toHaveBeenCalledTimes(1);
      expect(fetchWithRetryAndPaging).toHaveBeenCalledWith(
        expect.stringContaining('act_777777/campaigns')
      );
      expect(result.health.ads_layer.ad_account_id).toBe('777777');
    });

    it('mutation: prefers the connected account over a DIFFERING legacy adAccount field, consistently everywhere the id is used', async () => {
      mockAdmin();
      (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
        userId: 'client-user',
        email: 'client@example.com',
        displayName: 'Client User',
        isAdmin: false,
        adAccount: '111111', // legacy field — must NOT win when a connected account exists
      });
      (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
        {
          platform: 'meta',
          account_id: 'meta-222',
          account_name: 'Client Meta Ads',
          config: { account_type: 'ad_account', ad_account_id: '222222', access_token: 'clients-own-token' },
          created_at: '2024-01-01',
          updated_at: '2024-01-01',
        },
      ]);
      (fetchWithRetryAndPaging as jest.Mock).mockResolvedValueOnce({ data: [] });

      const result = await assessClientHealth('admin-user', 'client@example.com');

      // The connected account's id must win — in the fetch URL AND in the reported ad_account_id —
      // never the legacy field, and never disagreeing between the two.
      expect(fetchWithRetryAndPaging).toHaveBeenCalledWith(
        expect.stringContaining('act_222222/campaigns')
      );
      expect(result.health.ads_layer.ad_account_id).toBe('222222');
      expect(getMetaAccessToken).not.toHaveBeenCalled();
    });

    // Review-flagged bug: id and token were previously resolved as two INDEPENDENT `||` chains,
    // not a genuine matched pair. A connected account with a real ad_account_id but an empty
    // access_token would pick the connected id (only checked ad_account_id) paired with the
    // SHARED token (access_token was falsy) — silently reintroducing the exact bug this PR fixes.
    it('falls back to the legacy id + shared token TOGETHER when the connected account has no usable token, never mixing the two', async () => {
      mockAdmin();
      (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
        userId: 'client-user',
        email: 'client@example.com',
        displayName: 'Client User',
        isAdmin: false,
        adAccount: '333333',
      });
      (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
        {
          platform: 'meta',
          account_id: 'meta-444',
          account_name: 'Client Meta Ads',
          // ad_account_id is real, but access_token is falsy — must NOT be treated as usable.
          config: { account_type: 'ad_account', ad_account_id: '444444', access_token: '' },
          created_at: '2024-01-01',
          updated_at: '2024-01-01',
        },
      ]);
      (fetchWithRetryAndPaging as jest.Mock).mockResolvedValueOnce({ data: [] });

      const result = await assessClientHealth('admin-user', 'client@example.com');

      // Must use the LEGACY id (333333), not the connected account's id (444444) — using
      // 444444 with the shared token would be exactly the bug this PR exists to fix.
      expect(fetchWithRetryAndPaging).toHaveBeenCalledWith(
        expect.stringContaining('act_333333/campaigns')
      );
      expect(fetchWithRetryAndPaging).not.toHaveBeenCalledWith(
        expect.stringContaining('act_444444')
      );
      expect(result.health.ads_layer.ad_account_id).toBe('333333');
      expect(getMetaAccessToken).toHaveBeenCalledTimes(1);
      expect(ensureFreshMetaAdAccountToken).not.toHaveBeenCalled();
    });

    it('refreshes the connected token before reading it, and uses the REFRESHED value, not the stale pre-refresh one', async () => {
      mockAdmin();
      (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
        userId: 'client-user',
        email: 'client@example.com',
        displayName: 'Client User',
        isAdmin: false,
        adAccount: '',
      });
      const connectedAccount = {
        platform: 'meta',
        account_id: 'meta-555',
        account_name: 'Client Meta Ads',
        config: { account_type: 'ad_account', ad_account_id: '555555', access_token: 'stale-token' },
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
      };
      (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([connectedAccount]);
      // Simulate a successful refresh: ensureFreshMetaAdAccountToken mutates config in place,
      // exactly like the real implementation does on success.
      (ensureFreshMetaAdAccountToken as jest.Mock).mockImplementationOnce(async (account: any) => {
        account.config.access_token = 'freshly-refreshed-token';
        return { attempted: true, refreshed: true };
      });
      (fetchWithRetryAndPaging as jest.Mock).mockResolvedValueOnce({ data: [] });

      const result = await assessClientHealth('admin-user', 'client@example.com');

      expect(ensureFreshMetaAdAccountToken).toHaveBeenCalledWith(connectedAccount, 'client-user');
      expect(fetchWithRetryAndPaging).toHaveBeenCalledWith(
        expect.stringContaining('access_token=freshly-refreshed-token')
      );
      expect(fetchWithRetryAndPaging).not.toHaveBeenCalledWith(
        expect.stringContaining('access_token=stale-token')
      );
      expect(getMetaAccessToken).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('uses the resolved account id for the thresholds lookup too (the third reuse site), not just the campaigns fetch', async () => {
      mockAdmin();
      (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
        userId: 'client-user',
        email: 'client@example.com',
        displayName: 'Client User',
        isAdmin: false,
        adAccount: '666666', // legacy field — a differing id, must NOT be what thresholds are looked up under
      });
      (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
        {
          platform: 'meta',
          account_id: 'meta-888',
          account_name: 'Client Meta Ads',
          config: { account_type: 'ad_account', ad_account_id: '888888', access_token: 'clients-own-token' },
          created_at: '2024-01-01',
          updated_at: '2024-01-01',
        },
      ]);
      // Need at least one ACTIVE ad with a creative for `activeAds.length > 0`, which is what
      // gates the thresholds lookup — an empty-campaigns response never exercises this branch.
      (fetchWithRetryAndPaging as jest.Mock)
        .mockResolvedValueOnce({
          data: [{ id: 'camp1', name: 'Campaign 1', status: 'ACTIVE', objective: 'OUTCOME_LEADS' }],
        })
        .mockResolvedValueOnce({
          data: [
            { id: 'ad1', name: 'Ad 1', creative: { id: 'cr1' }, status: 'ACTIVE', insights: { data: [{ spend: '10' }] } },
          ],
        });
      const { getThresholdsForAccount } = require('../services/adsThresholdsDb');

      await assessClientHealth('admin-user', 'client@example.com');

      expect(getThresholdsForAccount).toHaveBeenCalledWith('meta', '888888');
      expect(getThresholdsForAccount).not.toHaveBeenCalledWith('meta', '666666');
    });
  });

  // Fatigue detection: frequency ceiling (default 3.5), CTR-drop / CPM-rise vs prior-period
  // baseline (defaults 20% / 15%) — resolved from ENG-918's threshold store (mocked empty here,
  // so registry defaults apply).
  //
  // The service fetches BOTH windows in one Graph API `insights.time_ranges(...)` call and
  // distinguishes the two resulting rows by `date_start` — NOT via separate aliased sub-fields
  // (an alias like `current:insights.date_preset(...)` is silently dropped by the real Graph
  // API, confirmed live against a real ad account during ENG-885 live-testing 2026-09-04). Mocks
  // here replicate that same `insights.data` shape with matching `date_start` values.
  function currentWindowDateStart(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 13);
    return d.toISOString().slice(0, 10);
  }
  function priorWindowDateStart(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 13 - 1 - 13);
    return d.toISOString().slice(0, 10);
  }

  // ENG-2188: setup gaps (no lander, no CRM) plus creative fatigue are more than two reasons, which
  // used to read as 'at-risk'. None of them is churn evidence.
  it('ENG-2188: more than two setup gaps need attention, never at-risk', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: 'admin-user', isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: 'client-user', email: 'client@example.com', displayName: 'Client User', adAccount: '123456',
    });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);
    mockedMetaFetch
      .mockResolvedValueOnce({ data: [{ id: 'camp1', name: 'Campaign 1', status: 'ACTIVE', objective: 'OUTCOME_LEADS' }] })
      .mockResolvedValueOnce({
        data: [{
          id: 'ad1', name: 'Fatigued Ad', creative: { id: 'cr1' }, status: 'ACTIVE',
          insights: { data: [{ spend: '50', frequency: '4.2', ctr: '1.0', cpm: '10', date_start: currentWindowDateStart() }] },
        }],
      });

    const result = await assessClientHealth('admin-user', 'client@example.com');

    expect(result.health.status_reasons.length).toBeGreaterThan(2);
    expect(result.health.status).toBe('needs-attention');
  });

  it('flags a creative fatigued by frequency alone (no prior-period data)', async () => {
    const adminUserId = 'admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: adminUserId, isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: 'client-user',
      email: 'client@example.com',
      displayName: 'Client User',
      adAccount: '123456',
    });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);

    const { fetchWithRetryAndPaging } = require('../utils/metaApiFetch');
    (fetchWithRetryAndPaging as jest.Mock)
      .mockResolvedValueOnce({ data: [{ id: 'camp1', name: 'Campaign 1', status: 'ACTIVE', objective: 'OUTCOME_LEADS' }] })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'ad1',
            name: 'Fatigued Ad',
            creative: { id: 'cr1' },
            status: 'ACTIVE',
            // Only the current-window row — newly launched, no prior-period baseline yet.
            insights: {
              data: [
                { spend: '50', frequency: '4.2', ctr: '1.0', cpm: '10', date_start: currentWindowDateStart() },
              ],
            },
          },
        ],
      });

    const result = await assessClientHealth(adminUserId, 'client@example.com');

    expect(result.success).toBe(true);
    expect(result.health.creative_variety.fatigue_warning).toBe(true);
    expect(result.health.creative_variety.fatigued_creatives).toEqual([
      { id: 'ad1', name: 'Fatigued Ad', reasons: ['frequency'] },
    ]);
  });

  it('requests the ads creative and insights.time_ranges selectors URL-encoded (ENG-1742 follow-up)', async () => {
    // Confirmed live 2026-09-04 against a real ad account: unencoded `creative{id,name}` on
    // this `ads` edge silently drops the whole `creative` field (no error, just missing data —
    // same as the sibling fix in meta.ts/agentModeService.ts). The `insights.time_ranges(...){...}`
    // selector is worse: unencoded, it hard-errors on EVERY call ("Syntax error \"Expected end
    // of string...\""), so this feature has never returned ad-level insights at all. Every
    // existing test in this file mocks the ad objects directly (e.g. `creative: { id: 'cr1' }`)
    // rather than a real fetch response keyed to a real URL, so none of them could have caught
    // this — this is the first test that inspects the actual URL built.
    const adminUserId = 'admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: adminUserId, isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: 'client-user',
      email: 'client@example.com',
      displayName: 'Client User',
      adAccount: '123456',
    });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);

    const { fetchWithRetryAndPaging } = require('../utils/metaApiFetch');
    (fetchWithRetryAndPaging as jest.Mock)
      .mockResolvedValueOnce({ data: [{ id: 'camp1', name: 'Campaign 1', status: 'ACTIVE', objective: 'OUTCOME_LEADS' }] })
      .mockResolvedValueOnce({ data: [] });

    await assessClientHealth(adminUserId, 'client@example.com');

    const adsCallUrl = (fetchWithRetryAndPaging as jest.Mock).mock.calls.find(
      (call: any[]) => call[0].includes('/ads?')
    )?.[0];
    expect(adsCallUrl).toBeDefined();
    expect(adsCallUrl).toContain('creative%7Bid%2Cname%7D');
    expect(adsCallUrl).not.toContain('creative{id,name}');
    expect(adsCallUrl).toContain(encodeURIComponent('insights.time_ranges('));
    expect(adsCallUrl).not.toContain('insights.time_ranges([');
    expect(adsCallUrl).not.toContain('{spend,frequency,ctr,cpm,date_start}');
  });

  it('flags a creative fatigued by CTR drop and CPM rise vs the prior period, not by frequency', async () => {
    const adminUserId = 'admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: adminUserId, isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: 'client-user',
      email: 'client@example.com',
      displayName: 'Client User',
      adAccount: '123456',
    });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);

    const { fetchWithRetryAndPaging } = require('../utils/metaApiFetch');
    (fetchWithRetryAndPaging as jest.Mock)
      .mockResolvedValueOnce({ data: [{ id: 'camp1', name: 'Campaign 1', status: 'ACTIVE', objective: 'OUTCOME_LEADS' }] })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'ad1',
            name: 'Drifting Ad',
            creative: { id: 'cr1' },
            status: 'ACTIVE',
            insights: {
              data: [
                // frequency under the 3.5 default ceiling — should not trigger that reason.
                { spend: '50', frequency: '2.0', ctr: '0.5', cpm: '15', date_start: currentWindowDateStart() },
                // CTR dropped 50% (> 20% default), CPM rose 50% (> 15% default) vs this baseline.
                { spend: '50', frequency: '2.0', ctr: '1.0', cpm: '10', date_start: priorWindowDateStart() },
              ],
            },
          },
        ],
      });

    const result = await assessClientHealth(adminUserId, 'client@example.com');

    expect(result.success).toBe(true);
    expect(result.health.creative_variety.fatigue_warning).toBe(true);
    const flagged = result.health.creative_variety.fatigued_creatives[0];
    expect(flagged.id).toBe('ad1');
    expect(flagged.reasons).toContain('ctr_drop');
    expect(flagged.reasons).toContain('cpm_rise');
    expect(flagged.reasons).not.toContain('frequency');
  });

  it('does not flag a healthy creative within all thresholds', async () => {
    const adminUserId = 'admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: adminUserId, isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: 'client-user',
      email: 'client@example.com',
      displayName: 'Client User',
      adAccount: '123456',
    });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);

    const { fetchWithRetryAndPaging } = require('../utils/metaApiFetch');
    (fetchWithRetryAndPaging as jest.Mock)
      .mockResolvedValueOnce({ data: [{ id: 'camp1', name: 'Campaign 1', status: 'ACTIVE', objective: 'OUTCOME_LEADS' }] })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'ad1',
            name: 'Healthy Ad',
            creative: { id: 'cr1' },
            status: 'ACTIVE',
            insights: {
              data: [
                { spend: '50', frequency: '2.0', ctr: '0.95', cpm: '10.5', date_start: currentWindowDateStart() },
                { spend: '50', frequency: '2.0', ctr: '1.0', cpm: '10', date_start: priorWindowDateStart() },
              ],
            },
          },
        ],
      });

    const result = await assessClientHealth(adminUserId, 'client@example.com');

    expect(result.success).toBe(true);
    expect(result.health.creative_variety.fatigue_warning).toBe(false);
    expect(result.health.creative_variety.fatigued_creatives).toEqual([]);
  });

  it('matches current vs prior window by RELATIVE ORDER, not exact date_start equality — an account-timezone offset must not silently drop both rows', async () => {
    // Meta buckets insights `date_start` in the AD ACCOUNT's own timezone, not UTC. Shift both
    // real dates forward by one day, as a non-UTC account plausibly would relative to our
    // UTC-computed window boundaries. Neither string equals currentWindowDateStart()/
    // priorWindowDateStart() exactly, but the current row is still the later of the two.
    const adminUserId = 'admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: adminUserId, isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: 'client-user',
      email: 'client@example.com',
      displayName: 'Client User',
      adAccount: '123456',
    });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);

    const shiftedCurrent = new Date(currentWindowDateStart());
    shiftedCurrent.setUTCDate(shiftedCurrent.getUTCDate() + 1);
    const shiftedPrior = new Date(priorWindowDateStart());
    shiftedPrior.setUTCDate(shiftedPrior.getUTCDate() + 1);

    const { fetchWithRetryAndPaging } = require('../utils/metaApiFetch');
    (fetchWithRetryAndPaging as jest.Mock)
      .mockResolvedValueOnce({ data: [{ id: 'camp1', name: 'Campaign 1', status: 'ACTIVE', objective: 'OUTCOME_LEADS' }] })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'ad1',
            name: 'Timezone-Shifted Ad',
            creative: { id: 'cr1' },
            status: 'ACTIVE',
            insights: {
              data: [
                // frequency 5.0 exceeds the 3.5 default ceiling — should trigger 'frequency'
                // ONLY if this row is correctly identified as the CURRENT window, not the prior.
                { spend: '50', frequency: '5.0', ctr: '1.0', cpm: '10', date_start: shiftedCurrent.toISOString().slice(0, 10) },
                { spend: '50', frequency: '1.0', ctr: '1.0', cpm: '10', date_start: shiftedPrior.toISOString().slice(0, 10) },
              ],
            },
          },
        ],
      });

    const result = await assessClientHealth(adminUserId, 'client@example.com');

    expect(result.success).toBe(true);
    expect(result.health.creative_variety.fatigue_warning).toBe(true);
    expect(result.health.creative_variety.fatigued_creatives[0].reasons).toContain('frequency');
  });

  /*
   * ENG-1584 sibling: fetchWithRetryAndPaging is bounded and reports `pagingTruncated` when a
   * read stops short of the account's full campaign list. active_campaigns is a bare count with
   * no other signal that it might be an undercount — this pins that the truncation flag survives
   * into ads_layer instead of being silently dropped, the gap this whole PR started from.
   */
  it('flags active_campaigns as incomplete when the campaigns read was truncated', async () => {
    const adminUserId = 'admin-user';
    const clientUserId = 'client-user';

    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });

    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: clientUserId,
      email: 'client@example.com',
      displayName: 'Client User',
      isAdmin: false,
      adAccount: '123456',
    });

    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
      {
        platform: 'meta',
        account_id: 'meta-123',
        account_name: 'Meta Ads',
        config: { account_type: 'ad_account', ad_account_id: '123456', access_token: 'tok' },
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
      },
    ]);

    const { fetchWithRetryAndPaging } = require('../utils/metaApiFetch');
    (fetchWithRetryAndPaging as jest.Mock)
      .mockResolvedValueOnce({
        data: [{ id: 'camp1', name: 'Campaign 1', status: 'ACTIVE', objective: 'OUTCOME_LEADS' }],
        pagingTruncated: true,
      })
      .mockResolvedValueOnce({ data: [] });

    const result = await assessClientHealth(adminUserId, 'client@example.com');

    expect(result.health.ads_layer.active_campaigns).toBe(1);
    expect(result.health.ads_layer.campaigns_complete).toBe(false);
  });

  /*
   * Fail-open regression: campaigns_complete used to default to `true` and only flip to `false`
   * on a TRUNCATED success — a fetch that THREW (network error, expired token) fell straight to
   * the catch block below (log-only), leaving active_campaigns at 0 and campaigns_complete still
   * true. That reads as "confirmed zero campaigns, complete" when nothing was actually read.
   */
  it('does not report campaigns_complete:true when the campaigns fetch itself throws', async () => {
    const adminUserId = 'admin-user';
    const clientUserId = 'client-user';

    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });

    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: clientUserId,
      email: 'client@example.com',
      displayName: 'Client User',
      isAdmin: false,
      adAccount: '123456',
    });

    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
      {
        platform: 'meta',
        account_id: 'meta-123',
        account_name: 'Meta Ads',
        config: { account_type: 'ad_account', ad_account_id: '123456', access_token: 'tok' },
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
      },
    ]);

    const { fetchWithRetryAndPaging } = require('../utils/metaApiFetch');
    (fetchWithRetryAndPaging as jest.Mock).mockRejectedValueOnce(new Error('Meta access token expired'));

    const result = await assessClientHealth(adminUserId, 'client@example.com');

    expect(result.health.ads_layer.active_campaigns).toBe(0);
    expect(result.health.ads_layer.campaigns_complete).toBe(false);
  });

  /*
   * ENG-1767 follow-up: `fetchWithRetryAndPaging` does not throw on a Graph API error — per its
   * own documented contract it RESOLVES with the parsed `{ error: {...} }` body, no `data` array,
   * no `pagingTruncated` flag. The truncation-only check above missed this case entirely: a real
   * permission error came back as `active_campaigns: 0, campaigns_complete: true` — confirmed live
   * against a real account whose stored token had lost Graph access. Same silent-wrong-zero shape
   * this whole ticket exists to eliminate, via a different trigger than the original bug.
   */
  it('does not report campaigns_complete:true when the campaigns fetch resolves with a Graph API error', async () => {
    const adminUserId = 'admin-user';
    const clientUserId = 'client-user';

    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });

    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: clientUserId,
      email: 'client@example.com',
      displayName: 'Client User',
      isAdmin: false,
      adAccount: '123456',
    });

    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
      {
        platform: 'meta',
        account_id: 'meta-123',
        account_name: 'Meta Ads',
        config: { account_type: 'ad_account', ad_account_id: '123456', access_token: 'tok' },
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
      },
    ]);

    const { fetchWithRetryAndPaging } = require('../utils/metaApiFetch');
    (fetchWithRetryAndPaging as jest.Mock).mockResolvedValueOnce({
      error: { message: 'Ad account owner has NOT grant ads_management or ads_read permission', code: 200 },
    });

    const result = await assessClientHealth(adminUserId, 'client@example.com');

    expect(result.health.ads_layer.active_campaigns).toBe(0);
    expect(result.health.ads_layer.campaigns_complete).toBe(false);
  });

  /*
   * Sibling of the campaigns_complete gap above, found by the same review: the ad-level insights
   * fetch (creative-fatigue/cannibalization source data) has the identical failure mode and, before
   * this fix, NO completeness signal at all — not even a flawed one. A failed read after a
   * successful campaigns fetch silently reported zero warnings with full confidence, which can make
   * a client's health look BETTER than it is, not just incomplete.
   */
  it('does not report creative_data_complete:true when the ad-level insights fetch resolves with a Graph API error', async () => {
    const adminUserId = 'admin-user';
    const clientUserId = 'client-user';

    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });

    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: clientUserId,
      email: 'client@example.com',
      displayName: 'Client User',
      isAdmin: false,
      adAccount: '123456',
    });

    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
      {
        platform: 'meta',
        account_id: 'meta-123',
        account_name: 'Meta Ads',
        config: { account_type: 'ad_account', ad_account_id: '123456', access_token: 'tok' },
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
      },
    ]);

    const { fetchWithRetryAndPaging } = require('../utils/metaApiFetch');
    (fetchWithRetryAndPaging as jest.Mock)
      .mockResolvedValueOnce({
        data: [{ id: 'camp1', name: 'Campaign 1', status: 'ACTIVE', objective: 'OUTCOME_LEADS' }],
      })
      .mockResolvedValueOnce({
        error: { message: 'Ad account owner has NOT grant ads_management or ads_read permission', code: 200 },
      });

    const result = await assessClientHealth(adminUserId, 'client@example.com');

    // The campaigns read itself succeeded cleanly — this must NOT be conflated with the
    // ad-level failure below.
    expect(result.health.ads_layer.campaigns_complete).toBe(true);
    expect(result.health.creative_variety.fatigue_warning).toBe(false);
    expect(result.health.creative_variety.cannibalization_warning).toBe(false);
    expect(result.health.creative_variety.creative_data_complete).toBe(false);
  });

  it('reports creative_data_complete:true for a genuinely clean, successful ad-level read', async () => {
    const adminUserId = 'admin-user';
    const clientUserId = 'client-user';

    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });

    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: clientUserId,
      email: 'client@example.com',
      displayName: 'Client User',
      isAdmin: false,
      adAccount: '123456',
    });

    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
      {
        platform: 'meta',
        account_id: 'meta-123',
        account_name: 'Meta Ads',
        config: { account_type: 'ad_account', ad_account_id: '123456', access_token: 'tok' },
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
      },
    ]);

    const { fetchWithRetryAndPaging } = require('../utils/metaApiFetch');
    (fetchWithRetryAndPaging as jest.Mock)
      .mockResolvedValueOnce({
        data: [{ id: 'camp1', name: 'Campaign 1', status: 'ACTIVE', objective: 'OUTCOME_LEADS' }],
      })
      .mockResolvedValueOnce({
        data: [
          { id: 'ad1', name: 'Ad 1', creative: { id: 'cr1' }, status: 'ACTIVE', insights: { data: [{ spend: '10' }] } },
        ],
      });

    const result = await assessClientHealth(adminUserId, 'client@example.com');

    expect(result.health.ads_layer.campaigns_complete).toBe(true);
    expect(result.health.creative_variety.creative_data_complete).toBe(true);
  });

  /*
   * Review finding on the fix above: fetchWithRetryAndPaging keeps whatever partial `data` it
   * already fetched when it truncates (it does not discard the page it did read) — so a truncated
   * campaigns read can still return real ACTIVE campaigns and feed a genuinely clean, successful
   * ad-level fetch. Before this, creative_data_complete reported its own isolated success (true)
   * with no reflection of the incomplete campaign list it was built from. Now ANDed with
   * campaigns_complete so incompleteness upstream propagates downstream too.
   */
  it('reports creative_data_complete:false when built from a truncated (but non-empty) campaigns read, even if the ad-level fetch itself is clean', async () => {
    const adminUserId = 'admin-user';
    const clientUserId = 'client-user';

    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });

    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: clientUserId,
      email: 'client@example.com',
      displayName: 'Client User',
      isAdmin: false,
      adAccount: '123456',
    });

    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
      {
        platform: 'meta',
        account_id: 'meta-123',
        account_name: 'Meta Ads',
        config: { account_type: 'ad_account', ad_account_id: '123456', access_token: 'tok' },
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
      },
    ]);

    const { fetchWithRetryAndPaging } = require('../utils/metaApiFetch');
    (fetchWithRetryAndPaging as jest.Mock)
      .mockResolvedValueOnce({
        data: [{ id: 'camp1', name: 'Campaign 1', status: 'ACTIVE', objective: 'OUTCOME_LEADS' }],
        pagingTruncated: true,
      })
      .mockResolvedValueOnce({
        data: [
          { id: 'ad1', name: 'Ad 1', creative: { id: 'cr1' }, status: 'ACTIVE', insights: { data: [{ spend: '10' }] } },
        ],
      });

    const result = await assessClientHealth(adminUserId, 'client@example.com');

    expect(result.health.ads_layer.active_campaigns).toBe(1);
    expect(result.health.ads_layer.campaigns_complete).toBe(false);
    expect(result.health.creative_variety.creative_data_complete).toBe(false);
  });

  /*
   * Review finding: adLevelDataComplete used to be assigned BEFORE the ad-level transform ran, so
   * a throw during that transform (malformed data from Graph) left the flag at whatever it was
   * already set to, misreporting a crashed read as complete. Now assigned pessimistic (false) the
   * moment the fetch is attempted, only flipping true after fetch AND transform both succeed — a
   * throw here should leave it false, caught by the outer catch, not silently true.
   */
  it('does not report creative_data_complete:true when the ad-level transform itself throws on malformed data', async () => {
    const adminUserId = 'admin-user';
    const clientUserId = 'client-user';

    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });

    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: clientUserId,
      email: 'client@example.com',
      displayName: 'Client User',
      isAdmin: false,
      adAccount: '123456',
    });

    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
      {
        platform: 'meta',
        account_id: 'meta-123',
        account_name: 'Meta Ads',
        config: { account_type: 'ad_account', ad_account_id: '123456', access_token: 'tok' },
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
      },
    ]);

    const { fetchWithRetryAndPaging } = require('../utils/metaApiFetch');
    (fetchWithRetryAndPaging as jest.Mock)
      .mockResolvedValueOnce({
        data: [{ id: 'camp1', name: 'Campaign 1', status: 'ACTIVE', objective: 'OUTCOME_LEADS' }],
      })
      // A malformed `null` entry — `ad.insights?.data` throws on `null.insights` inside the
      // transform, since the optional chaining only guards insights -> data, not `ad` itself.
      .mockResolvedValueOnce({ data: [null] });

    const result = await assessClientHealth(adminUserId, 'client@example.com');

    expect(result.success).toBe(true);
    expect(result.health.ads_layer.campaigns_complete).toBe(true);
    expect(result.health.creative_variety.creative_data_complete).toBe(false);
  });

  it('should detect a deployed landing page owned by another member of the client org', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: 'admin-user',
      isAdmin: true,
    });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: 'rankai-user',
      email: 'hugo@rankai.ai',
      displayName: 'Hugo',
      orgId: 'rankai-org',
    });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);
    (getLandingPagesByOrg as jest.Mock).mockResolvedValueOnce([
      {
        id: 'rankai-lander',
        userId: 'rankai-teammate',
        status: 'deployed',
        customDomainUrl: 'https://rankai.agentwebforms.com',
      },
    ]);

    const result = await assessClientHealth('admin-user', 'hugo@rankai.ai');

    expect(result.success).toBe(true);
    expect(result.health.lander_layer).toEqual({
      has_lander: true,
      platforms: ['landing_page'],
    });
    expect(getLandingPagesByOwner).toHaveBeenCalledWith('rankai-user');
    expect(getLandingPagesByOrg).toHaveBeenCalledWith('rankai-org', 'rankai-user');
  });

  it('should count a deployed org landing page with a lead list as lead capture', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: 'admin-user',
      isAdmin: true,
    });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: 'rankai-user',
      email: 'hugo@rankai.ai',
      displayName: 'Hugo',
      orgId: 'rankai-org',
    });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);
    (getLandingPagesByOrg as jest.Mock).mockResolvedValueOnce([
      {
        id: 'rankai-book-demo',
        userId: 'rankai-teammate',
        status: 'deployed',
        leadListId: 'rankai-book-demo-list',
      },
    ]);

    const result = await assessClientHealth('admin-user', 'hugo@rankai.ai');

    expect(result.success).toBe(true);
    expect(result.health.lead_quality_layer).toEqual({
      has_crm: true,
      platforms: ['landing_page_lead_capture'],
    });
  });

  it('should ignore non-deployed landing pages', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: 'admin-user',
      isAdmin: true,
    });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: 'client-user',
      email: 'client@example.com',
      displayName: 'Client',
    });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);
    (getLandingPagesByOwner as jest.Mock).mockResolvedValueOnce([
      {
        id: 'draft-lander',
        userId: 'client-user',
        status: 'draft',
        leadListId: 'draft-list',
      },
    ]);

    const result = await assessClientHealth('admin-user', 'client@example.com');

    expect(result.success).toBe(true);
    expect(result.health.lander_layer.has_lander).toBe(false);
    expect(result.health.lead_quality_layer.has_crm).toBe(false);
  });

  it('should preserve legacy health signals when landing-page lookup fails', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: 'admin-user',
      isAdmin: true,
    });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: 'client-user',
      email: 'client@example.com',
      displayName: 'Client',
      productDomain: 'client.example.com',
      emailDomain: 'mail.client.example.com',
    });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);
    (getLandingPagesByOwner as jest.Mock).mockRejectedValueOnce(
      new Error('landing-page table unavailable')
    );

    const result = await assessClientHealth('admin-user', 'client@example.com');

    expect(result.success).toBe(true);
    expect(result.health.lander_layer.has_lander).toBe(true);
    expect(result.health.lead_quality_layer.has_crm).toBe(true);
  });

  it('should still return health when landing-page lookup fails without legacy signals', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: 'admin-user',
      isAdmin: true,
    });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: 'client-user',
      email: 'client@example.com',
      displayName: 'Client',
    });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);
    (getLandingPagesByOwner as jest.Mock).mockRejectedValueOnce(
      new Error('landing-page table unavailable')
    );

    const result = await assessClientHealth('admin-user', 'client@example.com');

    expect(result.success).toBe(true);
    expect(result.health.lander_layer.has_lander).toBe(false);
    expect(result.health.lead_quality_layer.has_crm).toBe(false);
  });

  // FAIL test 4: Lookup by name match when email not found
  it('should find client by name when email lookup fails', async () => {
    const adminUserId = 'admin-user';

    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce(undefined);
    (userDb.getAllUsers as jest.Mock).mockResolvedValueOnce([
      {
        userId: 'client-found',
        email: 'john@company.com',
        displayName: 'John Smith',
        isAdmin: false,
        adAccount: '',
      },
    ]);
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);

    const result = await assessClientHealth(adminUserId, 'John Smith');

    expect(result.success).toBe(true);
    expect(result.health.client.displayName).toBe('John Smith');
  });

  // Notes: returns persisted note when client has one
  it('should include clientHealthNote in health assessment', async () => {
    const adminUserId = 'admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: 'client-1',
      email: 'client@example.com',
      displayName: 'Test Client',
      isAdmin: false,
      clientHealthNote: 'Follow up on renewal next quarter',
    });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);

    const result = await assessClientHealth(adminUserId, 'client@example.com');

    expect(result.success).toBe(true);
    expect(result.health.notes).toBe('Follow up on renewal next quarter');
  });

  // Notes: returns empty string when no note stored
  it('should return empty string for notes when none stored', async () => {
    const adminUserId = 'admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: 'client-2',
      email: 'client2@example.com',
      displayName: 'Client Two',
      isAdmin: false,
    });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);

    const result = await assessClientHealth(adminUserId, 'client2@example.com');

    expect(result.success).toBe(true);
    expect(result.health.notes).toBe('');
  });
});

describe('Client Health - listAllClients', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // FAIL test 1: Non-admin user should be rejected
  it('should reject non-admin users', async () => {
    const callerUserId = 'non-admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: callerUserId,
      email: 'user@example.com',
      isAdmin: false,
    });

    const result = await listAllClients(callerUserId);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/admin/i);
  });

  // FAIL test: callerIsAdmin=false should be rejected without DB lookup
  it('should reject when callerIsAdmin override is false', async () => {
    const result = await listAllClients('non-admin-user', false);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/admin/i);
    // Should not hit the DB when override is provided
    expect(userDb.getUserById).not.toHaveBeenCalled();
  });

  // SUCCESS test: delegated admin session with callerIsAdmin=true bypasses DB check
  it('should allow access when callerIsAdmin override is true (delegated session)', async () => {
    const targetUserId = 'target-customer';
    (userDb.getAllUsers as jest.Mock).mockResolvedValueOnce([
      { userId: targetUserId, email: 'customer@example.com', isAdmin: false },
    ]);
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);

    // Pass callerIsAdmin=true as the _svc token would set it — no DB lookup for admin check
    const result = await listAllClients(targetUserId, true);

    expect(result.success).toBe(true);
    expect(userDb.getUserById).not.toHaveBeenCalled();
  });

  // FAIL test 2: Should return admin users as well
  it('should return admin users in the list', async () => {
    const adminUserId = 'admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });
    (userDb.getAllUsers as jest.Mock).mockResolvedValueOnce([
      { userId: adminUserId, email: 'admin@example.com', isAdmin: true },
    ]);
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);

    const result = await listAllClients(adminUserId);

    expect(result.success).toBe(true);
    expect(result.clients).toHaveLength(1);
    expect(result.clients[0].email).toBe('admin@example.com');
  });

  // ENG-1907: a sandbox take-home account looks like a Pro customer with a Meta
  // connection; it must not appear in the admin client roster or its health sweep.
  it('never lists a sandbox (eval_) principal as a client', async () => {
    const adminUserId = 'admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });
    (userDb.getAllUsers as jest.Mock).mockResolvedValueOnce([
      { userId: 'customer-1', email: 'customer@example.com', isAdmin: false },
      { userId: 'eval_5d5d5d5d-0000-4000-8000-000000000000', email: 'candidate@example.invalid', isAdmin: false },
    ]);
    (getAccountsByUserId as jest.Mock).mockResolvedValue([]);

    const result = await listAllClients(adminUserId);

    expect(result.success).toBe(true);
    expect(result.clients.map((c: any) => c.email)).toEqual(['customer@example.com']);
    expect(getAccountsByUserId).not.toHaveBeenCalledWith(expect.stringMatching(/^eval_/));
  });

  // FAIL test 3: Error handling when DB fails
  it('should handle database errors gracefully', async () => {
    const adminUserId = 'admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });
    (userDb.getAllUsers as jest.Mock).mockRejectedValueOnce(new Error('DB connection failed'));

    const result = await listAllClients(adminUserId);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/failed/i);
  });

  // SUCCESS test: Returns client list with health indicators (including admins)
  it('should return all clients (including admins) with health indicators', async () => {
    const adminUserId = 'admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });
    (userDb.getAllUsers as jest.Mock).mockResolvedValueOnce([
      { userId: adminUserId, email: 'admin@example.com', isAdmin: true },
      {
        userId: 'client-1',
        email: 'client1@example.com',
        isAdmin: false,
        displayName: 'Client One',
        adAccount: '111',
        roles: ['customer'],
        lastLoginTime: '2024-06-01T00:00:00Z',
        createdAt: '2024-01-15T10:00:00Z',
      },
      {
        userId: 'client-2',
        email: 'client2@example.com',
        isAdmin: false,
        displayName: 'Client Two',
        adAccount: '',
        roles: ['free'],
        lastLoginTime: '2024-05-01T00:00:00Z',
        createdAt: '2024-02-20T08:30:00Z',
      },
    ]);

    (getAccountsByUserId as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { platform: 'meta', account_id: 'meta-1', account_name: 'Meta', config: { account_type: 'ad_account' } },
      ])
      .mockResolvedValueOnce([]);

    const result = await listAllClients(adminUserId);

    expect(result.success).toBe(true);
    expect(result.clients).toHaveLength(3);
    expect(result.clients[0].email).toBe('admin@example.com');
    expect(result.clients[1].email).toBe('client1@example.com');
    expect(result.clients[1].has_ads).toBe(true);
    expect(result.clients[1].signup_time).toBe('2024-01-15T10:00:00Z');
    expect(result.clients[2].email).toBe('client2@example.com');
    expect(result.clients[2].has_ads).toBe(false);
    expect(result.clients[2].signup_time).toBe('2024-02-20T08:30:00Z');
  });

  it('should use org landing-page and lead-capture signals in the client list', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: 'admin-user',
      isAdmin: true,
    });
    (userDb.getAllUsers as jest.Mock).mockResolvedValueOnce([
      {
        userId: 'rankai-user',
        email: 'hugo@rankai.ai',
        displayName: 'Hugo',
        orgId: 'rankai-org',
      },
    ]);
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);
    (getLandingPagesByOrg as jest.Mock).mockResolvedValueOnce([
      {
        id: 'rankai-book-demo',
        userId: 'rankai-teammate',
        status: 'deployed',
        leadListId: 'rankai-book-demo-list',
      },
    ]);

    const result = await listAllClients('admin-user');

    expect(result.success).toBe(true);
    expect(result.clients[0].has_lander).toBe(true);
    expect(result.clients[0].has_crm).toBe(true);
  });

  it('should preserve the client list when landing-page lookup fails', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: 'admin-user',
      isAdmin: true,
    });
    (userDb.getAllUsers as jest.Mock).mockResolvedValueOnce([
      {
        userId: 'client-user',
        email: 'client@example.com',
        productDomain: 'client.example.com',
        emailDomain: 'mail.client.example.com',
      },
    ]);
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);
    (getLandingPagesByOwner as jest.Mock).mockRejectedValueOnce(
      new Error('landing-page table unavailable')
    );

    const result = await listAllClients('admin-user');

    expect(result.success).toBe(true);
    expect(result.clients).toHaveLength(1);
    expect(result.clients[0].has_lander).toBe(true);
    expect(result.clients[0].has_crm).toBe(true);
  });
});

describe('Client Health - classifyMetaAdConnection', () => {
  const now = Date.parse('2026-09-25T00:00:00Z');
  const meta = (config: { token_expires_at?: number; refresh_token?: string }) =>
    ({ platform: 'meta', config: { account_type: 'ad_account', ...config } });

  it('is never_connected with no Meta ad account and no legacy adAccount', () => {
    expect(classifyMetaAdConnection([], '', now).connection).toBe('never_connected');
    expect(classifyMetaAdConnection([], undefined, now).connection).toBe('never_connected');
  });

  it('is connected with a legacy adAccount (shared token has no per-client expiry)', () => {
    expect(classifyMetaAdConnection([], 'act_legacy', now).connection).toBe('connected');
  });

  it('is connected when any Meta ad account token is unexpired or carries no expiry', () => {
    expect(classifyMetaAdConnection([meta({ token_expires_at: now + 1 })], '', now).connection).toBe('connected');
    expect(classifyMetaAdConnection([meta({})], '', now).connection).toBe('connected');
    expect(classifyMetaAdConnection([meta({ token_expires_at: now - 1 }), meta({ token_expires_at: now + 1 })], '', now).connection)
      .toBe('connected');
  });

  it('is expired, reporting the latest expiry, when every Meta ad account token has expired', () => {
    const result = classifyMetaAdConnection(
      [meta({ token_expires_at: now - 10_000 }), meta({ token_expires_at: now - 5_000 })], '', now);
    expect(result.connection).toBe('expired');
    expect(result.expiredAt).toBe(new Date(now - 5_000).toISOString());
  });

  it('treats an expired token with a refresh_token as connected (it can renew)', () => {
    expect(classifyMetaAdConnection([meta({ token_expires_at: now - 1, refresh_token: 'r' })], '', now).connection)
      .toBe('connected');
  });

  it('is other_platform when ads run on Google Ads or LinkedIn Ads without Meta (ThinkingAI shape)', () => {
    expect(classifyMetaAdConnection([{ platform: 'google_ads', config: { account_type: 'google_ads' } }], '', now).connection)
      .toBe('other_platform');
    expect(classifyMetaAdConnection([{ platform: 'linkedin_ads', config: { account_type: 'ad_account' } }], '', now).connection)
      .toBe('other_platform');
    expect(classifyMetaAdConnection([{ platform: 'gmail', config: {} }], '', now).connection).toBe('never_connected');
  });

  it('ignores non-ad Meta accounts (e.g. pages)', () => {
    const page = { platform: 'meta', config: { account_type: 'page', token_expires_at: now + 1 } };
    expect(classifyMetaAdConnection([page], '', now).connection).toBe('never_connected');
  });
});

describe('Client Health - listAllClients ad_connection', () => {
  it('reports never_connected / expired / connected per client', async () => {
    const expired = Date.parse('2020-01-01T00:00:00Z');
    (userDb.getAllUsers as jest.Mock).mockResolvedValueOnce([
      { userId: 'u-never', email: 'never@example.com' },
      { userId: 'u-expired', email: 'expired@example.com' },
      { userId: 'u-legacy', email: 'legacy@example.com', adAccount: 'act_legacy' },
      { userId: 'u-google', email: 'google@example.com' },
    ]);
    (getAccountsByUserId as jest.Mock).mockImplementation(async (userId: string) =>
      userId === 'u-expired'
        ? [{ platform: 'meta', config: { account_type: 'ad_account', token_expires_at: expired } }]
        : userId === 'u-google'
          ? [{ platform: 'google_ads', config: { account_type: 'google_ads' } }]
          : []);

    const result = await listAllClients('admin-user', true);

    const byId = Object.fromEntries(
      result.clients.map((c: { userId: string; ad_connection: string; has_ads: boolean }) => [c.userId, c]));
    expect(byId['u-never'].ad_connection).toBe('never_connected');
    expect(byId['u-expired'].ad_connection).toBe('expired');
    expect(byId['u-legacy'].ad_connection).toBe('connected');
    expect(byId['u-google'].ad_connection).toBe('other_platform');
    // ENG-2188: the all-platform state the portal's status reads.
    expect(byId['u-never'].ad_connection_all_platforms).toBe('never_connected');
    expect(byId['u-expired'].ad_connection_all_platforms).toBe('expired');
    expect(byId['u-legacy'].ad_connection_all_platforms).toBe('connected');
    expect(byId['u-google'].ad_connection_all_platforms).toBe('connected');
    // has_ads keeps its historical meaning (an ad account is on record) for existing consumers.
    expect(byId['u-expired'].has_ads).toBe(true);
    (getAccountsByUserId as jest.Mock).mockReset();
  });
});
