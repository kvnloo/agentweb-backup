// Tests the defense-in-depth customFields sanitizer at all crmDb write boundaries.
// Consolidates: createLead, batchCreateLeads, updateLead, setLeadFields guard tests.

const queryPromiseMock = jest.fn();
const getPromiseMock = jest.fn();
const putPromiseMock = jest.fn();
const batchWritePromiseMock = jest.fn();
const updatePromiseMock = jest.fn();

const putSpy: jest.Mock = jest.fn(() => ({ promise: putPromiseMock }));
const batchWriteSpy: jest.Mock = jest.fn(() => ({ promise: batchWritePromiseMock }));
const updateSpy: jest.Mock = jest.fn(() => ({ promise: updatePromiseMock }));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: queryPromiseMock })),
      get: jest.fn(() => ({ promise: getPromiseMock })),
      put: putSpy,
      update: updateSpy,
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

// ─── createLead ──────────────────────────────────────────────────────────────

function lastPutItem(): any {
  const call = putSpy.mock.calls[putSpy.mock.calls.length - 1];
  if (!call) throw new Error('put was not called');
  return (call[0] as any).Item;
}

describe('crmDb.createLead — customFields sanitizer', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    queryPromiseMock.mockResolvedValue({ Items: [] });
    putPromiseMock.mockResolvedValue({});
    updatePromiseMock.mockResolvedValue({});
    getPromiseMock
      .mockResolvedValueOnce({ Item: { listId: 'list-1', userId: 'user-1' } })
      .mockResolvedValue({ Item: null });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('coerces string customFields to {} and logs an error tagged db.createLead', async () => {
    await crmDb.createLead('list-1', {
      email: 'a@b.com',
      firstName: 'Test',
      // @ts-expect-error — intentionally pass a string to simulate upstream corruption
      customFields: '{"x":1}',
    });

    expect(lastPutItem().customFields).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[customFieldsGuard]'),
      expect.objectContaining({ source: 'db.createLead', type: 'string', listId: 'list-1' }),
    );
  });

  it('passes plain-object customFields through unchanged', async () => {
    await crmDb.createLead('list-1', {
      email: 'b@b.com',
      customFields: { foo: 'bar' },
    });

    expect(lastPutItem().customFields).toEqual({ foo: 'bar' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('coerces an array customFields to {} and logs the error', async () => {
    await crmDb.createLead('list-1', {
      email: 'c@b.com',
      customFields: ['a', 'b'] as any,
    });

    expect(lastPutItem().customFields).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[customFieldsGuard]'),
      expect.objectContaining({ source: 'db.createLead', isArray: true }),
    );
  });
});

// ─── batchCreateLeads ────────────────────────────────────────────────────────

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
    queryPromiseMock.mockResolvedValue({ Items: [] });
    getPromiseMock.mockResolvedValue({ Item: { listId: 'list-1', userId: 'user-1' } });
    batchWritePromiseMock.mockResolvedValue({});
    updatePromiseMock.mockResolvedValue({});
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
        customFields: ['a', 'b'] as any,
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

// ─── updateLead ──────────────────────────────────────────────────────────────

function lastUpdateWithCustomFields(): any {
  for (let i = updateSpy.mock.calls.length - 1; i >= 0; i--) {
    const p = updateSpy.mock.calls[i][0] as any;
    if (typeof p?.UpdateExpression === 'string' && p.UpdateExpression.includes(':customFields')) return p;
  }
  throw new Error('no dynamodb.update call had :customFields in its expression');
}

describe('crmDb.updateLead — customFields sanitizer', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    queryPromiseMock.mockResolvedValue({ Items: [] });
    getPromiseMock.mockResolvedValue({ Item: { listId: 'list-1', leadId: 'lead-1', userId: 'user-1' } });
    updatePromiseMock.mockResolvedValue({ Attributes: { listId: 'list-1', leadId: 'lead-1' } });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('coerces a string customFields to {} on the SET expression and logs db.updateLead', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { customFields: 'oops' as any });

    const params = lastUpdateWithCustomFields();
    expect(params.ExpressionAttributeValues[':customFields']).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[customFieldsGuard]'),
      expect.objectContaining({ source: 'db.updateLead', listId: 'list-1', leadId: 'lead-1', type: 'string' }),
    );
  });

  it('passes plain-object customFields through unchanged', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { customFields: { foo: 'bar' } });

    const params = lastUpdateWithCustomFields();
    expect(params.ExpressionAttributeValues[':customFields']).toEqual({ foo: 'bar' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('coerces an array customFields to {} and logs isArray', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { customFields: ['a', 'b'] as any });

    const params = lastUpdateWithCustomFields();
    expect(params.ExpressionAttributeValues[':customFields']).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[customFieldsGuard]'),
      expect.objectContaining({ source: 'db.updateLead', listId: 'list-1', leadId: 'lead-1', isArray: true }),
    );
  });
});

// ─── setLeadFields ───────────────────────────────────────────────────────────

// setLeadFields writes per-key (customFields.#cf0 = :cf0). Object.entries(string)
// would produce char-indexed entries — this guard prevents that corruption pattern.

function callsWithCustomFieldClauses(): any[] {
  return updateSpy.mock.calls
    .map((c) => c[0] as any)
    .filter((p) => typeof p?.UpdateExpression === 'string' && /customFields\.#cf/.test(p.UpdateExpression));
}

describe('crmDb.setLeadFields — customFields sanitizer', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    queryPromiseMock.mockResolvedValue({ Items: [] });
    getPromiseMock.mockResolvedValue({ Item: { listId: 'list-1', leadId: 'lead-1' } });
    updatePromiseMock.mockResolvedValue({});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('coerces a string options.customFields away and logs db.setLeadFields', async () => {
    await (crmDb as any).setLeadFields('list-1', 'lead-1', { customFields: 'corrupt' });

    expect(callsWithCustomFieldClauses()).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[customFieldsGuard]'),
      expect.objectContaining({ source: 'db.setLeadFields', listId: 'list-1', leadId: 'lead-1', type: 'string' }),
    );
  });

  it('writes per-key clauses for a normal object customFields', async () => {
    await (crmDb as any).setLeadFields('list-1', 'lead-1', { customFields: { foo: 'bar' } });

    const cfCalls = callsWithCustomFieldClauses();
    expect(cfCalls.length).toBeGreaterThan(0);
    const params = cfCalls[cfCalls.length - 1];
    const names = params.ExpressionAttributeNames as Record<string, string>;
    expect(Object.values(names)).toContain('foo');
    const values = params.ExpressionAttributeValues as Record<string, any>;
    expect(Object.values(values)).toContain('bar');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('coerces an array options.customFields away (Object.entries would corrupt) and logs isArray', async () => {
    await (crmDb as any).setLeadFields('list-1', 'lead-1', { customFields: ['a', 'b'] });

    expect(callsWithCustomFieldClauses()).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[customFieldsGuard]'),
      expect.objectContaining({ source: 'db.setLeadFields', listId: 'list-1', leadId: 'lead-1', isArray: true }),
    );
  });
});
