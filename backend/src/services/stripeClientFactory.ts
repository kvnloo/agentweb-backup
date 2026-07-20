import Stripe from 'stripe';

/**
 * The single Stripe API version used across the backend. Defined once here so
 * every client is pinned identically; bump it in one place.
 */
export const STRIPE_API_VERSION = '2025-05-28.basil';

/**
 * Central factory for every Stripe SDK client in the backend.
 *
 * Two jobs:
 *  1. Pin the API version in one place (previously duplicated across 6 sites).
 *  2. Honor the `STRIPE_API_BASE` test seam uniformly.
 *
 * `STRIPE_API_BASE`, when set, redirects SDK traffic to a mock host (an Arga
 * Stripe twin or a local fake) by overriding the SDK's host/port/protocol.
 * It is a TEST-ONLY seam: with it unset the client is byte-for-byte identical
 * to the previous inline construction (real Stripe, `api.stripe.com`).
 *
 * Setting it in production is a HARD BOOT ERROR — we must never silently send
 * live billing traffic to a non-Stripe host (fail loud, never reroute).
 *
 * @param key       the Stripe secret key
 * @param extraOpts extra SDK config merged in (e.g. `stripeAccount` for Connect)
 */
export function createStripeClient(
  key: string,
  extraOpts: Stripe.StripeConfig = {}
): Stripe {
  const config: Stripe.StripeConfig = {
    apiVersion: STRIPE_API_VERSION as any,
    ...extraOpts,
  };

  const base = process.env.STRIPE_API_BASE;
  if (base) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'STRIPE_API_BASE is set in production. It is a test-only seam for ' +
          'pointing the Stripe SDK at a mock/twin; refusing to boot rather ' +
          'than risk sending live billing traffic to a non-Stripe host.'
      );
    }
    // Throws on a malformed URL — a misconfigured seam should fail loudly.
    const url = new URL(base);
    config.host = url.hostname;
    config.protocol = url.protocol.replace(':', '') as 'https' | 'http';
    if (url.port) config.port = Number(url.port);
  }

  return new Stripe(key, config);
}
