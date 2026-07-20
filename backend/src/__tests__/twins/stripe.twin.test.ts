/**
 * Stripe API twin suite (ENG-401 · Phase 1 of the Arga integration, OPS-8).
 *
 * OPT-IN, NEVER A REQUIRED CHECK. Excluded from the default Jest run via
 * `testPathIgnorePatterns` (jest.config.js). Run explicitly:
 *
 *     npm run test:twins -- --testPathPattern=stripe
 *
 * It provisions a live Arga Stripe twin (needs `arga login` on the box) and
 * points the real Stripe SDK at it THROUGH our production seam
 * (`createStripeClient` honoring `STRIPE_API_BASE`). If the Arga CLI is not
 * authenticated/available, the whole suite SKIPS with a clear message — a dev
 * without Arga is never blocked, and this never gates a merge.
 *
 * Why twins and not `jest.mock('stripe')`: every assertion here depends on
 * STATE the twin actually keeps (a subscription that stays canceled across
 * calls) or on REAL response/event/error SHAPES the twin returns. A hand
 * mock can only return what its author already believed — which is exactly
 * how wrong-shape assumptions get frozen into the suite.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';
import Stripe from 'stripe';
import { createStripeClient } from '../../services/stripeClientFactory';

// ── Locate the Arga CLI and decide whether the suite can run ────────────────
function resolveArga(): string | null {
  const candidates = [
    'arga',
    path.join(process.env.HOME || '', '.local/bin/arga'),
  ];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['whoami'], { stdio: 'ignore' });
      return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}

const ARGA = resolveArga();
const describeTwin = ARGA ? describe : describe.skip;
if (!ARGA) {
  // eslint-disable-next-line no-console
  console.warn(
    '[stripe.twin] Arga CLI not authenticated (run `arga login`) — skipping twin suite.'
  );
}

interface TwinRun {
  runId: string;
  baseUrl: string;
}

function provisionStripeTwin(bin: string): TwinRun {
  const out = execFileSync(
    bin,
    ['previews', 'twins', 'provision', '--twins', 'stripe', '--ttl', '10', '--wait', '--timeout', '180', '--json'],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  const json = JSON.parse(out);
  const twin = json.twins?.stripe;
  if (json.status !== 'ready' || !twin?.base_url) {
    throw new Error(`Stripe twin not ready: ${out.slice(0, 500)}`);
  }
  return { runId: json.run_id, baseUrl: twin.base_url };
}

function teardownTwin(bin: string, runId: string): void {
  try {
    execFileSync(bin, ['previews', 'twins', 'teardown', runId], { stdio: 'ignore' });
  } catch {
    /* twin auto-expires on its 10-min TTL regardless */
  }
}

describeTwin('Stripe twin — real API behavior our jest.mock cannot express', () => {
  let twin: TwinRun;
  let stripe: Stripe;
  const savedBase = process.env.STRIPE_API_BASE;

  beforeAll(() => {
    twin = provisionStripeTwin(ARGA as string);
    // Drive the SDK through OUR production seam — this is the code under test.
    process.env.STRIPE_API_BASE = twin.baseUrl;
    stripe = createStripeClient('sk_test_twin');
  }, 200_000);

  afterAll(() => {
    if (twin) teardownTwin(ARGA as string, twin.runId);
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

  it('emits a customer.subscription.deleted event envelope on cancel', async () => {
    // SCOPE NOTE (per the ENG-401 mock-fidelity audit): the twin's *event
    // payload* fidelity is NOT reliable — it does not faithfully reproduce what
    // real Stripe puts in a webhook body, so deep reconciliation assertions
    // stay pinned to jest mocks. What the twin DOES reliably provide is the
    // event envelope: canceling a subscription produces a real
    // `customer.subscription.deleted` event whose data.object is a subscription.
    // That envelope check is all this asserts.
    const customer = await stripe.customers.create({ email: 'events@twin.test' });
    const product = await stripe.products.create({ name: 'Events Plan' });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: 1500,
      currency: 'usd',
      recurring: { interval: 'month' },
    });
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
    });
    await stripe.subscriptions.cancel(sub.id);

    const events = await stripe.events.list({ limit: 20 });
    const deletion = events.data.find(
      (e) => e.type === 'customer.subscription.deleted'
    );
    expect(deletion).toBeDefined();
    expect((deletion!.data.object as Stripe.Subscription).object).toBe('subscription');
  });

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
