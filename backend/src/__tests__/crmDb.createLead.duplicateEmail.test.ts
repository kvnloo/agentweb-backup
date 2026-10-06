// createLead's duplicate-email pre-check must throw a TYPED error that carries the row it
// found, with the historical message untouched (callers and tests match on the text).

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

describe('crmDb.createLead — duplicate email', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    putPromiseMock.mockResolvedValue({});
    getPromiseMock.mockResolvedValue({ Item: null });
  });

  it('throws a typed error carrying the existing row, message unchanged, and writes nothing', async () => {
    const row = { listId: 'list-1', leadId: 'lead_existing', email: 'dup@example.com', customFields: { a: 1 } };
    queryPromiseMock.mockResolvedValue({ Items: [row] });

    const err: any = await crmDb.createLead('list-1', { email: ' Dup@Example.com ' }).catch((e: any) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Lead with email " Dup@Example.com " already exists in this list');
    expect(err.duplicateEmail).toBe(true);
    expect(err.existingLead).toBe(row);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('does not raise it when no row exists, or when the pre-check is skipped', async () => {
    queryPromiseMock.mockResolvedValue({ Items: [] });
    await expect(crmDb.createLead('list-1', { email: 'new@example.com' })).resolves.toBeDefined();

    queryPromiseMock.mockResolvedValue({ Items: [{ leadId: 'x' }] });
    await expect(
      crmDb.createLead('list-1', { email: 'new@example.com', skipEmailDuplicateCheck: true }),
    ).resolves.toBeDefined();
  });
});
