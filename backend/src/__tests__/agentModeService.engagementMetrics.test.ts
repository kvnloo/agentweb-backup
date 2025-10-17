import { AgentModeService } from '../services/agentModeService';

// Mock the TaskSubscriberMetricsService
jest.mock('../services/taskSubscriberMetricsService', () => ({
  TaskSubscriberMetricsService: {
    getTaskSubscriberEngagementEvents: jest.fn(),
  },
}));

describe('AgentModeService - Engagement Metrics', () => {
  let agentModeService: AgentModeService;
  const mockTaskSubscriberMetricsService = require('../services/taskSubscriberMetricsService').TaskSubscriberMetricsService;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
  });

  describe('getTaskSubscriberEngagementEvents', () => {
    it('should return comprehensive engagement metrics for active engagement', async () => {
      const taskId = 'test-task-123';
      const userId = 'test-user-123';
      const emailSubject = 'Test Newsletter';

      // Mock events data with various engagement patterns
      const mockEvents = {
        taskId,
        emailSubject,
        eventsByUser: [
          {
            userEmail: 'user1@example.com',
            events: [
              {
                eventType: 'email.delivered',
                createdAt: '2024-01-01T10:00:00Z'
              },
              {
                eventType: 'email.opened',
                createdAt: '2024-01-01T10:15:00Z' // 15 minutes later
              },
              {
                eventType: 'email.clicked',
                createdAt: '2024-01-01T10:20:00Z', // 20 minutes later
                link: 'https://example.com/cta1'
              }
            ]
          },
          {
            userEmail: 'user2@example.com',
            events: [
              {
                eventType: 'email.delivered',
                createdAt: '2024-01-01T10:00:00Z'
              },
              {
                eventType: 'email.opened',
                createdAt: '2024-01-01T11:30:00Z' // 1.5 hours later - delayed engagement
              }
            ]
          },
          {
            userEmail: 'user3@example.com',
            events: [
              {
                eventType: 'email.delivered',
                createdAt: '2024-01-01T10:00:00Z'
              },
              {
                eventType: 'email.clicked',
                createdAt: '2024-01-01T10:05:00Z', // 5 minutes later - immediate engagement
                link: 'https://example.com/cta2'
              },
              {
                eventType: 'email.clicked',
                createdAt: '2024-01-01T10:10:00Z', // Multiple clicks
                link: 'https://example.com/cta1'
              }
            ]
          }
        ],
        totalEngagedUsers: 3
      };

      mockTaskSubscriberMetricsService.getTaskSubscriberEngagementEvents.mockResolvedValue(mockEvents);

      const result = await (agentModeService as any).getTaskSubscriberEngagementEvents(taskId, emailSubject, userId);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Task subscriber engagement metrics retrieved successfully');
      expect(result.data).toBeDefined();

      // Verify engagement patterns
      expect(result.data.engagementPatterns.immediateEngagement).toBe(2); // user1 and user3
      expect(result.data.engagementPatterns.delayedEngagement).toBe(1); // user2
      expect(result.data.engagementPatterns.multiTouchEngagement).toBe(3); // All users have multiple event types
      expect(result.data.engagementPatterns.singleTouchEngagement).toBe(0); // None have single event type

      // Verify timing metrics
      expect(result.data.timingMetrics.averageTimeToOpen).toBe(53); // Average of 15 and 90 minutes
      expect(result.data.timingMetrics.averageTimeToClick).toBe(13); // Average of 20, 5, and 10 minutes (user3's second click)
      expect(result.data.timingMetrics.fastestEngagement).toBe(5); // 5 minutes
      expect(result.data.timingMetrics.slowestEngagement).toBe(90); // 90 minutes

      // Verify link analysis
      expect(result.data.linkAnalysis.totalClicks).toBe(3);
      expect(result.data.linkAnalysis.uniqueLinksClicked).toBe(2);
      expect(result.data.linkAnalysis.mostClickedLink).toBe('https://example.com/cta1'); // Clicked twice
    });

    it('should handle empty engagement data', async () => {
      const taskId = 'test-task-123';
      const userId = 'test-user-123';
      const emailSubject = 'Test Newsletter';

      const mockEvents = {
        taskId,
        emailSubject,
        eventsByUser: [],
        totalEngagedUsers: 0
      };

      mockTaskSubscriberMetricsService.getTaskSubscriberEngagementEvents.mockResolvedValue(mockEvents);

      const result = await (agentModeService as any).getTaskSubscriberEngagementEvents(taskId, emailSubject, userId);

      expect(result.success).toBe(true);
      expect(result.data.engagementPatterns.immediateEngagement).toBe(0);
      expect(result.data.engagementPatterns.delayedEngagement).toBe(0);
      expect(result.data.engagementPatterns.multiTouchEngagement).toBe(0);
      expect(result.data.engagementPatterns.singleTouchEngagement).toBe(0);
      expect(result.data.timingMetrics.averageTimeToOpen).toBeNull();
      expect(result.data.timingMetrics.averageTimeToClick).toBeNull();
      expect(result.data.timingMetrics.fastestEngagement).toBeNull();
      expect(result.data.timingMetrics.slowestEngagement).toBeNull();
      expect(result.data.linkAnalysis.totalClicks).toBe(0);
      expect(result.data.linkAnalysis.uniqueLinksClicked).toBe(0);
      expect(result.data.linkAnalysis.mostClickedLink).toBeNull();
    });

    it('should handle users with only delivered events (no engagement)', async () => {
      const taskId = 'test-task-123';
      const userId = 'test-user-123';
      const emailSubject = 'Test Newsletter';

      const mockEvents = {
        taskId,
        emailSubject,
        eventsByUser: [
          {
            userEmail: 'user1@example.com',
            events: [
              {
                eventType: 'email.delivered',
                createdAt: '2024-01-01T10:00:00Z'
              }
            ]
          }
        ],
        totalEngagedUsers: 1
      };

      mockTaskSubscriberMetricsService.getTaskSubscriberEngagementEvents.mockResolvedValue(mockEvents);

      const result = await (agentModeService as any).getTaskSubscriberEngagementEvents(taskId, emailSubject, userId);

      expect(result.success).toBe(true);
      expect(result.data.timingMetrics.averageTimeToOpen).toBeNull();
      expect(result.data.timingMetrics.averageTimeToClick).toBeNull();
    });

    it('should handle users with only opens (no clicks)', async () => {
      const taskId = 'test-task-123';
      const userId = 'test-user-123';
      const emailSubject = 'Test Newsletter';

      const mockEvents = {
        taskId,
        emailSubject,
        eventsByUser: [
          {
            userEmail: 'user1@example.com',
            events: [
              {
                eventType: 'email.delivered',
                createdAt: '2024-01-01T10:00:00Z'
              },
              {
                eventType: 'email.opened',
                createdAt: '2024-01-01T10:30:00Z'
              }
            ]
          }
        ],
        totalEngagedUsers: 1
      };

      mockTaskSubscriberMetricsService.getTaskSubscriberEngagementEvents.mockResolvedValue(mockEvents);

      const result = await (agentModeService as any).getTaskSubscriberEngagementEvents(taskId, emailSubject, userId);

      expect(result.success).toBe(true);
      expect(result.data.timingMetrics.averageTimeToOpen).toBe(30); // 30 minutes
      expect(result.data.timingMetrics.averageTimeToClick).toBeNull();
      expect(result.data.linkAnalysis.totalClicks).toBe(0);
    });

    it('should handle service errors gracefully', async () => {
      const taskId = 'test-task-123';
      const userId = 'test-user-123';
      const emailSubject = 'Test Newsletter';

      mockTaskSubscriberMetricsService.getTaskSubscriberEngagementEvents.mockRejectedValue(new Error('Service error'));

      const result = await (agentModeService as any).getTaskSubscriberEngagementEvents(taskId, emailSubject, userId);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Failed to get task subscriber engagement events');
      expect(result.error).toBe('Service error');
    });

    it('should correctly identify immediate vs delayed engagement', async () => {
      const taskId = 'test-task-123';
      const userId = 'test-user-123';
      const emailSubject = 'Test Newsletter';

      const mockEvents = {
        taskId,
        emailSubject,
        eventsByUser: [
          {
            userEmail: 'immediate@example.com',
            events: [
              {
                eventType: 'email.delivered',
                createdAt: '2024-01-01T10:00:00Z'
              },
              {
                eventType: 'email.opened',
                createdAt: '2024-01-01T10:30:00Z' // 30 minutes - immediate
              }
            ]
          },
          {
            userEmail: 'delayed@example.com',
            events: [
              {
                eventType: 'email.delivered',
                createdAt: '2024-01-01T10:00:00Z'
              },
              {
                eventType: 'email.opened',
                createdAt: '2024-01-01T12:00:00Z' // 2 hours - delayed
              }
            ]
          }
        ],
        totalEngagedUsers: 2
      };

      mockTaskSubscriberMetricsService.getTaskSubscriberEngagementEvents.mockResolvedValue(mockEvents);

      const result = await (agentModeService as any).getTaskSubscriberEngagementEvents(taskId, emailSubject, userId);

      expect(result.data.engagementPatterns.immediateEngagement).toBe(1);
      expect(result.data.engagementPatterns.delayedEngagement).toBe(1);
    });

    it('should correctly identify multi-touch vs single-touch engagement', async () => {
      const taskId = 'test-task-123';
      const userId = 'test-user-123';
      const emailSubject = 'Test Newsletter';

      const mockEvents = {
        taskId,
        emailSubject,
        eventsByUser: [
          {
            userEmail: 'multitouch@example.com',
            events: [
              {
                eventType: 'email.delivered',
                createdAt: '2024-01-01T10:00:00Z'
              },
              {
                eventType: 'email.opened',
                createdAt: '2024-01-01T10:15:00Z'
              },
              {
                eventType: 'email.clicked',
                createdAt: '2024-01-01T10:20:00Z'
              }
            ]
          },
          {
            userEmail: 'singletouch@example.com',
            events: [
              {
                eventType: 'email.delivered',
                createdAt: '2024-01-01T10:00:00Z'
              },
              {
                eventType: 'email.opened',
                createdAt: '2024-01-01T10:30:00Z'
              }
            ]
          }
        ],
        totalEngagedUsers: 2
      };

      mockTaskSubscriberMetricsService.getTaskSubscriberEngagementEvents.mockResolvedValue(mockEvents);

      const result = await (agentModeService as any).getTaskSubscriberEngagementEvents(taskId, emailSubject, userId);

      // Both users have multiple event types (delivered + opened/clicked), so both are multi-touch
      expect(result.data.engagementPatterns.multiTouchEngagement).toBe(2);
      expect(result.data.engagementPatterns.singleTouchEngagement).toBe(0);
    });
  });
});
