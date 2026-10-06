/**
 * ENG-2326 — the expression crmDb.setLeadTopLevelIfBlank sends. A mocked DocumentClient cannot validate
 * DynamoDB syntax (the dynamodb-local proof in the PR does that); this pins the SHAPE: one UpdateItem per key,
 * conditional on absent / '' / NULL, every name and value a placeholder, conditional failure = skipped.
 */
const updateCalls: any[] = [];
let updateImpl: (p: any) => Promise<any> = async () => ({});

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      get: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      update: jest.fn((p: any) => { updateCalls.push(p); return { promise: () => updateImpl(p) }; }),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      scan: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      batchGet: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({ upload: jest.fn(), getObject: jest.fn(), getSignedUrl: jest.fn() })),
  SecretsManager: jest.fn(() => ({ getSecretValue: jest.fn() })),
}));

import { crmDb } from '../services/db';

beforeEach(() => {
  updateCalls.length = 0;
  updateImpl = async () => ({});
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('crmDb.setLeadTopLevelIfBlank', () => {
  it('one conditional UpdateItem per key; the condition admits absent, empty string and NULL only', async () => {
    const r = await crmDb.setLeadTopLevelIfBlank('list_a', 'lead_1', { firstTouch: { src: 'ad' }, utm_source: 'fb' });
    expect(r).toEqual({ written: ['firstTouch', 'utm_source'], kept: [] });
    expect(updateCalls).toHaveLength(2);
    for (const c of updateCalls) {
      expect(c.Key).toEqual({ listId: 'list_a', leadId: 'lead_1' });
      expect(c.TableName).toMatch(/AW-Leads$/);
      expect(c.UpdateExpression).toBe('SET #k = :v, #u = :ts');
      expect(c.ConditionExpression).toBe('attribute_exists(#pk) AND (attribute_not_exists(#k) OR #k = :empty OR attribute_type(#k, :nullType))');
      expect(c.ExpressionAttributeValues).toMatchObject({ ':empty': '', ':nullType': 'NULL' });
      expect(c.ExpressionAttributeNames['#pk']).toBe('leadId');
    }
    expect(updateCalls[0].ExpressionAttributeNames['#k']).toBe('firstTouch');
    expect(updateCalls[0].ExpressionAttributeValues[':v']).toEqual({ src: 'ad' }); // objects persist as Maps
    expect(updateCalls[1].ExpressionAttributeNames['#k']).toBe('utm_source');
  });

  it('no attribute name or value is ever inlined in an expression (reserved / odd keys are safe)', async () => {
    await crmDb.setLeadTopLevelIfBlank('list_a', 'lead_1', { 'utm-weird.key name': 'x', domain: 'd', system: 's' });
    expect(updateCalls).toHaveLength(3);
    for (const c of updateCalls) {
      const expr = `${c.UpdateExpression} ${c.ConditionExpression}`;
      const k = c.ExpressionAttributeNames['#k'];
      expect(expr).not.toContain(k);
      expect(expr.replace(/#[a-z]+|:[a-zA-Z]+/g, '')).not.toMatch(/[A-Za-z]{4,}\b(?!\()/); // only placeholders and function names remain
    }
    expect(updateCalls.map((c) => c.ExpressionAttributeNames['#k'])).toEqual(['utm-weird.key name', 'domain', 'system']);
  });

  it('a ConditionalCheckFailedException is a skip (value already present, or row gone), not an error; other keys still go', async () => {
    updateImpl = async (p) => { if (p.ExpressionAttributeNames['#k'] === 'firstTouch') throw Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' }); return {}; };
    const r = await crmDb.setLeadTopLevelIfBlank('list_a', 'lead_1', { firstTouch: { a: 1 }, utm_source: 'fb' });
    expect(r).toEqual({ written: ['utm_source'], kept: ['firstTouch'] });
    expect(updateCalls).toHaveLength(2);
  });

  it('any OTHER error propagates and stops (the cleanup then deletes nothing)', async () => {
    updateImpl = async () => { throw Object.assign(new Error('throttled'), { code: 'ProvisionedThroughputExceededException' }); };
    await expect(crmDb.setLeadTopLevelIfBlank('list_a', 'lead_1', { firstTouch: { a: 1 }, utm_source: 'fb' })).rejects.toThrow('throttled');
    expect(updateCalls).toHaveLength(1);
  });

  it('never writes a blank value and never touches the primary key attributes', async () => {
    const r = await crmDb.setLeadTopLevelIfBlank('list_a', 'lead_1', { firstTouch: '', utm_source: null, utm_medium: undefined, leadId: 'x', listId: 'y', '': 'z' } as any);
    expect(r).toEqual({ written: [], kept: [] });
    expect(updateCalls).toHaveLength(0);
  });
});
