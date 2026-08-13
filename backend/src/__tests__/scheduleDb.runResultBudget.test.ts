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

  // FAIL: at the ceiling, the run must still be recorded — by shedding the oldest runs.
  // Shedding and recording are ONE write: a trim that lands while the append does not
  // would delete history and still lose the run it made room for.
  it('trims the oldest run results and records the run in one write', async () => {
    const runResults = Array.from({ length: 12 }, (_, i) => ({ runId: `run-${i}`, summary: 'r'.repeat(30000) }));
    mockDocumentClientMethods.update
      .mockReturnValueOnce(rejected(itemSizeError()))
      .mockReturnValueOnce(resolved({ Attributes: { scheduleId: 'sched-1' } }));
    mockDocumentClientMethods.get.mockReturnValue(resolved({
      Item: { scheduleId: 'sched-1', startingMessage: 'p'.repeat(35000), runResults },
    }));

    const result = await scheduleDb.addRunResult('sched-1', { runId: 'run-new', summary: 'r'.repeat(30000) });

    expect(result).toEqual({ scheduleId: 'sched-1' });
    expect(mockDocumentClientMethods.get).toHaveBeenCalledTimes(1);
    expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(2);
    const written = mockDocumentClientMethods.update.mock.calls[1][0].ExpressionAttributeValues[':runResults'];
    expect(written.length).toBeLessThan(runResults.length + 1);
    // The incoming run is kept; the oldest are the ones dropped.
    expect(written[written.length - 1].runId).toBe('run-new');
    expect(written[0].runId).not.toBe('run-0');
  });

  // FAIL: a run finishing concurrently appends to the tail, and another writer shedding
  // to fit removes from the head — either would be clobbered by a list built from the
  // read above, so the write has to be bound to the history it was derived from
  it('binds the write to the exact history it read', async () => {
    const runResults = Array.from({ length: 12 }, (_, i) => ({ runId: `run-${i}`, summary: 'r'.repeat(30000) }));
    mockDocumentClientMethods.update
      .mockReturnValueOnce(rejected(itemSizeError()))
      .mockReturnValueOnce(resolved({ Attributes: { scheduleId: 'sched-1' } }));
    mockDocumentClientMethods.get.mockReturnValue(resolved({
      Item: { scheduleId: 'sched-1', startingMessage: 'p'.repeat(35000), runResults },
    }));

    await scheduleDb.addRunResult('sched-1', { runId: 'run-new', summary: 'r'.repeat(30000) });

    const write = mockDocumentClientMethods.update.mock.calls[1][0];
    // Length alone is not enough: a concurrent recovery that drops one and appends one
    // leaves the count unchanged, so the tail entry is asserted too.
    expect(write.ConditionExpression).toContain('size(#runResults) = :expectedLength');
    expect(write.ExpressionAttributeValues[':expectedLength']).toBe(runResults.length);
    expect(write.ExpressionAttributeValues[':expectedLast']).toEqual(runResults[runResults.length - 1]);
  });

  // FAIL: another writer shedding at the same moment must not make this one delete a
  // second prefix off an already-shortened list — recount against what is stored now
  it('recounts instead of over-deleting when the history moved under it', async () => {
    const runResults = Array.from({ length: 20 }, (_, i) => ({ runId: `run-${i}`, summary: 'r'.repeat(30000) }));
    const raced = Object.assign(new Error('stale'), { code: 'ConditionalCheckFailedException' });
    mockDocumentClientMethods.update
      .mockReturnValueOnce(rejected(itemSizeError()))
      .mockReturnValueOnce(rejected(raced))
      .mockReturnValueOnce(resolved({ Attributes: { scheduleId: 'sched-1' } }));
    mockDocumentClientMethods.get
      .mockReturnValueOnce(resolved({ Item: { scheduleId: 'sched-1', startingMessage: 'p'.repeat(35000), runResults } }))
      .mockReturnValueOnce(resolved({
        Item: { scheduleId: 'sched-1', startingMessage: 'p'.repeat(35000), runResults: runResults.slice(3) },
      }));

    const result = await scheduleDb.addRunResult('sched-1', { runId: 'run-new', summary: 'r'.repeat(30000) });

    expect(result).toEqual({ scheduleId: 'sched-1' });
    // Two reads: the losing write is recomputed against what is stored now, not replayed.
    expect(mockDocumentClientMethods.get).toHaveBeenCalledTimes(2);
    const retry = mockDocumentClientMethods.update.mock.calls[2][0];
    expect(retry.ExpressionAttributeValues[':expectedLength']).toBe(runResults.length - 3);
    expect(retry.ExpressionAttributeValues[':runResults'][0].runId).not.toBe('run-0');
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
