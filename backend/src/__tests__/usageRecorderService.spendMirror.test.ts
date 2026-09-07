/**
 * The ENG-1250 §9 dual-write seam itself: recordVendorUsage must mirror into
 * the spend ledger, and must be completely unaffected when that mirror fails.
 *
 * Separate from spendLedgerDualWrite.test.ts because this mocks the shim to
 * observe the call, where that suite mocks the store to test the shim.
 */
jest.mock('../services/spendLedgerDualWrite', () => ({
  mirrorVendorUsage: jest.fn(),
}));
jest.mock('../services/usageRecordDb', () => ({
  usageRecordDb: { incrementUsage: jest.fn() },
}));

import { recordVendorUsage } from '../services/usageRecorderService';
import { mirrorVendorUsage } from '../services/spendLedgerDualWrite';
import { usageRecordDb } from '../services/usageRecordDb';

const mockMirror = mirrorVendorUsage as jest.Mock;
const mockIncrement = usageRecordDb.incrementUsage as jest.Mock;

const ctx = {
  userId: 'user-1',
  billingUserId: 'owner-1',
  sessionId: 's-1',
  provider: 'you.com',
  operation: 'query',
  feature: 'agent-search',
  unit: 'query',
  quantity: 1,
  costSource: 'allocated' as const,
  costUsd: 0.0125,
};

describe('recordVendorUsage -> spend ledger mirror', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMirror.mockResolvedValue({ status: 'written' });
    mockIncrement.mockResolvedValue(undefined);
  });

  it('mirrors every metered vendor call', async () => {
    await recordVendorUsage(ctx);

    expect(mockMirror).toHaveBeenCalledTimes(1);
    expect(mockMirror.mock.calls[0][0]).toMatchObject({
      provider: 'you.com',
      operation: 'query',
      unit: 'query',
      quantity: 1,
      costSource: 'allocated',
      costUsd: 0.0125,
      billingUserId: 'owner-1',
      userId: 'user-1',
      sessionId: 's-1',
    });
  });

  it('still writes the original ledger row', async () => {
    await recordVendorUsage(ctx);

    expect(mockIncrement).toHaveBeenCalledTimes(1);
    expect(mockIncrement.mock.calls[0][0]).toMatchObject({ billingUserId: 'owner-1', costMicroUsd: 12500 });
  });

  it('stamps both rows from ONE instant, so they cannot straddle UTC midnight', async () => {
    // A plain assertion here proves nothing: two clock reads microseconds apart
    // agree on the date almost always, so the test would pass against a second
    // `new Date()`. Pinning the clock and pushing it over midnight DURING the
    // live write is what makes the single-read guarantee observable.
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-09-07T23:59:59.500Z'));
      mockIncrement.mockImplementation(async () => {
        jest.setSystemTime(new Date('2026-09-08T00:00:01.000Z'));
      });

      await recordVendorUsage(ctx);

      const mirroredAt: string = mockMirror.mock.calls[0][1];
      const legacyDate: string = mockIncrement.mock.calls[0][0].date;

      expect(legacyDate).toBe('2026-09-07');
      // A second clock read would stamp this 2026-09-08 and put the two rows in
      // different days — and the reconciliation would read that as drift.
      expect(mirroredAt).toBe('2026-09-07T23:59:59.500Z');
      expect(mirroredAt.slice(0, 10)).toBe(legacyDate);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a mirror rejection never escapes into the metering path', async () => {
    mockMirror.mockRejectedValue(new Error('ledger exploded'));

    await expect(recordVendorUsage(ctx)).resolves.toBeUndefined();
    expect(mockIncrement).toHaveBeenCalledTimes(1);
  });

  it('a reported mirror failure never escapes either', async () => {
    mockMirror.mockResolvedValue({ status: 'failed', reason: 'DynamoDB is down' });

    await expect(recordVendorUsage(ctx)).resolves.toBeUndefined();
    expect(mockIncrement).toHaveBeenCalledTimes(1);
  });

  // CodeRabbit, PR #2793: the shadow mirrors the live rail, it never leads it.
  it('does NOT mirror a row the live rail failed to write', async () => {
    mockIncrement.mockRejectedValue(new Error('usage table down'));

    await expect(recordVendorUsage(ctx)).resolves.toBeUndefined();
    // A ledger row with no matching usage record is not the difference §8
    // exists to measure — it is an outage artifact, and §8 cannot tell them
    // apart.
    expect(mockMirror).not.toHaveBeenCalled();
  });
});
