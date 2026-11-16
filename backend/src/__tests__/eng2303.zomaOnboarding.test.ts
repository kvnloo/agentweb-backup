process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
/**
 * ENG-2303 P2 acceptance (spec: /home/harsha/zoma-build/SPEC.md):
 *  - zoma_status returns the next step with a direct link: no payment method -> Stripe
 *    setup-mode Checkout link; no usable Meta connection -> the Meta OAuth connect URL.
 *  - State is derived (user row, connected accounts, Stripe); nothing is stored.
 *  - Writes are gated on payment method + Meta; an unreadable payment state fails closed.
 */
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../services/stripeService', () => ({ stripeService: {} }));
jest.mock('../services/metaConnectUrl', () => ({ buildMetaConnectUrl: jest.fn() }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));

import {
  assertZomaWriteReady,
  getZomaReadiness,
  runZomaTool,
  ZomaNotReadyError,
  type ZomaOnboardingDeps,
} from '../mcp/zomaOnboarding';

const NOW = 1_800_000_000_000;
const NO_CARD = { hasPaymentMethod: false, customerId: null, card: null, isZoma: false };
const CARD = { hasPaymentMethod: true, customerId: 'cus_zoma', card: { brand: 'visa', last4: '0159' }, isZoma: true };
const paid = () => jest.fn().mockResolvedValue(CARD);
const metaAccount = (over: any = {}) => ({
  platform: 'meta',
  account_id: 'act_111',
  account_name: 'Phoenix',
  config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: '111', currency: 'TWD', granted_scopes: ['ads_management'], ...over },
});

function deps(over: Partial<ZomaOnboardingDeps> = {}): ZomaOnboardingDeps & Record<string, jest.Mock> {
  return {
    getUser: jest.fn().mockResolvedValue({ userId: 'u1', zomaAdsExperience: 'runs_ads', email: 'a@b.co' }),
    listAccounts: jest.fn().mockResolvedValue([]),
    findLiveCustomerId: jest.fn(async (user: any) => user?.stripe_customer_id ?? null),
    createCustomerForUser: jest.fn().mockResolvedValue('cus_new'),
    resolvePaymentMethod: jest.fn().mockResolvedValue(NO_CARD),
    createPaymentMethodSetupSession: jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_setup' }),
    buildMetaConnectUrl: jest.fn().mockResolvedValue('https://www.facebook.com/v23.0/dialog/oauth?client_id=x'),
    frontendUrl: () => 'https://app.agentweb.pro',
    now: () => NOW,
    ...over,
  } as any;
}

describe('ENG-2303 zoma_status onboarding', () => {
  it('no payment method -> next step is a Stripe setup-mode Checkout link; writes disabled', async () => {
    // ENG-3128: ad accounts come before the card, so Meta is connected here.
    const d = deps({ listAccounts: jest.fn().mockResolvedValue([metaAccount()]) });
    const r = await getZomaReadiness('u1', d);
    expect(r.payment).toEqual({ ready: false, link: 'https://checkout.stripe.com/c/pay/cs_setup' });
    expect(r.writes_enabled).toBe(false);
    expect(r.next_step).toContain('https://checkout.stripe.com/c/pay/cs_setup');
    expect(d.createCustomerForUser).toHaveBeenCalledWith('u1', 'a@b.co');
    expect(d.createPaymentMethodSetupSession).toHaveBeenCalledWith({
      stripeCustomerId: 'cus_new',
      userId: 'u1',
      successUrl: 'https://app.agentweb.pro/settings?zoma=payment_method_added',
      cancelUrl: 'https://app.agentweb.pro/settings?zoma=payment_method_canceled',
    });
  });

  it('reuses the existing Stripe customer instead of creating one', async () => {
    const d = deps({ getUser: jest.fn().mockResolvedValue({ userId: 'u1', zomaAdsExperience: 'runs_ads', stripe_customer_id: 'cus_old' }) });
    await getZomaReadiness('u1', d);
    expect(d.createCustomerForUser).not.toHaveBeenCalled();
    expect((d.createPaymentMethodSetupSession as jest.Mock).mock.calls[0][0].stripeCustomerId).toBe('cus_old');
  });

  it('payment method found live by the resolver -> paid; missing Meta -> Meta connect link', async () => {
    const d = deps({ resolvePaymentMethod: paid() });
    const r = await getZomaReadiness('u1', d);
    expect(r.payment.ready).toBe(true);
    expect(d.createPaymentMethodSetupSession).not.toHaveBeenCalled();
    expect(r.meta.ready).toBe(false);
    expect(r.meta.link).toMatch(/facebook\.com/);
    expect(r.next_step).toContain(r.meta.link!);
    expect(r.writes_enabled).toBe(false);
  });

  it('expired or revoked Meta connections are not usable', async () => {
    const d = deps({
      getUser: jest.fn().mockResolvedValue({ userId: 'u1', zomaAdsExperience: 'runs_ads' }),
      resolvePaymentMethod: paid(),
      listAccounts: jest.fn().mockResolvedValue([
        metaAccount({ token_expires_at: NOW - 1 }),
        metaAccount({ ads_scope_revoked_at: '2026-01-01' }),
      ]),
    });
    const r = await getZomaReadiness('u1', d);
    expect(r.meta.ready).toBe(false);
  });

  it('fully set up -> no next step, writes enabled, no Stripe objects minted', async () => {
    const d = deps({
      getUser: jest.fn().mockResolvedValue({ userId: 'u1', zomaAdsExperience: 'runs_ads', email: 'a@b.co' }),
      resolvePaymentMethod: paid(),
      listAccounts: jest.fn().mockResolvedValue([metaAccount()]),
    });
    const r: any = await runZomaTool('zoma_status', {}, { userId: 'u1' }, d);
    expect(r.next_step).toBeNull();
    expect(r.writes_enabled).toBe(true);
    expect(r.meta.accounts).toEqual([{ account_id: '111', name: 'Phoenix', currency: 'TWD', ads_management: 'granted' }]);
    expect(r.summary).toContain('[x] Payment method on file');
    expect(d.createCustomerForUser).not.toHaveBeenCalled();
    expect(d.createPaymentMethodSetupSession).not.toHaveBeenCalled();
    expect(d.buildMetaConnectUrl).not.toHaveBeenCalled();
  });

  it('a Stripe outage fails closed (not ready, no throw, no link)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = deps({ resolvePaymentMethod: jest.fn().mockRejectedValue(new Error('stripe down')) });
    const r = await getZomaReadiness('u1', d);
    expect(r.payment.ready).toBe(false);
    expect(r.payment.link).toBeUndefined();
    expect(r.writes_enabled).toBe(false);
  });
});

describe('ENG-2303 write readiness gate', () => {
  it('refuses without a payment method', async () => {
    await expect(assertZomaWriteReady('u1', deps({ listAccounts: jest.fn().mockResolvedValue([metaAccount()]) }))).rejects.toThrow(
      /No payment method on file/,
    );
  });

  it('refuses without a usable Meta connection', async () => {
    const d = deps({ resolvePaymentMethod: paid() });
    await expect(assertZomaWriteReady('u1', d)).rejects.toThrow(ZomaNotReadyError);
  });

  it('refuses when the payment state cannot be read', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = deps({ resolvePaymentMethod: jest.fn().mockRejectedValue(new Error('x')), listAccounts: jest.fn().mockResolvedValue([metaAccount()]) });
    await expect(assertZomaWriteReady('u1', d)).rejects.toThrow(/Could not verify a payment method/);
  });

  it('ENG-2571: a stale has_payment_method flag alone never makes the user ready (checked live)', async () => {
    const d = deps({
      getUser: jest.fn().mockResolvedValue({ userId: 'u1', zomaAdsExperience: 'runs_ads', email: 'a@b.co', has_payment_method: true }),
      listAccounts: jest.fn().mockResolvedValue([metaAccount()]),
    });
    const r = await getZomaReadiness('u1', d);
    expect(r.payment.ready).toBe(false);
    expect(r.writes_enabled).toBe(false);
    expect(d.resolvePaymentMethod).toHaveBeenCalledWith(expect.objectContaining({ has_payment_method: true }), 'u1');
    await expect(assertZomaWriteReady('u1', d)).rejects.toThrow(/No payment method on file/);
  });

  it('passes with payment method + usable Meta and never mints Stripe objects', async () => {
    const d = deps({ getUser: jest.fn().mockResolvedValue({ userId: 'u1', zomaAdsExperience: 'runs_ads' }),
      resolvePaymentMethod: paid(), listAccounts: jest.fn().mockResolvedValue([metaAccount()]) });
    await expect(assertZomaWriteReady('u1', d)).resolves.toBeUndefined();
    expect(d.createCustomerForUser).not.toHaveBeenCalled();
    expect(d.createPaymentMethodSetupSession).not.toHaveBeenCalled();
  });
});
