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
        'Client Onboarding',
        [
          { stepCount: 1, title: 'Step 1' },
          { stepCount: 2, title: 'Step 2' },
        ],
        mockSessionId
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Work plan "Client Onboarding" created with 2 steps');
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

      await (agentModeService as any).createWorkPlan(
        'Project Plan',
        [
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
        mockSessionId
      );

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

    it('should overwrite existing work plan when creating new one', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: {
          title: 'Existing Plan',
          steps: [{ stepCount: 1, title: 'Step 1', status: 'pending' as const }],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T09:00:00.000Z',
        },
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue({
        ...mockSession,
        workPlan: {
          title: 'New Plan',
          steps: [{ stepCount: 1, title: 'New Step', status: 'pending' as const }],
        },
      });

      const result = await (agentModeService as any).createWorkPlan(
        'New Plan',
        [{ stepCount: 1, title: 'New Step' }],
        mockSessionId
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Work plan "New Plan" created');
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
      // Deep clone to avoid mutation across tests
      const freshWorkPlan = JSON.parse(JSON.stringify(existingWorkPlan));
      
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: freshWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).modifyWorkPlan(
        [{ stepCount: 3, title: 'Step 3', description: 'New step' }],
        [],
        mockSessionId
      );

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
      // Deep clone to avoid mutation across tests
      const freshWorkPlan = JSON.parse(JSON.stringify(existingWorkPlan));
      
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: freshWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).modifyWorkPlan(
        [
          {
            stepCount: 2,
            title: 'Updated Step 2',
            description: 'Updated description',
          },
        ],
        [],
        mockSessionId
      );

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
      // Deep clone to avoid mutation across tests
      const freshWorkPlan = JSON.parse(JSON.stringify(existingWorkPlan));
      
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: freshWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).modifyWorkPlan(
        [],
        [2],
        mockSessionId
      );

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          steps: [
            expect.objectContaining({ stepCount: 1, title: 'Step 1' }),
            // Step 2 should be removed
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

      const result = await (agentModeService as any).modifyWorkPlan(
        [{ stepCount: 1, title: 'Step 1' }],
        [],
        mockSessionId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('No work plan found');
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
      // Deep clone to avoid mutation across tests
      const freshWorkPlan = JSON.parse(JSON.stringify(existingWorkPlan));
      
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: freshWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      const result = await (agentModeService as any).setWorkPlanStatus(
        [{ stepCount: 2, status: 'completed', notes: 'Completed successfully' }],
        mockSessionId
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Step 2 status updated to completed');
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
      // Deep clone to avoid mutation across tests
      const freshWorkPlan = JSON.parse(JSON.stringify(existingWorkPlan));
      
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: freshWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).setWorkPlanStatus(
        [{ stepCount: 3, status: 'skipped', notes: 'Not needed' }],
        mockSessionId
      );

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
      // Deep clone to avoid mutation across tests
      const freshWorkPlan = JSON.parse(JSON.stringify(existingWorkPlan));
      
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: freshWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      await (agentModeService as any).setWorkPlanStatus(
        [{ stepCount: 2, status: 'completed' }],
        mockSessionId
      );

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
      // Deep clone to avoid mutation across tests
      const freshWorkPlan = JSON.parse(JSON.stringify(existingWorkPlan));
      
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: freshWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      const result = await (agentModeService as any).setWorkPlanStatus(
        [{ stepCount: 99, status: 'completed' }],
        mockSessionId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should fail when no work plan exists', async () => {
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        // No workPlan
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      const result = await (agentModeService as any).setWorkPlanStatus(
        [{ stepCount: 1, status: 'completed' }],
        mockSessionId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('No work plan found');
    });

    it('should update multiple steps at once', async () => {
      // Deep clone to avoid mutation across tests
      const freshWorkPlan = JSON.parse(JSON.stringify(existingWorkPlan));
      
      const mockSession = {
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        workPlan: freshWorkPlan,
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

      const result = await (agentModeService as any).setWorkPlanStatus(
        [
          { stepCount: 1, status: 'completed', notes: 'First done' },
          { stepCount: 2, status: 'completed', notes: 'Second done' },
        ],
        mockSessionId
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Updated 2 steps');
      expect(result.updatedSteps).toHaveLength(2);
      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({
              stepCount: 1,
              status: 'completed',
              notes: 'First done',
            }),
            expect.objectContaining({
              stepCount: 2,
              status: 'completed',
              notes: 'Second done',
            }),
          ]),
        })
      );
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

  describe('Required Function Calls', () => {
    describe('createWorkPlan with requiredFunctionCalls', () => {
      it('should create work plan with requiredFunctionCalls', async () => {
        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        await (agentModeService as any).createWorkPlan(
          'Client Onboarding',
          [
            {
              stepCount: 1,
              title: 'Analyze website',
              requiredFunctionCalls: ['search_web'],
            },
            {
              stepCount: 2,
              title: 'Create 3 blog articles',
              requiredFunctionCalls: ['create_blog_article', 'create_blog_article', 'create_blog_article'],
            },
          ],
          mockSessionId
        );

        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
          mockSessionId,
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({
                stepCount: 1,
                title: 'Analyze website',
                requiredFunctionCalls: ['search_web'],
              }),
              expect.objectContaining({
                stepCount: 2,
                title: 'Create 3 blog articles',
                requiredFunctionCalls: ['create_blog_article', 'create_blog_article', 'create_blog_article'],
              }),
            ]),
          })
        );
      });
    });

    describe('modifyWorkPlan with requiredFunctionCalls', () => {
      it('should add requiredFunctionCalls to existing step', async () => {
        const existingWorkPlan = {
          title: 'Project Plan',
          steps: [
            { stepCount: 1, title: 'Step 1', status: 'pending' as const },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(existingWorkPlan)),
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        await (agentModeService as any).modifyWorkPlan(
          [
            {
              stepCount: 1,
              title: 'Step 1',
              requiredFunctionCalls: ['search_web', 'create_blog_article'],
            },
          ],
          [],
          mockSessionId
        );

        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
          mockSessionId,
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({
                stepCount: 1,
                requiredFunctionCalls: ['search_web', 'create_blog_article'],
              }),
            ]),
          })
        );
      });
    });

    describe('setWorkPlanStatus with requiredFunctionCalls validation', () => {
      it('should fail to complete step when required functions not called', async () => {
        const workPlan = {
          title: 'Project Plan',
          steps: [
            {
              stepCount: 1,
              title: 'Research',
              status: 'pending' as const,
              requiredFunctionCalls: ['search_web'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: {}, // No functions called yet
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('Required function calls have not been made');
        expect(result.missingFunctionCalls).toBeDefined();
        expect(result.missingFunctionCalls[0].missing).toContain('search_web (need 1, have 0)');
      });

      it('should succeed when required functions have been called', async () => {
        const workPlan = {
          title: 'Project Plan',
          steps: [
            {
              stepCount: 1,
              title: 'Research',
              status: 'pending' as const,
              requiredFunctionCalls: ['search_web'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: { search_web: 1 }, // Function has been called
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateCalledFunctions as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Step 1 status updated to completed');
        expect(chatbotDb.updateCalledFunctions).toHaveBeenCalledWith(
          mockSessionId,
          { search_web: 0 } // Counter should be decremented
        );
      });

      it('should fail when multiple calls required but not enough made', async () => {
        const workPlan = {
          title: 'Project Plan',
          steps: [
            {
              stepCount: 1,
              title: 'Create 3 blog articles',
              status: 'pending' as const,
              requiredFunctionCalls: ['create_blog_article', 'create_blog_article', 'create_blog_article'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: { create_blog_article: 2 }, // Only 2 calls, need 3
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('Required function calls have not been made');
        expect(result.missingFunctionCalls[0].missing).toContain('create_blog_article (need 3, have 2)');
      });

      it('should succeed when multiple calls required and all made', async () => {
        const workPlan = {
          title: 'Project Plan',
          steps: [
            {
              stepCount: 1,
              title: 'Create 3 blog articles',
              status: 'pending' as const,
              requiredFunctionCalls: ['create_blog_article', 'create_blog_article', 'create_blog_article'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: { create_blog_article: 5 }, // More than enough
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateCalledFunctions as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(chatbotDb.updateCalledFunctions).toHaveBeenCalledWith(
          mockSessionId,
          { create_blog_article: 2 } // Should decrement by 3
        );
      });

      it('should handle multiple different required functions', async () => {
        const workPlan = {
          title: 'Project Plan',
          steps: [
            {
              stepCount: 1,
              title: 'Complete onboarding',
              status: 'pending' as const,
              requiredFunctionCalls: ['search_web', 'create_blog_article', 'generate_image'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: {
            search_web: 1,
            create_blog_article: 1,
            generate_image: 0, // This one is missing
          },
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'completed' }],
          mockSessionId
        );

        expect(result.success).toBe(false);
        expect(result.missingFunctionCalls[0].missing).toContain('generate_image (need 1, have 0)');
        expect(result.missingFunctionCalls[0].missing).not.toContain('search_web');
        expect(result.missingFunctionCalls[0].missing).not.toContain('create_blog_article');
      });

      it('should not validate requiredFunctionCalls when marking as skipped', async () => {
        const workPlan = {
          title: 'Project Plan',
          steps: [
            {
              stepCount: 1,
              title: 'Research',
              status: 'pending' as const,
              requiredFunctionCalls: ['search_web'],
            },
          ],
          createdAt: '2025-01-15T09:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
        };

        const mockSession = {
          sessionId: mockSessionId,
          userId: mockUserId,
          messages: [],
          workPlan: JSON.parse(JSON.stringify(workPlan)),
          calledFunctions: {}, // No functions called
        };

        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
        (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue(mockSession);

        const result = await (agentModeService as any).setWorkPlanStatus(
          [{ stepCount: 1, status: 'skipped', notes: 'Not needed' }],
          mockSessionId
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Step 1 status updated to skipped');
        // Should not try to update calledFunctions when skipping
        expect(chatbotDb.updateCalledFunctions).not.toHaveBeenCalled();
      });
    });
  });
});

