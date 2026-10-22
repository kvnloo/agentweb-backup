/**
 * ENG-668 PR-2 — the webhook controller does not treat a pay-as-you-go overage invoice as a subscription
 * payment. Its `handleInvoicePayment` row (`payment_succeeded` / `payment_failed`) is what
 * accountHealthClassifier reads as subscription health — a failed overage charge must not read as a
 * subscription at risk, and a paid one must not mask a subscription failure — and the CRM mirror models
 * the subscription too. Settlement records overage payments under their own event types instead
 * (`payg_overage_payment_*`, paygSettlementService).
 */
const mockConstruct = jest.fn();
const mockFindUser = jest.fn();
const mockRecord = jest.fn(async () => ({ written: true }));
const mockFailedHandler = jest.fn();
const mockPaidHandler = jest.fn();

jest.mock('../services/stripeService', () => {
  const actual = jest.requireActual('../services/stripeService');
  return {
    PAYG_OVERAGE_PURCHASE_TYPE: actual.PAYG_OVERAGE_PURCHASE_TYPE,
    isSetupModeCheckoutSession: actual.isSetupModeCheckoutSession,
    stripeService: { constructWebhookEvent: (...a: unknown[]) => mockConstruct(...a) },
    handleCheckoutSessionCompleted: jest.fn(),
    handleLlmUsageTopUpCheckoutCompleted: jest.fn(),
    handleSubscriptionUpdated: jest.fn(),
    handleSubscriptionDeleted: jest.fn(),
    findUserByStripeCustomerId: (...a: unknown[]) => mockFindUser(...a),
    handleInvoicePaymentSucceeded: (...a: unknown[]) => mockPaidHandler(...a),
    handleInvoicePaymentFailed: (...a: unknown[]) => mockFailedHandler(...a),
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
jest.mock('../services/paymentHistoryDb', () => ({ paymentHistoryDb: { record: (...a: unknown[]) => mockRecord(...(a as [])) } }));

import { handleWebhook } from '../controllers/stripeController';

function res() {
  const r = { status: jest.fn(), json: jest.fn() };
  r.status.mockReturnValue(r);
  r.json.mockReturnValue(r);
  return r;
}
const req = () => ({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') }) as never;
const flush = () => new Promise((resolve) => setImmediate(resolve));

const overageInvoice = {
  id: 'in_payg', object: 'invoice', customer: 'cus_1', amount_due: 4500, amount_paid: 0, currency: 'usd', status: 'open',
  metadata: { purchaseType: 'payg_overage', billingUserId: 'owner-1', month: '2026-09', idempotencyKey: 'payg:owner-1:2026-09' },
};
const subscriptionInvoice = { id: 'in_sub', object: 'invoice', customer: 'cus_1', amount_due: 4900, amount_paid: 0, currency: 'usd', status: 'open', metadata: {} };

describe('ENG-668 webhook controller — overage invoices are not subscription payments (rv4 MINOR 4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindUser.mockResolvedValue({ userId: 'owner-1', email: 'owner@example.com' });
  });

  it.each(['invoice.payment_failed', 'invoice.paid', 'invoice.payment_succeeded'])(
    '%s for an overage invoice: settlement handles it; no subscription payment row, no CRM mirror',
    async (type) => {
      mockConstruct.mockReturnValue({ id: 'evt_1', type, data: { object: overageInvoice } });
      const r = res();
      await handleWebhook(req(), r as never);
      await flush();
      const handler = type === 'invoice.payment_failed' ? mockFailedHandler : mockPaidHandler;
      expect(handler).toHaveBeenCalledWith(overageInvoice);
      expect(mockRecord).not.toHaveBeenCalled();
      expect(mockFindUser).not.toHaveBeenCalled(); // neither handleInvoicePayment nor the CRM mirror ran
      expect(r.json).toHaveBeenCalledWith({ received: true });
    },
  );

  it('a subscription invoice still records payment_failed (what the health classifier reads) and is mirrored', async () => {
    mockConstruct.mockReturnValue({ id: 'evt_2', type: 'invoice.payment_failed', data: { object: subscriptionInvoice } });
    await handleWebhook(req(), res() as never);
    await flush();
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'payment_failed', stripeInvoiceId: 'in_sub' }));
  });
});
