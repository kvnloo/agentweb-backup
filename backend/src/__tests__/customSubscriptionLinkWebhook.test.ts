import type Stripe from 'stripe';
import { CUSTOM_SUBSCRIPTION_LINK_SOURCE } from '../services/customSubscriptionLinkCheckout';
import {
  CustomLinkWebhookError,
  resolveCustomLinkEvent,
} from '../services/customSubscriptionLinkWebhook';

type Ev = Pick<Stripe.Event, 'id' | 'type' | 'data'>;
const ev = (id: string, type: string, object: Record<string, unknown>): Ev =>
  ({ id, type, data: { object } }) as unknown as Ev;

const linkMeta = {
  source: CUSTOM_SUBSCRIPTION_LINK_SOURCE,
  orgId: 'org_123',
  createdBy: 'user_9',
  linkLabel: 'Managed ads retainer',
  frequency: 'month',
};

const checkout = (meta: Record<string, unknown> = linkMeta) =>
  ev('evt_cs_1', 'checkout.session.completed', {
    id: 'cs_test_1',
    object: 'checkout.session',
    mode: 'subscription',
    customer: 'cus_1',
    subscription: 'sub_1',
    payment_status: 'paid',
    status: 'complete',
    metadata: meta,
  });

const sub = (type: string, id = 'evt_sub_1', meta: Record<string, unknown> = linkMeta, status = 'active') =>
  ev(id, type, {
    id: 'sub_1',
    object: 'subscription',
    customer: { id: 'cus_1', object: 'customer' },
    status,
    metadata: meta,
    items: { data: [{ price: { unit_amount: 49900, recurring: { interval: 'month', interval_count: 1 } } }] },
  });

// Real-shaped plan subscription (multiple line items, plan metadata) — must be ignored.
const planSub = ev('evt_plan_1', 'customer.subscription.updated', {
  id: 'sub_plan',
  object: 'subscription',
  customer: 'cus_plan',
  status: 'active',
  metadata: { orgId: 'org_123', plan: 'pro', userId: 'user_9' },
  items: {
    data: [
      { price: { id: 'price_pro', unit_amount: 49900, recurring: { interval: 'month' } }, quantity: 1 },
      { price: { id: 'price_seat', unit_amount: 2000, recurring: { interval: 'month' } }, quantity: 3 },
    ],
  },
});

describe('resolveCustomLinkEvent (ENG-2366)', () => {
  it('classifies checkout.session.completed', () => {
    expect(resolveCustomLinkEvent(checkout())).toEqual({
      kind: 'custom_link',
      eventType: 'checkout.session.completed',
      orgId: 'org_123',
      userId: 'user_9',
      linkLabel: 'Managed ads retainer',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      status: 'paid',
      idempotencyKey: 'custom_link:checkout:cs_test_1',
    });
  });

  it.each(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'])(
    'classifies %s',
    (type) => {
      const status = type.endsWith('deleted') ? 'canceled' : 'active';
      const r = resolveCustomLinkEvent(sub(type, 'evt_x', linkMeta, status));
      expect(r).toMatchObject({
        kind: 'custom_link',
        eventType: type,
        orgId: 'org_123',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        status,
      });
    },
  );

  it('one-time checkout (no subscription) omits stripeSubscriptionId', () => {
    const e = checkout();
    (e.data.object as unknown as Record<string, unknown>).subscription = null;
    const r = resolveCustomLinkEvent(e);
    expect(r.kind).toBe('custom_link');
    expect(r).not.toHaveProperty('stripeSubscriptionId');
  });

  it('prefers metadata.userId over createdBy when present', () => {
    const r = resolveCustomLinkEvent(checkout({ ...linkMeta, userId: 'user_owner' }));
    expect(r).toMatchObject({ userId: 'user_owner' });
  });

  describe('AC1: non custom-link events are untouched', () => {
    it('ignores a real-shaped plan subscription', () => {
      expect(resolveCustomLinkEvent(planSub)).toEqual({ kind: 'not_custom_link' });
    });
    it('ignores events with no metadata', () => {
      expect(resolveCustomLinkEvent(ev('e', 'checkout.session.completed', { id: 'cs' }))).toEqual({ kind: 'not_custom_link' });
    });
    it('ignores a different source value', () => {
      expect(resolveCustomLinkEvent(checkout({ ...linkMeta, source: 'plan' }))).toEqual({ kind: 'not_custom_link' });
    });
    it('ignores unhandled event types even with custom-link metadata', () => {
      expect(resolveCustomLinkEvent(ev('e', 'invoice.paid', { id: 'in_1', metadata: linkMeta }))).toEqual({
        kind: 'not_custom_link',
      });
    });
  });

  describe('AC2: missing/malformed orgId is a typed error', () => {
    it.each([undefined, '', '   ', 42, 'org with spaces', 'x'.repeat(200)])('orgId=%p', (orgId) => {
      const meta = { ...linkMeta, orgId } as Record<string, unknown>;
      if (orgId === undefined) delete meta.orgId;
      expect(() => resolveCustomLinkEvent(checkout(meta))).toThrow(CustomLinkWebhookError);
      expect(() => resolveCustomLinkEvent(sub('customer.subscription.updated', 'e', meta))).toThrow(CustomLinkWebhookError);
    });
  });

  describe('AC3: idempotencyKey stability', () => {
    it('same event id redelivered yields the same key', () => {
      const a = resolveCustomLinkEvent(sub('customer.subscription.updated', 'evt_A'));
      const b = resolveCustomLinkEvent(sub('customer.subscription.updated', 'evt_A'));
      expect(a.kind === 'custom_link' && b.kind === 'custom_link' && a.idempotencyKey === b.idempotencyKey).toBe(true);
    });
    it('distinct updates to the same subscription do not collapse', () => {
      const a = resolveCustomLinkEvent(sub('customer.subscription.updated', 'evt_A'));
      const b = resolveCustomLinkEvent(sub('customer.subscription.updated', 'evt_B'));
      expect((a as { idempotencyKey: string }).idempotencyKey).not.toBe((b as { idempotencyKey: string }).idempotencyKey);
    });
    it('checkout keys on session id across redeliveries', () => {
      const a = resolveCustomLinkEvent(checkout());
      const e2 = checkout();
      (e2 as { id: string }).id = 'evt_cs_retry';
      expect(resolveCustomLinkEvent(e2)).toMatchObject({ idempotencyKey: (a as { idempotencyKey: string }).idempotencyKey });
    });
  });
});
