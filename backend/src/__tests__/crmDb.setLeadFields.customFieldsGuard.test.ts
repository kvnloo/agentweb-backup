// Tests the defense-in-depth sanitizer at the crmDb.setLeadFields write boundary.
//
// setLeadFields writes per-key (customFields.#cf0 = :cf0). Object.entries(string)
// would produce char-indexed entries — this guard prevents that corruption pattern.

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

/** Find any update call whose UpdateExpression touches a customFields.#cf* path. */
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

    // No update call should reference per-key customFields paths.
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
    // ExpressionAttributeNames maps a `#cf*` placeholder → 'foo'
    const names = params.ExpressionAttributeNames as Record<string, string>;
    expect(Object.values(names)).toContain('foo');
    // ExpressionAttributeValues includes the :cf* placeholder with value 'bar'
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
