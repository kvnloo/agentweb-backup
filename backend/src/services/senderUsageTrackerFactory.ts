/**
 * Wires the DynamoDB (AW-Configs) deps for DynamoSenderUsageTracker.
 *
 * Kept separate from senderUsageTracker.ts so that file stays free of AWS
 * imports for fast unit tests — mirrors apolloServiceFactory.ts's split from
 * apolloQuota.ts.
 */

import AWS from 'aws-sdk';
import { DynamoSenderUsageTracker, senderUsageConfigId, type SenderUsageRow, type SenderUsageTracker } from './senderUsageTracker';

const TABLE_PREFIX = process.env.NODE_ENV === 'production' ? '' : 'Dev-';
const CONFIGS_TABLE = `${TABLE_PREFIX}AW-Configs`;

function buildSenderUsageTracker(): SenderUsageTracker {
  const dynamodb = new AWS.DynamoDB.DocumentClient();

  /**
   * Race-safe day-rollover increment. Mirrors apolloServiceFactory.ts's
   * safeIncrement — see that file for full rationale.
   */
  async function safeIncrement(userId: string, senderId: string, today: string): Promise<void> {
    const key = { userId, configId: senderUsageConfigId(senderId) };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await dynamodb.update({
          TableName: CONFIGS_TABLE,
          Key: key,
          UpdateExpression: 'ADD sentCount :one',
          ConditionExpression: '#date = :today',
          ExpressionAttributeNames: { '#date': 'date' },
          ExpressionAttributeValues: { ':one': 1, ':today': today },
        }).promise();
        return;
      } catch (err: any) {
        if (err.code !== 'ConditionalCheckFailedException') throw err;
        try {
          await dynamodb.put({
            TableName: CONFIGS_TABLE,
            Item: { ...key, date: today, sentCount: 1 },
            ConditionExpression: 'attribute_not_exists(userId) OR #date <> :today',
            ExpressionAttributeNames: { '#date': 'date' },
            ExpressionAttributeValues: { ':today': today },
          }).promise();
          return;
        } catch (putErr: any) {
          if (putErr.code !== 'ConditionalCheckFailedException') throw putErr;
        }
      }
    }
    await dynamodb.put({
      TableName: CONFIGS_TABLE,
      Item: { ...key, date: today, sentCount: 1 },
    }).promise();
  }

  return new DynamoSenderUsageTracker({
    async readUsage(userId: string, senderId: string): Promise<SenderUsageRow | null> {
      const r = await dynamodb.get({
        TableName: CONFIGS_TABLE,
        Key: { userId, configId: senderUsageConfigId(senderId) },
      }).promise();
      if (!r.Item) return null;
      return { date: r.Item.date, sentCount: r.Item.sentCount ?? 0 };
    },
    async incrementUsage(userId: string, senderId: string, today: string): Promise<void> {
      await safeIncrement(userId, senderId, today);
    },
  });
}

export const senderUsageTracker: SenderUsageTracker = buildSenderUsageTracker();
