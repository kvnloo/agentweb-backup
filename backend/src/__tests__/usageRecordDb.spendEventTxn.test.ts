/**
 * ENG-702 AC1 at the DynamoDB layer: incrementUsageWithSpendEvent.
 *
 * The classification matters as much as the write. A transaction condition
 * failure surfaces as TransactionCanceledException with a per-item
 * CancellationReasons array, NOT the single-item ConditionalCheckFailedException
 * a standalone put raises — so reading it wrong turns a harmless replay into a
 * thrown error, or worse, a genuine conflict into a silent "already charged".
 */
jest.mock('aws-sdk', () => {
  const mockDynamoDB = { update: jest.fn(), query: jest.fn(), scan: jest.fn(), get: jest.fn(), put: jest.fn(), transactWrite: jest.fn() };
  return { DynamoDB: { DocumentClient: jest.fn(() => mockDynamoDB) }, config: { update: jest.fn() } };
});

import AWS from 'aws-sdk';
import { usageRecordDb } from '../services/usageRecordDb';
import { SpendEvent } from '../services/spendEventDb';

const mockDynamoDB = new (AWS.DynamoDB.DocumentClient as any)();

const increment = {
  userId: 'user-1',
  date: '2026-09-08',
  model: 'you.com:query',
  feature: 'agent-search',
  inputTokens: 0,
  outputTokens: 0,
  costMicroUsd: 12500,
  billingUserId: 'owner-1',
  provider: 'you.com',
  unit: 'query',
  quantity: 1,
  costSource: 'allocated' as const,
};

const spendEvent = (over: Partial<SpendEvent> = {}): SpendEvent => ({
  billingUserId: 'owner-1',
  eventId: 'vendor-req-42',
  occurredAt: '2026-09-08T10:00:00.000Z',
  billingMonth: '2026-09',
  actingUserId: 'user-1',
  provider: 'you.com',
  operation: 'query',
  unit: 'query',
  quantity: 1,
  costMicroUsd: 12500,
  costSource: 'allocated',
  rateCardVersion: '2026-09-02',
  lifecycle: 'settled',
  ...over,
});

const cancelled = (reasons: Array<{ Code?: string }>) =>
  Object.assign(new Error('cancelled'), { code: 'TransactionCanceledException', CancellationReasons: reasons });

describe('incrementUsageWithSpendEvent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB.transactWrite.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
  });

  it('writes the aggregate and the spend event in ONE transaction', async () => {
    await usageRecordDb.incrementUsageWithSpendEvent(increment, spendEvent());

    expect(mockDynamoDB.transactWrite).toHaveBeenCalledTimes(1);
    const items = mockDynamoDB.transactWrite.mock.calls[0][0].TransactItems;
    expect(items).toHaveLength(3); // ledger + spend event + F5 projection maintenance
    expect(items[0].Update).toBeDefined();
    expect(items[1].Put.TableName).toBe('AW-SpendEvents');
    // ENG-1250 F5: the projection update rides in the SAME transaction, appended last.
    expect(items[2].Update.TableName).toBe('AW-SpendProjection');
    expect(items[2].Update.UpdateExpression).toBe('SET computedAt = :now ADD settledMicroUsd :m, settledEventCount :c');
  });

  it('targets AW-SpendEvents, never the LLM-only charge table', () => {
    // AW-LlmChargeEvents declares itself "deliberately LLM-only: it is not the
    // future cross-vendor wallet".
    return usageRecordDb.incrementUsageWithSpendEvent(increment, spendEvent()).then(() => {
      const put = mockDynamoDB.transactWrite.mock.calls[0][0].TransactItems[1].Put;
      expect(put.TableName).not.toContain('LlmChargeEvents');
    });
  });

  it('guards the spend event on both key attributes', async () => {
    await usageRecordDb.incrementUsageWithSpendEvent(increment, spendEvent());

    expect(mockDynamoDB.transactWrite.mock.calls[0][0].TransactItems[1].Put.ConditionExpression).toBe(
      'attribute_not_exists(billingUserId) AND attribute_not_exists(eventId)'
    );
  });

  it('writes NO ttl — AW-SpendEvents is retained by decision', async () => {
    await usageRecordDb.incrementUsageWithSpendEvent(increment, spendEvent());

    expect(mockDynamoDB.transactWrite.mock.calls[0][0].TransactItems[1].Put.Item).not.toHaveProperty('ttl');
  });

  it('validates the event before writing anything', async () => {
    // The store's guarantees are worth nothing if the transactional path can
    // bypass them.
    await expect(
      usageRecordDb.incrementUsageWithSpendEvent(increment, spendEvent({ billingMonth: '2026-08' }))
    ).rejects.toThrow(/disagrees with occurredAt/);

    expect(mockDynamoDB.transactWrite).not.toHaveBeenCalled();
  });

  it('reports a replayed token as duplicate, not an error', async () => {
    mockDynamoDB.transactWrite.mockReturnValue({
      promise: jest.fn().mockRejectedValue(cancelled([{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }])),
    });

    await expect(usageRecordDb.incrementUsageWithSpendEvent(increment, spendEvent())).resolves.toBe('duplicate');
  });

  it('does not read a LEDGER condition failure as a duplicate charge', async () => {
    // Index order is [ledger, spendEvent]; only index 1 means "already charged".
    mockDynamoDB.transactWrite.mockReturnValue({
      promise: jest.fn().mockRejectedValue(cancelled([{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }])),
    });

    await expect(usageRecordDb.incrementUsageWithSpendEvent(increment, spendEvent())).rejects.toBeDefined();
  });

  it('reports a pure conflict as retryable', async () => {
    mockDynamoDB.transactWrite.mockReturnValue({
      promise: jest.fn().mockRejectedValue(cancelled([{ Code: 'TransactionConflict' }, { Code: 'None' }])),
    });

    await expect(usageRecordDb.incrementUsageWithSpendEvent(increment, spendEvent())).resolves.toBe('conflict');
  });

  it('reports a top-level TransactionConflictException as retryable', async () => {
    mockDynamoDB.transactWrite.mockReturnValue({
      promise: jest.fn().mockRejectedValue(Object.assign(new Error('conflict'), { code: 'TransactionConflictException' })),
    });

    await expect(usageRecordDb.incrementUsageWithSpendEvent(increment, spendEvent())).resolves.toBe('conflict');
  });

  it('propagates an unrelated failure rather than classifying it', async () => {
    mockDynamoDB.transactWrite.mockReturnValue({
      promise: jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'ProvisionedThroughputExceededException' })),
    });

    await expect(usageRecordDb.incrementUsageWithSpendEvent(increment, spendEvent())).rejects.toThrow('boom');
  });
});

describe('incrementUsageWithDedupeMarker (ENG-1958)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB.transactWrite.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
  });

  it('pairs the aggregate ADD with a conditional marker Put in ONE transaction', async () => {
    await usageRecordDb.incrementUsageWithDedupeMarker(increment, 'owner-1', 'vendor-key-1');
    const items = mockDynamoDB.transactWrite.mock.calls[0][0].TransactItems;
    expect(items).toHaveLength(2);
    expect(items[0].Update).toBeDefined();
    expect(items[1].Put.ConditionExpression).toBe('attribute_not_exists(userId) AND attribute_not_exists(sk)');
  });

  it('writes the marker to its own idem# partition, keyed on the idempotencyKey, with a ttl', async () => {
    await usageRecordDb.incrementUsageWithDedupeMarker(increment, 'owner-1', 'vendor-key-1');
    const marker = mockDynamoDB.transactWrite.mock.calls[0][0].TransactItems[1].Put.Item;
    expect(marker.userId).toBe('idem#owner-1');
    expect(marker.sk).toBe('vendor-key-1');
    expect(typeof marker.ttl).toBe('number');
  });

  it('the marker carries no provider/unit/cost, so it can never read as a usage row', async () => {
    await usageRecordDb.incrementUsageWithDedupeMarker(increment, 'owner-1', 'vendor-key-1');
    const marker = mockDynamoDB.transactWrite.mock.calls[0][0].TransactItems[1].Put.Item;
    expect(marker).not.toHaveProperty('provider');
    expect(marker).not.toHaveProperty('unit');
    expect(marker).not.toHaveProperty('costMicroUsd');
  });

  it('a replayed key is reported as duplicate (marker condition failed), not an error', async () => {
    mockDynamoDB.transactWrite.mockReturnValue({
      promise: jest.fn().mockRejectedValue(cancelled([{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }])),
    });
    await expect(usageRecordDb.incrementUsageWithDedupeMarker(increment, 'owner-1', 'k')).resolves.toBe('duplicate');
  });

  it('a LEDGER condition failure (index 0) is NOT read as a duplicate', async () => {
    mockDynamoDB.transactWrite.mockReturnValue({
      promise: jest.fn().mockRejectedValue(cancelled([{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }])),
    });
    await expect(usageRecordDb.incrementUsageWithDedupeMarker(increment, 'owner-1', 'k')).rejects.toBeDefined();
  });

  it('reports a pure conflict as retryable', async () => {
    mockDynamoDB.transactWrite.mockReturnValue({
      promise: jest.fn().mockRejectedValue(cancelled([{ Code: 'TransactionConflict' }, { Code: 'None' }])),
    });
    await expect(usageRecordDb.incrementUsageWithDedupeMarker(increment, 'owner-1', 'k')).resolves.toBe('conflict');
  });

  it('propagates an unrelated failure rather than classifying it', async () => {
    mockDynamoDB.transactWrite.mockReturnValue({
      promise: jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'ProvisionedThroughputExceededException' })),
    });
    await expect(usageRecordDb.incrementUsageWithDedupeMarker(increment, 'owner-1', 'k')).rejects.toThrow('boom');
  });
});
