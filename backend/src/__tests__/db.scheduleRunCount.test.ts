import AWS from 'aws-sdk';

// Mock AWS SDK
jest.mock('aws-sdk', () => {
  const mockDynamoDB = {
    get: jest.fn(),
    update: jest.fn(),
  };

  const mockS3 = {
    putObject: jest.fn().mockReturnThis(),
    getObject: jest.fn().mockReturnThis(),
    deleteObject: jest.fn().mockReturnThis(),
    promise: jest.fn().mockResolvedValue({}),
  };

  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDynamoDB),
    },
    S3: jest.fn(() => mockS3),
    config: {
      update: jest.fn(),
    },
  };
});

// Import after mocking
import { scheduleDb } from '../services/db';

describe('scheduleDb - runCount Feature', () => {
  let mockDynamoDB: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const DocumentClient = AWS.DynamoDB.DocumentClient as any;
    mockDynamoDB = new DocumentClient();
  });

  describe('updateScheduleAfterRun', () => {
    const scheduleId = 'test-schedule-123';
    const lastRunTime = '2026-01-26T10:00:00.000Z';
    const nextRunTime = '2026-01-27T10:00:00.000Z';

    it('should decrement runCount from 3 to 2 and keep schedule active', async () => {
      // Mock getting the current schedule with runCount = 3
      mockDynamoDB.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            scheduleId,
            runCount: 3,
            status: 'active',
          },
        }),
      });

      // Mock the update operation
      mockDynamoDB.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            scheduleId,
            runCount: 2,
            status: 'active',
            lastRunTime,
            nextRunTime,
          },
        }),
      });

      const result = await scheduleDb.updateScheduleAfterRun(
        scheduleId,
        lastRunTime,
        nextRunTime,
        true // decrementRunCount
      );

      // Verify get was called to fetch current runCount
      expect(mockDynamoDB.get).toHaveBeenCalledWith({
        TableName: expect.stringContaining('AW-TaskSchedules'),
        Key: { scheduleId },
      });

      // Verify update was called with runCount decrement but no status change
      expect(mockDynamoDB.update).toHaveBeenCalledWith({
        TableName: expect.stringContaining('AW-TaskSchedules'),
        Key: { scheduleId },
        UpdateExpression: expect.stringContaining('#runCount = #runCount - :one'),
        ExpressionAttributeNames: expect.objectContaining({
          '#runCount': 'runCount',
        }),
        ExpressionAttributeValues: expect.objectContaining({
          ':one': 1,
        }),
        ReturnValues: 'ALL_NEW',
      });

      // Should NOT include status update
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.not.stringContaining('#status = :paused'),
        })
      );
    });

    it('should decrement runCount from 1 to 0 and auto-pause the schedule', async () => {
      // Mock getting the current schedule with runCount = 1
      mockDynamoDB.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            scheduleId,
            runCount: 1,
            status: 'active',
          },
        }),
      });

      // Mock the update operation
      mockDynamoDB.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            scheduleId,
            runCount: 0,
            status: 'paused',
            lastRunTime,
            nextRunTime,
          },
        }),
      });

      const result = await scheduleDb.updateScheduleAfterRun(
        scheduleId,
        lastRunTime,
        nextRunTime,
        true // decrementRunCount
      );

      // Verify update was called with both runCount decrement AND status change to paused
      expect(mockDynamoDB.update).toHaveBeenCalledWith({
        TableName: expect.stringContaining('AW-TaskSchedules'),
        Key: { scheduleId },
        UpdateExpression: expect.stringContaining('#runCount = #runCount - :one'),
        ExpressionAttributeNames: expect.objectContaining({
          '#runCount': 'runCount',
          '#status': 'status',
        }),
        ExpressionAttributeValues: expect.objectContaining({
          ':one': 1,
          ':paused': 'paused',
        }),
        ReturnValues: 'ALL_NEW',
      });

      // Should include status update to paused
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.stringContaining('#status = :paused'),
        })
      );
    });

    it('should not decrement or pause schedule with unlimited runCount (-1)', async () => {
      // Mock getting the current schedule with runCount = -1 (unlimited)
      mockDynamoDB.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            scheduleId,
            runCount: -1,
            status: 'active',
          },
        }),
      });

      // Mock the update operation
      mockDynamoDB.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            scheduleId,
            runCount: -1,
            status: 'active',
            lastRunTime,
            nextRunTime,
          },
        }),
      });

      const result = await scheduleDb.updateScheduleAfterRun(
        scheduleId,
        lastRunTime,
        nextRunTime,
        true // decrementRunCount
      );

      // Should NOT include runCount decrement
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.not.stringContaining('#runCount'),
        })
      );

      // Should NOT include status change
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.not.stringContaining('#status'),
        })
      );
    });

    it('should not decrement runCount when decrementRunCount is false (delayed runs)', async () => {
      // Mock getting the current schedule with runCount = 5
      mockDynamoDB.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            scheduleId,
            runCount: 5,
            status: 'active',
          },
        }),
      });

      // Mock the update operation
      mockDynamoDB.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            scheduleId,
            runCount: 5,
            status: 'active',
            lastRunTime,
            nextRunTime,
          },
        }),
      });

      const result = await scheduleDb.updateScheduleAfterRun(
        scheduleId,
        lastRunTime,
        nextRunTime,
        false // DO NOT decrement runCount (delayed run)
      );

      // Should NOT include runCount decrement
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.not.stringContaining('#runCount'),
        })
      );

      // Should NOT include status change
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.not.stringContaining('#status'),
        })
      );
    });

    it('should handle schedule without runCount field (legacy schedules)', async () => {
      // Mock getting a schedule that doesn't have runCount field
      mockDynamoDB.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            scheduleId,
            // No runCount field
            status: 'active',
          },
        }),
      });

      // Mock the update operation
      mockDynamoDB.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            scheduleId,
            status: 'active',
            lastRunTime,
            nextRunTime,
          },
        }),
      });

      const result = await scheduleDb.updateScheduleAfterRun(
        scheduleId,
        lastRunTime,
        nextRunTime,
        true // decrementRunCount
      );

      // Should NOT include runCount decrement (field doesn't exist)
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.not.stringContaining('#runCount'),
        })
      );

      // Should NOT include status change
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.not.stringContaining('#status'),
        })
      );
    });

    it('should decrement runCount from 2 to 1 and keep schedule active', async () => {
      // Mock getting the current schedule with runCount = 2
      mockDynamoDB.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            scheduleId,
            runCount: 2,
            status: 'active',
          },
        }),
      });

      // Mock the update operation
      mockDynamoDB.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            scheduleId,
            runCount: 1,
            status: 'active',
            lastRunTime,
            nextRunTime,
          },
        }),
      });

      const result = await scheduleDb.updateScheduleAfterRun(
        scheduleId,
        lastRunTime,
        nextRunTime,
        true // decrementRunCount
      );

      // Verify update includes runCount decrement but no status change
      expect(mockDynamoDB.update).toHaveBeenCalledWith({
        TableName: expect.stringContaining('AW-TaskSchedules'),
        Key: { scheduleId },
        UpdateExpression: expect.stringContaining('#runCount = #runCount - :one'),
        ExpressionAttributeNames: expect.objectContaining({
          '#runCount': 'runCount',
        }),
        ExpressionAttributeValues: expect.objectContaining({
          ':one': 1,
        }),
        ReturnValues: 'ALL_NEW',
      });

      // Should NOT include status update (still has 1 run left)
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.not.stringContaining('#status = :paused'),
        })
      );
    });
  });
});
