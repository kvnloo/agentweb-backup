/**
 * ENG-702 AC1: submitting the same vendor usage event twice increases recorded
 * spend once.
 *
 * The property that matters is that BOTH rails move together. Deduping the
 * spend event while the daily aggregate lands a second time is the exact defect
 * ENG-1251 was raised to close on the LLM side, so a test that only checks the
 * event would pass against the bug this exists to prevent.
 */
jest.mock('../services/usageRecordDb', () => {
  const actual = jest.requireActual('../services/usageRecordDb');
  return {
    ...actual,
    usageRecordDb: {
      ...actual.usageRecordDb,
      incrementUsage: jest.fn(),
      incrementUsageWithSpendEvent: jest.fn(),
    },
  };
});
jest.mock('../services/spendLedgerDualWrite', () => {
  const actual = jest.requireActual('../services/spendLedgerDualWrite');
  return { ...actual, mirrorVendorUsage: jest.fn() };
});

import { recordVendorUsage, RecordVendorUsageContext } from '../services/usageRecorderService';
import { usageRecordDb } from '../services/usageRecordDb';
import { mirrorVendorUsage } from '../services/spendLedgerDualWrite';

const mockTxn = usageRecordDb.incrementUsageWithSpendEvent as jest.Mock;
const mockPlain = usageRecordDb.incrementUsage as jest.Mock;
const mockMirror = mirrorVendorUsage as jest.Mock;

const ctx = (over: Partial<RecordVendorUsageContext> = {}): RecordVendorUsageContext => ({
  userId: 'user-1',
  billingUserId: 'owner-1',
  provider: 'you.com',
  operation: 'query',
  feature: 'agent-search',
  unit: 'query',
  quantity: 1,
  costSource: 'allocated',
  costUsd: 0.0125,
  ...over,
});

describe('recordVendorUsage — idempotent vendor writes (ENG-702 AC1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTxn.mockResolvedValue('applied');
    mockPlain.mockResolvedValue(undefined);
    mockMirror.mockResolvedValue({ status: 'written' });
  });

  describe('with an idempotency token', () => {
    it('writes both rails in ONE transaction', async () => {
      await recordVendorUsage(ctx({ idempotencyKey: 'vendor-req-42' }));

      expect(mockTxn).toHaveBeenCalledTimes(1);
      // and NOT as two independent writes
      expect(mockPlain).not.toHaveBeenCalled();
      expect(mockMirror).not.toHaveBeenCalled();
    });

    it('carries the token as the spend event id', async () => {
      await recordVendorUsage(ctx({ idempotencyKey: 'vendor-req-42' }));

      expect(mockTxn.mock.calls[0][1].eventId).toBe('vendor-req-42');
    });

    it('sends an aggregate row and a spend event that agree on cost and subject', async () => {
      await recordVendorUsage(ctx({ idempotencyKey: 'k' }));

      const [increment, event] = mockTxn.mock.calls[0];
      expect(increment.costMicroUsd).toBe(12500);
      expect(event.costMicroUsd).toBe(12500);
      expect(increment.billingUserId).toBe('owner-1');
      expect(event.billingUserId).toBe('owner-1');
      expect(increment.date).toBe(event.occurredAt.slice(0, 10));
    });

    it('a replayed token is reported as duplicate and adds nothing', async () => {
      mockTxn.mockResolvedValue('duplicate');

      await expect(recordVendorUsage(ctx({ idempotencyKey: 'k' }))).resolves.toBeUndefined();

      // One attempt, no fallback write — the aggregate contribution is skipped
      // together with the event, which is the whole point.
      expect(mockTxn).toHaveBeenCalledTimes(1);
      expect(mockPlain).not.toHaveBeenCalled();
    });

    it('never throws when the transaction fails', async () => {
      // Every caller is fire-and-forget; a rejection here is an unhandled
      // promise rejection and takes the process down.
      mockTxn.mockRejectedValue(new Error('DynamoDB is down'));

      await expect(recordVendorUsage(ctx({ idempotencyKey: 'k' }))).resolves.toBeUndefined();
    });

    it('never throws on a transaction conflict', async () => {
      mockTxn.mockResolvedValue('conflict');

      await expect(recordVendorUsage(ctx({ idempotencyKey: 'k' }))).resolves.toBeUndefined();
    });

    it('falls back to the plain write for an unpriced call', async () => {
      // The billing boundary forbids an unpriced unit becoming a $0 spend
      // event, so there is no event to make the aggregate idempotent against.
      await recordVendorUsage(ctx({ idempotencyKey: 'k', costSource: 'unpriced', costUsd: undefined }));

      expect(mockTxn).not.toHaveBeenCalled();
      expect(mockPlain).toHaveBeenCalledTimes(1);
    });
  });

  describe('without a token — the legacy path is unchanged', () => {
    it('writes the aggregate, then mirrors fail-open', async () => {
      await recordVendorUsage(ctx());

      expect(mockPlain).toHaveBeenCalledTimes(1);
      expect(mockMirror).toHaveBeenCalledTimes(1);
      expect(mockTxn).not.toHaveBeenCalled();
    });

    it('still does not mirror when the live write fails', async () => {
      mockPlain.mockRejectedValue(new Error('usage table down'));

      await expect(recordVendorUsage(ctx())).resolves.toBeUndefined();
      expect(mockMirror).not.toHaveBeenCalled();
    });
  });
});
