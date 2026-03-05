// Tests for DynamoDB pagination in getAllTaskExecutionsByUserId

const queryPromiseMock = jest.fn();

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: queryPromiseMock })),
      get: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      scan: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Location: '', Key: '' }) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getSignedUrl: jest.fn(),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
  })),
}));

import { taskDb } from '../services/db';

describe('getAllTaskExecutionsByUserId pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return all items from a single page', async () => {
    queryPromiseMock.mockResolvedValueOnce({
      Items: [
        { executionId: 'exec-1', userId: 'user-1', status: 'completed' },
        { executionId: 'exec-2', userId: 'user-1', status: 'completed' },
      ],
    });

    const result = await taskDb.getAllTaskExecutionsByUserId('user-1');

    expect(result).toHaveLength(2);
    expect(result![0].executionId).toBe('exec-1');
    expect(result![1].executionId).toBe('exec-2');
    expect(queryPromiseMock).toHaveBeenCalledTimes(1);
  });

  it('should paginate through multiple DynamoDB pages', async () => {
    // Page 1
    queryPromiseMock.mockResolvedValueOnce({
      Items: [
        { executionId: 'exec-1', userId: 'user-1' },
        { executionId: 'exec-2', userId: 'user-1' },
      ],
      LastEvaluatedKey: { userId: 'user-1', startTime: '2024-01-01T00:00:00Z' },
    });
    // Page 2
    queryPromiseMock.mockResolvedValueOnce({
      Items: [
        { executionId: 'exec-3', userId: 'user-1' },
        { executionId: 'exec-4', userId: 'user-1' },
      ],
      LastEvaluatedKey: { userId: 'user-1', startTime: '2024-01-02T00:00:00Z' },
    });
    // Page 3 (last)
    queryPromiseMock.mockResolvedValueOnce({
      Items: [
        { executionId: 'exec-5', userId: 'user-1' },
      ],
    });

    const result = await taskDb.getAllTaskExecutionsByUserId('user-1');

    expect(result).toHaveLength(5);
    expect(result!.map((e: any) => e.executionId)).toEqual([
      'exec-1', 'exec-2', 'exec-3', 'exec-4', 'exec-5',
    ]);
    expect(queryPromiseMock).toHaveBeenCalledTimes(3);
  });

  it('should return empty array when no items exist', async () => {
    queryPromiseMock.mockResolvedValueOnce({
      Items: [],
    });

    const result = await taskDb.getAllTaskExecutionsByUserId('user-no-data');

    expect(result).toHaveLength(0);
    expect(queryPromiseMock).toHaveBeenCalledTimes(1);
  });

  it('should handle empty Items on a page with LastEvaluatedKey', async () => {
    // Page 1: empty but has more
    queryPromiseMock.mockResolvedValueOnce({
      Items: [],
      LastEvaluatedKey: { userId: 'user-1', startTime: '2024-01-01T00:00:00Z' },
    });
    // Page 2: has data, done
    queryPromiseMock.mockResolvedValueOnce({
      Items: [{ executionId: 'exec-1', userId: 'user-1' }],
    });

    const result = await taskDb.getAllTaskExecutionsByUserId('user-1');

    expect(result).toHaveLength(1);
    expect(queryPromiseMock).toHaveBeenCalledTimes(2);
  });
});
