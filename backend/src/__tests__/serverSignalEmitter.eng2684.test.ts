import {
  mapStripeEventToSignals,
  emitStripeSignals,
  emitAccountSignal,
  DEFAULT_HIREEMMA_SIGNAL_LIST_ID,
} from '../services/serverSignalEmitter';

const user = { userId: 'u-123', createdAt: '2026-01-01T00:00:00.000Z' };
const sessionList = { listId: DEFAULT_HIREEMMA_SIGNAL_LIST_ID, listType: 'session', userId: 'owner' };

function deps(over: Record<string, any> = {}) {
  return {
    getList: jest.fn().mockResolvedValue(sessionList),
    ingest: jest.fn().mockResolvedValue({}),
    findUserByStripeCustomerId: jest.fn().mockResolvedValue(user),
    now: () => 1_800_000_000_000,
    logger: { warn: jest.fn(), error: jest.fn() },
    ...over,
  };
}

const ev = (type: string, object: any, previous_attributes?: any) => ({ id: `evt_${type}`, type, data: { object, previous_attributes } });

describe('ENG-2684 Stripe → hireemma.ai session signals', () => {
  const cases: Array<[string, any, string[]]> = [
    ['customer.subscription.created', ev('customer.subscription.created', { id: 'sub_1', customer: 'cus_1', status: 'active' }), ['subscription_started']],
    ['customer.subscription.deleted', ev('customer.subscription.deleted', { id: 'sub_1', customer: 'cus_1' }), ['subscription_cancelled']],
    ['plan change', ev('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1', items: { data: [{ price: { id: 'price_pro' } }] } }, { items: { data: [{ price: { id: 'price_basic' } }] } }), ['subscription_plan_changed']],
    ['invoice.paid first', ev('invoice.paid', { id: 'in_1', customer: 'cus_1', billing_reason: 'subscription_create', amount_paid: 49900 }), ['payment_completed']],
    ['invoice.paid renewal', ev('invoice.paid', { id: 'in_2', customer: 'cus_1', billing_reason: 'subscription_cycle', amount_paid: 49900 }), ['payment_completed', 'subscription_renewed']],
    ['invoice.payment_failed', ev('invoice.payment_failed', { id: 'in_3', customer: 'cus_1', amount_due: 49900 }), ['payment_failed']],
    ['charge.refunded', ev('charge.refunded', { id: 'ch_1', customer: 'cus_1', amount_refunded: 100 }), ['refund_issued']],
  ];

  it.each(cases)('%s emits exactly the expected signal(s) with ids', async (_label, event, names) => {
    const d = deps();
    await expect(emitStripeSignals(event, d)).resolves.toBe(names.length);
    expect(d.findUserByStripeCustomerId).toHaveBeenCalledWith('cus_1');
    expect(d.ingest).toHaveBeenCalledTimes(names.length);
    d.ingest.mock.calls.forEach(([input]: any[], i: number) => {
      expect(input.list).toBe(sessionList);
      expect(input.parsed.listId).toBe(DEFAULT_HIREEMMA_SIGNAL_LIST_ID);
      expect(input.parsed.event).toBe('custom');
      expect(input.parsed.customName).toBe(names[i]);
      expect(input.parsed.identity).toEqual({ sessionId: 'acct-u-123', sessionStartMs: Date.parse(user.createdAt) });
      expect(input.parsed.client.accountId).toBe('u-123');
      expect(JSON.parse(input.parsed.client.lastCustomProps).stripeEventId).toBe(event.id);
    });
  });

  it('reads the subscription id from a Basil invoice (parent.subscription_details) and a legacy one', () => {
    const basil = mapStripeEventToSignals(ev('invoice.paid', { id: 'in_b', customer: 'cus_1', amount_paid: 9900, parent: { subscription_details: { subscription: 'sub_basil' } } }));
    expect(basil[0].props.subscriptionId).toBe('sub_basil');
    const legacy = mapStripeEventToSignals(ev('invoice.payment_failed', { id: 'in_l', customer: 'cus_1', amount_due: 9900, subscription: 'sub_legacy' }));
    expect(legacy[0].props.subscriptionId).toBe('sub_legacy');
  });

  it('ignores subscription updates without a price change and unmapped events', () => {
    expect(mapStripeEventToSignals(ev('customer.subscription.updated', { id: 's', customer: 'c' }, { status: 'trialing' }))).toEqual([]);
    expect(mapStripeEventToSignals(ev('checkout.session.completed', { id: 'cs', customer: 'c' }))).toEqual([]);
    expect(mapStripeEventToSignals(ev('setup_intent.succeeded', { id: 'si', customer: 'c' }))).toEqual([]);
  });

  it('never throws when the write fails, the list is missing, or the customer is unknown', async () => {
    const e = cases[0][1];
    await expect(emitStripeSignals(e, deps({ ingest: jest.fn().mockRejectedValue(new Error('ddb down')) }))).resolves.toBe(0);
    await expect(emitStripeSignals(e, deps({ getList: jest.fn().mockResolvedValue(null) }))).resolves.toBe(0);
    await expect(emitStripeSignals(e, deps({ findUserByStripeCustomerId: jest.fn().mockRejectedValue(new Error('x')) }))).resolves.toBe(0);
    const unknown = deps({ findUserByStripeCustomerId: jest.fn().mockResolvedValue(null) });
    await expect(emitStripeSignals(e, unknown)).resolves.toBe(0);
    expect(unknown.ingest).not.toHaveBeenCalled();
  });

  it('checkout_started is emitted for a resolved account and refuses a non-session list', async () => {
    const d = deps();
    await expect(emitAccountSignal(user, 'checkout_started', { checkoutSessionId: 'cs_1' }, d)).resolves.toBe(true);
    expect(d.ingest.mock.calls[0][0].parsed.customName).toBe('checkout_started');
    const bad = deps({ getList: jest.fn().mockResolvedValue({ listType: 'leads' }) });
    await expect(emitAccountSignal(user, 'checkout_started', {}, bad)).resolves.toBe(false);
    expect(bad.ingest).not.toHaveBeenCalled();
  });
});
