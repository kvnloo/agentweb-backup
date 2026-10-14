/**
 * ENG-2325 — the ingest's list cache is invalidated by every crmDb write that can change what the ingest
 * reads (publicAccessEnabled, listType, trackingConfig, owner, existence) and by NOTHING on the hot
 * counter paths (leadCount / fieldNames), which would otherwise empty it on every new session.
 */
const getPromise = jest.fn();
const getSpy: jest.Mock = jest.fn(() => ({ promise: getPromise }));
const updateSpy: jest.Mock = jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Attributes: { listId: 'list_a' } }) }));
const putSpy: jest.Mock = jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) }));
const deleteSpy: jest.Mock = jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) }));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      get: getSpy, put: putSpy, update: updateSpy, delete: deleteSpy,
      scan: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      batchGet: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({ upload: jest.fn(), getObject: jest.fn(), getSignedUrl: jest.fn() })),
  SecretsManager: jest.fn(() => ({ getSecretValue: jest.fn() })),
}));

import { crmDb } from '../services/db';
import { getIngestList } from '../services/trackerIngestService';
import { ingestListCache } from '../utils/ingestListCache';

const row = (over: Record<string, any> = {}) => ({ listId: 'list_a', userId: 'u1', listType: 'session', publicAccessEnabled: true, trackingConfig: { allowedOrigins: ['https://go.example.com'] }, ...over });
let stored: any;

beforeEach(() => {
  jest.clearAllMocks();
  ingestListCache.clear();
  stored = row();
  getPromise.mockImplementation(async () => ({ Item: stored }));
});

const reads = () => getSpy.mock.calls.length;
const warm = async () => { await getIngestList('list_a'); await getIngestList('list_a'); expect(reads()).toBe(1); };

describe('getIngestList', () => {
  it('N reads -> ONE GetItem, and it is a CONSISTENT read of AW-LeadLists', async () => {
    for (let i = 0; i < 25; i++) await getIngestList('list_a');
    expect(reads()).toBe(1);
    expect(getSpy.mock.calls[0][0]).toMatchObject({ Key: { listId: 'list_a' }, ConsistentRead: true });
    expect(getSpy.mock.calls[0][0].TableName).toMatch(/AW-LeadLists$/);
  });

  it('crmDb.getLeadListById is still an ordinary (eventually consistent) read for everyone else', async () => {
    await crmDb.getLeadListById('list_a');
    expect(getSpy.mock.calls[0][0]).not.toHaveProperty('ConsistentRead');
  });
});

describe('invalidation by this process\'s own writes', () => {
  it('updateLeadList: disabling public access is visible to the very next ingest read', async () => {
    await warm();
    stored = row({ publicAccessEnabled: false });
    await crmDb.updateLeadList('list_a', { publicAccessEnabled: false });
    expect((await getIngestList('list_a'))?.publicAccessEnabled).toBe(false);
    expect(reads()).toBe(2);
  });

  it('updateLeadList: a shrunk allowedOrigins is visible at once', async () => {
    await warm();
    stored = row({ trackingConfig: { allowedOrigins: [] } });
    await crmDb.updateLeadList('list_a', { trackingConfig: { allowedOrigins: [] } as any });
    expect((await getIngestList('list_a'))?.trackingConfig?.allowedOrigins).toEqual([]);
  });

  it.each([
    ['deleteLeadList', () => crmDb.deleteLeadList('list_a')],
    ['transferLeadListOwner', () => crmDb.transferLeadListOwner('list_a', 'u2')],
    ['createLeadList (explicit id)', () => crmDb.createLeadList('u1', 'n', 'd', undefined, undefined, undefined, undefined, undefined, undefined, 'session', undefined, 'list_a')],
  ])('%s invalidates', async (_n, write) => {
    await warm();
    await write();
    await getIngestList('list_a');
    expect(reads()).toBe(2);
  });

  it('a FAILED write does not invalidate (nothing changed)', async () => {
    await warm();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    updateSpy.mockImplementationOnce(() => ({ promise: jest.fn().mockRejectedValue(new Error('ValidationException')) }));
    await expect(crmDb.updateLeadList('list_a', { name: 'x' })).rejects.toBeDefined();
    await getIngestList('list_a');
    expect(reads()).toBe(1);
  });

  it('the hot counter paths (leadCount, fieldNames) do NOT invalidate', async () => {
    await warm();
    await crmDb.incrementLeadCount('list_a', 1);
    await crmDb.mergeFieldNames('list_a', ['x']);
    await crmDb.updateFieldNames('list_a', ['x']);
    await getIngestList('list_a');
    expect(reads()).toBe(1);
  });
});
