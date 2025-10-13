import { TaskSubscriberMetricsService } from '../services/taskSubscriberMetricsService';
import { taskDb, userDb, subscriberDb } from '../services/db';

// Mock the database services
jest.mock('../services/db', () => ({
  taskDb: {
    getTaskById: jest.fn()
  },
  userDb: {
    getUserById: jest.fn()
  },
  subscriberDb: {
    getAllTaskSubscribers: jest.fn()
  }
}));

// Mock the emailEventsDb
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailDomain: jest.fn()
  }
}));

const mockTaskDb = taskDb as jest.Mocked<typeof taskDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockSubscriberDb = subscriberDb as jest.Mocked<typeof subscriberDb>;

describe('TaskSubscriberMetricsService - Simple Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getTaskSubscriberMetrics', () => {
    it('should return empty metrics when task is not found', async () => {
      mockTaskDb.getTaskById.mockResolvedValue(undefined);

      await expect(
        TaskSubscriberMetricsService.getTaskSubscriberMetrics('non-existent-task', 'user123')
      ).rejects.toThrow('Task not found');
    });

    it('should return empty metrics when user is not found', async () => {
      mockTaskDb.getTaskById.mockResolvedValue({
        taskId: 'task123',
        userId: 'user123',
        name: 'Test Task'
      });
      mockUserDb.getUserById.mockResolvedValue(undefined);

      await expect(
        TaskSubscriberMetricsService.getTaskSubscriberMetrics('task123', 'user123')
      ).rejects.toThrow('User not found');
    });

    it('should return empty metrics when user is not admin and task does not belong to user', async () => {
      mockTaskDb.getTaskById.mockResolvedValue({
        taskId: 'task123',
        userId: 'other-user',
        name: 'Test Task'
      });
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'user123',
        isAdmin: false
      });

      await expect(
        TaskSubscriberMetricsService.getTaskSubscriberMetrics('task123', 'user123')
      ).rejects.toThrow('Access denied');
    });

    it('should allow admin users to access any task', async () => {
      mockTaskDb.getTaskById.mockResolvedValue({
        taskId: 'task123',
        userId: 'other-user',
        name: 'Test Task'
      });
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'user123',
        isAdmin: true,
        emailDomain: 'test.com'
      });
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue([]);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberMetrics('task123', 'user123');

      expect(result).toEqual({
        subscribers: [],
        events: [],
        metrics: {
          timeline: [],
          totalEvents: 0,
          eventTypes: {},
          subjectMetrics: {}
        }
      });
    });

    it('should return empty metrics when no subscribers exist', async () => {
      mockTaskDb.getTaskById.mockResolvedValue({
        taskId: 'task123',
        userId: 'user123',
        name: 'Test Task'
      });
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'user123',
        isAdmin: false,
        emailDomain: 'test.com'
      });
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue([]);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberMetrics('task123', 'user123');

      expect(result).toEqual({
        subscribers: [],
        events: [],
        metrics: {
          timeline: [],
          totalEvents: 0,
          eventTypes: {},
          subjectMetrics: {}
        }
      });
    });

    it('should return empty metrics when user has no email domain', async () => {
      mockTaskDb.getTaskById.mockResolvedValue({
        taskId: 'task123',
        userId: 'user123',
        name: 'Test Task'
      });
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'user123',
        isAdmin: false,
        emailDomain: null
      });
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue([
        { email: 'test@example.com', subscribedAt: '2024-01-01' }
      ]);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberMetrics('task123', 'user123');

      expect(result).toEqual({
        subscribers: [{ email: 'test@example.com', subscribedAt: '2024-01-01' }],
        events: [],
        metrics: {
          timeline: [],
          totalEvents: 0,
          eventTypes: {},
          subjectMetrics: {}
        }
      });
    });
  });
});
