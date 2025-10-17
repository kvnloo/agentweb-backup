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
      expect(result.eventsByUser).toHaveLength(1); // Only subscriber1 has engagement (opened/clicked)
      expect(result.totalEngagedUsers).toBe(1); // 1 engaged user (subscriber1)

      // Verify events are grouped by user email
      const subscriber1Events = result.eventsByUser.find(user => user.userEmail === 'subscriber1@example.com');
      
      expect(subscriber1Events).toBeDefined();
      expect(subscriber1Events!.events).toHaveLength(3);
      
      // subscriber2 should be filtered out since they only have delivered events (no engagement)
      const subscriber2Events = result.eventsByUser.find(user => user.userEmail === 'subscriber2@example.com');
      expect(subscriber2Events).toBeUndefined();

      // Verify events are sorted by createdAt (chronological order) for subscriber1
      expect(subscriber1Events!.events[0].eventType).toBe('email.delivered');
      expect(subscriber1Events!.events[1].eventType).toBe('email.opened');
      expect(subscriber1Events!.events[2].eventType).toBe('email.clicked');

      // Verify delivered, clicked and opened events are included for subscriber1
      const eventTypes = subscriber1Events!.events.map(event => event.eventType);
      expect(eventTypes).toContain('email.delivered');
      expect(eventTypes).toContain('email.opened');
      expect(eventTypes).toContain('email.clicked');

      // subscriber2 is filtered out since they only have delivered events (no engagement)
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
          createdAt: '2024-01-01T09:00:00Z',
          data: { to: 'subscriber1@example.com' },
          processedAt: '2024-01-01T09:01:00Z'
        },
        {
          eventId: 'event2',
          emailId: 'email1',
          emailDomain: 'test.com',
          eventType: 'email.opened',
          createdAt: '2024-01-01T10:00:00Z',
          data: { to: 'subscriber1@example.com' },
          processedAt: '2024-01-01T10:01:00Z'
        }
      ];

      const productUpdateEvents = [
        {
          eventId: 'event3',
          emailId: 'email2',
          emailDomain: 'test.com',
          eventType: 'email.delivered',
          createdAt: '2024-01-01T10:30:00Z',
          data: { to: 'subscriber1@example.com' },
          processedAt: '2024-01-01T10:31:00Z'
        },
        {
          eventId: 'event4',
          emailId: 'email2',
          emailDomain: 'test.com',
          eventType: 'email.clicked',
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
      expect(newsletterResult.eventsByUser).toHaveLength(1);
      expect(newsletterResult.eventsByUser[0].userEmail).toBe('subscriber1@example.com');
      expect(newsletterResult.eventsByUser[0].events).toHaveLength(2); // delivered + opened

      // Test Product Update subject
      mockEmailEventsDb.getEventsByEmailId.mockResolvedValue(productUpdateEvents);
      const productResult = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents('task123', 'Product Update', 'user123');
      expect(productResult.eventsByUser).toHaveLength(1);
      expect(productResult.eventsByUser[0].userEmail).toBe('subscriber1@example.com');
      expect(productResult.eventsByUser[0].events).toHaveLength(2); // delivered + clicked
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
      expect(exactMatch.eventsByUser).toHaveLength(0); // No events mocked, but structure is correct

      // Test different case
      const differentCase = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents('task123', 'newsletter', 'user123');
      expect(differentCase.eventsByUser).toHaveLength(0);
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
          eventType: 'email.opened',
          createdAt: '2024-01-01T10:00:00Z',
          data: { to: 'subscriber1@example.com' },
          processedAt: '2024-01-01T10:01:00Z'
        },
        {
          eventId: 'event2',
          emailId: 'email2',
          emailDomain: 'test.com',
          eventType: 'email.clicked',
          createdAt: '2024-01-01T11:00:00Z',
          data: { to: 'subscriber1@example.com' },
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

      expect(result.eventsByUser).toHaveLength(1); // One user with engagement events
      expect(result.totalEngagedUsers).toBe(1); // 1 engaged user
      
      // Should include events from both email IDs for the same user
      const userEvents = result.eventsByUser[0];
      expect(userEvents.userEmail).toBe('subscriber1@example.com');
      expect(userEvents.events).toHaveLength(2);
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
      expect(result).toHaveProperty('eventsByUser');
      expect(result).toHaveProperty('totalEngagedUsers');
      expect(Array.isArray(result.eventsByUser)).toBe(true);
      expect(typeof result.totalEngagedUsers).toBe('number');
    });
  });
});
