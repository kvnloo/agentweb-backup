/**
 * ENG-2724: a subscription moved to a price outside the Starter/Pro env
 * mapping (Max, custom contract prices) must sync its tier from `plan`
 * metadata — validated against subscription_types — instead of silently
 * keeping the old tier.
 */

const mockStripe = {
  subscriptions: { retrieve: jest.fn(), list: jest.fn() },
  customers: { retrieve: jest.fn().mockResolvedValue({ deleted: false, invoice_settings: {} }) },
  paymentMethods: { list: jest.fn().mockResolvedValue({ data: [{ id: 'pm_test' }] }) },
  invoices: { list: jest.fn() },
  prices: { retrieve: jest.fn() },
  products: { retrieve: jest.fn() },
};

jest.mock('stripe', () => jest.fn().mockImplementation(() => mockStripe));

const mockUpdateUser = jest.fn().mockResolvedValue(undefined);
const mockScanWithFilter = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
    updateUser: mockUpdateUser,
    scanWithFilter: mockScanWithFilter,
  },
}));

const KNOWN_TIERS: Record<string, any> = {
  Starter: { allowedPages: ['starter'], allowedSkills: [] },
  Pro: { allowedPages: ['pro'], allowedSkills: [] },
  Max: { allowedPages: ['max'], allowedSkills: ['*'] },
  'Super Premium': { allowedPages: ['*'], allowedSkills: ['*'] },
  Free: { allowedPages: ['/'], allowedSkills: [] },
};
const mockGetTierConfig = jest.fn(async (name: string) => KNOWN_TIERS[name] ?? null);

jest.mock('../services/subscriptionService', () => ({
  getTierConfig: (name: string) => mockGetTierConfig(name),
  DEFAULT_PAGES: ['/'],
}));

jest.mock('../services/paymentHistoryDb', () => ({
  paymentHistoryDb: { record: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../services/crmAutoSyncService', () => ({
  syncUserUpdateToLeadList: jest.fn(),
}));

process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
process.env.STRIPE_STARTER_PRICE_ID = 'price_starter_test';
process.env.STRIPE_COMPLETE_PRICE_ID = 'price_complete_test';

import { handleSubscriptionUpdated, resolveSubscriptionTypeForPrice } from '../services/stripeService';

function makeSub(price: any, metadata: Record<string, string> = {}) {
  return {
    id: 'sub_x',
    status: 'active',
    customer: 'cus_x',
    cancel_at_period_end: false,
    current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
    default_payment_method: 'pm_test',
    metadata,
    items: { data: [{ price }] },
    discount: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockScanWithFilter.mockResolvedValue([
    { userId: 'u1', email: 'p@example.com', stripe_customer_id: 'cus_x', subscriptionType: 'Pro' },
  ]);
});

describe('resolveSubscriptionTypeForPrice', () => {
  it('keeps the env mapping for Starter/Pro prices', async () => {
    await expect(resolveSubscriptionTypeForPrice({ id: 'price_starter_test' })).resolves.toBe('Starter');
    await expect(resolveSubscriptionTypeForPrice({ id: 'price_complete_test', metadata: { plan: 'Max' } })).resolves.toBe('Pro');
  });

  it('falls back to price metadata.plan when it names a defined tier', async () => {
    await expect(resolveSubscriptionTypeForPrice({ id: 'price_max', metadata: { plan: 'Max' } })).resolves.toBe('Max');
  });

  it('prefers price metadata, then product, then subscription metadata', async () => {
    // A stale subscription label must not override the billed price's label.
    await expect(
      resolveSubscriptionTypeForPrice({ id: 'price_c', metadata: { plan: 'Max' } }, { metadata: { plan: 'Starter' } }),
    ).resolves.toBe('Max');
    await expect(
      resolveSubscriptionTypeForPrice({ id: 'price_c' }, { metadata: { plan: 'Max' } }),
    ).resolves.toBe('Max');
    await expect(
      resolveSubscriptionTypeForPrice({ id: 'price_c', product: { metadata: { plan: 'Max' } } }),
    ).resolves.toBe('Max');
  });

  it('rejects metadata that names an undefined tier and warns', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(resolveSubscriptionTypeForPrice({ id: 'price_c', metadata: { plan: 'Ultra' } })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unmapped price price_c'));
    warn.mockRestore();
  });

  it('never grants the internal Super Premium tier from metadata', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      resolveSubscriptionTypeForPrice({ id: 'price_c', metadata: { plan: 'Super Premium' } }),
    ).resolves.toBeNull();
    warn.mockRestore();
  });

  it('retrieves an unexpanded product to read its plan label', async () => {
    mockStripe.products.retrieve.mockResolvedValueOnce({ id: 'prod_c', metadata: { plan: 'Max' } });
    await expect(resolveSubscriptionTypeForPrice({ id: 'price_c', product: 'prod_c' })).resolves.toBe('Max');
    expect(mockStripe.products.retrieve).toHaveBeenCalledWith('prod_c');
  });

  it('never grants Free from metadata on a billed price', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      resolveSubscriptionTypeForPrice({ id: 'price_c' }, { metadata: { plan: 'Free' } }),
    ).resolves.toBeNull();
    warn.mockRestore();
  });

  it('returns null without metadata (no silent promotion)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(resolveSubscriptionTypeForPrice({ id: 'price_unknown' })).resolves.toBeNull();
    warn.mockRestore();
  });
});

describe('handleSubscriptionUpdated — Max/custom price', () => {
  it('syncs subscriptionType and tier config from price metadata.plan', async () => {
    await handleSubscriptionUpdated(makeSub({ id: 'price_max_custom', metadata: { plan: 'Max' } }));
    const updates = mockUpdateUser.mock.calls[0][1];
    expect(updates.subscriptionType).toBe('Max');
    expect(updates.allowedPages).toEqual(['max']);
  });

  it('leaves the existing tier untouched for an unmappable price', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await handleSubscriptionUpdated(makeSub({ id: 'price_mystery' }));
    const updates = mockUpdateUser.mock.calls[0]?.[1] ?? {};
    expect(updates.subscriptionType).toBeUndefined();
    warn.mockRestore();
  });
});
