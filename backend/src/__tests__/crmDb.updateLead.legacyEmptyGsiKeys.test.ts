// Tests for updateLead self-healing of legacy empty-string GSI key
// attributes. AW-Leads has three sparse cross-tenant GSIs (EmailLookupIndex,
// LinkedinLookupIndex, NameCompanyLookupIndex) whose HASH keys are email,
// linkedin, and nameCompanyKey respectively, with RANGE key updatedAt.
//
// Legacy rows written before the sparse-index guards can still carry
// empty-string values for these attributes. Any updateLead call SETs
// updatedAt, which forces DDB to re-evaluate the GSI projection and reject
// the update with "AttributeValue for a key attribute cannot contain an
// empty string value". updateLead must detect those legacy empty-string
// attrs and queue a REMOVE in the same UpdateExpression.

const getPromiseMock = jest.fn();
const updatePromiseMock = jest.fn();
const getSpy: jest.Mock = jest.fn(() => ({ promise: getPromiseMock }));
const updateSpy: jest.Mock = jest.fn(() => ({ promise: updatePromiseMock }));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: getSpy,
      update: updateSpy,
      query: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
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

function leadUpdateParams(): any {
  // updateLead may issue a follow-up update on AW-LeadLists (fieldNames sync);
  // pick the one targeting AW-Leads.
  for (const call of updateSpy.mock.calls) {
    const params = call[0];
    if (typeof params?.TableName === 'string' && params.TableName.endsWith('AW-Leads')) {
      return params;
    }
  }
  throw new Error('update on AW-Leads was not called');
}

describe('crmDb.updateLead — legacy empty-string GSI key self-heal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updatePromiseMock.mockResolvedValue({ Attributes: {} });
  });

  it('REMOVEs linkedin when existing item has linkedin="" and update does not touch linkedin', async () => {
    getPromiseMock.mockResolvedValue({
      Item: {
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'jane@acme.com',
        linkedin: '',
        firstName: 'Jane',
        lastName: 'Doe',
        company: 'Acme',
      },
    });

    await crmDb.updateLead('list-1', 'lead-1', {
      syncMetadata: { hubspot_deal_id: 'deal-123' },
    });

    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/REMOVE\b.*\blinkedin\b/);
  });

  it('REMOVEs email when existing item has email="" and update does not touch email', async () => {
    getPromiseMock.mockResolvedValue({
      Item: {
        listId: 'list-1',
        leadId: 'lead-1',
        email: '',
        linkedin: 'https://linkedin.com/in/jane',
      },
    });

    await crmDb.updateLead('list-1', 'lead-1', {
      syncMetadata: { hubspot_contact_id: 'c-1' },
    });

    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/REMOVE\b.*\bemail\b/);
  });

  it('REMOVEs nameCompanyKey when existing item has nameCompanyKey="" and update does not recompute it', async () => {
    getPromiseMock.mockResolvedValue({
      Item: {
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'jane@acme.com',
        nameCompanyKey: '',
      },
    });

    await crmDb.updateLead('list-1', 'lead-1', {
      syncMetadata: { hubspot_deal_id: 'd' },
    });

    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/REMOVE\b.*\bnameCompanyKey\b/);
  });

  it('does NOT add REMOVE clauses when existing item has valid (non-empty) GSI keys', async () => {
    getPromiseMock.mockResolvedValue({
      Item: {
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'jane@acme.com',
        linkedin: 'https://linkedin.com/in/jane',
        nameCompanyKey: 'jane|doe|acme',
      },
    });

    await crmDb.updateLead('list-1', 'lead-1', {
      syncMetadata: { hubspot_deal_id: 'd' },
    });

    const params = leadUpdateParams();
    expect(params.UpdateExpression).not.toMatch(/REMOVE/);
  });

  it('does NOT REMOVE linkedin when caller is setting linkedin in the same update (SET wins, no duplicate clauses)', async () => {
    getPromiseMock.mockResolvedValue({
      Item: {
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'jane@acme.com',
        linkedin: '',
      },
    });

    await crmDb.updateLead('list-1', 'lead-1', {
      linkedin: 'https://linkedin.com/in/jane-new',
    });

    const params = leadUpdateParams();
    // SET linkedin must be present; no REMOVE linkedin in the same expression
    expect(params.UpdateExpression).toMatch(/SET\b.*\blinkedin\b/);
    expect(params.UpdateExpression).not.toMatch(/REMOVE\b[^]*\blinkedin\b/);
  });

  it('REMOVEs multiple empty-string GSI keys in one update when several are bad', async () => {
    getPromiseMock.mockResolvedValue({
      Item: {
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'jane@acme.com',
        linkedin: '',
        nameCompanyKey: '',
      },
    });

    await crmDb.updateLead('list-1', 'lead-1', {
      syncMetadata: { hubspot_deal_id: 'd' },
    });

    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/REMOVE\b.*\blinkedin\b/);
    expect(params.UpdateExpression).toMatch(/REMOVE\b.*\bnameCompanyKey\b/);
  });

  it('still works (no crash) when getLeadById returns null (item does not exist)', async () => {
    getPromiseMock.mockResolvedValue({ Item: undefined });

    await expect(
      crmDb.updateLead('list-1', 'lead-missing', {
        syncMetadata: { hubspot_deal_id: 'd' },
      }),
    ).resolves.not.toThrow();
  });
});

// ─── Null standard field handling (revert enrichment path) ───────────────────

describe('crmDb.updateLead — null standard fields → REMOVE', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updatePromiseMock.mockResolvedValue({ Attributes: {} });
    getPromiseMock.mockResolvedValue({
      Item: { listId: 'list-1', leadId: 'lead-1', email: 'jane@acme.com' },
    });
  });

  it('REMOVEs email when passed as null', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { email: null as any });
    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/REMOVE\b.*\bemail\b/);
    expect(params.ExpressionAttributeValues).not.toHaveProperty(':email');
  });

  it('REMOVEs linkedin when passed as null', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { linkedin: null as any });
    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/REMOVE\b.*\blinkedin\b/);
    expect(params.ExpressionAttributeValues).not.toHaveProperty(':linkedin');
  });

  it('REMOVEs companyLinkedin when passed as null', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { companyLinkedin: null as any });
    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/REMOVE\b.*\bcompanyLinkedin\b/);
    expect(params.ExpressionAttributeValues).not.toHaveProperty(':companyLinkedin');
  });

  it('REMOVEs firstName when passed as null', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { firstName: null as any });
    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/REMOVE\b.*\bfirstName\b/);
    expect(params.ExpressionAttributeValues).not.toHaveProperty(':firstName');
  });

  it('REMOVEs phone when passed as null', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { phone: null as any });
    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/REMOVE\b.*\bphone\b/);
  });

  it('REMOVEs company when passed as null', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { company: null as any });
    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/REMOVE\b.*\bcompany\b/);
  });

  it('REMOVEs title when passed as null', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { title: null as any });
    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/REMOVE\b.*\btitle\b/);
  });

  it('REMOVEs notes when passed as null', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { notes: null as any });
    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/REMOVE\b.*\bnotes\b/);
  });

  it('does not throw when all standard fields are null (revert of fully-enriched lead)', async () => {
    await expect(
      crmDb.updateLead('list-1', 'lead-1', {
        email: null as any,
        firstName: null as any,
        lastName: null as any,
        company: null as any,
        phone: null as any,
        title: null as any,
        linkedin: null as any,
        companyLinkedin: null as any,
        notes: null as any,
      }),
    ).resolves.not.toThrow();
  });
});
