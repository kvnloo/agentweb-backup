/**
 * Wires the DynamoDB (AW-Configs) deps for DynamoSenderUsageTracker.
 *
 * Kept separate from senderUsageTracker.ts so that file stays free of AWS
 * imports for fast unit tests — mirrors apolloServiceFactory.ts's split from
 * apolloQuota.ts.
 */

import AWS from 'aws-sdk';
import {
  DynamoSenderUsageTracker,
  senderUsageConfigId,
  SenderDailyLimitExceededError,
  type SenderUsageRow,
  type SenderUsageTracker,
} from './senderUsageTracker';

const TABLE_PREFIX = process.env.NODE_ENV === 'production' ? '' : 'Dev-';
const CONFIGS_TABLE = `${TABLE_PREFIX}AW-Configs`;

function buildSenderUsageTracker(): SenderUsageTracker {
  const dynamodb = new AWS.DynamoDB.DocumentClient();

  /**
   * Atomic check-and-reserve. The limit check and the increment happen in one
   * conditional DynamoDB update (`sentCount < :limit` in the same
   * ConditionExpression as the `ADD`), so concurrent reservations against the
   * same sender can't all pass a check before any of them records — DynamoDB
   * evaluates the condition against the item's current state at the instant
   * of each individual write, not against a value read earlier.
   */
  async function reserve(userId: string, senderId: string, today: string, limit: number): Promise<void> {
    const key = { userId, configId: senderUsageConfigId(senderId) };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await dynamodb
          .update({
            TableName: CONFIGS_TABLE,
            Key: key,
            UpdateExpression: 'ADD sentCount :one',
            ConditionExpression: '#date = :today AND sentCount < :limit',
            ExpressionAttributeNames: { '#date': 'date' },
            ExpressionAttributeValues: { ':one': 1, ':today': today, ':limit': limit },
          })
          .promise();
        return; // reserved
      } catch (err: any) {
        if (err.code !== 'ConditionalCheckFailedException') throw err;

        // The condition can fail for two different reasons — disambiguate with a
        // strongly consistent read before deciding whether this is a real block or
        // just a missing/stale row that needs creating.
        const current = await dynamodb.get({ TableName: CONFIGS_TABLE, Key: key, ConsistentRead: true }).promise();
        const row = current.Item;
        if (row && row.date === today) {
          // Today's row exists and is genuinely at/over limit — that's why the
          // conditional update above failed. Real answer, not a race.
          throw new SenderDailyLimitExceededError(senderId, limit);
        }
        if (limit < 1) {
          throw new SenderDailyLimitExceededError(senderId, limit);
        }

        try {
          await dynamodb
            .put({
              TableName: CONFIGS_TABLE,
              Item: { ...key, date: today, sentCount: 1 },
              ConditionExpression: 'attribute_not_exists(userId) OR #date <> :today',
              ExpressionAttributeNames: { '#date': 'date' },
              ExpressionAttributeValues: { ':today': today },
            })
            .promise();
          return; // reserved
        } catch (putErr: any) {
          if (putErr.code !== 'ConditionalCheckFailedException') throw putErr;
          // Someone else created/updated today's row between our read and this put —
          // loop and retry the conditional increment against the now-current row.
        }
      }
    }
    // Exhausted retries under heavy contention. Fail closed — silently overwriting the
    // count here (the old unconditional-put fallback) would blow through the limit
    // under exactly the contention this loop exists to handle.
    throw new SenderDailyLimitExceededError(senderId, limit);
  }

  async function release(userId: string, senderId: string, today: string): Promise<void> {
    try {
      await dynamodb
        .update({
          TableName: CONFIGS_TABLE,
          Key: { userId, configId: senderUsageConfigId(senderId) },
          UpdateExpression: 'ADD sentCount :negOne',
          ConditionExpression: '#date = :today AND sentCount > :zero',
          ExpressionAttributeNames: { '#date': 'date' },
          ExpressionAttributeValues: { ':negOne': -1, ':today': today, ':zero': 0 },
        })
        .promise();
    } catch (err: any) {
      // Nothing sensible to release if the day already rolled over or the count is
      // already at 0 — the reservation is effectively already gone. Worst case this
      // leaves one send's worth of quota consumed despite the provider call failing:
      // a conservative (under- not over-sending) bias, not an error.
      if (err.code !== 'ConditionalCheckFailedException') throw err;
    }
  }

  return new DynamoSenderUsageTracker({
    async readUsage(userId: string, senderId: string): Promise<SenderUsageRow | null> {
      const r = await dynamodb
        .get({
          TableName: CONFIGS_TABLE,
          Key: { userId, configId: senderUsageConfigId(senderId) },
        })
        .promise();
      if (!r.Item) return null;
      return { date: r.Item.date, sentCount: r.Item.sentCount ?? 0 };
    },
    async reserveUsage(userId: string, senderId: string, today: string, limit: number): Promise<void> {
      await reserve(userId, senderId, today, limit);
    },
    async releaseUsage(userId: string, senderId: string, today: string): Promise<void> {
      await release(userId, senderId, today);
    },
  });
}

export const senderUsageTracker: SenderUsageTracker = buildSenderUsageTracker();
