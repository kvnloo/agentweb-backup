/**
 * ENG-3040 acceptance contract (ads_get_ad_accounts half):
 *  - Meta's tool returns name, status, currency and timezone; zoma_status has no status or
 *    timezone, so this is a read tool, not a mapping.
 *  - Lists only accounts connected to this user or shared with their org (the gateway's own
 *    account list), usable connections only, with one read of each account's own node.
 *  - tools:read on aw_ keys (a key without it gets 403 before any read), no arguments,
 *    metered once per call, advertised read-only, matrix row covered.
 *  - ads_get_field_context is NOT resolved here: it stays a gap owned by ENG-3040.
 */
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    listMetaAdsCampaignsNew: jest.fn(),
    getMetaAdsMetrics: jest.fn(),
    callMetaAdsInsightsApiWrapper: jest.fn(),
    callMetaMarketingApi: jest.fn(),
    launchTargetedAudienceCampaign: jest.fn(),
    launchRetargetingCampaign: jest.fn(),
    readToolkitMetaPagesGraph: jest.fn(),
  },
}));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: { validateKey: jest.fn() } }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: { validateAccessToken: jest.fn() } }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn(), recordMcpWriteExecuted: jest.fn() }));

import { agentModeService } from '../services/agentModeService';
import {
  AD_ACCOUNT_LIST_FIELDS, AD_ACCOUNTS_TOOL_DEFINITION, MAX_AD_ACCOUNTS, runMetaAdAccountsTool,
} from '../mcp/metaToolkitAdAccounts';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { getMetaToolkitManifest, assertMetaToolkitV1Call } from '../mcp/metaToolkitManifest';
import { handleMetaToolkitCall, type MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { READ_ONLY_TOOLKIT_TOOLS } from '../mcp/toolkitToolAnnotations';
import { isDatabricksAllowedCall } from '../mcp/zomaDatabricksReadOnly';
import { ZOMA_META_PARITY_MATRIX, summarizeParity } from '../mcp/zomaMetaParityMatrix';

const NOW = Date.parse('2026-11-15T00:00:00Z');
const GRAPH = { name: 'Acme US', account_status: 1, currency: 'USD', timezone_name: 'America/Los_Angeles' };

function metaAccount(adAccountId: string, extra: Record<string, unknown> = {}, name = 'stored name') {
  return {
    platform: 'meta', account_id: adAccountId, account_name: name,
    config: { account_type: 'ad_account', ad_account_id: adAccountId, access_token: 'SECRET_TOKEN', currency: 'EUR', token_expires_at: NOW + 86_400_000, ...extra },
    created_at: '', updated_at: '',
  } as any;
}

function makeDeps(overrides: Partial<MetaToolkitGatewayDeps> = {}): MetaToolkitGatewayDeps {
  return {
    validateApiKey: jest.fn().mockResolvedValue({ userId: 'user-1', keyId: 'key-1' }),
    validateOAuthToken: jest.fn().mockResolvedValue(null),
    listAccounts: jest.fn().mockResolvedValue([metaAccount('111'), metaAccount('222')]),
    execute: jest.fn() as any,
    recordUsage: jest.fn().mockResolvedValue(true) as any,
    now: () => NOW,
    ...overrides,
  };
}

const call = (deps: MetaToolkitGatewayDeps, args: any = {}) =>
  handleMetaToolkitCall({ authorization: 'Bearer aw_good', toolName: 'ads_get_ad_accounts', args }, deps);

const readGraph = agentModeService.readToolkitMetaPagesGraph as jest.Mock;

describe('ENG-3040 ads_get_ad_accounts', () => {
  beforeEach(() => { readGraph.mockReset(); });

  describe('handler', () => {
    it('reads each connected account own node once and returns name, status, currency, timezone', async () => {
      const readAccount = jest.fn().mockResolvedValue(GRAPH);
      const out: any = await runMetaAdAccountsTool('u', [{ accountId: '111' }], {}, { readAccount });
      expect(readAccount).toHaveBeenCalledTimes(1);
      expect(readAccount).toHaveBeenCalledWith('u', '111', AD_ACCOUNT_LIST_FIELDS);
      expect(AD_ACCOUNT_LIST_FIELDS.split(',')).toEqual(expect.arrayContaining(['name', 'account_status', 'currency', 'timezone_name']));
      expect(out).toEqual({
        accounts: [{ account_id: '111', name: 'Acme US', status: 'ACTIVE', currency: 'USD', timezone: 'America/Los_Angeles' }],
        count: 1,
      });
    });

    it('labels a disabled account and an unmapped status code', async () => {
      const readAccount = jest.fn()
        .mockResolvedValueOnce({ ...GRAPH, account_status: 2 })
        .mockResolvedValueOnce({ ...GRAPH, account_status: 999 });
      const out: any = await runMetaAdAccountsTool('u', [{ accountId: '1' }, { accountId: '2' }], {}, { readAccount });
      expect(out.accounts.map((a: any) => a.status)).toEqual(['DISABLED', 'UNKNOWN_999']);
    });

    it('still lists a connection Meta refused to read, from what Zoma stored, and does not hide the others', async () => {
      const readAccount = jest.fn().mockImplementation(async (_u: string, id: string) => {
        if (id === '2') throw Object.assign(new Error('x'), { metaError: { message: 'Permissions error' } });
        return GRAPH;
      });
      const out: any = await runMetaAdAccountsTool('u', [{ accountId: '1' }, { accountId: '2', name: 'Stored', currency: 'EUR' }], {}, { readAccount });
      expect(out.accounts[0].status).toBe('ACTIVE');
      expect(out.accounts[1]).toEqual({ account_id: '2', name: 'Stored', status: 'UNREADABLE', currency: 'EUR', read_error: 'Permissions error' });
    });

    it('refuses when Meta refused every read (so the call is not metered as a success)', async () => {
      const readAccount = jest.fn().mockRejectedValue(new Error('Meta request failed.'));
      await expect(runMetaAdAccountsTool('u', [{ accountId: '1' }], {}, { readAccount })).rejects.toThrow(MetaToolkitRefusal);
    });

    it('returns an empty list and no Graph read when nothing is connected', async () => {
      const readAccount = jest.fn();
      const out: any = await runMetaAdAccountsTool('u', [], {}, { readAccount });
      expect(out).toMatchObject({ accounts: [], count: 0 });
      expect(out.note).toContain('zoma_status');
      expect(readAccount).not.toHaveBeenCalled();
    });

    it('takes no arguments: an account_id (or anything else) is refused before any read', async () => {
      const readAccount = jest.fn();
      await expect(runMetaAdAccountsTool('u', [{ accountId: '1' }], { account_id: '999' }, { readAccount })).rejects.toThrow(/takes no arguments/);
      expect(readAccount).not.toHaveBeenCalled();
    });

    it('reads a duplicate connection once, skips a non-numeric id, and caps the number of reads', async () => {
      const readAccount = jest.fn().mockResolvedValue(GRAPH);
      const many = Array.from({ length: MAX_AD_ACCOUNTS + 3 }, (_, i) => ({ accountId: String(1000 + i) }));
      const out: any = await runMetaAdAccountsTool('u', [{ accountId: '1000' }, { accountId: 'me' }, ...many], {}, { readAccount });
      expect(readAccount).toHaveBeenCalledTimes(MAX_AD_ACCOUNTS);
      expect(out.count).toBe(MAX_AD_ACCOUNTS);
      expect(out.truncated).toBe(true);
    });
  });

  describe('through the toolkit gateway', () => {
    it('lists both connected accounts when several are connected, and meters once', async () => {
      readGraph.mockResolvedValue(GRAPH);
      const deps = makeDeps();
      const out: any = await call(deps);
      expect(out.accounts.map((a: any) => a.account_id)).toEqual(['111', '222']);
      expect(readGraph.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([['user-1', '111', 'act_111'], ['user-1', '222', 'act_222']]);
      expect(deps.recordUsage).toHaveBeenCalledTimes(1);
      expect((deps.recordUsage as jest.Mock).mock.calls[0][0]).toMatchObject({ toolName: 'ads_get_ad_accounts', platform: 'meta', userId: 'user-1' });
      expect(deps.execute).not.toHaveBeenCalled();
      expect(JSON.stringify(out)).not.toContain('SECRET_TOKEN');
    });

    it('leaves out a revoked or expired connection and anything that is not a Meta ad account', async () => {
      readGraph.mockResolvedValue(GRAPH);
      const deps = makeDeps({
        listAccounts: jest.fn().mockResolvedValue([
          metaAccount('111'),
          metaAccount('222', { ads_scope_revoked_at: '2026-11-01' }),
          metaAccount('333', { token_expires_at: NOW - 1 }),
          { platform: 'google_ads', account_id: '444', config: { customer_id: '444', refresh_token: 'r' } },
        ]),
      });
      const out: any = await call(deps);
      expect(out.accounts.map((a: any) => a.account_id)).toEqual(['111']);
      expect(readGraph).toHaveBeenCalledTimes(1);
    });

    it('an aw_ key without tools:read gets 403 before any account list or Graph read, unmetered', async () => {
      const deps = makeDeps({ validateApiKey: jest.fn().mockResolvedValue({ userId: 'user-1', keyId: 'key-1', scopes: ['resources:read'] }) });
      await expect(call(deps)).rejects.toMatchObject({ status: 403 });
      expect(deps.listAccounts).not.toHaveBeenCalled();
      expect(readGraph).not.toHaveBeenCalled();
      expect(deps.recordUsage).not.toHaveBeenCalled();
    });

    it('a read-only aw_ key (tools:read) may call it', async () => {
      readGraph.mockResolvedValue(GRAPH);
      const deps = makeDeps({ validateApiKey: jest.fn().mockResolvedValue({ userId: 'user-1', keyId: 'key-1', scopes: ['tools:read'] }) });
      await expect(call(deps)).resolves.toMatchObject({ count: 2 });
    });

    it('an account_id argument is refused and not metered: the tool cannot be pointed at another account', async () => {
      const deps = makeDeps();
      await expect(call(deps, { account_id: '999' })).rejects.toThrow(/takes no arguments/);
      expect(readGraph).not.toHaveBeenCalled();
      expect(deps.recordUsage).not.toHaveBeenCalled();
    });

    it('no token is 401', async () => {
      const deps = makeDeps();
      await expect(handleMetaToolkitCall({ authorization: undefined, toolName: 'ads_get_ad_accounts', args: {} }, deps)).rejects.toMatchObject({ status: 401 });
      expect(deps.listAccounts).not.toHaveBeenCalled();
    });
  });

  describe('manifest, annotations and parity matrix', () => {
    const row = (name: string) => ZOMA_META_PARITY_MATRIX.find((r) => r.metaTool === name)!;

    it('is advertised once with no arguments and accepted by the v1 surface check', () => {
      const defs = getMetaToolkitManifest().filter((d: any) => d.name === 'ads_get_ad_accounts');
      expect(defs).toHaveLength(1);
      expect(defs[0].inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
      expect(defs[0].description).toBe(AD_ACCOUNTS_TOOL_DEFINITION.description);
      expect(() => assertMetaToolkitV1Call('ads_get_ad_accounts', {})).not.toThrow();
    });

    it('is classified read-only, so Databricks-origin callers may use it', () => {
      expect(READ_ONLY_TOOLKIT_TOOLS.has('ads_get_ad_accounts')).toBe(true);
      expect(isDatabricksAllowedCall('ads_get_ad_accounts', {})).toBe(true);
    });

    it('matrix: ads_get_ad_accounts is covered by the tool of the same name', () => {
      expect(row('ads_get_ad_accounts')).toMatchObject({ status: 'covered', zoma: { tool: 'ads_get_ad_accounts' } });
    });

    it('matrix: ads_get_field_context is still a gap owned by ENG-3040, and no tool is advertised under that name', () => {
      expect(row('ads_get_field_context')).toMatchObject({ status: 'gap', owner: 'ENG-3040' });
      expect(getMetaToolkitManifest().some((d: any) => d.name === 'ads_get_field_context')).toBe(false);
    });

    it('Campaign management totals: 7 covered, 1 gap', () => {
      const cm = summarizeParity().find((r: any) => r.category === 'Campaign management');
      expect(cm).toMatchObject({ covered: 7, gap: 1 });
    });
  });
});
