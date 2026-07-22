/**
 * Stripe API twin suite (ENG-401 · Phase 1 of the Arga integration, OPS-8).
 *
 * OPT-IN, NEVER A REQUIRED CHECK. Excluded from the default Jest run via
 * `testPathIgnorePatterns` (jest.config.js). Run explicitly:
 *
 *     npm run test:twins -- --testPathPattern=stripe
 *
 * REUSABLE-TWIN PATTERN (ENG-402): this suite no longer provisions a fresh twin
 * per run. It reads the coordinates of a persistent twin from `.env.twins.json`
 * (created once by `npm run test:twins:setup`) and points the real Stripe SDK at
 * it THROUGH our production seam (`createStripeClient` honoring `STRIPE_API_BASE`).
 * State is reset to baseline before each test for isolation. When no reusable
 * twin is configured, the whole suite SKIPS with a clear message — a dev without
 * a twin is never blocked, and this never gates a merge.
 *
 * Why twins and not `jest.mock('stripe')`: every assertion here depends on
 * STATE the twin actually keeps (a subscription that stays canceled across
 * calls) or on REAL response/event/error SHAPES the twin returns. A hand
 * mock can only return what its author already believed — which is exactly
 * how wrong-shape assumptions get frozen into the suite.
 */
import Stripe from 'stripe';
import { createStripeClient } from '../../services/stripeClientFactory';
import { getTwin, resetTwinToBaseline, resolveTwinSession } from './twinSession';

// Reusable twin (from `.env.twins.json`). SKIPS cleanly when none is configured —
// never red, never a gate.
const { config: twinConfig, skipReason } = resolveTwinSession('stripe');
const describeTwin = skipReason ? describe.skip : describe;
if (skipReason) {
  // eslint-disable-next-line no-console
  console.warn(
    `[stripe.twin] SKIPPED — ${skipReason}. This suite is opt-in and never gates a merge.`,
  );
}

describeTwin('Stripe twin — real API behavior our jest.mock cannot express', () => {
  let stripe: Stripe;
  const savedBase = process.env.STRIPE_API_BASE;

  beforeAll(() => {
    const twin = getTwin('stripe');
    if (!twin) throw new Error('stripe twin missing from .env.twins.json despite non-skip resolution');
    // Drive the SDK through OUR production seam — this is the code under test.
    process.env.STRIPE_API_BASE = twin.baseUrl;
    stripe = createStripeClient('sk_test_twin');
  });

  // Reset the reusable twin to its baseline seed state before each test so
  // state-mutating tests are isolated (best-effort: a failed reset warns, not crashes).
  beforeEach(() => {
    if (twinConfig) resetTwinToBaseline(twinConfig.runId);
  });

  afterAll(() => {
    if (savedBase === undefined) delete process.env.STRIPE_API_BASE;
    else process.env.STRIPE_API_BASE = savedBase;
  });

  it('keeps subscription state across calls: active → canceled persists', async () => {
    const customer = await stripe.customers.create({ email: 'lifecycle@twin.test' });
    const product = await stripe.products.create({ name: 'Twin Plan' });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: 2900,
      currency: 'usd',
      recurring: { interval: 'month' },
    });

    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
    });
    expect(sub.status).toBe('active');

    const canceled = await stripe.subscriptions.cancel(sub.id);
    expect(canceled.status).toBe('canceled');
    expect(canceled.canceled_at).toBeTruthy();

    // The point jest.mock can't make: re-reading returns the persisted state.
    const reread = await stripe.subscriptions.retrieve(sub.id);
    expect(reread.status).toBe('canceled');
  });

  it('returns the real resource_missing / 404 shape for an unknown customer', async () => {
    expect.assertions(3);
    try {
      await stripe.customers.retrieve('cus_DEFINITELYDOESNOTEXIST');
    } catch (err) {
      const e = err as Stripe.errors.StripeError;
      expect(e.type).toBe('StripeInvalidRequestError');
      expect(e.statusCode).toBe(404);
      expect(e.code).toBe('resource_missing');
    }
  });

  // NOTE: an event-payload assertion (customer.subscription.deleted) was
  // deliberately NOT included. The ENG-401 mock-fidelity audit found the twin's
  // event-payload fidelity is unreliable, and events.list is global twin state
  // (no server-side related-object filter to scope it per-test). Webhook/event
  // shape stays covered by pinned jest mocks, per the audit's recommendation.

  it('fails loudly with resource_missing when the target does not exist', async () => {
    // Subscribing a non-existent customer must throw resource_missing, not
    // return a degraded/empty success — enforces the no-silent-fallback rule.
    // (Resource lookups are in the twin's faithful set; param validation is
    // not, so this asserts the missing-resource path specifically.)
    expect.assertions(1);
    try {
      await stripe.subscriptions.create({
        customer: 'cus_DEFINITELYDOESNOTEXIST',
        items: [{ price: 'price_nonexistent' }],
      });
    } catch (err) {
      expect((err as Stripe.errors.StripeError).code).toBe('resource_missing');
    }
  });
});
