import AWS from 'aws-sdk';

jest.mock('aws-sdk', () => {
  const mockDynamoDB = {
    get: jest.fn(),
    put: jest.fn(),
    update: jest.fn(),
    query: jest.fn(),
  };
  const mockS3 = {
    putObject: jest.fn().mockReturnThis(),
    getObject: jest.fn().mockReturnThis(),
    deleteObject: jest.fn().mockReturnThis(),
    promise: jest.fn().mockResolvedValue({}),
  };
  return {
    DynamoDB: { DocumentClient: jest.fn(() => mockDynamoDB) },
    S3: jest.fn(() => mockS3),
    config: { update: jest.fn() },
  };
});

import { subscriberDb } from '../services/db';

/**
 * ENG-2991: the subscriber writes that make the public flows safe are single conditional DynamoDB operations. The route tests mock
 * subscriberDb, so this is where the expressions themselves are pinned: what they say, and how a refused condition is reported.
 */
describe('subscriberDb: conditional writes (ENG-2991)', () => {
  let ddb: any;
  const ok = (value: any) => ({ promise: jest.fn().mockResolvedValue(value) });
  const fails = (error: any) => ({ promise: jest.fn().mockRejectedValue(error) });
  const conditionFailed = () => Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });
  const lastParams = (fn: jest.Mock) => fn.mock.calls.at(-1)![0];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    ddb = new (AWS.DynamoDB as any).DocumentClient();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('softUnsubscribe', () => {
    it('is unconditional by default (the owner-side callers rely on that)', async () => {
      ddb.update.mockReturnValue(ok({ Attributes: { unsubscribed: true } }));
      await subscriberDb.softUnsubscribe('t1', 'a@x.com', 'bye');
      const p = lastParams(ddb.update);
      expect(p.ConditionExpression).toBeUndefined();
      expect(p.Key).toEqual({ taskId: 't1', email: 'a@x.com' });
      expect(p.UpdateExpression).toBe('SET unsubscribed = :unsubscribed, unsubscribedAt = :unsubscribedAt, feedback = :feedback');
    });

    it('with onlyIfActive: applies only to an existing row that is not already unsubscribed, and returns the new row', async () => {
      ddb.update.mockReturnValue(ok({ Attributes: { email: 'a@x.com', unsubscribed: true, unsubscribedAt: '2026-11-16T10:00:00.000Z' } }));
      const row = await subscriberDb.softUnsubscribe('t1', 'a@x.com', undefined, { onlyIfActive: true });
      const p = lastParams(ddb.update);
      expect(p.ConditionExpression).toBe('attribute_exists(email) AND (attribute_not_exists(unsubscribed) OR unsubscribed = :stillActive)');
      expect(p.ExpressionAttributeValues[':stillActive']).toBe(false);
      expect(p.ExpressionAttributeValues[':unsubscribed']).toBe(true);
      expect(typeof p.ExpressionAttributeValues[':unsubscribedAt']).toBe('string');
      expect(p.ReturnValues).toBe('ALL_NEW');
      expect(row).toMatchObject({ unsubscribed: true });
    });

    it('with onlyIfActive: returns null (and does not throw) when the condition is refused, i.e. the row was already unsubscribed or is gone', async () => {
      ddb.update.mockReturnValue(fails(conditionFailed()));
      await expect(subscriberDb.softUnsubscribe('t1', 'a@x.com', undefined, { onlyIfActive: true })).resolves.toBeNull();
    });

    it('with onlyIfActive: any other failure is still an error', async () => {
      ddb.update.mockReturnValue(fails(Object.assign(new Error('throttled'), { code: 'ProvisionedThroughputExceededException' })));
      await expect(subscriberDb.softUnsubscribe('t1', 'a@x.com', undefined, { onlyIfActive: true })).rejects.toThrow('throttled');
    });

    it('without onlyIfActive a refused condition is not swallowed (there is none to refuse)', async () => {
      ddb.update.mockReturnValue(fails(conditionFailed()));
      await expect(subscriberDb.softUnsubscribe('t1', 'a@x.com')).rejects.toThrow();
    });
  });

  describe('resubscribe', () => {
    it('is unconditional by default (the owner-only route relies on that)', async () => {
      ddb.update.mockReturnValue(ok({ Attributes: { unsubscribed: false } }));
      await subscriberDb.resubscribe('t1', 'a@x.com');
      expect(lastParams(ddb.update).ConditionExpression).toBeUndefined();
    });

    it('with onlyIfUnsubscribedAt: applies only while the row is still opted out by exactly that opt-out', async () => {
      ddb.update.mockReturnValue(ok({ Attributes: { unsubscribed: false } }));
      await subscriberDb.resubscribe('t1', 'a@x.com', { onlyIfUnsubscribedAt: '2026-11-16T10:00:00.000Z' });
      const p = lastParams(ddb.update);
      expect(p.ConditionExpression).toBe('unsubscribed = :wasOptedOut AND unsubscribedAt = :claimedOptOut');
      expect(p.ExpressionAttributeValues[':wasOptedOut']).toBe(true);
      expect(p.ExpressionAttributeValues[':claimedOptOut']).toBe('2026-11-16T10:00:00.000Z');
      expect(p.ExpressionAttributeValues[':unsubscribed']).toBe(false); // still the same SET
      expect(p.UpdateExpression).toContain('unsubscribed = :unsubscribed');
    });

    it('with onlyIfUnsubscribedAt: returns null when the person has opted out again (or been put back) since', async () => {
      ddb.update.mockReturnValue(fails(conditionFailed()));
      await expect(subscriberDb.resubscribe('t1', 'a@x.com', { onlyIfUnsubscribedAt: 'old' })).resolves.toBeNull();
    });

    it('any other failure is still an error', async () => {
      ddb.update.mockReturnValue(fails(new Error('boom')));
      await expect(subscriberDb.resubscribe('t1', 'a@x.com', { onlyIfUnsubscribedAt: 'x' })).rejects.toThrow('boom');
    });
  });

  describe('refreshOptOut', () => {
    it('gives an unsubscribed row a new opt-out time, and only an unsubscribed one', async () => {
      ddb.update.mockReturnValue(ok({ Attributes: { unsubscribed: true, unsubscribedAt: 'new' } }));
      const row = await subscriberDb.refreshOptOut('t1', 'a@x.com');
      const p = lastParams(ddb.update);
      expect(p.UpdateExpression).toBe('SET unsubscribedAt = :now');
      expect(p.ConditionExpression).toBe('unsubscribed = :isOptedOut');
      expect(p.ExpressionAttributeValues[':isOptedOut']).toBe(true);
      expect(Date.parse(p.ExpressionAttributeValues[':now'])).not.toBeNaN();
      expect(row).toMatchObject({ unsubscribed: true });
    });

    it('does nothing (null) for an address that is not unsubscribed or does not exist, and creates no row', async () => {
      ddb.update.mockReturnValue(fails(conditionFailed()));
      await expect(subscriberDb.refreshOptOut('t1', 'ghost@x.com')).resolves.toBeNull();
    });
  });

  describe('addSubscriber', () => {
    it('inserts only if no row exists for that exact address, in the same operation', async () => {
      ddb.get.mockReturnValue(ok({}));
      ddb.put.mockReturnValue(ok({}));
      const row = await subscriberDb.addSubscriber('t1', 'a@x.com');
      expect(lastParams(ddb.put).ConditionExpression).toBe('attribute_not_exists(email)');
      expect(lastParams(ddb.put).Item).toMatchObject({ taskId: 't1', email: 'a@x.com', unsubscribed: false });
      expect(row).toMatchObject({ taskId: 't1', email: 'a@x.com', unsubscribed: false });
    });

    it('reports a refused insert (another request got there first) with the same message as an existing row, which the confirm route relies on', async () => {
      ddb.get.mockReturnValue(ok({}));
      ddb.put.mockReturnValue(fails(conditionFailed()));
      await expect(subscriberDb.addSubscriber('t1', 'a@x.com')).rejects.toThrow('Email a@x.com is already in the subscriber list for this task');
    });

    it('reports an existing row the same way, without inserting', async () => {
      ddb.get.mockReturnValue(ok({ Item: { taskId: 't1', email: 'a@x.com' } }));
      await expect(subscriberDb.addSubscriber('t1', 'a@x.com')).rejects.toThrow(/already in the subscriber list/);
      expect(ddb.put).not.toHaveBeenCalled();
    });

    it('any other failure of the insert is still an error with its own message', async () => {
      ddb.get.mockReturnValue(ok({}));
      ddb.put.mockReturnValue(fails(new Error('network down')));
      await expect(subscriberDb.addSubscriber('t1', 'a@x.com')).rejects.toThrow('network down');
    });
  });

  describe('reads', () => {
    it('getTaskSubscriberByEmail is eventually consistent unless asked, and strongly consistent when asked', async () => {
      ddb.get.mockReturnValue(ok({ Item: { email: 'a@x.com' } }));
      await subscriberDb.getTaskSubscriberByEmail('t1', 'a@x.com');
      expect(lastParams(ddb.get).ConsistentRead).toBeUndefined();
      await subscriberDb.getTaskSubscriberByEmail('t1', 'a@x.com', true);
      expect(lastParams(ddb.get).ConsistentRead).toBe(true);
    });

    it('getTaskSubscriberStates reads one task\'s addresses with only the three fields needed, across pages', async () => {
      ddb.query
        .mockReturnValueOnce(ok({ Items: [{ email: 'a@x.com' }], LastEvaluatedKey: { taskId: 't1', email: 'a@x.com' } }))
        .mockReturnValueOnce(ok({ Items: [{ email: 'B@x.com', unsubscribed: true, unsubscribedAt: 'x' }] }));
      const rows = await subscriberDb.getTaskSubscriberStates('t1');
      expect(rows).toEqual([{ email: 'a@x.com' }, { email: 'B@x.com', unsubscribed: true, unsubscribedAt: 'x' }]);
      const p = ddb.query.mock.calls[0][0];
      expect(p.KeyConditionExpression).toBe('taskId = :taskId');
      expect(p.ProjectionExpression).toBe('email, unsubscribed, unsubscribedAt');
      expect(p.ExpressionAttributeValues).toEqual({ ':taskId': 't1' });
    });
  });
});
