// Tests that batchCreateLeads sets nameCompanyKey on new leads when
// firstName + lastName + company are all present. This was a bug where the
// field was never written, breaking Tier 0 sibling matching during enrichment.

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

describe('crmDb.batchCreateLeads — nameCompanyKey (new-lead path)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryPromiseMock.mockResolvedValue({ Items: [] });
    getPromiseMock.mockResolvedValue({ Item: { listId: 'list-1', userId: 'user-1' } });
    batchWritePromiseMock.mockResolvedValue({});
  });

  it('sets nameCompanyKey when firstName + lastName + company all present', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { email: 'a@example.com', firstName: 'John', lastName: 'Doe', company: 'Acme' },
    ]);

    const items = batchedItems();
    expect(items).toHaveLength(1);
    expect(items[0].nameCompanyKey).toBe('john|doe|acme');
  });

  it('does not set nameCompanyKey when firstName missing', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { email: 'b@example.com', lastName: 'Doe', company: 'Acme' },
    ]);

    const items = batchedItems();
    expect(items[0].nameCompanyKey).toBeUndefined();
  });

  it('does not set nameCompanyKey when lastName missing', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { email: 'c@example.com', firstName: 'John', company: 'Acme' },
    ]);

    const items = batchedItems();
    expect(items[0].nameCompanyKey).toBeUndefined();
  });

  it('does not set nameCompanyKey when company missing', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { email: 'd@example.com', firstName: 'John', lastName: 'Doe' },
    ]);

    const items = batchedItems();
    expect(items[0].nameCompanyKey).toBeUndefined();
  });

  it('lowercases and trims all three fields in the key', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { email: 'e@example.com', firstName: '  YONATAN ', lastName: ' Pesses ', company: ' Tailor Brands ' },
    ]);

    const items = batchedItems();
    expect(items[0].nameCompanyKey).toBe('yonatan|pesses|tailor brands');
  });

  it('sets nameCompanyKey independently per lead in a batch', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { email: 'f@example.com', firstName: 'Alice', lastName: 'Smith', company: 'Corp' },
      { email: 'g@example.com', firstName: 'Bob' }, // missing lastName + company
    ]);

    const items = batchedItems();
    const alice = items.find(i => i.email === 'f@example.com');
    const bob = items.find(i => i.email === 'g@example.com');
    expect(alice?.nameCompanyKey).toBe('alice|smith|corp');
    expect(bob?.nameCompanyKey).toBeUndefined();
  });
});
