// Tests the defense-in-depth sanitizer at the crmDb.updateLead write boundary.

const queryPromiseMock = jest.fn();
const getPromiseMock = jest.fn();
const updatePromiseMock = jest.fn();
const updateSpy: jest.Mock = jest.fn(() => ({ promise: updatePromiseMock }));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: queryPromiseMock })),
      get: jest.fn(() => ({ promise: getPromiseMock })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      update: updateSpy,
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      scan: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      batchGet: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
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

/** Find the most recent dynamodb.update call whose UpdateExpression references customFields. */
function lastUpdateParams(): any {
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

    const params = lastUpdateParams();
    expect(params.ExpressionAttributeValues[':customFields']).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[customFieldsGuard]'),
      expect.objectContaining({ source: 'db.updateLead', listId: 'list-1', leadId: 'lead-1', type: 'string' }),
    );
  });

  it('passes plain-object customFields through unchanged', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { customFields: { foo: 'bar' } });

    const params = lastUpdateParams();
    expect(params.ExpressionAttributeValues[':customFields']).toEqual({ foo: 'bar' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('coerces an array customFields to {} and logs isArray', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { customFields: ['a', 'b'] as any });

    const params = lastUpdateParams();
    expect(params.ExpressionAttributeValues[':customFields']).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[customFieldsGuard]'),
      expect.objectContaining({ source: 'db.updateLead', listId: 'list-1', leadId: 'lead-1', isArray: true }),
    );
  });
});
