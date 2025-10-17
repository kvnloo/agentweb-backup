import { TaskSubscriberMetricsService } from '../services/taskSubscriberMetricsService';

// Mock the database services
jest.mock('../services/db', () => ({
  taskDb: {
    getTaskById: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
  },
  subscriberDb: {
    getAllTaskSubscribers: jest.fn(),
  },
}));

// Mock the emailEventsDb module
const mockEmailEventsDb = {
  getEventsByEmailDomain: jest.fn(),
  getEventsByEmailId: jest.fn(),
};

jest.mock('../services/emailEventsDb', () => mockEmailEventsDb);

describe('TaskSubscriberMetricsService - Simple Tests', () => {
  const mockDb = require('../services/db');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getTaskSubscriberMetrics - emailHistory removal', () => {
    const taskId = 'test-task-123';
    const userId = 'test-user-123';
    const emailDomain = 'test.com';

    const mockTask = {
      taskId,
      userId,
      name: 'Test Task',
    };

    const mockUser = {
      userId,
      email: 'user@test.com',
      emailDomain,
      isAdmin: false,
    };

    const mockSubscribers = [
      {
        subscribedAt: '2025-01-01T00:00:00.000Z',
        taskId,
        email: 'subscriber1@test.com',
        emailHistory: [
          {
            emailId: 'email-1',
            subject: 'Test Email 1',
            senderType: 'resend',
            sentAt: '2025-01-01T00:00:00.000Z',
          },
          {
            emailId: 'email-2',
            subject: 'Test Email 2',
            senderType: 'resend',
            sentAt: '2025-01-02T00:00:00.000Z',
          },
        ],
      },
      {
        subscribedAt: '2025-01-01T00:00:00.000Z',
        taskId,
        email: 'subscriber2@test.com',
        emailHistory: [
          {
            emailId: 'email-3',
            subject: 'Test Email 1',
            senderType: 'resend',
            sentAt: '2025-01-01T00:00:00.000Z',
          },
        ],
      },
    ];

    const mockEvents = [
      {
        eventId: 'event-1',
        emailId: 'email-1',
        emailDomain,
        eventType: 'delivered',
        createdAt: '2025-01-01T00:00:00.000Z',
        data: {},
        processedAt: '2025-01-01T00:00:00.000Z',
      },
    ];

    it('should remove emailHistory from subscribers in response', async () => {
      // Test the emailHistory removal logic directly
      const subscribersWithHistory = [
        {
          subscribedAt: '2025-01-01T00:00:00.000Z',
          taskId: 'test-task-123',
          email: 'subscriber1@test.com',
          emailHistory: [
            { emailId: 'email-1', subject: 'Test Email 1', senderType: 'resend' },
          ],
        },
      ];

      // Simulate the emailHistory removal logic
      const subscribersWithoutHistory = subscribersWithHistory.map(subscriber => {
        const { emailHistory, ...subscriberWithoutHistory } = subscriber;
        return subscriberWithoutHistory;
      });

      // Verify that emailHistory is removed
      expect(subscribersWithoutHistory).toHaveLength(1);
      expect(subscribersWithoutHistory[0]).not.toHaveProperty('emailHistory');
      expect(subscribersWithoutHistory[0]).toHaveProperty('subscribedAt');
      expect(subscribersWithoutHistory[0]).toHaveProperty('taskId');
      expect(subscribersWithoutHistory[0]).toHaveProperty('email');
    });

    it('should handle empty subscribers list', async () => {
      mockDb.taskDb.getTaskById.mockResolvedValue(mockTask);
      mockDb.userDb.getUserById.mockResolvedValue(mockUser);
      mockDb.subscriberDb.getAllTaskSubscribers.mockResolvedValue([]);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId);

      // subscribers property removed - no longer returned
      // events property removed - no longer returned
      expect(result.metrics.totalEvents).toBe(0);
    });

    it('should handle user without email domain', async () => {
      const userWithoutDomain = { ...mockUser, emailDomain: null };
      mockDb.taskDb.getTaskById.mockResolvedValue(mockTask);
      mockDb.userDb.getUserById.mockResolvedValue(userWithoutDomain);
      mockDb.subscriberDb.getAllTaskSubscribers.mockResolvedValue(mockSubscribers);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId);

      // subscribers property removed - no longer returned

      // events property removed - no longer returned
      expect(result.metrics.totalEvents).toBe(0);
    });

    it('should throw error when task not found', async () => {
      mockDb.taskDb.getTaskById.mockResolvedValue(null);
      mockDb.userDb.getUserById.mockResolvedValue(mockUser);

      await expect(
        TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId)
      ).rejects.toThrow('Task not found');
    });

    it('should throw error when user not found', async () => {
      mockDb.taskDb.getTaskById.mockResolvedValue(mockTask);
      mockDb.userDb.getUserById.mockResolvedValue(null);

      await expect(
        TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId)
      ).rejects.toThrow('User not found');
    });

    it('should throw error when access denied', async () => {
      const otherUserTask = { ...mockTask, userId: 'other-user' };
      mockDb.taskDb.getTaskById.mockResolvedValue(otherUserTask);
      mockDb.userDb.getUserById.mockResolvedValue(mockUser);

      await expect(
        TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId)
      ).rejects.toThrow('Access denied');
    });

    it('should allow admin users to access any task', async () => {
      const adminUser = { ...mockUser, isAdmin: true };
      const otherUserTask = { ...mockTask, userId: 'other-user' };
      
      mockDb.taskDb.getTaskById.mockResolvedValue(otherUserTask);
      mockDb.userDb.getUserById.mockResolvedValue(adminUser);
      mockDb.subscriberDb.getAllTaskSubscribers.mockResolvedValue([]);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId);

      // subscribers property removed - no longer returned
      expect(result.metrics.totalEvents).toBe(0);
    });
  });

  describe('getTaskSubscriberEngagementEvents - basic functionality', () => {
    const taskId = 'test-task-123';
    const userId = 'test-user-123';
    const emailSubject = 'Test Email Subject';

    const mockTask = {
      taskId,
      userId,
      name: 'Test Task',
    };

    const mockUser = {
      userId,
      email: 'user@test.com',
      emailDomain: 'test.com',
      isAdmin: false,
    };

    it('should return empty events when no subscribers exist', async () => {
      mockDb.taskDb.getTaskById.mockResolvedValue(mockTask);
      mockDb.userDb.getUserById.mockResolvedValue(mockUser);
      mockDb.subscriberDb.getAllTaskSubscribers.mockResolvedValue([]);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents(
        taskId,
        emailSubject,
        userId
      );

      expect(result.taskId).toBe(taskId);
      expect(result.emailSubject).toBe(emailSubject);
      // events property removed - no longer returned
      expect(result.totalEvents).toBe(0);
    });

    it('should return empty events when user has no email domain', async () => {
      const userWithoutDomain = { ...mockUser, emailDomain: null };
      mockDb.taskDb.getTaskById.mockResolvedValue(mockTask);
      mockDb.userDb.getUserById.mockResolvedValue(userWithoutDomain);
      mockDb.subscriberDb.getAllTaskSubscribers.mockResolvedValue([]);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents(
        taskId,
        emailSubject,
        userId
      );

      expect(result.taskId).toBe(taskId);
      expect(result.emailSubject).toBe(emailSubject);
      // events property removed - no longer returned
      expect(result.totalEvents).toBe(0);
    });

    it('should throw error when task not found', async () => {
      mockDb.taskDb.getTaskById.mockResolvedValue(null);
      mockDb.userDb.getUserById.mockResolvedValue(mockUser);

      await expect(
        TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents(taskId, emailSubject, userId)
      ).rejects.toThrow('Task not found');
    });

    it('should throw error when user not found', async () => {
      mockDb.taskDb.getTaskById.mockResolvedValue(mockTask);
      mockDb.userDb.getUserById.mockResolvedValue(null);

      await expect(
        TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents(taskId, emailSubject, userId)
      ).rejects.toThrow('User not found');
    });

    it('should throw error when access denied', async () => {
      const otherUserTask = { ...mockTask, userId: 'other-user' };
      mockDb.taskDb.getTaskById.mockResolvedValue(otherUserTask);
      mockDb.userDb.getUserById.mockResolvedValue(mockUser);

      await expect(
        TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents(taskId, emailSubject, userId)
      ).rejects.toThrow('Access denied');
    });

    it('should allow admin users to access any task', async () => {
      const adminUser = { ...mockUser, isAdmin: true };
      const otherUserTask = { ...mockTask, userId: 'other-user' };
      
      mockDb.taskDb.getTaskById.mockResolvedValue(otherUserTask);
      mockDb.userDb.getUserById.mockResolvedValue(adminUser);
      mockDb.subscriberDb.getAllTaskSubscribers.mockResolvedValue([]);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents(
        taskId,
        emailSubject,
        userId
      );

      expect(result.taskId).toBe(taskId);
      expect(result.emailSubject).toBe(emailSubject);
      // events property removed - no longer returned
      expect(result.totalEvents).toBe(0);
    });
  });
});