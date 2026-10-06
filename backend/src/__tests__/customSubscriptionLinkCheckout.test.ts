import {
  buildCustomSubscriptionLinkCheckoutParams,
  CUSTOM_SUBSCRIPTION_LINK_SOURCE,
  CustomSubscriptionLinkError,
  CustomSubscriptionLinkInput,
  MAX_CUSTOM_LINK_AMOUNT_USD,
  MAX_CUSTOM_LINK_LABEL_LENGTH,
} from '../services/customSubscriptionLinkCheckout';

const base: CustomSubscriptionLinkInput = {
  orgId: 'org_1',
  label: '  Managed ads retainer  ',
  amountUsd: 499,
  frequency: 'month',
  createdBy: 'user_1',
  successUrl: 'https://x/ok',
  cancelUrl: 'https://x/cancel',
};

describe('buildCustomSubscriptionLinkCheckoutParams (ENG-2304)', () => {
  it('one_time -> payment mode with no recurring', () => {
    const p = buildCustomSubscriptionLinkCheckoutParams({ ...base, frequency: 'one_time' });
    expect(p.mode).toBe('payment');
    expect(p.line_items![0].price_data!.recurring).toBeUndefined();
    expect(p.payment_intent_data?.metadata).toMatchObject({ source: CUSTOM_SUBSCRIPTION_LINK_SOURCE });
    expect(p.subscription_data).toBeUndefined();
  });

  it.each([
    ['week', 'week', 1],
    ['month', 'month', 1],
    ['quarter', 'month', 3],
    ['year', 'year', 1],
  ] as const)('%s -> subscription with interval %s x%d', (frequency, interval, count) => {
    const p = buildCustomSubscriptionLinkCheckoutParams({ ...base, frequency });
    expect(p.mode).toBe('subscription');
    expect(p.line_items![0].price_data!.recurring).toEqual({ interval, interval_count: count });
    expect(p.subscription_data?.metadata).toMatchObject({ orgId: 'org_1' });
  });

  it('converts to integer cents', () => {
    const p = buildCustomSubscriptionLinkCheckoutParams({ ...base, amountUsd: 19.99 });
    expect(p.line_items![0].price_data!.unit_amount).toBe(1999);
    const q = buildCustomSubscriptionLinkCheckoutParams({ ...base, amountUsd: 0.1 + 0.2 - 0.00000000000000004 });
    expect(Number.isInteger(q.line_items![0].price_data!.unit_amount)).toBe(true);
  });

  it.each([0, -5, NaN, Infinity, 1.005, 12.345, MAX_CUSTOM_LINK_AMOUNT_USD + 0.01])('rejects amount %p', (amountUsd) => {
    expect(() => buildCustomSubscriptionLinkCheckoutParams({ ...base, amountUsd })).toThrow(CustomSubscriptionLinkError);
  });

  it('accepts the max amount exactly', () => {
    const p = buildCustomSubscriptionLinkCheckoutParams({ ...base, amountUsd: MAX_CUSTOM_LINK_AMOUNT_USD });
    expect(p.line_items![0].price_data!.unit_amount).toBe(MAX_CUSTOM_LINK_AMOUNT_USD * 100);
  });

  it('trims the label and enforces non-empty + length cap', () => {
    const p = buildCustomSubscriptionLinkCheckoutParams(base);
    expect(p.line_items![0].price_data!.product_data!.name).toBe('Managed ads retainer');
    expect(() => buildCustomSubscriptionLinkCheckoutParams({ ...base, label: '   ' })).toThrow(CustomSubscriptionLinkError);
    expect(() =>
      buildCustomSubscriptionLinkCheckoutParams({ ...base, label: 'a'.repeat(MAX_CUSTOM_LINK_LABEL_LENGTH + 1) }),
    ).toThrow(CustomSubscriptionLinkError);
  });

  it('sets customer and full metadata when stripeCustomerId given', () => {
    const p = buildCustomSubscriptionLinkCheckoutParams({ ...base, stripeCustomerId: 'cus_123', customerEmail: 'a@b.co' });
    expect(p.customer).toBe('cus_123');
    expect(p.customer_email).toBeUndefined();
    expect(p.customer_creation).toBeUndefined();
    expect(p.metadata).toEqual({
      source: CUSTOM_SUBSCRIPTION_LINK_SOURCE,
      orgId: 'org_1',
      createdBy: 'user_1',
      linkLabel: 'Managed ads retainer',
      frequency: 'month',
    });
  });

  it('without customer: customer_email, and customer_creation only in payment mode', () => {
    const sub = buildCustomSubscriptionLinkCheckoutParams({ ...base, customerEmail: 'a@b.co' });
    expect(sub.customer).toBeUndefined();
    expect(sub.customer_email).toBe('a@b.co');
    expect(sub.customer_creation).toBeUndefined();
    const pay = buildCustomSubscriptionLinkCheckoutParams({ ...base, frequency: 'one_time' });
    expect(pay.customer_creation).toBe('always');
  });

  it('rejects missing orgId/createdBy and unknown frequency', () => {
    expect(() => buildCustomSubscriptionLinkCheckoutParams({ ...base, orgId: '' })).toThrow(CustomSubscriptionLinkError);
    expect(() => buildCustomSubscriptionLinkCheckoutParams({ ...base, createdBy: ' ' })).toThrow(CustomSubscriptionLinkError);
    expect(() => buildCustomSubscriptionLinkCheckoutParams({ ...base, frequency: 'daily' as any })).toThrow(CustomSubscriptionLinkError);
  });
});
