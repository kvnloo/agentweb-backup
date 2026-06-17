/**
 * Regression: getUserByResetToken must paginate the table scan.
 *
 * Dev/prod AW-Users exceeds one 1MB DynamoDB scan page (~2MB / 300+ items).
 * A single, non-paginated scan only sees the first page, so a valid reset
 * token belonging to a user beyond page 1 yields no match → the controller
 * falsely returns "Invalid or expired reset token". The lookup must follow
 * LastEvaluatedKey until the token is found or every page is exhausted.
 */

const mockScanPromise = jest.fn();
const mockScan = jest.fn(() => ({ promise: mockScanPromise }));
const mockDocClientInstance = {
  scan: mockScan,
  put: jest.fn(() => ({ promise: jest.fn() })),
  get: jest.fn(() => ({ promise: jest.fn() })),
  update: jest.fn(() => ({ promise: jest.fn() })),
  query: jest.fn(() => ({ promise: jest.fn() })),
  delete: jest.fn(() => ({ promise: jest.fn() })),
};

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => mockDocClientInstance),
  },
  S3: jest.fn(() => ({
    upload: jest.fn(() => ({ promise: jest.fn() })),
    getObject: jest.fn(() => ({ promise: jest.fn() })),
    deleteObject: jest.fn(() => ({ promise: jest.fn() })),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) })),
  })),
}));

import { userDb } from '../services/db';

beforeEach(() => {
  jest.clearAllMocks();
  mockScanPromise.mockReset();
});

describe('getUserByResetToken pagination', () => {
  it('finds a token on a later scan page (beyond the first 1MB)', async () => {
    // Page 1: no match, has more. Page 2: the matching user.
    mockScanPromise
      .mockResolvedValueOnce({ Items: [], Count: 0, LastEvaluatedKey: { userId: 'cursor-1' } })
      .mockResolvedValueOnce({
        Items: [{ userId: 'user-pg2', email: 'late@example.com', resetPasswordToken: 'tok-123' }],
        Count: 1,
      });

    const user = await userDb.getUserByResetToken('tok-123');

    expect(user).not.toBeNull();
    expect(user!.userId).toBe('user-pg2');
    expect(mockScan).toHaveBeenCalledTimes(2);
    // Second call must carry the cursor from page 1.
    const secondParams = (mockScan.mock.calls[1] as any)[0];
    expect(secondParams.ExclusiveStartKey).toEqual({ userId: 'cursor-1' });
  });

  it('stops early when the token is found on the first page', async () => {
    mockScanPromise.mockResolvedValueOnce({
      Items: [{ userId: 'user-pg1', email: 'early@example.com', resetPasswordToken: 'tok-a' }],
      Count: 1,
      LastEvaluatedKey: { userId: 'cursor-1' },
    });

    const user = await userDb.getUserByResetToken('tok-a');

    expect(user!.userId).toBe('user-pg1');
    // Found on page 1 → must NOT scan page 2 despite LastEvaluatedKey present.
    expect(mockScan).toHaveBeenCalledTimes(1);
  });

  it('returns null after exhausting all pages with no match', async () => {
    mockScanPromise
      .mockResolvedValueOnce({ Items: [], Count: 0, LastEvaluatedKey: { userId: 'c1' } })
      .mockResolvedValueOnce({ Items: [], Count: 0, LastEvaluatedKey: { userId: 'c2' } })
      .mockResolvedValueOnce({ Items: [], Count: 0 });

    const user = await userDb.getUserByResetToken('missing');

    expect(user).toBeNull();
    expect(mockScan).toHaveBeenCalledTimes(3);
  });

  it('surfaces a scan error via handleError (does not silently return a wrong user)', async () => {
    mockScanPromise.mockRejectedValueOnce(
      Object.assign(new Error('throughput exceeded'), { code: 'ProvisionedThroughputExceededException' }),
    );

    await expect(userDb.getUserByResetToken('tok-err')).rejects.toThrow(/throughput exceeded/);
    expect(mockScan).toHaveBeenCalledTimes(1);
  });

  it('keeps the resetPasswordToken + tombstone filter on every page', async () => {
    mockScanPromise
      .mockResolvedValueOnce({ Items: [], Count: 0, LastEvaluatedKey: { userId: 'c1' } })
      .mockResolvedValueOnce({ Items: [], Count: 0 });

    await userDb.getUserByResetToken('tok-x');

    for (const call of mockScan.mock.calls as any[]) {
      expect(call[0].FilterExpression).toMatch(/resetPasswordToken = :token/);
      expect(call[0].FilterExpression).toMatch(/NOT begins_with\(userId, :tombstone\)/);
      expect(call[0].ExpressionAttributeValues[':token']).toBe('tok-x');
    }
  });
});
