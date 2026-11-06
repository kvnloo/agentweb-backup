/**
 * ENG-1801: canonical fix-verification for admin `client_id` scoping on the 3
 * Meta-ads reporting tools (list_meta_ads_campaigns, get_meta_ads_metrics,
 * call_meta_ads_insights_api). Exercised through all 3 service-layer entry
 * points to prove the fix lives in the shared getMetaCredentials resolver, not
 * reimplemented per-tool. See agentModeService.metaCredentialsFallback.test.ts
 * and agentModeService.metaMetricsAccountResolution.test.ts for the deeper
 * per-wrapper coverage this file complements.
 *
 * callMetaAdsInsightsApiWrapper's success path submits a report to Meta and
 * polls (real axios + a 10s sleep between polls) — heavyweight to drive to a
 * real success in a unit test and not where the ENG-1801 logic lives, so only
 * its reject-path and legacy-fallback-suppression scenarios are covered here
 * (both throw inside getMetaCredentials, before any axios call is made). Its
 * account_id is schema-required regardless of client_id, so the
 * single-default-account fallback (only reachable when account_id is
 * omitted) is structurally unreachable via this tool — not tested here.
 */

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true),
  })),
}));

jest.mock('../services/metaService', () => ({
  metaService: {
    listCampaigns: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
  },
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('secrets-manager-token'),
}));

jest.mock('../services/adminAuditLog', () => ({
  recordAdminAudit: jest.fn(),
}));

// getMetaAdsMetrics reaches real network calls once past credential
// resolution (unlike the other two wrappers, whose mocks above are enough).
// Without this, a reject-path test that WRONGLY proceeds past the resolver
// would hit the sandbox's real-network-egress guard instead of failing on
// the assertion below — a false pass for the wrong reason. Mocking it lets
// "fetchWithRetryAndPaging never called" be the real, direct assertion.
jest.mock('../utils/metaApiFetch', () => ({
  fetchWithRetryAndPaging: jest.fn(),
}));

import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';
import { userDb } from '../services/db';
import { getMetaAccessToken } from '../utils/secretsManager';
import { recordAdminAudit } from '../services/adminAuditLog';
import { fetchWithRetryAndPaging } from '../utils/metaApiFetch';

const adminCaller = { userId: 'admin-1', id: 'admin-1', email: 'admin@agentweb.pro', isAdmin: true, connected_accounts: [] };
const nonAdminCaller = { userId: 'caller-1', id: 'caller-1', email: 'caller@agentweb.pro', isAdmin: false, connected_accounts: [] };
const targetUser = {
  userId: 'target-1',
  id: 'target-1',
  email: 'client@example.com',
  isAdmin: false,
  roles: ['customer'],
  connected_accounts: [{
    platform: 'meta',
    account_id: 'target-account-id',
    account_name: "Client's Account",
    config: { account_type: 'ad_account', access_token: 'target-token', ad_account_id: 'target-account-id' },
  }],
};

function mockUsers(...users: any[]) {
  (userDb.getUserById as jest.Mock).mockImplementation(async (id: string) => users.find(u => u.userId === id) ?? null);
  (userDb.getUserByEmail as jest.Mock).mockImplementation(async (email: string) => users.find(u => u.email === email) ?? null);
}

describe('ENG-1801 — admin client_id scoping (canonical, all 3 wrapper entry points)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    (getMetaAccessToken as jest.Mock).mockResolvedValue('secrets-manager-token');
    mockUsers(adminCaller, nonAdminCaller, targetUser);
  });

  describe.each([
    ['listMetaAdsCampaignsNew', (svc: AgentModeService, callerId: string, clientId: string) =>
      svc.listMetaAdsCampaignsNew(callerId, 'target-account-id', {}, { clientId, toolName: 'list_meta_ads_campaigns' })],
    ['getMetaAdsMetrics', (svc: AgentModeService, callerId: string, clientId: string) =>
      svc.getMetaAdsMetrics('7d', callerId, ['c1'], 'target-account-id', { clientId, toolName: 'get_meta_ads_metrics' })],
    ['callMetaAdsInsightsApiWrapper', (svc: AgentModeService, callerId: string, clientId: string) =>
      svc.callMetaAdsInsightsApiWrapper(callerId, {
        account_id: 'target-account-id', object_type: 'account' as any, fields: ['impressions'], date_preset: 'last_30d', client_id: clientId,
      })],
  ])('%s', (name, call) => {
    // getMetaAdsMetrics never throws (catch-and-return contract) — the other
    // two throw. Normalize so the same assertion works for all three.
    const expectRejection = async (promise: Promise<any>, pattern: RegExp) => {
      if (name === 'getMetaAdsMetrics') {
        const result = await promise;
        expect(result).toEqual(expect.objectContaining({ success: false, error: expect.stringMatching(pattern) }));
      } else {
        await expect(promise).rejects.toThrow(pattern);
      }
    };

    it('rejects a non-admin caller passing client_id', async () => {
      await expectRejection(call(service, 'caller-1', 'client@example.com'), /admin/i);
      expect(metaService.listCampaigns).not.toHaveBeenCalled();
      expect(fetchWithRetryAndPaging).not.toHaveBeenCalled();
    });

    it('rejects a blank client_id', async () => {
      await expectRejection(call(service, 'admin-1', '   '), /non-blank/i);
      expect(fetchWithRetryAndPaging).not.toHaveBeenCalled();
    });

    it('rejects an unresolvable client_id', async () => {
      await expectRejection(call(service, 'admin-1', 'nobody@nowhere.com'), /no client account found/i);
      expect(fetchWithRetryAndPaging).not.toHaveBeenCalled();
    });

    it('rejects a target without customer-portal access', async () => {
      const nonCustomerTarget = { ...targetUser, userId: 'non-customer-1', email: 'staff@agentweb.pro', roles: ['staff'] };
      mockUsers(adminCaller, nonAdminCaller, targetUser, nonCustomerTarget);
      await expectRejection(call(service, 'admin-1', 'staff@agentweb.pro'), /customer portal access/i);
      expect(fetchWithRetryAndPaging).not.toHaveBeenCalled();
    });

    it('rejects a non-string client_id', async () => {
      await expectRejection(call(service, 'admin-1', 12345 as any), /non-blank/i);
      expect(fetchWithRetryAndPaging).not.toHaveBeenCalled();
    });

    it('rejects an admin targeting another admin who lacks the customer role (admin-targets-admin)', async () => {
      const peerAdmin = { ...adminCaller, userId: 'admin-2', email: 'admin2@agentweb.pro' };
      mockUsers(adminCaller, nonAdminCaller, targetUser, peerAdmin);
      await expectRejection(call(service, 'admin-1', 'admin2@agentweb.pro'), /customer portal access/i);
      expect(fetchWithRetryAndPaging).not.toHaveBeenCalled();
    });

    it('rejects an admin self-targeting via client_id when their own account lacks the customer role', async () => {
      mockUsers(adminCaller, nonAdminCaller, targetUser);
      await expectRejection(call(service, 'admin-1', 'admin@agentweb.pro'), /customer portal access/i);
      expect(fetchWithRetryAndPaging).not.toHaveBeenCalled();
    });

    it('mutation: suppresses the legacy adAccount fallback under client_id scope', async () => {
      const targetWithLegacyOnly = { ...targetUser, connected_accounts: [], adAccount: '883347640787043' };
      mockUsers(adminCaller, nonAdminCaller, targetWithLegacyOnly);

      await expectRejection(call(service, 'admin-1', 'client@example.com'), /never fall back/i);
      expect(getMetaAccessToken).not.toHaveBeenCalled();
      expect(metaService.listCampaigns).not.toHaveBeenCalled();
      expect(fetchWithRetryAndPaging).not.toHaveBeenCalled();
    });
  });

  it('listMetaAdsCampaignsNew: resolves a named client cross-tenant, uses their account, and audits it', async () => {
    (metaService.listCampaigns as jest.Mock).mockResolvedValue({ campaigns: [{ id: 'c1' }], truncated: false, pagesFetched: 1 });

    const result = await service.listMetaAdsCampaignsNew(
      'admin-1', 'target-account-id', {}, { clientId: 'client@example.com', toolName: 'list_meta_ads_campaigns' }
    );

    expect(result.success).toBe(true);
    expect(metaService.listCampaigns).toHaveBeenCalledWith('target-account-id', 'target-token');
    expect(recordAdminAudit).toHaveBeenCalledTimes(1);
    expect(recordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'admin-1',
      action: 'meta_ads_client_scope',
      tool: 'list_meta_ads_campaigns',
      targetUserId: 'target-1',
      targetEmail: 'client@example.com',
    }));
  });

  it('listMetaAdsCampaignsNew: mutation — requires an explicit account_id under client_id scope (single-account fallback suppressed)', async () => {
    await expect(
      service.listMetaAdsCampaignsNew('admin-1', undefined, {}, { clientId: 'client@example.com', toolName: 'list_meta_ads_campaigns' })
    ).rejects.toThrow(/require an explicit account_id/i);
    expect(metaService.listCampaigns).not.toHaveBeenCalled();
  });

  it('ENG-2786: missing account_id under client_id scope is invalid_args with candidate account_ids, still no auto-select', async () => {
    let caught: any;
    try {
      await service.listMetaAdsCampaignsNew('admin-1', undefined, {}, { clientId: 'client@example.com', toolName: 'list_meta_ads_campaigns' });
    } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.toolErrorClass).toBe('invalid_args');
    expect(caught.candidateAccountIds).toEqual(['act_target-account-id']);
    expect(caught.message).toMatch(/Candidate account_ids: \[act_target-account-id\]/);
    expect(metaService.listCampaigns).not.toHaveBeenCalled();
    expect(getMetaAccessToken).not.toHaveBeenCalled();
  });

  it('ENG-2786: candidates include a connected Meta ad account that has no stored token', async () => {
    mockUsers(adminCaller, { ...targetUser, connected_accounts: [{
      platform: 'meta', account_id: 'act_3000000000000001', account_name: 'Seeded',
      config: { account_type: 'ad_account' },
    }] });
    let caught: any;
    try {
      await service.listMetaAdsCampaignsNew('admin-1', undefined, {}, { clientId: 'client@example.com', toolName: 'list_meta_ads_campaigns' });
    } catch (e) { caught = e; }
    expect(caught?.toolErrorClass).toBe('invalid_args');
    expect(caught.candidateAccountIds).toEqual(['act_3000000000000001']);
    expect(metaService.listCampaigns).not.toHaveBeenCalled();
    expect(getMetaAccessToken).not.toHaveBeenCalled();
  });

  it('ENG-2786: the model-visible tool error (dispatch formatting) carries the candidate account_ids and an invalid_args verdict', async () => {
    const { listMetaAdsCampaignsTool } = await import('../emma/metaTools');
    const { appendRetryabilityGuidance } = await import('../services/agentMode/core/errorRetryability');
    const { classifyToolErrorClass } = await import('../utils/toolErrorClassifier');
    let caught: any;
    try {
      await listMetaAdsCampaignsTool.execute({ client_id: 'client@example.com' }, { userId: 'admin-1' } as any);
    } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    // Same assembly toolDispatch.ts uses for a thrown tool error.
    const content = appendRetryabilityGuidance(
      (service as any).formatToolError('list_meta_ads_campaigns', caught.message),
      classifyToolErrorClass(caught),
    );
    expect(content).toContain('Candidate account_ids: [act_target-account-id]');
    expect(classifyToolErrorClass(caught)).toBe('invalid_args');
    expect(content).toMatch(/fix the arguments/);
    expect(content).not.toMatch(/\(re\)connect the account/);
  });

  it('unscoped calls (no client_id) are completely unaffected — zero admin gate, zero audit', async () => {
    (metaService.listCampaigns as jest.Mock).mockResolvedValue({ campaigns: [], truncated: false, pagesFetched: 1 });

    await service.listMetaAdsCampaignsNew('target-1');

    expect(metaService.listCampaigns).toHaveBeenCalledWith('target-account-id', 'target-token');
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });
});
