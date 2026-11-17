/**
 * ENG-2747 / ENG-2781 decision 4 (option B): Zoma is read-only for OAuth clients registered from a
 * Databricks workspace. Writes are refused before any upstream call or metering, write tools are
 * hidden from tools/list, and everyone else is unaffected.
 */
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: { validateKey: jest.fn() } }));
const mockGetClient = jest.fn();
jest.mock('../mcp/oauth/oauthService', () => ({
  mcpOAuthService: { validateAccessToken: jest.fn(), getClient: (...a: unknown[]) => mockGetClient(...a) },
}));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn(), recordMcpWriteExecuted: jest.fn() }));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));

import { authenticateMetaToolkitCaller, handleMetaToolkitCall, MetaToolkitAuthError, MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { getMetaToolkitManifest, MetaToolkitRefusal } from '../mcp/metaToolkitManifest';
import { getGoogleToolkitManifest } from '../mcp/googleToolkitManifest';
import { annotateToolkitTools, READ_ONLY_TOOLKIT_TOOLS } from '../mcp/toolkitToolAnnotations';
import {
  DATABRICKS_READ_ONLY_MESSAGE,
  databricksToolView,
  isDatabricksAllowedCall,
  isDatabricksClient,
  isDatabricksRedirectUri,
} from '../mcp/zomaDatabricksReadOnly';

const DATABRICKS_REDIRECT = 'https://dbc-519ea225-682e.cloud.databricks.com/login/oauth/http.html';
const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const accounts = [
  { platform: 'meta', account_id: '123', config: { account_type: 'ad_account', ad_account_id: '123', access_token: 'x' } },
];

function makeDeps(redirectUris: (() => Promise<string[] | null>) | string[] | null) {
  const deps = {
    validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1' }),
    validateOAuthToken: jest.fn().mockResolvedValue({ userId: 'u1', clientId: 'c1' }),
    listAccounts: jest.fn().mockResolvedValue(accounts),
    execute: jest.fn().mockResolvedValue({ rows: [] }),
    recordUsage: jest.fn().mockResolvedValue(undefined),
    recordWrite: jest.fn().mockResolvedValue(undefined),
    now: () => Date.parse('2026-11-12T00:00:00Z'),
    rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) },
    executeWrite: jest.fn().mockResolvedValue({ preview: true }),
    executeLifecycle: jest.fn().mockResolvedValue({ ok: true }),
    executeAudience: jest.fn().mockResolvedValue({ ok: true }),
    prepareUpload: jest.fn().mockResolvedValue({ url: 'u' }),
    runZomaTool: jest.fn().mockResolvedValue({ ok: true }),
    getOAuthClientRedirectUris:
      typeof redirectUris === 'function' ? jest.fn(redirectUris) : jest.fn().mockResolvedValue(redirectUris),
  };
  return { deps: deps as unknown as MetaToolkitGatewayDeps, raw: deps };
}

type Schemaful = { inputSchema: { properties: Record<string, { enum?: string[] } | undefined> } };

const OAUTH = 'Bearer oauth_fixture';
const createCampaign = {
  toolName: 'call_meta_marketing_api',
  args: { entity_type: 'CAMPAIGN', action: 'CREATE', account_id: '123', name: 'x' },
};

describe('ENG-2747 Databricks host detection', () => {
  it.each([
    DATABRICKS_REDIRECT,
    'https://adb-1234567890123456.7.azuredatabricks.net/login/oauth/http.html',
    'https://1234567890123456.7.gcp.databricks.com/login/oauth/http.html',
    'https://acme.cloud.databricks.com/some/other/path',
    'https://dbc-1.cloud.databricks.us/login/oauth/http.html',
    'https://adb-1.2.databricks.azure.cn/login/oauth/http.html',
    'https://myapp-123.aws.databricksapps.com/oauth/callback',
    'https://acme.cloud.databricks.com./login/oauth/http.html',
  ])('recognises %s', (uri) => expect(isDatabricksRedirectUri(uri)).toBe(true));

  it.each([
    CLAUDE_REDIRECT,
    'https://databricks.com.evil.example/login/oauth/http.html',
    'https://evildatabricks.com/login/oauth/http.html',
    'http://localhost:3334/callback',
    'not a url',
  ])('does not recognise %s', (uri) => expect(isDatabricksRedirectUri(uri)).toBe(false));

  it('a client is Databricks-origin if any of its redirect URIs is', () => {
    expect(isDatabricksClient([CLAUDE_REDIRECT, DATABRICKS_REDIRECT])).toBe(true);
    expect(isDatabricksClient([CLAUDE_REDIRECT])).toBe(false);
    expect(isDatabricksClient(null)).toBe(false);
  });
});

describe('ENG-2747 Databricks allowed calls', () => {
  it('allows verified reads and the onboarding/local tools', () => {
    for (const name of READ_ONLY_TOOLKIT_TOOLS) expect(isDatabricksAllowedCall(name, {})).toBe(true);
    for (const name of ['zoma_status', 'zoma_usage', 'ads_get_errors', 'ads_get_help_article']) expect(isDatabricksAllowedCall(name, {})).toBe(true);
  });

  it('allows call_meta_marketing_api only for read actions without confirm or preview_token', () => {
    for (const action of ['LIST', 'GET', 'PREVIEW', 'SEARCH', 'GET_MATCH_QUALITY']) {
      expect(isDatabricksAllowedCall('call_meta_marketing_api', { action })).toBe(true);
    }
    for (const action of ['CREATE', 'UPDATE', 'ARCHIVE', 'DELETE', 'COPY', 'UPLOAD_IMAGE', 'BULK_CREATE', '']) {
      expect(isDatabricksAllowedCall('call_meta_marketing_api', { action })).toBe(false);
    }
    expect(isDatabricksAllowedCall('call_meta_marketing_api', { action: 'LIST', confirm: true })).toBe(false);
    expect(isDatabricksAllowedCall('call_meta_marketing_api', { action: 'GET', preview_token: 't' })).toBe(false);
    expect(isDatabricksAllowedCall('call_meta_marketing_api', undefined)).toBe(false);
  });

  it('refuses every other tool, including unknown and future ones', () => {
    for (const name of ['zoma_custom_audiences', 'call_google_ads_api', 'zoma_prepare_upload', 'meta_delete_product', 'brand_new_tool']) {
      expect(isDatabricksAllowedCall(name, {})).toBe(false);
    }
  });
});

describe('ENG-2747 gateway enforcement', () => {
  it('refuses a write from a Databricks-origin OAuth client before any upstream call or metering', async () => {
    const { deps, raw } = makeDeps([DATABRICKS_REDIRECT]);
    // Databricks replaces the text of any MCP tool error with a generic line, so the refusal comes back as a
    // normal result that carries the reason (still refused, still not executed or metered).
    await expect(handleMetaToolkitCall({ authorization: OAUTH, ...createCampaign }, deps)).resolves.toEqual({
      success: false,
      message: DATABRICKS_READ_ONLY_MESSAGE,
    });
    await expect(
      handleMetaToolkitCall({ authorization: OAUTH, toolName: 'zoma_prepare_upload', args: {} }, deps),
    ).resolves.toMatchObject({ success: false, message: expect.stringMatching(/read-only/) });
    // A model that retries with its own confirm flag gets the same refusal.
    await expect(
      handleMetaToolkitCall({ authorization: OAUTH, toolName: 'call_meta_marketing_api', args: { action: 'UPDATE', confirm: true } }, deps),
    ).resolves.toMatchObject({ success: false, message: DATABRICKS_READ_ONLY_MESSAGE });
    expect(raw.executeWrite).not.toHaveBeenCalled();
    expect(raw.prepareUpload).not.toHaveBeenCalled();
    expect(raw.listAccounts).not.toHaveBeenCalled();
    expect(raw.recordUsage).not.toHaveBeenCalled();
  });

  it('returns a refusal raised after the gate (Meta rejecting a read) to Databricks as a result, and keeps throwing it for everyone else', async () => {
    const { deps, raw } = makeDeps([DATABRICKS_REDIRECT]);
    raw.execute.mockRejectedValueOnce(new MetaToolkitRefusal('Meta rejected this read'));
    await expect(
      handleMetaToolkitCall({ authorization: OAUTH, toolName: 'list_meta_ads_campaigns', args: {} }, deps),
    ).resolves.toEqual({ success: false, message: 'Meta rejected this read' });
    expect(raw.recordUsage).not.toHaveBeenCalled();

    const other = makeDeps([CLAUDE_REDIRECT]);
    other.raw.execute.mockRejectedValueOnce(new MetaToolkitRefusal('Meta rejected this read'));
    await expect(
      handleMetaToolkitCall({ authorization: OAUTH, toolName: 'list_meta_ads_campaigns', args: {} }, other.deps),
    ).rejects.toThrow('Meta rejected this read');
  });

  it('tells a Databricks caller with no usable Meta account why (403), but keeps 429 and plain errors as errors', async () => {
    const noAccount = makeDeps([DATABRICKS_REDIRECT]);
    noAccount.raw.listAccounts.mockResolvedValue([]);
    await expect(
      handleMetaToolkitCall({ authorization: OAUTH, toolName: 'list_meta_ads_campaigns', args: {} }, noAccount.deps),
    ).resolves.toMatchObject({ success: false, message: expect.stringMatching(/No usable .* is connected/) });
    expect(noAccount.raw.execute).not.toHaveBeenCalled();
    expect(noAccount.raw.recordUsage).not.toHaveBeenCalled();

    // Everyone else still gets the thrown 403, and rate limits / unexpected failures stay protocol errors.
    const other = makeDeps([CLAUDE_REDIRECT]);
    other.raw.listAccounts.mockResolvedValue([]);
    await expect(
      handleMetaToolkitCall({ authorization: OAUTH, toolName: 'list_meta_ads_campaigns', args: {} }, other.deps),
    ).rejects.toMatchObject({ status: 403 });

    const limited = makeDeps([DATABRICKS_REDIRECT]);
    limited.raw.execute.mockRejectedValueOnce(new MetaToolkitAuthError('slow down', 429, 5));
    await expect(
      handleMetaToolkitCall({ authorization: OAUTH, toolName: 'list_meta_ads_campaigns', args: {} }, limited.deps),
    ).rejects.toMatchObject({ status: 429 });

    const broken = makeDeps([DATABRICKS_REDIRECT]);
    broken.raw.execute.mockRejectedValueOnce(new Error('boom'));
    await expect(
      handleMetaToolkitCall({ authorization: OAUTH, toolName: 'list_meta_ads_campaigns', args: {} }, broken.deps),
    ).rejects.toThrow('boom');
  });

  it('logs a gate refusal with the tool name and action only, never the arguments', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { deps } = makeDeps([DATABRICKS_REDIRECT]);
      await handleMetaToolkitCall(
        { authorization: OAUTH, toolName: 'call_meta_marketing_api', args: { action: 'UPDATE', confirm: true, params: { name: 'secret campaign copy' } } },
        deps,
      );
      expect(warn).toHaveBeenCalledWith('[meta-toolkit] databricks read-only gate refused', { tool: 'call_meta_marketing_api', action: 'UPDATE' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret campaign copy');
    } finally {
      warn.mockRestore();
    }
  });

  it('lets a Databricks-origin OAuth client read', async () => {
    const { deps, raw } = makeDeps([DATABRICKS_REDIRECT]);
    await handleMetaToolkitCall({ authorization: OAUTH, toolName: 'list_meta_ads_campaigns', args: {} }, deps);
    expect(raw.execute).toHaveBeenCalledTimes(1);
    // Usage analytics tag the call as Databricks traffic.
    expect(raw.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ clientType: 'databricks' }));
  });

  it('does not tag non-Databricks OAuth callers as Databricks in usage', async () => {
    const { deps, raw } = makeDeps([CLAUDE_REDIRECT]);
    await handleMetaToolkitCall({ authorization: OAUTH, toolName: 'list_meta_ads_campaigns', args: {} }, deps);
    expect(raw.recordUsage).toHaveBeenCalledWith(expect.not.objectContaining({ clientType: 'databricks' }));
  });

  it('leaves non-Databricks OAuth clients, aw_ keys and unknown clients able to write', async () => {
    for (const uris of [[CLAUDE_REDIRECT], null]) {
      const { deps, raw } = makeDeps(uris);
      await handleMetaToolkitCall({ authorization: OAUTH, ...createCampaign }, deps);
      expect(raw.executeWrite).toHaveBeenCalledTimes(1);
    }
    const { deps, raw } = makeDeps([DATABRICKS_REDIRECT]);
    await handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', ...createCampaign }, deps);
    expect(raw.executeWrite).toHaveBeenCalledTimes(1);
    expect(raw.getOAuthClientRedirectUris).not.toHaveBeenCalled();
  });

  it('fails closed: a client lookup error refuses the call with a retryable 503, never lets it through', async () => {
    const { deps, raw } = makeDeps(() => Promise.reject(new Error('dynamo down')));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(handleMetaToolkitCall({ authorization: OAUTH, ...createCampaign }, deps)).rejects.toMatchObject({ status: 503 });
    await expect(authenticateMetaToolkitCaller(OAUTH, deps)).rejects.toMatchObject({ status: 503 });
    expect(raw.executeWrite).not.toHaveBeenCalled();
    expect(raw.recordUsage).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('uses the real client record and caches the answer per client', async () => {
    const { deps } = makeDeps(null);
    delete (deps as Partial<MetaToolkitGatewayDeps>).getOAuthClientRedirectUris;
    (deps.validateOAuthToken as jest.Mock).mockResolvedValue({ userId: 'u1', clientId: 'dbx-client' });
    mockGetClient.mockResolvedValue({ clientId: 'dbx-client', redirectUris: [DATABRICKS_REDIRECT] });
    expect((await authenticateMetaToolkitCaller(OAUTH, deps)).databricksOrigin).toBe(true);
    expect((await authenticateMetaToolkitCaller(OAUTH, deps)).databricksOrigin).toBe(true);
    expect(mockGetClient).toHaveBeenCalledTimes(1);

    (deps.validateOAuthToken as jest.Mock).mockResolvedValue({ userId: 'u1', clientId: 'claude-client' });
    mockGetClient.mockResolvedValue({ clientId: 'claude-client', redirectUris: [CLAUDE_REDIRECT] });
    expect((await authenticateMetaToolkitCaller(OAUTH, deps)).databricksOrigin).toBe(false);

    (deps.validateOAuthToken as jest.Mock).mockResolvedValue({ userId: 'u1', clientId: 'zoma-device-setup' });
    mockGetClient.mockResolvedValue(null);
    expect((await authenticateMetaToolkitCaller(OAUTH, deps)).databricksOrigin).toBe(false);
  });
});

describe('ENG-2747 Databricks tools/list view', () => {
  const all = annotateToolkitTools([...getMetaToolkitManifest(), ...getGoogleToolkitManifest()]);
  const view = databricksToolView(all);

  it('shows only tools the caller may call', () => {
    for (const t of view) {
      const probe = t.name === 'call_meta_marketing_api' ? { action: 'LIST' } : {};
      expect(isDatabricksAllowedCall(t.name, probe)).toBe(true);
    }
    const names = view.map((t) => t.name);
    for (const hidden of ['zoma_custom_audiences', 'call_google_ads_api', 'zoma_prepare_upload', 'meta_delete_product']) {
      expect(names).not.toContain(hidden);
    }
    expect(names).toContain('list_meta_ads_campaigns');
  });

  it('narrows call_meta_marketing_api to read actions and drops confirm/preview_token, without mutating the source', () => {
    const narrowed = view.find((t) => t.name === 'call_meta_marketing_api') as unknown as Schemaful;
    expect(narrowed.inputSchema.properties.action?.enum).toEqual(['LIST', 'GET', 'PREVIEW', 'SEARCH', 'GET_MATCH_QUALITY']);
    expect(narrowed.inputSchema.properties.confirm).toBeUndefined();
    expect(narrowed.inputSchema.properties.preview_token).toBeUndefined();
    expect((narrowed as unknown as { annotations: { readOnlyHint: boolean } }).annotations.readOnlyHint).toBe(true);
    const original = all.find((t) => t.name === 'call_meta_marketing_api') as unknown as Schemaful;
    expect(original.inputSchema.properties.action?.enum).toContain('CREATE');
    expect(original.inputSchema.properties.confirm).toBeDefined();
  });
});
