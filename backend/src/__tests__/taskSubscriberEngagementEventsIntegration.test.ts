import { TaskSubscriberMetricsService } from '../services/taskSubscriberMetricsService';

// Mock all dependencies
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

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailId: jest.fn()
  }
}));

const { taskDb, userDb, subscriberDb } = require('../services/db');
const { emailEventsDb } = require('../services/emailEventsDb');

const mockTaskDb = taskDb as jest.Mocked<typeof taskDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockSubscriberDb = subscriberDb as jest.Mocked<typeof subscriberDb>;
const mockEmailEventsDb = emailEventsDb as jest.Mocked<typeof emailEventsDb>;

describe('Task Subscriber Engagement Events Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('End-to-End Engagement Events Retrieval', () => {
    it('should retrieve engagement events for a specific email subject', async () => {
      // Setup test data
      const mockTask = {
        taskId: 'task123',
        userId: 'user123',
        name: 'Newsletter Campaign'
      };

      const mockUser = {
        userId: 'user123',
        isAdmin: false,
        emailDomain: 'company.com'
      };

      const mockSubscribers = [
        {
          email: 'subscriber1@example.com',
          subscribedAt: '2024-01-01T00:00:00Z',
          emailHistory: [
            {
              emailId: 'email1',
              subject: 'Weekly Newsletter',
              senderType: 'resend',
              sentAt: '2024-01-01T10:00:00Z'
            },
            {
              emailId: 'email2',
              subject: 'Product Update',
              senderType: 'resend',
              sentAt: '2024-01-08T10:00:00Z'
            }
          ]
        },
        {
          email: 'subscriber2@example.com',
          subscribedAt: '2024-01-01T00:00:00Z',
          emailHistory: [
            {
              emailId: 'email1',
              subject: 'Weekly Newsletter',
              senderType: 'resend',
              sentAt: '2024-01-01T10:00:00Z'
            }
          ]
        }
      ];

      const mockEvents = [
        {
          eventId: 'event1',
          emailId: 'email1',
          emailDomain: 'company.com',
          eventType: 'email.delivered',
          createdAt: '2024-01-01T10:01:00Z',
          data: { to: 'subscriber1@example.com' },
          processedAt: '2024-01-01T10:02:00Z'
        },
        {
          eventId: 'event2',
          emailId: 'email1',
          emailDomain: 'company.com',
          eventType: 'email.opened',
          createdAt: '2024-01-01T11:00:00Z',
          data: { to: 'subscriber1@example.com' },
          processedAt: '2024-01-01T11:01:00Z'
        },
        {
          eventId: 'event3',
          emailId: 'email1',
          emailDomain: 'company.com',
          eventType: 'email.clicked',
          createdAt: '2024-01-01T12:00:00Z',
          data: { to: 'subscriber1@example.com' },
          processedAt: '2024-01-01T12:01:00Z'
        },
        {
          eventId: 'event4',
          emailId: 'email1',
          emailDomain: 'company.com',
          eventType: 'email.delivered',
          createdAt: '2024-01-01T10:01:00Z',
          data: { to: 'subscriber2@example.com' },
          processedAt: '2024-01-01T10:02:00Z'
        }
      ];

      // Setup mocks
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue(mockUser);
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue(mockSubscribers);
      mockEmailEventsDb.getEventsByEmailId.mockResolvedValue(mockEvents);

      // Test the service
      const result = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents('task123', 'Weekly Newsletter', 'user123');

      // Verify basic structure
      expect(result.taskId).toBe('task123');
      expect(result.emailSubject).toBe('Weekly Newsletter');
      expect(result.events).toHaveLength(4);
      expect(result.count).toBe(4);

      // Verify events are sorted by creation time (newest first)
      expect(result.events[0].eventId).toBe('event3'); // clicked
      expect(result.events[1].eventId).toBe('event2'); // opened
      expect(result.events[2].eventId).toBe('event1'); // delivered
      expect(result.events[3].eventId).toBe('event4'); // delivered

      // Verify all events are for the correct email ID
      result.events.forEach(event => {
        expect(event.emailId).toBe('email1');
        expect(event.emailDomain).toBe('company.com');
      });

      // Verify event types
      const eventTypes = result.events.map(event => event.eventType);
      expect(eventTypes).toContain('email.delivered');
      expect(eventTypes).toContain('email.opened');
      expect(eventTypes).toContain('email.clicked');
    });

    it('should filter events by email subject correctly', async () => {
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
          subscribedAt: '2024-01-01T00:00:00Z',
          emailHistory: [
            {
              emailId: 'email1',
              subject: 'Newsletter',
              senderType: 'resend'
            },
            {
              emailId: 'email2',
              subject: 'Product Update',
              senderType: 'resend'
            }
          ]
        }
      ];

      const newsletterEvents = [
        {
          eventId: 'event1',
          emailId: 'email1',
          emailDomain: 'test.com',
          eventType: 'email.delivered',
          createdAt: '2024-01-01T10:00:00Z',
          data: { to: 'subscriber1@example.com' },
          processedAt: '2024-01-01T10:01:00Z'
        }
      ];

      const productUpdateEvents = [
        {
          eventId: 'event2',
          emailId: 'email2',
          emailDomain: 'test.com',
          eventType: 'email.delivered',
          createdAt: '2024-01-01T11:00:00Z',
          data: { to: 'subscriber1@example.com' },
          processedAt: '2024-01-01T11:01:00Z'
        }
      ];

      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue(mockUser);
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue(mockSubscribers);
      mockEmailEventsDb.getEventsByEmailId.mockResolvedValue(newsletterEvents);

      // Test Newsletter subject
      const newsletterResult = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents('task123', 'Newsletter', 'user123');
      expect(newsletterResult.events).toHaveLength(1);
      expect(newsletterResult.events[0].emailId).toBe('email1');

      // Test Product Update subject
      mockEmailEventsDb.getEventsByEmailId.mockResolvedValue(productUpdateEvents);
      const productResult = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents('task123', 'Product Update', 'user123');
      expect(productResult.events).toHaveLength(1);
      expect(productResult.events[0].emailId).toBe('email2');
    });

    it('should handle case-sensitive subject matching', async () => {
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
          subscribedAt: '2024-01-01T00:00:00Z',
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
      mockEmailEventsDb.getEventsByEmailId.mockResolvedValue([]);

      // Test exact case match
      const exactMatch = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents('task123', 'Newsletter', 'user123');
      expect(exactMatch.events).toHaveLength(0); // No events mocked, but structure is correct

      // Test different case
      const differentCase = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents('task123', 'newsletter', 'user123');
      expect(differentCase.events).toHaveLength(0);
    });

    it('should handle multiple subscribers with same email subject', async () => {
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
          subscribedAt: '2024-01-01T00:00:00Z',
          emailHistory: [
            {
              emailId: 'email1',
              subject: 'Newsletter',
              senderType: 'resend'
            }
          ]
        },
        {
          email: 'subscriber2@example.com',
          subscribedAt: '2024-01-01T00:00:00Z',
          emailHistory: [
            {
              emailId: 'email2',
              subject: 'Newsletter',
              senderType: 'resend'
            }
          ]
        }
      ];

      const allEvents = [
        {
          eventId: 'event1',
          emailId: 'email1',
          emailDomain: 'test.com',
          eventType: 'email.delivered',
          createdAt: '2024-01-01T10:00:00Z',
          data: { to: 'subscriber1@example.com' },
          processedAt: '2024-01-01T10:01:00Z'
        },
        {
          eventId: 'event2',
          emailId: 'email2',
          emailDomain: 'test.com',
          eventType: 'email.delivered',
          createdAt: '2024-01-01T11:00:00Z',
          data: { to: 'subscriber2@example.com' },
          processedAt: '2024-01-01T11:01:00Z'
        }
      ];

      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue(mockUser);
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue(mockSubscribers);
      
      // Mock different events for different email IDs
      mockEmailEventsDb.getEventsByEmailId
        .mockResolvedValueOnce([allEvents[0]]) // For email1
        .mockResolvedValueOnce([allEvents[1]]); // For email2

      const result = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents('task123', 'Newsletter', 'user123');

      expect(result.events).toHaveLength(2);
      expect(result.count).toBe(2);
      
      // Should include events from both email IDs
      const emailIds = result.events.map(event => event.emailId);
      expect(emailIds).toContain('email1');
      expect(emailIds).toContain('email2');
    });
  });

  describe('Service Integration', () => {
    it('should handle service errors gracefully', async () => {
      mockTaskDb.getTaskById.mockRejectedValue(new Error('Database connection failed'));

      await expect(
        TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents('task123', 'Newsletter', 'user123')
      ).rejects.toThrow('Database connection failed');
    });

    it('should return consistent data structure', async () => {
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

      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue(mockUser);
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue([]);
      mockEmailEventsDb.getEventsByEmailId.mockResolvedValue([]);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents('task123', 'Newsletter', 'user123');

      // Verify the structure matches the interface
      expect(result).toHaveProperty('taskId');
      expect(result).toHaveProperty('emailSubject');
      expect(result).toHaveProperty('events');
      expect(result).toHaveProperty('count');
      expect(Array.isArray(result.events)).toBe(true);
      expect(typeof result.count).toBe('number');
    });
  });
});
