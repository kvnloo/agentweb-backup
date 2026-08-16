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
    scan: jest.fn(),
    get: jest.fn(),
    put: jest.fn(),
    transactWrite: jest.fn(),
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
    mockDynamoDB.scan.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) });
    mockDynamoDB.transactWrite.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
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
      expect(params.UpdateExpression).toContain('callCount :calls');
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
      // ENG-1251 Greptile P1: callCount ADDs the increment's own `calls`
      // field (defaults to 1) rather than a hardcoded 1 -- lets the atomic
      // charge-coupled path below add a whole group's call count in one shot.
      expect(v[':calls']).toBe(1);
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

  // ENG-1251 Greptile P1 ("Coverage suppresses unrelated aggregate usage"):
  // couples the ledger increment with its paired charge event in one
  // DynamoDB transaction so the two can never land independently.
  describe('incrementUsageWithChargeEvent', () => {
    const baseIncrement = {
      userId: 'user-1',
      date: '2026-06-12',
      model: 'anthropic.claude-sonnet-4-6',
      feature: 'engine:agent_task',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      costMicroUsd: 6128,
      billingUserId: 'owner-1',
      calls: 3,
    };
    const baseChargeEvent = {
      billingUserId: 'owner-1',
      eventId: 'engine:user-1:anthropic.claude-sonnet-4-6:engine:agent_task:abc123',
      occurredAt: '2026-06-12T10:00:00.000Z',
      actingUserId: 'user-1',
      tokens: 1260,
      costMicroUsd: 6128,
      model: 'anthropic.claude-sonnet-4-6',
      feature: 'engine:agent_task',
      calls: 3,
    };

    it('writes both items in ONE transactWrite call and returns "applied" on success', async () => {
      const outcome = await usageRecordDb.incrementUsageWithChargeEvent(baseIncrement, baseChargeEvent);

      expect(outcome).toBe('applied');
      expect(mockDynamoDB.transactWrite).toHaveBeenCalledTimes(1);
      expect(mockDynamoDB.update).not.toHaveBeenCalled();
      const [{ TransactItems }] = mockDynamoDB.transactWrite.mock.calls[0];
      expect(TransactItems).toHaveLength(2);
    });

    it('the ledger item is an unconditional Update against AW-UsageRecords, keyed and summed exactly like a plain incrementUsage call', async () => {
      await usageRecordDb.incrementUsageWithChargeEvent(baseIncrement, baseChargeEvent);
      const [{ TransactItems }] = mockDynamoDB.transactWrite.mock.calls[0];
      const ledgerItem = TransactItems[0].Update;

      expect(ledgerItem.TableName).toBe('AW-UsageRecords');
      expect(ledgerItem.Key).toEqual({
        userId: 'user-1',
        sk: '2026-06-12#anthropic.claude-sonnet-4-6#engine:agent_task',
      });
      expect(ledgerItem.ConditionExpression).toBeUndefined();
      // ENG-1251 Greptile P1: callCount ADDs the group's true call count (3
      // records summed into this one increment), not a hardcoded 1.
      expect(ledgerItem.ExpressionAttributeValues[':calls']).toBe(3);
      expect(ledgerItem.ExpressionAttributeValues[':in']).toBe(1000);
      expect(ledgerItem.ExpressionAttributeValues[':cost']).toBe(6128);
    });

    it('the charge-event item is a conditional Put against AW-LlmChargeEvents with a TTL and the same not-exists guard as recordLlmChargeEvent', async () => {
      await usageRecordDb.incrementUsageWithChargeEvent(baseIncrement, baseChargeEvent);
      const [{ TransactItems }] = mockDynamoDB.transactWrite.mock.calls[0];
      const chargeItem = TransactItems[1].Put;

      expect(chargeItem.TableName).toBe('AW-LlmChargeEvents');
      expect(chargeItem.ConditionExpression).toBe(
        'attribute_not_exists(billingUserId) AND attribute_not_exists(eventId)'
      );
      expect(chargeItem.Item).toMatchObject(baseChargeEvent);
      expect(chargeItem.Item.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('returns "duplicate" when the charge-event item (index 1) fails its condition -- and does NOT retry or rewrite anything', async () => {
      const error: any = new Error('TransactionCanceled');
      error.code = 'TransactionCanceledException';
      error.CancellationReasons = [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }];
      mockDynamoDB.transactWrite.mockReturnValue({ promise: jest.fn().mockRejectedValue(error) });

      const outcome = await usageRecordDb.incrementUsageWithChargeEvent(baseIncrement, baseChargeEvent);
      expect(outcome).toBe('duplicate');
    });

    it('rethrows rather than returning "duplicate" when the LEDGER item (index 0) reports a condition failure -- structurally shouldn\'t happen since the ledger item is unconditional, but must never be misread as a confirmed charge duplicate', async () => {
      const error: any = new Error('TransactionCanceled');
      error.code = 'TransactionCanceledException';
      error.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }];
      mockDynamoDB.transactWrite.mockReturnValue({ promise: jest.fn().mockRejectedValue(error) });

      await expect(
        usageRecordDb.incrementUsageWithChargeEvent(baseIncrement, baseChargeEvent)
      ).rejects.toThrow('TransactionCanceled');
    });

    it('returns "conflict" on a bare TransactionConflictException (concurrent writer, not a condition failure)', async () => {
      const error: any = new Error('TransactionConflict');
      error.code = 'TransactionConflictException';
      mockDynamoDB.transactWrite.mockReturnValue({ promise: jest.fn().mockRejectedValue(error) });

      const outcome = await usageRecordDb.incrementUsageWithChargeEvent(baseIncrement, baseChargeEvent);
      expect(outcome).toBe('conflict');
    });

    it('returns "conflict" when every cancellation reason is TransactionConflict/None (pure contention, no real condition failure)', async () => {
      const error: any = new Error('TransactionCanceled');
      error.code = 'TransactionCanceledException';
      error.CancellationReasons = [{ Code: 'TransactionConflict' }, { Code: 'None' }];
      mockDynamoDB.transactWrite.mockReturnValue({ promise: jest.fn().mockRejectedValue(error) });

      const outcome = await usageRecordDb.incrementUsageWithChargeEvent(baseIncrement, baseChargeEvent);
      expect(outcome).toBe('conflict');
    });

    it('rethrows an unrecognized error shape rather than silently classifying it', async () => {
      const error = new Error('ProvisionedThroughputExceeded');
      mockDynamoDB.transactWrite.mockReturnValue({ promise: jest.fn().mockRejectedValue(error) });

      await expect(
        usageRecordDb.incrementUsageWithChargeEvent(baseIncrement, baseChargeEvent)
      ).rejects.toThrow('ProvisionedThroughputExceeded');
    });

    it('rethrows a TransactionCanceledException with no recognizable cancellation reasons', async () => {
      const error: any = new Error('TransactionCanceled');
      error.code = 'TransactionCanceledException';
      error.CancellationReasons = [{ Code: 'ValidationError' }, { Code: 'None' }];
      mockDynamoDB.transactWrite.mockReturnValue({ promise: jest.fn().mockRejectedValue(error) });

      await expect(
        usageRecordDb.incrementUsageWithChargeEvent(baseIncrement, baseChargeEvent)
      ).rejects.toThrow('TransactionCanceled');
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

  // ENG-366: cross-user date-range scan feeding the admin cost aggregation.
  // ENG-353 behavioral contract, assertion 3 (window filtering): the filter is
  // pushed to DynamoDB as a BETWEEN on the row's date attribute, so rows outside
  // [start, end] never reach the aggregation layer.
  describe('scanByDateRange', () => {
    it('scans with a date BETWEEN filter bounded by start and end (inclusive)', async () => {
      await usageRecordDb.scanByDateRange('2026-06-01', '2026-06-30');

      expect(mockDynamoDB.scan).toHaveBeenCalledTimes(1);
      const params = mockDynamoDB.scan.mock.calls[0][0];
      expect(params.FilterExpression).toBe('#date BETWEEN :start AND :end');
      expect(params.ExpressionAttributeNames).toEqual({ '#date': 'date' });
      expect(params.ExpressionAttributeValues).toEqual({
        ':start': '2026-06-01',
        ':end': '2026-06-30',
      });
    });

    it('returns the rows and paginates through LastEvaluatedKey', async () => {
      const page1 = {
        Items: [{ userId: 'user-1', sk: '2026-06-01#m#f', costMicroUsd: 100 }],
        LastEvaluatedKey: { userId: 'user-1', sk: '2026-06-01#m#f' },
      };
      const page2 = {
        Items: [{ userId: 'user-2', sk: '2026-06-02#m#f', costMicroUsd: 200 }],
      };
      mockDynamoDB.scan
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue(page1) })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue(page2) });

      const rows = await usageRecordDb.scanByDateRange('2026-06-01', '2026-06-30');

      expect(rows).toHaveLength(2);
      expect(mockDynamoDB.scan).toHaveBeenCalledTimes(2);
      expect(mockDynamoDB.scan.mock.calls[1][0].ExclusiveStartKey).toEqual(
        page1.LastEvaluatedKey
      );
      expect(rows.map((r: any) => r.userId)).toEqual(['user-1', 'user-2']);
    });

    it('returns an empty array (not undefined) when the scan matches nothing', async () => {
      mockDynamoDB.scan.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
      const rows = await usageRecordDb.scanByDateRange('2026-06-01', '2026-06-30');
      expect(rows).toEqual([]);
    });

    it('propagates DynamoDB errors', async () => {
      mockDynamoDB.scan.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('ProvisionedThroughputExceeded')),
      });
      await expect(
        usageRecordDb.scanByDateRange('2026-06-01', '2026-06-30')
      ).rejects.toThrow('ProvisionedThroughputExceeded');
    });
  });
});
