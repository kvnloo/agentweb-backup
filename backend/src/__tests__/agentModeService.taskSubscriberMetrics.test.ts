import { AgentModeService } from '../services/agentModeService';

// Mock the TaskSubscriberMetricsService
jest.mock('../services/taskSubscriberMetricsService', () => ({
  TaskSubscriberMetricsService: {
    getTaskSubscriberMetrics: jest.fn(),
  },
}));

describe('AgentModeService - Task Subscriber Metrics', () => {
  let agentModeService: AgentModeService;
  const mockTaskSubscriberMetricsService = require('../services/taskSubscriberMetricsService').TaskSubscriberMetricsService;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
  });

  describe('getTaskSubscriberMetrics', () => {
    it('should strip engagedEmails from subject metrics for agent processing', async () => {
      const taskId = 'test-task-123';
      const userId = 'test-user-123';

      // Mock the service to return metrics with engagedEmails
      const mockMetrics = {
        metrics: {
          totalEvents: 5,
          eventTypes: {
            'email.delivered': 3,
            'email.opened': 2,
            'email.clicked': 1
          },
          subjectMetrics: {
            'Test Subject 1': {
              sent: 2,
              delivered: 2,
              opened: 1,
              clicked: 1,
              bounced: 0,
              failed: 0,
              openRate: 50,
              clickThroughRate: 50,
              engagedEmails: ['user1@example.com', 'user2@example.com']
            },
            'Test Subject 2': {
              sent: 1,
              delivered: 1,
              opened: 1,
              clicked: 0,
              bounced: 0,
              failed: 0,
              openRate: 100,
              clickThroughRate: 0,
              engagedEmails: ['user3@example.com']
            }
          }
        }
      };

      mockTaskSubscriberMetricsService.getTaskSubscriberMetrics.mockResolvedValue(mockMetrics);

      // Call the private method through reflection
      const result = await (agentModeService as any).getTaskSubscriberMetrics(taskId, userId);

      // Verify the response structure
      expect(result.success).toBe(true);
      expect(result.message).toBe('Task subscriber metrics retrieved successfully');
      expect(result.data).toBeDefined();

      // Verify that engagedEmails are stripped from all subject metrics
      expect(result.data.metrics.subjectMetrics['Test Subject 1']).not.toHaveProperty('engagedEmails');
      expect(result.data.metrics.subjectMetrics['Test Subject 2']).not.toHaveProperty('engagedEmails');

      // Verify that other properties are preserved
      expect(result.data.metrics.subjectMetrics['Test Subject 1']).toHaveProperty('sent');
      expect(result.data.metrics.subjectMetrics['Test Subject 1']).toHaveProperty('delivered');
      expect(result.data.metrics.subjectMetrics['Test Subject 1']).toHaveProperty('opened');
      expect(result.data.metrics.subjectMetrics['Test Subject 1']).toHaveProperty('clicked');
      expect(result.data.metrics.subjectMetrics['Test Subject 1']).toHaveProperty('bounced');
      expect(result.data.metrics.subjectMetrics['Test Subject 1']).toHaveProperty('failed');
      expect(result.data.metrics.subjectMetrics['Test Subject 1']).toHaveProperty('openRate');
      expect(result.data.metrics.subjectMetrics['Test Subject 1']).toHaveProperty('clickThroughRate');

      // Verify the values are preserved
      expect(result.data.metrics.subjectMetrics['Test Subject 1'].sent).toBe(2);
      expect(result.data.metrics.subjectMetrics['Test Subject 1'].delivered).toBe(2);
      expect(result.data.metrics.subjectMetrics['Test Subject 1'].opened).toBe(1);
      expect(result.data.metrics.subjectMetrics['Test Subject 1'].clicked).toBe(1);
      expect(result.data.metrics.subjectMetrics['Test Subject 1'].openRate).toBe(50);
      expect(result.data.metrics.subjectMetrics['Test Subject 1'].clickThroughRate).toBe(50);

      // Verify other metrics are preserved
      expect(result.data.metrics.totalEvents).toBe(5);
      expect(result.data.metrics.eventTypes).toEqual({
        'email.delivered': 3,
        'email.opened': 2,
        'email.clicked': 1
      });
    });

    it('should handle subject metrics without engagedEmails', async () => {
      const taskId = 'test-task-123';
      const userId = 'test-user-123';

      // Mock the service to return metrics without engagedEmails
      const mockMetrics = {
        metrics: {
          totalEvents: 2,
          eventTypes: {
            'email.delivered': 2
          },
          subjectMetrics: {
            'Test Subject': {
              sent: 1,
              delivered: 1,
              clicked: 0,
              bounced: 0,
              failed: 0,
              clickThroughRate: 0
              // Note: no engagedEmails property
            }
          }
        }
      };

      mockTaskSubscriberMetricsService.getTaskSubscriberMetrics.mockResolvedValue(mockMetrics);

      const result = await (agentModeService as any).getTaskSubscriberMetrics(taskId, userId);

      expect(result.success).toBe(true);
      expect(result.data.metrics.subjectMetrics['Test Subject']).not.toHaveProperty('engagedEmails');
      expect(result.data.metrics.subjectMetrics['Test Subject'].sent).toBe(1);
      expect(result.data.metrics.subjectMetrics['Test Subject'].delivered).toBe(1);
    });

    it('should handle empty subject metrics', async () => {
      const taskId = 'test-task-123';
      const userId = 'test-user-123';

      const mockMetrics = {
        metrics: {
          totalEvents: 0,
          eventTypes: {},
          subjectMetrics: {}
        }
      };

      mockTaskSubscriberMetricsService.getTaskSubscriberMetrics.mockResolvedValue(mockMetrics);

      const result = await (agentModeService as any).getTaskSubscriberMetrics(taskId, userId);

      expect(result.success).toBe(true);
      expect(result.data.metrics.subjectMetrics).toEqual({});
    });

    it('should handle service errors gracefully', async () => {
      const taskId = 'test-task-123';
      const userId = 'test-user-123';

      mockTaskSubscriberMetricsService.getTaskSubscriberMetrics.mockRejectedValue(new Error('Service error'));

      const result = await (agentModeService as any).getTaskSubscriberMetrics(taskId, userId);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Failed to get task subscriber metrics');
      expect(result.error).toBe('Service error');
    });

    it('should preserve subject metrics with open tracking disabled', async () => {
      const taskId = 'test-task-123';
      const userId = 'test-user-123';

      // Mock metrics with open tracking disabled (no opened/openRate properties)
      const mockMetrics = {
        metrics: {
          totalEvents: 2,
          eventTypes: {
            'email.delivered': 2
          },
          subjectMetrics: {
            'Test Subject': {
              sent: 1,
              delivered: 1,
              clicked: 0,
              bounced: 0,
              failed: 0,
              clickThroughRate: 0,
              engagedEmails: ['user@example.com']
              // Note: no opened or openRate properties
            }
          }
        }
      };

      mockTaskSubscriberMetricsService.getTaskSubscriberMetrics.mockResolvedValue(mockMetrics);

      const result = await (agentModeService as any).getTaskSubscriberMetrics(taskId, userId);

      expect(result.success).toBe(true);
      expect(result.data.metrics.subjectMetrics['Test Subject']).not.toHaveProperty('engagedEmails');
      expect(result.data.metrics.subjectMetrics['Test Subject']).not.toHaveProperty('opened');
      expect(result.data.metrics.subjectMetrics['Test Subject']).not.toHaveProperty('openRate');
      expect(result.data.metrics.subjectMetrics['Test Subject'].sent).toBe(1);
      expect(result.data.metrics.subjectMetrics['Test Subject'].delivered).toBe(1);
    });
  });
});
