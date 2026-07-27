const mockPut = jest.fn();
const mockDelete = jest.fn();

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: (...args: any[]) => ({ promise: () => mockPut(...args) }),
      delete: (...args: any[]) => ({ promise: () => mockDelete(...args) }),
    })),
  },
  S3: jest.fn(() => ({})),
}));

import { oauthSessionDb } from '../services/db';

beforeEach(() => {
  jest.clearAllMocks();
  mockPut.mockResolvedValue({});
  mockDelete.mockResolvedValue({});
});

describe('oauthSessionDb pending-session atomicity', () => {
  it('stores each pending flow as its own TTL-bounded row', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00Z'));
    await oauthSessionDb.savePending({
      sessionId: 'session-1',
      userId: 'user-1',
      provider: 'hubspot',
      data: { token: 'secret' },
    });
    jest.useRealTimers();

    expect(mockPut).toHaveBeenCalledWith({
      TableName: 'AW-OAuthSessions',
      Item: {
        sessionId: 'session-1',
        userId: 'user-1',
        provider: 'hubspot',
        data: { token: 'secret' },
        ttl: Math.floor(new Date('2026-07-27T12:10:00Z').getTime() / 1000),
      },
      ConditionExpression: 'attribute_not_exists(sessionId)',
    });
  });

  it('atomically deletes and returns only a live matching user+provider row', async () => {
    mockDelete.mockResolvedValueOnce({ Attributes: { data: { token: 'secret' } } });

    await expect(
      oauthSessionDb.consumePending('session-1', 'user-1', 'hubspot'),
    ).resolves.toEqual({ token: 'secret' });

    expect(mockDelete).toHaveBeenCalledWith(expect.objectContaining({
      TableName: 'AW-OAuthSessions',
      Key: { sessionId: 'session-1' },
      ConditionExpression: 'userId = :userId AND provider = :provider AND #ttl > :now',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: expect.objectContaining({
        ':userId': 'user-1',
        ':provider': 'hubspot',
      }),
      ReturnValues: 'ALL_OLD',
    }));
  });

  it('returns null when the row is missing, expired, mismatched, or already consumed', async () => {
    const conflict: any = new Error('condition failed');
    conflict.code = 'ConditionalCheckFailedException';
    mockDelete.mockRejectedValueOnce(conflict);

    await expect(
      oauthSessionDb.consumePending('session-1', 'user-1', 'hubspot'),
    ).resolves.toBeNull();
  });

  it('fails closed when DynamoDB cannot perform the atomic consume', async () => {
    mockDelete.mockRejectedValueOnce(new Error('Dynamo unavailable'));

    await expect(
      oauthSessionDb.consumePending('session-1', 'user-1', 'hubspot'),
    ).rejects.toThrow('Dynamo unavailable');
  });
});
