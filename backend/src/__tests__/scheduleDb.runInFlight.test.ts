/**
 * ENG-324: unit tests for the scheduled-run in-flight lease helpers on scheduleDb
 * (setRunInFlight / heartbeatRunInFlight / clearRunInFlight / getInFlightSchedules
 * / claimAbandonedRun). These are the durable, conditional-write primitives the
 * reconciler relies on to requeue a run whose process died mid-flight.
 */
import AWS from 'aws-sdk';

jest.mock('aws-sdk', () => {
  const mockDynamoDB = {
    get: jest.fn(),
    update: jest.fn(),
    query: jest.fn(),
  };
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

const ok = (attrs: any = {}) => ({ promise: jest.fn().mockResolvedValue(attrs) });
const conditionalFail = () => ({
  promise: jest.fn().mockRejectedValue(
    Object.assign(new Error('conditional failed'), { code: 'ConditionalCheckFailedException' })
  ),
});

let mockDynamoDB: any;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const DocumentClient = AWS.DynamoDB.DocumentClient as any;
  mockDynamoDB = new DocumentClient();
});

afterEach(() => jest.restoreAllMocks());

describe('scheduleDb.setRunInFlight', () => {
  it('writes the lease with heartbeatAt defaulted to startedAt', async () => {
    mockDynamoDB.update.mockReturnValue(ok());
    await scheduleDb.setRunInFlight('sched-1', {
      runId: 'run-1', sessionId: 'sess-1', startedAt: '2026-07-16T12:00:00.000Z', instanceId: 'inst-1',
    });
    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).toBe('SET runInFlight = :lease');
    expect(params.ExpressionAttributeValues[':lease']).toEqual({
      runId: 'run-1', sessionId: 'sess-1', startedAt: '2026-07-16T12:00:00.000Z',
      instanceId: 'inst-1', heartbeatAt: '2026-07-16T12:00:00.000Z',
    });
  });
});

describe('scheduleDb.attachSessionToRunInFlight (ENG-479)', () => {
  it('conditionally sets the lease sessionId on the matching runId', async () => {
    mockDynamoDB.update.mockReturnValue(ok());
    await scheduleDb.attachSessionToRunInFlight('sched-1', 'run-1', 'sess-1');
    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).toBe('SET runInFlight.sessionId = :sid');
    expect(params.ConditionExpression).toBe('runInFlight.runId = :runId');
    expect(params.ExpressionAttributeValues[':sid']).toBe('sess-1');
    expect(params.ExpressionAttributeValues[':runId']).toBe('run-1');
  });

  it('never rejects — swallows a stale-lease condition failure, and reports it as false (ENG-657)', async () => {
    mockDynamoDB.update.mockReturnValue(conditionalFail());
    await expect(scheduleDb.attachSessionToRunInFlight('sched-1', 'run-1', 'sess-1')).resolves.toBe(false);
  });

  it('never rejects — swallows an unexpected error, and reports it as false (ENG-657)', async () => {
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockRejectedValue(new Error('throttled')) });
    await expect(scheduleDb.attachSessionToRunInFlight('sched-1', 'run-1', 'sess-1')).resolves.toBe(false);
  });

  it('reports success as true so the resume path can require a confirmed attach (ENG-657)', async () => {
    mockDynamoDB.update.mockReturnValue(ok());
    await expect(scheduleDb.attachSessionToRunInFlight('sched-1', 'run-1', 'sess-1')).resolves.toBe(true);
  });
});

describe('scheduleDb.heartbeatRunInFlight', () => {
  it('conditionally bumps heartbeatAt on the matching runId', async () => {
    mockDynamoDB.update.mockReturnValue(ok());
    await scheduleDb.heartbeatRunInFlight('sched-1', 'run-1');
    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).toBe('SET runInFlight.heartbeatAt = :now');
    expect(params.ConditionExpression).toBe('runInFlight.runId = :runId');
    expect(params.ExpressionAttributeValues[':runId']).toBe('run-1');
  });

  it('never rejects — swallows a stale-lease condition failure', async () => {
    mockDynamoDB.update.mockReturnValue(conditionalFail());
    await expect(scheduleDb.heartbeatRunInFlight('sched-1', 'run-1')).resolves.toBeUndefined();
  });

  it('never rejects — swallows an unexpected error (fired from a timer)', async () => {
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockRejectedValue(new Error('throttled')) });
    await expect(scheduleDb.heartbeatRunInFlight('sched-1', 'run-1')).resolves.toBeUndefined();
  });
});

describe('scheduleDb.clearRunInFlight', () => {
  it('removes the lease and returns true on the matching runId', async () => {
    mockDynamoDB.update.mockReturnValue(ok());
    const result = await scheduleDb.clearRunInFlight('sched-1', 'run-1');
    expect(result).toBe(true);
    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).toBe('REMOVE runInFlight');
    expect(params.ConditionExpression).toBe('runInFlight.runId = :runId');
  });

  it('returns false when the lease was already reaped (condition fails)', async () => {
    mockDynamoDB.update.mockReturnValue(conditionalFail());
    await expect(scheduleDb.clearRunInFlight('sched-1', 'run-1')).resolves.toBe(false);
  });
});

describe('scheduleDb.claimAbandonedRun', () => {
  it('requeues and removes the lease, returning true (single winner)', async () => {
    mockDynamoDB.update.mockReturnValue(ok());
    const result = await scheduleDb.claimAbandonedRun('sched-1', 'run-1', {
      nextRunTime: '2026-07-16T12:30:00.000Z', retryCount: 2, sessionId: 'sess-1', lastAt: '2026-07-16T12:00:00.000Z',
    });
    expect(result).toBe(true);
    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.ConditionExpression).toBe('runInFlight.runId = :runId');
    expect(params.UpdateExpression).toMatch(/nextRunTime = :nextRunTime/);
    expect(params.UpdateExpression).toMatch(/REMOVE runInFlight/);
    expect(params.ExpressionAttributeValues[':n']).toBe(2);
  });

  it('clears the lease without rescheduling when requeue is null (over cap)', async () => {
    mockDynamoDB.update.mockReturnValue(ok());
    const result = await scheduleDb.claimAbandonedRun('sched-1', 'run-1', null);
    expect(result).toBe(true);
    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).toBe('SET updatedAt = :now REMOVE runInFlight');
    expect(params.ExpressionAttributeValues[':nextRunTime']).toBeUndefined();
  });

  it('returns false when another instance already claimed it', async () => {
    mockDynamoDB.update.mockReturnValue(conditionalFail());
    await expect(scheduleDb.claimAbandonedRun('sched-1', 'run-1', null)).resolves.toBe(false);
  });
});

describe('scheduleDb.getInFlightSchedules', () => {
  it('queries both active and paused scheduled_chat schedules that hold a lease, merged', async () => {
    mockDynamoDB.query
      .mockReturnValueOnce(ok({ Items: [{ scheduleId: 'active-1', runInFlight: { runId: 'run-1' } }] }))
      .mockReturnValueOnce(ok({ Items: [{ scheduleId: 'paused-1', runInFlight: { runId: 'run-2' } }] }));

    const result = await scheduleDb.getInFlightSchedules();

    expect(result).toHaveLength(2);
    expect(result.map((r: any) => r.scheduleId).sort()).toEqual(['active-1', 'paused-1']);
    const statusesQueried = mockDynamoDB.query.mock.calls.map((c: any[]) => c[0].ExpressionAttributeValues[':status']).sort();
    expect(statusesQueried).toEqual(['active', 'paused']);
    const params = mockDynamoDB.query.mock.calls[0][0];
    expect(params.IndexName).toBe('StatusStartTimeIndex');
    expect(params.FilterExpression).toContain('attribute_exists(runInFlight)');
    expect(params.ExpressionAttributeValues[':type']).toBe('scheduled_chat');
  });

  it('returns an empty array on query failure instead of throwing', async () => {
    mockDynamoDB.query.mockReturnValue({ promise: jest.fn().mockRejectedValue(new Error('boom')) });
    await expect(scheduleDb.getInFlightSchedules()).resolves.toEqual([]);
  });
});
