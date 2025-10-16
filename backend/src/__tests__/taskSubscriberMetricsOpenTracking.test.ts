import { TaskSubscriberMetricsService } from '../services/taskSubscriberMetricsService';

// Mock the database modules
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

// Mock the emailEventsDb module
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailDomain: jest.fn()
  }
}));

import { taskDb, userDb, subscriberDb } from '../services/db';
import { emailEventsDb } from '../services/emailEventsDb';

const mockTaskDb = taskDb as jest.Mocked<typeof taskDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockSubscriberDb = subscriberDb as jest.Mocked<typeof subscriberDb>;
const mockEmailEventsDb = emailEventsDb as jest.Mocked<typeof emailEventsDb>;

describe('TaskSubscriberMetricsService - Open Tracking Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getTaskSubscriberMetrics - open tracking behavior', () => {
    it('should include opened and openRate when opened > 0', async () => {
      const taskId = 'task123';
      const userId = 'user123';

      // Mock task
      mockTaskDb.getTaskById.mockResolvedValue({
        id: taskId,
        userId: userId,
        name: 'Test Task',
        prompt: 'Test prompt'
      } as any);

      // Mock user
      mockUserDb.getUserById.mockResolvedValue({
        id: userId,
        emailDomain: 'example.com',
        isAdmin: false
      } as any);

      // Mock subscribers with email history
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue([
        {
          id: 'sub1',
          taskId: taskId,
          emailHistory: [
            {
              emailId: 'email1',
              subject: 'Test Subject',
              senderType: 'resend'
            }
          ]
        }
      ] as any);

      // Mock email events with opened events
      mockEmailEventsDb.getEventsByEmailDomain.mockResolvedValue([
        {
          emailId: 'email1',
          eventType: 'email.delivered',
          createdAt: '2024-01-01T00:00:00Z',
          data: { to: 'test@example.com' }
        },
        {
          emailId: 'email1',
          eventType: 'email.opened',
          createdAt: '2024-01-01T00:01:00Z',
          data: { to: 'test@example.com' }
        }
      ] as any);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId);

      expect(result.metrics.subjectMetrics['Test Subject']).toHaveProperty('opened');
      expect(result.metrics.subjectMetrics['Test Subject']).toHaveProperty('openRate');
      expect(result.metrics.subjectMetrics['Test Subject'].opened).toBe(1);
      expect(result.metrics.subjectMetrics['Test Subject'].openRate).toBe(100);
    });

    it('should remove opened and openRate when opened is 0', async () => {
      const taskId = 'task123';
      const userId = 'user123';

      // Mock task
      mockTaskDb.getTaskById.mockResolvedValue({
        id: taskId,
        userId: userId,
        name: 'Test Task',
        prompt: 'Test prompt'
      } as any);

      // Mock user
      mockUserDb.getUserById.mockResolvedValue({
        id: userId,
        emailDomain: 'example.com',
        isAdmin: false
      } as any);

      // Mock subscribers with email history
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue([
        {
          id: 'sub1',
          taskId: taskId,
          emailHistory: [
            {
              emailId: 'email1',
              subject: 'Test Subject',
              senderType: 'resend'
            }
          ]
        }
      ] as any);

      // Mock email events with only delivered events (no opened events)
      mockEmailEventsDb.getEventsByEmailDomain.mockResolvedValue([
        {
          emailId: 'email1',
          eventType: 'email.delivered',
          createdAt: '2024-01-01T00:00:00Z',
          data: { to: 'test@example.com' }
        }
      ] as any);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId);

      expect(result.metrics.subjectMetrics['Test Subject']).not.toHaveProperty('opened');
      expect(result.metrics.subjectMetrics['Test Subject']).not.toHaveProperty('openRate');
      expect(result.metrics.subjectMetrics['Test Subject']).toHaveProperty('delivered');
      expect(result.metrics.subjectMetrics['Test Subject']).toHaveProperty('clicked');
      expect(result.metrics.subjectMetrics['Test Subject']).toHaveProperty('clickThroughRate');
    });

    it('should handle mixed subjects - some with opened tracking, some without', async () => {
      const taskId = 'task123';
      const userId = 'user123';

      // Mock task
      mockTaskDb.getTaskById.mockResolvedValue({
        id: taskId,
        userId: userId,
        name: 'Test Task',
        prompt: 'Test prompt'
      } as any);

      // Mock user
      mockUserDb.getUserById.mockResolvedValue({
        id: userId,
        emailDomain: 'example.com',
        isAdmin: false
      } as any);

      // Mock subscribers with email history for two subjects
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue([
        {
          id: 'sub1',
          taskId: taskId,
          emailHistory: [
            {
              emailId: 'email1',
              subject: 'Subject With Opens',
              senderType: 'resend'
            },
            {
              emailId: 'email2',
              subject: 'Subject Without Opens',
              senderType: 'resend'
            }
          ]
        }
      ] as any);

      // Mock email events - one subject has opens, one doesn't
      mockEmailEventsDb.getEventsByEmailDomain.mockResolvedValue([
        {
          emailId: 'email1',
          eventType: 'email.delivered',
          createdAt: '2024-01-01T00:00:00Z',
          data: { to: 'test@example.com' }
        },
        {
          emailId: 'email1',
          eventType: 'email.opened',
          createdAt: '2024-01-01T00:01:00Z',
          data: { to: 'test@example.com' }
        },
        {
          emailId: 'email2',
          eventType: 'email.delivered',
          createdAt: '2024-01-01T00:00:00Z',
          data: { to: 'test2@example.com' }
        }
      ] as any);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId);

      // Subject with opens should have opened and openRate
      expect(result.metrics.subjectMetrics['Subject With Opens']).toHaveProperty('opened');
      expect(result.metrics.subjectMetrics['Subject With Opens']).toHaveProperty('openRate');
      expect(result.metrics.subjectMetrics['Subject With Opens'].opened).toBe(1);
      expect(result.metrics.subjectMetrics['Subject With Opens'].openRate).toBe(100);

      // Subject without opens should not have opened and openRate
      expect(result.metrics.subjectMetrics['Subject Without Opens']).not.toHaveProperty('opened');
      expect(result.metrics.subjectMetrics['Subject Without Opens']).not.toHaveProperty('openRate');
      expect(result.metrics.subjectMetrics['Subject Without Opens']).toHaveProperty('delivered');
      expect(result.metrics.subjectMetrics['Subject Without Opens']).toHaveProperty('clicked');
    });

    it('should handle multiple opened events correctly', async () => {
      const taskId = 'task123';
      const userId = 'user123';

      // Mock task
      mockTaskDb.getTaskById.mockResolvedValue({
        id: taskId,
        userId: userId,
        name: 'Test Task',
        prompt: 'Test prompt'
      } as any);

      // Mock user
      mockUserDb.getUserById.mockResolvedValue({
        id: userId,
        emailDomain: 'example.com',
        isAdmin: false
      } as any);

      // Mock subscribers with email history
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue([
        {
          id: 'sub1',
          taskId: taskId,
          emailHistory: [
            {
              emailId: 'email1',
              subject: 'Test Subject',
              senderType: 'resend'
            }
          ]
        }
      ] as any);

      // Mock email events with multiple opened events
      mockEmailEventsDb.getEventsByEmailDomain.mockResolvedValue([
        {
          emailId: 'email1',
          eventType: 'email.delivered',
          createdAt: '2024-01-01T00:00:00Z',
          data: { to: 'test@example.com' }
        },
        {
          emailId: 'email1',
          eventType: 'email.opened',
          createdAt: '2024-01-01T00:01:00Z',
          data: { to: 'test@example.com' }
        },
        {
          emailId: 'email1',
          eventType: 'email.opened',
          createdAt: '2024-01-01T00:02:00Z',
          data: { to: 'test2@example.com' }
        }
      ] as any);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId);

      expect(result.metrics.subjectMetrics['Test Subject']).toHaveProperty('opened');
      expect(result.metrics.subjectMetrics['Test Subject']).toHaveProperty('openRate');
      expect(result.metrics.subjectMetrics['Test Subject'].opened).toBe(2); // Unique recipients
      expect(result.metrics.subjectMetrics['Test Subject'].openRate).toBe(200); // 2 opened / 1 delivered * 100
    });

    it('should handle case where no email events exist', async () => {
      const taskId = 'task123';
      const userId = 'user123';

      // Mock task
      mockTaskDb.getTaskById.mockResolvedValue({
        id: taskId,
        userId: userId,
        name: 'Test Task',
        prompt: 'Test prompt'
      } as any);

      // Mock user
      mockUserDb.getUserById.mockResolvedValue({
        id: userId,
        emailDomain: 'example.com',
        isAdmin: false
      } as any);

      // Mock subscribers with email history
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue([
        {
          id: 'sub1',
          taskId: taskId,
          emailHistory: [
            {
              emailId: 'email1',
              subject: 'Test Subject',
              senderType: 'resend'
            }
          ]
        }
      ] as any);

      // Mock empty email events
      mockEmailEventsDb.getEventsByEmailDomain.mockResolvedValue([]);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId);

      expect(result.metrics.subjectMetrics['Test Subject']).not.toHaveProperty('opened');
      expect(result.metrics.subjectMetrics['Test Subject']).not.toHaveProperty('openRate');
      expect(result.metrics.subjectMetrics['Test Subject']).toHaveProperty('sent');
      expect(result.metrics.subjectMetrics['Test Subject'].sent).toBe(1);
    });

    it('should handle case where subscribers have no email history', async () => {
      const taskId = 'task123';
      const userId = 'user123';

      // Mock task
      mockTaskDb.getTaskById.mockResolvedValue({
        id: taskId,
        userId: userId,
        name: 'Test Task',
        prompt: 'Test prompt'
      } as any);

      // Mock user
      mockUserDb.getUserById.mockResolvedValue({
        id: userId,
        emailDomain: 'example.com',
        isAdmin: false
      } as any);

      // Mock subscribers with no email history
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue([
        {
          id: 'sub1',
          taskId: taskId,
          emailHistory: []
        }
      ] as any);

      // Mock empty email events
      mockEmailEventsDb.getEventsByEmailDomain.mockResolvedValue([]);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId);

      expect(result.metrics.timeline).toEqual([]);
      expect(result.metrics.totalEvents).toBe(0);
      expect(result.metrics.eventTypes).toEqual({});
      expect(result.metrics.subjectMetrics).toEqual({});
    });

    it('should handle case where user has no email domain', async () => {
      const taskId = 'task123';
      const userId = 'user123';

      // Mock task
      mockTaskDb.getTaskById.mockResolvedValue({
        id: taskId,
        userId: userId,
        name: 'Test Task',
        prompt: 'Test prompt'
      } as any);

      // Mock user with no email domain
      mockUserDb.getUserById.mockResolvedValue({
        id: userId,
        emailDomain: null,
        isAdmin: false
      } as any);

      // Mock subscribers
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue([
        {
          id: 'sub1',
          taskId: taskId,
          emailHistory: []
        }
      ] as any);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId);

      expect(result.metrics.timeline).toEqual([]);
      expect(result.metrics.totalEvents).toBe(0);
      expect(result.metrics.eventTypes).toEqual({});
      expect(result.metrics.subjectMetrics).toEqual({});
    });

    it('should handle case where task is not found', async () => {
      const taskId = 'nonexistent';
      const userId = 'user123';

      // Mock task not found
      mockTaskDb.getTaskById.mockResolvedValue(undefined);

      await expect(
        TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId)
      ).rejects.toThrow('Task not found');
    });

    it('should handle case where user is not found', async () => {
      const taskId = 'task123';
      const userId = 'nonexistent';

      // Mock task
      mockTaskDb.getTaskById.mockResolvedValue({
        id: taskId,
        userId: userId,
        name: 'Test Task',
        prompt: 'Test prompt'
      } as any);

      // Mock user not found
      mockUserDb.getUserById.mockResolvedValue(undefined);

      await expect(
        TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId)
      ).rejects.toThrow('User not found');
    });

    it('should handle case where user is not authorized', async () => {
      const taskId = 'task123';
      const userId = 'user123';
      const otherUserId = 'other123';

      // Mock task owned by different user
      mockTaskDb.getTaskById.mockResolvedValue({
        id: taskId,
        userId: otherUserId,
        name: 'Test Task',
        prompt: 'Test prompt'
      } as any);

      // Mock user who is not admin
      mockUserDb.getUserById.mockResolvedValue({
        id: userId,
        emailDomain: 'example.com',
        isAdmin: false
      } as any);

      await expect(
        TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId)
      ).rejects.toThrow('Access denied');
    });

    it('should allow admin users to access any task', async () => {
      const taskId = 'task123';
      const userId = 'admin123';
      const taskOwnerId = 'other123';

      // Mock task owned by different user
      mockTaskDb.getTaskById.mockResolvedValue({
        id: taskId,
        userId: taskOwnerId,
        name: 'Test Task',
        prompt: 'Test prompt'
      } as any);

      // Mock admin user
      mockUserDb.getUserById.mockResolvedValue({
        id: userId,
        emailDomain: 'example.com',
        isAdmin: true
      } as any);

      // Mock subscribers
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue([
        {
          id: 'sub1',
          taskId: taskId,
          emailHistory: [
            {
              emailId: 'email1',
              subject: 'Test Subject',
              senderType: 'resend'
            }
          ]
        }
      ] as any);

      // Mock email events
      mockEmailEventsDb.getEventsByEmailDomain.mockResolvedValue([
        {
          emailId: 'email1',
          eventType: 'email.delivered',
          createdAt: '2024-01-01T00:00:00Z',
          data: { to: 'test@example.com' }
        }
      ] as any);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId);

      expect(result.metrics.subjectMetrics['Test Subject']).not.toHaveProperty('opened');
      expect(result.metrics.subjectMetrics['Test Subject']).not.toHaveProperty('openRate');
    });
  });
});
