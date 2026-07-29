/**
 * ENG-629 — fail closed and prompt re-consent when a Meta connection lacks Ads scopes.
 *
 * Live evidence (OPS-79, fired twice in 24h): the scheduled Meta Ads report on
 * account 922903076601160 failed with
 *   "(#200) Ad account owner has NOT granted ads_management or ads_read permission"
 * yet `list_connected_accounts` showed the account connected + active, and the
 * unattended run emitted a report with no data rather than a loud failure.
 *
 * These tests pin the contract in both directions: an incapable connection must
 * fail closed with the one actionable re-consent error and must not hit Meta
 * twice for the same impossible read; a capable connection must behave exactly
 * as before.
 *
 * All capability/token data is mocked (AC5) — no live OAuth, no campaign mutation.
 */

// Must come before any imports
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true)
  }))
}));

jest.mock('../services/metaService', () => ({
  metaService: {
    listCampaigns: jest.fn()
  }
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn()
  }
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('secrets-manager-token')
}));

const mockUpdateAccountConfig = jest.fn().mockResolvedValue(undefined);
const mockIsTokenValid = jest.fn().mockResolvedValue(true);

jest.mock('../services/connectedAccountsDb', () => {
  const actual = jest.requireActual('../services/connectedAccountsDb');
  return {
    ...actual,
    updateAccountConfig: (...args: any[]) => mockUpdateAccountConfig(...args),
    isTokenValid: (...args: any[]) => mockIsTokenValid(...args),
  };
});

import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';
import { userDb } from '../services/db';
import { META_ADS_RECONSENT_MESSAGE } from '../utils/metaAdsScope';

const AD_ACCOUNT_ID = '922903076601160';

/** Build a Meta ad-account connected-account record with explicit capability data. */
const metaAccount = (config: Record<string, any>) => ({
  platform: 'meta',
  account_id: AD_ACCOUNT_ID,
  account_name: 'AgentWeb Ads',
  config: {
    account_type: 'ad_account',
    ad_account_id: AD_ACCOUNT_ID,
    access_token: 'EAA-token',
    token_expires_at: Date.now() + 86_400_000,
    ...config,
  },
});

/** The exact error Meta returned in production for OPS-79. */
const metaPermissionError = () => {
  const err: any = new Error(
    '(#200) Ad account owner has NOT granted ads_management or ads_read permission'
  );
  err.code = 200;
  return err;
};

describe('AgentModeService — Meta Ads scope fail-closed gate (ENG-629)', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
    mockUpdateAccountConfig.mockResolvedValue(undefined);
    mockIsTokenValid.mockResolvedValue(true);
  });

  // ── AC2 + AC3: fail closed BEFORE calling Meta when we know scopes are missing ──

  describe('pre-flight gate (granted_scopes authoritatively missing)', () => {
    const userWithoutAdsScope = {
      id: 'user1',
      connected_accounts: [
        metaAccount({ granted_scopes: ['pages_show_list', 'pages_read_engagement'] }),
      ],
    };

    it('throws the actionable re-consent error instead of returning an empty result', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(userWithoutAdsScope);

      await expect(agentModeService.listMetaAdsCampaignsNew('user1')).rejects.toThrow(
        /ads_read/
      );
      await expect(agentModeService.listMetaAdsCampaignsNew('user1')).rejects.toThrow(
        /Reconnect Meta/i
      );
    });

    it('never calls the Meta API — the impossible read is not attempted at all', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(userWithoutAdsScope);

      await expect(agentModeService.listMetaAdsCampaignsNew('user1')).rejects.toThrow();

      expect(metaService.listCampaigns).not.toHaveBeenCalled();
    });

    it('throws rather than resolving, so a scheduled run cannot narrate it as success', async () => {
      // The soft `{ success: false, campaigns: [] }` shape is exactly what let the
      // unattended run produce a clean-looking empty report. It must not appear.
      (userDb.getUserById as jest.Mock).mockResolvedValue(userWithoutAdsScope);

      const result = await agentModeService
        .listMetaAdsCampaignsNew('user1')
        .then(() => 'RESOLVED')
        .catch(() => 'REJECTED');

      expect(result).toBe('REJECTED');
    });

    it('flags the error as a Meta auth error so it rides the existing rethrow channel', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(userWithoutAdsScope);

      const err: any = await agentModeService.listMetaAdsCampaignsNew('user1').catch(e => e);

      expect(err.isMetaAuthError).toBe(true);
      expect(err.isMetaAdsScopeError).toBe(true);
      expect(err.needsReconnect).toBe(true);
    });

    it('does not leak the access token in the surfaced message', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(userWithoutAdsScope);

      const err: any = await agentModeService.listMetaAdsCampaignsNew('user1').catch(e => e);

      expect(err.message).not.toContain('EAA-token');
    });
  });

  // ── AC4: capable connections keep working, unchanged ──

  describe('connections with valid scopes retain current behavior', () => {
    it('proceeds normally when granted_scopes contains ads_read', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        id: 'user1',
        connected_accounts: [metaAccount({ granted_scopes: ['ads_read', 'pages_show_list'] })],
      });
      (metaService.listCampaigns as jest.Mock).mockResolvedValue([
        { id: '120241445300020585', name: 'AgentWeb Broad Targeting' },
      ]);

      const result = await agentModeService.listMetaAdsCampaignsNew('user1');

      expect(result.success).toBe(true);
      expect(result.totalCount).toBe(1);
      expect(metaService.listCampaigns).toHaveBeenCalledTimes(1);
    });

    it('proceeds normally when granted_scopes contains ads_management', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        id: 'user1',
        connected_accounts: [metaAccount({ granted_scopes: ['ads_management'] })],
      });
      (metaService.listCampaigns as jest.Mock).mockResolvedValue([]);

      const result = await agentModeService.listMetaAdsCampaignsNew('user1');

      expect(result.success).toBe(true);
      expect(metaService.listCampaigns).toHaveBeenCalledTimes(1);
    });

    it('lets a legacy record (no granted_scopes) through — unknown is not a refusal', async () => {
      // Legacy records carry the *requested* scopes only. We cannot prove
      // incapability, so we must not lock out a connection that actually works.
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        id: 'user1',
        connected_accounts: [
          metaAccount({ scopes: ['ads_management', 'ads_read', 'pages_show_list'] }),
        ],
      });
      (metaService.listCampaigns as jest.Mock).mockResolvedValue([{ id: 'c1' }]);

      const result = await agentModeService.listMetaAdsCampaignsNew('user1');

      expect(result.success).toBe(true);
      expect(metaService.listCampaigns).toHaveBeenCalledTimes(1);
    });
  });

  // ── The live OPS-79 case: legacy record, Meta refuses at call time ──

  describe('post-flight normalization (Meta returns the authoritative refusal)', () => {
    const legacyUser = {
      id: 'user1',
      connected_accounts: [
        metaAccount({ scopes: ['ads_management', 'ads_read', 'pages_show_list'] }),
      ],
    };

    it('converts Meta’s raw (#200) refusal into the one actionable re-consent error', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(legacyUser);
      (metaService.listCampaigns as jest.Mock).mockRejectedValue(metaPermissionError());

      const err: any = await agentModeService.listMetaAdsCampaignsNew('user1').catch(e => e);

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain(META_ADS_RECONSENT_MESSAGE);
      expect(err.isMetaAdsScopeError).toBe(true);
    });

    it('throws instead of degrading to the soft empty-result shape', async () => {
      // Before this fix the catch block returned `{ success:false, campaigns: undefined }`,
      // which reads to the model as "the account has no campaigns".
      (userDb.getUserById as jest.Mock).mockResolvedValue(legacyUser);
      (metaService.listCampaigns as jest.Mock).mockRejectedValue(metaPermissionError());

      const outcome = await agentModeService
        .listMetaAdsCampaignsNew('user1')
        .then(() => 'RESOLVED')
        .catch(() => 'REJECTED');

      expect(outcome).toBe('REJECTED');
    });

    it('records the now-known-missing capability so the next read fails pre-flight', async () => {
      // AC3: "scheduled runs do not repeatedly attempt the same impossible read".
      // Meta just told us authoritatively what the grant is; persist it.
      (userDb.getUserById as jest.Mock).mockResolvedValue(legacyUser);
      (metaService.listCampaigns as jest.Mock).mockRejectedValue(metaPermissionError());

      await agentModeService.listMetaAdsCampaignsNew('user1').catch(() => undefined);

      expect(mockUpdateAccountConfig).toHaveBeenCalledTimes(1);
      const [userId, platform, accountId, updates] = mockUpdateAccountConfig.mock.calls[0];
      expect(userId).toBe('user1');
      expect(platform).toBe('meta');
      expect(accountId).toBe(AD_ACCOUNT_ID);
      expect(Array.isArray(updates.granted_scopes)).toBe(true);
      expect(updates.granted_scopes).not.toContain('ads_read');
      expect(updates.granted_scopes).not.toContain('ads_management');
    });

    it('records a signal strong enough that the NEXT read fails without calling Meta', async () => {
      // AC3, end to end. Asserting "the persisted array has no ads scope" is not
      // enough: for a legacy record the retained array is [], which is
      // indistinguishable from "we never asked" and would let the gate fall
      // through to Meta again on every subsequent scheduled run.
      (userDb.getUserById as jest.Mock).mockResolvedValue(legacyUser);
      (metaService.listCampaigns as jest.Mock).mockRejectedValue(metaPermissionError());

      await agentModeService.listMetaAdsCampaignsNew('user1').catch(() => undefined);

      expect(metaService.listCampaigns).toHaveBeenCalledTimes(1);
      const persisted = mockUpdateAccountConfig.mock.calls[0][3];

      // Feed exactly what we persisted back in, as the next run would read it.
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        id: 'user1',
        connected_accounts: [metaAccount({ ...legacyUser.connected_accounts[0].config, ...persisted })],
      });

      await expect(agentModeService.listMetaAdsCampaignsNew('user1')).rejects.toThrow(/ads_read/);
      expect(metaService.listCampaigns).toHaveBeenCalledTimes(1); // still 1 — never retried
    });

    it('still surfaces the actionable error even if persisting the capability fails', async () => {
      // The self-heal is best-effort; it must never mask the user-facing failure.
      (userDb.getUserById as jest.Mock).mockResolvedValue(legacyUser);
      (metaService.listCampaigns as jest.Mock).mockRejectedValue(metaPermissionError());
      mockUpdateAccountConfig.mockRejectedValue(new Error('dynamo unavailable'));

      const err: any = await agentModeService.listMetaAdsCampaignsNew('user1').catch(e => e);

      expect(err.message).toContain(META_ADS_RECONSENT_MESSAGE);
    });

    it('leaves non-permission Meta failures on their existing soft path (AC4)', async () => {
      // A rate limit is not a scope problem and must not be relabelled as one,
      // nor be escalated from the existing soft-result behavior.
      (userDb.getUserById as jest.Mock).mockResolvedValue(legacyUser);
      (metaService.listCampaigns as jest.Mock).mockRejectedValue(
        new Error('Meta rate limit exceeded')
      );

      const result = await agentModeService.listMetaAdsCampaignsNew('user1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/rate limit/i);
      expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
    });

    it('does not relabel a validation error (#100) as a scope problem — that is ENG-630', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(legacyUser);
      const validationError: any = new Error('(#100) param filtering must be an array');
      validationError.code = 100;
      (metaService.listCampaigns as jest.Mock).mockRejectedValue(validationError);

      const result = await agentModeService.listMetaAdsCampaignsNew('user1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/filtering/i);
      expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
    });
  });

  // ── AC1: not presented to Ads tooling as fully capable ──

  describe('list_connected_accounts capability reporting', () => {
    it('marks a Meta ad account without ads scopes as not ads-capable', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        id: 'user1',
        connected_accounts: [metaAccount({ granted_scopes: ['pages_show_list'] })],
      });

      const result = await agentModeService.listConnectedAccounts('user1');
      const account = result.accounts.find((a: any) => a.platform === 'meta');

      expect(account.ads_capable).toBe(false);
    });

    it('explains why, naming the missing capability and the remedy', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        id: 'user1',
        connected_accounts: [metaAccount({ granted_scopes: ['pages_show_list'] })],
      });

      const result = await agentModeService.listConnectedAccounts('user1');
      const account = result.accounts.find((a: any) => a.platform === 'meta');

      expect(account.capability_warning).toMatch(/ads_read/);
      expect(account.capability_warning).toMatch(/reconnect/i);
    });

    it('marks a properly scoped Meta ad account as ads-capable with no warning', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        id: 'user1',
        connected_accounts: [metaAccount({ granted_scopes: ['ads_read'] })],
      });

      const result = await agentModeService.listConnectedAccounts('user1');
      const account = result.accounts.find((a: any) => a.platform === 'meta');

      expect(account.ads_capable).toBe(true);
      expect(account.capability_warning).toBeUndefined();
    });

    it('reports unknown-capability legacy records without a false warning', async () => {
      // We have no proof either way; do not claim capable, do not cry wolf.
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        id: 'user1',
        connected_accounts: [metaAccount({ scopes: ['ads_read'] })],
      });

      const result = await agentModeService.listConnectedAccounts('user1');
      const account = result.accounts.find((a: any) => a.platform === 'meta');

      expect(account.ads_capable).toBeUndefined();
      expect(account.capability_warning).toBeUndefined();
    });

    it('leaves non-Meta accounts untouched (AC4)', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        id: 'user1',
        connected_accounts: [
          {
            platform: 'gmail',
            account_id: 'user@example.com',
            account_name: 'Gmail',
            config: {
              account_type: 'gmail',
              access_token: 't',
              token_expires_at: Date.now() + 1000,
              granted_scopes: [],
            },
          },
        ],
      });

      const result = await agentModeService.listConnectedAccounts('user1');
      const account = result.accounts.find((a: any) => a.platform === 'gmail');

      expect(account.ads_capable).toBeUndefined();
      expect(account.capability_warning).toBeUndefined();
      expect(account.is_active).toBe(true);
    });
  });
});
