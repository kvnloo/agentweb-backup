import { chatbotDb } from '../services/chatbotService';

// Mock the entire chatbotService module
jest.mock('../services/chatbotService', () => {
  const originalModule = jest.requireActual('../services/chatbotService');
  return {
    ...originalModule,
    chatbotDb: {
      ...originalModule.chatbotDb,
      updateSessionWorkPlan: jest.fn(),
    },
  };
});

describe('ChatbotService - Work Plan', () => {
  const mockUpdateSessionWorkPlan = chatbotDb.updateSessionWorkPlan as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('updateSessionWorkPlan', () => {
    const sessionId = 'test-session-123';
    const mockWorkPlan = {
      title: 'Client Onboarding',
      steps: [
        {
          stepCount: 1,
          title: 'Analyze website',
          description: 'Gather business information',
          status: 'completed' as const,
          completedAt: '2025-01-15T10:00:00.000Z',
          notes: 'Website analyzed successfully',
        },
        {
          stepCount: 2,
          title: 'Update brand guidelines',
          status: 'pending' as const,
        },
        {
          stepCount: 3,
          title: 'Create marketing strategy',
          status: 'pending' as const,
        },
      ],
      createdAt: '2025-01-15T09:00:00.000Z',
      updatedAt: '2025-01-15T10:00:00.000Z',
    };

    it('should successfully update work plan with valid sequential stepCount', async () => {
      mockUpdateSessionWorkPlan.mockResolvedValue({
        sessionId,
        workPlan: mockWorkPlan,
      });

      const result = await chatbotDb.updateSessionWorkPlan(sessionId, mockWorkPlan);

      expect(mockUpdateSessionWorkPlan).toHaveBeenCalledWith(sessionId, mockWorkPlan);
      expect(result.workPlan).toBeDefined();
      expect(result.workPlan?.title).toBe('Client Onboarding');
      expect(result.workPlan?.steps).toHaveLength(3);
    });

    it('should throw error when stepCount validation fails', async () => {
      const invalidWorkPlan = {
        ...mockWorkPlan,
        steps: [
          {
            stepCount: 1,
            title: 'Step 1',
            status: 'pending' as const,
          },
          {
            stepCount: 3, // Invalid: should be 2
            title: 'Step 3',
            status: 'pending' as const,
          },
        ],
      };

      mockUpdateSessionWorkPlan.mockRejectedValue(
        new Error('Invalid stepCount at index 1: expected 2 but got 3')
      );

      await expect(
        chatbotDb.updateSessionWorkPlan(sessionId, invalidWorkPlan)
      ).rejects.toThrow(/Invalid stepCount at index 1: expected 2 but got 3/);
    });

    it('should handle work plan with all status types', async () => {
      const workPlanWithAllStatuses = {
        title: 'Complete Plan',
        steps: [
          {
            stepCount: 1,
            title: 'Completed step',
            status: 'completed' as const,
            completedAt: '2025-01-15T10:00:00.000Z',
          },
          {
            stepCount: 2,
            title: 'Pending step',
            status: 'pending' as const,
          },
          {
            stepCount: 3,
            title: 'Skipped step',
            status: 'skipped' as const,
            notes: 'Not needed',
          },
        ],
        createdAt: '2025-01-15T09:00:00.000Z',
        updatedAt: '2025-01-15T10:00:00.000Z',
      };

      mockUpdateSessionWorkPlan.mockResolvedValue({
        sessionId,
        workPlan: workPlanWithAllStatuses,
      });

      const result = await chatbotDb.updateSessionWorkPlan(
        sessionId,
        workPlanWithAllStatuses
      );

      expect(result.workPlan).toBeDefined();
      expect(result.workPlan?.steps).toHaveLength(3);
      expect(result.workPlan?.steps[0].status).toBe('completed');
      expect(result.workPlan?.steps[1].status).toBe('pending');
      expect(result.workPlan?.steps[2].status).toBe('skipped');
    });

    it('should handle work plan with optional fields', async () => {
      const minimalWorkPlan = {
        title: 'Minimal Plan',
        steps: [
          {
            stepCount: 1,
            title: 'Only required fields',
            status: 'pending' as const,
          },
        ],
        createdAt: '2025-01-15T09:00:00.000Z',
        updatedAt: '2025-01-15T09:00:00.000Z',
      };

      mockUpdateSessionWorkPlan.mockResolvedValue({
        sessionId,
        workPlan: minimalWorkPlan,
      });

      const result = await chatbotDb.updateSessionWorkPlan(sessionId, minimalWorkPlan);

      expect(result.workPlan).toBeDefined();
      expect(result.workPlan?.steps[0].description).toBeUndefined();
      expect(result.workPlan?.steps[0].notes).toBeUndefined();
      expect(result.workPlan?.steps[0].completedAt).toBeUndefined();
    });

    it('should handle large work plans with many steps', async () => {
      const largeWorkPlan = {
        title: 'Large Project',
        steps: Array.from({ length: 20 }, (_, i) => ({
          stepCount: i + 1,
          title: `Step ${i + 1}`,
          status: 'pending' as const,
        })),
        createdAt: '2025-01-15T09:00:00.000Z',
        updatedAt: '2025-01-15T09:00:00.000Z',
      };

      mockUpdateSessionWorkPlan.mockResolvedValue({
        sessionId,
        workPlan: largeWorkPlan,
      });

      const result = await chatbotDb.updateSessionWorkPlan(sessionId, largeWorkPlan);

      expect(result.workPlan?.steps).toHaveLength(20);
      // Verify all stepCounts are sequential
      result.workPlan?.steps.forEach((step, index) => {
        expect(step.stepCount).toBe(index + 1);
      });
    });

    it('should propagate errors when update fails', async () => {
      const dbError = new Error('Database connection failed');
      mockUpdateSessionWorkPlan.mockRejectedValue(dbError);

      await expect(
        chatbotDb.updateSessionWorkPlan(sessionId, mockWorkPlan)
      ).rejects.toThrow('Database connection failed');
    });
  });
});

