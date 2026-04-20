import { Request, Response } from 'express';

// Mock all dependencies before importing the controller
// Mock subscriptionService so subscription checks always pass in tests
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => [
    'get_marketing_tips',
    'analyze_competitors',
    'create_work_plan',
    'modify_work_plan',
    'set_work_plan_status',
  ]),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getScheduledChatsDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    generateMarketingResponse: jest.fn(),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set([
      'install_skills', 'search_web', 'read_file_content', 'read_page_source',
      'search_knowledge_base', 'list_knowledge_base_files', 'read_knowledge_base_files',
      'create_work_plan', 'modify_work_plan', 'set_work_plan_status',
      'save_file', 'describe_image',
    ])),
    getAdminToolNames: jest.fn().mockReturnValue([
      'list_predefined_work_plans', 'manage_predefined_work_plan',
      'list_skills', 'manage_skill', 'get_chat_history',
    ]),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
    addRunResult: jest.fn(),
    getScheduleById: jest.fn(),
    getSchedulesReadyToRun: jest.fn(),
    updateScheduleAfterRun: jest.fn(),
    updateSchedule: jest.fn(),
  },
  taskDb: {
    getTaskExecutionById: jest.fn(),
    createTaskExecution: jest.fn(),
    updateTaskExecution: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn().mockResolvedValue({ userId: 'test-user-1', email: 'test@example.com', isAdmin: false }),
  },
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-run-id-123'),
}));

// Import mocked services
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb, taskDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { agentModeController, runScheduledChat } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockTaskDb = taskDb as jest.Mocked<typeof taskDb>;
const mockGenerateMarketingResponseWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

describe('AgentModeController - Scheduled Chat with Work Plan', () => {
  const mockUserId = 'test-user-123';
  const mockScheduleId = 'test-schedule-123';
  
  const baseSchedule = {
    scheduleId: mockScheduleId,
    scheduleName: 'Test Schedule',
    startingMessage: 'Hello, please help me with marketing',
    keywords: ['marketing', 'strategy'],
    requiredFunctionCalls: ['get_marketing_tips', 'analyze_competitors'],
    userId: mockUserId,
  };

  const mockSession = {
    sessionId: 'test-session-123',
    userId: mockUserId,
    title: 'Test Session',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockResponse = {
    content: 'Here are some marketing strategies and tips for your business.',
    toolCalls: [
      { name: 'get_marketing_tips', arguments: {} },
      { name: 'analyze_competitors', arguments: {} },
    ],
    knowledgeBaseQueries: [],
    sources: [],
    responseMessages: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup default mocks
    mockChatbotDb.createChatSession.mockResolvedValue(mockSession);
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(mockSession);
    mockAgentModeService.getDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Generated Title');
    // Use worker service instead of direct generateMarketingResponse
    mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(mockResponse);
    mockScheduleDb.addRunResult.mockResolvedValue(undefined);
    mockScheduleDb.getScheduleById.mockResolvedValue(baseSchedule);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([]);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Clean up to prevent memory leaks
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('Work Plan Integration', () => {
    it('should focus on next pending step when work plan exists and is not completed', async () => {
      const workPlan = {
        title: 'Onboarding Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Step 2', status: 'pending' as const },
          { stepCount: 3, title: 'Step 3', status: 'pending' as const },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const sessionWithWorkPlan = {
        ...mockSession,
        workPlan,
      };

      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithWorkPlan);

      const responseWithWorkPlan = {
        ...mockResponse,
        workPlan,
      };

      let callCount = 0;
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(() => {
        callCount++;
        return Promise.resolve(responseWithWorkPlan);
      });

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // Should have been called multiple times (work plan not completed)
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(20);

      // Check that retry messages focus on work plan steps
      const calls = mockGenerateMarketingResponseWorkerService.runInWorker.mock.calls;
      // First call uses starting message
      expect(calls[0][0].messageContent).toBe(baseSchedule.startingMessage);
      // Subsequent calls should remind to complete pending steps
      for (let i = 1; i < calls.length; i++) {
        expect(calls[i][0].messageContent).toContain('Please perform the work on pending steps');
        expect(calls[i][0].messageContent).toContain('set_work_plan_status');
      }

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'failure', // Work plan not completed
          passed: false,
        })
      );
    });

    it('should check keywords and function calls after work plan is completed', async () => {
      const workPlan = {
        title: 'Onboarding Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Step 2', status: 'completed' as const },
          { stepCount: 3, title: 'Step 3', status: 'completed' as const },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const sessionWithWorkPlan = {
        ...mockSession,
        workPlan,
      };

      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithWorkPlan);

      const responseWithWorkPlan = {
        ...mockResponse,
        workPlan,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(responseWithWorkPlan);

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'success',
          passed: true,
          attempt: 1,
          keywordMatches: ['marketing', 'strategy'],
          keywordMisses: [],
          functionCallMatches: ['get_marketing_tips', 'analyze_competitors'],
          functionCallMisses: [],
        })
      );
    });

    it('should progress through work plan steps sequentially', async () => {
      const workPlanStep1 = {
        title: 'Onboarding Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'pending' as const },
          { stepCount: 2, title: 'Step 2', status: 'pending' as const },
          { stepCount: 3, title: 'Step 3', status: 'pending' as const },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const workPlanStep2 = {
        ...workPlanStep1,
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Step 2', status: 'pending' as const },
          { stepCount: 3, title: 'Step 3', status: 'pending' as const },
        ],
      };

      const workPlanStep3 = {
        ...workPlanStep1,
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Step 2', status: 'completed' as const },
          { stepCount: 3, title: 'Step 3', status: 'pending' as const },
        ],
      };

      // Track getChatSession calls
      // getChatSession is called: once per attempt for retry message check, and once in generateSessionResponse
      let getChatSessionCallCount = 0;
      mockChatbotDb.getChatSession.mockImplementation(() => {
        getChatSessionCallCount++;
        // For retry message (odd calls after first two): check work plan state
        // For generateSessionResponse (even calls): get session
        if (getChatSessionCallCount === 1) {
          // First call in generateSessionResponse for attempt 1
          return Promise.resolve({ ...mockSession, workPlan: workPlanStep1 });
        } else if (getChatSessionCallCount === 2) {
          // Second call for retry message check (attempt 2)
          // Work plan should be updated from previous response
          return Promise.resolve({ ...mockSession, workPlan: workPlanStep2 });
        } else if (getChatSessionCallCount === 3) {
          // Third call in generateSessionResponse for attempt 2
          return Promise.resolve({ ...mockSession, workPlan: workPlanStep2 });
        } else if (getChatSessionCallCount === 4) {
          // Fourth call for retry message check (attempt 3)
          return Promise.resolve({ ...mockSession, workPlan: workPlanStep3 });
        } else {
          return Promise.resolve({ ...mockSession, workPlan: workPlanStep3 });
        }
      });

      let responseCallCount = 0;
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(() => {
        responseCallCount++;
        if (responseCallCount === 1) {
          return Promise.resolve({ ...mockResponse, workPlan: workPlanStep2 });
        } else if (responseCallCount === 2) {
          return Promise.resolve({ ...mockResponse, workPlan: workPlanStep3 });
        } else {
          return Promise.resolve({ ...mockResponse, workPlan: workPlanStep3 });
        }
      });

      await runScheduledChat(baseSchedule, mockUserId, true);

      const calls = mockGenerateMarketingResponseWorkerService.runInWorker.mock.calls;
      // First call uses starting message
      expect(calls[0][0].messageContent).toBe(baseSchedule.startingMessage);
      // Second call should remind to complete pending steps
      expect(calls[1][0].messageContent).toContain('Please perform the work on pending steps');
      expect(calls[1][0].messageContent).toContain('set_work_plan_status');
    });

    it('should skip completed and skipped steps to find next pending step', async () => {
      const workPlan = {
        title: 'Onboarding Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Step 2', status: 'skipped' as const },
          { stepCount: 3, title: 'Step 3', status: 'pending' as const },
          { stepCount: 4, title: 'Step 4', status: 'pending' as const },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const sessionWithWorkPlan = {
        ...mockSession,
        workPlan,
      };

      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithWorkPlan);

      const responseWithWorkPlan = {
        ...mockResponse,
        workPlan,
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(responseWithWorkPlan);

      await runScheduledChat(baseSchedule, mockUserId, true);

      const calls = mockGenerateMarketingResponseWorkerService.runInWorker.mock.calls;
      // Second call should remind to complete pending steps
      expect(calls[1][0].messageContent).toContain('Please perform the work on pending steps');
      expect(calls[1][0].messageContent).toContain('set_work_plan_status');
    });

    it('should work normally when no work plan exists', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(mockSession);

      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'success',
          passed: true,
          attempt: 1,
          keywordMatches: ['marketing', 'strategy'],
          functionCallMatches: ['get_marketing_tips', 'analyze_competitors'],
        })
      );
    });

    it('should complete successfully when work plan is completed and all requirements are met', async () => {
      const workPlan = {
        title: 'Onboarding Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Step 2', status: 'completed' as const },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const sessionWithWorkPlan = {
        ...mockSession,
        workPlan,
      };

      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithWorkPlan);

      const responseWithWorkPlan = {
        ...mockResponse,
        workPlan,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(responseWithWorkPlan);

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'success',
          passed: true,
          attempt: 1,
        })
      );
    });

    it('should fail when work plan is completed but requirements are not met', async () => {
      const workPlan = {
        title: 'Onboarding Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Step 2', status: 'completed' as const },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const sessionWithWorkPlan = {
        ...mockSession,
        workPlan,
      };

      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithWorkPlan);

      const responseWithWorkPlan = {
        ...mockResponse,
        workPlan,
        content: 'Here are some general business tips.',
        toolCalls: [{ name: 'get_marketing_tips', arguments: {} }], // Missing analyze_competitors
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(responseWithWorkPlan);

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // Should retry because requirements not met
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(20);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'failure',
          passed: false,
          attempt: 20,
        })
      );
    });

    it('should handle work plan completion during scheduled chat', async () => {
      const workPlanIncomplete = {
        title: 'Onboarding Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'pending' as const },
          { stepCount: 2, title: 'Step 2', status: 'pending' as const },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const workPlanComplete = {
        ...workPlanIncomplete,
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Step 2', status: 'completed' as const },
        ],
      };

      let getChatSessionCallCount = 0;
      mockChatbotDb.getChatSession.mockImplementation(() => {
        getChatSessionCallCount++;
        if (getChatSessionCallCount === 1) {
          // First call in generateSessionResponse for attempt 1
          return Promise.resolve({ ...mockSession, workPlan: workPlanIncomplete });
        } else if (getChatSessionCallCount === 2) {
          // Second call for retry message check (attempt 2)
          // Work plan is now complete from previous response
          return Promise.resolve({ ...mockSession, workPlan: workPlanComplete });
        } else {
          return Promise.resolve({ ...mockSession, workPlan: workPlanComplete });
        }
      });

      let responseCallCount = 0;
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(() => {
        responseCallCount++;
        if (responseCallCount === 1) {
          return Promise.resolve({ 
            ...mockResponse, 
            workPlan: workPlanComplete,
            content: 'Step 1 completed',
          });
        } else {
          return Promise.resolve({ 
            ...mockResponse, 
            workPlan: workPlanComplete,
            content: 'Here are some marketing strategy and tips for your business.',
            toolCalls: [
              { name: 'get_marketing_tips', arguments: {} },
              { name: 'analyze_competitors', arguments: {} },
            ],
          });
        }
      });

      await runScheduledChat(baseSchedule, mockUserId, true);

      const calls = mockGenerateMarketingResponseWorkerService.runInWorker.mock.calls;
      // First call uses starting message
      expect(calls[0][0].messageContent).toBe(baseSchedule.startingMessage);
      // Second call should check keywords and function calls (work plan completed)
      expect(calls[1][0].messageContent).toContain('Please try again');
      expect(calls[1][0].messageContent).toContain('marketing');
    });

    it('should handle empty work plan steps array', async () => {
      const workPlan = {
        title: 'Onboarding Plan',
        steps: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const sessionWithWorkPlan = {
        ...mockSession,
        workPlan,
      };

      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithWorkPlan);

      const responseWithWorkPlan = {
        ...mockResponse,
        workPlan,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(responseWithWorkPlan);

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // Empty steps array means work plan is completed (all steps completed)
      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'success',
          passed: true,
        })
      );
    });

    it('should handle work plan with all steps skipped', async () => {
      const workPlan = {
        title: 'Onboarding Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'skipped' as const },
          { stepCount: 2, title: 'Step 2', status: 'skipped' as const },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const sessionWithWorkPlan = {
        ...mockSession,
        workPlan,
      };

      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithWorkPlan);

      const responseWithWorkPlan = {
        ...mockResponse,
        workPlan,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(responseWithWorkPlan);

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // All steps skipped means work plan is completed
      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'success',
          passed: true,
        })
      );
    });
  });
});
