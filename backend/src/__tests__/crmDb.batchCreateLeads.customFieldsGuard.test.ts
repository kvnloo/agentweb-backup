// Tests the defense-in-depth sanitizer at the batchCreateLeads new-lead write boundary.

const queryPromiseMock = jest.fn();
const getPromiseMock = jest.fn();
const batchWritePromiseMock = jest.fn();
const batchWriteSpy: jest.Mock = jest.fn(() => ({ promise: batchWritePromiseMock }));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: queryPromiseMock })),
      get: jest.fn(() => ({ promise: getPromiseMock })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      scan: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      batchGet: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      batchWrite: batchWriteSpy,
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Location: '', Key: '' }) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getSignedUrl: jest.fn(),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
  })),
}));

import { crmDb } from '../services/db';

/** Pull the Items out of the most recent batchWrite call, regardless of table name. */
function batchedItems(): any[] {
  const call = batchWriteSpy.mock.calls[batchWriteSpy.mock.calls.length - 1];
  if (!call) throw new Error('batchWrite was not called');
  const requestItems = (call[0] as any).RequestItems as Record<string, any[]>;
  const allItems: any[] = [];
  for (const reqs of Object.values(requestItems)) {
    for (const r of reqs) if (r.PutRequest?.Item) allItems.push(r.PutRequest.Item);
  }
  return allItems;
}

describe('crmDb.batchCreateLeads — customFields sanitizer (new-lead path)', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // No existing leads in the list.
    queryPromiseMock.mockResolvedValue({ Items: [] });
    getPromiseMock.mockResolvedValue({ Item: { listId: 'list-1', userId: 'user-1' } });
    batchWritePromiseMock.mockResolvedValue({});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('coerces a string customFields to {} on the written Item and logs db.batchCreateLeads.newLead', async () => {
    await crmDb.batchCreateLeads('list-1', [
      {
        email: 'a@b.com',
        firstName: 'Test',
        // @ts-expect-error — intentionally pass a string to simulate upstream corruption
        customFields: '{"x":1}',
      },
    ]);

    const items = batchedItems();
    expect(items).toHaveLength(1);
    expect(items[0].customFields).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[customFieldsGuard]'),
      expect.objectContaining({ source: 'db.batchCreateLeads.newLead', type: 'string', listId: 'list-1' }),
    );
  });

  it('passes plain-object customFields through unchanged', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { email: 'b@b.com', customFields: { foo: 'bar' } },
    ]);

    const items = batchedItems();
    expect(items).toHaveLength(1);
    expect(items[0].customFields).toEqual({ foo: 'bar' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('coerces an array customFields to {} on the written Item and logs isArray', async () => {
    await crmDb.batchCreateLeads('list-1', [
      {
        email: 'c@b.com',
        // @ts-expect-error — intentionally pass an array
        customFields: ['a', 'b'],
      },
    ]);

    const items = batchedItems();
    expect(items[0].customFields).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[customFieldsGuard]'),
      expect.objectContaining({ source: 'db.batchCreateLeads.newLead', isArray: true }),
    );
  });
});
