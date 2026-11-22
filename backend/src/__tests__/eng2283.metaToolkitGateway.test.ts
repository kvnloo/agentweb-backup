/**
 * ENG-2283 acceptance contract:
 *  1. Unauthenticated / foreign-account calls are rejected (missing token, wrong account,
 *     revoked Meta connection).
 *  2. Each successful call emits exactly one usage event through the existing emitter (mocked).
 *  3. Reuses existing credential + usage storage only (deps are the existing services).
 */
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: { validateKey: jest.fn() } }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: { validateAccessToken: jest.fn() } }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn() }));
jest.mock('../mcp/metaToolkitManifest', () => {
  class MetaToolkitRefusal extends Error {}
  return {
    MetaToolkitRefusal,
    executeMetaToolkitCall: jest.fn(),
    getMetaToolkitManifest: () => [
      { name: 'list_meta_ads_campaigns', inputSchema: { properties: { account_id: {} } } },
      { name: 'get_meta_ads_metrics', inputSchema: { properties: {} } },
    ],
  };
});

import {
  MetaToolkitAuthError,
  MetaToolkitGatewayDeps,
  handleMetaToolkitCall,
} from '../mcp/metaToolkitGateway';

const NOW = Date.parse('2026-10-05T00:00:00Z');

function metaAccount(adAccountId: string, extra: Record<string, unknown> = {}) {
  return {
    platform: 'meta',
    account_id: adAccountId,
    account_name: 'acct',
    config: { account_type: 'ad_account', ad_account_id: adAccountId, access_token: 'tok', token_expires_at: NOW + 86_400_000, ...extra },
    created_at: '', updated_at: '',
  } as any;
}

function makeDeps(overrides: Partial<MetaToolkitGatewayDeps> = {}): MetaToolkitGatewayDeps {
  return {
    validateApiKey: jest.fn().mockResolvedValue({ userId: 'user-1', keyId: 'key-1' }),
    validateOAuthToken: jest.fn().mockResolvedValue(null),
    listAccounts: jest.fn().mockResolvedValue([metaAccount('111')]),
    execute: jest.fn().mockResolvedValue({ success: true }) as any,
    recordUsage: jest.fn().mockResolvedValue(true) as any,
    now: () => NOW,
    ...overrides,
  };
}

const call = (deps: MetaToolkitGatewayDeps, extra: Record<string, unknown> = {}) =>
  handleMetaToolkitCall({ authorization: 'Bearer aw_good', toolName: 'list_meta_ads_campaigns', args: {}, ...extra }, deps);

describe('ENG-2283 Meta Toolkit gateway', () => {
  it('rejects a call with no token (401) and meters nothing', async () => {
    const deps = makeDeps();
    await expect(call(deps, { authorization: undefined })).rejects.toMatchObject({ status: 401 });
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.recordUsage).not.toHaveBeenCalled();
  });

  it('rejects an invalid/revoked API key (401)', async () => {
    const deps = makeDeps({ validateApiKey: jest.fn().mockResolvedValue(null) });
    await expect(call(deps)).rejects.toBeInstanceOf(MetaToolkitAuthError);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('rejects an expired API key (401)', async () => {
    const deps = makeDeps({ validateApiKey: jest.fn().mockResolvedValue({ userId: 'u', keyId: 'k', expiresAt: '2026-01-01T00:00:00Z' }) });
    await expect(call(deps)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an unknown non-aw_ token, never treating it as internal (401)', async () => {
    const deps = makeDeps();
    await expect(call(deps, { authorization: 'Bearer some-internal-token' })).rejects.toMatchObject({ status: 401 });
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('rejects a foreign ad account the caller cannot see (403)', async () => {
    const deps = makeDeps();
    await expect(call(deps, { args: { account_id: 'act_999' } })).rejects.toMatchObject({ status: 403 });
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.recordUsage).not.toHaveBeenCalled();
  });

  it('rejects a revoked Meta connection (403)', async () => {
    const deps = makeDeps({ listAccounts: jest.fn().mockResolvedValue([metaAccount('111', { ads_scope_revoked_at: '2026-10-01' })]) });
    await expect(call(deps, { args: { account_id: '111' } })).rejects.toMatchObject({ status: 403 });
    await expect(call(deps)).rejects.toMatchObject({ status: 403 });
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('rejects an expired Meta token (403)', async () => {
    const deps = makeDeps({ listAccounts: jest.fn().mockResolvedValue([metaAccount('111', { token_expires_at: NOW - 1 })]) });
    await expect(call(deps)).rejects.toMatchObject({ status: 403 });
  });

  it('rejects when no Meta connection exists (403)', async () => {
    const deps = makeDeps({ listAccounts: jest.fn().mockResolvedValue([]) });
    await expect(call(deps)).rejects.toMatchObject({ status: 403 });
  });

  it('executes as the key owner with the resolved account and emits exactly one usage event', async () => {
    const deps = makeDeps();
    const result = await call(deps, { sessionId: 's-1' });
    expect(result).toEqual({ success: true });
    expect(deps.execute).toHaveBeenCalledWith('list_meta_ads_campaigns', { account_id: '111' }, { userId: 'user-1', sessionId: 's-1' });
    expect(deps.recordUsage).toHaveBeenCalledTimes(1);
    expect(deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1', toolName: 'list_meta_ads_campaigns', authMethod: 'api_key', apiKeyId: 'key-1',
    }));
  });

  it('accepts an MCP OAuth token and meters with the oauth client', async () => {
    const deps = makeDeps({ validateOAuthToken: jest.fn().mockResolvedValue({ userId: 'user-2', clientId: 'claude' }) });
    await call(deps, { authorization: 'Bearer oauth-token', args: { account_id: 'act_111' } });
    expect(deps.recordUsage).toHaveBeenCalledTimes(1);
    expect(deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-2', authMethod: 'oauth', clientId: 'claude' }));
  });

  it('does not inject account_id into tools whose schema lacks it', async () => {
    const deps = makeDeps();
    await call(deps, { toolName: 'get_meta_ads_metrics', args: { campaign_id: 'c1' } });
    expect(deps.execute).toHaveBeenCalledWith('get_meta_ads_metrics', { campaign_id: 'c1' }, expect.anything());
  });

  it('does not meter a call whose execution throws', async () => {
    const deps = makeDeps({ execute: jest.fn().mockRejectedValue(new Error('boom')) as any });
    await expect(call(deps)).rejects.toThrow('boom');
    expect(deps.recordUsage).not.toHaveBeenCalled();
  });

  it('enforces the API key rateLimitPerMin per credential (429 + retry-after), independent of IP', async () => {
    const { RateLimiter } = jest.requireActual('../middleware/rateLimiter');
    const limiter = new RateLimiter();
    const deps = makeDeps({
      rateLimiter: limiter,
      validateApiKey: jest.fn().mockResolvedValue({ userId: 'user-1', keyId: 'key-rl', rateLimitPerMin: 2 }),
    });
    await call(deps);
    await call(deps);
    const err = await call(deps).catch((e) => e);
    expect(err).toBeInstanceOf(MetaToolkitAuthError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(deps.execute).toHaveBeenCalledTimes(2);
    limiter.destroy?.();
  });

  it('enforces the 60/min OAuth per-user limit', async () => {
    const limiter = { check: jest.fn().mockReturnValue({ allowed: false, remaining: 0, resetInMs: 30000 }) };
    const deps = makeDeps({
      rateLimiter: limiter,
      validateOAuthToken: jest.fn().mockResolvedValue({ userId: 'user-2', clientId: 'claude' }),
    });
    const err = await handleMetaToolkitCall({ authorization: 'Bearer oauth-token', toolName: 'list_campaigns', args: {} }, deps).catch((e) => e);
    expect(err.status).toBe(429);
    expect(limiter.check).toHaveBeenCalledWith('meta-toolkit:oauth:user-2', 60);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  // ENG-2303 P2: onboarding must work before Meta is connected.
  it('zoma_status skips Meta account resolution, runs the Zoma handler, and is metered once', async () => {
    const runZomaTool = jest.fn().mockResolvedValue({ next_step: 'connect Meta' });
    const deps = makeDeps({ listAccounts: jest.fn().mockResolvedValue([]), runZomaTool: runZomaTool as any });
    const result = await call(deps, { toolName: 'zoma_status' });
    expect(result).toEqual({ next_step: 'connect Meta' });
    expect(runZomaTool).toHaveBeenCalledWith('zoma_status', {}, { userId: 'user-1' });
    expect(deps.listAccounts).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.recordUsage).toHaveBeenCalledTimes(1);
    expect(deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'zoma_status', authMethod: 'api_key' }));
  });

  it('zoma_status still requires authentication', async () => {
    const runZomaTool = jest.fn();
    const deps = makeDeps({ runZomaTool: runZomaTool as any });
    await expect(call(deps, { toolName: 'zoma_status', authorization: undefined })).rejects.toMatchObject({ status: 401 });
    expect(runZomaTool).not.toHaveBeenCalled();
  });
});
