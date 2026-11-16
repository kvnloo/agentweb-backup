import {
  buildCustomSubscriptionLinkCheckoutParams,
  CUSTOM_SUBSCRIPTION_LINK_SOURCE,
} from '../services/customSubscriptionLinkCheckout';
import {
  InMemoryPaymentFeedbackAskLedger,
  isPaymentFeedbackAskEnabled,
  shouldSendPaymentFeedbackAsk,
} from '../services/paymentFeedbackTrigger';

const customMeta = { source: CUSTOM_SUBSCRIPTION_LINK_SOURCE, orgId: 'org_1' };

function invoice(id: string, billingReason: string, metadata: Record<string, string> = customMeta, basil = true) {
  const details = { subscription: 'sub_1', metadata };
  return basil
    ? { id, billing_reason: billingReason, parent: { subscription_details: details } }
    : { id, billing_reason: billingReason, subscription: 'sub_1', subscription_details: details };
}

describe('shouldSendPaymentFeedbackAsk (ENG-2856)', () => {
  let ledger: InMemoryPaymentFeedbackAskLedger;
  const on = () => ({ enabled: true, ledger });

  beforeEach(() => {
    ledger = new InMemoryPaymentFeedbackAskLedger();
  });

  it('1st payment (subscription_create) -> no ask', () => {
    expect(shouldSendPaymentFeedbackAsk(invoice('in_1', 'subscription_create'), on()))
      .toEqual({ ask: false, reason: 'not_second_payment' });
  });

  it('2nd payment (subscription_cycle) -> ask', () => {
    shouldSendPaymentFeedbackAsk(invoice('in_1', 'subscription_create'), on());
    expect(shouldSendPaymentFeedbackAsk(invoice('in_2', 'subscription_cycle'), on()))
      .toEqual({ ask: true, invoiceId: 'in_2', subscriptionId: 'sub_1', orgId: 'org_1' });
  });

  it('reads pre-Basil root subscription_details.metadata too', () => {
    expect(shouldSendPaymentFeedbackAsk(invoice('in_2', 'subscription_cycle', customMeta, false), on()))
      .toMatchObject({ ask: true, orgId: 'org_1' });
  });

  it('same invoice redelivered -> no second ask', () => {
    expect(shouldSendPaymentFeedbackAsk(invoice('in_2', 'subscription_cycle'), on()).ask).toBe(true);
    expect(shouldSendPaymentFeedbackAsk(invoice('in_2', 'subscription_cycle'), on()))
      .toEqual({ ask: false, reason: 'already_asked' });
  });

  it('non-custom-link subscription -> ignored', () => {
    expect(shouldSendPaymentFeedbackAsk(invoice('in_2', 'subscription_cycle', { orgId: 'org_1' }), on()))
      .toEqual({ ask: false, reason: 'not_custom_link' });
    expect(shouldSendPaymentFeedbackAsk({ id: 'in_3', billing_reason: 'subscription_cycle' }, on()))
      .toEqual({ ask: false, reason: 'not_custom_link' });
    expect(shouldSendPaymentFeedbackAsk(
      invoice('in_4', 'subscription_cycle', { source: CUSTOM_SUBSCRIPTION_LINK_SOURCE }), on(),
    )).toEqual({ ask: false, reason: 'not_custom_link' });
  });

  it('flag off -> no-op and the ledger is untouched', () => {
    const claim = jest.spyOn(ledger, 'claim');
    expect(shouldSendPaymentFeedbackAsk(invoice('in_2', 'subscription_cycle'), { enabled: false, ledger }))
      .toEqual({ ask: false, reason: 'flag_off' });
    expect(claim).not.toHaveBeenCalled();
  });

  it('PAYMENT_FEEDBACK_ASK_ENABLED defaults off', () => {
    expect(isPaymentFeedbackAskEnabled({})).toBe(false);
    expect(isPaymentFeedbackAskEnabled({ PAYMENT_FEEDBACK_ASK_ENABLED: '1' })).toBe(false);
    expect(isPaymentFeedbackAskEnabled({ PAYMENT_FEEDBACK_ASK_ENABLED: 'true' })).toBe(true);
  });
});

describe('custom subscription link checkout stamps subscription metadata (ENG-2856)', () => {
  it('subscription_data.metadata carries source + orgId so invoices can be classified', () => {
    const p = buildCustomSubscriptionLinkCheckoutParams({
      orgId: 'org_1',
      label: 'Retainer',
      amountUsd: 499,
      frequency: 'month',
      createdBy: 'user_1',
      successUrl: 'https://x/ok',
      cancelUrl: 'https://x/cancel',
    });
    expect(p.subscription_data?.metadata).toMatchObject({ source: CUSTOM_SUBSCRIPTION_LINK_SOURCE, orgId: 'org_1' });
  });
});
