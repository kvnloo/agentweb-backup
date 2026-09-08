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
import {
  getDroppedWriteTotals,
  resetDroppedWriteState,
  setDroppedWriteAlertSink,
} from '../services/usageWriteFailureMonitor';
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
    resetDroppedWriteState();
    setDroppedWriteAlertSink(() => {});
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

  describe('retry and surface (AC3 / AC6)', () => {
    it('retries a transient failure and succeeds without recording a loss', async () => {
      mockTxn
        .mockRejectedValueOnce(Object.assign(new Error('throttled'), { code: 'ThrottlingException' }))
        .mockResolvedValue('applied');

      await recordVendorUsage(ctx({ idempotencyKey: 'k' }));

      expect(mockTxn).toHaveBeenCalledTimes(2);
      expect(getDroppedWriteTotals()).toEqual({ count: 0, lostMicroUsd: 0 });
    });

    it('retries a transaction conflict — the write did not happen at all', async () => {
      mockTxn.mockResolvedValueOnce('conflict').mockResolvedValue('applied');

      await recordVendorUsage(ctx({ idempotencyKey: 'k' }));

      expect(mockTxn).toHaveBeenCalledTimes(2);
      expect(getDroppedWriteTotals().count).toBe(0);
    });

    it('surfaces an exhausted write as a counted loss, with the money', async () => {
      mockTxn.mockRejectedValue(Object.assign(new Error('throttled'), { code: 'ThrottlingException' }));

      await expect(recordVendorUsage(ctx({ idempotencyKey: 'k' }))).resolves.toBeUndefined();

      expect(mockTxn).toHaveBeenCalledTimes(3);
      expect(getDroppedWriteTotals()).toEqual({ count: 1, lostMicroUsd: 12500 });
    });

    it('does not retry a permanent failure, but still counts it', async () => {
      mockTxn.mockRejectedValue(Object.assign(new Error('bad'), { code: 'ValidationException' }));

      await recordVendorUsage(ctx({ idempotencyKey: 'k' }));

      expect(mockTxn).toHaveBeenCalledTimes(1);
      expect(getDroppedWriteTotals().count).toBe(1);
    });

    it('a successful write after an outage flushes the final alert window', async () => {
      // Otherwise the last batch of a finished outage is never reported, since
      // windows only close when a LATER drop arrives.
      const alerts: unknown[] = [];
      setDroppedWriteAlertSink((summary) => alerts.push(summary));

      mockTxn.mockRejectedValue(Object.assign(new Error('down'), { code: 'ValidationException' }));
      await recordVendorUsage(ctx({ idempotencyKey: 'a' }));
      expect(alerts).toHaveLength(0);

      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
      mockTxn.mockResolvedValue('applied');
      await recordVendorUsage(ctx({ idempotencyKey: 'b' }));

      expect(alerts).toHaveLength(1);
      jest.spyOn(Date, 'now').mockRestore();
    });

    it.each([
      ['unpriced keyed', { idempotencyKey: 'b', costSource: 'unpriced' as const, costUsd: undefined }],
      ['tokenless legacy', {}],
    ])('a successful %s write also flushes the final alert window', async (_label, success) => {
      // CodeRabbit, PR #2807: recovery through these paths left the window open
      // until some unrelated priced+keyed write happened to occur.
      const alerts: unknown[] = [];
      setDroppedWriteAlertSink((summary) => alerts.push(summary));

      mockTxn.mockRejectedValue(Object.assign(new Error('down'), { code: 'ValidationException' }));
      await recordVendorUsage(ctx({ idempotencyKey: 'a' }));
      expect(alerts).toHaveLength(0);

      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
      await recordVendorUsage(ctx(success));

      expect(alerts).toHaveLength(1);
      jest.spyOn(Date, 'now').mockRestore();
    });

    it('retries a tokenless call too, now that every call carries a minted id', async () => {
      // Before ENG-1250 §6 the tokenless path could not be retried safely: its
      // unconditional ADD would double-count after a lost response. With a
      // minted id the replay dedupes, so AC3's retry is now universally safe.
      mockTxn.mockRejectedValue(Object.assign(new Error('throttled'), { code: 'ThrottlingException' }));

      await recordVendorUsage(ctx());

      expect(mockTxn).toHaveBeenCalledTimes(3);
      expect(getDroppedWriteTotals()).toEqual({ count: 1, lostMicroUsd: 12500 });
    });
  });

  describe('without a token — every vendor call still takes the atomic path', () => {
    it('uses the transaction even when the call site supplies no token', async () => {
      // ENG-1250 §6: threading a minted nonce through eleven call sites would
      // buy nothing the central mint does not, so the floor is raised here.
      await recordVendorUsage(ctx());

      expect(mockTxn).toHaveBeenCalledTimes(1);
      expect(mockPlain).not.toHaveBeenCalled();
    });

    it('mints a marked event id so a retry cannot double-count', async () => {
      await recordVendorUsage(ctx());

      expect(mockTxn.mock.calls[0][1].eventId).toMatch(/^gen:/);
    });

    it('gives distinct ids to two separate calls', async () => {
      await recordVendorUsage(ctx());
      await recordVendorUsage(ctx());

      expect(mockTxn.mock.calls[0][1].eventId).not.toBe(mockTxn.mock.calls[1][1].eventId);
    });
  });

  describe('fallback when the ledger transaction fails', () => {
    beforeEach(() => {
      mockTxn.mockRejectedValue(Object.assign(new Error('down'), { code: 'ValidationException' }));
    });

    it('still lands the LIVE row, so one table\'s outage does not stop both rails', async () => {
      await recordVendorUsage(ctx({ idempotencyKey: 'k' }));

      expect(mockPlain).toHaveBeenCalledTimes(1);
      expect(mockMirror).toHaveBeenCalledTimes(1);
    });

    it('still counts the lost ledger write', async () => {
      await recordVendorUsage(ctx({ idempotencyKey: 'k' }));

      expect(getDroppedWriteTotals()).toEqual({ count: 1, lostMicroUsd: 12500 });
    });

    it('never throws even when the fallback fails too, and counts the loss ONCE', async () => {
      // Both catches would otherwise fire for one lost write, inflating the
      // lost-dollars figure AC3 exists to make trustworthy.
      mockPlain.mockRejectedValue(new Error('usage table down as well'));

      await expect(recordVendorUsage(ctx({ idempotencyKey: 'k' }))).resolves.toBeUndefined();
      expect(getDroppedWriteTotals()).toEqual({ count: 1, lostMicroUsd: 12500 });
    });
  });
});
