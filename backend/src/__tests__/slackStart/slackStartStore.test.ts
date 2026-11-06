/**
 * ENG-2782 S1 — the intake store is DynamoDB, never process memory, so domain
 * dedupe, idempotency, completion leases and rate limits hold across every
 * backend instance. These tests pin the conditional writes that make that true.
 */
import { createDynamoSlackStartStore, SLACK_START_TABLE } from '../../services/slackStart/slackStartStore';

function fakeClient() {
  const calls: Record<string, any[]> = { transactWrite: [], get: [], update: [] };
  const responses: Record<string, Array<() => any>> = { transactWrite: [], get: [], update: [] };
  const op = (name: string) =>
    jest.fn((params: any) => {
      calls[name].push(params);
      const next = responses[name].shift();
      return { promise: async () => (next ? next() : {}) };
    });
  return { client: { transactWrite: op('transactWrite'), get: op('get'), update: op('update') }, calls, responses };
}

const conditionalFailure = () => {
  const err: any = new Error('The conditional request failed');
  err.code = 'ConditionalCheckFailedException';
  throw err;
};

const intake = { intakeId: 'i-1', domain: 'acme.co', email: 'sam@acme.co' } as any;
const lock = { domain: 'acme.co', intakeId: 'i-1', idempotencyKeyHash: 'h', createdAt: '2026-11-05T00:00:00.000Z' };

describe('DynamoDB slack-start store', () => {
  it('writes the intake and the domain lock in ONE transaction, each conditioned on not existing', async () => {
    const { client, calls } = fakeClient();
    const store = createDynamoSlackStartStore(client as any);
    await expect(store.createIntake(intake, lock)).resolves.toEqual({ created: true });
    const items = calls.transactWrite[0].TransactItems;
    expect(items).toHaveLength(2);
    expect(items.map((i: any) => i.Put.Item.pk)).toEqual(['intake#i-1', 'domain#acme.co']);
    for (const i of items) {
      expect(i.Put.TableName).toBe(SLACK_START_TABLE);
      expect(i.Put.ConditionExpression).toBe('attribute_not_exists(pk)');
    }
  });

  it('reports the existing lock (read consistently) when the domain is already taken', async () => {
    const { client, calls, responses } = fakeClient();
    responses.transactWrite.push(() => {
      const err: any = new Error('Transaction cancelled');
      err.code = 'TransactionCanceledException';
      err.message = 'Transaction cancelled, please refer cancellation reasons for specific reasons [None, ConditionalCheckFailed]';
      throw err;
    });
    responses.get.push(() => ({ Item: { pk: 'domain#acme.co', ...lock, intakeId: 'i-0' } }));
    const store = createDynamoSlackStartStore(client as any);
    const res = await store.createIntake(intake, lock);
    expect(res).toEqual({ created: false, lock: expect.objectContaining({ intakeId: 'i-0', domain: 'acme.co' }) });
    expect(calls.get[0]).toEqual({ TableName: SLACK_START_TABLE, Key: { pk: 'domain#acme.co' }, ConsistentRead: true });
  });

  it('rethrows non-conditional transaction failures', async () => {
    const { client, responses } = fakeClient();
    responses.transactWrite.push(() => {
      throw Object.assign(new Error('throttled'), { code: 'ProvisionedThroughputExceededException' });
    });
    await expect(createDynamoSlackStartStore(client as any).createIntake(intake, lock)).rejects.toThrow('throttled');
  });

  it('updates nested intake fields conditionally and reports a lost condition as false', async () => {
    const { client, calls, responses } = fakeClient();
    const store = createDynamoSlackStartStore(client as any);
    await expect(
      store.updateIntake('i-1', { 'answers.source': 'linkedin', updatedAt: 't' }, { ifNotExists: 'brandBuildTriggeredAt' }),
    ).resolves.toBe(true);
    const p = calls.update[0];
    expect(p.Key).toEqual({ pk: 'intake#i-1' });
    expect(p.UpdateExpression).toBe('SET #n0.#n1 = :v0, #n2 = :v1');
    expect(p.ExpressionAttributeNames).toMatchObject({ '#n0': 'answers', '#n1': 'source', '#n2': 'updatedAt' });
    expect(p.ConditionExpression).toBe('attribute_exists(pk) AND attribute_not_exists(#c0)');
    expect(p.ExpressionAttributeNames['#c0']).toBe('brandBuildTriggeredAt');

    responses.update.push(conditionalFailure);
    await expect(store.updateIntake('i-1', { x: 1 }, { ifNotExists: 'x' })).resolves.toBe(false);
  });

  it('claims a lease only when it is absent or expired', async () => {
    const { client, calls } = fakeClient();
    await createDynamoSlackStartStore(client as any).updateIntake(
      'i-1',
      { completionLeaseUntil: 'later' },
      { ifLeaseFree: { attr: 'completionLeaseUntil', now: 'now' } },
    );
    const p = calls.update[0];
    expect(p.ConditionExpression).toBe('attribute_exists(pk) AND (attribute_not_exists(#c0) OR #c0 < :cnow)');
    expect(p.ExpressionAttributeValues[':cnow']).toBe('now');
  });

  it('counts rate-limit hits atomically per window with a TTL and denies past the max', async () => {
    const { client, calls, responses } = fakeClient();
    const store = createDynamoSlackStartStore(client as any);
    const now = new Date('2026-11-05T10:30:00.000Z');
    await expect(store.consumeRate('ip', 'abc', 5, 3_600_000, now)).resolves.toBe(true);
    const p = calls.update[0];
    expect(p.Key).toEqual({ pk: 'rate#ip#abc#2026-11-05T10:00:00.000Z' });
    expect(p.UpdateExpression).toBe('ADD #count :one SET #expiresAt = if_not_exists(#expiresAt, :exp)');
    expect(p.ConditionExpression).toBe('attribute_not_exists(#count) OR #count < :max');
    expect(p.ExpressionAttributeValues[':max']).toBe(5);
    expect(p.ExpressionAttributeValues[':exp']).toBe(Math.floor(Date.parse('2026-11-05T11:00:00.000Z') / 1000) + 3600);

    responses.update.push(conditionalFailure);
    await expect(store.consumeRate('ip', 'abc', 5, 3_600_000, now)).resolves.toBe(false);
  });

  it('reads intakes consistently and strips the storage key', async () => {
    const { client, calls, responses } = fakeClient();
    responses.get.push(() => ({ Item: { pk: 'intake#i-1', intakeId: 'i-1' } }));
    await expect(createDynamoSlackStartStore(client as any).getIntake('i-1')).resolves.toEqual({ intakeId: 'i-1' });
    expect(calls.get[0].ConsistentRead).toBe(true);
  });

  it('reads a domain lock consistently by domain', async () => {
    const { client, calls, responses } = fakeClient();
    responses.get.push(() => ({ Item: { pk: 'domain#acme.co', kind: 'domain', ...lock } }));
    await expect(createDynamoSlackStartStore(client as any).getDomainLock('acme.co')).resolves.toEqual(lock);
    expect(calls.get[0]).toEqual({ TableName: SLACK_START_TABLE, Key: { pk: 'domain#acme.co' }, ConsistentRead: true });
  });

  it('is provisioned at boot with TTL (rate counters expire) and point-in-time recovery', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CRITICAL_TABLE_SPECS, CRITICAL_TABLE_SETTINGS } = require('../../services/ensureCriticalTables');
    expect(CRITICAL_TABLE_SPECS.map((t: any) => t.TableName)).toContain(SLACK_START_TABLE);
    expect(CRITICAL_TABLE_SETTINGS[SLACK_START_TABLE]).toEqual({ ttlAttribute: 'expiresAt', pointInTimeRecovery: true });
  });
});
