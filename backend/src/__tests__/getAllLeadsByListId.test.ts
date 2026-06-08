// Tests for crmDb.getAllLeadsByListId — the paginated loader that follows
// DynamoDB pagination across pages and returns every lead for a list.

const queryPromiseMock = jest.fn();
const querySpy: jest.Mock = jest.fn(() => ({ promise: queryPromiseMock }));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: querySpy,
      get: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
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

describe('getAllLeadsByListId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('follows pagination across multiple pages', async () => {
    queryPromiseMock
      .mockResolvedValueOnce({ Items: [{ leadId: 'a' }], LastEvaluatedKey: { leadId: 'a' } })
      .mockResolvedValueOnce({ Items: [{ leadId: 'b' }], LastEvaluatedKey: null });

    const leads = await crmDb.getAllLeadsByListId('list-1');

    expect(leads.map((l: any) => l.leadId)).toEqual(['a', 'b']);
    expect(querySpy).toHaveBeenCalledTimes(2);
  });
});
