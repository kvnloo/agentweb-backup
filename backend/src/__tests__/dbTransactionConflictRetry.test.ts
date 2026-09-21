// Tests for the TransactionConflictException retry wrapper shared by
// userDb.updateUser and orgDb.updateOrg (ENG-1955 follow-up).
//
// A plain UpdateItem on a user/org row can lose a race against a
// TransactWriteItems call touching the SAME item — e.g. onboarding's
// marketStrategy mirror (updateUser) landing at the exact moment the LLM
// usage-credit ledger (transactWrite) meters the ICP generation call that
// just completed on that same user row. Observed live: a fresh onboarding's
// marketStrategy.icp ended up completely empty because of exactly this race
// — mirrorIcpsToMarketStrategy treats the write as best-effort and only
// logs on failure, so the write was lost outright with no retry. AWS
// documents TransactionConflictException as an expected, transient
// condition to retry, not a permanent failure.

jest.mock('aws-sdk', () => {
  const mockDynamoDB = {
    get: jest.fn(),
    query: jest.fn(),
    update: jest.fn(),
  };

  const mockS3 = {
    putObject: jest.fn().mockReturnThis(),
    getObject: jest.fn().mockReturnThis(),
    deleteObject: jest.fn().mockReturnThis(),
    promise: jest.fn().mockResolvedValue({}),
  };

  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDynamoDB),
    },
    S3: jest.fn(() => mockS3),
    config: {
      update: jest.fn(),
    },
  };
});

import AWS from 'aws-sdk';
import { userDb, orgDb } from '../services/db';

const transactionConflict = () =>
  Object.assign(new Error('Transaction is ongoing for the item'), {
    code: 'TransactionConflictException',
  });

describe('TransactionConflictException retry — userDb.updateUser', () => {
  let mockDynamoDB: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const DocumentClient = AWS.DynamoDB.DocumentClient as any;
    mockDynamoDB = new DocumentClient();
    mockDynamoDB.query.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Items: [{ userId: 'u1', email: 'u1@example.com' }],
      }),
    });
  });

  it('retries on TransactionConflictException and succeeds once the conflict clears', async () => {
    mockDynamoDB.update
      .mockReturnValueOnce({ promise: jest.fn().mockRejectedValue(transactionConflict()) })
      .mockReturnValueOnce({ promise: jest.fn().mockRejectedValue(transactionConflict()) })
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({ Attributes: { userId: 'u1', icpResult: [] } }),
      });

    const result = await userDb.updateUser('u1', { icpResult: [] } as any);

    expect(mockDynamoDB.update).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ userId: 'u1', icpResult: [] });
  });

  it('gives up after the attempt cap and throws the conflict, rather than retrying forever', async () => {
    mockDynamoDB.update.mockReturnValue({
      promise: jest.fn().mockRejectedValue(transactionConflict()),
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(userDb.updateUser('u1', { icpResult: [] } as any)).rejects.toMatchObject({
      code: 'TransactionConflictException',
    });
    // Bounded — not an infinite or unreasonably long retry loop.
    expect(mockDynamoDB.update.mock.calls.length).toBeGreaterThan(1);
    expect(mockDynamoDB.update.mock.calls.length).toBeLessThanOrEqual(4);

    errSpy.mockRestore();
  });

  it('does NOT retry a non-conflict error — fails immediately on the first attempt', async () => {
    mockDynamoDB.update.mockReturnValue({
      promise: jest.fn().mockRejectedValue(
        Object.assign(new Error('boom'), { code: 'ProvisionedThroughputExceededException' }),
      ),
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(userDb.updateUser('u1', { icpResult: [] } as any)).rejects.toThrow('boom');
    expect(mockDynamoDB.update).toHaveBeenCalledTimes(1);

    errSpy.mockRestore();
  });
});

describe('TransactionConflictException retry — orgDb.updateOrg', () => {
  let mockDynamoDB: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const DocumentClient = AWS.DynamoDB.DocumentClient as any;
    mockDynamoDB = new DocumentClient();
  });

  it('retries on TransactionConflictException and succeeds once the conflict clears', async () => {
    mockDynamoDB.update
      .mockReturnValueOnce({ promise: jest.fn().mockRejectedValue(transactionConflict()) })
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({ Attributes: { orgId: 'org1' } }),
      });

    const result = await orgDb.updateOrg('org1', { marketStrategy: { icp: [] } } as any);

    expect(mockDynamoDB.update).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ orgId: 'org1' });
  });

  it('does NOT retry a non-conflict error — fails immediately', async () => {
    mockDynamoDB.update.mockReturnValue({
      promise: jest.fn().mockRejectedValue(
        Object.assign(new Error('boom'), { code: 'ValidationException' }),
      ),
    });

    await expect(
      orgDb.updateOrg('org1', { marketStrategy: { icp: [] } } as any),
    ).rejects.toThrow('boom');
    expect(mockDynamoDB.update).toHaveBeenCalledTimes(1);
  });
});
