// ENG-2783: the DynamoDB shapes behind system.callConsent. `system` is a DynamoDB reserved word (unescaped it throws
// ValidationException live, invisible to mocks), so these pin the aliases, the conditions and the bootstrap.

const getPromiseMock = jest.fn();
const putPromiseMock = jest.fn();
const updatePromiseMock = jest.fn();
const queryPromiseMock = jest.fn();
const putSpy: jest.Mock = jest.fn(() => ({ promise: putPromiseMock }));
const updateSpy: jest.Mock = jest.fn(() => ({ promise: updatePromiseMock }));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: queryPromiseMock })),
      get: jest.fn(() => ({ promise: getPromiseMock })),
      put: putSpy,
      update: updateSpy,
      transactWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      scan: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      batchGet: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({ upload: jest.fn(), getObject: jest.fn(), getSignedUrl: jest.fn() })),
  SecretsManager: jest.fn(() => ({ getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }) })),
}));

import { crmDb } from '../services/db';

const RECORD = { granted: true, text: 'x', phoneDigits: '12125550142', capturedAt: '2026-11-13T00:00:00.000Z', source: 'form' };
const conditionalFailure = () => Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });

describe('crmDb.createLeadSystemRecordOnce (the existing-lead consent write)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updatePromiseMock.mockReset();
  });

  it('bootstraps the system map without clobbering it, then creates the key only if absent, with the reserved word aliased', async () => {
    updatePromiseMock.mockResolvedValue({});
    await expect(crmDb.createLeadSystemRecordOnce('list-1', 'lead-1', 'callConsent', RECORD)).resolves.toBe(true);

    expect(updateSpy).toHaveBeenCalledTimes(2);
    const [bootstrap, write] = updateSpy.mock.calls.map((c) => c[0]);
    // 1) bootstrap: if_not_exists keeps an existing system.hot_lead_call; only a lead that exists
    expect(bootstrap.UpdateExpression).toBe('SET #system = if_not_exists(#system, :emptyMap)');
    expect(bootstrap.ExpressionAttributeNames).toEqual({ '#system': 'system' });
    expect(bootstrap.ExpressionAttributeValues).toEqual({ ':emptyMap': {} });
    expect(bootstrap.ConditionExpression).toBe('attribute_exists(leadId)');
    // 2) the write: a document path under the aliased system map, only while the key is absent
    expect(write.Key).toEqual({ listId: 'list-1', leadId: 'lead-1' });
    expect(write.UpdateExpression).toBe('SET #system.#k = :rec, updatedAt = :ts');
    expect(write.ConditionExpression).toBe('attribute_not_exists(#system.#k)');
    expect(write.ExpressionAttributeNames).toEqual({ '#system': 'system', '#k': 'callConsent' });
    expect(write.ExpressionAttributeValues[':rec']).toEqual(RECORD);
    // no unaliased reserved word anywhere in an expression
    for (const expr of [bootstrap.UpdateExpression, bootstrap.ConditionExpression, write.UpdateExpression, write.ConditionExpression]) {
      expect(expr.replace(/#system/g, '')).not.toMatch(/\bsystem\b/);
    }
  });

  it('a second call for the same key returns false (the conditional write failed) and the first record is never overwritten', async () => {
    updatePromiseMock.mockResolvedValueOnce({}).mockResolvedValueOnce({}) // 1st call: bootstrap, write
      .mockResolvedValueOnce({}).mockRejectedValueOnce(conditionalFailure()); // 2nd call: bootstrap ok, write refused
    expect(await crmDb.createLeadSystemRecordOnce('list-1', 'lead-1', 'callConsent', RECORD)).toBe(true);
    expect(await crmDb.createLeadSystemRecordOnce('list-1', 'lead-1', 'callConsent', { ...RECORD, text: 'second' })).toBe(false);
    // every write is conditional on absence, so there is no path that replaces an existing record
    const writes = updateSpy.mock.calls.map((c) => c[0]).filter((p) => String(p.UpdateExpression).startsWith('SET #system.#k'));
    expect(writes).toHaveLength(2);
    expect(writes.every((p) => p.ConditionExpression === 'attribute_not_exists(#system.#k)')).toBe(true);
  });

  it('a lead that does not exist is not created: false, and no record write is attempted', async () => {
    updatePromiseMock.mockRejectedValueOnce(conditionalFailure());
    expect(await crmDb.createLeadSystemRecordOnce('list-1', 'gone', 'callConsent', RECORD)).toBe(false);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });
});

describe('crmDb.createLead: the system sidecar in the creation put', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryPromiseMock.mockResolvedValue({ Items: [] });
    putPromiseMock.mockResolvedValue({});
    updatePromiseMock.mockResolvedValue({});
    getPromiseMock.mockResolvedValueOnce({ Item: { listId: 'list-1', userId: 'user-1' } }).mockResolvedValue({ Item: null });
  });
  const putItem = () => (putSpy.mock.calls[putSpy.mock.calls.length - 1][0] as { Item: Record<string, unknown> }).Item;

  it('writes system.callConsent in the same put when `system` is passed', async () => {
    await crmDb.createLead('list-1', { email: 'a@b.com', phone: '(212) 555-0142', system: { callConsent: RECORD } }, 'form_fill');
    expect(putItem().system).toEqual({ callConsent: RECORD });
  });

  it.each([['an empty system map', { system: {} }], ['no system at all', {}]])('%s leaves the item without a system attribute', async (_n, extra) => {
    await crmDb.createLead('list-1', { email: 'b@b.com', phone: '(212) 555-0142', ...extra }, 'form_fill');
    expect(putItem()).not.toHaveProperty('system');
  });
});
