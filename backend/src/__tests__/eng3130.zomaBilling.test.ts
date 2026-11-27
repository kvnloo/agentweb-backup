/**
 * ENG-3130 / ENG-3131 — Zoma $50 plan (5,000 calls included, 1¢/call after) entered through a
 * $1 7-day trial that is required only at the first write that makes ads live.
 *
 * Covers: metering counts only successful calls; overage math; the paywall gates publish
 * writes but not reads or drafts; webhook state transitions → funnel events; day-3 email
 * scheduling; everything off while ZOMA_BILLING_ENABLED is unset.
 */
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: { validateKey: jest.fn() } }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: { validateAccessToken: jest.fn() } }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), getUsersByIds: jest.fn() } }));

import type Stripe from 'stripe';
import type { DynamoAttributeMap } from '../loops/core/ports';
import { EVT_ZOMA_BILLING_FUNNEL, recordZomaBillingFunnel } from '../services/mcpUsageEventsService';
import { handleMetaToolkitCall, type MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { runZomaTool } from '../mcp/zomaOnboarding';
import {
  assertZomaPublishAllowed,
  computeZomaUsageBill,
  createZomaTrialCheckoutLink,
  getZomaBillingConfig,
  getZomaBillingUsage,
  formatZomaPlanLine,
  getZomaPlanSummary,
  planAllowsPublish,
  planStateFromSubscriptions,
  handleZomaBillingWebhookEvent,
  isBillableResult,
  isZomaPublishWrite,
  openZomaCheckout,
  reportZomaBillableCall,
  resetZomaBillingCacheForTests,
  recordZomaCheckoutCanceled,
  runZomaTrialReminders,
  zomaCheckoutCancelUrl,
  trialReminderDue,
  TRIAL_REMINDER_METADATA_KEY,
  ZomaPaywallError,
  type ZomaBillingDeps,
} from '../mcp/zomaBilling';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const ENABLED_ENV = {
  ZOMA_BILLING_ENABLED: 'true',
  ZOMA_STRIPE_PLAN_PRICE_ID: 'price_plan',
  ZOMA_STRIPE_OVERAGE_PRICE_ID: 'price_overage',
  ZOMA_STRIPE_TRIAL_FEE_PRICE_ID: 'price_fee',
} as NodeJS.ProcessEnv;

function sub(over: Partial<Stripe.Subscription> & Record<string, any> = {}): Stripe.Subscription {
  return {
    id: 'sub_1', status: 'trialing', created: sec('2026-11-10T00:00:00Z'),
    trial_start: sec('2026-11-10T00:00:00Z'), trial_end: sec('2026-11-17T00:00:00Z'),
    latest_invoice: { id: 'in_fee', status: 'paid' },
    cancel_at_period_end: false, metadata: { product: 'zoma_plan', userId: 'u1' },
    items: { data: [{ current_period_start: sec('2026-11-10T00:00:00Z'), current_period_end: sec('2026-11-17T00:00:00Z') }] },
    ...over,
  } as any;
}

function billingDeps(over: Partial<ZomaBillingDeps> = {}, env: NodeJS.ProcessEnv = ENABLED_ENV): ZomaBillingDeps {
  return {
    config: () => getZomaBillingConfig(env),
    getUser: jest.fn().mockResolvedValue({ userId: 'u1', email: 'u1@example.com' }),
    findCustomerId: jest.fn().mockResolvedValue(null),
    createCustomer: jest.fn().mockResolvedValue('cus_new'),
    listSubscriptions: jest.fn().mockResolvedValue([]),
    createCheckoutSession: jest.fn().mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }),
    retrieveCheckoutSession: jest.fn(),
    findOpenCheckoutSession: jest.fn().mockResolvedValue(null),
    sendMeterEvent: jest.fn().mockResolvedValue(undefined),
    searchTrialingSubscriptions: jest.fn().mockResolvedValue([]),
    setSubscriptionMetadata: jest.fn().mockResolvedValue(undefined),
    sendEmail: jest.fn().mockResolvedValue('sent'),
    getUsage: jest.fn().mockResolvedValue({
      start: '', end: '', toolCalls: 42, writes: { total: 3, confirmed: 3, mismatch: 0, unconfirmed: 0 }, recentWrites: [],
    }),
    getAdsSummary: jest.fn().mockResolvedValue(undefined),
    recordFunnel: jest.fn().mockResolvedValue(true),
    backendUrl: () => 'https://api.example.com',
    now: () => NOW,
    ...over,
  };
}

beforeEach(() => resetZomaBillingCacheForTests());

describe('ENG-3130 config and overage math', () => {
  it('reads prices and plan numbers from env, with the plan defaults', () => {
    const cfg = getZomaBillingConfig(ENABLED_ENV);
    expect(cfg).toMatchObject({
      enabled: true, planPriceId: 'price_plan', overagePriceId: 'price_overage', trialFeePriceId: 'price_fee',
      includedCalls: 5000, overageCentsPerCall: 1, planCents: 5000, trialFeeCents: 100, trialDays: 7, reminderDay: 3,
      meterEventName: 'zoma_tool_call',
    });
    expect(getZomaBillingConfig({ ...ENABLED_ENV, ZOMA_PLAN_INCLUDED_CALLS: '100', ZOMA_PLAN_OVERAGE_CENTS_PER_CALL: '2' }))
      .toMatchObject({ includedCalls: 100, overageCentsPerCall: 2 });
  });

  it('is off unless ZOMA_BILLING_ENABLED is exactly "true"', () => {
    expect(getZomaBillingConfig({}).enabled).toBe(false);
    expect(getZomaBillingConfig({ ZOMA_BILLING_ENABLED: '1' }).enabled).toBe(false);
  });

  it.each([
    [0, 0, 0],
    [4999, 0, 0],
    [5000, 0, 0],
    [5001, 1, 1],
    [12345, 7345, 7345],
  ])('%i calls → %i overage calls, %i cents', (used, overage, cents) => {
    expect(computeZomaUsageBill(used, { includedCalls: 5000, overageCentsPerCall: 1 })).toEqual({ included: 5000, used, overage, overageCents: cents });
  });
});

describe('ENG-3130 only successful calls are billable', () => {
  it.each([
    [{ success: true }, true],
    [{ data: [] }, true],
    [{ status: 'PREVIEW', success: false, preview_token: 'v1.x' }, true],
    [{ success: false, verification: 'UNCONFIRMED' }, true],
    [{ success: false, error: 'Meta said no' }, false],
    [{ status: 'PREVIEW_MISMATCH', success: false }, false],
  ])('%p → billable %p', (result, billable) => {
    expect(isBillableResult(result)).toBe(billable);
  });

  const metaAccount = { platform: 'meta', account_id: '111', config: { account_type: 'ad_account', ad_account_id: '111', access_token: 't' } } as any;
  const gatewayDeps = (over: Partial<MetaToolkitGatewayDeps> = {}): MetaToolkitGatewayDeps => ({
    validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1' }),
    validateOAuthToken: jest.fn(),
    listAccounts: jest.fn().mockResolvedValue([metaAccount]),
    execute: jest.fn() as any,
    recordUsage: jest.fn().mockResolvedValue(true) as any,
    now: () => NOW,
    recordWrite: jest.fn().mockResolvedValue(true) as any,
    reportBillableCall: jest.fn().mockResolvedValue(true),
    assertPublishAllowed: jest.fn().mockResolvedValue(undefined),
    ...over,
  });
  const write = (d: MetaToolkitGatewayDeps, params: Record<string, unknown>, action = 'UPDATE') => handleMetaToolkitCall({
    authorization: 'Bearer aw_k', toolName: 'call_meta_marketing_api',
    args: { entity_type: 'CAMPAIGN', action, campaign_id: '5', params },
  }, d);

  it('a successful write meters one call (usage row + Stripe meter event)', async () => {
    const d = gatewayDeps({ executeWrite: jest.fn().mockResolvedValue({ success: true, verification: 'CONFIRMED', id: '5' }) });
    await write(d, { name: 'x' });
    expect(d.recordUsage).toHaveBeenCalledTimes(1);
    expect(d.reportBillableCall).toHaveBeenCalledTimes(1);
    expect(d.reportBillableCall).toHaveBeenCalledWith('u1', expect.stringMatching(/^zoma-/));
  });

  it('a call that fails in-band is never metered', async () => {
    const d = gatewayDeps({ executeWrite: jest.fn().mockResolvedValue({ status: 'PREVIEW_MISMATCH', success: false }) });
    await write(d, { name: 'x' });
    expect(d.recordUsage).not.toHaveBeenCalled();
    expect(d.reportBillableCall).not.toHaveBeenCalled();
  });

  it('a failed write attempt still leaves an audit row, and it is never metered', async () => {
    const d = gatewayDeps({
      executeWrite: jest.fn().mockResolvedValue({ success: false, error: 'Meta said no' }),
      recordFailure: jest.fn().mockResolvedValue(true) as any,
    });
    await write(d, { name: 'x' });
    expect(d.recordFailure).toHaveBeenCalledTimes(1);
    expect(d.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', toolName: 'call_meta_marketing_api', platform: 'meta' }));
    // No arguments or error text in the audit row.
    expect(JSON.stringify((d.recordFailure as jest.Mock).mock.calls[0][0])).not.toMatch(/Meta said no|"name":"x"/);
    expect(d.recordUsage).not.toHaveBeenCalled();
    expect(d.reportBillableCall).not.toHaveBeenCalled();
  });

  it('a successful or thrown call writes no failure row', async () => {
    const ok = gatewayDeps({
      executeWrite: jest.fn().mockResolvedValue({ success: true, verification: 'CONFIRMED', id: '5' }),
      recordFailure: jest.fn().mockResolvedValue(true) as any,
    });
    await write(ok, { name: 'x' });
    expect(ok.recordFailure).not.toHaveBeenCalled();
    const thrown = gatewayDeps({
      executeWrite: jest.fn().mockRejectedValue(new MetaToolkitRefusal('nope')),
      recordFailure: jest.fn().mockResolvedValue(true) as any,
    });
    await expect(write(thrown, { name: 'x' })).rejects.toThrow('nope');
    expect(thrown.recordFailure).not.toHaveBeenCalled();
  });

  it('a failure-audit error never fails the call', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = gatewayDeps({
      executeWrite: jest.fn().mockResolvedValue({ success: false, error: 'x' }),
      recordFailure: jest.fn().mockRejectedValue(new Error('dynamo down')) as any,
    });
    const res: any = await write(d, { name: 'x' });
    expect(res.success).toBe(false);
  });

  it('a call that throws is never metered', async () => {
    const d = gatewayDeps({ executeWrite: jest.fn().mockRejectedValue(new MetaToolkitRefusal('nope')) });
    await expect(write(d, { name: 'x' })).rejects.toThrow('nope');
    expect(d.recordUsage).not.toHaveBeenCalled();
    expect(d.reportBillableCall).not.toHaveBeenCalled();
  });

  it('a Stripe meter failure never fails the call', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = gatewayDeps({
      executeWrite: jest.fn().mockResolvedValue({ success: true, verification: 'CONFIRMED', id: '5' }),
      reportBillableCall: jest.fn().mockRejectedValue(new Error('stripe down')),
    });
    const res: any = await write(d, { name: 'x' });
    expect(res.success).toBe(true);
  });

  describe('ENG-3131 paywall in the gateway', () => {
    const paywalled = () => jest.fn().mockRejectedValue(new ZomaPaywallError('Going live needs the Zoma plan → https://pay', 'https://pay'));

    it('a go-live write (status → ACTIVE) is refused with the pay link, before anything is sent', async () => {
      const d = gatewayDeps({ executeWrite: jest.fn(), assertPublishAllowed: paywalled() });
      await expect(write(d, { status: 'ACTIVE' })).rejects.toThrow(/Going live needs the Zoma plan → https:\/\/pay/);
      expect(d.executeWrite).not.toHaveBeenCalled();
      expect(d.assertPublishAllowed).toHaveBeenCalledWith('u1', { platform: 'meta', toolName: 'call_meta_marketing_api' });
      expect(d.recordUsage).not.toHaveBeenCalled();
    });

    it.each([
      ['a draft CREATE', { name: 'x' }, 'CREATE'],
      ['a pause', { status: 'PAUSED' }, 'UPDATE'],
      ['an edit', { name: 'renamed' }, 'UPDATE'],
    ])('%s is not gated', async (_label, params, action) => {
      const d = gatewayDeps({ executeWrite: jest.fn().mockResolvedValue({ success: true, verification: 'CONFIRMED', id: '5' }), assertPublishAllowed: paywalled() });
      await write(d, params, action);
      expect(d.assertPublishAllowed).not.toHaveBeenCalled();
      expect(d.executeWrite).toHaveBeenCalled();
    });

    const googleWrite = (d: MetaToolkitGatewayDeps, status: string) => handleMetaToolkitCall({
      authorization: 'Bearer aw_k', toolName: 'call_google_ads_api',
      args: { entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: 'customers/1/campaigns/2', status },
    }, d);

    describe('Google Ads (dark behind ZOMA_GOOGLE_ENABLED)', () => {
      beforeAll(() => { process.env.ZOMA_GOOGLE_ENABLED = 'true'; });
      afterAll(() => { delete process.env.ZOMA_GOOGLE_ENABLED; });
    it('a Google Ads go-live (status ENABLED) is refused with the pay link before anything is sent', async () => {
      const d = gatewayDeps({ assertPublishAllowed: paywalled() });
      await expect(googleWrite(d, 'ENABLED')).rejects.toThrow(/Going live needs the Zoma plan → https:\/\/pay/);
      expect(d.assertPublishAllowed).toHaveBeenCalledWith('u1', { platform: 'google_ads', toolName: 'call_google_ads_api' });
      expect(d.recordUsage).not.toHaveBeenCalled();
    });

    it('a Google Ads pause (status PAUSED) is not gated', async () => {
      const d = gatewayDeps({ assertPublishAllowed: paywalled() });
      await googleWrite(d, 'PAUSED').catch(() => undefined);
      expect(d.assertPublishAllowed).not.toHaveBeenCalled();
    });
    });

    it('a read is not gated', async () => {
      const d = gatewayDeps({ execute: jest.fn().mockResolvedValue({ data: [] }) as any, assertPublishAllowed: paywalled() });
      await handleMetaToolkitCall({ authorization: 'Bearer aw_k', toolName: 'get_campaigns', args: {} }, d);
      expect(d.assertPublishAllowed).not.toHaveBeenCalled();
      expect(d.recordUsage).toHaveBeenCalledTimes(1);
    });
  });
});

describe('ENG-3131 publish classification', () => {
  it.each([
    ['meta', { action: 'UPDATE', params: { status: 'ACTIVE' } }, true],
    ['meta', { action: 'UPDATE', params: { status: 'PAUSED' } }, false],
    ['meta', { action: 'CREATE', params: { status: 'ACTIVE' } }, false], // creates are always forced PAUSED
    ['meta', { action: 'UPDATE', params: { daily_budget: 100 } }, false],
    ['google_ads', { action: 'UPDATE', status: 'ENABLED' }, true],
    ['google_ads', { action: 'CREATE', status: 'ENABLED' }, true],
    ['google_ads', { action: 'CREATE', status: 'PAUSED' }, false],
    ['x_ads', { action: 'ACTIVATE' }, true],
    ['x_ads', { action: 'PAUSE' }, false],
    ['x_ads', { action: 'CREATE' }, false], // creates are always PAUSED
    // The X write validator coerces `action` with String(); a non-string action must not skip the paywall.
    ['x_ads', { action: ['ACTIVATE'] }, true],
  ] as const)('%s %p → publish %p', (platform, args, expected) => {
    expect(isZomaPublishWrite(platform, args)).toBe(expected);
  });
});

describe('ENG-3131 assertZomaPublishAllowed', () => {
  it('is a no-op while billing is off (no Stripe call)', async () => {
    const d = billingDeps({}, {});
    await expect(assertZomaPublishAllowed('u1', { platform: 'meta' }, d)).resolves.toBeUndefined();
    expect(d.findCustomerId).not.toHaveBeenCalled();
  });

  it('no plan → refuses with a $1 trial pay link and records paywall_shown', async () => {
    const d = billingDeps();
    const err: any = await assertZomaPublishAllowed('u1', { platform: 'meta', toolName: 't' }, d).catch((e) => e);
    expect(err).toBeInstanceOf(ZomaPaywallError);
    expect(err.link).toBe('https://api.example.com/api/zoma/billing/checkout/cs_test_1');
    expect(err.message).toContain('$1 7-day trial → https://api.example.com/api/zoma/billing/checkout/cs_test_1');
    expect(err.message).toContain('charged $50/month automatically (cancel before day 7 to avoid it), with 5,000 calls included, then 1¢ per call');
    expect(err.message).not.toMatch(/emma|app\.agentweb/i);
    expect(d.recordFunnel).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', step: 'paywall_shown', dimensions: expect.objectContaining({ surface: 'write_guard', planStatus: 'none' }) }));
  });

  it.each(['trialing', 'active'])('a %s plan may publish', async (status) => {
    const d = billingDeps({ findCustomerId: jest.fn().mockResolvedValue('cus_1'), listSubscriptions: jest.fn().mockResolvedValue([sub({ status: status as any })]) });
    await expect(assertZomaPublishAllowed('u1', { platform: 'meta' }, d)).resolves.toBeUndefined();
    expect(d.createCheckoutSession).not.toHaveBeenCalled();
  });

  it.each(['past_due', 'unpaid'])('a %s plan is told to fix the card on it, with no second Checkout', async (status) => {
    const d = billingDeps({ findCustomerId: jest.fn().mockResolvedValue('cus_1'), listSubscriptions: jest.fn().mockResolvedValue([sub({ status: status as any })]) });
    await expect(assertZomaPublishAllowed('u1', { platform: 'meta' }, d)).rejects.toThrow(/did not go through.*Do not start a second plan/);
    const summary = await getZomaPlanSummary('u1', d);
    expect(summary?.link).toBeUndefined();
    expect(summary?.error).toMatch(/did not go through/);
    expect(d.createCheckoutSession).not.toHaveBeenCalled();
  });

  it.each(['canceled', 'incomplete_expired'])('a %s plan is paywalled', async (status) => {
    const d = billingDeps({ findCustomerId: jest.fn().mockResolvedValue('cus_1'), listSubscriptions: jest.fn().mockResolvedValue([sub({ status: status as any })]) });
    await expect(assertZomaPublishAllowed('u1', { platform: 'meta' }, d)).rejects.toBeInstanceOf(ZomaPaywallError);
  });

  it('ignores subscriptions that are not the Zoma plan (e.g. the Emma plan)', async () => {
    const d = billingDeps({ findCustomerId: jest.fn().mockResolvedValue('cus_1'), listSubscriptions: jest.fn().mockResolvedValue([sub({ status: 'active', metadata: {} })]) });
    await expect(assertZomaPublishAllowed('u1', { platform: 'meta' }, d)).rejects.toBeInstanceOf(ZomaPaywallError);
  });

  it('a trialing plan whose $1 invoice has not settled cannot publish and is not offered a second checkout', async () => {
    const d = billingDeps({
      findCustomerId: jest.fn().mockResolvedValue('cus_1'),
      listSubscriptions: jest.fn().mockResolvedValue([sub({ latest_invoice: { id: 'in_fee', status: 'open' } as any })]),
    });
    await expect(assertZomaPublishAllowed('u1', { platform: 'meta' }, d)).rejects.toThrow(/payment is still being confirmed/i);
    const summary = await getZomaPlanSummary('u1', d);
    expect(summary).toMatchObject({ status: 'trialing', publish_enabled: false });
    expect(summary?.link).toBeUndefined();
    expect(d.createCheckoutSession).not.toHaveBeenCalled();
  });

  it.each([null, 'in_unexpanded', { id: 'in_fee', status: 'draft' }, { id: 'in_fee', status: 'void' }])('a trial without a paid invoice fails closed: %p', (invoice) => {
    expect(planAllowsPublish(planStateFromSubscriptions('cus_1', [sub({ latest_invoice: invoice as any })]))).toBe(false);
  });

  it.each(['draft', 'open', 'paid'])('an active plan publishes whatever its renewal invoice is (%s)', (status) => {
    expect(planAllowsPublish(planStateFromSubscriptions('cus_1', [sub({ status: 'active', latest_invoice: { id: 'in_renewal', status } as any })]))).toBe(true);
  });

  it('zoma_status says a cancelled paying plan ends and will not renew', async () => {
    const d = billingDeps({ findCustomerId: jest.fn().mockResolvedValue('cus_1'), listSubscriptions: jest.fn().mockResolvedValue([sub({ status: 'active', cancel_at_period_end: true })]) });
    const line = formatZomaPlanLine((await getZomaPlanSummary('u1', d))!, d.config());
    expect(line).toMatch(/active until 2026-11-17, cancelled, it will not renew/);
  });

  it('zoma_status says a cancelled trial will not renew', async () => {
    const d = billingDeps({ findCustomerId: jest.fn().mockResolvedValue('cus_1'), listSubscriptions: jest.fn().mockResolvedValue([sub({ cancel_at_period_end: true })]) });
    const line = formatZomaPlanLine((await getZomaPlanSummary('u1', d))!, d.config());
    expect(line).toContain('cancelled, it will not renew');
    expect(line).not.toContain('then $50/month');
  });

  it('paywall_shown is recorded at most once an hour per surface', async () => {
    const d = billingDeps();
    await assertZomaPublishAllowed('u1', { platform: 'meta' }, d).catch(() => undefined);
    expect(d.recordFunnel).toHaveBeenCalledWith(expect.objectContaining({ step: 'paywall_shown', dedupeKey: 'write_guard#2026-11-16T12' }));
  });

  it('fails closed when Stripe cannot be read', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = billingDeps({ findCustomerId: jest.fn().mockRejectedValue(new Error('stripe down')) });
    await expect(assertZomaPublishAllowed('u1', { platform: 'meta' }, d)).rejects.toThrow(/nothing went live/);
  });
});

describe('ENG-3131 trial checkout', () => {
  it('creates a subscription-mode Checkout: $1 fee now, 7-day trial, then plan + metered overage, on a Zoma-only customer', async () => {
    const d = billingDeps();
    const link = await createZomaTrialCheckoutLink('u1', d);
    expect(link).toBe('https://api.example.com/api/zoma/billing/checkout/cs_test_1');
    expect(d.createCustomer).toHaveBeenCalledWith('u1');
    const params = (d.createCheckoutSession as jest.Mock).mock.calls[0][0];
    expect(params).toMatchObject({
      mode: 'subscription',
      customer: 'cus_new',
      line_items: [{ price: 'price_plan', quantity: 1 }, { price: 'price_overage' }, { price: 'price_fee', quantity: 1 }],
      subscription_data: { trial_period_days: 7, metadata: { product: 'zoma_plan', userId: 'u1' } },
      metadata: { product: 'zoma_plan', userId: 'u1' },
      success_url: 'https://api.example.com/api/zoma/billing/done?result=paid',
      cancel_url: expect.stringMatching(/^https:\/\/api\.example\.com\/api\/zoma\/billing\/done\?result=canceled&u=u1&s=[0-9a-f]{32}$/),
    });
  });

  it('an old pay link no longer opens once the user has a live plan (no second subscription)', async () => {
    const d = billingDeps({
      retrieveCheckoutSession: jest.fn().mockResolvedValue({ id: 'cs_old', status: 'open', url: 'https://checkout.stripe.com/x', created: sec('2026-11-16T11:00:00Z'), metadata: { product: 'zoma_plan', userId: 'u1' } }),
      findCustomerId: jest.fn().mockResolvedValue('cus_1'),
      listSubscriptions: jest.fn().mockResolvedValue([sub()]),
    });
    await expect(openZomaCheckout('cs_old', d)).resolves.toEqual({ kind: 'gone' });
    expect(d.recordFunnel).not.toHaveBeenCalled();
  });

  it('an entitled subscription wins over a newer trial whose $1 has not settled', () => {
    const entitled = sub({ id: 'sub_old', status: 'active', created: sec('2026-10-01T00:00:00Z') });
    const unpaidTrial = sub({ id: 'sub_new', created: sec('2026-11-10T00:00:00Z'), latest_invoice: { id: 'in', status: 'open' } as any });
    const state = planStateFromSubscriptions('cus_1', [unpaidTrial, entitled]);
    expect(state).toMatchObject({ subscriptionId: 'sub_old', status: 'active' });
    expect(planAllowsPublish(state)).toBe(true);
  });

  it('a first-time buyer gets the $1 trial; Checkout is USD-only', async () => {
    const d = billingDeps();
    await createZomaTrialCheckoutLink('u1', d);
    const params = (d.createCheckoutSession as jest.Mock).mock.calls[0][0];
    expect(params.adaptive_pricing).toEqual({ enabled: false });
    expect(params.line_items.map((l: any) => l.price)).toEqual(['price_plan', 'price_overage', 'price_fee']);
    expect(params.subscription_data.trial_period_days).toBe(7);
  });

  it.each([
    ['cancelled', 'canceled'],
    ['paused', 'paused'],
  ])('a user with a %s earlier plan gets the plan itself: no trial, no $1 line', async (_label, status) => {
    const d = billingDeps({ findCustomerId: jest.fn().mockResolvedValue('cus_1'), listSubscriptions: jest.fn().mockResolvedValue([sub({ status: status as any })]) });
    await createZomaTrialCheckoutLink('u1', d);
    const params = (d.createCheckoutSession as jest.Mock).mock.calls[0][0];
    expect(params.line_items.map((l: any) => l.price)).toEqual(['price_plan', 'price_overage']);
    expect(params.subscription_data.trial_period_days).toBeUndefined();
    expect(params.subscription_data.trial_settings).toBeUndefined();
    expect(params.custom_text.submit.message).not.toMatch(/trial/i);
    expect(params.adaptive_pricing).toEqual({ enabled: false });
  });

  it('a subscription that never started does not use up the trial', async () => {
    const d = billingDeps({ findCustomerId: jest.fn().mockResolvedValue('cus_1'), listSubscriptions: jest.fn().mockResolvedValue([sub({ status: 'incomplete_expired' })]) });
    await createZomaTrialCheckoutLink('u1', d);
    expect((d.createCheckoutSession as jest.Mock).mock.calls[0][0].subscription_data.trial_period_days).toBe(7);
  });

  it('the refusal and zoma_status say a returning user is buying the plan, not a trial', async () => {
    const d = billingDeps({ findCustomerId: jest.fn().mockResolvedValue('cus_1'), listSubscriptions: jest.fn().mockResolvedValue([sub({ status: 'canceled' })]) });
    const err: any = await assertZomaPublishAllowed('u1', { platform: 'meta' }, d).catch((e) => e);
    expect(err.message).toMatch(/\$50\/month, charged today/);
    expect(err.message).not.toMatch(/trial/i);
    const line = formatZomaPlanLine((await getZomaPlanSummary('u1', d))!, d.config());
    expect(line).toMatch(/\$50\/month → https:/);
    expect(line).not.toMatch(/trial/i);
  });

  it('the first-time paywall says reads are free only until the plan starts, then count', async () => {
    const err: any = await assertZomaPublishAllowed('u1', { platform: 'meta' }, billingDeps()).catch((e) => e);
    expect(err.message).toContain('Reads and drafts are free until you start the plan, after which every successful call, reads included, counts toward the included calls.');
  });

  it('reuses a still-open Checkout instead of minting a second one', async () => {
    const d = billingDeps({
      findCustomerId: jest.fn().mockResolvedValue('cus_1'),
      findOpenCheckoutSession: jest.fn().mockResolvedValue({ id: 'cs_open' }),
    });
    await expect(createZomaTrialCheckoutLink('u1', d)).resolves.toBe('https://api.example.com/api/zoma/billing/checkout/cs_open');
    expect(d.findOpenCheckoutSession).toHaveBeenCalledWith('cus_1', 60 * 60 * 1000);
    expect(d.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('refuses to mint a link when a price id is missing', async () => {
    const d = billingDeps({}, { ZOMA_BILLING_ENABLED: 'true', ZOMA_STRIPE_PLAN_PRICE_ID: 'price_plan' });
    await expect(createZomaTrialCheckoutLink('u1', d)).rejects.toThrow(/ZOMA_STRIPE_OVERAGE_PRICE_ID, ZOMA_STRIPE_TRIAL_FEE_PRICE_ID/);
  });

  it('opening the pay link records checkout_started once per session and redirects to Stripe', async () => {
    const d = billingDeps({
      retrieveCheckoutSession: jest.fn().mockResolvedValue({ id: 'cs_test_1', status: 'open', url: 'https://checkout.stripe.com/x', created: sec('2026-11-16T11:00:00Z'), metadata: { product: 'zoma_plan', userId: 'u1' } }),
    });
    await expect(openZomaCheckout('cs_test_1', d)).resolves.toEqual({ kind: 'redirect', url: 'https://checkout.stripe.com/x' });
    expect(d.recordFunnel).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', step: 'checkout_started', dedupeKey: 'cs_test_1' }));
  });

  it('a session that is not a Zoma plan, or is no longer open, does not redirect', async () => {
    const other = billingDeps({ retrieveCheckoutSession: jest.fn().mockResolvedValue({ id: 'cs_x', status: 'open', url: 'u', metadata: {} }) });
    await expect(openZomaCheckout('cs_x', other)).resolves.toEqual({ kind: 'not_found' });
    const done = billingDeps({ retrieveCheckoutSession: jest.fn().mockResolvedValue({ id: 'cs_x', status: 'complete', url: null, metadata: { product: 'zoma_plan' } }) });
    await expect(openZomaCheckout('cs_x', done)).resolves.toEqual({ kind: 'gone' });
    await expect(openZomaCheckout('../etc', other)).resolves.toEqual({ kind: 'not_found' });
  });
});

describe('ENG-3130 Stripe meter reporting', () => {
  it('sends one meter event (value 1) for a user with a Zoma billing customer', async () => {
    const d = billingDeps({ findCustomerId: jest.fn().mockResolvedValue('cus_1') });
    await expect(reportZomaBillableCall('u1', 'zoma-abc', d)).resolves.toBe(true);
    expect(d.sendMeterEvent).toHaveBeenCalledWith({ eventName: 'zoma_tool_call', customerId: 'cus_1', value: 1, identifier: 'zoma-abc', timestamp: Math.floor(NOW / 1000) });
  });

  it('skips users who never opened checkout, and caches the miss', async () => {
    const d = billingDeps();
    await reportZomaBillableCall('u1', 'a', d);
    await reportZomaBillableCall('u1', 'b', d);
    expect(d.sendMeterEvent).not.toHaveBeenCalled();
    expect(d.findCustomerId).toHaveBeenCalledTimes(1);
  });

  it('does nothing while billing is off', async () => {
    const d = billingDeps({ findCustomerId: jest.fn().mockResolvedValue('cus_1') }, {});
    await expect(reportZomaBillableCall('u1', 'a', d)).resolves.toBe(false);
    expect(d.findCustomerId).not.toHaveBeenCalled();
  });
});

describe('ENG-3130 zoma_usage', () => {
  it('shows included / used / overage for the plan period', async () => {
    const d = billingDeps({
      findCustomerId: jest.fn().mockResolvedValue('cus_1'),
      listSubscriptions: jest.fn().mockResolvedValue([sub({ status: 'active' })]),
      getUsage: jest.fn().mockResolvedValue({ start: '', end: '', toolCalls: 5250, writes: { total: 0, confirmed: 0, mismatch: 0, unconfirmed: 0 }, recentWrites: [] }),
    });
    const billing = await getZomaBillingUsage('u1', d);
    expect(d.getUsage).toHaveBeenCalledWith('u1', { start: '2026-11-10T00:00:00.000Z', end: '2026-11-17T00:00:00.000Z' });
    expect(billing).toMatchObject({ plan: 'active', included: 5000, used: 5250, overage: 250, overage_cents: 250 });

    const res: any = await runZomaTool('zoma_usage', {}, { userId: 'u1' }, {
      getUsage: jest.fn().mockResolvedValue({ start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z', toolCalls: 5250, writes: { total: 0, confirmed: 0, mismatch: 0, unconfirmed: 0 }, recentWrites: [] }),
      getBillingUsage: async () => billing,
      now: () => NOW,
    } as any);
    expect(res.billing).toEqual(billing);
    expect(res.summary).toContain('Successful calls: 5,250 of 5,000 included');
    expect(res.summary).toContain('Overage: 250 calls × 1¢ = $2.50');
    expect(res.summary).toContain('Billing period: 2026-11-10 → 2026-11-17');
    expect(res.summary).not.toContain('Billing is not enabled yet');
  });

  it('is absent while billing is off', async () => {
    await expect(getZomaBillingUsage('u1', billingDeps({}, {}))).resolves.toBeUndefined();
  });
});

describe('ENG-3131 webhook transitions', () => {
  const evt = (type: string, object: any, previous_attributes?: any) => ({ id: `evt_${type}`, type, created: sec('2026-11-16T10:00:00Z'), data: { object, previous_attributes } }) as any;
  const zomaMeta = { product: 'zoma_plan', userId: 'u1' };

  it.each([
    ['checkout.session.completed', { id: 'cs_1', customer: 'cus_1', metadata: zomaMeta }, undefined, 'paid'],
    ['checkout.session.expired', { id: 'cs_1', metadata: zomaMeta }, undefined, 'checkout_expired'],
    ['customer.subscription.updated', { id: 'sub_1', status: 'active', metadata: zomaMeta }, { status: 'trialing' }, 'trial_converted'],
    ['customer.subscription.deleted', { id: 'sub_1', status: 'canceled', trial_end: 200, ended_at: 200, metadata: zomaMeta }, undefined, 'trial_canceled'],
    ['customer.subscription.deleted', { id: 'sub_1', status: 'canceled', trial_end: 200, ended_at: 200 + 1800, metadata: zomaMeta }, undefined, 'trial_canceled'],
    ['customer.subscription.deleted', { id: 'sub_1', status: 'canceled', trial_end: 200, ended_at: 200 + 3601, metadata: zomaMeta }, undefined, 'subscription_canceled'],
    ['customer.subscription.deleted', { id: 'sub_1', status: 'canceled', trial_end: 200, ended_at: 200 + 2 * 3600, metadata: zomaMeta }, undefined, 'subscription_canceled'],
  ])('%s → %s funnel step (deduped on the Stripe event id)', async (type, object, prev, step) => {
    const recordFunnel = jest.fn().mockResolvedValue(true);
    await expect(handleZomaBillingWebhookEvent(evt(type, object, prev), { recordFunnel })).resolves.toBe(true);
    expect(recordFunnel).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', step, dedupeKey: `evt_${type}` }));
  });

  it('a renewal update (active → active) records nothing but is still claimed', async () => {
    const recordFunnel = jest.fn();
    await expect(handleZomaBillingWebhookEvent(evt('customer.subscription.updated', { id: 'sub_1', status: 'active', metadata: zomaMeta }, { cancel_at_period_end: true }), { recordFunnel })).resolves.toBe(true);
    expect(recordFunnel).not.toHaveBeenCalled();
  });

  it('claims Zoma plan invoices so the Emma subscription handlers never see them', async () => {
    const recordFunnel = jest.fn();
    await expect(handleZomaBillingWebhookEvent(evt('invoice.paid', { id: 'in_1', parent: { subscription_details: { metadata: zomaMeta } } }), { recordFunnel })).resolves.toBe(true);
  });

  it('leaves every non-Zoma event to the existing handlers', async () => {
    const recordFunnel = jest.fn();
    await expect(handleZomaBillingWebhookEvent(evt('customer.subscription.updated', { id: 'sub_e', status: 'active', metadata: {} }, { status: 'trialing' }), { recordFunnel })).resolves.toBe(false);
    await expect(handleZomaBillingWebhookEvent(evt('checkout.session.completed', { id: 'cs_e', mode: 'setup', metadata: { purchaseType: 'zoma_payment_method', userId: 'u1' } }), { recordFunnel })).resolves.toBe(false);
    expect(recordFunnel).not.toHaveBeenCalled();
  });

  it('funnel rows with a dedupe key are written once (webhook retries never double count)', async () => {
    const items: DynamoAttributeMap[] = [];
    const store = {
      put: jest.fn(async (item: DynamoAttributeMap, opts?: { condition?: string }) => {
        if (opts?.condition && items.some((i) => i.tsSession === item.tsSession)) throw Object.assign(new Error('dup'), { code: 'ConditionalCheckFailedException' });
        items.push(item);
      }),
      queryByLoopId: jest.fn(),
    };
    const input = { userId: 'u1', step: 'paid' as const, dedupeKey: 'evt_1', now: new Date('2026-11-16T10:00:00Z') };
    await expect(recordZomaBillingFunnel(input, store)).resolves.toBe(true);
    await expect(recordZomaBillingFunnel(input, store)).resolves.toBe(false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ eventType: EVT_ZOMA_BILLING_FUNNEL, subjectId: 'u1', dimensions: expect.objectContaining({ step: 'paid', product: 'zoma' }) });
  });
});

describe('ENG-3131 day-3 trial reminder', () => {
  const start = '2026-11-10T00:00:00Z';
  const at = (iso: string) => Date.parse(iso);

  it('is due from day 3 of the trial until it ends, and only once', () => {
    expect(trialReminderDue(sub(), at('2026-11-12T23:59:59Z'), 3)).toBe(false);
    expect(trialReminderDue(sub(), at('2026-11-13T00:00:00Z'), 3)).toBe(true);
    expect(trialReminderDue(sub(), at('2026-11-17T00:00:00Z'), 3)).toBe(false);
    expect(trialReminderDue(sub({ metadata: { product: 'zoma_plan', [TRIAL_REMINDER_METADATA_KEY]: 'x' } }), at('2026-11-14T00:00:00Z'), 3)).toBe(false);
    expect(trialReminderDue(sub({ status: 'active' }), at('2026-11-14T00:00:00Z'), 3)).toBe(false);
  });

  it('does not remind a user who already cancelled the trial', () => {
    expect(trialReminderDue(sub({ cancel_at_period_end: true }), at('2026-11-14T00:00:00Z'), 3)).toBe(false);
  });

  it('claims the hour, sends, then marks the subscription and records the funnel step', async () => {
    const order: string[] = [];
    const d = billingDeps({
      now: () => at('2026-11-13T05:00:00Z'),
      searchTrialingSubscriptions: jest.fn().mockResolvedValue([sub(), sub({ id: 'sub_early', trial_start: sec('2026-11-12T00:00:00Z'), trial_end: sec('2026-11-19T00:00:00Z') })]),
      setSubscriptionMetadata: jest.fn(async () => { order.push('mark'); }),
      sendEmail: jest.fn(async () => { order.push('send'); return 'sent' as const; }),
    });
    await expect(runZomaTrialReminders(d)).resolves.toEqual({ checked: 2, sent: 1 });
    expect(order).toEqual(['mark', 'send']);
    expect(d.recordFunnel).toHaveBeenCalledWith(expect.objectContaining({ step: 'trial_reminder_claimed', dedupeKey: 'sub_1#2026-11-13T05' }));
    expect(d.setSubscriptionMetadata).toHaveBeenCalledWith('sub_1', { [TRIAL_REMINDER_METADATA_KEY]: '2026-11-13T05:00:00.000Z' });
    expect(d.getUsage).toHaveBeenCalledWith('u1', { start: new Date(start).toISOString(), end: '2026-11-13T05:00:00.000Z' });
    const [to, subject, text] = (d.sendEmail as jest.Mock).mock.calls[0];
    expect(to).toBe('u1@example.com');
    expect(subject).toBe('Your Zoma trial ends on 2026-11-17');
    expect(text).toContain('42 successful calls');
    expect(text).toContain('sent 3 change(s) to your ad accounts (3 confirmed by read-back)');
    expect(text).toContain('$50/month with 5,000 calls included and 1¢ per call');
    expect(d.recordFunnel).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', step: 'trial_reminder_sent', dedupeKey: 'sub_1' }));
  });

  const dueDeps = (over: Partial<ZomaBillingDeps> = {}) => billingDeps({ now: () => at('2026-11-13T05:00:00Z'), searchTrialingSubscriptions: jest.fn().mockResolvedValue([sub()]), ...over });

  it('a failed send clears the marker again so the next pass retries it', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = dueDeps({ sendEmail: jest.fn().mockResolvedValue('failed') });
    await expect(runZomaTrialReminders(d)).resolves.toEqual({ checked: 1, sent: 0 });
    expect((d.setSubscriptionMetadata as jest.Mock).mock.calls).toEqual([
      ['sub_1', { [TRIAL_REMINDER_METADATA_KEY]: expect.any(String) }],
      ['sub_1', { [TRIAL_REMINDER_METADATA_KEY]: '' }],
    ]);
    expect(d.recordFunnel).not.toHaveBeenCalledWith(expect.objectContaining({ step: 'trial_reminder_sent' }));
  });

  it('when the marker cannot be written nothing is sent, so it can never repeat every hour', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = dueDeps({ setSubscriptionMetadata: jest.fn().mockRejectedValue(new Error('stripe 429')) });
    await expect(runZomaTrialReminders(d)).resolves.toEqual({ checked: 1, sent: 0 });
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it('a mail the non-prod guard suppressed is marked done but not counted as sent', async () => {
    const d = dueDeps({ sendEmail: jest.fn().mockResolvedValue('suppressed') });
    await expect(runZomaTrialReminders(d)).resolves.toEqual({ checked: 1, sent: 0 });
    expect(d.setSubscriptionMetadata).toHaveBeenCalledTimes(1);
    expect(d.recordFunnel).not.toHaveBeenCalledWith(expect.objectContaining({ step: 'trial_reminder_sent' }));
  });

  it('another instance that already claimed this hour sends nothing', async () => {
    const d = dueDeps({ recordFunnel: jest.fn().mockResolvedValue(false) });
    await expect(runZomaTrialReminders(d)).resolves.toEqual({ checked: 1, sent: 0 });
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it('puts the ad performance in the email, and still sends without it', async () => {
    const withAds = dueDeps({ getAdsSummary: jest.fn().mockResolvedValue('$120.00 spent, 3,400 impressions, 85 clicks') });
    await runZomaTrialReminders(withAds);
    expect((withAds.sendEmail as jest.Mock).mock.calls[0][2]).toContain('How your ads are doing: $120.00 spent, 3,400 impressions, 85 clicks');
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = dueDeps({ getAdsSummary: jest.fn().mockRejectedValue(new Error('meta down')) });
    await expect(runZomaTrialReminders(broken)).resolves.toEqual({ checked: 1, sent: 1 });
    expect((broken.sendEmail as jest.Mock).mock.calls[0][2]).not.toContain('How your ads are doing');
  });

  it('does nothing while billing is off', async () => {
    const d = billingDeps({}, {});
    await expect(runZomaTrialReminders(d)).resolves.toEqual({ checked: 0, sent: 0 });
    expect(d.searchTrialingSubscriptions).not.toHaveBeenCalled();
  });
});

describe('ENG-3131 cancel at card entry', () => {
  const secret = 'test-secret';
  const query = (url: string) => Object.fromEntries(new URL(url).searchParams);

  it('records checkout_canceled once an hour for a validly signed cancel redirect', async () => {
    const q = query(zomaCheckoutCancelUrl('https://api.example.com/api/zoma/billing/done', 'u1', secret));
    expect(q.result).toBe('canceled');
    const d = billingDeps();
    await expect(recordZomaCheckoutCanceled(q, d, NOW, secret)).resolves.toBe(true);
    expect(d.recordFunnel).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', step: 'checkout_canceled', dedupeKey: 'u1#2026-11-16T12' }));
  });

  it.each([
    ['a forged signature', { u: 'u1', s: 'x'.repeat(32) }],
    ['another user with the first user\'s signature', { u: 'u2' }],
    ['no user', { u: undefined }],
  ])('ignores %s', async (_name, override) => {
    const q = { ...query(zomaCheckoutCancelUrl('https://api.example.com/api/zoma/billing/done', 'u1', secret)), ...override };
    const d = billingDeps();
    await expect(recordZomaCheckoutCanceled(q, d, NOW, secret)).resolves.toBe(false);
    expect(d.recordFunnel).not.toHaveBeenCalled();
  });

  it('the Checkout session is minted with the signed cancel url', async () => {
    const d = billingDeps();
    await createZomaTrialCheckoutLink('u1', d);
    const params = (d.createCheckoutSession as jest.Mock).mock.calls[0][0];
    expect(params.cancel_url).toMatch(/\/api\/zoma\/billing\/done\?result=canceled&u=u1&s=[0-9a-f]{32}$/);
  });
});

describe('ENG-3131 funnel dedupe key', () => {
  it('a repeat with the same dedupeKey is refused even when the clock has moved', async () => {
    const seen = new Set<string>();
    const store = {
      put: async (item: any) => {
        if (seen.has(item.tsSession)) throw Object.assign(new Error('exists'), { code: 'ConditionalCheckFailedException' });
        seen.add(item.tsSession);
      },
      queryByLoopId: async () => [],
    } as any;
    const input = { userId: 'u1', step: 'trial_reminder_claimed' as const, dedupeKey: 'sub_1#2026-11-13T05' };
    await expect(recordZomaBillingFunnel({ ...input, now: new Date('2026-11-13T05:00:01Z') }, store)).resolves.toBe(true);
    await expect(recordZomaBillingFunnel({ ...input, now: new Date('2026-11-13T05:40:00Z') }, store)).resolves.toBe(false);
    await expect(recordZomaBillingFunnel({ ...input, dedupeKey: 'sub_1#2026-11-13T06' }, store)).resolves.toBe(true);
  });
});
