jest.mock('aws-sdk', () => {
  const mockDynamoDB = {
    get: jest.fn(),
    query: jest.fn(),
  };

  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDynamoDB),
    },
    S3: jest.fn(() => ({})),
    config: { update: jest.fn() },
  };
});

import AWS from 'aws-sdk';
import { userDb } from '../services/db';

describe('userDb.getUserByIdConsistent', () => {
  let mockDynamoDB: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const DocumentClient = AWS.DynamoDB.DocumentClient as any;
    mockDynamoDB = new DocumentClient();
  });

  it('resolves the index email then reads the current primary-key record strongly', async () => {
    mockDynamoDB.query.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Items: [{ userId: 'user-1', email: 'rui@example.com' }] }),
    });
    mockDynamoDB.get.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Item: { userId: 'user-1', email: 'rui@example.com', connected_accounts: [] } }),
    });

    const result = await userDb.getUserByIdConsistent('user-1');

    expect(result).toEqual(expect.objectContaining({ userId: 'user-1', email: 'rui@example.com' }));
    expect(mockDynamoDB.get).toHaveBeenCalledWith(expect.objectContaining({
      Key: { email: 'rui@example.com' },
      ConsistentRead: true,
    }));
  });

  it('fails closed when the UserIdIndex cannot resolve the primary key', async () => {
    mockDynamoDB.query.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Items: [] }),
    });

    await expect(userDb.getUserByIdConsistent('user-1')).resolves.toBeUndefined();
    expect(mockDynamoDB.get).not.toHaveBeenCalled();
  });

  it('fails closed when the strongly read record belongs to a different user', async () => {
    mockDynamoDB.query.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Items: [{ userId: 'user-1', email: 'rui@example.com' }] }),
    });
    mockDynamoDB.get.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Item: { userId: 'user-2', email: 'rui@example.com' } }),
    });

    await expect(userDb.getUserByIdConsistent('user-1')).resolves.toBeUndefined();
  });
});
