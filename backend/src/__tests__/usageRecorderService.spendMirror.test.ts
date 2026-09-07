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
    await recordVendorUsage(ctx);

    const mirroredAt: string = mockMirror.mock.calls[0][1];
    const legacyDate: string = mockIncrement.mock.calls[0][0].date;

    expect(mirroredAt.slice(0, 10)).toBe(legacyDate);
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

  it('a failure in the ORIGINAL rail still leaves the mirror attempted', async () => {
    mockIncrement.mockRejectedValue(new Error('usage table down'));

    await expect(recordVendorUsage(ctx)).resolves.toBeUndefined();
    expect(mockMirror).toHaveBeenCalledTimes(1);
  });
});
