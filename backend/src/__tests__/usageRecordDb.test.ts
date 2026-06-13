/**
 * Tests for the AW-UsageRecords DynamoDB adapter.
 * Key acceptance points:
 *  - increments use a SINGLE atomic UpdateExpression with ADD (no read-modify-write)
 *  - costMicroUsd is an integer counter
 *  - TTL (~180d) is set on first write only (if_not_exists)
 *  - date-range query paginates and brackets the sort key correctly
 */

// Mock BEFORE imports
jest.mock('aws-sdk', () => {
  const mockDynamoDB = {
    update: jest.fn(),
    query: jest.fn(),
    get: jest.fn(),
    put: jest.fn(),
  };
  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDynamoDB),
    },
    config: { update: jest.fn() },
  };
});

import AWS from 'aws-sdk';
import { usageRecordDb } from '../services/usageRecordDb';

const mockDynamoDB = new (AWS.DynamoDB.DocumentClient as any)();

describe('usageRecordDb', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    mockDynamoDB.query.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) });
  });

  describe('incrementUsage', () => {
    const baseIncrement = {
      userId: 'user-1',
      date: '2026-06-12',
      model: 'anthropic.claude-sonnet-4-6',
      feature: 'agent-chat',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      costMicroUsd: 6128,
      billingUserId: 'owner-1',
    };

    it('issues a single atomic update with ADD counters — no reads first', async () => {
      await usageRecordDb.incrementUsage(baseIncrement);

      expect(mockDynamoDB.update).toHaveBeenCalledTimes(1);
      expect(mockDynamoDB.get).not.toHaveBeenCalled();
      expect(mockDynamoDB.put).not.toHaveBeenCalled();
      expect(mockDynamoDB.query).not.toHaveBeenCalled();

      const params = mockDynamoDB.update.mock.calls[0][0];
      expect(params.UpdateExpression).toMatch(/^ADD /);
      expect(params.UpdateExpression).toContain('inputTokens :in');
      expect(params.UpdateExpression).toContain('outputTokens :out');
      expect(params.UpdateExpression).toContain('cacheReadTokens :cr');
      expect(params.UpdateExpression).toContain('cacheWriteTokens :cw');
      expect(params.UpdateExpression).toContain('totalTokens :tt');
      expect(params.UpdateExpression).toContain('costMicroUsd :cost');
      expect(params.UpdateExpression).toContain('callCount :one');
    });

    it('keys rows by (userId, date#model#feature)', async () => {
      await usageRecordDb.incrementUsage(baseIncrement);
      const params = mockDynamoDB.update.mock.calls[0][0];
      expect(params.Key).toEqual({
        userId: 'user-1',
        sk: '2026-06-12#anthropic.claude-sonnet-4-6#agent-chat',
      });
    });

    it('passes integer microdollar cost, summed totalTokens, callCount 1, and billingUserId', async () => {
      await usageRecordDb.incrementUsage({ ...baseIncrement, costMicroUsd: 6128.4 });
      const params = mockDynamoDB.update.mock.calls[0][0];
      const v = params.ExpressionAttributeValues;
      expect(v[':in']).toBe(1000);
      expect(v[':out']).toBe(200);
      expect(v[':cr']).toBe(50);
      expect(v[':cw']).toBe(10);
      expect(v[':tt']).toBe(1260); // 1000 + 200 + 50 + 10
      expect(v[':cost']).toBe(6128); // rounded to integer microdollars
      expect(Number.isInteger(v[':cost'])).toBe(true);
      expect(v[':one']).toBe(1);
      expect(v[':billing']).toBe('owner-1');
    });

    it('sets a ~180 day TTL only on first write (if_not_exists)', async () => {
      const before = Math.floor(Date.now() / 1000) + 180 * 24 * 60 * 60;
      await usageRecordDb.incrementUsage(baseIncrement);
      const after = Math.floor(Date.now() / 1000) + 180 * 24 * 60 * 60;

      const params = mockDynamoDB.update.mock.calls[0][0];
      expect(params.UpdateExpression).toContain('#ttl = if_not_exists(#ttl, :ttl)');
      expect(params.ExpressionAttributeNames['#ttl']).toBe('ttl');
      expect(params.ExpressionAttributeValues[':ttl']).toBeGreaterThanOrEqual(before);
      expect(params.ExpressionAttributeValues[':ttl']).toBeLessThanOrEqual(after);
    });

    it('omits onBehalfOf when not provided and includes it when provided', async () => {
      await usageRecordDb.incrementUsage(baseIncrement);
      let params = mockDynamoDB.update.mock.calls[0][0];
      expect(params.UpdateExpression).not.toContain('onBehalfOf');
      expect(params.ExpressionAttributeValues[':obo']).toBeUndefined();

      await usageRecordDb.incrementUsage({ ...baseIncrement, onBehalfOf: 'client-7' });
      params = mockDynamoDB.update.mock.calls[1][0];
      expect(params.UpdateExpression).toContain('onBehalfOf = :obo');
      expect(params.ExpressionAttributeValues[':obo']).toBe('client-7');
    });

    it('defaults missing cache counters to 0', async () => {
      const { cacheReadTokens, cacheWriteTokens, ...noCache } = baseIncrement;
      await usageRecordDb.incrementUsage(noCache as any);
      const v = mockDynamoDB.update.mock.calls[0][0].ExpressionAttributeValues;
      expect(v[':cr']).toBe(0);
      expect(v[':cw']).toBe(0);
      expect(v[':tt']).toBe(1200);
    });

    it('propagates DynamoDB errors (fail-open handling lives in the recorder, not here)', async () => {
      mockDynamoDB.update.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('ProvisionedThroughputExceeded')),
      });
      await expect(usageRecordDb.incrementUsage(baseIncrement)).rejects.toThrow(
        'ProvisionedThroughputExceeded'
      );
    });
  });

  describe('queryByUserDateRange', () => {
    it('queries with BETWEEN bracketing the end date past every model#feature suffix', async () => {
      await usageRecordDb.queryByUserDateRange('user-1', '2026-06-01', '2026-06-30');

      expect(mockDynamoDB.query).toHaveBeenCalledTimes(1);
      const params = mockDynamoDB.query.mock.calls[0][0];
      expect(params.KeyConditionExpression).toBe('userId = :uid AND sk BETWEEN :start AND :end');
      expect(params.ExpressionAttributeValues).toEqual({
        ':uid': 'user-1',
        ':start': '2026-06-01',
        ':end': '2026-06-30~',
      });
    });

    it('returns the rows and paginates through LastEvaluatedKey', async () => {
      const page1 = {
        Items: [{ userId: 'user-1', sk: '2026-06-01#m#f', totalTokens: 10 }],
        LastEvaluatedKey: { userId: 'user-1', sk: '2026-06-01#m#f' },
      };
      const page2 = {
        Items: [{ userId: 'user-1', sk: '2026-06-02#m#f', totalTokens: 20 }],
      };
      mockDynamoDB.query
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue(page1) })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue(page2) });

      const rows = await usageRecordDb.queryByUserDateRange('user-1', '2026-06-01', '2026-06-30');

      expect(rows).toHaveLength(2);
      expect(mockDynamoDB.query).toHaveBeenCalledTimes(2);
      expect(mockDynamoDB.query.mock.calls[1][0].ExclusiveStartKey).toEqual(
        page1.LastEvaluatedKey
      );
    });

    it('returns an empty array when there are no rows', async () => {
      mockDynamoDB.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      const rows = await usageRecordDb.queryByUserDateRange('user-1', '2026-06-01', '2026-06-30');
      expect(rows).toEqual([]);
    });
  });

  describe('table name prefix', () => {
    const baseIncrement = {
      userId: 'user-1',
      date: '2026-06-12',
      model: 'm',
      feature: 'f',
      inputTokens: 1,
      outputTokens: 1,
      costMicroUsd: 1,
      billingUserId: 'owner-1',
    };

    it('uses the unprefixed prod table name outside development', async () => {
      // The default test env (NODE_ENV !== 'development') takes the '' branch.
      await usageRecordDb.incrementUsage(baseIncrement);
      expect(mockDynamoDB.update.mock.calls[0][0].TableName).toBe('AW-UsageRecords');
    });

    it('prefixes the table with Dev- in development', async () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      try {
        await jest.isolateModulesAsync(async () => {
          const { usageRecordDb: devDb } = require('../services/usageRecordDb');
          await devDb.incrementUsage(baseIncrement);
        });
      } finally {
        process.env.NODE_ENV = prev;
      }
      const lastCall = mockDynamoDB.update.mock.calls.at(-1)[0];
      expect(lastCall.TableName).toBe('Dev-AW-UsageRecords');
    });
  });
});
