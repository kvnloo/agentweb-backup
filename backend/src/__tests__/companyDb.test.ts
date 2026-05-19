/**
 * Unit tests for companyDb — AW-CRMCompanies service.
 * Tests run against mocked DynamoDB; no live AWS calls.
 */

const mockDynamoMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => mockDynamoMethods),
  },
  S3: jest.fn(() => ({})),
}));

// companyDb imports dynamodb from config/aws which wraps DocumentClient
jest.mock('../config/aws', () => ({
  dynamodb: mockDynamoMethods,
}));

import {
  companyDb,
  CompanyNotFoundError,
  CompanyAuthError,
  generateCompanyId,
} from '../services/companyDb';

const promiseOk = (value: any = {}) => ({ promise: jest.fn().mockResolvedValue(value) });
const promiseErr = (err: any) => ({ promise: jest.fn().mockRejectedValue(err) });

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// generateCompanyId
// ---------------------------------------------------------------------------
describe('generateCompanyId', () => {
  it('returns a string starting with company_', () => {
    expect(generateCompanyId()).toMatch(/^company_\d+_[a-z0-9]+$/);
  });

  it('produces unique ids on repeated calls', () => {
    const ids = new Set(Array.from({ length: 20 }, generateCompanyId));
    expect(ids.size).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// createCompany
// ---------------------------------------------------------------------------
describe('createCompany', () => {
  it('persists company and returns it with generated fields', async () => {
    mockDynamoMethods.put.mockReturnValue(promiseOk());
    const result = await companyDb.createCompany({
      userId: 'user_1',
      name: 'Warp',
      domain: 'warp.dev',
      dealStage: 'Prospect',
    });
    expect(result.companyId).toMatch(/^company_/);
    expect(result.userId).toBe('user_1');
    expect(result.name).toBe('Warp');
    expect(result.domain).toBe('warp.dev');
    expect(result.dealStage).toBe('Prospect');
    expect(result.createdAt).toBeDefined();
    expect(result.updatedAt).toBeDefined();
    expect(mockDynamoMethods.put).toHaveBeenCalledTimes(1);
  });

  it('lowercases the domain', async () => {
    mockDynamoMethods.put.mockReturnValue(promiseOk());
    const result = await companyDb.createCompany({ userId: 'u1', name: 'Acme', domain: 'ACME.COM' });
    expect(result.domain).toBe('acme.com');
  });

  it('does not set optional fields when not provided', async () => {
    mockDynamoMethods.put.mockReturnValue(promiseOk());
    const result = await companyDb.createCompany({ userId: 'u1', name: 'Minimal' });
    expect(result.domain).toBeUndefined();
    expect(result.industry).toBeUndefined();
    expect(result.dealStage).toBeUndefined();
  });

  it('propagates DynamoDB errors', async () => {
    mockDynamoMethods.put.mockReturnValue(promiseErr(new Error('put failed')));
    await expect(companyDb.createCompany({ userId: 'u1', name: 'Bad' })).rejects.toThrow('put failed');
  });
});

// ---------------------------------------------------------------------------
// getCompany
// ---------------------------------------------------------------------------
describe('getCompany', () => {
  it('returns company when found', async () => {
    const item = { companyId: 'company_1', userId: 'u1', name: 'Warp', createdAt: 'x', updatedAt: 'x' };
    mockDynamoMethods.get.mockReturnValue(promiseOk({ Item: item }));
    const result = await companyDb.getCompany('company_1');
    expect(result).toEqual(item);
  });

  it('returns null when not found', async () => {
    mockDynamoMethods.get.mockReturnValue(promiseOk({}));
    const result = await companyDb.getCompany('company_missing');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listCompaniesByUser
// ---------------------------------------------------------------------------
describe('listCompaniesByUser', () => {
  it('queries userId-createdAt-index and returns items', async () => {
    const items = [
      { companyId: 'c1', userId: 'u1', name: 'A', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { companyId: 'c2', userId: 'u1', name: 'B', createdAt: '2026-01-02', updatedAt: '2026-01-02' },
    ];
    mockDynamoMethods.query.mockReturnValue(promiseOk({ Items: items }));
    const result = await companyDb.listCompaniesByUser('u1');
    expect(result).toEqual(items);
    const call = mockDynamoMethods.query.mock.calls[0][0];
    expect(call.IndexName).toBe('userId-createdAt-index');
    expect(call.ExpressionAttributeValues[':uid']).toBe('u1');
  });

  it('returns empty array when user has no companies', async () => {
    mockDynamoMethods.query.mockReturnValue(promiseOk({ Items: [] }));
    const result = await companyDb.listCompaniesByUser('u_empty');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// updateCompany
// ---------------------------------------------------------------------------
describe('updateCompany', () => {
  const existing = { companyId: 'c1', userId: 'u1', name: 'Old', createdAt: 'x', updatedAt: 'x' };
  const updated = { ...existing, name: 'New', updatedAt: 'y' };

  it('updates company fields and returns new item', async () => {
    mockDynamoMethods.get.mockReturnValue(promiseOk({ Item: existing }));
    mockDynamoMethods.update.mockReturnValue(promiseOk({ Attributes: updated }));
    const result = await companyDb.updateCompany('c1', 'u1', { name: 'New' });
    expect(result.name).toBe('New');
  });

  it('throws CompanyNotFoundError when company does not exist', async () => {
    mockDynamoMethods.get.mockReturnValue(promiseOk({}));
    await expect(companyDb.updateCompany('missing', 'u1', { name: 'X' }))
      .rejects.toThrow(CompanyNotFoundError);
  });

  it('throws CompanyAuthError when userId does not match', async () => {
    mockDynamoMethods.get.mockReturnValue(promiseOk({ Item: existing }));
    await expect(companyDb.updateCompany('c1', 'other_user', { name: 'X' }))
      .rejects.toThrow(CompanyAuthError);
  });

  it('sets REMOVE clause when null is passed for an optional field', async () => {
    mockDynamoMethods.get.mockReturnValue(promiseOk({ Item: existing }));
    mockDynamoMethods.update.mockReturnValue(promiseOk({ Attributes: existing }));
    await companyDb.updateCompany('c1', 'u1', { notes: null });
    const call = mockDynamoMethods.update.mock.calls[0][0];
    expect(call.UpdateExpression).toContain('REMOVE #notes');
  });
});

// ---------------------------------------------------------------------------
// deleteCompany
// ---------------------------------------------------------------------------
describe('deleteCompany', () => {
  const existing = { companyId: 'c1', userId: 'u1', name: 'Warp', createdAt: 'x', updatedAt: 'x' };

  it('deletes company when authorized', async () => {
    mockDynamoMethods.get.mockReturnValue(promiseOk({ Item: existing }));
    mockDynamoMethods.delete.mockReturnValue(promiseOk());
    await expect(companyDb.deleteCompany('c1', 'u1')).resolves.toBeUndefined();
    expect(mockDynamoMethods.delete).toHaveBeenCalledTimes(1);
  });

  it('throws CompanyNotFoundError for missing company', async () => {
    mockDynamoMethods.get.mockReturnValue(promiseOk({}));
    await expect(companyDb.deleteCompany('missing', 'u1')).rejects.toThrow(CompanyNotFoundError);
  });

  it('throws CompanyAuthError for wrong user', async () => {
    mockDynamoMethods.get.mockReturnValue(promiseOk({ Item: existing }));
    await expect(companyDb.deleteCompany('c1', 'intruder')).rejects.toThrow(CompanyAuthError);
  });
});

// ---------------------------------------------------------------------------
// assignLeadToCompany / unassignLeadFromCompany
// ---------------------------------------------------------------------------
describe('assignLeadToCompany', () => {
  it('updates lead with companyId', async () => {
    mockDynamoMethods.update.mockReturnValue(promiseOk());
    await companyDb.assignLeadToCompany('list_1', 'lead_1', 'company_1');
    const call = mockDynamoMethods.update.mock.calls[0][0];
    expect(call.UpdateExpression).toContain('companyId = :cid');
    expect(call.ExpressionAttributeValues[':cid']).toBe('company_1');
  });

  it('propagates DynamoDB ConditionalCheckFailed for non-existent lead', async () => {
    const err = Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' });
    mockDynamoMethods.update.mockReturnValue(promiseErr(err));
    await expect(companyDb.assignLeadToCompany('l', 'x', 'c')).rejects.toThrow('cond');
  });
});

describe('unassignLeadFromCompany', () => {
  it('removes companyId from lead', async () => {
    mockDynamoMethods.update.mockReturnValue(promiseOk());
    await companyDb.unassignLeadFromCompany('list_1', 'lead_1');
    const call = mockDynamoMethods.update.mock.calls[0][0];
    expect(call.UpdateExpression).toContain('REMOVE companyId');
  });
});

// ---------------------------------------------------------------------------
// getLeadsByCompanyId
// ---------------------------------------------------------------------------
describe('getLeadsByCompanyId', () => {
  it('queries companyId-index GSI', async () => {
    const leads = [{ listId: 'l1', leadId: 'x', companyId: 'c1' }];
    mockDynamoMethods.query.mockReturnValue(promiseOk({ Items: leads }));
    const result = await companyDb.getLeadsByCompanyId('c1');
    expect(result).toEqual(leads);
    const call = mockDynamoMethods.query.mock.calls[0][0];
    expect(call.IndexName).toBe('companyId-index');
    expect(call.ExpressionAttributeValues[':cid']).toBe('c1');
  });

  it('returns empty array when no leads found', async () => {
    mockDynamoMethods.query.mockReturnValue(promiseOk({}));
    const result = await companyDb.getLeadsByCompanyId('empty_company');
    expect(result).toEqual([]);
  });
});
