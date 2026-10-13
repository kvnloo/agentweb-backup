/**
 * ENG-2303 P2 billing invariant: the Zoma "add a payment method" link is a setup-mode
 * Checkout Session. Its completion must NOT run the subscription handler (which would set
 * subscription_status=active on a non-subscriber), record a subscription event, or emit a
 * CRM payment.subscribed signal. Subscription checkouts are unchanged.
 */
const mockHandleCheckout = jest.fn();
const mockConstruct = jest.fn();
const mockFindUser = jest.fn().mockResolvedValue(null);

jest.mock('../services/stripeService', () => {
  const actual = jest.requireActual('../services/stripeService');
  return {
    isSetupModeCheckoutSession: actual.isSetupModeCheckoutSession,
    stripeService: { constructWebhookEvent: (...a: any[]) => mockConstruct(...a) },
    handleCheckoutSessionCompleted: (...a: any[]) => mockHandleCheckout(...a),
    handleLlmUsageTopUpCheckoutCompleted: jest.fn(),
    handleSubscriptionUpdated: jest.fn(),
    handleSubscriptionDeleted: jest.fn(),
    findUserByStripeCustomerId: (...a: any[]) => mockFindUser(...a),
    handleInvoicePaymentSucceeded: jest.fn(),
    handleInvoicePaymentFailed: jest.fn(),
    handleChargeRefunded: jest.fn(),
    handleChargeDisputeCreated: jest.fn(),
    handleChargeDisputeClosed: jest.fn(),
    handleSubscriptionScheduleEnded: jest.fn(),
    reconcileAllStripeUsers: jest.fn(),
    findBasePlanItem: jest.fn(),
    getSubscriptionPeriodEndIso: jest.fn(),
  };
});
jest.mock('../services/db', () => ({ userDb: {} }));

import { handleWebhook } from '../controllers/stripeController';
import { isSetupModeCheckoutSession } from '../services/stripeService';

function res() {
  const r: any = {};
  r.status = jest.fn(() => r);
  r.json = jest.fn(() => r);
  return r;
}
const req = () => ({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') }) as any;

describe('ENG-2303 setup-mode checkout webhook guard', () => {
  beforeEach(() => jest.clearAllMocks());

  it('classifies only setup-mode checkout sessions', () => {
    expect(isSetupModeCheckoutSession({ object: 'checkout.session', mode: 'setup' })).toBe(true);
    expect(isSetupModeCheckoutSession({ object: 'checkout.session', mode: 'subscription' })).toBe(false);
    expect(isSetupModeCheckoutSession({ object: 'checkout.session', mode: 'payment' })).toBe(false);
    expect(isSetupModeCheckoutSession(undefined)).toBe(false);
  });

  it('a completed setup-mode session never reaches the subscription handler or payment history', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockConstruct.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', object: 'checkout.session', mode: 'setup', customer: 'cus_1', metadata: { userId: 'u1', purchaseType: 'zoma_payment_method' } } },
    });
    const r = res();
    await handleWebhook(req(), r);
    expect(mockHandleCheckout).not.toHaveBeenCalled();
    expect(mockFindUser).not.toHaveBeenCalled(); // neither recordSubscriptionEvent nor the CRM hook ran
    expect(r.json).toHaveBeenCalledWith({ received: true });
  });

  it('a subscription checkout still runs the subscription handler', async () => {
    mockConstruct.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_2', object: 'checkout.session', mode: 'subscription', customer: 'cus_2', subscription: 'sub_2' } },
    });
    await handleWebhook(req(), res());
    expect(mockHandleCheckout).toHaveBeenCalledTimes(1);
  });
});
