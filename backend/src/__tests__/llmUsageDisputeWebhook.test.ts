/**
 * ENG-1140 — chargeback handling for AgentWeb Credits purchases.
 *
 * A dispute puts the funds at risk immediately, so purchased usage capacity is
 * revoked as soon as the dispute opens rather than when it resolves. Winning a
 * dispute deliberately does NOT auto-restore capacity: credits are month-scoped
 * and disputes usually resolve in a later month, so a re-grant would hand the
 * customer a second month of capacity for a single payment. Restoring a won
 * dispute is an admin one-time-credit decision instead.
 */

const mockStripe = {
  charges: {
    retrieve: jest.fn(),
  },
};

jest.mock('stripe', () => jest.fn().mockImplementation(() => mockStripe));

const mockReverse = jest.fn(async () => ({ reversed: true, billingUserId: 'u1', ledger: {} as any }));
const mockGrant = jest.fn(async () => ({ granted: true }));

// Blanket-mocking this module would strip the other exports stripeService's
// import graph relies on, so keep the real module and swap only the two
// functions under test.
jest.mock('../services/llmUsageCreditService', () => ({
  ...jest.requireActual('../services/llmUsageCreditService'),
  grantMonthlyLlmUsageCredit: (...a: any[]) => mockGrant(...(a as [])),
  reverseMonthlyPurchasedLlmUsageCredit: (...a: any[]) => mockReverse(...(a as [])),
}));

import { handleChargeDisputeCreated, handleChargeDisputeClosed } from '../services/stripeService';
import { userDb } from '../services/db';
import { paymentHistoryDb } from '../services/paymentHistoryDb';

const topUpCharge = {
  id: 'ch_topup_1',
  customer: 'cus_1',
  amount: 2500,
  currency: 'usd',
  metadata: {
    purchaseType: 'llm_usage_top_up',
    billingUserId: 'u1',
    topUpGrantId: 'topup-1',
    usageCreditMicroUsd: '10000000',
  },
};

const DISPUTE_CREATED_SEC = 1_800_000_000; // Stripe-shape unix seconds (still passed through, not used for keying)

const fullDispute = {
  id: 'dp_1',
  charge: 'ch_topup_1',
  amount: 2500,
  currency: 'usd',
  reason: 'fraudulent',
  status: 'needs_response',
  created: DISPUTE_CREATED_SEC,
};

describe('AgentWeb Credits chargeback handling', () => {
  let getUser: jest.SpyInstance;
  let record: jest.SpyInstance;
  let getByUserId: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    mockStripe.charges.retrieve.mockResolvedValue(topUpCharge);
    getUser = jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: 'u1' } as any);
    record = jest.spyOn(paymentHistoryDb, 'record').mockResolvedValue(undefined as any);
    // Default: no prior history for the user, so dedup lets the write through.
    getByUserId = jest.spyOn(paymentHistoryDb, 'getByUserId').mockResolvedValue([]);
  });

  afterEach(() => {
    getUser.mockRestore();
    record.mockRestore();
    getByUserId.mockRestore();
  });

  describe('dispute opened', () => {
    it('revokes the full purchased capacity when the whole charge is disputed', async () => {
      await handleChargeDisputeCreated(fullDispute);

      expect(mockReverse).toHaveBeenCalledWith({
        billingUserId: 'u1',
        grantId: 'stripe:topup-1',
        reversalId: 'dispute:dp_1:2500',
        targetReversedMicroUsd: 10_000_000,
      });
    });

    it('revokes proportionally when only part of the charge is disputed', async () => {
      await handleChargeDisputeCreated({ ...fullDispute, amount: 1000 });

      expect(mockReverse).toHaveBeenCalledWith(
        expect.objectContaining({ targetReversedMicroUsd: 4_000_000 }),
      );
    });

    it('ignores disputes on charges that are not credit purchases', async () => {
      mockStripe.charges.retrieve.mockResolvedValue({
        ...topUpCharge,
        metadata: { purchaseType: 'subscription' },
      });

      await handleChargeDisputeCreated(fullDispute);

      expect(mockReverse).not.toHaveBeenCalled();
    });

    it('does nothing when the dispute carries no charge reference', async () => {
      await handleChargeDisputeCreated({ ...fullDispute, charge: null });

      expect(mockStripe.charges.retrieve).not.toHaveBeenCalled();
      expect(mockReverse).not.toHaveBeenCalled();
    });

    it('fails loudly when credit-purchase metadata is unusable', async () => {
      mockStripe.charges.retrieve.mockResolvedValue({
        ...topUpCharge,
        metadata: { ...topUpCharge.metadata, topUpGrantId: '' },
      });

      await expect(handleChargeDisputeCreated(fullDispute)).rejects.toThrow(
        /dispute metadata/i,
      );
      expect(mockReverse).not.toHaveBeenCalled();
    });

    it('does not revoke when the billing user no longer exists', async () => {
      getUser.mockResolvedValue(undefined);

      await handleChargeDisputeCreated(fullDispute);

      expect(mockReverse).not.toHaveBeenCalled();
    });

    it('keys the reversal to the dispute so redelivery cannot double-revoke', async () => {
      await handleChargeDisputeCreated(fullDispute);
      await handleChargeDisputeCreated(fullDispute);

      const [first, second] = mockReverse.mock.calls as any[];
      expect(first[0].reversalId).toBe(second[0].reversalId);
    });

    it('skips a duplicate dispute_opened history row when the same disputeId is already recorded', async () => {
      // Simulate a prior dispute_opened row for this dispute in history.
      getByUserId.mockResolvedValueOnce([
        {
          userId: 'u1',
          timestamp: '2026-08-13T10:00:00.000Z',
          eventType: 'dispute_opened',
          amount: 2500,
          currency: 'usd',
          status: 'disputed',
          metadata: { disputeId: 'dp_1' },
        },
      ]);

      await handleChargeDisputeCreated(fullDispute);

      expect(record).not.toHaveBeenCalled();
    });

    it('does not treat an unrelated dispute_opened row as a duplicate', async () => {
      getByUserId.mockResolvedValueOnce([
        {
          userId: 'u1',
          timestamp: '2026-08-13T10:00:00.000Z',
          eventType: 'dispute_opened',
          amount: 4200,
          currency: 'usd',
          status: 'disputed',
          metadata: { disputeId: 'dp_OTHER' },
        },
      ]);

      await handleChargeDisputeCreated(fullDispute);

      expect(record).toHaveBeenCalledTimes(1);
    });

    it('records the true reversal outcome when no current-month grant exists to revoke', async () => {
      mockReverse.mockResolvedValueOnce({ reversed: false, billingUserId: 'u1', ledger: {} as any });

      await handleChargeDisputeCreated(fullDispute);

      expect(record).toHaveBeenCalledTimes(1);
      const arg = (record.mock.calls[0]![0] as any);
      expect(arg.status).toBe('disputed_no_action');
      expect(arg.metadata).toMatchObject({
        revokedMicroUsd: 0,
        reversalOutcome: 'no_current_month_grant',
      });
    });

    it('records the revoked amount when the reversal succeeds', async () => {
      await handleChargeDisputeCreated(fullDispute);

      const arg = (record.mock.calls[0]![0] as any);
      expect(arg.status).toBe('disputed');
      expect(arg.metadata).toMatchObject({
        revokedMicroUsd: 10_000_000,
        reversalOutcome: 'revoked',
      });
    });
  });

  describe('dispute closed', () => {
    it('does not restore capacity when the dispute is won', async () => {
      await handleChargeDisputeClosed({ ...fullDispute, status: 'won' });

      expect(mockGrant).not.toHaveBeenCalled();
    });

    it('leaves the revocation standing when the dispute is lost', async () => {
      await handleChargeDisputeClosed({ ...fullDispute, status: 'lost' });

      expect(mockGrant).not.toHaveBeenCalled();
      expect(mockReverse).not.toHaveBeenCalled();
    });

    it('skips a duplicate dispute_closed row when the same disputeId is already recorded', async () => {
      getByUserId.mockResolvedValueOnce([
        {
          userId: 'u1',
          timestamp: '2026-08-13T10:00:00.000Z',
          eventType: 'dispute_closed',
          amount: 2500,
          currency: 'usd',
          status: 'won',
          metadata: { disputeId: 'dp_1' },
        },
      ]);

      await handleChargeDisputeClosed({ ...fullDispute, status: 'won' });

      expect(record).not.toHaveBeenCalled();
    });

    it('records dispute_closed even when a prior dispute_opened row for the same id exists — different event types are not duplicates', async () => {
      getByUserId.mockResolvedValueOnce([
        {
          userId: 'u1',
          timestamp: '2026-08-13T10:00:00.000Z',
          eventType: 'dispute_opened',
          amount: 2500,
          currency: 'usd',
          status: 'disputed',
          metadata: { disputeId: 'dp_1' },
        },
      ]);

      await handleChargeDisputeClosed({ ...fullDispute, status: 'won' });

      expect(record).toHaveBeenCalledTimes(1);
    });
  });
});
