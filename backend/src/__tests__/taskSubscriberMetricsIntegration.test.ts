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
    getEventsByEmailDomain: jest.fn()
  }
}));

const mockOpenAI = {
  chat: {
    completions: {
      create: jest.fn()
    }
  }
};

jest.mock('openai', () => {
  return {
    OpenAI: jest.fn().mockImplementation(() => mockOpenAI)
  };
});

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    updateChatSession: jest.fn()
  }
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSettings: jest.fn()
  }
}));

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn()
}));

const { taskDb, userDb, subscriberDb } = require('../services/db');
const { emailEventsDb } = require('../services/emailEventsDb');

const mockTaskDb = taskDb as jest.Mocked<typeof taskDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockSubscriberDb = subscriberDb as jest.Mocked<typeof subscriberDb>;
const mockEmailEventsDb = emailEventsDb as jest.Mocked<typeof emailEventsDb>;

describe('Task Subscriber Metrics Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('End-to-End Metrics Calculation', () => {
    it('should calculate comprehensive metrics for a real-world scenario', async () => {
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
              subject: 'Weekly Newsletter - Week 1',
              senderType: 'resend',
              sentAt: '2024-01-01T10:00:00Z'
            },
            {
              emailId: 'email2',
              subject: 'Weekly Newsletter - Week 2',
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
              subject: 'Weekly Newsletter - Week 1',
              senderType: 'resend',
              sentAt: '2024-01-01T10:00:00Z'
            }
          ]
        },
        {
          email: 'subscriber3@example.com',
          subscribedAt: '2024-01-01T00:00:00Z',
          emailHistory: [
            {
              emailId: 'email1',
              subject: 'Weekly Newsletter - Week 1',
              senderType: 'resend',
              sentAt: '2024-01-01T10:00:00Z'
            },
            {
              emailId: 'email2',
              subject: 'Weekly Newsletter - Week 2',
              senderType: 'resend',
              sentAt: '2024-01-08T10:00:00Z'
            }
          ]
        }
      ];

      const mockEvents = [
        // Week 1 Newsletter Events
        {
          emailId: 'email1',
          eventType: 'email.delivered',
          createdAt: '2024-01-01T10:01:00Z',
          data: { to: ['subscriber1@example.com', 'subscriber2@example.com', 'subscriber3@example.com'] }
        },
        {
          emailId: 'email1',
          eventType: 'email.opened',
          createdAt: '2024-01-01T11:00:00Z',
          data: { to: ['subscriber1@example.com', 'subscriber3@example.com'] }
        },
        {
          emailId: 'email1',
          eventType: 'email.clicked',
          createdAt: '2024-01-01T12:00:00Z',
          data: { to: ['subscriber1@example.com'] }
        },
        // Week 2 Newsletter Events
        {
          emailId: 'email2',
          eventType: 'email.delivered',
          createdAt: '2024-01-08T10:01:00Z',
          data: { to: ['subscriber1@example.com', 'subscriber3@example.com'] }
        },
        {
          emailId: 'email2',
          eventType: 'email.opened',
          createdAt: '2024-01-08T11:00:00Z',
          data: { to: ['subscriber1@example.com'] }
        },
        {
          emailId: 'email2',
          eventType: 'email.bounced',
          createdAt: '2024-01-08T11:30:00Z',
          data: { to: ['subscriber3@example.com'] }
        }
      ];

      // Setup mocks
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue(mockUser);
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue(mockSubscribers);
      mockEmailEventsDb.getEventsByEmailDomain.mockResolvedValue(mockEvents);

      // Test the service
      const result = await TaskSubscriberMetricsService.getTaskSubscriberMetrics('task123', 'user123');

      // Verify basic structure
      expect(result.subscribers).toHaveLength(3);
      expect(result.events).toHaveLength(6);
      expect(result.metrics.totalEvents).toBe(6);

      // Verify event type counts
      expect(result.metrics.eventTypes).toEqual({
        'email.delivered': 2,
        'email.opened': 2,
        'email.clicked': 1,
        'email.bounced': 1
      });

      // Verify timeline
      expect(result.metrics.timeline).toHaveLength(2);
      expect(result.metrics.timeline[0].date).toBe('2024-01-08');
      expect(result.metrics.timeline[1].date).toBe('2024-01-01');

      // Verify Week 1 Newsletter metrics
      const week1Metrics = result.metrics.subjectMetrics['Weekly Newsletter - Week 1'];
      expect(week1Metrics.sent).toBe(3); // 3 subscribers received it
      expect(week1Metrics.delivered).toBe(3); // 3 unique recipients delivered
      expect(week1Metrics.opened).toBe(2); // 2 unique recipients opened
      expect(week1Metrics.clicked).toBe(1); // 1 unique recipient clicked
      expect(week1Metrics.bounced).toBe(0);
      expect(week1Metrics.failed).toBe(0);
      expect(week1Metrics.openRate).toBeCloseTo(66.67, 1); // 2/3 * 100
      expect(week1Metrics.clickThroughRate).toBeCloseTo(33.33, 1); // 1/3 * 100
      expect(week1Metrics.engagedEmails).toContain('subscriber1@example.com');
      expect(week1Metrics.engagedEmails).toContain('subscriber3@example.com');

      // Verify Week 2 Newsletter metrics
      const week2Metrics = result.metrics.subjectMetrics['Weekly Newsletter - Week 2'];
      expect(week2Metrics.sent).toBe(2); // 2 subscribers received it
      expect(week2Metrics.delivered).toBe(2); // 2 unique recipients delivered
      expect(week2Metrics.opened).toBe(1); // 1 unique recipient opened
      expect(week2Metrics.clicked).toBe(0);
      expect(week2Metrics.bounced).toBe(1); // 1 bounced
      expect(week2Metrics.failed).toBe(0);
      expect(week2Metrics.openRate).toBe(50); // 1/2 * 100
      expect(week2Metrics.clickThroughRate).toBe(0); // 0/2 * 100
      expect(week2Metrics.engagedEmails).toContain('subscriber1@example.com');
    });

    it('should handle mixed event data formats correctly', async () => {
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
              subject: 'Test Email',
              senderType: 'resend'
            }
          ]
        }
      ];

      const mockEvents = [
        {
          emailId: 'email1',
          eventType: 'email.delivered',
          createdAt: '2024-01-01T10:00:00Z',
          data: { to: 'subscriber1@example.com' } // Single string
        },
        {
          emailId: 'email1',
          eventType: 'email.opened',
          createdAt: '2024-01-01T11:00:00Z',
          data: { to: ['subscriber1@example.com'] } // Array
        },
        {
          emailId: 'email1',
          eventType: 'email.clicked',
          createdAt: '2024-01-01T12:00:00Z',
          data: null // No data
        }
      ];

      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue(mockUser);
      mockSubscriberDb.getAllTaskSubscribers.mockResolvedValue(mockSubscribers);
      mockEmailEventsDb.getEventsByEmailDomain.mockResolvedValue(mockEvents);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberMetrics('task123', 'user123');

      const testEmailMetrics = result.metrics.subjectMetrics['Test Email'];
      expect(testEmailMetrics.sent).toBe(1);
      expect(testEmailMetrics.delivered).toBe(1);
      expect(testEmailMetrics.opened).toBe(1);
      expect(testEmailMetrics.clicked).toBe(0); // No data for clicked event
    });
  });

  describe('Service Integration', () => {
    it('should handle service errors gracefully', async () => {
      mockTaskDb.getTaskById.mockRejectedValue(new Error('Database connection failed'));

      await expect(
        TaskSubscriberMetricsService.getTaskSubscriberMetrics('task123', 'user123')
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
      mockEmailEventsDb.getEventsByEmailDomain.mockResolvedValue([]);

      const result = await TaskSubscriberMetricsService.getTaskSubscriberMetrics('task123', 'user123');

      // Verify the structure matches the interface
      expect(result).toHaveProperty('subscribers');
      expect(result).toHaveProperty('events');
      expect(result).toHaveProperty('metrics');
      expect(result.metrics).toHaveProperty('timeline');
      expect(result.metrics).toHaveProperty('totalEvents');
      expect(result.metrics).toHaveProperty('eventTypes');
      expect(result.metrics).toHaveProperty('subjectMetrics');
    });
  });
});
