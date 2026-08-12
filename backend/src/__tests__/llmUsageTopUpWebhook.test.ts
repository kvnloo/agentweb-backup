jest.mock('../services/llmUsageCreditService', () => ({
  grantMonthlyLlmUsageCredit: jest.fn(async () => ({ granted: true })),
}));

import { handleLlmUsageTopUpCheckoutCompleted } from '../services/stripeService';
import { grantMonthlyLlmUsageCredit } from '../services/llmUsageCreditService';

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
  },
};

describe('usage top-up Stripe webhook', () => {
  beforeEach(() => jest.clearAllMocks());

  it('grants the configured provider usage credit after paid checkout', async () => {
    await handleLlmUsageTopUpCheckoutCompleted(paidSession);
    expect(grantMonthlyLlmUsageCredit).toHaveBeenCalledWith({
      billingUserId: 'u1',
      grantId: 'stripe:cs_test_topup_1',
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
});
