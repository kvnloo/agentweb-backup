/**
 * Seed Stripe test mode with sample subscriptions for revenue dashboard testing.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_... npx ts-node backend/scripts/seed-stripe-test-data.ts
 *
 * Creates:
 * - 2 products (Basic, Pro) with monthly prices
 * - 10 test customers with various subscription states
 * - Mix of: active, canceled (churned), trialing, past_due
 * - Spread across different months for cohort testing
 */
import Stripe from 'stripe';

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_KEY || !STRIPE_KEY.startsWith('sk_test_')) {
  console.error('ERROR: Set STRIPE_SECRET_KEY to a test key (sk_test_...)');
  console.error('Usage: STRIPE_SECRET_KEY=sk_test_... npx ts-node backend/scripts/seed-stripe-test-data.ts');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_KEY, { apiVersion: '2025-05-28.basil' as any });

interface TestCustomer {
  name: string;
  email: string;
  plan: 'basic' | 'pro';
  status: 'active' | 'canceled' | 'trialing';
  createdMonthsAgo: number;
  canceledMonthsAgo?: number;
}

const TEST_CUSTOMERS: TestCustomer[] = [
  // Active customers (various cohorts)
  { name: 'Alice Active', email: 'alice@test-agentweb.com', plan: 'pro', status: 'active', createdMonthsAgo: 5 },
  { name: 'Bob Builder', email: 'bob@test-agentweb.com', plan: 'pro', status: 'active', createdMonthsAgo: 4 },
  { name: 'Carol Client', email: 'carol@test-agentweb.com', plan: 'basic', status: 'active', createdMonthsAgo: 3 },
  { name: 'Dave Diligent', email: 'dave@test-agentweb.com', plan: 'pro', status: 'active', createdMonthsAgo: 2 },
  { name: 'Eve Early', email: 'eve@test-agentweb.com', plan: 'basic', status: 'active', createdMonthsAgo: 1 },
  { name: 'Frank Fresh', email: 'frank@test-agentweb.com', plan: 'pro', status: 'active', createdMonthsAgo: 0 },

  // Churned customers
  { name: 'Gary Gone', email: 'gary@test-agentweb.com', plan: 'basic', status: 'canceled', createdMonthsAgo: 4, canceledMonthsAgo: 2 },
  { name: 'Helen Halted', email: 'helen@test-agentweb.com', plan: 'pro', status: 'canceled', createdMonthsAgo: 3, canceledMonthsAgo: 1 },

  // Trial users
  { name: 'Ian Interested', email: 'ian@test-agentweb.com', plan: 'pro', status: 'trialing', createdMonthsAgo: 0 },
  { name: 'Jane Joining', email: 'jane@test-agentweb.com', plan: 'basic', status: 'trialing', createdMonthsAgo: 0 },
];

async function getOrCreateProducts() {
  // Check for existing test products first
  const existing = await stripe.products.list({ limit: 100 });
  let basicProduct = existing.data.find(p => p.name === 'AgentWeb Basic (Test)');
  let proProduct = existing.data.find(p => p.name === 'AgentWeb Pro (Test)');

  if (!basicProduct) {
    basicProduct = await stripe.products.create({
      name: 'AgentWeb Basic (Test)',
      description: 'Basic plan for testing revenue dashboard',
    });
    console.log(`Created product: ${basicProduct.name} (${basicProduct.id})`);
  }

  if (!proProduct) {
    proProduct = await stripe.products.create({
      name: 'AgentWeb Pro (Test)',
      description: 'Pro plan for testing revenue dashboard',
    });
    console.log(`Created product: ${proProduct.name} (${proProduct.id})`);
  }

  // Get or create prices
  const prices = await stripe.prices.list({ limit: 100 });
  let basicPrice = prices.data.find(p => p.product === basicProduct!.id && p.unit_amount === 4900);
  let proPrice = prices.data.find(p => p.product === proProduct!.id && p.unit_amount === 14900);

  if (!basicPrice) {
    basicPrice = await stripe.prices.create({
      product: basicProduct.id,
      unit_amount: 4900, // $49/mo
      currency: 'usd',
      recurring: { interval: 'month' },
    });
    console.log(`Created price: Basic $49/mo (${basicPrice.id})`);
  }

  if (!proPrice) {
    proPrice = await stripe.prices.create({
      product: proProduct.id,
      unit_amount: 14900, // $149/mo
      currency: 'usd',
      recurring: { interval: 'month' },
    });
    console.log(`Created price: Pro $149/mo (${proPrice.id})`);
  }

  return { basicPrice, proPrice };
}

function monthsAgoTimestamp(months: number): number {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  d.setDate(5); // 5th of the month to avoid edge cases
  return Math.floor(d.getTime() / 1000);
}

async function seedCustomer(tc: TestCustomer, basicPriceId: string, proPriceId: string) {
  // Check if customer already exists
  const existing = await stripe.customers.list({ email: tc.email, limit: 1 });
  if (existing.data.length > 0) {
    console.log(`  Skipping ${tc.name} (${tc.email}) — already exists`);
    return;
  }

  const customer = await stripe.customers.create({
    name: tc.name,
    email: tc.email,
    metadata: { source: 'revenue-dashboard-test' },
  });

  // Attach a test payment method
  const pm = await stripe.paymentMethods.create({
    type: 'card',
    card: { token: 'tok_visa' },
  });
  await stripe.paymentMethods.attach(pm.id, { customer: customer.id });
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: pm.id },
  });

  const priceId = tc.plan === 'basic' ? basicPriceId : proPriceId;

  if (tc.status === 'trialing') {
    await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      trial_period_days: 14,
    });
    console.log(`  Created ${tc.name}: ${tc.plan} (trialing)`);
  } else {
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      backdate_start_date: monthsAgoTimestamp(tc.createdMonthsAgo),
    });

    if (tc.status === 'canceled' && tc.canceledMonthsAgo !== undefined) {
      await stripe.subscriptions.cancel(sub.id);
      console.log(`  Created ${tc.name}: ${tc.plan} (canceled, was active ${tc.createdMonthsAgo}mo, churned ${tc.canceledMonthsAgo}mo ago)`);
    } else {
      console.log(`  Created ${tc.name}: ${tc.plan} (active, started ${tc.createdMonthsAgo}mo ago)`);
    }
  }
}

async function main() {
  console.log('Seeding Stripe test data for revenue dashboard...\n');

  const { basicPrice, proPrice } = await getOrCreateProducts();
  console.log(`\nBasic price: $${(basicPrice.unit_amount! / 100).toFixed(0)}/mo (${basicPrice.id})`);
  console.log(`Pro price: $${(proPrice.unit_amount! / 100).toFixed(0)}/mo (${proPrice.id})\n`);

  console.log('Creating test customers:');
  for (const tc of TEST_CUSTOMERS) {
    try {
      await seedCustomer(tc, basicPrice.id, proPrice.id);
    } catch (err: any) {
      console.error(`  ERROR creating ${tc.name}: ${err.message}`);
    }
  }

  console.log('\nDone! Expected revenue dashboard results:');
  console.log('  Active paying: 6 ($49*2 + $149*4 = $694 MRR)');
  console.log('  Trialing: 2');
  console.log('  Churned: 2');
  console.log('  Cohorts: 6 months of data');
  console.log('\nRun the backend and navigate to Admin Dashboard → Revenue tab to verify.');
}

main().catch(console.error);
