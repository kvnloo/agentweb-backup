// Regression tests verifying that refactored DynamoDB functions properly paginate.
// Each test simulates multi-page results to ensure data is not truncated at 1MB.

const queryPromiseMock = jest.fn();
const scanPromiseMock = jest.fn();
const queryMock = jest.fn((_params?: any) => ({ promise: queryPromiseMock }));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: queryMock,
      scan: jest.fn(() => ({ promise: scanPromiseMock })),
      get: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
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

import { taskDb, scheduleDb, subscriberDb } from '../services/db';

describe('P0 pagination regression tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getPendingTaskExecutions', () => {
    it('should collect pending executions across multiple pages', async () => {
      queryPromiseMock
        .mockResolvedValueOnce({
          Items: [
            { executionId: 'exec-1', status: 'pending' },
            { executionId: 'exec-2', status: 'pending' },
          ],
          LastEvaluatedKey: { executionId: 'exec-2' },
        })
        .mockResolvedValueOnce({
          Items: [
            { executionId: 'exec-3', status: 'pending' },
          ],
        });

      const result = await taskDb.getPendingTaskExecutions();

      expect(result).toHaveLength(3);
      expect(result!.map((e: any) => e.executionId)).toEqual(['exec-1', 'exec-2', 'exec-3']);
      expect(queryPromiseMock).toHaveBeenCalledTimes(2);
    });

    it('should return empty array when no pending executions', async () => {
      queryPromiseMock.mockResolvedValueOnce({ Items: [] });

      const result = await taskDb.getPendingTaskExecutions();
      expect(result).toHaveLength(0);
    });
  });

  describe('getTaskExecutions', () => {
    it('should collect all executions for a task across pages', async () => {
      queryPromiseMock
        .mockResolvedValueOnce({
          Items: [
            { executionId: 'exec-1', taskId: 'task-1' },
            { executionId: 'exec-2', taskId: 'task-1' },
          ],
          LastEvaluatedKey: { executionId: 'exec-2' },
        })
        .mockResolvedValueOnce({
          Items: [
            { executionId: 'exec-3', taskId: 'task-1' },
          ],
        });

      const result = await taskDb.getTaskExecutions('task-1');

      expect(result).toHaveLength(3);
      expect(queryPromiseMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('getTaskSchedules', () => {
    it('should collect all schedules for a task across pages', async () => {
      queryPromiseMock
        .mockResolvedValueOnce({
          Items: [
            { scheduleId: 'sched-1', taskId: 'task-1' },
          ],
          LastEvaluatedKey: { scheduleId: 'sched-1' },
        })
        .mockResolvedValueOnce({
          Items: [
            { scheduleId: 'sched-2', taskId: 'task-1' },
          ],
        });

      const result = await taskDb.getTaskSchedules('task-1');

      expect(result).toHaveLength(2);
      expect(queryPromiseMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('getUserTaskCount', () => {
    it('should sum counts across paginated COUNT queries', async () => {
      queryPromiseMock
        .mockResolvedValueOnce({
          Count: 100,
          LastEvaluatedKey: { taskId: 'task-100' },
        })
        .mockResolvedValueOnce({
          Count: 50,
        });

      const result = await taskDb.getUserTaskCount('user-1');

      expect(result).toBe(150);
      expect(queryPromiseMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('getPendingSchedules', () => {
    it('should collect pending schedules across pages', async () => {
      queryPromiseMock
        .mockResolvedValueOnce({
          Items: [
            { scheduleId: 'sched-1', status: 'active' },
          ],
          LastEvaluatedKey: { scheduleId: 'sched-1' },
        })
        .mockResolvedValueOnce({
          Items: [
            { scheduleId: 'sched-2', status: 'active' },
            { scheduleId: 'sched-3', status: 'active' },
          ],
        });

      const result = await scheduleDb.getPendingSchedules();

      expect(result).toHaveLength(3);
      expect(queryPromiseMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('getSchedulesByUserId', () => {
    it('should collect all user schedules across pages', async () => {
      queryPromiseMock
        .mockResolvedValueOnce({
          Items: [
            { scheduleId: 'sched-1', userId: 'user-1' },
            { scheduleId: 'sched-2', userId: 'user-1' },
          ],
          LastEvaluatedKey: { scheduleId: 'sched-2' },
        })
        .mockResolvedValueOnce({
          Items: [
            { scheduleId: 'sched-3', userId: 'user-1' },
          ],
        });

      const result = await scheduleDb.getSchedulesByUserId('user-1');

      expect(result).toHaveLength(3);
      expect(queryPromiseMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('getSchedulesByTaskId', () => {
    it('should collect all task schedules across pages', async () => {
      queryPromiseMock
        .mockResolvedValueOnce({
          Items: [{ scheduleId: 'sched-1' }],
          LastEvaluatedKey: { scheduleId: 'sched-1' },
        })
        .mockResolvedValueOnce({
          Items: [{ scheduleId: 'sched-2' }],
        });

      const result = await scheduleDb.getSchedulesByTaskId('task-1');

      expect(result).toHaveLength(2);
      expect(queryPromiseMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('getSchedulesReadyToRun', () => {
    it('queries the full active-due partition so unsupported legacy rows cannot be silently filtered by DynamoDB', async () => {
      queryPromiseMock.mockResolvedValueOnce({ Items: [] });

      await scheduleDb.getSchedulesReadyToRun();

      const params = queryMock.mock.calls[0][0]!;
      expect(params.FilterExpression).toBeUndefined();
      expect(params.ExpressionAttributeNames).not.toHaveProperty('#type');
      expect(params.ExpressionAttributeValues).not.toHaveProperty(':type');
    });

    it('returns scheduled chats but not due legacy task schedules', async () => {
      queryPromiseMock.mockResolvedValueOnce({
        Items: [
          { scheduleId: 'chat-1', type: 'scheduled_chat' },
          { scheduleId: 'legacy-1', taskId: 'task-1' },
        ],
      });

      const result = await scheduleDb.getSchedulesReadyToRun();

      expect(result).toEqual([{ scheduleId: 'chat-1', type: 'scheduled_chat' }]);
    });

    it('emits one structured warning naming a newly detected overdue legacy schedule and the skip reason', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      queryPromiseMock.mockResolvedValue({
        Items: [{ scheduleId: 'legacy-observable-1', taskId: 'task-1' }],
      });

      await scheduleDb.getSchedulesReadyToRun();
      await scheduleDb.getSchedulesReadyToRun();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('legacy-observable-1'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('legacy_task_schedule_unsupported'));
      warn.mockRestore();
    });

    it('should collect all ready schedules across pages', async () => {
      queryPromiseMock
        .mockResolvedValueOnce({
          Items: [
            { scheduleId: 'sched-1', type: 'scheduled_chat' },
          ],
          LastEvaluatedKey: { scheduleId: 'sched-1' },
        })
        .mockResolvedValueOnce({
          Items: [
            { scheduleId: 'sched-2', type: 'scheduled_chat' },
          ],
        });

      const result = await scheduleDb.getSchedulesReadyToRun();

      expect(result).toHaveLength(2);
      expect(queryPromiseMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('getTaskSubscribers', () => {
    it('should collect all subscribers across pages', async () => {
      queryPromiseMock
        .mockResolvedValueOnce({
          Items: [
            { taskId: 'task-1', email: 'a@test.com' },
            { taskId: 'task-1', email: 'b@test.com' },
          ],
          LastEvaluatedKey: { taskId: 'task-1', email: 'b@test.com' },
        })
        .mockResolvedValueOnce({
          Items: [
            { taskId: 'task-1', email: 'c@test.com' },
          ],
        });

      const result = await subscriberDb.getTaskSubscribers('task-1');

      expect(result).toHaveLength(3);
      expect(queryPromiseMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('getAllTaskSubscribers', () => {
    it('should collect all subscribers across pages', async () => {
      queryPromiseMock
        .mockResolvedValueOnce({
          Items: [
            { taskId: 'task-1', email: 'a@test.com' },
          ],
          LastEvaluatedKey: { taskId: 'task-1', email: 'a@test.com' },
        })
        .mockResolvedValueOnce({
          Items: [
            { taskId: 'task-1', email: 'b@test.com' },
          ],
        });

      const result = await subscriberDb.getAllTaskSubscribers('task-1');

      expect(result).toHaveLength(2);
      expect(queryPromiseMock).toHaveBeenCalledTimes(2);
    });
  });
});
