const mockStripe = {
  subscriptions: { retrieve: jest.fn() },
  subscriptionItems: { create: jest.fn(), del: jest.fn() },
};
jest.mock('stripe', () => jest.fn().mockImplementation(() => mockStripe));
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';

const mockOrgDb = { getOrgById: jest.fn(), updateOrg: jest.fn() };
const mockUserDb = { getUserById: jest.fn() };
jest.mock('../services/db', () => ({ orgDb: mockOrgDb, userDb: mockUserDb }));

import { addHotLeadCallBilling, mirrorHotLeadCallBilling, HotLeadCallBillingError } from '../services/hotLeadCallBillingService';

const PRODUCT = 'prod_hot_lead';
const item = (id = 'si_hlc', created = 1) => ({ id, created, price: { product: PRODUCT, recurring: { interval: 'month' } } });
const baseItem = { id: 'si_base', created: 0, price: { product: 'prod_plan', recurring: { interval: 'month' } } };
const sub = (items: unknown[] = [], status = 'active') => ({ id: 'sub_1', status, items: { data: items } });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_HOT_LEAD_CALL_PRODUCT_ID = PRODUCT;
  mockOrgDb.getOrgById.mockResolvedValue({ orgId: 'org-a', ownerUserId: 'owner' });
  mockUserDb.getUserById.mockResolvedValue({ userId: 'owner', stripe_subscription_id: 'sub_1' });
  mockStripe.subscriptions.retrieve.mockResolvedValue(sub([baseItem]));
  mockStripe.subscriptionItems.create.mockResolvedValue(item());
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('addHotLeadCallBilling', () => {
  it('adds one $70 monthly item on the owner’s subscription with an idempotency key, and mirrors it at once', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValueOnce(sub([baseItem])).mockResolvedValueOnce(sub([baseItem, item()]));
    await expect(addHotLeadCallBilling('org-a')).resolves.toEqual({ itemId: 'si_hlc', alreadyPresent: false });
    const [params, options] = mockStripe.subscriptionItems.create.mock.calls[0];
    expect(params).toMatchObject({
      subscription: 'sub_1', quantity: 1, payment_behavior: 'error_if_incomplete',
      price_data: { currency: 'usd', unit_amount: 7000, product: PRODUCT, recurring: { interval: 'month' } },
    });
    expect(options.idempotencyKey).toContain('org-a');
    // Entitlement must not wait for the webhook: the mirror is written right after the charge.
    expect(mockOrgDb.updateOrg).toHaveBeenCalledWith('org-a', { hotLeadCallBilling: expect.objectContaining({ itemId: 'si_hlc', status: 'active' }) });
  });

  it('removes a duplicate item created by a racing request, keeping the earliest', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValueOnce(sub([baseItem])).mockResolvedValueOnce(sub([baseItem, item('si_late', 9), item('si_first', 3)]));
    mockStripe.subscriptionItems.create.mockResolvedValue(item('si_late', 9));
    await expect(addHotLeadCallBilling('org-a')).resolves.toEqual({ itemId: 'si_first', alreadyPresent: false });
    expect(mockStripe.subscriptionItems.del).toHaveBeenCalledTimes(1);
    expect(mockStripe.subscriptionItems.del).toHaveBeenCalledWith('si_late', { proration_behavior: 'always_invoice' });
    expect(mockOrgDb.updateOrg).toHaveBeenCalledWith('org-a', { hotLeadCallBilling: expect.objectContaining({ itemId: 'si_first' }) });
  });

  it('a failed duplicate check never fails an add that was paid', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValueOnce(sub([baseItem])).mockRejectedValueOnce(new Error('boom'));
    await expect(addHotLeadCallBilling('org-a')).resolves.toEqual({ itemId: 'si_hlc', alreadyPresent: false });
  });

  it('is idempotent: when the live subscription already has the item nothing is created', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(sub([item('si_existing')]));
    await expect(addHotLeadCallBilling('org-a')).resolves.toEqual({ itemId: 'si_existing', alreadyPresent: true });
    expect(mockStripe.subscriptionItems.create).not.toHaveBeenCalled();
    // A stale 'past_due' or 'canceled' mirror is corrected here, so the tool result and dispatch agree.
    expect(mockOrgDb.updateOrg).toHaveBeenCalledWith('org-a', { hotLeadCallBilling: expect.objectContaining({ itemId: 'si_existing', status: 'active' }) });
  });

  it.each([
    ['no Stripe subscription', () => mockUserDb.getUserById.mockResolvedValue({ userId: 'owner' }), /Subscribe to a plan first/],
    ['a trial subscription (always_invoice would charge nothing)', () => mockStripe.subscriptions.retrieve.mockResolvedValue(sub([baseItem], 'trialing')), /first payment/],
    ['a yearly subscription', () => mockStripe.subscriptions.retrieve.mockResolvedValue(sub([{ ...baseItem, price: { product: 'prod_plan', recurring: { interval: 'year' } } }])), /monthly subscription/],
    ['a subscription that is not active', () => mockStripe.subscriptions.retrieve.mockResolvedValue(sub([], 'canceled')), /Subscribe to a plan first/],
    ['a missing product id', () => { delete process.env.STRIPE_HOT_LEAD_CALL_PRODUCT_ID; }, /cannot be billed right now/],
    ['a Stripe error', () => mockStripe.subscriptionItems.create.mockRejectedValue(Object.assign(new Error('secret sk_live_abc detail'), { type: 'StripeCardError', code: 'card_declined' })), /Nothing was turned on/],
  ])('refuses cleanly with %s and leaks nothing', async (_name, arrange, message) => {
    arrange();
    const err = await addHotLeadCallBilling('org-a').then(() => null, e => e);
    expect(err).toBeInstanceOf(HotLeadCallBillingError);
    expect(err.message).toMatch(message);
    expect(err.message).not.toContain('sk_live');
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('sk_live');
  });
});

describe('mirrorHotLeadCallBilling (subscription webhook)', () => {
  const OWNER = { userId: 'owner', orgId: 'org-a' };
  const written = () => mockOrgDb.updateOrg.mock.calls[0]?.[1]?.hotLeadCallBilling;

  it.each([
    ['active', 'active'], ['trialing', 'active'], ['past_due', 'past_due'], ['unpaid', 'past_due'], ['canceled', 'canceled'],
  ])('writes the item with status %s -> %s', async (stripeStatus, expected) => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(sub([item()], stripeStatus));
    await mirrorHotLeadCallBilling(OWNER, sub([item()], stripeStatus) as never);
    expect(written()).toMatchObject({ itemId: 'si_hlc', status: expected });
    expect(Date.parse(written().updatedAt)).not.toBeNaN();
  });

  it('marks a vanished item canceled, but does not write for an org that never bought it', async () => {
    mockOrgDb.getOrgById.mockResolvedValue({ orgId: 'org-a', ownerUserId: 'owner', hotLeadCallBilling: { itemId: 'si_hlc', status: 'active', updatedAt: 'x' } });
    mockStripe.subscriptions.retrieve.mockResolvedValue(sub());
    await mirrorHotLeadCallBilling(OWNER, sub() as never);
    expect(written()).toMatchObject({ itemId: 'si_hlc', status: 'canceled' });
    mockOrgDb.updateOrg.mockClear();
    mockOrgDb.getOrgById.mockResolvedValue({ orgId: 'org-a', ownerUserId: 'owner' });
    await mirrorHotLeadCallBilling(OWNER, sub() as never);
    expect(mockOrgDb.updateOrg).not.toHaveBeenCalled();
  });

  it('decides from Stripe’s live state, so a stale event without the item cannot flip a paid add-on to canceled', async () => {
    mockOrgDb.getOrgById.mockResolvedValue({ orgId: 'org-a', ownerUserId: 'owner', hotLeadCallBilling: { itemId: 'si_hlc', status: 'active', updatedAt: 'x' } });
    mockStripe.subscriptions.retrieve.mockResolvedValue(sub([item()])); // live: the item is there
    await mirrorHotLeadCallBilling(OWNER, sub([]) as never);            // stale payload: it is not
    expect(mockOrgDb.updateOrg).not.toHaveBeenCalled();
  });

  it('falls back to the event payload when Stripe cannot be read', async () => {
    mockStripe.subscriptions.retrieve.mockRejectedValue(new Error('network'));
    await mirrorHotLeadCallBilling(OWNER, sub([item()], 'past_due') as never);
    expect(written()).toMatchObject({ itemId: 'si_hlc', status: 'past_due' });
  });

  it('skips a duplicate delivery, a non-owner and an unconfigured product', async () => {
    mockOrgDb.getOrgById.mockResolvedValue({ orgId: 'org-a', ownerUserId: 'owner', hotLeadCallBilling: { itemId: 'si_hlc', status: 'active', updatedAt: 'x' } });
    mockStripe.subscriptions.retrieve.mockResolvedValue(sub([item()]));
    await mirrorHotLeadCallBilling(OWNER, sub([item()]) as never);
    await mirrorHotLeadCallBilling({ userId: 'someone-else', orgId: 'org-a' }, sub([item()], 'past_due') as never);
    delete process.env.STRIPE_HOT_LEAD_CALL_PRODUCT_ID;
    await mirrorHotLeadCallBilling(OWNER, sub([item()], 'past_due') as never);
    expect(mockOrgDb.updateOrg).not.toHaveBeenCalled();
  });
});
