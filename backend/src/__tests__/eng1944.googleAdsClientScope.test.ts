/**
 * ENG-1944: fix-verification for admin `client_id` scoping on the two Google
 * Ads tool entry points (call_google_ads_api, call_google_ads_reporting_api).
 * Mirrors eng1801.metaAdsClientScope.test.ts — same threat model (a
 * delegated/admin session's Google Ads calls always resolved against the
 * CALLER's own connected Google identity, never the requested client's),
 * same fix shape (resolveGoogleAdsCredentialScope mirrors
 * resolveMetaCredentialScope).
 *
 * Unlike the Meta wrappers, both Google Ads handlers catch every thrown
 * error (including the auth error) inside their own try/catch and return
 * { success: false, error, authError: true } rather than rejecting — so
 * assertions here check the resolved value, not a rejection.
 */

jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    listBiddingStrategies: jest.fn(),
    queryReporting: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
  },
}));

jest.mock('../services/adminAuditLog', () => ({
  recordAdminAudit: jest.fn(),
}));

import { AgentModeService } from '../services/agentModeService';
import { googleAdsService } from '../services/googleAdsService';
import { userDb } from '../services/db';
import { recordAdminAudit } from '../services/adminAuditLog';

const adminCaller = { userId: 'admin-1', id: 'admin-1', email: 'admin@agentweb.pro', isAdmin: true };
const nonAdminCaller = { userId: 'caller-1', id: 'caller-1', email: 'caller@agentweb.pro', isAdmin: false };
const targetUser = { userId: 'target-1', id: 'target-1', email: 'client@example.com', isAdmin: false, roles: ['customer'] };

function mockUsers(...users: any[]) {
  (userDb.getUserById as jest.Mock).mockImplementation(async (id: string) => users.find(u => u.userId === id) ?? null);
  (userDb.getUserByEmail as jest.Mock).mockImplementation(async (email: string) => users.find(u => u.email === email) ?? null);
}

describe('ENG-1944 — admin client_id scoping on Google Ads tools', () => {
  let service: AgentModeService;

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    mockUsers(adminCaller, nonAdminCaller, targetUser);
  });

  describe.each([
    ['call_google_ads_api (BIDDING_STRATEGY LIST)', (svc: AgentModeService, callerId: string, clientId: string) =>
      svc.handleCallGoogleAdsApi(callerId, { customer_id: '123', entity_type: 'BIDDING_STRATEGY', action: 'LIST' }, { clientScope: { clientId, toolName: 'call_google_ads_api' } })],
    ['call_google_ads_reporting_api (raw)', (svc: AgentModeService, callerId: string, clientId: string) =>
      svc.handleCallGoogleAdsReportingApi(callerId, { customer_id: '123', mode: 'raw', query: 'SELECT campaign.id FROM campaign' }, { clientScope: { clientId, toolName: 'call_google_ads_reporting_api' } })],
  ])('%s', (_name, call) => {
    it('rejects a non-admin caller passing client_id', async () => {
      const result = await call(service, 'caller-1', 'client@example.com');
      expect(result).toEqual(expect.objectContaining({ success: false, authError: true, error: expect.stringMatching(/admin/i) }));
      expect(googleAdsService.listBiddingStrategies).not.toHaveBeenCalled();
      expect(googleAdsService.queryReporting).not.toHaveBeenCalled();
    });

    it('rejects a blank client_id', async () => {
      const result = await call(service, 'admin-1', '   ');
      expect(result).toEqual(expect.objectContaining({ success: false, authError: true, error: expect.stringMatching(/non-blank/i) }));
    });

    it('rejects an unresolvable client_id', async () => {
      const result = await call(service, 'admin-1', 'nobody@nowhere.com');
      expect(result).toEqual(expect.objectContaining({ success: false, authError: true, error: expect.stringMatching(/no client account found/i) }));
    });

    it('rejects a target without customer-portal access', async () => {
      const staffTarget = { userId: 'staff-1', id: 'staff-1', email: 'staff@agentweb.pro', isAdmin: false, roles: ['staff'] };
      mockUsers(adminCaller, nonAdminCaller, targetUser, staffTarget);
      const result = await call(service, 'admin-1', 'staff@agentweb.pro');
      expect(result).toEqual(expect.objectContaining({ success: false, authError: true, error: expect.stringMatching(/customer portal access/i) }));
    });

    it('succeeds for an admin scoping to a valid client, resolves against the client, and audits it', async () => {
      (googleAdsService.listBiddingStrategies as jest.Mock).mockResolvedValue([{ resourceName: 'x', id: '1', name: 'strat', type: 'TARGET_CPA', status: 'ENABLED' }]);
      (googleAdsService.queryReporting as jest.Mock).mockResolvedValue([{ campaign: { id: '1' } }]);

      const result = await call(service, 'admin-1', 'client@example.com');

      expect(result.success).toBe(true);
      const usedFn = googleAdsService.listBiddingStrategies as jest.Mock;
      const usedReportingFn = googleAdsService.queryReporting as jest.Mock;
      const calledWithTargetUserId =
        (usedFn.mock.calls[0]?.[0] === 'target-1') || (usedReportingFn.mock.calls[0]?.[0] === 'target-1');
      expect(calledWithTargetUserId).toBe(true);

      expect(recordAdminAudit).toHaveBeenCalledTimes(1);
      expect(recordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({
        actorUserId: 'admin-1',
        action: 'google_ads_client_scope',
        targetUserId: 'target-1',
        targetEmail: 'client@example.com',
      }));
    });
  });

  it('call_google_ads_api: allows an admin client-scoped WRITE, audited, using the client\'s credentials', async () => {
    const result = await service.handleCallGoogleAdsApi(
      'admin-1',
      { customer_id: '123', entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: 'customers/123/campaigns/1', status: 'PAUSED' },
      { clientScope: { clientId: 'client@example.com', callerIsAdmin: true, toolName: 'call_google_ads_api' } }
    );
    expect(result?.error ?? '').not.toMatch(/only supports read actions/i);
    expect(recordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'admin-1', action: 'google_ads_client_scope', targetUserId: 'target-1',
    }));
  });

  it('call_google_ads_api: still refuses a client-scoped WRITE from a non-admin', async () => {
    const result = await service.handleCallGoogleAdsApi(
      'user-1',
      { customer_id: '123', entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: 'customers/123/campaigns/1', status: 'PAUSED' },
      { clientScope: { clientId: 'client@example.com', callerIsAdmin: false, toolName: 'call_google_ads_api' } }
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/admin-only/i);
  });

  it('unscoped calls (no client_id) are completely unaffected — zero admin gate, zero audit, act as the caller', async () => {
    (googleAdsService.listBiddingStrategies as jest.Mock).mockResolvedValue([]);

    const result = await service.handleCallGoogleAdsApi('target-1', { customer_id: '123', entity_type: 'BIDDING_STRATEGY', action: 'LIST' });

    expect(result.success).toBe(true);
    expect(googleAdsService.listBiddingStrategies).toHaveBeenCalledWith('target-1', '123');
    expect(userDb.getUserById).not.toHaveBeenCalled();
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });
});
