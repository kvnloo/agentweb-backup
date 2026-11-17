process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
/**
 * ENG-2823 — Zoma Google Ads toolkit on the provider-pluggable template.
 *  - Google reads go through the same handler objects Emma registers, against the caller's
 *    own/org-shared customer only; usage is metered with platform google_ads.
 *  - A write without confirm sends nothing to Google and returns a PREVIEW + token.
 *  - confirm + that token applies exactly once, then read-back decides CONFIRMED.
 *  - Spend ceiling refusal; stale / reused / state-changed tokens never dispatch.
 *  - ENG-2036 shape validation runs before readiness/credentials; ENG-592 read-back mismatch
 *    is never success; budgets in major units are echoed as micros; creates are PAUSED.
 *  - Flag off (default): the toolkit is Meta-only, exactly as before.
 */
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../emma/impl/adsCrmApis', () => ({
  handleCallGoogleAdsApi: jest.fn().mockResolvedValue({ success: true, budgets: [] }),
  handleCallGoogleAdsReportingApi: jest.fn().mockResolvedValue({ success: true, results: [] }),
}));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));

import * as adsCrmApis from '../emma/impl/adsCrmApis';
import { callGoogleAdsApiTool, googleAdsToolRegistry, GOOGLE_ADS_TOOL_NAMES } from '../emma/googleAdsTools';
import { assertGoogleToolkitCall, executeGoogleToolkitRead, getGoogleToolkitManifest } from '../mcp/googleToolkitManifest';
import {
  executeGoogleToolkitWrite, googleSpendCeilingPolicyFromEnv, majorToMicros, type GoogleToolkitWriteDeps,
} from '../mcp/googleToolkitWrites';
import { handleMetaToolkitCall, MetaToolkitAuthError, type MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { assertZomaWriteReady, formatZomaStatus, getZomaReadiness, ZomaNotReadyError } from '../mcp/zomaOnboarding';
import { GOOGLE_ADS_PROVIDER, META_PROVIDER, resolveProviderAccount } from '../mcp/zomaProviders';

const NOW = Date.parse('2026-11-05T00:00:00Z');
const CID = '1234567890';
const BUDGET = `customers/${CID}/campaignBudgets/55`;
const CAMPAIGN = `customers/${CID}/campaigns/77`;

const googleAccount = (customerId = CID, over: Record<string, unknown> = {}) => ({
  platform: 'google_ads',
  account_id: customerId,
  account_name: 'Acme Search',
  config: { account_type: 'google_ads', customer_id: customerId, login_customer_id: '999', currency: 'USD', access_token: 't', refresh_token: 'r', ...over },
}) as any;
const metaAccount = () => ({
  platform: 'meta', account_id: 'act_111', account_name: 'Phoenix',
  config: { account_type: 'ad_account', ad_account_id: '111', access_token: 'tok', granted_scopes: ['ads_management'] },
}) as any;

// ── Write executor ────────────────────────────────────────────────────────────

function writeDeps(over: Partial<GoogleToolkitWriteDeps> = {}) {
  const state: Record<string, any> = {
    [BUDGET]: { resourceName: BUDGET, name: 'Daily', amountMicros: 20_000_000, explicitlyShared: false, referenceCount: 1 },
    [CAMPAIGN]: { resourceName: CAMPAIGN, name: 'Brand', status: 'PAUSED', budget: BUDGET },
  };
  const deps: GoogleToolkitWriteDeps & { state: Record<string, any> } = {
    state,
    assertReady: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(async (_u: string, _c: string, _k: string, rn: string) => (state[rn] ? { ...state[rn] } : null)),
    dispatch: jest.fn(async (_u: string, args: any) => {
      // Simulates Google applying the change.
      if (args.entity_type === 'BUDGET' && args.action === 'UPDATE') state[args.budget_resource_name].amountMicros = args.amount_micros;
      if (args.entity_type === 'CAMPAIGN' && args.action === 'UPDATE') state[args.campaign_resource_name].status = args.status;
      if (args.entity_type === 'BUDGET' && args.action === 'CREATE') {
        const rn = `customers/${CID}/campaignBudgets/900`;
        state[rn] = { resourceName: rn, name: args.name, amountMicros: args.amount_micros, explicitlyShared: args.explicitly_shared, referenceCount: 0 };
        return { success: true, budgetResourceName: rn };
      }
      if (args.entity_type === 'CAMPAIGN' && args.action === 'CREATE') {
        const rn = `customers/${CID}/campaigns/901`;
        state[rn] = { resourceName: rn, name: args.name, status: args.status, budget: args.budget_resource_name };
        return { success: true, campaignResourceName: rn };
      }
      return { success: true, message: 'ok' };
    }),
    spendCeilingPolicy: () => null,
    secret: () => 'test-secret',
    now: () => NOW,
    consumedTokens: new Map(),
    ...over,
  };
  return deps;
}

const budgetUpdate = { customer_id: CID, entity_type: 'BUDGET', action: 'UPDATE', budget_resource_name: BUDGET, amount: 50 };

describe('ENG-2823 Google guarded writes', () => {
  it('preview without confirm sends nothing to Google and echoes major units as micros', async () => {
    const d = writeDeps();
    const r: any = await executeGoogleToolkitWrite('u1', budgetUpdate, 'USD', d);
    expect(r.status).toBe('PREVIEW');
    expect(r.preview_token).toMatch(/^v1\./);
    expect(r.preview).toContain('20.00 USD/day (= 20000000 micros) → 50.00 USD/day (= 50000000 micros)');
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('confirm + token applies exactly once, then read-back CONFIRMED', async () => {
    const d = writeDeps();
    const preview: any = await executeGoogleToolkitWrite('u1', budgetUpdate, 'USD', d);
    const r: any = await executeGoogleToolkitWrite('u1', { ...budgetUpdate, confirm: true, preview_token: preview.preview_token }, 'USD', d);
    expect(d.dispatch).toHaveBeenCalledTimes(1);
    expect(d.dispatch).toHaveBeenCalledWith('u1', { customer_id: CID, entity_type: 'BUDGET', action: 'UPDATE', budget_resource_name: BUDGET, amount_micros: 50_000_000 });
    expect(r).toMatchObject({ success: true, verification: 'CONFIRMED', id: BUDGET, amount_micros: 50_000_000 });

    // Replaying the same approval never applies it again (Google state moved on → mismatch).
    const replay: any = await executeGoogleToolkitWrite('u1', { ...budgetUpdate, confirm: true, preview_token: preview.preview_token }, 'USD', d);
    expect(replay.status).toBe('PREVIEW_MISMATCH');
    expect(d.dispatch).toHaveBeenCalledTimes(1);
  });

  it('a consumed token is refused even when nothing changed in Google Ads', async () => {
    const d = writeDeps({ dispatch: jest.fn().mockResolvedValue({ success: true }) }); // state unchanged after "apply"
    const p: any = await executeGoogleToolkitWrite('u1', budgetUpdate, 'USD', d);
    await executeGoogleToolkitWrite('u1', { ...budgetUpdate, confirm: true, preview_token: p.preview_token }, 'USD', d);
    await expect(executeGoogleToolkitWrite('u1', { ...budgetUpdate, confirm: true, preview_token: p.preview_token }, 'USD', d))
      .rejects.toThrow(/already used/);
    expect(d.dispatch).toHaveBeenCalledTimes(1);
  });

  it('stale confirm tokens are rejected without dispatch: expired, other args, other user, changed Google state', async () => {
    let now = NOW;
    const d = writeDeps({ now: () => now });
    const preview: any = await executeGoogleToolkitWrite('u1', budgetUpdate, 'USD', d);

    const otherArgs: any = await executeGoogleToolkitWrite('u1', { ...budgetUpdate, amount: 60, confirm: true, preview_token: preview.preview_token }, 'USD', d);
    expect(otherArgs.status).toBe('PREVIEW_MISMATCH');
    const otherUser: any = await executeGoogleToolkitWrite('u2', { ...budgetUpdate, confirm: true, preview_token: preview.preview_token }, 'USD', d);
    expect(otherUser.status).toBe('PREVIEW_MISMATCH');

    d.state[BUDGET].amountMicros = 30_000_000; // someone changed the budget in Google Ads
    const changed: any = await executeGoogleToolkitWrite('u1', { ...budgetUpdate, confirm: true, preview_token: preview.preview_token }, 'USD', d);
    expect(changed.status).toBe('PREVIEW_MISMATCH');

    const fresh: any = await executeGoogleToolkitWrite('u1', budgetUpdate, 'USD', d);
    now = NOW + 16 * 60 * 1000;
    const expired: any = await executeGoogleToolkitWrite('u1', { ...budgetUpdate, confirm: true, preview_token: fresh.preview_token }, 'USD', d);
    expect(expired.status).toBe('PREVIEW_MISMATCH');
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('spend ceiling refuses before a preview or dispatch (GOOGLE_TOOLKIT_SPEND_CEILING, micros)', async () => {
    const d = writeDeps({ spendCeilingPolicy: () => googleSpendCeilingPolicyFromEnv('{"maxDailyBudget":40000000}') });
    await expect(executeGoogleToolkitWrite('u1', budgetUpdate, 'USD', d)).rejects.toThrow(/exceeds this account's max daily budget of 40000000 \(micros\)/);
    const ratio = writeDeps({ spendCeilingPolicy: () => googleSpendCeilingPolicyFromEnv('{"maxChangeRatio":2}') });
    await expect(executeGoogleToolkitWrite('u1', budgetUpdate, 'USD', ratio)).rejects.toThrow(/2\.50x/);
    const malformed = writeDeps({ spendCeilingPolicy: () => googleSpendCeilingPolicyFromEnv('not json') });
    await expect(executeGoogleToolkitWrite('u1', budgetUpdate, 'USD', malformed)).rejects.toThrow(/could not be evaluated/);
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(ratio.dispatch).not.toHaveBeenCalled();
  });

  it('ENG-2036: shape errors are refused before readiness, credentials or any Google read', async () => {
    const d = writeDeps();
    for (const bad of [
      { ...budgetUpdate, amount: undefined, amount_micros: 50_000_000 },
      { ...budgetUpdate, amount: 50.001 },
      { ...budgetUpdate, budget_resource_name: 'customers/999/campaignBudgets/55' }, // other customer
      { ...budgetUpdate, name: 'rename too' },
      { customer_id: CID, entity_type: 'CAMPAIGN', action: 'REMOVE', campaign_resource_name: CAMPAIGN },
    ]) {
      await expect(executeGoogleToolkitWrite('u1', bad, 'USD', d)).rejects.toBeInstanceOf(MetaToolkitRefusal);
    }
    expect(d.assertReady).not.toHaveBeenCalled();
    expect(d.read).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('a user without a payment method / Google connection gets no preview', async () => {
    const d = writeDeps({ assertReady: jest.fn().mockRejectedValue(new ZomaNotReadyError('No payment method on file')) });
    await expect(executeGoogleToolkitWrite('u1', budgetUpdate, 'USD', d)).rejects.toThrow('No payment method on file');
    expect(d.read).not.toHaveBeenCalled();
  });

  it('ENG-592: Google accepted but read-back unchanged is MISMATCH, never success', async () => {
    const d = writeDeps({ dispatch: jest.fn().mockResolvedValue({ success: false, errorType: 'unsupported_field', error: 'unsupported_field: did not change' }) });
    const p: any = await executeGoogleToolkitWrite('u1', budgetUpdate, 'USD', d);
    const r: any = await executeGoogleToolkitWrite('u1', { ...budgetUpdate, confirm: true, preview_token: p.preview_token }, 'USD', d);
    expect(r).toMatchObject({ success: false, verification: 'MISMATCH' });
  });

  it('read-back that disagrees is MISMATCH; missing read-back is UNCONFIRMED', async () => {
    const d = writeDeps({ dispatch: jest.fn().mockResolvedValue({ success: true }) }); // Google "succeeds" but state unchanged
    const p: any = await executeGoogleToolkitWrite('u1', budgetUpdate, 'USD', d);
    const r: any = await executeGoogleToolkitWrite('u1', { ...budgetUpdate, confirm: true, preview_token: p.preview_token }, 'USD', d);
    expect(r).toMatchObject({ success: false, verification: 'MISMATCH' });

    const gone = writeDeps();
    const p2: any = await executeGoogleToolkitWrite('u1', budgetUpdate, 'USD', gone);
    const current = { ...gone.state[BUDGET] };
    (gone.read as jest.Mock).mockResolvedValueOnce(current).mockResolvedValueOnce(null); // preflight sees it; read-back does not
    const r2: any = await executeGoogleToolkitWrite('u1', { ...budgetUpdate, confirm: true, preview_token: p2.preview_token }, 'USD', gone);
    expect(r2).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
  });

  it('new campaigns are created PAUSED; ENABLED on create is refused; enabling is its own preview', async () => {
    const d = writeDeps();
    d.state[BUDGET].explicitlyShared = true;
    d.state[BUDGET].referenceCount = 3;
    const create = { customer_id: CID, entity_type: 'CAMPAIGN', action: 'CREATE', name: 'New', type: 'SEARCH', budget_resource_name: BUDGET, bidding_strategy: 'TARGET_SPEND' };
    await expect(executeGoogleToolkitWrite('u1', { ...create, status: 'ENABLED' }, 'USD', d)).rejects.toThrow(/always created PAUSED/);
    const p: any = await executeGoogleToolkitWrite('u1', create, 'USD', d);
    expect(p.preview).toContain('SHARED budget');
    expect(p.preview).toContain('all 3 campaign(s)');
    const r: any = await executeGoogleToolkitWrite('u1', { ...create, confirm: true, preview_token: p.preview_token }, 'USD', d);
    expect((d.dispatch as jest.Mock).mock.calls[0][1]).toMatchObject({ status: 'PAUSED' });
    expect(r).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'PAUSED', id: `customers/${CID}/campaigns/901` });

    const enable = { customer_id: CID, entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN, status: 'ENABLED' };
    const pe: any = await executeGoogleToolkitWrite('u1', enable, 'USD', d);
    expect(pe.preview).toContain('PAUSED → ENABLED');
    expect(pe.preview).toContain('can start delivery and spending');
  });

  it('refuses attaching a non-shared budget that another campaign already uses', async () => {
    const d = writeDeps(); // BUDGET referenceCount 1, not shared
    await expect(executeGoogleToolkitWrite('u1', {
      customer_id: CID, entity_type: 'CAMPAIGN', action: 'CREATE', name: 'New', type: 'SEARCH', budget_resource_name: BUDGET, bidding_strategy: 'TARGET_SPEND',
    }, 'USD', d)).rejects.toThrow(/not shared/);
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('major units follow the account currency precision', () => {
    expect(majorToMicros(50, 'USD', 'amount')).toBe(50_000_000);
    expect(majorToMicros(1500, 'JPY', 'amount')).toBe(1_500_000_000);
    expect(() => majorToMicros(10.5, 'JPY', 'amount')).toThrow(/more decimals/);
  });
});

// ── Manifest + reads ──────────────────────────────────────────────────────────

describe('ENG-2823 Google toolkit manifest and reads', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is built from the same handler objects, with client_id / override / micros inputs removed', () => {
    expect(googleAdsToolRegistry.getToolNames()).toEqual([...GOOGLE_ADS_TOOL_NAMES]);
    const manifest = getGoogleToolkitManifest();
    expect(manifest.map((d: any) => d.name)).toEqual(['call_google_ads_api', 'call_google_ads_reporting_api']);
    const api = manifest[0].inputSchema.properties;
    for (const gone of ['client_id', 'override_tracking_check', 'tracking_override_token', 'amount_micros', 'cpc_bid_micros']) expect(api[gone]).toBeUndefined();
    expect(api.amount).toBeDefined();
    expect(api.preview_token).toBeDefined();
    expect(manifest[1].inputSchema.properties.client_id).toBeUndefined();
  });

  it('refuses everything outside the curated surface', () => {
    expect(() => assertGoogleToolkitCall('call_google_ads_api', { entity_type: 'CAMPAIGN', action: 'REMOVE' })).toThrow(MetaToolkitRefusal);
    // ENG-2928 moved KEYWORD ADD into the guarded surface; campaign-level asset attach stays out.
    expect(() => assertGoogleToolkitCall('call_google_ads_api', { entity_type: 'CAMPAIGN_ASSET', action: 'ATTACH' })).toThrow(MetaToolkitRefusal);
    expect(() => assertGoogleToolkitCall('call_google_ads_api', { entity_type: 'CAMPAIGN', action: 'LIST', client_id: 'x' })).toThrow(MetaToolkitRefusal);
    expect(() => assertGoogleToolkitCall('call_google_ads_api', { entity_type: 'CAMPAIGN', action: 'UPDATE', override_tracking_check: true })).toThrow(MetaToolkitRefusal);
    expect(() => assertGoogleToolkitCall('send_email', {})).toThrow(MetaToolkitRefusal);
    expect(() => assertGoogleToolkitCall('call_google_ads_api', { entity_type: 'CAMPAIGN', action: 'LIST' })).not.toThrow();
  });

  it('reads dispatch through the shared handler (same impl Emma uses)', async () => {
    await executeGoogleToolkitRead('call_google_ads_api', { customer_id: CID, entity_type: 'BUDGET', action: 'LIST' }, { userId: 'u1' });
    expect(adsCrmApis.handleCallGoogleAdsApi).toHaveBeenCalledWith('u1', { customer_id: CID, entity_type: 'BUDGET', action: 'LIST' }, { sessionId: undefined });
    await executeGoogleToolkitRead('call_google_ads_reporting_api', { customer_id: CID, mode: 'dashboard' }, { userId: 'u1' });
    expect(adsCrmApis.handleCallGoogleAdsReportingApi).toHaveBeenCalledWith('u1', { customer_id: CID, mode: 'dashboard' }, {});
  });

  it('the default write dispatch is the Emma handler object', () => {
    expect(googleAdsToolRegistry.getTool('call_google_ads_api')).toBe(callGoogleAdsApiTool);
  });
});

// ── Gateway: flag, account lookup, metering ───────────────────────────────────

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
const gcall = (deps: MetaToolkitGatewayDeps, toolName: string, args: any) =>
  handleMetaToolkitCall({ authorization: 'Bearer aw_good', toolName, args }, deps);

describe('ENG-2823 gateway', () => {
  const prev = process.env.ZOMA_GOOGLE_ADS_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.ZOMA_GOOGLE_ADS_ENABLED;
    else process.env.ZOMA_GOOGLE_ADS_ENABLED = prev;
    jest.clearAllMocks();
  });

  it('flag off: Google tools are not part of the toolkit (Meta-only, as before)', async () => {
    delete process.env.ZOMA_GOOGLE_ADS_ENABLED;
    const deps = gatewayDeps([metaAccount(), googleAccount()], { execute: jest.fn().mockRejectedValue(new MetaToolkitRefusal('not part')) as any });
    await expect(gcall(deps, 'call_google_ads_reporting_api', { customer_id: CID, mode: 'dashboard' })).rejects.toBeInstanceOf(MetaToolkitRefusal);
    expect(adsCrmApis.handleCallGoogleAdsReportingApi).not.toHaveBeenCalled();
  });

  it('flag on: a read runs against the caller\'s own customer and is metered once with platform google_ads', async () => {
    process.env.ZOMA_GOOGLE_ADS_ENABLED = 'true';
    const deps = gatewayDeps([googleAccount()]);
    await gcall(deps, 'call_google_ads_reporting_api', { mode: 'dashboard' }); // single account: auto-selected
    expect(adsCrmApis.handleCallGoogleAdsReportingApi).toHaveBeenCalledWith('u1', { customer_id: CID, mode: 'dashboard' }, {});
    expect(deps.recordUsage).toHaveBeenCalledTimes(1);
    expect(deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'call_google_ads_reporting_api', platform: 'google_ads' }));
    expect(deps.recordWrite).not.toHaveBeenCalled();
  });

  it('flag on: a foreign customer is 403 and nothing runs or is metered', async () => {
    process.env.ZOMA_GOOGLE_ADS_ENABLED = 'true';
    const deps = gatewayDeps([googleAccount()]);
    await expect(gcall(deps, 'call_google_ads_api', { customer_id: '5555555555', entity_type: 'CAMPAIGN', action: 'LIST' }))
      .rejects.toMatchObject({ status: 403 });
    await expect(gcall(deps, 'call_google_ads_api', { customer_id: CID, entity_type: 'CAMPAIGN', action: 'REMOVE' }))
      .rejects.toBeInstanceOf(MetaToolkitRefusal);
    expect(adsCrmApis.handleCallGoogleAdsApi).not.toHaveBeenCalled();
    expect(deps.recordUsage).not.toHaveBeenCalled();
  });

  it('Meta calls are metered with platform meta', async () => {
    const deps = gatewayDeps([metaAccount()]);
    await gcall(deps, 'list_meta_ads_campaigns', {});
    expect(deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ platform: 'meta' }));
  });

  it('auth errors keep their class for the HTTP layer', async () => {
    process.env.ZOMA_GOOGLE_ADS_ENABLED = 'true';
    const deps = gatewayDeps([]);
    await expect(gcall(deps, 'call_google_ads_reporting_api', { mode: 'dashboard' })).rejects.toBeInstanceOf(MetaToolkitAuthError);
  });
});

// ── Providers + onboarding ────────────────────────────────────────────────────

describe('ENG-2823 providers and setup status', () => {
  it('one resolver, two providers: Meta messages unchanged, Google by customer_id', () => {
    expect(resolveProviderAccount(META_PROVIDER, [], undefined, NOW)).toEqual({ ok: false, kind: 'forbidden', message: 'No usable Meta ad account is connected. Connect or reconnect Meta.' });
    expect(resolveProviderAccount(GOOGLE_ADS_PROVIDER, [googleAccount(), googleAccount('222')], undefined, NOW))
      .toMatchObject({ ok: false, kind: 'ambiguous', message: 'Multiple Google Ads accounts are connected; pass customer_id.' });
    expect(resolveProviderAccount(GOOGLE_ADS_PROVIDER, [googleAccount()], '123-456-7890', NOW)).toMatchObject({ ok: true, accountId: CID });
    const expired = googleAccount(CID, { refresh_token: undefined, token_expires_at: NOW - 1 });
    expect(resolveProviderAccount(GOOGLE_ADS_PROVIDER, [expired], CID, NOW))
      .toMatchObject({ ok: false, message: 'The Google Ads connection for this account was revoked or expired. Reconnect Google Ads.' });
  });

  const onboardingDeps = (accounts: any[], googleEnabled: boolean) => ({
    getUser: jest.fn().mockResolvedValue({ userId: 'u1', email: 'a@b.co', zomaAdsExperience: 'runs_ads' }),
    listAccounts: jest.fn().mockResolvedValue(accounts),
    findLiveCustomerId: jest.fn(),
    createCustomerForUser: jest.fn(),
    resolvePaymentMethod: jest.fn().mockResolvedValue({ hasPaymentMethod: true }),
    createPaymentMethodSetupSession: jest.fn(),
    buildMetaConnectUrl: jest.fn().mockResolvedValue('https://facebook.example/connect'),
    buildGoogleAdsConnectUrl: jest.fn().mockResolvedValue('https://accounts.google.example/connect'),
    googleEnabled: () => googleEnabled,
    pagesUrl: () => 'https://api.agentweb.pro',
    now: () => NOW,
    getUsage: jest.fn(),
  }) as any;

  it('flag on: status shows each platform with a connect link for the missing one; either platform is enough', async () => {
    const metaOnly = await getZomaReadiness('u1', onboardingDeps([metaAccount()], true));
    expect(metaOnly.next_step).toBeNull();
    expect(metaOnly.google_ads).toMatchObject({ ready: false, link: 'https://accounts.google.example/connect', writes_enabled: false });

    const googleOnly = await getZomaReadiness('u1', onboardingDeps([googleAccount()], true));
    expect(googleOnly.next_step).toBeNull();
    expect(googleOnly.meta.link).toBe('https://facebook.example/connect');
    expect(googleOnly.google_ads).toMatchObject({ ready: true, writes_enabled: true, accounts: [{ customer_id: CID, currency: 'USD', login_customer_id: '999' }] });

    const neither = await getZomaReadiness('u1', onboardingDeps([], true));
    expect(neither.next_step).toContain('https://facebook.example/connect');
    expect(neither.next_step).toContain('https://accounts.google.example/connect');
  });

  it('flag off (ENG-2973): Google is explicitly unavailable, no Google link minted, no Google line rendered', async () => {
    const d = onboardingDeps([metaAccount(), googleAccount()], false);
    const r = await getZomaReadiness('u1', d);
    expect(r.google_ads).toEqual({ available: false, ready: false, accounts: [], writes_enabled: false, reason: 'google_ads_provider_disabled' });
    expect(r.next_step).toBeNull();
    expect(d.buildGoogleAdsConnectUrl).not.toHaveBeenCalled();
    expect(formatZomaStatus(r)).not.toContain('Google Ads');

    const none = onboardingDeps([], false);
    const empty = await getZomaReadiness('u1', none);
    expect(empty.google_ads.available).toBe(false);
    expect(empty.next_step).not.toContain('Google');
    expect(none.buildGoogleAdsConnectUrl).not.toHaveBeenCalled();
  });

  it('flag on (ENG-2973): google_ads carries available: true and no disabled reason', async () => {
    const r = await getZomaReadiness('u1', onboardingDeps([googleAccount()], true));
    expect(r.google_ads.available).toBe(true);
    expect(r.google_ads.reason).toBeUndefined();
    expect(formatZomaStatus(r)).toContain('Google Ads account connected');
  });

  it('write readiness is per platform', async () => {
    await expect(assertZomaWriteReady('u1', onboardingDeps([metaAccount()], true), 'google_ads')).rejects.toThrow('No usable Google Ads account is connected');
    await expect(assertZomaWriteReady('u1', onboardingDeps([googleAccount()], true), 'google_ads')).resolves.toBeUndefined();
    await expect(assertZomaWriteReady('u1', onboardingDeps([googleAccount()], true))).rejects.toThrow('No usable Meta ad account is connected');
  });
});
