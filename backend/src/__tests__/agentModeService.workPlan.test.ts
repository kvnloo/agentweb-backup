import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';

// Mock the dependencies
jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
  taskTemplateDb: {
    listTemplates: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn(),
      put: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      scan: jest.fn(),
      query: jest.fn(),
    })),
  },
  SecretsManager: jest.fn(),
}));

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

describe('AgentModeService - Work Plan', () => {
  let agentModeService: AgentModeService;
  const mockSessionId = 'test-session-123';
  const mockUserId = 'user-456';

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  describe('createWorkPlan', () => {
    it('should create a new work plan with valid steps', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        createdAt: '2025-01-15T09:00:00.000Z',
        updatedAt: '2025-01-15T09:00:00.000Z',
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue({
        ...mockSession,
        workPlan: {
          title: 'Client Onboarding',
          steps: [
            { stepCount: 1, title: 'Step 1', status: 'pending' },
            { stepCount: 2, title: 'Step 2', status: 'pending' },
          ],
        },
      });

      const result = await (agentModeService as any).createWorkPlan(
        mockSessionId,
        mockUserId,
        {
          title: 'Client Onboarding',
          steps: [
            { stepCount: 1, title: 'Step 1' },
            { stepCount: 2, title: 'Step 2' },
          ],
        }
      );

      expect(result).toContain('Work plan "Client Onboarding" created with 2 steps');
      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          title: 'Client Onboarding',
          steps: expect.arrayContaining([
            expect.objectContaining({
              stepCount: 1,
              title: 'Step 1',
              status: 'pending',
            }),
            expect.objectContaining({
              stepCount: 2,
              title: 'Step 2',
              status: 'pending',
            }),
          ]),
        })
      );
    });

    it('should create work plan with step descriptions', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).createWorkPlan(mockSessionId, mockUserId, {
        title: 'Project Plan',
        steps: [
          {
            stepCount: 1,
            title: 'Research',
            description: 'Conduct market research',
          },
          {
            stepCount: 2,
            title: 'Development',
            description: 'Build the solution',
          },
        ],
      });

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({
              stepCount: 1,
              title: 'Research',
              description: 'Conduct market research',
              status: 'pending',
            }),
          ]),
        })
      );
    });

    it('should reject creating work plan when one already exists', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: {
          title: 'Existing Plan',
          steps: [{ stepCount: 1, title: 'Step 1', status: 'pending' }],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T09:00:00.000Z',
        },
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      await expect(
        (agentModeService as any).createWorkPlan(mockSessionId, mockUserId, {
          title: 'New Plan',
          steps: [{ stepCount: 1, title: 'Step 1' }],
        })
      ).rejects.toThrow('A work plan already exists');
    });
  });

  describe('modifyWorkPlan', () => {
    const existingWorkPlan = {
      title: 'Project Plan',
      steps: [
        { stepCount: 1, title: 'Step 1', status: 'completed' as const },
        { stepCount: 2, title: 'Step 2', status: 'pending' as const },
      ],
      createdAt: '2025-01-15T09:00:00.000Z',
      updatedAt: '2025-01-15T10:00:00.000Z',
    };

    it('should add new steps to existing work plan', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: existingWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).modifyWorkPlan(mockSessionId, mockUserId, {
        steps: [{ stepCount: 3, title: 'Step 3', description: 'New step' }],
      });

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({ stepCount: 1, title: 'Step 1' }),
            expect.objectContaining({ stepCount: 2, title: 'Step 2' }),
            expect.objectContaining({
              stepCount: 3,
              title: 'Step 3',
              description: 'New step',
              status: 'pending',
            }),
          ]),
        })
      );
    });

    it('should update existing step details without changing status', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: existingWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).modifyWorkPlan(mockSessionId, mockUserId, {
        steps: [
          {
            stepCount: 2,
            title: 'Updated Step 2',
            description: 'Updated description',
          },
        ],
      });

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({ stepCount: 1, status: 'completed' }), // Unchanged
            expect.objectContaining({
              stepCount: 2,
              title: 'Updated Step 2',
              description: 'Updated description',
              status: 'pending', // Status preserved
            }),
          ]),
        })
      );
    });

    it('should remove steps when removeStepCounts is provided', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: existingWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).modifyWorkPlan(mockSessionId, mockUserId, {
        steps: [],
        removeStepCounts: [2],
      });

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          steps: [
            expect.objectContaining({ stepCount: 1, title: 'Step 1' }),
            // Step 2 should be removed and step 3 should not exist
          ],
        })
      );
    });

    it('should fail when no work plan exists', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        // No workPlan
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      await expect(
        (agentModeService as any).modifyWorkPlan(mockSessionId, mockUserId, {
          steps: [{ stepCount: 1, title: 'Step 1' }],
        })
      ).rejects.toThrow('No work plan exists');
    });
  });

  describe('setWorkPlanStatus', () => {
    const existingWorkPlan = {
      title: 'Project Plan',
      steps: [
        { stepCount: 1, title: 'Step 1', status: 'completed' as const },
        { stepCount: 2, title: 'Step 2', status: 'pending' as const },
        { stepCount: 3, title: 'Step 3', status: 'pending' as const },
      ],
      createdAt: '2025-01-15T09:00:00.000Z',
      updatedAt: '2025-01-15T10:00:00.000Z',
    };

    it('should update step status to completed', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: existingWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      const result = await (agentModeService as any).setWorkPlanStatus(
        mockSessionId,
        mockUserId,
        {
          stepCount: 2,
          status: 'completed',
          notes: 'Completed successfully',
        }
      );

      expect(result).toContain('Step 2 status updated to completed');
      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({
              stepCount: 2,
              status: 'completed',
              notes: 'Completed successfully',
              completedAt: expect.any(String),
            }),
          ]),
        })
      );
    });

    it('should update step status to skipped', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: existingWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).setWorkPlanStatus(mockSessionId, mockUserId, {
        stepCount: 3,
        status: 'skipped',
        notes: 'Not needed',
      });

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({
              stepCount: 3,
              status: 'skipped',
              notes: 'Not needed',
            }),
          ]),
        })
      );
    });

    it('should update step status without notes', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: existingWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).setWorkPlanStatus(mockSessionId, mockUserId, {
        stepCount: 2,
        status: 'completed',
      });

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({
              stepCount: 2,
              status: 'completed',
              completedAt: expect.any(String),
            }),
          ]),
        })
      );
    });

    it('should fail when step does not exist', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: existingWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      await expect(
        (agentModeService as any).setWorkPlanStatus(mockSessionId, mockUserId, {
          stepCount: 99,
          status: 'completed',
        })
      ).rejects.toThrow('Step 99 not found in work plan');
    });

    it('should fail when no work plan exists', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        // No workPlan
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      await expect(
        (agentModeService as any).setWorkPlanStatus(mockSessionId, mockUserId, {
          stepCount: 1,
          status: 'completed',
        })
      ).rejects.toThrow('No work plan exists');
    });
  });

  describe('buildMarketingContext with work plan', () => {
    it('should inject work plan status into context', () => {
      const sessionHistory = [
        {
          role: 'system' as const,
          content: 'You are a helpful assistant',
          timestamp: '2025-01-15T09:00:00.000Z',
        },
        {
          role: 'user' as const,
          content: 'Hello',
          timestamp: '2025-01-15T09:01:00.000Z',
        },
      ];

      const workPlan = {
        title: 'Client Onboarding',
        steps: [
          { stepCount: 1, title: 'Analyze website', status: 'completed' as const },
          { stepCount: 2, title: 'Update guidelines', status: 'pending' as const },
          { stepCount: 3, title: 'Create strategy', status: 'pending' as const },
        ],
        createdAt: '2025-01-15T09:00:00.000Z',
        updatedAt: '2025-01-15T10:00:00.000Z',
      };

      const result = (agentModeService as any).buildMarketingContext(
        'What is next?',
        sessionHistory,
        [],
        workPlan
      );

      // Find the work plan status message
      const workPlanMessage = result.find(
        (msg: any) => msg.role === 'assistant' && msg.content.includes('Current Work Plan')
      );

      expect(workPlanMessage).toBeDefined();
      expect(workPlanMessage.content).toContain('Client Onboarding');
      expect(workPlanMessage.content).toContain('1. ✓ Analyze website (completed)');
      expect(workPlanMessage.content).toContain('2. ○ Update guidelines (pending)');
      expect(workPlanMessage.content).toContain('3. ○ Create strategy (pending)');
    });

    it('should include skipped steps with correct icon', () => {
      const workPlan = {
        title: 'Project Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Step 2', status: 'skipped' as const },
          { stepCount: 3, title: 'Step 3', status: 'pending' as const },
        ],
        createdAt: '2025-01-15T09:00:00.000Z',
        updatedAt: '2025-01-15T10:00:00.000Z',
      };

      const result = (agentModeService as any).buildMarketingContext(
        'Continue',
        [],
        [],
        workPlan
      );

      const workPlanMessage = result.find(
        (msg: any) => msg.role === 'assistant' && msg.content.includes('Current Work Plan')
      );

      expect(workPlanMessage.content).toContain('1. ✓ Step 1 (completed)');
      expect(workPlanMessage.content).toContain('2. ⊘ Step 2 (skipped)');
      expect(workPlanMessage.content).toContain('3. ○ Step 3 (pending)');
    });

    it('should not inject work plan when none exists', () => {
      const result = (agentModeService as any).buildMarketingContext(
        'Hello',
        [],
        [],
        undefined // No work plan
      );

      const workPlanMessage = result.find(
        (msg: any) => msg.role === 'assistant' && msg.content.includes('Current Work Plan')
      );

      expect(workPlanMessage).toBeUndefined();
    });
  });
});

