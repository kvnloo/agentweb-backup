// Tests the defense-in-depth sanitizer at the crmDb.createLead write boundary.

const queryPromiseMock = jest.fn();
const getPromiseMock = jest.fn();
const putPromiseMock = jest.fn();
const putSpy: jest.Mock = jest.fn(() => ({ promise: putPromiseMock }));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: queryPromiseMock })),
      get: jest.fn(() => ({ promise: getPromiseMock })),
      put: putSpy,
      update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
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
