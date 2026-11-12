// ENG-2865: the meta/zoma toolkit enforces aw_ key scopes like the main MCP (ENG-1083).
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: { validateKey: jest.fn() } }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: { validateAccessToken: jest.fn() } }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn(), recordMcpWriteExecuted: jest.fn() }));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));

import { handleMetaToolkitCall, MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';

const accounts = [
  { platform: 'meta', account_id: '123', config: { account_type: 'ad_account', ad_account_id: '123', access_token: 'x' } },
];

function makeDeps(scopes: string[] | undefined, authMethod: 'aw' | 'oauth' = 'aw') {
  const deps = {
    validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1', ...(scopes ? { scopes } : {}) }),
    validateOAuthToken: jest.fn().mockResolvedValue({ userId: 'u1', clientId: 'c1' }),
    listAccounts: jest.fn().mockResolvedValue(accounts),
    execute: jest.fn().mockResolvedValue({ rows: [] }),
    recordUsage: jest.fn().mockResolvedValue(undefined),
    recordWrite: jest.fn().mockResolvedValue(undefined),
    now: () => Date.parse('2026-11-07T00:00:00Z'),
    rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) },
    executeWrite: jest.fn().mockResolvedValue({ preview: true }),
    executeCreative: jest.fn().mockResolvedValue({ image_hash: 'h' }),
    prepareUpload: jest.fn().mockResolvedValue({ url: 'u' }),
    runZomaTool: jest.fn().mockResolvedValue({ ok: true }),
  };
  const authorization = authMethod === 'aw' ? 'Bearer aw_fixture' : 'Bearer oauth_fixture';
  return { deps: deps as unknown as MetaToolkitGatewayDeps, raw: deps, authorization };
}

const write = { toolName: 'call_meta_marketing_api', args: { entity_type: 'CAMPAIGN', action: 'CREATE', account_id: '123', name: 'x' } };
const creative = { toolName: 'call_meta_marketing_api', args: { entity_type: 'AD_CREATIVE', action: 'UPLOAD_IMAGE', account_id: '123' } };
const read = { toolName: 'call_meta_marketing_api', args: { entity_type: 'CAMPAIGN', action: 'LIST', account_id: '123' } };

describe('ENG-2865 toolkit aw_ key scopes', () => {
  it.each([
    ['guarded Meta write', write, 'executeWrite'],
    ['creative upload', creative, 'executeCreative'],
    ['zoma_prepare_upload', { toolName: 'zoma_prepare_upload', args: {} }, 'prepareUpload'],
  ])('read-only key: %s is denied 403 with no upstream call and no metering', async (_l, call, upstream) => {
    const { deps, raw, authorization } = makeDeps(['tools:read']);
    await expect(handleMetaToolkitCall({ authorization, ...call }, deps)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('tools:execute'),
    });
    expect((raw as any)[upstream]).not.toHaveBeenCalled();
    expect(raw.execute).not.toHaveBeenCalled();
    expect(raw.recordUsage).not.toHaveBeenCalled();
  });

  it('read-only key: Google Ads write is denied before the Google stack runs', async () => {
    const prev = process.env.ZOMA_GOOGLE_ADS_ENABLED;
    process.env.ZOMA_GOOGLE_ADS_ENABLED = 'true';
    try {
      const { deps, raw, authorization } = makeDeps(['tools:read']);
      await expect(handleMetaToolkitCall({
        authorization,
        toolName: 'call_google_ads_api',
        args: { entity_type: 'CAMPAIGN', action: 'UPDATE', customer_id: '1' },
      }, deps)).rejects.toMatchObject({ status: 403 });
      expect(raw.listAccounts).not.toHaveBeenCalled();
      expect(raw.recordWrite).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ZOMA_GOOGLE_ADS_ENABLED; else process.env.ZOMA_GOOGLE_ADS_ENABLED = prev;
    }
  });

  it('read-only key: reads and zoma status still work', async () => {
    const { deps, raw, authorization } = makeDeps(['tools:read']);
    await handleMetaToolkitCall({ authorization, ...read }, deps);
    expect(raw.execute).toHaveBeenCalledTimes(1);
    await handleMetaToolkitCall({ authorization, toolName: 'zoma_status', args: {} }, deps);
    expect(raw.runZomaTool).toHaveBeenCalledTimes(1);
  });

  it('execute-only key reads (execute implies read)', async () => {
    const { deps, raw, authorization } = makeDeps(['tools:execute']);
    await handleMetaToolkitCall({ authorization, ...read }, deps);
    expect(raw.execute).toHaveBeenCalledTimes(1);
  });

  it('a key with neither scope cannot read', async () => {
    const { deps, raw, authorization } = makeDeps(['email:read']);
    await expect(handleMetaToolkitCall({ authorization, ...read }, deps)).rejects.toMatchObject({ status: 403 });
    expect(raw.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['full-scope key', ['tools:read', 'tools:execute']],
    ['legacy key without scopes (grandfathered)', undefined],
  ])('%s: writes unchanged', async (_l, scopes) => {
    const { deps, raw, authorization } = makeDeps(scopes as string[] | undefined);
    await handleMetaToolkitCall({ authorization, ...write }, deps);
    expect(raw.executeWrite).toHaveBeenCalledTimes(1);
    await handleMetaToolkitCall({ authorization, toolName: 'zoma_prepare_upload', args: {} }, deps);
    expect(raw.prepareUpload).toHaveBeenCalledTimes(1);
  });

  it('OAuth callers are not affected', async () => {
    const { deps, raw, authorization } = makeDeps(undefined, 'oauth');
    // ENG-2747: a non-Databricks OAuth client (its redirect URIs are looked up per call).
    deps.getOAuthClientRedirectUris = jest.fn().mockResolvedValue(['https://claude.ai/api/mcp/auth_callback']);
    await handleMetaToolkitCall({ authorization, ...write }, deps);
    expect(raw.executeWrite).toHaveBeenCalledTimes(1);
  });
});
