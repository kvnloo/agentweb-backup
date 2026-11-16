/**
 * ENG-3047 — scheduleDb.updateScheduleAfterRun with an expected due time.
 *
 * The due-schedule loop passes the `nextRunTime` it read. The write then lands only
 * if the row still carries that value, so of two callers that read the same due row
 * exactly one advances it (and decrements runCount). Callers that pass no expected
 * value keep the unconditional write.
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

  it('conditions the write on the expected due time and still sets the new one', async () => {
    const result = await scheduleDb.updateScheduleAfterRun(SCHEDULE_ID, NOW, NEXT, true, DUE);

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.ConditionExpression).toBe('#nextRunTime = :expectedNextRunTime');
    expect(params.ExpressionAttributeNames['#nextRunTime']).toBe('nextRunTime');
    expect(params.ExpressionAttributeValues[':expectedNextRunTime']).toBe(DUE);
    expect(params.ExpressionAttributeValues[':nextRunTime']).toBe(NEXT);
    expect(params.UpdateExpression).toContain('#runCount = #runCount - :one');
    expect(result).toEqual({ scheduleId: SCHEDULE_ID, runCount: 2 });
  });

  it('throws preconditionFailed when the row no longer carries the expected due time', async () => {
    const conditional: any = new Error('The conditional request failed');
    conditional.code = 'ConditionalCheckFailedException';
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockRejectedValue(conditional) });

    await expect(scheduleDb.updateScheduleAfterRun(SCHEDULE_ID, NOW, NEXT, true, DUE))
      .rejects.toMatchObject({ preconditionFailed: true });
  });

  it('rethrows any other write error without the preconditionFailed mark', async () => {
    const throttled: any = new Error('Rate exceeded');
    throttled.code = 'ProvisionedThroughputExceededException';
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockRejectedValue(throttled) });

    const caught: any = await scheduleDb.updateScheduleAfterRun(SCHEDULE_ID, NOW, NEXT, true, DUE).catch((e) => e);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.preconditionFailed).toBeUndefined();
  });
});
