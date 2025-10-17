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
    getEventsByEmailId: jest.fn()
  }
}));

const mockTaskDb = taskDb as jest.Mocked<typeof taskDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockSubscriberDb = subscriberDb as jest.Mocked<typeof subscriberDb>;

describe('TaskSubscriberMetricsService - Engagement Events (Simple Tests)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getTaskSubscriberEngagementEvents', () => {
    it('should return empty events when task is not found', async () => {
      mockTaskDb.getTaskById.mockResolvedValue(undefined);

      await expect(
        TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents('non-existent-task', 'Test Subject', 'user123')
      ).rejects.toThrow('Task not found');
    });

    it('should return empty events when user is not found', async () => {
      mockTaskDb.getTaskById.mockResolvedValue({
        taskId: 'task123',
        userId: 'user123',
        name: 'Test Task'
      });
      mockUserDb.getUserById.mockResolvedValue(undefined);

      await expect(
        TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents('task123', 'Test Subject', 'user123')
      ).rejects.toThrow('User not found');
    });

    it('should return empty events when user is not admin and task does not belong to user', async () => {
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
        TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents('task123', 'Test Subject', 'user123')
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

      const result = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents('task123', 'Test Subject', 'user123');

      expect(result).toEqual({
        taskId: 'task123',
        emailSubject: 'Test Subject',
        eventsByUser: [],
        totalEngagedUsers: 0
      });
    });

    it('should return empty events when no subscribers exist', async () => {
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

      const result = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents('task123', 'Test Subject', 'user123');

      expect(result).toEqual({
        taskId: 'task123',
        emailSubject: 'Test Subject',
        eventsByUser: [],
        totalEngagedUsers: 0
      });
    });

    it('should return empty events when user has no email domain', async () => {
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

      const result = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents('task123', 'Test Subject', 'user123');

      expect(result).toEqual({
        taskId: 'task123',
        emailSubject: 'Test Subject',
        eventsByUser: [],
        totalEngagedUsers: 0
      });
    });

    it('should return empty events when no matching email subject found', async () => {
      const mockTask = {
        taskId: 'task123',
        userId: 'user123',
        name: 'Test Task'
      };

      const mockUser = {
        userId: 'user123',
        isAdmin: false,
        emailDomain: 'test.com'
      };

      const mockSubscribers = [
        {
          email: 'subscriber1@example.com',
          subscribedAt: '2024-01-01',
          emailHistory: [
            {
              emailId: 'email1',
              subject: 'Different Subject',
              senderType: 'resend'
            }
          ]
        }
      ];

      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue(mockUser);
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue(mockSubscribers);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents('task123', 'Test Subject', 'user123');

      expect(result).toEqual({
        taskId: 'task123',
        emailSubject: 'Test Subject',
        eventsByUser: [],
        totalEngagedUsers: 0
      });
    });

    it('should handle case-sensitive email subject matching', async () => {
      const mockTask = {
        taskId: 'task123',
        userId: 'user123',
        name: 'Test Task'
      };

      const mockUser = {
        userId: 'user123',
        isAdmin: false,
        emailDomain: 'test.com'
      };

      const mockSubscribers = [
        {
          email: 'subscriber1@example.com',
          subscribedAt: '2024-01-01',
          emailHistory: [
            {
              emailId: 'email1',
              subject: 'Newsletter',
              senderType: 'resend'
            }
          ]
        }
      ];

      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue(mockUser);
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue(mockSubscribers);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents('task123', 'newsletter', 'user123');

      // Should not match due to case sensitivity
      expect(result.eventsByUser).toHaveLength(0);
      expect(result.totalEngagedUsers).toBe(0);
    });
  });
});
