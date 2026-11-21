/**
 * ENG-3142 — X Ads is dark until ZOMA_X_ADS_ENABLED=true, then routed through the real Zoma
 * gateway: own-account resolution, token decryption, platform x_ads metering, readiness and the
 * OAuth 1.0a connect flow (X faked at the HTTP boundary).
 */
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../utils/secretsManager', () => ({
  ...jest.requireActual('../utils/secretsManager'),
  getXAdsCredentials: jest.fn().mockResolvedValue({ consumerKey: 'ck', consumerSecret: 'cs' }),
}));
const mockFetch = jest.fn();
(global as any).fetch = (...a: any[]) => mockFetch(...a);

import { handleMetaToolkitCall, MetaToolkitAuthError, type MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { formatZomaStatus, getZomaReadiness } from '../mcp/zomaOnboarding';
import { resolveProviderAccount, X_ADS_PROVIDER } from '../mcp/zomaProviders';
import { toolkitManifest } from '../routes/metaToolkit';
import {
  buildXAdsConnectLink, completeXAdsConnect, PendingXConnects, startXAdsConnect, verifyXAdsConnectLink, type ZomaXAdsConnectDeps,
} from '../mcp/zomaXAdsConnect';
import { encryptPassword } from '../utils/crypto';
import { redactAccountSecrets } from '../utils/accountSecretRedaction';

const NOW = Date.parse('2026-11-20T00:00:00Z');
const ok = (body: unknown) => ({ status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

const xAccount = (id = 'acc1', over: Record<string, unknown> = {}) => ({
  platform: 'x_ads',
  account_id: id,
  account_name: 'Acme on X',
  config: {
    account_type: 'x_ads', ad_account_id: id, currency: 'USD', token_expires_at: 0,
    access_token: encryptPassword('tok', 'u1'), access_token_secret: encryptPassword('sec', 'u1'), ...over,
  },
});
const metaAccount = () => ({
  platform: 'meta', account_id: 'act_1', account_name: 'Meta',
  config: { account_type: 'ad_account', ad_account_id: 'act_1', access_token: 'm', token_expires_at: NOW + 1e9 },
});

function gatewayDeps(accounts: any[], over: Partial<MetaToolkitGatewayDeps> = {}): MetaToolkitGatewayDeps {
  return {
    validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1' }),
    validateOAuthToken: jest.fn().mockResolvedValue(null),
    listAccounts: jest.fn().mockResolvedValue(accounts),
    execute: jest.fn().mockResolvedValue({ success: true }) as any,
    recordUsage: jest.fn().mockResolvedValue(true) as any,
    recordWrite: jest.fn().mockResolvedValue(true) as any,
    now: () => NOW,
    rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) } as any,
    ...over,
  };
}
const call = (deps: MetaToolkitGatewayDeps, toolName: string, args: any) =>
  handleMetaToolkitCall({ authorization: 'Bearer aw_good', toolName, args }, deps);

const prev = process.env.ZOMA_X_ADS_ENABLED;
afterEach(() => {
  if (prev === undefined) delete process.env.ZOMA_X_ADS_ENABLED;
  else process.env.ZOMA_X_ADS_ENABLED = prev;
  mockFetch.mockReset();
  jest.clearAllMocks();
});

describe('ENG-3142 flag', () => {
  it('off (default): X tools are not listed and not routed; X is never called', async () => {
    delete process.env.ZOMA_X_ADS_ENABLED;
    expect(toolkitManifest(false).map((t: any) => t.name)).not.toEqual(expect.arrayContaining(['x_ads_read']));
    const deps = gatewayDeps([metaAccount(), xAccount()], { execute: jest.fn().mockRejectedValue(new MetaToolkitRefusal('not part')) as any });
    await expect(call(deps, 'x_ads_read', { action: 'LIST_CAMPAIGNS' })).rejects.toBeInstanceOf(MetaToolkitRefusal);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('on: X tools are listed with annotations', () => {
    process.env.ZOMA_X_ADS_ENABLED = 'true';
    const tools = toolkitManifest(false) as any[];
    expect(tools.find((t) => t.name === 'x_ads_read')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((t) => t.name === 'x_ads_write')?.annotations).toMatchObject({ destructiveHint: true });
  });
});

describe('ENG-3142 gateway (flag on)', () => {
  beforeEach(() => { process.env.ZOMA_X_ADS_ENABLED = 'true'; });

  it('a read runs on the caller\'s own account with the decrypted user token, metered once as x_ads', async () => {
    mockFetch.mockResolvedValue(ok({ data: [{ id: 'c1' }] }));
    const deps = gatewayDeps([xAccount()]);
    const result: any = await call(deps, 'x_ads_read', { action: 'LIST_CAMPAIGNS' });
    expect(result).toMatchObject({ success: true, account_id: 'acc1', data: [{ id: 'c1' }] });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toMatch(/^https:\/\/ads-api\.x\.com\/12\/accounts\/acc1\/campaigns/);
    expect(init.headers.Authorization).toMatch(/oauth_consumer_key="ck"/);
    expect(init.headers.Authorization).toMatch(/oauth_token="tok"/);
    expect(deps.recordUsage).toHaveBeenCalledTimes(1);
    expect(deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'x_ads_read', platform: 'x_ads' }));
    expect(deps.recordWrite).not.toHaveBeenCalled();
  });

  it('an account_id that is not connected is a tool error naming the connected ids; a revoked one is 403; X is never called', async () => {
    const deps = gatewayDeps([xAccount()]);
    const wrong = call(deps, 'x_ads_read', { action: 'LIST_CAMPAIGNS', account_id: 'someoneelse' });
    await expect(wrong).rejects.toBeInstanceOf(MetaToolkitRefusal);
    await expect(call(deps, 'x_ads_read', { action: 'LIST_CAMPAIGNS', account_id: 'someoneelse' }))
      .rejects.toThrow("X Ads account someoneelse isn't connected; connected: acc1.");
    await expect(call(gatewayDeps([xAccount('acc1', { needs_reconnect: true })]), 'x_ads_read', { action: 'LIST_CAMPAIGNS' }))
      .rejects.toBeInstanceOf(MetaToolkitAuthError);
    await expect(call(deps, 'x_ads_write', { entity_type: 'CAMPAIGN', action: 'DELETE' })).rejects.toBeInstanceOf(MetaToolkitRefusal);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('two connected X accounts without account_id is ambiguous', () => {
    expect(resolveProviderAccount(X_ADS_PROVIDER, [xAccount('a1'), xAccount('a2')] as any, undefined, NOW))
      .toMatchObject({ ok: false, kind: 'ambiguous', message: 'Multiple X Ads accounts are connected; pass account_id.' });
  });

  it('a write preview needs tools:execute scope and reaches X only for reads', async () => {
    mockFetch.mockResolvedValue(ok({ data: { id: 'c1', name: 'Launch', entity_status: 'PAUSED', daily_budget_amount_local_micro: 5000000 } }));
    const deps = gatewayDeps([xAccount()]);
    // Payment readiness is checked through zomaOnboarding; stub it at the module edge.
    const onboarding = require('../mcp/zomaOnboarding');
    const spy = jest.spyOn(onboarding, 'assertZomaWriteReady').mockResolvedValue(undefined);
    const preview: any = await call(deps, 'x_ads_write', { entity_type: 'CAMPAIGN', action: 'PAUSE', campaign_id: 'c1' });
    expect(preview.status).toBe('PREVIEW');
    expect(mockFetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
    expect(deps.recordWrite).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('stored tokens are redacted from API responses (access_token_secret included)', () => {
    const redacted = redactAccountSecrets(xAccount() as any);
    expect(redacted.config).not.toHaveProperty('access_token');
    expect(redacted.config).not.toHaveProperty('access_token_secret');
  });
});

describe('ENG-3142 zoma_status', () => {
  const onboardingDeps = (accounts: any[], xEnabled: boolean) => ({
    getUser: jest.fn().mockResolvedValue({ userId: 'u1', email: 'a@b.co', zomaAdsExperience: 'runs_ads' }),
    listAccounts: jest.fn().mockResolvedValue(accounts),
    findLiveCustomerId: jest.fn(),
    createCustomerForUser: jest.fn(),
    resolvePaymentMethod: jest.fn().mockResolvedValue({ hasPaymentMethod: true }),
    createPaymentMethodSetupSession: jest.fn(),
    buildMetaConnectUrl: jest.fn().mockResolvedValue('https://facebook.example/connect'),
    buildXAdsConnectUrl: jest.fn().mockResolvedValue('https://api.example/api/oauth/x-ads/start?t=abc'),
    googleEnabled: () => false,
    xAdsEnabled: () => xEnabled,
    pagesUrl: () => 'https://api.agentweb.pro',
    now: () => NOW,
    getUsage: jest.fn(),
  }) as any;

  it('flag off: no x_ads field, no X link minted, no X line rendered', async () => {
    const d = onboardingDeps([], false);
    const r = await getZomaReadiness('u1', d);
    expect(r).not.toHaveProperty('x_ads');
    expect(d.buildXAdsConnectUrl).not.toHaveBeenCalled();
    expect(r.next_step).not.toMatch(/X Ads/);
    expect(formatZomaStatus(r)).not.toMatch(/X Ads/);
  });

  it('flag on: X is a connectable provider; an X connection alone is enough', async () => {
    const neither = await getZomaReadiness('u1', onboardingDeps([], true));
    expect(neither.x_ads).toMatchObject({ available: true, ready: false, link: 'https://api.example/api/oauth/x-ads/start?t=abc' });
    expect(neither.next_step).toContain('https://api.example/api/oauth/x-ads/start?t=abc');

    const xOnly = await getZomaReadiness('u1', onboardingDeps([xAccount()], true));
    expect(xOnly.next_step).toBeNull();
    expect(xOnly.x_ads).toMatchObject({ ready: true, writes_enabled: true, accounts: [{ account_id: 'acc1', currency: 'USD' }] });
    expect(formatZomaStatus(xOnly)).toContain('[x] X Ads account connected (acc1, USD)');
    expect(formatZomaStatus(xOnly)).toContain('How did my X Ads campaigns do');

    const metaOnly = await getZomaReadiness('u1', onboardingDeps([metaAccount()], true));
    expect(metaOnly.x_ads?.ready).toBe(false);
  });
});

describe('ENG-3142 OAuth 1.0a connect', () => {
  const connectDeps = (over: Partial<ZomaXAdsConnectDeps> = {}): ZomaXAdsConnectDeps => ({
    enabled: () => true,
    backendUrl: () => 'https://api.example',
    getAppCredentials: jest.fn().mockResolvedValue({ consumerKey: 'ck', consumerSecret: 'cs' }),
    encrypt: (p, u) => `enc(${p},${u})`,
    saveAccount: jest.fn().mockResolvedValue(undefined),
    pending: new PendingXConnects(),
    now: () => NOW,
    fetchImpl: mockFetch,
    ...over,
  });

  it('start → X authorize; callback stores one encrypted x_ads row per ad account', async () => {
    const d = connectDeps();
    mockFetch
      .mockResolvedValueOnce(ok('oauth_token=rt&oauth_token_secret=rts&oauth_callback_confirmed=true'))
      .mockResolvedValueOnce(ok('oauth_token=at&oauth_token_secret=ats&user_id=42&screen_name=acme'))
      .mockResolvedValueOnce(ok({ data: [{ id: 'acc1', name: 'Acme', currency: 'USD', timezone: 'America/New_York' }, { id: 'old', deleted: true }] }));
    const link = buildXAdsConnectLink('u1', 'https://api.example');
    const start = await startXAdsConnect(new URL(link).searchParams.get('t'), d);
    expect(start).toEqual({ kind: 'redirect', url: 'https://api.x.com/oauth/authorize?oauth_token=rt' });
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toContain(encodeURIComponent('https://api.example/api/oauth/x-ads/callback'));

    const done = await completeXAdsConnect({ oauth_token: 'rt', oauth_verifier: 'v' }, d);
    expect(done).toMatchObject({ kind: 'page', status: 200, title: 'X Ads connected' });
    expect(d.saveAccount).toHaveBeenCalledTimes(1);
    expect(d.saveAccount).toHaveBeenCalledWith('u1', 'x_ads', expect.objectContaining({
      account_id: 'acc1',
      config: expect.objectContaining({ ad_account_id: 'acc1', access_token: 'enc(at,u1)', access_token_secret: 'enc(ats,u1)', token_expires_at: 0, screen_name: 'acme' }),
    }));
    // Single use: replaying the callback stores nothing.
    expect(await completeXAdsConnect({ oauth_token: 'rt', oauth_verifier: 'v' }, d)).toMatchObject({ status: 400 });
    expect(d.saveAccount).toHaveBeenCalledTimes(1);
  });

  it('flag off: both routes 404 and X is never called; a forged link is refused', async () => {
    const off = connectDeps({ enabled: () => false });
    expect(await startXAdsConnect(buildXAdsConnectLink('u1', 'https://x').split('t=')[1], off)).toMatchObject({ status: 404 });
    expect(await completeXAdsConnect({ oauth_token: 'a', oauth_verifier: 'b' }, off)).toMatchObject({ status: 404 });
    expect(await startXAdsConnect('not-a-jwt', connectDeps())).toMatchObject({ status: 400 });
    expect(verifyXAdsConnectLink('not-a-jwt')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('declining on X connects nothing', async () => {
    const d = connectDeps();
    expect(await completeXAdsConnect({ denied: 'rt' }, d)).toMatchObject({ title: 'X Ads not connected' });
    expect(d.saveAccount).not.toHaveBeenCalled();
  });
});
