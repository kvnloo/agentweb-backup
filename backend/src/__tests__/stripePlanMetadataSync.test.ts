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
  Sandbox: { allowedPages: ['*'], allowedSkills: ['*'] },
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

process.env.STRIPE_EXTRA_SEAT_PRODUCT_ID = 'prod_seat';

import { handleSubscriptionDeleted, handleSubscriptionUpdated, reconcileStripeUser, resolveSubscriptionTypeForPrice } from '../services/stripeService';

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

  it('prefers price metadata, then product, and never subscription metadata', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // A stale subscription label must not override the billed price's label.
    await expect(
      resolveSubscriptionTypeForPrice({ id: 'price_c', metadata: { plan: 'Max' } }, { metadata: { plan: 'Starter' } }),
    ).resolves.toBe('Max');
    // Nor may it set the tier on its own (contract customer on unlabelled price).
    await expect(
      resolveSubscriptionTypeForPrice({ id: 'price_c', product: { metadata: {} } }, { metadata: { plan: 'Starter' } }),
    ).resolves.toBeNull();
    warn.mockRestore();
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

  it('never grants the administrator-only Sandbox tier from price or product metadata', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(resolveSubscriptionTypeForPrice({ id: 'price_c', metadata: { plan: 'Sandbox' } })).resolves.toBeNull();
      await expect(resolveSubscriptionTypeForPrice({ id: 'price_c', product: { metadata: { plan: 'Sandbox' } } })).resolves.toBeNull();
      expect(mockGetTierConfig).not.toHaveBeenCalledWith('Sandbox');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not log account-controlled metadata when the plan is unmappable', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await resolveSubscriptionTypeForPrice({ id: 'price_c', metadata: { plan: 'private@example.com' } });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private@example.com');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unmapped price price_c'));
    } finally {
      warn.mockRestore();
    }
  });

  it('does not log account-controlled metadata when tier lookup throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetTierConfig.mockRejectedValueOnce(new Error('lookup unavailable'));
    try {
      await resolveSubscriptionTypeForPrice({ id: 'price_c', metadata: { plan: 'private@example.com' } });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private@example.com');
    } finally {
      warn.mockRestore();
    }
  });

  it('retrieves an unexpanded product to read its plan label', async () => {
    mockStripe.products.retrieve.mockResolvedValueOnce({ id: 'prod_c', metadata: { plan: 'Max' } });
    await expect(resolveSubscriptionTypeForPrice({ id: 'price_c', product: 'prod_c' })).resolves.toBe('Max');
    expect(mockStripe.products.retrieve).toHaveBeenCalledWith('prod_c', {}, { timeout: 5000, maxNetworkRetries: 0 });
  });

  it('propagates a failed product lookup so the webhook can be retried', async () => {
    mockStripe.products.retrieve.mockRejectedValueOnce(new Error('stripe 500'));
    await expect(resolveSubscriptionTypeForPrice({ id: 'price_c', product: 'prod_c' })).rejects.toThrow('stripe 500');
  });

  it('rejects at a hard deadline when a product lookup hangs past the idle timeout', async () => {
    jest.useFakeTimers();
    try {
      mockStripe.products.retrieve.mockReturnValueOnce(new Promise(() => {}));
      const p = resolveSubscriptionTypeForPrice({ id: 'price_c', product: 'prod_c' });
      const assertion = expect(p).rejects.toThrow('exceeded 6000ms');
      await jest.advanceTimersByTimeAsync(6000);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('never grants Free from metadata on a billed price', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      resolveSubscriptionTypeForPrice({ id: 'price_c', metadata: { plan: 'Free' } }),
    ).resolves.toBeNull();
    warn.mockRestore();
  });

  it('returns null without metadata (no silent promotion)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(resolveSubscriptionTypeForPrice({ id: 'price_unknown' })).resolves.toBeNull();
    warn.mockRestore();
  });
});

describe('handleSubscriptionDeleted — surviving custom subscription', () => {
  it.each(['active', 'trialing'])('retries lookup failure without canceling a surviving %s subscription', async (status) => {
    const survivor = { ...makeSub({ id: 'price_custom', product: 'prod_failure' }), id: 'sub_survivor', status };
    mockStripe.subscriptions.list.mockImplementation(async (params: any) => ({ data: params.status === status ? [survivor] : [] }));
    mockStripe.products.retrieve.mockRejectedValueOnce(new Error('product unavailable'));
    await expect(handleSubscriptionDeleted({ ...makeSub({ id: 'price_starter_test' }), status: 'canceled' })).rejects.toThrow('product unavailable');
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('does not swallow a write failure after finding a surviving subscription', async () => {
    mockStripe.subscriptions.list.mockResolvedValue({ data: [makeSub({ id: 'price_max', metadata: { plan: 'Max' } })] });
    mockUpdateUser.mockRejectedValueOnce(new Error('write unavailable'));
    await expect(handleSubscriptionDeleted(makeSub({ id: 'price_starter_test' }))).rejects.toThrow('write unavailable');
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser.mock.calls[0][1].subscriptionType).toBe('Max');
  });
});

describe('handleSubscriptionDeleted — surviving subscription races and seat items', () => {
  const NOT_ENDED = 'NOT (#storedStatus IN (:endedCanceled, :endedExpired))';

  it('makes the survivor write conditional on the stored status not having ended, and retries when refused', async () => {
    mockStripe.subscriptions.list.mockResolvedValue({ data: [makeSub({ id: 'price_max', metadata: { plan: 'Max' } })] });
    // The survivor was itself canceled while its tier was being resolved.
    mockUpdateUser.mockRejectedValueOnce(Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' }));
    await expect(handleSubscriptionDeleted(makeSub({ id: 'price_starter_test' }))).rejects.toThrow('The conditional request failed');
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser.mock.calls[0][2]?.condition?.expression).toContain(NOT_ENDED);
    const { syncUserUpdateToLeadList } = jest.requireMock('../services/crmAutoSyncService');
    expect(syncUserUpdateToLeadList).not.toHaveBeenCalled();
  });

  it('still repairs a row already stored as canceled when Stripe has a live survivor', async () => {
    mockScanWithFilter.mockResolvedValue([
      { userId: 'u1', email: 'p@example.com', stripe_customer_id: 'cus_x', subscriptionType: 'Free', subscription_status: 'canceled' },
    ]);
    mockStripe.subscriptions.list.mockResolvedValue({ data: [makeSub({ id: 'price_max', metadata: { plan: 'Max' } })] });
    await handleSubscriptionDeleted(makeSub({ id: 'price_starter_test' }));
    expect(mockUpdateUser.mock.calls[0][1].subscriptionType).toBe('Max');
    expect(mockUpdateUser.mock.calls[0][2]).toBeUndefined();
  });

  it('reads the tier from the base plan when an extra-seat item sorts first', async () => {
    const survivor = makeSub({ id: 'price_max', metadata: { plan: 'Max' } });
    survivor.items.data = [
      { id: 'si_seat', price: { id: 'price_seat', product: 'prod_seat' } },
      { id: 'si_plan', price: { id: 'price_max', metadata: { plan: 'Max' } } },
    ] as any;
    mockStripe.subscriptions.list.mockResolvedValue({ data: [survivor] });
    await handleSubscriptionDeleted(makeSub({ id: 'price_starter_test' }));
    expect(mockUpdateUser.mock.calls[0][1].subscriptionType).toBe('Max');
    expect(mockStripe.products.retrieve).not.toHaveBeenCalled();
  });
});

describe('reconcileStripeUser — Max/custom price', () => {
  const user = { userId: 'u1', email: 'p@example.com', stripe_customer_id: 'cus_x', subscriptionType: 'Free', subscription_status: 'canceled' };

  it('does not grant a metadata tier from a canceled subscription', async () => {
    mockStripe.subscriptions.list.mockResolvedValue({
      data: [{ ...makeSub({ id: 'price_max', metadata: { plan: 'Max' } }), status: 'canceled' }],
    });
    const updates = await reconcileStripeUser({ ...user });
    expect(updates?.subscriptionType).toBeUndefined();
    expect(updates?.allowedPages).toBeUndefined();
  });

  it('syncs a metadata tier from a live subscription', async () => {
    mockStripe.subscriptions.list.mockResolvedValue({ data: [makeSub({ id: 'price_max', metadata: { plan: 'Max' } })] });
    const updates = await reconcileStripeUser({ ...user });
    expect(updates?.subscriptionType).toBe('Max');
    expect(updates?.subscription_status).toBe('active');
  });

  it('reads the tier from the base plan when an extra-seat item sorts first', async () => {
    const sub = makeSub({ id: 'price_max', metadata: { plan: 'Max' } });
    sub.items.data = [
      { id: 'si_seat', price: { id: 'price_seat', product: 'prod_seat' } },
      { id: 'si_plan', price: { id: 'price_max', metadata: { plan: 'Max' } } },
    ] as any;
    mockStripe.subscriptions.list.mockResolvedValue({ data: [sub] });
    const updates = await reconcileStripeUser({ ...user });
    expect(updates?.subscriptionType).toBe('Max');
  });
});

describe('handleSubscriptionUpdated — Max/custom price', () => {
  it('does not grant a metadata tier from an event whose own status has ended', async () => {
    await handleSubscriptionUpdated({ ...makeSub({ id: 'price_max_custom', metadata: { plan: 'Max' } }), status: 'canceled' });
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser.mock.calls[0][1].subscriptionType).toBeUndefined();
  });

  it('keeps the env-mapped tier sync for an ended event, as on main', async () => {
    await handleSubscriptionUpdated({ ...makeSub({ id: 'price_complete_test' }), status: 'canceled' });
    expect(mockUpdateUser.mock.calls[1][1].subscriptionType).toBeDefined();
  });

  it('syncs subscriptionType and tier config from price metadata.plan', async () => {
    await handleSubscriptionUpdated(makeSub({ id: 'price_max_custom', metadata: { plan: 'Max' } }));
    const updates = Object.assign({}, ...mockUpdateUser.mock.calls.map((c: any[]) => c[1]));
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

  it('persists status and renewal before a failing product lookup, then errors for retry', async () => {
    mockStripe.products.retrieve.mockRejectedValueOnce(new Error('stripe timeout'));
    await expect(handleSubscriptionUpdated(makeSub({ id: 'price_custom', product: 'prod_slow' }))).rejects.toThrow('stripe timeout');
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    const updates = mockUpdateUser.mock.calls[0][1];
    expect(updates.subscription_status).toBe('active');
    expect(updates.current_period_end).toBeDefined();
    expect(updates.subscriptionType).toBeUndefined();
  });

  it('does not keep a paid tier when a cancellation landed during the product lookup', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockStripe.products.retrieve.mockResolvedValueOnce({ id: 'prod_max', metadata: { plan: 'Max' } });
    // The stored row was canceled while the lookup ran: DynamoDB refuses the conditional tier write.
    mockUpdateUser
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' }));
    await expect(handleSubscriptionUpdated(makeSub({ id: 'price_custom', product: 'prod_max' }))).resolves.toBeUndefined();
    expect(mockUpdateUser).toHaveBeenCalledTimes(2);
    const [, tierWrite, options] = mockUpdateUser.mock.calls[1];
    expect(tierWrite.subscriptionType).toBe('Max');
    expect(options.condition.expression).toContain('NOT (#storedStatus IN (:endedCanceled, :endedExpired))');
    expect(options.condition.names).toEqual({ '#storedStatus': 'subscription_status' });
    expect(options.condition.values).toEqual({ ':endedCanceled': 'canceled', ':endedExpired': 'incomplete_expired' });
    const { syncUserUpdateToLeadList } = jest.requireMock('../services/crmAutoSyncService');
    expect(syncUserUpdateToLeadList).toHaveBeenCalledWith('p@example.com', { subscriptionType: undefined, subscription_status: undefined });
    warn.mockRestore();
  });

  it('guards every tier write for a live event, and the first status write stays unconditional', async () => {
    await handleSubscriptionUpdated(makeSub({ id: 'price_max_custom', metadata: { plan: 'Max' } }));
    expect(mockUpdateUser.mock.calls[0][2]).toBeUndefined();
    expect(mockUpdateUser.mock.calls[1][2]?.condition).toBeDefined();
  });

  it('errors for retry when the tier write fails for any other reason', async () => {
    mockUpdateUser.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('write unavailable'));
    await expect(
      handleSubscriptionUpdated(makeSub({ id: 'price_max_custom', metadata: { plan: 'Max' } })),
    ).rejects.toThrow('write unavailable');
  });
});
