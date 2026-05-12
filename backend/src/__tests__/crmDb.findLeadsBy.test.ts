// Tests for the three cross-tenant lookup methods used by CRM-history Tier 0:
//   - findLeadsByEmail (EmailLookupIndex GSI)
//   - findLeadsByLinkedin (LinkedinLookupIndex GSI)
//   - findLeadsByNameCompany (NameCompanyLookupIndex GSI)
//
// All three: Query against the relevant GSI with ScanIndexForward false
// (freshest by updatedAt), Limit 10, return LeadRecord[].

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

function lastQueryParams(): any {
  const call = querySpy.mock.calls[querySpy.mock.calls.length - 1];
  if (!call) throw new Error('query was not called');
  return call[0];
}

describe('crmDb.findLeadsByEmail', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns [] without calling DDB when email is empty/whitespace', async () => {
    expect(await crmDb.findLeadsByEmail('')).toEqual([]);
    expect(await crmDb.findLeadsByEmail('   ')).toEqual([]);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('returns [] when no leads match', async () => {
    queryPromiseMock.mockResolvedValue({ Items: [] });
    expect(await crmDb.findLeadsByEmail('nope@nope.com')).toEqual([]);
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it('queries EmailLookupIndex with ScanIndexForward false and Limit 10', async () => {
    queryPromiseMock.mockResolvedValue({
      Items: [{ leadId: 'lead-a', email: 'jane@acme.com', userId: 'user-1' }],
    });
    const result = await crmDb.findLeadsByEmail('Jane@Acme.com');

    const params = lastQueryParams();
    expect(params.IndexName).toBe('EmailLookupIndex');
    expect(params.ScanIndexForward).toBe(false);
    expect(params.Limit).toBe(10);
    expect(params.ExpressionAttributeValues[':email']).toBe('jane@acme.com');
    expect(result).toHaveLength(1);
    expect(result[0].leadId).toBe('lead-a');
  });

  it('returns multiple matches in DDB-returned order (already sorted by sort key updatedAt desc)', async () => {
    queryPromiseMock.mockResolvedValue({
      Items: [
        { leadId: 'fresh', email: 'jane@acme.com', updatedAt: '2026-05-12T10:00:00Z' },
        { leadId: 'stale', email: 'jane@acme.com', updatedAt: '2026-01-01T00:00:00Z' },
      ],
    });
    const result = await crmDb.findLeadsByEmail('jane@acme.com');
    expect(result.map(r => r.leadId)).toEqual(['fresh', 'stale']);
  });
});

describe('crmDb.findLeadsByLinkedin', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns [] without calling DDB when linkedin is empty', async () => {
    expect(await crmDb.findLeadsByLinkedin('')).toEqual([]);
    expect(await crmDb.findLeadsByLinkedin('   ')).toEqual([]);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('queries LinkedinLookupIndex with the trimmed linkedin value', async () => {
    queryPromiseMock.mockResolvedValue({ Items: [] });
    await crmDb.findLeadsByLinkedin('  https://linkedin.com/in/jane  ');

    const params = lastQueryParams();
    expect(params.IndexName).toBe('LinkedinLookupIndex');
    expect(params.ScanIndexForward).toBe(false);
    expect(params.Limit).toBe(10);
    expect(params.ExpressionAttributeValues[':linkedin']).toBe('https://linkedin.com/in/jane');
  });

  it('returns matching leads', async () => {
    queryPromiseMock.mockResolvedValue({
      Items: [{ leadId: 'lead-li', linkedin: 'https://linkedin.com/in/jane' }],
    });
    const result = await crmDb.findLeadsByLinkedin('https://linkedin.com/in/jane');
    expect(result).toHaveLength(1);
  });
});

describe('crmDb.findLeadsByNameCompany', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns [] without calling DDB when any of f/l/c is missing', async () => {
    expect(await crmDb.findLeadsByNameCompany('', 'Doe', 'Acme')).toEqual([]);
    expect(await crmDb.findLeadsByNameCompany('Jane', '', 'Acme')).toEqual([]);
    expect(await crmDb.findLeadsByNameCompany('Jane', 'Doe', '')).toEqual([]);
    expect(await crmDb.findLeadsByNameCompany('  ', 'Doe', 'Acme')).toEqual([]);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('queries NameCompanyLookupIndex with synthesized lowercased key', async () => {
    queryPromiseMock.mockResolvedValue({ Items: [] });
    await crmDb.findLeadsByNameCompany('Jane', 'Doe', 'Acme Inc');

    const params = lastQueryParams();
    expect(params.IndexName).toBe('NameCompanyLookupIndex');
    expect(params.ScanIndexForward).toBe(false);
    expect(params.Limit).toBe(10);
    expect(params.ExpressionAttributeValues[':nameCompanyKey']).toBe('jane|doe|acme inc');
  });

  it('returns matching leads', async () => {
    queryPromiseMock.mockResolvedValue({
      Items: [{ leadId: 'lead-nc', nameCompanyKey: 'jane|doe|acme' }],
    });
    const result = await crmDb.findLeadsByNameCompany('Jane', 'Doe', 'Acme');
    expect(result).toHaveLength(1);
  });
});
