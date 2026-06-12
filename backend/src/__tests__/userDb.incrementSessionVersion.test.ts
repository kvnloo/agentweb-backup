import AWS from 'aws-sdk';

// Mock AWS SDK
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

import { userDb } from '../services/db';

describe('userDb.incrementSessionVersion', () => {
  let mockDynamoDB: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const DocumentClient = AWS.DynamoDB.DocumentClient as any;
    mockDynamoDB = new DocumentClient();
  });

  it('atomically bumps sessionVersion via if_not_present and returns the new value', async () => {
    // getUserById resolves email via the UserIdIndex query
    mockDynamoDB.query.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Items: [{ userId: 'user-1', email: 'user@example.com' }],
      }),
    });
    mockDynamoDB.update.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Attributes: { sessionVersion: 1 } }),
    });

    const result = await userDb.incrementSessionVersion('user-1');

    expect(result).toBe(1);
    expect(mockDynamoDB.update).toHaveBeenCalledWith(
      expect.objectContaining({
        Key: { email: 'user@example.com' },
        UpdateExpression: 'SET #sv = if_not_present(#sv, :zero) + :one',
        ExpressionAttributeNames: { '#sv': 'sessionVersion' },
        ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
        ReturnValues: 'UPDATED_NEW',
      })
    );
  });

  it('throws when the user does not exist', async () => {
    mockDynamoDB.query.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Items: [] }),
    });

    await expect(userDb.incrementSessionVersion('missing-user')).rejects.toThrow();
    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });
});
