// ENG-1048: addRunResult appends with list_append, which cannot shed anything, so a
// schedule row sitting at DynamoDB's 400KB item limit silently stops recording runs.
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

const itemSizeError = () => Object.assign(new Error('Item size has exceeded the maximum allowed size'), {
  code: 'ValidationException',
});

const resolved = (value: any) => ({ promise: jest.fn().mockResolvedValue(value) });
const rejected = (error: any) => ({ promise: jest.fn().mockRejectedValue(error) });

describe('scheduleDb.addRunResult item budget', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks keeps implementations, and these tests queue different ones.
    mockDocumentClientMethods.update.mockReset();
    mockDocumentClientMethods.get.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // SUCCESS: the normal path still appends without an extra read
  it('appends with list_append and does not re-read the row', async () => {
    mockDocumentClientMethods.update.mockReturnValue(resolved({ Attributes: { scheduleId: 'sched-1' } }));

    await scheduleDb.addRunResult('sched-1', { runId: 'run-new' });

    expect(mockDocumentClientMethods.get).not.toHaveBeenCalled();
    expect(mockDocumentClientMethods.update.mock.calls[0][0].UpdateExpression).toContain('list_append');
  });

  // FAIL: at the ceiling, the run must still be recorded — by shedding the oldest runs
  it('trims the oldest run results and retries when the item is over the limit', async () => {
    const runResults = Array.from({ length: 12 }, (_, i) => ({ runId: `run-${i}`, summary: 'r'.repeat(30000) }));
    mockDocumentClientMethods.update
      .mockReturnValueOnce(rejected(itemSizeError()))
      .mockReturnValueOnce(resolved({}))
      .mockReturnValueOnce(resolved({ Attributes: { scheduleId: 'sched-1' } }));
    mockDocumentClientMethods.get.mockReturnValue(resolved({
      Item: { scheduleId: 'sched-1', startingMessage: 'p'.repeat(35000), runResults },
    }));

    const result = await scheduleDb.addRunResult('sched-1', { runId: 'run-new', summary: 'r'.repeat(30000) });

    expect(result).toEqual({ scheduleId: 'sched-1' });
    expect(mockDocumentClientMethods.get).toHaveBeenCalledTimes(1);
    // The oldest entries go out by index, and the incoming run is appended by the
    // retry of the original list_append — so nothing is written from the stale read.
    const trim = mockDocumentClientMethods.update.mock.calls[1][0];
    expect(trim.UpdateExpression).toMatch(/REMOVE #runResults\[0\]/);
    expect(mockDocumentClientMethods.update.mock.calls[2][0].UpdateExpression).toContain('list_append');
  });

  // FAIL: a run finishing concurrently appends to the tail — a full-list write derived
  // from the read above would erase it, so the trim must never send one
  it('never writes back the run-result list it read', async () => {
    const runResults = Array.from({ length: 12 }, (_, i) => ({ runId: `run-${i}`, summary: 'r'.repeat(30000) }));
    mockDocumentClientMethods.update
      .mockReturnValueOnce(rejected(itemSizeError()))
      .mockReturnValueOnce(resolved({}))
      .mockReturnValueOnce(resolved({ Attributes: { scheduleId: 'sched-1' } }));
    mockDocumentClientMethods.get.mockReturnValue(resolved({
      Item: { scheduleId: 'sched-1', startingMessage: 'p'.repeat(35000), runResults },
    }));

    await scheduleDb.addRunResult('sched-1', { runId: 'run-new', summary: 'r'.repeat(30000) });

    mockDocumentClientMethods.update.mock.calls.forEach(([params]: any[]) => {
      expect(Array.isArray(params.ExpressionAttributeValues?.[':runResults'])).toBe(false);
    });
  });

  // FAIL: another writer shedding at the same moment must not make this one delete a
  // second prefix off an already-shortened list — recount against what is stored now
  it('recounts instead of over-deleting when the history moved under it', async () => {
    const runResults = Array.from({ length: 20 }, (_, i) => ({ runId: `run-${i}`, summary: 'r'.repeat(30000) }));
    const raced = Object.assign(new Error('stale'), { code: 'ConditionalCheckFailedException' });
    mockDocumentClientMethods.update
      .mockReturnValueOnce(rejected(itemSizeError()))
      .mockReturnValueOnce(rejected(raced))
      .mockReturnValueOnce(resolved({}))
      .mockReturnValueOnce(resolved({ Attributes: { scheduleId: 'sched-1' } }));
    mockDocumentClientMethods.get
      .mockReturnValueOnce(resolved({ Item: { scheduleId: 'sched-1', startingMessage: 'p'.repeat(35000), runResults } }))
      .mockReturnValueOnce(resolved({
        Item: { scheduleId: 'sched-1', startingMessage: 'p'.repeat(35000), runResults: runResults.slice(3) },
      }));

    const result = await scheduleDb.addRunResult('sched-1', { runId: 'run-new', summary: 'r'.repeat(30000) });

    expect(result).toEqual({ scheduleId: 'sched-1' });
    // Two reads: the racing removal is recomputed, not replayed.
    expect(mockDocumentClientMethods.get).toHaveBeenCalledTimes(2);
    const first = mockDocumentClientMethods.update.mock.calls[1][0];
    const second = mockDocumentClientMethods.update.mock.calls[2][0];
    expect(first.ConditionExpression).toContain('size(#runResults)');
    expect(second.ExpressionAttributeValues[':expectedLength']).toBe(runResults.length - 3);
  });

  // FAIL: a shed that keeps losing the race must not fall through to an unguarded write
  it('surfaces the original error when the history keeps moving', async () => {
    const runResults = Array.from({ length: 12 }, (_, i) => ({ runId: `run-${i}`, summary: 'r'.repeat(30000) }));
    const raced = Object.assign(new Error('stale'), { code: 'ConditionalCheckFailedException' });
    mockDocumentClientMethods.update
      .mockReturnValueOnce(rejected(itemSizeError()))
      .mockReturnValue(rejected(raced));
    mockDocumentClientMethods.get.mockReturnValue(resolved({
      Item: { scheduleId: 'sched-1', startingMessage: 'p'.repeat(35000), runResults },
    }));

    await expect(scheduleDb.addRunResult('sched-1', { runId: 'run-new', summary: 'r'.repeat(30000) }))
      .rejects.toThrow('Item size has exceeded the maximum allowed size');
  });

  // FAIL: an unrelated failure must not trigger the read-modify-write path
  it('rethrows a non-size error without re-reading the row', async () => {
    mockDocumentClientMethods.update.mockReturnValue(rejected(Object.assign(new Error('nope'), {
      code: 'ProvisionedThroughputExceededException',
    })));

    await expect(scheduleDb.addRunResult('sched-1', { runId: 'run-new' })).rejects.toThrow('nope');
    expect(mockDocumentClientMethods.get).not.toHaveBeenCalled();
  });

  // FAIL: nothing to shed → surface the original error rather than writing a lie
  it('rethrows when even the incoming run result cannot fit', async () => {
    mockDocumentClientMethods.update.mockReturnValue(rejected(itemSizeError()));
    mockDocumentClientMethods.get.mockReturnValue(resolved({
      Item: { scheduleId: 'sched-1', startingMessage: 'p'.repeat(400000), runResults: [] },
    }));

    await expect(scheduleDb.addRunResult('sched-1', { runId: 'run-new' }))
      .rejects.toThrow('Item size has exceeded the maximum allowed size');
    expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(1);
  });

  // FAIL: a missing row cannot be healed
  it('rethrows when the schedule row no longer exists', async () => {
    mockDocumentClientMethods.update.mockReturnValue(rejected(itemSizeError()));
    mockDocumentClientMethods.get.mockReturnValue(resolved({}));

    await expect(scheduleDb.addRunResult('sched-gone', { runId: 'run-new' }))
      .rejects.toThrow('Item size has exceeded the maximum allowed size');
  });
});
