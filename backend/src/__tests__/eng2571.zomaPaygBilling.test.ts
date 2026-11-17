process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
/**
 * ENG-2571 acceptance (Zoma "Pay as you go" billing). Stripe SDK mocked; the route and
 * stripeService run for real.
 *  1/4  GET /api/stripe/billing-summary reports the card (and the Zoma marker, which comes
 *       from a SetupIntent's metadata.purchaseType, not customer metadata).
 *  2    Manage Billing opens the portal for the customer that holds the card.
 *  3    Nothing is written to the user row.
 *  5    No card / subscribed: unchanged.
 *  6    A Stripe error is a 503, never a silent "no card".
 *  7    The summary never carries a Stripe customer id.
 *  8    The setup Checkout shows the approved submit message.
 *  9    A deleted Zoma customer never blocks minting a new payment link.
 *  A deleted or unknown (resource_missing) candidate customer is skipped everywhere, never fatal.
 */
import express from 'express';
import request from 'supertest';

const mockStripe = {
  customers: { create: jest.fn(), retrieve: jest.fn(), search: jest.fn(), list: jest.fn() },
  paymentMethods: { list: jest.fn() },
  setupIntents: { list: jest.fn() },
  checkout: { sessions: { create: jest.fn() } },
  billingPortal: { sessions: { create: jest.fn() } },
};
jest.mock('stripe', () => jest.fn().mockImplementation(() => mockStripe));

const mockGetUserById = jest.fn();
const mockUpdateUser = jest.fn();
const mockGetOrgById = jest.fn();
jest.mock('../services/db', () => ({
  userDb: { getUserById: mockGetUserById, updateUser: mockUpdateUser },
  orgDb: { getOrgById: mockGetOrgById },
  User: {},
}));
jest.mock('../services/waitlistDb', () => ({ waitlistDb: {}, WaitlistEntry: {} }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u1', email: 'z@acme.co', isAdmin: false };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  AuthenticatedRequest: {},
}));
jest.mock('../controllers/stripeController', () => ({ handleWebhook: jest.fn(), listProducts: jest.fn(), reconcile: jest.fn(), getPaymentHistory: jest.fn() }));
jest.mock('../services/metaConnectUrl', () => ({ buildMetaConnectUrl: jest.fn() }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/mcpUsageEventsService', () => ({ getMcpUserUsage: jest.fn() }));

process.env.STRIPE_SECRET_KEY = 'sk_test_fake';

import stripeRouter from '../routes/stripe';
import { stripeService } from '../services/stripeService';
import { createZomaPaymentSetupLink, type ZomaOnboardingDeps } from '../mcp/zomaOnboarding';

const app = express();
app.use(express.json());
app.use('/api/stripe', stripeRouter);

const VISA = { id: 'pm_visa', type: 'card', created: 200, card: { brand: 'visa', last4: '0159' } };
const OLD_MC = { id: 'pm_mc', type: 'card', created: 100, card: { brand: 'mastercard', last4: '4444' } };
const ZOMA_SI = { id: 'seti_1', status: 'succeeded', metadata: { userId: 'u1', purchaseType: 'zoma_payment_method' } };

/** Stripe state keyed by customer id. */
function stripeState(customers: Record<string, { deleted?: boolean; defaultPm?: any; pms?: any[]; sis?: any[]; metadata?: any }>, searchIds: string[] = []) {
  mockStripe.customers.search.mockResolvedValue({ data: searchIds.map((id) => ({ id })) });
  mockStripe.customers.list.mockResolvedValue({ data: [] });
  mockStripe.customers.retrieve.mockImplementation(async (id: string) => {
    const c = customers[id];
    if (!c) {
      throw Object.assign(new Error(`No such customer: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
    }
    if (c.deleted) return { id, deleted: true };
    return { id, metadata: c.metadata ?? {}, invoice_settings: { default_payment_method: c.defaultPm ?? null } };
  });
  mockStripe.paymentMethods.list.mockImplementation(async ({ customer }: any) => ({ data: customers[customer]?.pms ?? [] }));
  mockStripe.setupIntents.list.mockImplementation(async ({ customer }: any) => ({ data: customers[customer]?.sis ?? [] }));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  mockGetOrgById.mockResolvedValue(null);
  mockStripe.billingPortal.sessions.create.mockResolvedValue({ url: 'https://billing.stripe.com/p/session/x' });
});

describe('GET /api/stripe/billing-summary', () => {
  it('1: Zoma card on a searched customer -> card brand/last4 + isZoma, no customer id, no user write', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1', subscriptionType: 'Free' });
    stripeState({ cus_zoma: { pms: [VISA], sis: [ZOMA_SI] } }, ['cus_zoma']);
    const res = await request(app).get('/api/stripe/billing-summary');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasPaymentMethod: true, isZoma: true, card: { brand: 'visa', last4: '0159' } });
    expect(JSON.stringify(res.body)).not.toMatch(/cus_/); // 7
    expect(mockUpdateUser).not.toHaveBeenCalled(); // 3
  });

  it('prefers the default payment method, else the most recently created card', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1' });
    stripeState({ cus_zoma: { defaultPm: OLD_MC, pms: [VISA, OLD_MC], sis: [ZOMA_SI] } }, ['cus_zoma']);
    let res = await request(app).get('/api/stripe/billing-summary');
    expect(res.body.card).toEqual({ brand: 'mastercard', last4: '4444' });

    stripeState({ cus_zoma: { pms: [OLD_MC, VISA], sis: [] } }, ['cus_zoma']);
    res = await request(app).get('/api/stripe/billing-summary');
    expect(res.body.card).toEqual({ brand: 'visa', last4: '0159' });
  });

  it('4: card without a Zoma SetupIntent (churned subscriber, even with source=zoma_mcp metadata) -> isZoma false', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1', stripe_customer_id: 'cus_old', subscription_status: 'canceled' });
    stripeState({
      cus_old: {
        pms: [VISA],
        metadata: { source: 'zoma_mcp' },
        sis: [{ id: 'seti_sub', status: 'succeeded', metadata: {} }, { ...ZOMA_SI, id: 'seti_abandoned', status: 'requires_payment_method' }],
      },
    });
    const res = await request(app).get('/api/stripe/billing-summary');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasPaymentMethod: true, isZoma: false, card: { brand: 'visa', last4: '0159' } });
  });

  it('finds the card on a searched customer when user.stripe_customer_id points at another one', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1', stripe_customer_id: 'cus_other' });
    stripeState({ cus_other: { pms: [] }, cus_zoma: { pms: [VISA], sis: [ZOMA_SI] } }, ['cus_zoma']);
    const res = await request(app).get('/api/stripe/billing-summary');
    expect(res.body).toEqual({ hasPaymentMethod: true, isZoma: true, card: { brand: 'visa', last4: '0159' } });
  });

  it('a card saved moments ago is found by email while search still lags (Opslane run 925)', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1', email: 'z@acme.co' });
    stripeState({ cus_new: { pms: [VISA], sis: [ZOMA_SI] } }, []);
    mockStripe.customers.list.mockResolvedValue({ data: [{ id: 'cus_new', metadata: { userId: 'u1' } }] });
    const res = await request(app).get('/api/stripe/billing-summary');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasPaymentMethod: true, isZoma: true, card: { brand: 'visa', last4: '0159' } });
    expect(mockStripe.customers.list).toHaveBeenCalledWith({ email: 'z@acme.co', limit: 10 });
    const portal = await request(app).post('/api/stripe/create-customer-portal-session');
    expect(portal.status).toBe(200);
    expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_new' }));
  });

  it("an email match that belongs to another user id is ignored", async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1', email: 'z@acme.co' });
    stripeState({ cus_someone: { pms: [VISA], sis: [ZOMA_SI] } }, []);
    mockStripe.customers.list.mockResolvedValue({ data: [{ id: 'cus_someone', metadata: { userId: 'u2' } }] });
    const res = await request(app).get('/api/stripe/billing-summary');
    expect(res.body).toEqual({ hasPaymentMethod: false, isZoma: false, card: null });
  });

  it('a stale user.stripe_customer_id Stripe no longer knows is skipped; the searched card holder still wins', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1', stripe_customer_id: 'cus_gone' });
    stripeState({ cus_zoma: { pms: [VISA], sis: [ZOMA_SI] } }, ['cus_zoma']);
    const res = await request(app).get('/api/stripe/billing-summary');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasPaymentMethod: true, isZoma: true, card: { brand: 'visa', last4: '0159' } });
  });

  it('6: any other customer-retrieve error is still a 503, not a skipped customer', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1', stripe_customer_id: 'cus_old' });
    stripeState({ cus_zoma: { pms: [VISA], sis: [ZOMA_SI] } }, ['cus_zoma']);
    mockStripe.customers.retrieve.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { statusCode: 429 }));
    const res = await request(app).get('/api/stripe/billing-summary');
    expect(res.status).toBe(503);
  });

  it('5: no card anywhere -> all false', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1' });
    stripeState({}, []);
    const res = await request(app).get('/api/stripe/billing-summary');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasPaymentMethod: false, isZoma: false, card: null });
  });

  it('6: Stripe error -> 503 with an error, never a silent false', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1' });
    mockStripe.customers.search.mockRejectedValue(new Error('stripe down'));
    const res = await request(app).get('/api/stripe/billing-summary');
    expect(res.status).toBe(503);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.hasPaymentMethod).toBeUndefined();
  });

  it('org member billed through the owner -> all false without calling Stripe', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1', orgId: 'org1' });
    mockGetOrgById.mockResolvedValue({ orgId: 'org1', ownerUserId: 'owner1' });
    const res = await request(app).get('/api/stripe/billing-summary');
    expect(res.body).toEqual({ hasPaymentMethod: false, isZoma: false, card: null });
    expect(mockStripe.customers.search).not.toHaveBeenCalled();
    expect(mockStripe.customers.retrieve).not.toHaveBeenCalled();
  });
});

describe('POST /api/stripe/create-customer-portal-session', () => {
  it('2: unsubscribed user with no stripe_customer_id -> portal for the Zoma customer holding the card', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1', subscription_status: undefined });
    stripeState({ cus_zoma: { pms: [VISA], sis: [ZOMA_SI] } }, ['cus_zoma']);
    const res = await request(app).post('/api/stripe/create-customer-portal-session');
    expect(res.status).toBe(200);
    expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_zoma' }));
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('2: unsubscribed user whose stripe_customer_id is a different, card-less customer -> the card holder', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1', stripe_customer_id: 'cus_other', subscription_status: 'canceled' });
    stripeState({ cus_other: { pms: [] }, cus_zoma: { pms: [VISA], sis: [ZOMA_SI] } }, ['cus_zoma']);
    const res = await request(app).post('/api/stripe/create-customer-portal-session');
    expect(res.status).toBe(200);
    expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_zoma' }));
  });

  it('unsubscribed user with no card but a row customer -> unchanged: portal for that customer (invoice history)', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1', stripe_customer_id: 'cus_other', subscription_status: 'canceled' });
    stripeState({ cus_other: { pms: [] } }, []);
    const res = await request(app).post('/api/stripe/create-customer-portal-session');
    expect(res.status).toBe(200);
    expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_other' }));
  });

  it('unsubscribed user with a row customer -> a failed card lookup still opens that customer', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1', stripe_customer_id: 'cus_other', subscription_status: 'canceled' });
    mockStripe.customers.search.mockRejectedValue(new Error('Stripe is down'));
    const res = await request(app).post('/api/stripe/create-customer-portal-session');
    expect(res.status).toBe(200);
    expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_other' }));
  });

  it('unsubscribed user with no card and no row id -> a searched live customer still opens (invoice history)', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1' });
    stripeState({ cus_old: { pms: [] } }, ['cus_old']);
    const res = await request(app).post('/api/stripe/create-customer-portal-session');
    expect(res.status).toBe(200);
    expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_old' }));
  });

  it.each(['incomplete', 'unpaid', 'paused'])('a %s subscription keeps its own customer, never another card holder', async (status) => {
    mockGetUserById.mockResolvedValue({ userId: 'u1', stripe_customer_id: 'cus_sub', subscription_status: status });
    stripeState({ cus_sub: { pms: [] }, cus_zoma: { pms: [VISA], sis: [ZOMA_SI] } }, ['cus_zoma']);
    const res = await request(app).post('/api/stripe/create-customer-portal-session');
    expect(res.status).toBe(200);
    expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_sub' }));
    expect(mockStripe.customers.search).not.toHaveBeenCalled();
  });

  it('unsubscribed user with no card and no customer anywhere -> 404', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1' });
    stripeState({}, []);
    const res = await request(app).post('/api/stripe/create-customer-portal-session');
    expect(res.status).toBe(404);
    expect(mockStripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('5: subscribed user -> unchanged: their own stripe_customer_id, no lookup', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'u1', stripe_customer_id: 'cus_sub', subscription_status: 'active' });
    const res = await request(app).post('/api/stripe/create-customer-portal-session');
    expect(res.status).toBe(200);
    expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_sub' }));
    expect(mockStripe.customers.search).not.toHaveBeenCalled();
  });
});

describe('Zoma setup Checkout + customer creation', () => {
  it('8: the setup Checkout shows the approved submit message', async () => {
    mockStripe.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
    await stripeService.createPaymentMethodSetupSession({ stripeCustomerId: 'cus_1', userId: 'u1', successUrl: 's', cancelUrl: 'c' });
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].custom_text).toEqual({
      submit: { message: 'Saving a card lets Zoma make changes to your ads. Nothing is charged today.' },
    });
  });

  it("9: after the user's only Zoma customer is deleted, a new customer and session are minted", async () => {
    // Stripe replays an idempotent create for 24h: the first key returns the deleted customer.
    stripeState({ cus_dead: { deleted: true }, cus_fresh: {} }, []);
    mockStripe.customers.create.mockImplementation(async (_params: any, opts: any) =>
      opts.idempotencyKey === 'zoma-customer-u1' ? { id: 'cus_dead' } : { id: 'cus_fresh' },
    );
    mockStripe.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_new' });
    const deps = {
      getUser: async () => ({ userId: 'u1', email: 'z@acme.co' }),
      findLiveCustomerId: (user: any, id: string) => stripeService.findLiveCustomerIdForUser(user, id),
      createCustomerForUser: (id: string, email: string | undefined) => stripeService.createCustomerForUser(id, email),
      createPaymentMethodSetupSession: (p: any) => stripeService.createPaymentMethodSetupSession(p),
      pagesUrl: () => 'https://api.agentweb.pro',
    } as unknown as ZomaOnboardingDeps;
    const url = await createZomaPaymentSetupLink('u1', { successUrl: 's', cancelUrl: 'c' }, deps);
    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_new');
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].customer).toBe('cus_fresh');
  });

  function linkDeps(user: any): ZomaOnboardingDeps {
    return {
      getUser: async () => user,
      findLiveCustomerId: (u: any, id: string) => stripeService.findLiveCustomerIdForUser(u, id),
      createCustomerForUser: (id: string, email: string | undefined) => stripeService.createCustomerForUser(id, email),
      createPaymentMethodSetupSession: (p: any) => stripeService.createPaymentMethodSetupSession(p),
      pagesUrl: () => 'https://api.agentweb.pro',
    } as unknown as ZomaOnboardingDeps;
  }

  it('9: the deleted customer is still in the lagging search index -> skipped, a new customer is minted', async () => {
    stripeState({ cus_dead: { deleted: true }, cus_fresh: {} }, ['cus_dead']);
    mockStripe.customers.create.mockImplementation(async (_params: any, opts: any) =>
      opts.idempotencyKey === 'zoma-customer-u1' ? { id: 'cus_dead' } : { id: 'cus_fresh' },
    );
    mockStripe.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_new' });
    const url = await createZomaPaymentSetupLink('u1', { successUrl: 's', cancelUrl: 'c' }, linkDeps({ userId: 'u1', email: 'z@acme.co' }));
    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_new');
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].customer).toBe('cus_fresh');
  });

  it('9: user.stripe_customer_id deleted or unknown -> falls through to the next live candidate', async () => {
    stripeState({ cus_dead: { deleted: true }, cus_live: {} }, ['cus_live']);
    mockStripe.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_live' });
    await createZomaPaymentSetupLink('u1', { successUrl: 's', cancelUrl: 'c' }, linkDeps({ userId: 'u1', stripe_customer_id: 'cus_dead' }));
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].customer).toBe('cus_live');

    mockStripe.checkout.sessions.create.mockClear();
    await createZomaPaymentSetupLink('u1', { successUrl: 's', cancelUrl: 'c' }, linkDeps({ userId: 'u1', stripe_customer_id: 'cus_gone' }));
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].customer).toBe('cus_live');
    expect(mockStripe.customers.create).not.toHaveBeenCalled();
  });

  it('a live row customer is used without waiting on discovery, even when search fails', async () => {
    stripeState({ cus_row: {} }, []);
    mockStripe.customers.search.mockRejectedValue(new Error('search down'));
    mockStripe.customers.list.mockRejectedValue(new Error('list down'));
    await expect(stripeService.findLiveCustomerIdForUser({ stripe_customer_id: 'cus_row', email: 'z@acme.co' }, 'u1')).resolves.toBe('cus_row');
    expect(mockStripe.customers.search).not.toHaveBeenCalled();
  });

  it('9: concurrent first-time creates share one idempotency key (still deduped)', async () => {
    stripeState({ cus_a: {} }, []);
    mockStripe.customers.create.mockResolvedValue({ id: 'cus_a' });
    const [a, b] = await Promise.all([stripeService.createCustomerForUser('u1', undefined), stripeService.createCustomerForUser('u1', undefined)]);
    expect(a).toBe('cus_a');
    expect(b).toBe('cus_a');
    const keys = mockStripe.customers.create.mock.calls.map((c: any[]) => c[1].idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });
});
