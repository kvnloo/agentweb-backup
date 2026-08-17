jest.mock('../services/llmUsageCreditService', () => ({
  grantMonthlyLlmUsageCredit: jest.fn(async () => ({ granted: true })),
  reverseMonthlyPurchasedLlmUsageCredit: jest.fn(async () => ({ reversed: true })),
}));

import { handleChargeRefunded, handleLlmUsageTopUpCheckoutCompleted } from '../services/stripeService';
import { grantMonthlyLlmUsageCredit, reverseMonthlyPurchasedLlmUsageCredit } from '../services/llmUsageCreditService';
import { userDb } from '../services/db';
import { paymentHistoryDb } from '../services/paymentHistoryDb';

const paidSession = {
  id: 'cs_test_topup_1',
  payment_status: 'paid',
  amount_total: 2500,
  metadata: {
    purchaseType: 'llm_usage_top_up',
    billingUserId: 'u1',
    packageId: 'aw-10',
    usageCreditMicroUsd: '10000000',
    minimumMarkupBps: '25000',
    topUpGrantId: 'topup-1',
  },
};

describe('usage top-up Stripe webhook', () => {
  beforeEach(() => jest.clearAllMocks());

  it('grants the configured provider usage credit after paid checkout', async () => {
    await handleLlmUsageTopUpCheckoutCompleted(paidSession);
    expect(grantMonthlyLlmUsageCredit).toHaveBeenCalledWith({
      billingUserId: 'u1',
      grantId: 'stripe:topup-1',
      source: 'purchase',
      amountMicroUsd: 10_000_000,
    });
  });

  it('waits for async payment success when checkout is not paid', async () => {
    await handleLlmUsageTopUpCheckoutCompleted({ ...paidSession, payment_status: 'unpaid' });
    expect(grantMonthlyLlmUsageCredit).not.toHaveBeenCalled();
  });

  it('fails closed if the paid amount falls below the checkout markup snapshot', async () => {
    await expect(handleLlmUsageTopUpCheckoutCompleted({ ...paidSession, amount_total: 2499 }))
      .rejects.toThrow('below the configured minimum markup');
    expect(grantMonthlyLlmUsageCredit).not.toHaveBeenCalled();
  });

  it('proportionally removes purchased capacity when Stripe reports a refund', async () => {
    const getUser = jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: 'u1' } as any);
    const record = jest.spyOn(paymentHistoryDb, 'record').mockResolvedValue({ written: true });

    await handleChargeRefunded({
      id: 'ch_topup_1',
      customer: 'cus_1',
      amount: 2500,
      amount_refunded: 1000,
      refunded: false,
      currency: 'usd',
      metadata: {
        purchaseType: 'llm_usage_top_up',
        billingUserId: 'u1',
        topUpGrantId: 'topup-1',
        usageCreditMicroUsd: '10000000',
      },
      refunds: { data: [{ id: 're_1', reason: 'requested_by_customer' }] },
    });

    expect(reverseMonthlyPurchasedLlmUsageCredit).toHaveBeenCalledWith({
      billingUserId: 'u1',
      grantId: 'stripe:topup-1',
      reversalId: 'charge:ch_topup_1:refunded:1000',
      targetReversedMicroUsd: 4_000_000,
    });
    getUser.mockRestore();
    record.mockRestore();
  });
});
