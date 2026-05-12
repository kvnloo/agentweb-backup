// Tests for crmDb.batchGetLeads — composite-key BatchGetItem over AW-Leads.
//
// Used by the v3.1 enrichment dep to load only the user-selected leads
// (bulk-actions selection) without paginating the entire list.

const batchGetPromiseMock = jest.fn();
const batchGetSpy: jest.Mock = jest.fn(() => ({ promise: batchGetPromiseMock }));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      get: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      scan: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      batchGet: batchGetSpy,
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

const LIST_ID = 'list-1';

describe('crmDb.batchGetLeads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns [] without calling DynamoDB when leadIds is empty', async () => {
    const result = await crmDb.batchGetLeads(LIST_ID, []);
    expect(result).toEqual([]);
    expect(batchGetSpy).not.toHaveBeenCalled();
  });

  it('fetches leads for a single batch (<=25 ids) in one BatchGetItem call', async () => {
    batchGetPromiseMock.mockResolvedValueOnce({
      Responses: {
        ['AW-Leads']: [
          { listId: LIST_ID, leadId: 'lead-1', email: 'a@x.com' },
          { listId: LIST_ID, leadId: 'lead-2', email: 'b@x.com' },
        ],
      },
    });

    const result = await crmDb.batchGetLeads(LIST_ID, ['lead-1', 'lead-2']);

    expect(batchGetSpy).toHaveBeenCalledTimes(1);
    const params = batchGetSpy.mock.calls[0][0] as any;
    expect(params.RequestItems['AW-Leads'].Keys).toEqual([
      { listId: LIST_ID, leadId: 'lead-1' },
      { listId: LIST_ID, leadId: 'lead-2' },
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((l: any) => l.leadId).sort()).toEqual(['lead-1', 'lead-2']);
  });

  it('chunks into multiple BatchGetItem calls when leadIds exceeds the per-batch cap', async () => {
    // 60 ids → 3 batches of 25/25/10
    const ids = Array.from({ length: 60 }, (_, i) => `lead-${i + 1}`);
    batchGetPromiseMock
      .mockResolvedValueOnce({
        Responses: { ['AW-Leads']: ids.slice(0, 25).map(id => ({ listId: LIST_ID, leadId: id })) },
      })
      .mockResolvedValueOnce({
        Responses: { ['AW-Leads']: ids.slice(25, 50).map(id => ({ listId: LIST_ID, leadId: id })) },
      })
      .mockResolvedValueOnce({
        Responses: { ['AW-Leads']: ids.slice(50, 60).map(id => ({ listId: LIST_ID, leadId: id })) },
      });

    const result = await crmDb.batchGetLeads(LIST_ID, ids);

    expect(batchGetSpy).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(60);
    // Last batch should carry the remainder of 10 keys
    const lastParams = batchGetSpy.mock.calls[2][0] as any;
    expect(lastParams.RequestItems['AW-Leads'].Keys).toHaveLength(10);
  });

  it('propagates errors from DynamoDB and stops further batches', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `lead-${i + 1}`);
    batchGetPromiseMock.mockRejectedValueOnce(new Error('DDB threw'));

    await expect(crmDb.batchGetLeads(LIST_ID, ids)).rejects.toThrow();
    // Failed on the first batch — second batch must not run.
    expect(batchGetSpy).toHaveBeenCalledTimes(1);
  });
});
