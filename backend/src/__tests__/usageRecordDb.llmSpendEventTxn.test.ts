/**
 * ENG-1934 — the engine transaction's spend-event items.
 *
 * `incrementUsageWithChargeEvent` grows from two items to one more per spend
 * event supplied (one per priced portion of the group). The classification of a cancelled transaction is the part
 * that can silently lose money: "duplicate" makes the route SKIP the write, so
 * it must only ever mean "this exact charge already landed".
 */
jest.mock('aws-sdk', () => {
  const mockDynamoDB = { update: jest.fn(), put: jest.fn(), transactWrite: jest.fn() };
  return {
    DynamoDB: { DocumentClient: jest.fn(() => mockDynamoDB) },
    config: { update: jest.fn() },
  };
});

import AWS from 'aws-sdk';
import { usageRecordDb } from '../services/usageRecordDb';
import { SpendEvent, SpendEventValidationError } from '../services/spendEventDb';

const mockDynamoDB = new (AWS.DynamoDB.DocumentClient as any)();

const increment = {
  userId: 'user-1',
  date: '2026-09-14',
  model: 'anthropic.claude-opus-5',
  feature: 'engine:agent_task',
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMicroUsd: 10_000,
  billingUserId: 'owner-1',
  calls: 2,
};
const charge = {
  billingUserId: 'owner-1',
  eventId: 'engine:user-1:anthropic.claude-opus-5:engine:agent_task:abc',
  occurredAt: '2026-09-14T10:00:00.000Z',
  actingUserId: 'user-1',
  tokens: 1200,
  costMicroUsd: 10_000,
  model: 'anthropic.claude-opus-5',
  feature: 'engine:agent_task',
  calls: 2,
};
const spendEvent: SpendEvent = {
  billingUserId: 'owner-1',
  eventId: `llm:${charge.eventId}`,
  occurredAt: charge.occurredAt,
  billingMonth: '2026-09',
  actingUserId: 'user-1',
  provider: 'bedrock',
  operation: 'anthropic.claude-opus-5',
  feature: 'engine:agent_task',
  unit: 'llm_token',
  quantity: 1200,
  costMicroUsd: 10_000,
  costSource: 'allocated',
  rateCardVersion: 'llm-price-book:2026-09-10',
  lifecycle: 'settled',
};

const cancelled = (codes: string[]) =>
  Object.assign(new Error('TransactionCanceled'), {
    code: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

describe('incrementUsageWithChargeEvent with a spend event (ENG-1934)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB.transactWrite.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
  });

  it('writes aggregate, charge event and spend event in ONE transaction', async () => {
    await expect(usageRecordDb.incrementUsageWithChargeEvent(increment, charge, [spendEvent])).resolves.toBe('applied');

    expect(mockDynamoDB.transactWrite).toHaveBeenCalledTimes(1);
    const [{ TransactItems }] = mockDynamoDB.transactWrite.mock.calls[0];
    expect(TransactItems).toHaveLength(3);
    expect(TransactItems[2].Put).toEqual({
      TableName: 'AW-SpendEvents',
      Item: spendEvent,
      ConditionExpression: 'attribute_not_exists(billingUserId) AND attribute_not_exists(eventId)',
    });
  });

  it('writes one item per priced portion — engine-priced and book-priced stay separate events', async () => {
    const engineEvent = { ...spendEvent, eventId: `${spendEvent.eventId}#engine`, rateCardVersion: 'caller:agent-engine' };

    await usageRecordDb.incrementUsageWithChargeEvent(increment, charge, [spendEvent, engineEvent]);

    const [{ TransactItems }] = mockDynamoDB.transactWrite.mock.calls[0];
    expect(TransactItems).toHaveLength(4);
    expect(TransactItems.slice(2).map((i: any) => i.Put.Item.rateCardVersion)).toEqual([
      'llm-price-book:2026-09-10',
      'caller:agent-engine',
    ]);
  });

  it('a condition failure on ANY spend-event item alone still throws, never "duplicate"', async () => {
    const engineEvent = { ...spendEvent, eventId: `${spendEvent.eventId}#engine`, rateCardVersion: 'caller:agent-engine' };
    mockDynamoDB.transactWrite.mockReturnValue({
      promise: jest.fn().mockRejectedValue(cancelled(['None', 'None', 'None', 'ConditionalCheckFailed'])),
    });

    await expect(
      usageRecordDb.incrementUsageWithChargeEvent(increment, charge, [spendEvent, engineEvent]),
    ).rejects.toThrow('TransactionCanceled');
  });

  it('without one, the transaction is the same two items as before', async () => {
    await usageRecordDb.incrementUsageWithChargeEvent(increment, charge);

    expect(mockDynamoDB.transactWrite.mock.calls[0][0].TransactItems).toHaveLength(2);
  });

  it('rejects a malformed spend event BEFORE writing anything', async () => {
    const bad = { ...spendEvent, rateCardVersion: undefined };

    await expect(usageRecordDb.incrementUsageWithChargeEvent(increment, charge, [bad])).rejects.toBeInstanceOf(
      SpendEventValidationError,
    );
    expect(mockDynamoDB.transactWrite).not.toHaveBeenCalled();
  });

  it('a genuine retry (charge AND spend event both exist) is "duplicate"', async () => {
    mockDynamoDB.transactWrite.mockReturnValue({
      promise: jest.fn().mockRejectedValue(cancelled(['None', 'ConditionalCheckFailed', 'ConditionalCheckFailed'])),
    });

    await expect(usageRecordDb.incrementUsageWithChargeEvent(increment, charge, [spendEvent])).resolves.toBe(
      'duplicate',
    );
  });

  it('a spend-event-ONLY condition failure is NOT a duplicate — it throws so the route writes the usage', async () => {
    // No legitimate cause exists. Reading it as "duplicate" would make the route
    // skip the aggregate and the charge for usage that never landed.
    mockDynamoDB.transactWrite.mockReturnValue({
      promise: jest.fn().mockRejectedValue(cancelled(['None', 'None', 'ConditionalCheckFailed'])),
    });

    await expect(usageRecordDb.incrementUsageWithChargeEvent(increment, charge, [spendEvent])).rejects.toThrow(
      'TransactionCanceled',
    );
  });

  it('a pure contention cancellation across all three items is still "conflict"', async () => {
    mockDynamoDB.transactWrite.mockReturnValue({
      promise: jest.fn().mockRejectedValue(cancelled(['None', 'TransactionConflict', 'None'])),
    });

    await expect(usageRecordDb.incrementUsageWithChargeEvent(increment, charge, [spendEvent])).resolves.toBe(
      'conflict',
    );
  });
});
