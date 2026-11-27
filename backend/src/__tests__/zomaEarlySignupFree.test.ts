jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), getUsersByIds: jest.fn() } }));

import {
  assertZomaPublishAllowed,
  formatZomaPlanLine,
  getZomaBillingConfig,
  getZomaPlanSummary,
  ZomaBillingDeps,
  ZomaPaywallError,
} from '../mcp/zomaBilling';
import { getZomaEarlySignupConfig, isEarlySignupFree } from '../mcp/zomaEarlySignup';

const BILLING_ENV = {
  ZOMA_BILLING_ENABLED: 'true',
  ZOMA_STRIPE_PLAN_PRICE_ID: 'price_plan',
  ZOMA_STRIPE_OVERAGE_PRICE_ID: 'price_overage',
  ZOMA_STRIPE_TRIAL_FEE_PRICE_ID: 'price_fee',
};
const EARLY_ENV = {
  ZOMA_EARLY_SIGNUP_FREE_ENABLED: 'true',
  ZOMA_EARLY_SIGNUP_FROM: '2026-11-13T00:00:00-08:00',
  ZOMA_EARLY_SIGNUP_UNTIL: '2026-12-03T23:59:59-08:00',
  ZOMA_EARLY_SIGNUP_FREE_UNTIL: '2027-01-01T00:00:00-08:00',
};
const IN_WINDOW = '2026-11-20T18:00:00.000Z';
const BEFORE_WINDOW = '2026-11-13T07:59:59.000Z'; // 23:59:59 PT on Nov 12
const AFTER_WINDOW = '2026-12-04T08:00:00.000Z'; // 00:00 PT on Dec 4
const DEC_2 = Date.parse('2026-12-02T17:00:00Z');
const FREE_END = Date.parse('2027-01-01T08:00:00Z');

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(EARLY_ENV)) delete process.env[k];
  Object.assign(process.env, saved);
});
const setEarly = (over: Record<string, string | undefined> = {}) => {
  for (const [k, v] of Object.entries({ ...EARLY_ENV, ...over })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

function deps(createdAt: string | undefined, now = DEC_2, over: Partial<ZomaBillingDeps> = {}): ZomaBillingDeps {
  return {
    config: () => getZomaBillingConfig(BILLING_ENV),
    getUser: jest.fn().mockResolvedValue({ userId: 'u1', email: 'u1@example.com', createdAt }),
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
    getUsage: jest.fn(),
    getAdsSummary: jest.fn(),
    recordFunnel: jest.fn().mockResolvedValue(true),
    backendUrl: () => 'https://api.example.com',
    now: () => now,
    ...over,
  };
}

const publish = (d: ZomaBillingDeps) => assertZomaPublishAllowed('u1', { platform: 'meta' }, d);

describe('early-signup free period', () => {
  it('in the window and before free-until: no paywall, no checkout, no Stripe lookup', async () => {
    setEarly();
    const d = deps(IN_WINDOW);
    await expect(publish(d)).resolves.toBeUndefined();
    expect(d.createCheckoutSession).not.toHaveBeenCalled();
    expect(d.findCustomerId).not.toHaveBeenCalled();
  });

  it('window edges are inclusive in PT', async () => {
    setEarly();
    await expect(publish(deps('2026-11-13T08:00:00.000Z'))).resolves.toBeUndefined();
    await expect(publish(deps('2026-12-04T07:59:59.000Z'))).resolves.toBeUndefined();
  });

  it.each([['before', BEFORE_WINDOW], ['after', AFTER_WINDOW]])('signed up %s the window: paywall as today', async (_l, createdAt) => {
    setEarly();
    const d = deps(createdAt);
    await expect(publish(d)).rejects.toBeInstanceOf(ZomaPaywallError);
    expect(d.createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it('after free-until the paywall returns, at the exact instant', async () => {
    setEarly();
    await expect(publish(deps(IN_WINDOW, FREE_END - 1))).resolves.toBeUndefined();
    await expect(publish(deps(IN_WINDOW, FREE_END))).rejects.toBeInstanceOf(ZomaPaywallError);
  });

  it('flag off: no change at all and the user is never looked up', async () => {
    // Baseline: no early-signup env at all. The one getUser call is the existing checkout-link path.
    const base = deps(IN_WINDOW);
    const baseErr: any = await publish(base).catch((e) => e);
    expect(baseErr).toBeInstanceOf(ZomaPaywallError);
    for (const flag of [undefined, 'false', 'TRUE', '1']) {
      setEarly({ ZOMA_EARLY_SIGNUP_FREE_ENABLED: flag });
      const d = deps(IN_WINDOW);
      const err: any = await publish(d).catch((e) => e);
      expect(err.message).toBe(baseErr.message);
      expect((d.getUser as jest.Mock).mock.calls).toEqual((base.getUser as jest.Mock).mock.calls);
      expect((d.createCheckoutSession as jest.Mock).mock.calls).toEqual((base.createCheckoutSession as jest.Mock).mock.calls);
      const plan = await getZomaPlanSummary('u1', deps(IN_WINDOW));
      expect(plan?.free_until).toBeUndefined();
      expect(plan?.publish_enabled).toBe(false);
    }
  });

  it('billing off: early flag does nothing either way', async () => {
    setEarly();
    const d = deps(IN_WINDOW, DEC_2, { config: () => getZomaBillingConfig({}) });
    await expect(publish(d)).resolves.toBeUndefined();
    expect(d.getUser).not.toHaveBeenCalled();
    expect(await getZomaPlanSummary('u1', d)).toBeUndefined();
  });

  it.each([
    ['missing createdAt', undefined],
    ['garbage createdAt', 'not-a-date'],
  ])('fails closed on %s', async (_l, createdAt) => {
    setEarly();
    await expect(publish(deps(createdAt))).rejects.toBeInstanceOf(ZomaPaywallError);
  });

  it('fails closed when the user lookup throws', async () => {
    setEarly();
    const d = deps(IN_WINDOW, DEC_2, { getUser: jest.fn().mockRejectedValue(new Error('ddb down')) });
    await expect(publish(d)).rejects.toBeInstanceOf(ZomaPaywallError);
  });

  it.each([
    ['offset-less date', { ZOMA_EARLY_SIGNUP_FROM: '2026-11-13T00:00:00' }],
    ['date only', { ZOMA_EARLY_SIGNUP_FREE_UNTIL: '2027-01-01' }],
    ['inverted window', { ZOMA_EARLY_SIGNUP_FROM: '2026-12-05T00:00:00-08:00' }],
  ])('invalid config (%s) disables the skip', async (_l, over) => {
    setEarly(over as any);
    expect(getZomaEarlySignupConfig()).toBeUndefined();
    await expect(publish(deps(IN_WINDOW))).rejects.toBeInstanceOf(ZomaPaywallError);
  });

  it('flag alone uses the built-in window (no date env needed)', async () => {
    setEarly({ ZOMA_EARLY_SIGNUP_FROM: undefined, ZOMA_EARLY_SIGNUP_UNTIL: undefined, ZOMA_EARLY_SIGNUP_FREE_UNTIL: undefined });
    const cfg = getZomaEarlySignupConfig()!;
    expect(cfg.from).toBe(Date.parse('2026-11-13T08:00:00Z'));
    expect(cfg.until).toBe(Date.parse('2026-12-04T07:59:59Z'));
    expect(cfg.freeUntil).toBe(FREE_END);
    await expect(publish(deps(IN_WINDOW))).resolves.toBeUndefined();
    await expect(publish(deps(BEFORE_WINDOW))).rejects.toBeInstanceOf(ZomaPaywallError);
    expect((await getZomaPlanSummary('u1', deps(IN_WINDOW)))?.free_until).toBe('Jan 1, 2027');
  });

  it('blank date env falls back to the default; a set env value overrides it', () => {
    setEarly({ ZOMA_EARLY_SIGNUP_UNTIL: '  ', ZOMA_EARLY_SIGNUP_FREE_UNTIL: '2027-02-01T00:00:00-08:00' });
    const cfg = getZomaEarlySignupConfig()!;
    expect(cfg.until).toBe(Date.parse('2026-12-04T07:59:59Z'));
    expect(cfg.freeUntil).toBe(Date.parse('2027-02-01T08:00:00Z'));
    expect(cfg.freeUntilRaw).toBe('2027-02-01T00:00:00-08:00');
  });

  it('defaults do nothing while the flag is off', () => {
    setEarly({ ZOMA_EARLY_SIGNUP_FREE_ENABLED: undefined, ZOMA_EARLY_SIGNUP_FROM: undefined, ZOMA_EARLY_SIGNUP_UNTIL: undefined, ZOMA_EARLY_SIGNUP_FREE_UNTIL: undefined });
    expect(getZomaEarlySignupConfig()).toBeUndefined();
  });

  it('zoma_status says free until Jan 1 and mints no checkout', async () => {
    setEarly();
    const d = deps(IN_WINDOW);
    const plan = await getZomaPlanSummary('u1', d);
    expect(plan).toEqual({ status: 'none', publish_enabled: true, free_until: 'Jan 1, 2027' });
    expect(formatZomaPlanLine(plan!, getZomaBillingConfig(BILLING_ENV))).toBe('  [x] Zoma plan: free until Jan 1, 2027, no card needed');
    expect(d.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('zoma_status for an out-of-window user is unchanged (trial link)', async () => {
    setEarly();
    const plan = await getZomaPlanSummary('u1', deps(BEFORE_WINDOW));
    expect(plan?.free_until).toBeUndefined();
    expect(plan?.publish_enabled).toBe(false);
    expect(plan?.link).toContain('/api/zoma/billing/checkout/');
  });

  it('early signup with an existing active plan sees that plan, not "free"', async () => {
    setEarly();
    const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    const active: any = {
      id: 'sub_1', status: 'active', created: sec('2026-11-20T00:00:00Z'), latest_invoice: { id: 'in_1', status: 'paid' },
      cancel_at_period_end: false, metadata: { product: 'zoma_plan', userId: 'u1' },
      items: { data: [{ current_period_start: sec('2026-11-27T00:00:00Z'), current_period_end: sec('2026-12-27T00:00:00Z') }] },
    };
    const d = deps(IN_WINDOW, DEC_2, { findCustomerId: jest.fn().mockResolvedValue('cus_1'), listSubscriptions: jest.fn().mockResolvedValue([active]) });
    const plan = await getZomaPlanSummary('u1', d);
    expect(plan?.status).toBe('active');
    expect(plan?.free_until).toBeUndefined();
    expect(plan?.publish_enabled).toBe(true);
  });

  it('early signup with an unsettled trial: no payment-pending block, publish allowed', async () => {
    setEarly();
    const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    const trial: any = {
      id: 'sub_t', status: 'trialing', created: sec('2026-11-20T00:00:00Z'), trial_start: sec('2026-11-20T00:00:00Z'), trial_end: sec('2026-11-27T00:00:00Z'),
      latest_invoice: { id: 'in_fee', status: 'open' }, cancel_at_period_end: false, metadata: { product: 'zoma_plan', userId: 'u1' },
      items: { data: [{ current_period_start: sec('2026-11-20T00:00:00Z'), current_period_end: sec('2026-11-27T00:00:00Z') }] },
    };
    const d = deps(IN_WINDOW, DEC_2, { findCustomerId: jest.fn().mockResolvedValue('cus_1'), listSubscriptions: jest.fn().mockResolvedValue([trial]) });
    const plan = await getZomaPlanSummary('u1', d);
    expect(plan?.error).toBeUndefined();
    expect(plan?.publish_enabled).toBe(true);
    expect(formatZomaPlanLine(plan!, getZomaBillingConfig(BILLING_ENV))).toMatch(/^  \[x\] Zoma plan: trial/);
    await expect(publish(d)).resolves.toBeUndefined();
  });

  it.each(['past_due', 'unpaid'])('early signup with a %s plan shows free, no link, no error', async (status) => {
    setEarly();
    const d = deps(IN_WINDOW, DEC_2, {
      findCustomerId: jest.fn().mockResolvedValue('cus_1'),
      listSubscriptions: jest.fn().mockResolvedValue([{ id: 'sub_p', status, created: 5, metadata: { product: 'zoma_plan' }, items: { data: [] } }]),
    });
    const plan = await getZomaPlanSummary('u1', d);
    expect(plan).toEqual({ status: 'none', publish_enabled: true, free_until: 'Jan 1, 2027' });
    expect(d.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('early signup with a cancelled old plan still shows free, and no checkout', async () => {
    setEarly();
    const d = deps(IN_WINDOW, DEC_2, {
      findCustomerId: jest.fn().mockResolvedValue('cus_1'),
      listSubscriptions: jest.fn().mockResolvedValue([{ id: 'sub_old', status: 'canceled', created: 1, metadata: { product: 'zoma_plan' }, items: { data: [] } }]),
    });
    expect((await getZomaPlanSummary('u1', d))?.free_until).toBe('Jan 1, 2027');
    expect(d.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('early signup: Stripe read failure still shows free (matches the write guard)', async () => {
    setEarly();
    const d = deps(IN_WINDOW, DEC_2, { findCustomerId: jest.fn().mockRejectedValue(new Error('stripe down')) });
    expect((await getZomaPlanSummary('u1', d))?.free_until).toBe('Jan 1, 2027');
    await expect(publish(d)).resolves.toBeUndefined();
  });

  it('non-early: Stripe read failure is unchanged (error, publish disabled)', async () => {
    setEarly();
    const d = deps(BEFORE_WINDOW, DEC_2, { findCustomerId: jest.fn().mockRejectedValue(new Error('stripe down')) });
    const plan = await getZomaPlanSummary('u1', d);
    expect(plan?.publish_enabled).toBe(false);
    expect(plan?.error).toMatch(/Could not check/);
  });

  it.each(['2027-02-30T00:00:00-08:00', '2027-01-01T24:00:00-08:00', '2027-13-01T00:00:00Z'])('impossible date %s disables the skip', async (bad) => {
    setEarly({ ZOMA_EARLY_SIGNUP_FREE_UNTIL: bad });
    expect(getZomaEarlySignupConfig()).toBeUndefined();
  });

  it('isEarlySignupFree pure checks', () => {
    setEarly();
    const cfg = getZomaEarlySignupConfig()!;
    expect(isEarlySignupFree(IN_WINDOW, DEC_2, cfg)).toBe(true);
    expect(isEarlySignupFree(IN_WINDOW, DEC_2, undefined)).toBe(false);
    expect(isEarlySignupFree(123, DEC_2, cfg)).toBe(false);
  });
});
