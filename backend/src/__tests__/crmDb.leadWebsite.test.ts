// Tests that createLead / updateLead / batchCreateLeads persist a caller-
// supplied `website`.
//
// Bug (found live, ENG-1388/ENG-1932 Enigma testing): `website` is a
// first-class LeadRecord attribute — domain resolution for enrichment
// (resolveApolloMatchDomain, enrichmentV3RealDeps.ts) reads lead.website
// directly, and a "Tier 0.5" resolver writes it back. But none of the three
// write paths accepted it as an input: a caller-supplied website was always
// silently dropped, so only that resolver could ever populate the field. A
// lead created via the API, a CSV import, or a LinkedIn bulk-import with an
// explicit website ended up with no domain for Enigma (or anything else) to
// resolve against.

const getPromiseMock = jest.fn();
const putPromiseMock = jest.fn();
const updatePromiseMock = jest.fn();
const putSpy: jest.Mock = jest.fn(() => ({ promise: putPromiseMock }));
const updateSpy: jest.Mock = jest.fn(() => ({ promise: updatePromiseMock }));
const batchWriteMock = jest.fn();
const batchWriteSpy: jest.Mock = jest.fn(() => ({ promise: batchWriteMock }));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: jest.fn(() => ({ promise: getPromiseMock })),
      put: putSpy,
      update: updateSpy,
      query: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
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

function lastPutItem(): any {
  const call = putSpy.mock.calls[putSpy.mock.calls.length - 1];
  if (!call) throw new Error('put was not called');
  return (call[0] as any).Item;
}

function leadUpdateParams(): any {
  for (const call of updateSpy.mock.calls) {
    const params = call[0];
    if (typeof params?.TableName === 'string' && params.TableName.endsWith('AW-Leads')) return params;
  }
  throw new Error('update on AW-Leads was not called');
}

describe('crmDb.createLead — website', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getPromiseMock.mockResolvedValueOnce({ Item: { listId: 'list-1', userId: 'user-1' } }).mockResolvedValue({ Item: null });
    putPromiseMock.mockResolvedValue({});
    updatePromiseMock.mockResolvedValue({ Attributes: {} }); // createLead's updateFieldNames side-write
  });

  it('persists a caller-supplied website', async () => {
    await crmDb.createLead('list-1', { firstName: 'Jane', company: 'Acme', website: 'acme.com' });
    expect(lastPutItem().website).toBe('acme.com');
  });

  it('defaults to empty string when omitted (matches every other plain field)', async () => {
    await crmDb.createLead('list-1', { firstName: 'Jane', company: 'Acme' });
    expect(lastPutItem().website).toBe('');
  });
});

describe('crmDb.updateLead — website', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updatePromiseMock.mockResolvedValue({ Attributes: {} });
    getPromiseMock.mockResolvedValue({ Item: { listId: 'list-1', leadId: 'lead-1' } });
  });

  it('SETs website when supplied', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { website: 'blueland.com' });
    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/SET\b.*\bwebsite\b/);
    expect(params.ExpressionAttributeValues[':website']).toBe('blueland.com');
  });

  it('REMOVEs website when set to empty string (matches company/title/notes)', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { website: '' });
    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/REMOVE\b.*\bwebsite\b/);
  });

  it('leaves website untouched when not in the update payload', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { firstName: 'Jane' });
    const params = leadUpdateParams();
    expect(params.UpdateExpression || '').not.toMatch(/\bwebsite\b/);
  });
});

describe('crmDb.batchCreateLeads — website', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getPromiseMock.mockResolvedValue({ Item: null });
    batchWriteMock.mockResolvedValue({ UnprocessedItems: {} });
  });

  it('persists a caller-supplied website on a newly created lead', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { firstName: 'Jane', company: 'Acme', website: 'acme.com' },
    ]);
    const call = batchWriteSpy.mock.calls.find((c: any) =>
      Object.keys(c[0].RequestItems).some((t: string) => t.endsWith('AW-Leads')));
    expect(call).toBeDefined();
    const table = Object.keys(call![0].RequestItems).find((t: string) => t.endsWith('AW-Leads'))!;
    const item = call![0].RequestItems[table][0].PutRequest.Item;
    expect(item.website).toBe('acme.com');
  });
});
