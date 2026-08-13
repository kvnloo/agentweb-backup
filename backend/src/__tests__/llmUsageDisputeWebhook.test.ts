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

const DISPUTE_CREATED_SEC = 1_800_000_000; // deterministic sample; Stripe-shape unix seconds
// Kept in sync with disputeIdOffsetMs() in stripeService.ts. Recompute here
// so the assertions catch any drift in the offset formula.
function idOffsetFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 500;
}
const DISPUTE_OPENED_TS = new Date(
  DISPUTE_CREATED_SEC * 1000 + idOffsetFor('dp_1'),
).toISOString();
const DISPUTE_CLOSED_TS = new Date(
  DISPUTE_CREATED_SEC * 1000 + idOffsetFor('dp_1') + 500,
).toISOString();

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

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    mockStripe.charges.retrieve.mockResolvedValue(topUpCharge);
    getUser = jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: 'u1' } as any);
    record = jest.spyOn(paymentHistoryDb, 'record').mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    getUser.mockRestore();
    record.mockRestore();
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

    it('uses a deterministic timestamp derived from dispute.created so webhook redelivery replaces the same history row', async () => {
      await handleChargeDisputeCreated(fullDispute);

      expect(record).toHaveBeenCalledTimes(1);
      const arg = (record.mock.calls[0]![0] as any);
      expect(arg.timestamp).toBe(DISPUTE_OPENED_TS);
    });

    it('separates two disputes that share the same dispute.created second by hashing the dispute id into the timestamp offset', async () => {
      await handleChargeDisputeCreated(fullDispute);
      const firstTs = (record.mock.calls[0]![0] as any).timestamp;

      // Same createdSec, different dispute id → must produce a different sort
      // key so the second dispute's audit row is not silently overwritten by
      // the first one's Put.
      await handleChargeDisputeCreated({ ...fullDispute, id: 'dp_2' });
      const secondTs = (record.mock.calls[1]![0] as any).timestamp;

      expect(firstTs).not.toBe(secondTs);
      // Both must still be inside the same wall-clock second (baseMs ..
      // baseMs+999) — the offset stays under 1000ms.
      const baseMs = DISPUTE_CREATED_SEC * 1000;
      expect(new Date(firstTs).getTime()).toBeGreaterThanOrEqual(baseMs);
      expect(new Date(firstTs).getTime()).toBeLessThan(baseMs + 1000);
      expect(new Date(secondTs).getTime()).toBeGreaterThanOrEqual(baseMs);
      expect(new Date(secondTs).getTime()).toBeLessThan(baseMs + 1000);
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

    it('uses a deterministic timestamp 1ms after the opened row, so redelivery collapses and opened/closed stay distinct', async () => {
      await handleChargeDisputeClosed({ ...fullDispute, status: 'won' });

      expect(record).toHaveBeenCalledTimes(1);
      const arg = (record.mock.calls[0]![0] as any);
      expect(arg.timestamp).toBe(DISPUTE_CLOSED_TS);
    });
  });
});
