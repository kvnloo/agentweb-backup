jest.mock('aws-sdk', () => {
  const mockDynamoDB = { delete: jest.fn() };
  return {
    DynamoDB: { DocumentClient: jest.fn(() => mockDynamoDB) },
    S3: jest.fn(() => ({})),
    config: { update: jest.fn() },
  };
});

import AWS from 'aws-sdk';
import { socialEngagementTrackingDb } from '../services/db';

describe('socialEngagementTrackingDb.deleteEngagement', () => {
  let mockDynamoDB: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const DocumentClient = AWS.DynamoDB.DocumentClient as any;
    mockDynamoDB = new DocumentClient();
    mockDynamoDB.delete.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
  });

  it('deletes only the still-queued reservation owned by this schedule', async () => {
    await socialEngagementTrackingDb.deleteEngagement({
      userId: 'user-1',
      postId: 'urn:li:share:123',
      engagingAccountId: 'account-1',
      actionType: 'like',
      scheduleId: 'old-schedule',
    });

    expect(mockDynamoDB.delete).toHaveBeenCalledWith(expect.objectContaining({
      Key: {
        userId: 'user-1',
        postId_engagingAccountId: 'urn:li:share:123#account-1#like',
      },
      ConditionExpression: 'scheduleId = :scheduleId AND #status = :queued',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':scheduleId': 'old-schedule',
        ':queued': 'queued',
      },
    }));
  });

  it('leaves a newer reservation in place when its schedule ID no longer matches', async () => {
    mockDynamoDB.delete.mockReturnValue({
      promise: jest.fn().mockRejectedValue(
        Object.assign(new Error('conditional failed'), { code: 'ConditionalCheckFailedException' }),
      ),
    });

    await expect(socialEngagementTrackingDb.deleteEngagement({
      userId: 'user-1',
      postId: 'urn:li:share:123',
      engagingAccountId: 'account-1',
      actionType: 'like',
      scheduleId: 'old-schedule',
    })).resolves.toBe(false);
  });
});
