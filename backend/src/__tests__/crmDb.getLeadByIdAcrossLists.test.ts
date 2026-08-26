// Tests for crmDb.getLeadByIdAcrossLists — the ENG-969 follow-up reverse lookup
// that lets getLeadDetails recover when a caller pairs a valid lead_id with a
// stale/wrong list_id (production session 6082779b-f9f1-4e38-a8eb-34abbc3da419).

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

const LEAD_ID = 'lead-1776952951589_2x9dod7nx';

describe('crmDb.getLeadByIdAcrossLists', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null without calling DynamoDB when candidateListIds is empty', async () => {
    const result = await crmDb.getLeadByIdAcrossLists([], LEAD_ID);
    expect(result).toBeNull();
    expect(batchGetSpy).not.toHaveBeenCalled();
  });

  it('finds the lead in a single batch (<=25 candidate lists)', async () => {
    batchGetPromiseMock.mockResolvedValueOnce({
      Responses: {
        ['AW-Leads']: [{ listId: 'list-b', leadId: LEAD_ID, email: 'a@x.com' }],
      },
    });

    const result = await crmDb.getLeadByIdAcrossLists(['list-a', 'list-b'], LEAD_ID);

    expect(batchGetSpy).toHaveBeenCalledTimes(1);
    const params = batchGetSpy.mock.calls[0][0] as any;
    expect(params.RequestItems['AW-Leads'].Keys).toEqual([
      { listId: 'list-a', leadId: LEAD_ID },
      { listId: 'list-b', leadId: LEAD_ID },
    ]);
    expect(result).toEqual({ listId: 'list-b', leadId: LEAD_ID, email: 'a@x.com' });
  });

  it('stops after the batch that finds a match, without querying later batches', async () => {
    // 30 candidate lists → 2 batches of 25/5; the match is in the first batch.
    const listIds = Array.from({ length: 30 }, (_, i) => `list-${i + 1}`);
    batchGetPromiseMock.mockResolvedValueOnce({
      Responses: { ['AW-Leads']: [{ listId: 'list-3', leadId: LEAD_ID }] },
    });

    const result = await crmDb.getLeadByIdAcrossLists(listIds, LEAD_ID);

    expect(batchGetSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ listId: 'list-3', leadId: LEAD_ID });
  });

  it('checks every batch and returns null when no candidate list has the lead', async () => {
    const listIds = Array.from({ length: 30 }, (_, i) => `list-${i + 1}`);
    batchGetPromiseMock
      .mockResolvedValueOnce({ Responses: { ['AW-Leads']: [] } })
      .mockResolvedValueOnce({ Responses: { ['AW-Leads']: [] } });

    const result = await crmDb.getLeadByIdAcrossLists(listIds, LEAD_ID);

    expect(batchGetSpy).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
  });

  it('caps candidate lists at 200 so a pathological org cannot turn this into an unbounded scan', async () => {
    const listIds = Array.from({ length: 500 }, (_, i) => `list-${i + 1}`);
    batchGetPromiseMock.mockResolvedValue({ Responses: { ['AW-Leads']: [] } });

    await crmDb.getLeadByIdAcrossLists(listIds, LEAD_ID);

    // 200 candidates / 25 per batch = 8 BatchGetItem calls, never 20.
    expect(batchGetSpy).toHaveBeenCalledTimes(8);
  });

  it('propagates errors from DynamoDB and stops further batches', async () => {
    const listIds = Array.from({ length: 30 }, (_, i) => `list-${i + 1}`);
    batchGetPromiseMock.mockRejectedValueOnce(new Error('DDB threw'));

    await expect(crmDb.getLeadByIdAcrossLists(listIds, LEAD_ID)).rejects.toThrow();
    expect(batchGetSpy).toHaveBeenCalledTimes(1);
  });
});
