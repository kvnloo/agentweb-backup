// ENG-2914: zoma_custom_audiences is advertised, scope-checked (ENG-2865), account-resolved and metered.
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
import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';

const accounts = [
  { platform: 'meta', account_id: '123', config: { account_type: 'ad_account', ad_account_id: '123', access_token: 'x' } },
];

function makeDeps(scopes: string[] | undefined, audienceResult: any = { success: true, audiences: [] }) {
  const deps = {
    validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1', ...(scopes ? { scopes } : {}) }),
    validateOAuthToken: jest.fn().mockResolvedValue({ userId: 'u1', clientId: 'c1' }),
    listAccounts: jest.fn().mockResolvedValue(accounts),
    execute: jest.fn(),
    recordUsage: jest.fn().mockResolvedValue(undefined),
    recordWrite: jest.fn().mockResolvedValue(undefined),
    now: () => Date.parse('2026-11-10T00:00:00Z'),
    rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) },
    runZomaTool: jest.fn(),
    executeAudience: jest.fn().mockResolvedValue(audienceResult),
  };
  return { deps: deps as unknown as MetaToolkitGatewayDeps, raw: deps };
}

const call = (action: string, extra: any = {}) => ({ authorization: 'Bearer aw_fixture', toolName: 'zoma_custom_audiences', args: { action, ...extra } });

describe('ENG-2914 zoma_custom_audiences gateway', () => {
  it('is advertised in the toolkit manifest with its actions', () => {
    const def = getMetaToolkitManifest().find((d: any) => d.name === 'zoma_custom_audiences');
    expect(def.inputSchema.properties.action.enum).toEqual(
      ['LIST', 'GET', 'LIST_AD_SETS', 'CREATE', 'UPDATE', 'ADD_USERS', 'REMOVE_USERS', 'DELETE', 'EXCLUDE_CUSTOMERS'],
    );
    expect(def.inputSchema.properties.source.properties.type.enum).toContain('external_provider');
  });

  it.each(['CREATE', 'UPDATE', 'ADD_USERS', 'REMOVE_USERS', 'DELETE', 'EXCLUDE_CUSTOMERS', 'SOMETHING_NEW'])(
    'read-only aw_ key: %s is denied 403 before any upstream call or metering', async (action) => {
      const { deps, raw } = makeDeps(['tools:read']);
      await expect(handleMetaToolkitCall(call(action), deps)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('tools:execute') });
      expect(raw.executeAudience).not.toHaveBeenCalled();
      expect(raw.listAccounts).not.toHaveBeenCalled();
      expect(raw.recordUsage).not.toHaveBeenCalled();
    });

  it('read-only aw_ key: reads run against the resolved account and are metered once as tool use', async () => {
    const { deps, raw } = makeDeps(['tools:read']);
    await handleMetaToolkitCall(call('LIST'), deps);
    expect(raw.executeAudience).toHaveBeenCalledWith('u1', { action: 'LIST', account_id: '123' });
    expect(raw.recordUsage).toHaveBeenCalledTimes(1);
    expect(raw.recordWrite).not.toHaveBeenCalled();
    expect(raw.runZomaTool).not.toHaveBeenCalled();
  });

  it('a foreign account_id is refused 403', async () => {
    const { deps, raw } = makeDeps(undefined);
    await expect(handleMetaToolkitCall(call('LIST', { account_id: '999' }), deps)).rejects.toMatchObject({ status: 403 });
    expect(raw.executeAudience).not.toHaveBeenCalled();
  });

  it('an executed write (has a verification) is metered as a CUSTOM_AUDIENCE write; a preview is not', async () => {
    const preview = makeDeps(undefined, { status: 'PREVIEW', preview_token: 't' });
    await handleMetaToolkitCall(call('CREATE', { params: { name: 'x' } }), preview.deps);
    expect(preview.raw.recordWrite).not.toHaveBeenCalled();
    expect(preview.raw.recordUsage).toHaveBeenCalledTimes(1);

    const done = makeDeps(undefined, { success: true, verification: 'CONFIRMED', id: '600' });
    await handleMetaToolkitCall(call('EXCLUDE_CUSTOMERS', { ad_set_ids: ['1'] }), done.deps);
    expect(done.raw.recordWrite).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'zoma_custom_audiences', platform: 'meta', entityType: 'CUSTOM_AUDIENCE', action: 'EXCLUDE_CUSTOMERS', verification: 'CONFIRMED', objectId: '600',
    }));
  });
});
