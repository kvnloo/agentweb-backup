/**
 * Internal Enrichment Service (D1)
 *
 * Joins AW-Users + Stripe data for a single Contact at read time. No migration,
 * no denormalisation — the join happens per-request and is cached per contactId
 * for 1 hour.
 */

export interface EnrichmentResult {
  isUser: boolean;
  signupDate: string | null;
  subscriptionType: 'free' | 'pro' | string | null;
  stripeStatus: 'active' | 'trialing' | 'past_due' | 'canceled' | string | null;
  mrr: number;
  currentPeriodEnd: string | null;
  stripeCustomerId: string | null;
}

export const EMPTY_ENRICHMENT: EnrichmentResult = {
  isUser: false,
  signupDate: null,
  subscriptionType: null,
  stripeStatus: null,
  mrr: 0,
  currentPeriodEnd: null,
  stripeCustomerId: null,
};

export interface EnrichmentUserRecord {
  userId?: string;
  email?: string;
  subscriptionType?: string | null;
  subscription_status?: string | null;
  current_period_end?: string | null;
  stripe_customer_id?: string | null;
  createdAt?: string | null;
  signupDate?: string | null;
}

export interface EnrichmentStripeSubscription {
  id: string;
  status: string;
  currentPeriodEnd: string | null;
  mrrCents: number;
  priceId?: string;
  subscriptionType?: string;
}

export interface EnrichmentDeps {
  getUserByEmail: (email: string) => Promise<EnrichmentUserRecord | null>;
  getStripeSubscriptionForCustomer: (
    stripeCustomerId: string
  ) => Promise<EnrichmentStripeSubscription | null>;
  now?: () => number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  value: EnrichmentResult;
  expiresAt: number;
}

export class InternalEnrichmentCache {
  private store = new Map<string, CacheEntry>();
  constructor(private ttlMs: number = DEFAULT_TTL_MS, private nowFn: () => number = () => Date.now()) {}

  get(key: string): EnrichmentResult | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < this.nowFn()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: EnrichmentResult): void {
    this.store.set(key, { value, expiresAt: this.nowFn() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

export function normaliseEnrichmentKey(email: string | null | undefined): string {
  return (email || '').trim().toLowerCase();
}

export async function enrichContact(
  email: string,
  deps: EnrichmentDeps,
  cache?: InternalEnrichmentCache
): Promise<EnrichmentResult> {
  const key = normaliseEnrichmentKey(email);
  if (!key) return { ...EMPTY_ENRICHMENT };

  if (cache) {
    const hit = cache.get(key);
    if (hit) return hit;
  }

  const user = await deps.getUserByEmail(key);
  if (!user) {
    const result = { ...EMPTY_ENRICHMENT };
    if (cache) cache.set(key, result);
    return result;
  }

  const base: EnrichmentResult = {
    isUser: true,
    signupDate: user.signupDate || user.createdAt || null,
    subscriptionType: (user.subscriptionType as any) || null,
    stripeStatus: (user.subscription_status as any) || null,
    mrr: 0,
    currentPeriodEnd: user.current_period_end || null,
    stripeCustomerId: user.stripe_customer_id || null,
  };

  if (!user.stripe_customer_id) {
    if (cache) cache.set(key, base);
    return base;
  }

  try {
    const sub = await deps.getStripeSubscriptionForCustomer(user.stripe_customer_id);
    if (sub) {
      base.stripeStatus = sub.status;
      base.currentPeriodEnd = sub.currentPeriodEnd;
      base.mrr = Math.round((sub.mrrCents || 0)) / 100;
      if (sub.subscriptionType) {
        base.subscriptionType = sub.subscriptionType;
      }
    }
  } catch (err) {
    console.warn('[enrichContact] Stripe lookup failed:', (err as any)?.message);
  }

  if (cache) cache.set(key, base);
  return base;
}

export const defaultEnrichmentCache = new InternalEnrichmentCache();
