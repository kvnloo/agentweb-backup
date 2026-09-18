// ENG-1552: the delivery-state log. Asserts the real UpdateItem params — the guarantees
// live in the expressions, not in which mock got called.
const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  scan: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  batchWrite: jest.fn(),
};

jest.mock('aws-sdk', () => {
  return {
    config: {
      update: jest.fn(),
    },
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDocumentClientMethods),
    },
    S3: jest.fn(() => ({
      upload: jest.fn(),
      getObject: jest.fn(),
      deleteObject: jest.fn(),
    })),
  };
});

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailDomainAndLeadEmail: jest.fn(),
    updateEmailEventContent: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    getReceivedEmailContent: jest.fn(),
    getDeliveredEmailContent: jest.fn(),
  },
}));

import { scheduleDb } from '../services/db';

const resolved = (value: any) => ({ promise: jest.fn().mockResolvedValue(value) });
const rejected = (error: any) => ({ promise: jest.fn().mockRejectedValue(error) });
const conditionalFailure = () => Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });
const entry = { runId: 'run-1', state: 'withheld', reason: 'no_authorized_recipients', at: '2026-09-18T00:00:00.000Z' };

describe('scheduleDb.appendDeliveryLogEntry', () => {
  beforeEach(() => {
    mockDocumentClientMethods.update.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('appends under an attribute_exists condition, so a schedule deleted mid-run is never recreated', async () => {
    mockDocumentClientMethods.update.mockReturnValueOnce(resolved({ Attributes: { deliveryLog: [entry] } }));

    await scheduleDb.appendDeliveryLogEntry('sched-1', entry);

    expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(1);
    const params = mockDocumentClientMethods.update.mock.calls[0][0];
    expect(params.Key).toEqual({ scheduleId: 'sched-1' });
    expect(params.UpdateExpression).toBe('SET #deliveryLog = list_append(if_not_exists(#deliveryLog, :emptyList), :entry)');
    expect(params.ConditionExpression).toBe('attribute_exists(#scheduleId)');
    expect(params.ExpressionAttributeNames['#scheduleId']).toBe('scheduleId');
    expect(params.ExpressionAttributeValues[':entry']).toEqual([entry]);
  });

  it('writes the lastKnownSensitive breadcrumb in the SAME write when given', async () => {
    mockDocumentClientMethods.update.mockReturnValueOnce(resolved({ Attributes: { deliveryLog: [entry] } }));

    await scheduleDb.appendDeliveryLogEntry('sched-1', entry, { lastKnownSensitive: false });

    const params = mockDocumentClientMethods.update.mock.calls[0][0];
    expect(params.UpdateExpression).toContain('#lastKnownSensitive = :lastKnownSensitive');
    expect(params.ExpressionAttributeValues[':lastKnownSensitive']).toBe(false);
    expect(params.ExpressionAttributeValues[':lastKnownSensitiveAt']).toBe(entry.at);
  });

  it('treats a deleted schedule as nothing to record — no throw, no second write', async () => {
    mockDocumentClientMethods.update.mockReturnValueOnce(rejected(conditionalFailure()));

    await expect(scheduleDb.appendDeliveryLogEntry('gone', entry)).resolves.toBeUndefined();
    expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(1);
  });

  it('trims the oldest entries past 100, bound to the length it measured', async () => {
    const log = Array.from({ length: 102 }, (_, i) => ({ ...entry, runId: `r${i}` }));
    mockDocumentClientMethods.update
      .mockReturnValueOnce(resolved({ Attributes: { deliveryLog: log } }))
      .mockReturnValueOnce(resolved({}));

    await scheduleDb.appendDeliveryLogEntry('sched-1', entry);

    const trim = mockDocumentClientMethods.update.mock.calls[1][0];
    expect(trim.UpdateExpression).toBe('REMOVE #deliveryLog[0], #deliveryLog[1]');
    expect(trim.ConditionExpression).toBe('size(#deliveryLog) = :measured');
    expect(trim.ExpressionAttributeValues[':measured']).toBe(102);
  });

  it('a raced trim is swallowed — the append already landed', async () => {
    const log = Array.from({ length: 101 }, (_, i) => ({ ...entry, runId: `r${i}` }));
    mockDocumentClientMethods.update
      .mockReturnValueOnce(resolved({ Attributes: { deliveryLog: log } }))
      .mockReturnValueOnce(rejected(conditionalFailure()));

    await expect(scheduleDb.appendDeliveryLogEntry('sched-1', entry)).resolves.toBeUndefined();
  });
});
