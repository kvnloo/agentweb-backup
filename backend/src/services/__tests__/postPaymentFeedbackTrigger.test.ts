import { decideFeedbackAsk, FEEDBACK_ASK_COOLDOWN_MS } from '../postPaymentFeedbackTrigger';
import { CUSTOM_SUBSCRIPTION_LINK_SOURCE } from '../customSubscriptionLinkCheckout';

const NOW = Date.UTC(2026, 10, 9);
const meta = { source: CUSTOM_SUBSCRIPTION_LINK_SOURCE, orgId: 'org_1' };

function invoice(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: 'paid',
    billing_reason: 'subscription_cycle',
    parent: { subscription_details: { subscription: 'sub_1', metadata: meta } },
    ...overrides,
  };
}

const twoPaid = [{ id: 'in_1', status: 'paid' }, { id: 'in_2', status: 'paid' }];

describe('decideFeedbackAsk (ENG-2835)', () => {
  it('does not ask on the 1st payment', () => {
    const d = decideFeedbackAsk({
      invoice: invoice('in_1', { billing_reason: 'subscription_create' }),
      subscriptionInvoices: [{ id: 'in_1', status: 'paid' }],
      priorAsks: [],
      now: NOW,
    });
    expect(d).toEqual({ ask: false, reason: 'not_subscription_cycle' });
  });

  it('asks on the 2nd consecutive paid invoice', () => {
    const d = decideFeedbackAsk({ invoice: invoice('in_2'), subscriptionInvoices: twoPaid, priorAsks: [], now: NOW });
    expect(d).toEqual({ ask: true, orgId: 'org_1', invoiceId: 'in_2', subscriptionId: 'sub_1', idempotencyKey: 'feedback_ask:in_2' });
  });

  it('does not duplicate on webhook redelivery of the same invoice', () => {
    const d = decideFeedbackAsk({
      invoice: invoice('in_2'),
      subscriptionInvoices: twoPaid,
      priorAsks: [{ orgId: 'org_1', invoiceId: 'in_2', askedAt: NOW }],
      now: NOW + 1000,
    });
    expect(d).toEqual({ ask: false, reason: 'already_asked_for_invoice' });
  });

  it('ignores subscriptions not created by a custom link', () => {
    const d = decideFeedbackAsk({
      invoice: invoice('in_2', { parent: { subscription_details: { subscription: 'sub_1', metadata: { orgId: 'org_1' } } } }),
      subscriptionInvoices: twoPaid,
      priorAsks: [],
      now: NOW,
    });
    expect(d).toEqual({ ask: false, reason: 'not_custom_link' });
  });

  it('reads legacy subscription_details metadata', () => {
    const d = decideFeedbackAsk({
      invoice: invoice('in_2', { parent: undefined, subscription: 'sub_1', subscription_details: { metadata: meta } }),
      subscriptionInvoices: twoPaid,
      priorAsks: [],
      now: NOW,
    });
    expect(d.ask).toBe(true);
  });

  it('does not ask when the streak is broken or on the 3rd invoice', () => {
    expect(decideFeedbackAsk({
      invoice: invoice('in_2'),
      subscriptionInvoices: [{ id: 'in_1', status: 'uncollectible' }, { id: 'in_2', status: 'paid' }],
      priorAsks: [], now: NOW,
    })).toEqual({ ask: false, reason: 'not_second_consecutive' });
    expect(decideFeedbackAsk({
      invoice: invoice('in_3'),
      subscriptionInvoices: [...twoPaid, { id: 'in_3', status: 'paid' }],
      priorAsks: [], now: NOW,
    })).toEqual({ ask: false, reason: 'not_second_consecutive' });
  });

  it('enforces one ask per org per 90 days', () => {
    const base = { invoice: invoice('in_2'), subscriptionInvoices: twoPaid, now: NOW };
    expect(decideFeedbackAsk({ ...base, priorAsks: [{ orgId: 'org_1', invoiceId: 'in_x', askedAt: NOW - FEEDBACK_ASK_COOLDOWN_MS + 1 }] }))
      .toEqual({ ask: false, reason: 'org_cooldown' });
    expect(decideFeedbackAsk({ ...base, priorAsks: [{ orgId: 'org_1', invoiceId: 'in_x', askedAt: NOW - FEEDBACK_ASK_COOLDOWN_MS }] }).ask)
      .toBe(true);
  });

  it('refuses a malformed orgId and an unpaid invoice', () => {
    expect(decideFeedbackAsk({
      invoice: invoice('in_2', { parent: { subscription_details: { subscription: 'sub_1', metadata: { ...meta, orgId: 'bad id!' } } } }),
      subscriptionInvoices: twoPaid, priorAsks: [], now: NOW,
    })).toEqual({ ask: false, reason: 'missing_org' });
    expect(decideFeedbackAsk({ invoice: invoice('in_2', { status: 'open' }), subscriptionInvoices: twoPaid, priorAsks: [], now: NOW }))
      .toEqual({ ask: false, reason: 'not_paid' });
  });
});
