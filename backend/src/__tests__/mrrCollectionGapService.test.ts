// --- Mocks ---

const mockStripe = {
  subscriptions: { list: jest.fn() },
  invoices: { list: jest.fn() },
};

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => mockStripe);
});

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';

import { detectMrrCollectionGaps } from '../services/mrrCollectionGapService';
import type Stripe from 'stripe';

function makeCustomer(overrides: Partial<Stripe.Customer> = {}): Stripe.Customer {
  return {
    id: overrides.id || 'cus_default',
    object: 'customer',
    email: overrides.email ?? 'someone@example.com',
    default_source: overrides.default_source ?? null,
    invoice_settings: overrides.invoice_settings ?? { default_payment_method: null },
    ...overrides,
  } as Stripe.Customer;
}

function makeSubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: overrides.id || 'sub_default',
    object: 'subscription',
    status: overrides.status || 'active',
    customer: overrides.customer || makeCustomer(),
    metadata: overrides.metadata || {},
    discounts: overrides.discounts || [],
    items: overrides.items || {
      object: 'list',
      data: [
        {
          price: {
            unit_amount: 49900,
            recurring: { interval: 'month' },
          },
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function mockSubscriptionPage(subs: Stripe.Subscription[]) {
  mockStripe.subscriptions.list.mockResolvedValueOnce({ data: subs, has_more: false });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('detectMrrCollectionGaps', () => {
  it('flags an active paid subscription whose customer has no payment method on file', async () => {
    const customer = makeCustomer({
      id: 'cus_storywithai',
      email: 'story@example.com',
      default_source: null,
      invoice_settings: { default_payment_method: null } as any,
    });
    mockSubscriptionPage([makeSubscription({ id: 'sub_1', customer })]);
    // no_payment_method short-circuits before the invoices.list call
    mockStripe.invoices.list.mockResolvedValue({ data: [] });

    const flags = await detectMrrCollectionGaps();

    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      customerId: 'cus_storywithai',
      subscriptionId: 'sub_1',
      reason: 'no_payment_method',
      contractedAmountCents: 49900,
      actualAmountCents: 0,
    });
  });

  it('flags a subscription whose customer has a payment method but zero successful charges ever', async () => {
    const customer = makeCustomer({
      id: 'cus_corgi',
      default_source: 'card_123',
    });
    mockSubscriptionPage([makeSubscription({ id: 'sub_2', customer })]);
    mockStripe.invoices.list.mockResolvedValueOnce({ data: [] }); // no paid invoices ever

    const flags = await detectMrrCollectionGaps();

    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      customerId: 'cus_corgi',
      subscriptionId: 'sub_2',
      reason: 'zero_successful_charges',
      actualAmountCents: 0,
    });
  });

  it('flags a subscription billing below its configured contracted price', async () => {
    const customer = makeCustomer({ id: 'cus_pmps', default_source: 'card_456' });
    mockSubscriptionPage([
      makeSubscription({
        id: 'sub_3',
        customer,
        metadata: { contractedPriceCents: '49900' },
        items: {
          object: 'list',
          data: [{ price: { unit_amount: 5000, recurring: { interval: 'month' } } }],
        } as any,
      }),
    ]);
    mockStripe.invoices.list.mockResolvedValueOnce({ data: [{ id: 'in_1', status: 'paid' }] });

    const flags = await detectMrrCollectionGaps();

    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      customerId: 'cus_pmps',
      subscriptionId: 'sub_3',
      reason: 'below_contracted_price',
      contractedAmountCents: 49900,
      actualAmountCents: 5000,
    });
  });

  it('does not flag a healthy account: payment method present, charges succeeding, billing at contracted price', async () => {
    const customer = makeCustomer({ id: 'cus_healthy', default_source: 'card_789' });
    mockSubscriptionPage([
      makeSubscription({
        id: 'sub_4',
        customer,
        metadata: { contractedPriceCents: '49900' },
      }),
    ]);
    mockStripe.invoices.list.mockResolvedValueOnce({ data: [{ id: 'in_2', status: 'paid' }] });

    const flags = await detectMrrCollectionGaps();

    expect(flags).toHaveLength(0);
  });

  it('skips the below-contracted-price check when no contractedPriceCents metadata is set (no ground truth to compare against)', async () => {
    const customer = makeCustomer({ id: 'cus_no_metadata', default_source: 'card_999' });
    mockSubscriptionPage([
      makeSubscription({
        id: 'sub_5',
        customer,
        metadata: {},
        items: {
          object: 'list',
          data: [{ price: { unit_amount: 5000, recurring: { interval: 'month' } } }],
        } as any,
      }),
    ]);
    mockStripe.invoices.list.mockResolvedValueOnce({ data: [{ id: 'in_3', status: 'paid' }] });

    const flags = await detectMrrCollectionGaps();

    expect(flags).toHaveLength(0);
  });

  it('does not flag no_payment_method or zero_successful_charges for a canceled subscription (not a live status)', async () => {
    const customer = makeCustomer({ id: 'cus_canceled', default_source: null });
    mockSubscriptionPage([
      makeSubscription({ id: 'sub_6', customer, status: 'canceled' }),
    ]);

    const flags = await detectMrrCollectionGaps();

    expect(flags).toHaveLength(0);
    expect(mockStripe.invoices.list).not.toHaveBeenCalled();
  });

  it('does not flag no_payment_method or zero_successful_charges for a trialing subscription with no charge due yet', async () => {
    const customer = makeCustomer({ id: 'cus_trial', default_source: null });
    mockSubscriptionPage([
      makeSubscription({ id: 'sub_trial', customer, status: 'trialing' }),
    ]);

    const flags = await detectMrrCollectionGaps();

    expect(flags).toHaveLength(0);
    expect(mockStripe.invoices.list).not.toHaveBeenCalled();
  });

  it('does not treat a subscription-level default payment method as no_payment_method even when the customer has no default', async () => {
    const customer = makeCustomer({
      id: 'cus_sub_level_pm',
      default_source: null,
      invoice_settings: { default_payment_method: null } as any,
    });
    mockSubscriptionPage([
      makeSubscription({
        id: 'sub_with_own_pm',
        customer,
        default_payment_method: 'pm_on_subscription',
      } as any),
    ]);
    mockStripe.invoices.list.mockResolvedValueOnce({ data: [{ id: 'in_sub_pm', status: 'paid' }] });

    const flags = await detectMrrCollectionGaps();

    expect(flags).toHaveLength(0);
  });

  it('reproduces the three named real-book leaks as a fixture-driven regression (Story With AI, Corgi, PMPS)', async () => {
    const storyWithAi = makeSubscription({
      id: 'sub_story',
      customer: makeCustomer({ id: 'cus_story', email: 'childrenstorywithai@gmail.com', default_source: null }),
    });
    const corgi = makeSubscription({
      id: 'sub_corgi',
      customer: makeCustomer({ id: 'cus_corgi_real', default_source: 'card_corgi' }),
    });
    const pmps = makeSubscription({
      id: 'sub_pmps',
      customer: makeCustomer({ id: 'cus_pmps_real', default_source: 'card_pmps' }),
      metadata: { contractedPriceCents: '49900' },
      items: {
        object: 'list',
        data: [{ price: { unit_amount: 5000, recurring: { interval: 'month' } } }],
      } as any,
    });
    mockSubscriptionPage([storyWithAi, corgi, pmps]);
    mockStripe.invoices.list
      .mockResolvedValueOnce({ data: [] }) // corgi: never a successful invoice
      .mockResolvedValueOnce({ data: [{ id: 'in_pmps', status: 'paid' }] }); // pmps: paying, just below contract

    const flags = await detectMrrCollectionGaps();

    const reasons = flags.map(f => `${f.customerId}:${f.reason}`).sort();
    expect(reasons).toEqual([
      'cus_corgi_real:zero_successful_charges',
      'cus_pmps_real:below_contracted_price',
      'cus_story:no_payment_method',
    ]);
  });

  it('skips a subscription whose customer field is a bare string ID or a deleted customer object', async () => {
    const deletedCustomer = { id: 'cus_gone', deleted: true } as unknown as Stripe.Customer;
    mockSubscriptionPage([
      makeSubscription({ id: 'sub_string_customer', customer: 'cus_raw_id' as any }),
      makeSubscription({ id: 'sub_deleted_customer', customer: deletedCustomer }),
    ]);

    const flags = await detectMrrCollectionGaps();

    expect(flags).toHaveLength(0);
    expect(mockStripe.invoices.list).not.toHaveBeenCalled();
  });

  it('ignores a non-numeric contractedPriceCents value rather than crashing or false-flagging', async () => {
    const customer = makeCustomer({ id: 'cus_bad_metadata', default_source: 'card_1' });
    mockSubscriptionPage([
      makeSubscription({ id: 'sub_bad_metadata', customer, metadata: { contractedPriceCents: 'not-a-number' } }),
    ]);
    mockStripe.invoices.list.mockResolvedValueOnce({ data: [{ id: 'in_x', status: 'paid' }] });

    const flags = await detectMrrCollectionGaps();

    expect(flags).toHaveLength(0);
  });

  it('falls back to the customer id in the detail message and null customerEmail when Stripe has no email on file', async () => {
    const customer = makeCustomer({ id: 'cus_no_email', email: null as any, default_source: null });
    mockSubscriptionPage([makeSubscription({ id: 'sub_no_email', customer })]);

    const flags = await detectMrrCollectionGaps();

    expect(flags).toHaveLength(1);
    expect(flags[0].customerEmail).toBeNull();
    expect(flags[0].detail).toContain('cus_no_email');
  });

  it('treats invoice_settings.default_payment_method alone as a payment method on file', async () => {
    const customer = makeCustomer({
      id: 'cus_pm_via_invoice_settings',
      default_source: null,
      invoice_settings: { default_payment_method: 'pm_abc' } as any,
    });
    mockSubscriptionPage([makeSubscription({ id: 'sub_pm', customer })]);
    mockStripe.invoices.list.mockResolvedValueOnce({ data: [{ id: 'in_y', status: 'paid' }] });

    const flags = await detectMrrCollectionGaps();

    expect(flags).toHaveLength(0);
  });

  it('treats a customer with no invoice_settings object at all as having no payment method', async () => {
    const customer = makeCustomer({ id: 'cus_no_invoice_settings', default_source: null });
    delete (customer as any).invoice_settings;
    mockSubscriptionPage([makeSubscription({ id: 'sub_no_invoice_settings', customer })]);

    const flags = await detectMrrCollectionGaps();

    expect(flags).toHaveLength(1);
    expect(flags[0].reason).toBe('no_payment_method');
  });

  it('ignores a negative contractedPriceCents value as invalid ground truth', async () => {
    const customer = makeCustomer({ id: 'cus_negative_metadata', default_source: 'card_1' });
    mockSubscriptionPage([
      makeSubscription({ id: 'sub_negative_metadata', customer, metadata: { contractedPriceCents: '-100' } }),
    ]);
    mockStripe.invoices.list.mockResolvedValueOnce({ data: [{ id: 'in_z', status: 'paid' }] });

    const flags = await detectMrrCollectionGaps();

    expect(flags).toHaveLength(0);
  });

  it('throws loudly when STRIPE_SECRET_KEY is not configured, instead of booking a silent $0', async () => {
    jest.resetModules();
    const key = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      const { detectMrrCollectionGaps: detectWithoutKey } = require('../services/mrrCollectionGapService');
      await expect(detectWithoutKey()).rejects.toThrow('Missing STRIPE_SECRET_KEY');
    } finally {
      process.env.STRIPE_SECRET_KEY = key;
    }
  });

  it('paginates through all Stripe subscription pages before returning', async () => {
    const custA = makeCustomer({ id: 'cus_a', default_source: null });
    const custB = makeCustomer({ id: 'cus_b', default_source: null });
    mockStripe.subscriptions.list
      .mockResolvedValueOnce({ data: [makeSubscription({ id: 'sub_a', customer: custA })], has_more: true })
      .mockResolvedValueOnce({ data: [makeSubscription({ id: 'sub_b', customer: custB })], has_more: false });

    const flags = await detectMrrCollectionGaps();

    expect(mockStripe.subscriptions.list).toHaveBeenCalledTimes(2);
    expect(flags.map(f => f.subscriptionId).sort()).toEqual(['sub_a', 'sub_b']);
  });
});
