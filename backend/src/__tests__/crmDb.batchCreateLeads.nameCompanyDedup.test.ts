// Tests for the opt-in name+company dedup axis in batchCreateLeads.
//
// CSV imports that carry only firstName + lastName + company (no email or
// LinkedIn) need a composite dedup key so re-imports merge instead of
// duplicating. This is opt-in via { dedupByNameCompany: true } — every other
// caller (sync adapters, crons, agent mode) keeps the email/LinkedIn-only
// behavior untouched.

const queryPromiseMock = jest.fn();
const getPromiseMock = jest.fn();
const batchWritePromiseMock = jest.fn();
const updatePromiseMock = jest.fn();
const batchWriteSpy: jest.Mock = jest.fn(() => ({ promise: batchWritePromiseMock }));
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
  const allItems: any[] = [];
  for (const call of batchWriteSpy.mock.calls) {
    const requestItems = (call[0] as any).RequestItems as Record<string, any[]>;
    for (const reqs of Object.values(requestItems)) {
      for (const r of reqs) if (r.PutRequest?.Item) allItems.push(r.PutRequest.Item);
    }
  }
  return allItems;
}

describe('crmDb.batchCreateLeads — name+company dedup (opt-in)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryPromiseMock.mockResolvedValue({ Items: [] });
    getPromiseMock.mockResolvedValue({ Item: { listId: 'list-1', userId: 'user-1' } });
    batchWritePromiseMock.mockResolvedValue({});
    updatePromiseMock.mockResolvedValue({});
  });

  it('flags within-batch duplicate name+company (no email/LinkedIn) as an error row when opted in', async () => {
    const result = await crmDb.batchCreateLeads(
      'list-1',
      [
        { firstName: 'John', lastName: 'Doe', company: 'Acme' },
        { firstName: 'john', lastName: ' Doe ', company: 'ACME' },
      ],
      { dedupByNameCompany: true },
    );

    expect(result.errorCount).toBe(1);
    expect(result.errors[0]).toMatch(/duplicate/i);
    // Only the first row is written as a new lead.
    expect(batchedItems()).toHaveLength(1);
  });

  it('merges a name+company-only lead into an existing lead instead of duplicating', async () => {
    queryPromiseMock.mockResolvedValueOnce({
      Items: [
        {
          listId: 'list-1',
          leadId: 'existing-1',
          firstName: 'John',
          lastName: 'Doe',
          company: 'Acme',
          nameCompanyKey: 'john|doe|acme',
        },
      ],
    });
    const updateLeadSpy = jest.spyOn(crmDb, 'updateLead').mockResolvedValue({} as any);

    const result = await crmDb.batchCreateLeads(
      'list-1',
      [{ firstName: 'John', lastName: 'Doe', company: 'Acme', title: 'CEO' }],
      { dedupByNameCompany: true },
    );

    expect(result.mergedCount).toBe(1);
    expect(result.newCount).toBe(0);
    expect(updateLeadSpy).toHaveBeenCalledWith(
      'list-1',
      'existing-1',
      expect.objectContaining({ title: 'CEO' }),
    );
    expect(batchedItems()).toHaveLength(0);
    updateLeadSpy.mockRestore();
  });

  it('matches an existing lead that predates the stored nameCompanyKey field', async () => {
    // Older leads have no nameCompanyKey attribute — the key is recomputed
    // from firstName/lastName/company so they still dedup.
    queryPromiseMock.mockResolvedValueOnce({
      Items: [
        {
          listId: 'list-1',
          leadId: 'legacy-1',
          firstName: 'John',
          lastName: 'Doe',
          company: 'Acme',
        },
      ],
    });
    const updateLeadSpy = jest.spyOn(crmDb, 'updateLead').mockResolvedValue({} as any);

    const result = await crmDb.batchCreateLeads(
      'list-1',
      [{ firstName: 'John', lastName: 'Doe', company: 'Acme', title: 'CTO' }],
      { dedupByNameCompany: true },
    );

    expect(result.mergedCount).toBe(1);
    expect(updateLeadSpy).toHaveBeenCalledWith('list-1', 'legacy-1', expect.any(Object));
    updateLeadSpy.mockRestore();
  });

  it('creates a new lead when name+company has no existing match', async () => {
    const result = await crmDb.batchCreateLeads(
      'list-1',
      [{ firstName: 'Jane', lastName: 'Roe', company: 'Beta' }],
      { dedupByNameCompany: true },
    );

    expect(result.newCount).toBe(1);
    const items = batchedItems();
    expect(items).toHaveLength(1);
    expect(items[0].nameCompanyKey).toBe('jane|roe|beta');
  });

  it('does NOT dedup by name+company when the option is absent (default behavior preserved)', async () => {
    const result = await crmDb.batchCreateLeads('list-1', [
      { firstName: 'John', lastName: 'Doe', company: 'Acme' },
      { firstName: 'John', lastName: 'Doe', company: 'Acme' },
    ]);

    expect(result.errorCount).toBe(0);
    // Both rows become new leads — no composite dedup without opt-in.
    expect(batchedItems()).toHaveLength(2);
  });

  it('leads carrying an email dedup on email, not name+company, even when opted in', async () => {
    // Two distinct emails, identical name+company. Email is the stronger
    // identity, so both are kept — name+company must not collapse them.
    const result = await crmDb.batchCreateLeads(
      'list-1',
      [
        { email: 'a@x.com', firstName: 'John', lastName: 'Doe', company: 'Acme' },
        { email: 'b@x.com', firstName: 'John', lastName: 'Doe', company: 'Acme' },
      ],
      { dedupByNameCompany: true },
    );

    expect(result.errorCount).toBe(0);
    expect(batchedItems()).toHaveLength(2);
  });
});
