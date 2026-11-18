/**
 * ENG-3047 — scheduleDb.updateScheduleAfterRun with an expected due time.
 *
 * The due-schedule loop passes the `nextRunTime` and `lastRunTime` it read. The write
 * then lands only if the row still carries both, so of two callers that read the same
 * due row exactly one advances it (and decrements runCount). `lastRunTime` moves on
 * every fire, so an edit that puts the old due time back does not let a stale caller
 * through. Callers that pass no expected value keep the unconditional write.
 */
import AWS from 'aws-sdk';

jest.mock('aws-sdk', () => {
  const mockDynamoDB = { get: jest.fn(), update: jest.fn() };
  const mockS3 = {
    putObject: jest.fn().mockReturnThis(),
    getObject: jest.fn().mockReturnThis(),
    deleteObject: jest.fn().mockReturnThis(),
    promise: jest.fn().mockResolvedValue({}),
  };
  return {
    DynamoDB: { DocumentClient: jest.fn(() => mockDynamoDB) },
    S3: jest.fn(() => mockS3),
    config: { update: jest.fn() },
  };
});

import { scheduleDb } from '../services/db';

const SCHEDULE_ID = 'sched-1';
const DUE = '2026-11-15T09:00:00.000Z';
const LAST = '2026-11-14T09:00:04.000Z';
const NOW = '2026-11-15T09:00:05.000Z';
const NEXT = '2026-11-16T09:00:00.000Z';

describe('ENG-3047 updateScheduleAfterRun conditional advance', () => {
  let mockDynamoDB: any;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB = new (AWS.DynamoDB.DocumentClient as any)();
    mockDynamoDB.get.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Item: { scheduleId: SCHEDULE_ID, runCount: 3, status: 'active', nextRunTime: DUE } }),
    });
    mockDynamoDB.update.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Attributes: { scheduleId: SCHEDULE_ID, runCount: 2 } }),
    });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => errorSpy.mockRestore());

  it('writes unconditionally when no expected due time is passed', async () => {
    await scheduleDb.updateScheduleAfterRun(SCHEDULE_ID, NOW, NEXT, true);

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.ConditionExpression).toBeUndefined();
    expect(params.ExpressionAttributeValues[':expectedNextRunTime']).toBeUndefined();
  });

  it('conditions the write on the expected due time and last run time, and still sets the new ones', async () => {
    const result = await scheduleDb.updateScheduleAfterRun(SCHEDULE_ID, NOW, NEXT, true, { nextRunTime: DUE, lastRunTime: LAST });

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.ConditionExpression).toBe('#nextRunTime = :expectedNextRunTime AND #lastRunTime = :expectedLastRunTime');
    expect(params.ExpressionAttributeNames['#nextRunTime']).toBe('nextRunTime');
    expect(params.ExpressionAttributeNames['#lastRunTime']).toBe('lastRunTime');
    expect(params.ExpressionAttributeValues[':expectedNextRunTime']).toBe(DUE);
    expect(params.ExpressionAttributeValues[':expectedLastRunTime']).toBe(LAST);
    expect(params.ExpressionAttributeValues[':nextRunTime']).toBe(NEXT);
    expect(params.ExpressionAttributeValues[':lastRunTime']).toBe(NOW);
    expect(params.UpdateExpression).toContain('#runCount = #runCount - :one');
    expect(result).toEqual({ scheduleId: SCHEDULE_ID, runCount: 2 });
  });

  it('requires the last run time to still be absent for a schedule that has never run', async () => {
    await scheduleDb.updateScheduleAfterRun(SCHEDULE_ID, NOW, NEXT, true, { nextRunTime: DUE, lastRunTime: undefined });

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.ConditionExpression).toBe('#nextRunTime = :expectedNextRunTime AND attribute_not_exists(#lastRunTime)');
    expect(params.ExpressionAttributeValues[':expectedLastRunTime']).toBeUndefined();
  });

  it('throws preconditionFailed when the row no longer carries the expected due time', async () => {
    const conditional: any = new Error('The conditional request failed');
    conditional.code = 'ConditionalCheckFailedException';
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockRejectedValue(conditional) });

    await expect(scheduleDb.updateScheduleAfterRun(SCHEDULE_ID, NOW, NEXT, true, { nextRunTime: DUE, lastRunTime: LAST }))
      .rejects.toMatchObject({ preconditionFailed: true });
  });

  it('rethrows any other write error without the preconditionFailed mark', async () => {
    const throttled: any = new Error('Rate exceeded');
    throttled.code = 'ProvisionedThroughputExceededException';
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockRejectedValue(throttled) });

    const caught: any = await scheduleDb.updateScheduleAfterRun(SCHEDULE_ID, NOW, NEXT, true, { nextRunTime: DUE, lastRunTime: LAST }).catch((e) => e);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.preconditionFailed).toBeUndefined();
  });
});
