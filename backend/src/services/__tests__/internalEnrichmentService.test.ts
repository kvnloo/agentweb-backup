import {
  enrichContact,
  InternalEnrichmentCache,
  normaliseEnrichmentKey,
  EMPTY_ENRICHMENT,
  EnrichmentDeps,
  EnrichmentUserRecord,
  EnrichmentStripeSubscription,
} from '../internalEnrichmentService';

function makeDeps(overrides: Partial<EnrichmentDeps> = {}): EnrichmentDeps {
  return {
    getUserByEmail: async () => null,
    getStripeSubscriptionForCustomer: async () => null,
    ...overrides,
  };
}

describe('normaliseEnrichmentKey', () => {
  it('lowercases and trims', () => {
    expect(normaliseEnrichmentKey('  Jane@Acme.com ')).toBe('jane@acme.com');
  });

  it('handles null/undefined', () => {
    expect(normaliseEnrichmentKey(null)).toBe('');
    expect(normaliseEnrichmentKey(undefined)).toBe('');
  });
});

describe('enrichContact — no user', () => {
  it('returns isUser: false when user lookup fails', async () => {
    const deps = makeDeps({ getUserByEmail: async () => null });
    const result = await enrichContact('no-one@nowhere.com', deps);
    expect(result).toEqual(EMPTY_ENRICHMENT);
  });

  it('returns empty when email is blank', async () => {
    const deps = makeDeps({ getUserByEmail: async () => ({ stripe_customer_id: 'cus_x' } as any) });
    const result = await enrichContact('', deps);
    expect(result).toEqual(EMPTY_ENRICHMENT);
  });
});

describe('enrichContact — user without stripe_customer_id', () => {
  it('returns base user data with stripeStatus: null', async () => {
    const user: EnrichmentUserRecord = {
      userId: 'u1',
      email: 'jane@acme.com',
      subscriptionType: 'free',
      signupDate: '2026-01-01T00:00:00Z',
    };
    const deps = makeDeps({ getUserByEmail: async () => user });
    const result = await enrichContact('jane@acme.com', deps);

    expect(result.isUser).toBe(true);
    expect(result.signupDate).toBe('2026-01-01T00:00:00Z');
    expect(result.subscriptionType).toBe('free');
    expect(result.stripeStatus).toBe(null);
    expect(result.stripeCustomerId).toBe(null);
    expect(result.mrr).toBe(0);
  });

  it('falls back to createdAt when signupDate is missing', async () => {
    const user: EnrichmentUserRecord = {
      userId: 'u1',
      createdAt: '2026-02-02T00:00:00Z',
    };
    const deps = makeDeps({ getUserByEmail: async () => user });
    const result = await enrichContact('jane@acme.com', deps);
    expect(result.signupDate).toBe('2026-02-02T00:00:00Z');
  });
});

describe('enrichContact — user with stripe data', () => {
  const user: EnrichmentUserRecord = {
    userId: 'u1',
    email: 'jane@acme.com',
    subscriptionType: 'free',
    subscription_status: null,
    stripe_customer_id: 'cus_123',
  };

  const sub: EnrichmentStripeSubscription = {
    id: 'sub_1',
    status: 'active',
    currentPeriodEnd: '2026-05-01T00:00:00Z',
    mrrCents: 4900,
    subscriptionType: 'pro',
  };

  it('overrides stripeStatus/mrr/currentPeriodEnd/subscriptionType from Stripe', async () => {
    const deps = makeDeps({
      getUserByEmail: async () => user,
      getStripeSubscriptionForCustomer: async () => sub,
    });
    const result = await enrichContact('jane@acme.com', deps);

    expect(result.isUser).toBe(true);
    expect(result.stripeStatus).toBe('active');
    expect(result.mrr).toBe(49);
    expect(result.currentPeriodEnd).toBe('2026-05-01T00:00:00Z');
    expect(result.subscriptionType).toBe('pro');
    expect(result.stripeCustomerId).toBe('cus_123');
  });

  it('returns base data when Stripe returns null subscription', async () => {
    const deps = makeDeps({
      getUserByEmail: async () => user,
      getStripeSubscriptionForCustomer: async () => null,
    });
    const result = await enrichContact('jane@acme.com', deps);
    expect(result.mrr).toBe(0);
    expect(result.stripeCustomerId).toBe('cus_123');
  });

  it('swallows Stripe errors and returns base user data', async () => {
    const deps = makeDeps({
      getUserByEmail: async () => user,
      getStripeSubscriptionForCustomer: async () => {
        throw new Error('stripe down');
      },
    });
    const result = await enrichContact('jane@acme.com', deps);
    expect(result.isUser).toBe(true);
    expect(result.stripeCustomerId).toBe('cus_123');
    expect(result.mrr).toBe(0);
  });
});

describe('InternalEnrichmentCache', () => {
  it('stores and retrieves values within TTL', () => {
    const now = { t: 1_000_000 };
    const cache = new InternalEnrichmentCache(1000, () => now.t);
    cache.set('a@b.com', { ...EMPTY_ENRICHMENT, isUser: true });
    expect(cache.get('a@b.com')?.isUser).toBe(true);
  });

  it('expires entries after TTL', () => {
    const now = { t: 1_000_000 };
    const cache = new InternalEnrichmentCache(1000, () => now.t);
    cache.set('a@b.com', { ...EMPTY_ENRICHMENT, isUser: true });
    now.t += 1001;
    expect(cache.get('a@b.com')).toBe(null);
    expect(cache.size()).toBe(0);
  });

  it('clear() resets the store', () => {
    const cache = new InternalEnrichmentCache();
    cache.set('a@b.com', EMPTY_ENRICHMENT);
    cache.set('b@c.com', EMPTY_ENRICHMENT);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

describe('enrichContact — cache integration', () => {
  it('cache hit short-circuits both DB and Stripe calls', async () => {
    const getUserByEmail = jest.fn(async () => null);
    const getStripeSubscriptionForCustomer = jest.fn(async () => null);
    const deps = { getUserByEmail, getStripeSubscriptionForCustomer };
    const cache = new InternalEnrichmentCache();

    await enrichContact('miss@x.com', deps, cache);
    expect(getUserByEmail).toHaveBeenCalledTimes(1);

    await enrichContact('miss@x.com', deps, cache);
    expect(getUserByEmail).toHaveBeenCalledTimes(1);
  });

  it('different emails do not collide in cache', async () => {
    const deps = makeDeps({
      getUserByEmail: async (e: string) => (e === 'a@x.com' ? ({ userId: 'u1' } as any) : null),
    });
    const cache = new InternalEnrichmentCache();
    const r1 = await enrichContact('a@x.com', deps, cache);
    const r2 = await enrichContact('b@x.com', deps, cache);
    expect(r1.isUser).toBe(true);
    expect(r2.isUser).toBe(false);
  });

  it('is case-insensitive on the lookup key', async () => {
    const getUserByEmail = jest.fn(async () => ({ userId: 'u1' } as any));
    const deps = { getUserByEmail, getStripeSubscriptionForCustomer: async () => null };
    const cache = new InternalEnrichmentCache();
    await enrichContact('Jane@Acme.com', deps, cache);
    await enrichContact('jane@acme.com', deps, cache);
    expect(getUserByEmail).toHaveBeenCalledTimes(1);
    expect(getUserByEmail).toHaveBeenCalledWith('jane@acme.com');
  });
});
