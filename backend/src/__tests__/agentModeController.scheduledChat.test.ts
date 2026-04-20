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
  getAllowedSkills: jest.fn(async () => ['*']),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    updateSessionError: jest.fn(),
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
    installSkills: jest.fn().mockResolvedValue({ success: true, installedSkills: [] }),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
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
    createSchedule: jest.fn(),
    addRunResult: jest.fn(),
    getScheduleById: jest.fn(),
    getSchedulesReadyToRun: jest.fn(),
    updateScheduleAfterRun: jest.fn(),
    updateSchedule: jest.fn(),
    getSchedulesByUserId: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
  },
  taskDb: {
    getTaskExecutionById: jest.fn(),
    createTaskExecution: jest.fn(),
    updateTaskExecution: jest.fn(),
  },
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-run-id-123'),
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendScheduledChatResultEmail: jest.fn(),
    sendDailyDigestEmail: jest.fn(),
    sendScheduledChatVariableRequestEmail: jest.fn(),
    sendScheduledChatErrorEmail: jest.fn(),
  },
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
  },
}));

// Import mocked services
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb, taskDb, userDb } from '../services/db';
import { emailService } from '../services/emailService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { getAllowedFunctionCalls, getAllowedSkills } from '../services/subscriptionService';
import { skillService } from '../services/skillService';
import { agentModeController, runScheduledChat } from '../controllers/agentModeController';

const mockedGetAllowedFunctionCalls = getAllowedFunctionCalls as jest.MockedFunction<typeof getAllowedFunctionCalls>;
const mockedGetAllowedSkills = getAllowedSkills as jest.MockedFunction<typeof getAllowedSkills>;
const mockedSkillService = skillService as jest.Mocked<typeof skillService>;

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockTaskDb = taskDb as jest.Mocked<typeof taskDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockEmailService = emailService as jest.Mocked<typeof emailService>;
const mockGenerateMarketingResponseWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

describe('AgentModeController - Scheduled Chat with 6 Iterations', () => {
  const mockUserId = 'test-user-123';
  const mockScheduleId = 'test-schedule-123';
  
  const baseSchedule = {
    scheduleId: mockScheduleId,
    scheduleName: 'Test Schedule',
    startingMessage: 'Hello, please help me with marketing',
    keywords: ['marketing', 'strategy'],
    requiredFunctionCalls: ['get_marketing_tips', 'analyze_competitors'],
    userId: mockUserId,
    nextRunTime: new Date().toISOString(),
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
    mockAgentModeService.getDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue(mockAgentModeService.default_model);

    // Setup default mocks
    mockChatbotDb.createChatSession.mockResolvedValue(mockSession);
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(mockSession);
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Generated Title');
    // Use worker service instead of direct generateMarketingResponse
    mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(mockResponse);
    mockScheduleDb.addRunResult.mockResolvedValue(undefined);
    mockScheduleDb.getScheduleById.mockResolvedValue(baseSchedule);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([]);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined);
    mockUserDb.getUserById.mockResolvedValue({ userId: mockUserId, email: 'owner@example.com' } as any);
  });

  afterEach(() => {
    // Clean up to prevent memory leaks
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('runScheduledChat function', () => {
    it('should succeed on first attempt when all criteria are met', async () => {
      // Mock successful response with all required keywords and function calls
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
          keywordMisses: [],
          functionCallMatches: ['get_marketing_tips', 'analyze_competitors'],
          functionCallMisses: [],
        })
      );
    });

    it('should retry up to 6 times when criteria are not met', async () => {
      // Mock responses that don't meet criteria
      const incompleteResponse = {
        ...mockResponse,
        content: 'Here are some general business tips.',
        toolCalls: [{ name: 'get_marketing_tips', arguments: {} }], // Missing analyze_competitors
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(incompleteResponse);

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // Should have been called 20 times (maxTries = 20)
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(20);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'failure',
          passed: false,
          attempt: 20, // Last attempt
          keywordMatches: [],
          keywordMisses: ['marketing', 'strategy'],
          functionCallMatches: ['get_marketing_tips'],
          functionCallMisses: ['analyze_competitors'],
        })
      );
    });

    it('should succeed on 4th attempt when criteria are met', async () => {
      let callCount = 0;
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(() => {
        callCount++;
        if (callCount <= 3) {
          // First 3 attempts fail
          return Promise.resolve({
            ...mockResponse,
            content: 'Here are some general business tips.',
            toolCalls: [{ name: 'get_marketing_tips', arguments: {} }],
          });
        } else {
          // 4th attempt succeeds
          return Promise.resolve({
            ...mockResponse,
            content: 'Here are some marketing strategy and tips for your business.',
            toolCalls: [
              { name: 'get_marketing_tips', arguments: {} },
              { name: 'analyze_competitors', arguments: {} },
            ],
          });
        }
      });

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // Should have been called 4 times (stopped after success)
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(4);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'success',
          passed: true,
          attempt: 4,
          keywordMatches: ['marketing', 'strategy'],
          keywordMisses: [],
          functionCallMatches: ['get_marketing_tips', 'analyze_competitors'],
          functionCallMisses: [],
        })
      );
    });

    it('should handle partial success across multiple attempts', async () => {
      let callCount = 0;
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First attempt: only keywords, no function calls
          return Promise.resolve({
            ...mockResponse,
            content: 'Here are some marketing strategies for your business.',
            toolCalls: [],
          });
        } else if (callCount === 2) {
          // Second attempt: only one function call
          return Promise.resolve({
            ...mockResponse,
            content: 'Here are some general business tips.',
            toolCalls: [{ name: 'get_marketing_tips', arguments: {} }],
          });
        } else if (callCount === 3) {
          // Third attempt: gets the missing function call
          return Promise.resolve({
            ...mockResponse,
            content: 'Here are some general business tips.',
            toolCalls: [{ name: 'analyze_competitors', arguments: {} }],
          });
        } else {
          // Subsequent attempts fail
          return Promise.resolve({
            ...mockResponse,
            content: 'Here are some general business tips.',
            toolCalls: [],
          });
        }
      });

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // Should have been called 20 times (all attempts)
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(20);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'failure',
          passed: false,
          attempt: 20,
          keywordMatches: ['marketing'], // Only "marketing" found in "strategies"
          keywordMisses: ['strategy'],
          functionCallMatches: ['get_marketing_tips', 'analyze_competitors'], // Found across attempts
          functionCallMisses: [],
        })
      );
    });

    it('should handle schedule with no keywords or function calls', async () => {
      const simpleSchedule = {
        ...baseSchedule,
        keywords: [],
        requiredFunctionCalls: [],
      };

      const result = await runScheduledChat(simpleSchedule, mockUserId, true);

      // Should succeed immediately since no criteria to meet
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(1);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'success',
          passed: true,
          attempt: 1,
          keywordMatches: [],
          keywordMisses: [],
          functionCallMatches: [],
          functionCallMisses: [],
        })
      );
    });

    it('should handle errors during individual attempts', async () => {
      let callCount = 0;
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          // Second attempt throws an error
          throw new Error('Network error');
        }
        return Promise.resolve({
          ...mockResponse,
          content: 'Here are some general business tips.',
          toolCalls: [],
        });
      });

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // Should have been called 20 times (error on attempt 2, but continued)
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

    it('should handle critical errors that stop execution', async () => {
      mockGenerateMarketingResponseWorkerService.runInWorker.mockRejectedValue(new Error('Critical database error'));

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // After the fix, runScheduledChat returns an error result instead of throwing
      expect(result).toEqual(
        expect.objectContaining({
          status: 'failure',
          passed: false,
          actualResponse: expect.stringContaining('Critical database error'),
        })
      );

      // Should also save error to session and save run result
      expect(mockChatbotDb.updateSessionError).toHaveBeenCalled();
      expect(mockScheduleDb.addRunResult).toHaveBeenCalled();
    });

    it('should create correct session title for test vs production', async () => {
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(mockResponse);

      await runScheduledChat(baseSchedule, mockUserId, true);

      // Should create session with pageIdentifier including scheduleId
      expect(mockChatbotDb.createChatSession).toHaveBeenCalledWith(
        mockUserId,
        undefined,
        'agent',
        `Test: Test Schedule|scheduleId:${mockScheduleId}`,
        undefined,
        undefined,
        undefined,
        undefined,
        'scheduled'
      );
    });

    it('should copy emailCampaignTaskId from schedule to session', async () => {
      const scheduleWithCampaignId = {
        ...baseSchedule,
        emailCampaignTaskId: 'campaign-task-123',
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
      });

      await runScheduledChat(scheduleWithCampaignId, mockUserId, true);

      // Should create session with emailCampaignTaskId from schedule
      expect(mockChatbotDb.createChatSession).toHaveBeenCalledWith(
        mockUserId,
        undefined,
        'agent',
        `Test: Test Schedule|scheduleId:${mockScheduleId}`,
        undefined,
        undefined,
        undefined,
        'campaign-task-123',
        'scheduled'
      );
    });

    it('should handle schedule with null emailCampaignTaskId', async () => {
      const scheduleWithoutCampaignId = {
        ...baseSchedule,
        emailCampaignTaskId: null,
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
      });

      await runScheduledChat(scheduleWithoutCampaignId, mockUserId, true);

      // Should create session with undefined emailCampaignTaskId
      expect(mockChatbotDb.createChatSession).toHaveBeenCalledWith(
        mockUserId,
        undefined,
        'agent',
        `Test: Test Schedule|scheduleId:${mockScheduleId}`,
        undefined,
        undefined,
        undefined,
        null,
        'scheduled'
      );
    });

    it('should save run result to database', async () => {
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(mockResponse);

      await runScheduledChat(baseSchedule, mockUserId, true);

      // Should save result to database
      expect(mockScheduleDb.addRunResult).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          scheduleId: mockScheduleId,
          runId: 'mock-run-id-123',
          status: 'failure', // The test shows it's actually failing
          passed: false,
        })
      );
    });

    it('should not run test scheduled chat when required variable values are missing', async () => {
      const variableSchedule = {
        ...baseSchedule,
        variables: [{ name: 'company_name', description: 'Company name' }],
        variableValues: {}
      };
      mockScheduleDb.getScheduleById.mockResolvedValue(variableSchedule as any);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Missing variable values for scheduled chat',
          missingVariables: ['company_name']
        })
      );
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    });

    it('should send notification email when sendNotificationEmail is true and schedule has email notifications', async () => {
      const scheduleWithEmails = {
        ...baseSchedule,
        emailNotifications: ['user@example.com', 'admin@example.com'],
      };
      mockScheduleDb.getScheduleById.mockResolvedValue(scheduleWithEmails);

      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: { sendNotificationEmail: true },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      // testScheduledChat returns immediately with pending status; wait for background run
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pending' })
      );

      // Wait for background run to complete and email to be sent
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockEmailService.sendScheduledChatResultEmail).toHaveBeenCalledWith(
        ['user@example.com', 'admin@example.com'],
        'Test Schedule',
        expect.objectContaining({ sessionId: 'test-session-123' }),
        mockScheduleId,
        undefined
      );
    });

    it('should not send notification email when sendNotificationEmail is false', async () => {
      const scheduleWithEmails = {
        ...baseSchedule,
        emailNotifications: ['user@example.com'],
      };
      mockScheduleDb.getScheduleById.mockResolvedValue(scheduleWithEmails);

      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: { sendNotificationEmail: false },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      // Wait for background run to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockEmailService.sendScheduledChatResultEmail).not.toHaveBeenCalled();
    });

    it('should not send notification email when sendNotificationEmail is true but no email notifications configured', async () => {
      // baseSchedule has no emailNotifications
      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: { sendNotificationEmail: true },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      // Wait for background run to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockEmailService.sendScheduledChatResultEmail).not.toHaveBeenCalled();
    });

    it('should not send notification email when body is missing', async () => {
      const scheduleWithEmails = {
        ...baseSchedule,
        emailNotifications: ['user@example.com'],
      };
      mockScheduleDb.getScheduleById.mockResolvedValue(scheduleWithEmails);

      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      // Wait for background run to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockEmailService.sendScheduledChatResultEmail).not.toHaveBeenCalled();
    });

    it('should still return success even if notification email fails', async () => {
      const scheduleWithEmails = {
        ...baseSchedule,
        emailNotifications: ['user@example.com'],
      };
      mockScheduleDb.getScheduleById.mockResolvedValue(scheduleWithEmails);

      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);
      mockEmailService.sendScheduledChatResultEmail.mockRejectedValue(new Error('SMTP failure'));

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: { sendNotificationEmail: true },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      // Should return pending status immediately (not an error)
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pending' })
      );
      expect(mockRes.status).not.toHaveBeenCalledWith(500);

      // Wait for background run and email attempt to complete
      await new Promise(resolve => setTimeout(resolve, 100));
    });
  });

  describe('runScheduledChats endpoint', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.clearAllMocks();
      // Reset environment variables
      process.env = { ...originalEnv };
      // Setup default mocks needed for runScheduledChat
      mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
      mockAgentModeService.generateSessionTitle.mockResolvedValue('Generated Title');
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(mockResponse);
      mockChatbotDb.createChatSession.mockResolvedValue(mockSession);
      mockChatbotDb.getChatSession.mockResolvedValue(mockSession);
      mockScheduleDb.addRunResult.mockResolvedValue(undefined);
      mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined);
      mockEmailService.sendScheduledChatResultEmail.mockResolvedValue(undefined);
      mockEmailService.sendDailyDigestEmail.mockResolvedValue(undefined);
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should process multiple scheduled chats with 6 iterations each', async () => {
      // Set concurrent run limit to 2 to allow both schedules to run
      process.env.MAX_CONCURRENT_RUNS = '2';
      
      const schedules = [
        { ...baseSchedule, scheduleId: 'schedule-1', frequency: 'daily' },
        { ...baseSchedule, scheduleId: 'schedule-2', scheduleName: 'Test Schedule 2', frequency: 'daily' },
      ];

      // Mock getSchedulesReadyToRun to return multiple schedules
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue(schedules);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Processed 2 scheduled chats',
          processed: 2,
          results: expect.arrayContaining([
            expect.objectContaining({ scheduleId: 'schedule-1', status: 'started' }),
            expect.objectContaining({ scheduleId: 'schedule-2', status: 'started' }),
          ]),
        })
      );
    });

    it('should handle no scheduled chats ready to run', async () => {
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([]);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith({
        message: 'No scheduled chats ready to run',
        processed: 0,
        results: [],
      });
    });

    it('should request variable values and skip run when required variables are missing', async () => {
      const scheduleWithVariables = {
        ...baseSchedule,
        frequency: 'daily',
        variables: [{ name: 'company_name', description: 'Company name' }],
        variableValues: {},
        emailNotifications: ['notify@example.com'],
      };
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([scheduleWithVariables]);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      const nextRunTime = new Date(response.results[0].nextRunTime).getTime();
      const variableRequestExpiresAt = new Date(response.results[0].variableRequestExpiresAt).getTime();
      expect(response.results[0]).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'waiting_for_variables',
          missingVariables: ['company_name'],
          variableRequestExpiresAt: expect.any(String),
        })
      );
      expect(nextRunTime - variableRequestExpiresAt).toBe(30 * 60 * 1000);
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          variableRequestStatus: 'pending',
        })
      );
      expect(mockEmailService.sendScheduledChatVariableRequestEmail).toHaveBeenCalledWith(
        ['notify@example.com'],
        'Test Schedule',
        mockScheduleId,
        [{ name: 'company_name', description: 'Company name' }],
        expect.any(String),
        expect.any(String)
      );
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    });

    it('should request variable values when values are stale (not provided after latest request)', async () => {
      const scheduleWithStaleValues = {
        ...baseSchedule,
        frequency: 'daily',
        variables: [{ name: 'company_name', description: 'Company name' }],
        variableValues: { company_name: 'Acme Inc' },
        variableRequestStatus: 'provided',
        // Missing variableRequestSentAt/variableValuesUpdatedAt means values are considered stale for auto-run
        emailNotifications: ['notify@example.com'],
      };
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([scheduleWithStaleValues] as any);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(response.results[0]).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'waiting_for_variables',
          missingVariables: ['company_name'],
        })
      );
      expect(mockEmailService.sendScheduledChatVariableRequestEmail).toHaveBeenCalledWith(
        ['notify@example.com'],
        'Test Schedule',
        mockScheduleId,
        [{ name: 'company_name', description: 'Company name' }],
        expect.any(String),
        expect.any(String)
      );
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    });

    it('should request variable values when existing values predate the last run', async () => {
      const scheduleWithOutdatedValues = {
        ...baseSchedule,
        frequency: 'daily',
        variables: [{ name: 'company_name', description: 'Company name' }],
        variableValues: { company_name: 'Acme Inc' },
        variableRequestStatus: 'provided',
        variableRequestSentAt: '2026-01-01T00:00:00.000Z',
        variableValuesUpdatedAt: '2026-01-01T00:10:00.000Z',
        lastRunTime: '2026-01-02T00:00:00.000Z',
        emailNotifications: ['notify@example.com'],
      };
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([scheduleWithOutdatedValues] as any);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(response.results[0]).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'waiting_for_variables',
          missingVariables: ['company_name'],
        })
      );
      expect(mockEmailService.sendScheduledChatVariableRequestEmail).toHaveBeenCalledWith(
        ['notify@example.com'],
        'Test Schedule',
        mockScheduleId,
        [{ name: 'company_name', description: 'Company name' }],
        expect.any(String),
        expect.any(String)
      );
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    });

    it('should default to max 5 concurrent runs when MAX_CONCURRENT_RUNS is not set', async () => {
      delete process.env.MAX_CONCURRENT_RUNS;
      
      const schedules = Array.from({ length: 7 }, (_, i) => ({
        ...baseSchedule,
        scheduleId: `schedule-${i + 1}`,
        scheduleName: `Test Schedule ${i + 1}`,
        frequency: 'daily',
      }));

      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue(schedules);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      const startedCount = response.results.filter((r: any) => r.status === 'started').length;
      const delayedCount = response.results.filter((r: any) => r.status === 'delayed').length;

      expect(startedCount).toBe(5);
      expect(delayedCount).toBe(2);
    });

    it('should use custom MAX_CONCURRENT_RUNS from environment variable', async () => {
      process.env.MAX_CONCURRENT_RUNS = '3';
      
      const schedules = Array.from({ length: 5 }, (_, i) => ({
        ...baseSchedule,
        scheduleId: `schedule-${i + 1}`,
        scheduleName: `Test Schedule ${i + 1}`,
        frequency: 'daily',
      }));

      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue(schedules);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      const startedCount = response.results.filter((r: any) => r.status === 'started').length;
      const delayedCount = response.results.filter((r: any) => r.status === 'delayed').length;

      expect(startedCount).toBe(3);
      expect(delayedCount).toBe(2);
    });

    it('should delay schedules by 30 minutes when limit is reached', async () => {
      process.env.MAX_CONCURRENT_RUNS = '2';
      
      const schedules = Array.from({ length: 4 }, (_, i) => ({
        ...baseSchedule,
        scheduleId: `schedule-${i + 1}`,
        scheduleName: `Test Schedule ${i + 1}`,
        frequency: 'daily',
        lastRunTime: undefined,
      }));

      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue(schedules);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      const beforeTime = new Date();
      await agentModeController.runScheduledChats(mockReq, mockRes);
      const afterTime = new Date();

      // Check that delayed schedules have nextRunTime set to ~30 minutes from now
      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      const delayedResults = response.results.filter((r: any) => r.status === 'delayed');
      
      expect(delayedResults.length).toBe(2);
      
      delayedResults.forEach((result: any) => {
        const delayedTime = new Date(result.nextRunTime);
        const expectedMinTime = new Date(beforeTime.getTime() + 29 * 60 * 1000); // 29 minutes
        const expectedMaxTime = new Date(afterTime.getTime() + 31 * 60 * 1000); // 31 minutes
        
        expect(delayedTime.getTime()).toBeGreaterThanOrEqual(expectedMinTime.getTime());
        expect(delayedTime.getTime()).toBeLessThanOrEqual(expectedMaxTime.getTime());
        expect(result.reason).toContain('Delayed due to concurrent run limit (2)');
      });

      // Verify updateScheduleAfterRun was called with delayed time
      const delayedUpdateCalls = mockScheduleDb.updateScheduleAfterRun.mock.calls.filter((call: any) => {
        const nextRunTime = new Date(call[2]);
        const now = new Date();
        const diffMinutes = (nextRunTime.getTime() - now.getTime()) / (1000 * 60);
        return diffMinutes >= 29 && diffMinutes <= 31;
      });
      expect(delayedUpdateCalls.length).toBe(2);
    });

    it('should handle MAX_CONCURRENT_RUNS=0 correctly', async () => {
      process.env.MAX_CONCURRENT_RUNS = '0';
      
      const schedules = Array.from({ length: 3 }, (_, i) => ({
        ...baseSchedule,
        scheduleId: `schedule-${i + 1}`,
        scheduleName: `Test Schedule ${i + 1}`,
        frequency: 'daily',
      }));

      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue(schedules);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      const startedCount = response.results.filter((r: any) => r.status === 'started').length;
      const delayedCount = response.results.filter((r: any) => r.status === 'delayed').length;

      expect(startedCount).toBe(0);
      expect(delayedCount).toBe(3);
    });

    it('should run all schedules when under the limit', async () => {
      process.env.MAX_CONCURRENT_RUNS = '10';
      
      const schedules = Array.from({ length: 3 }, (_, i) => ({
        ...baseSchedule,
        scheduleId: `schedule-${i + 1}`,
        scheduleName: `Test Schedule ${i + 1}`,
        frequency: 'daily',
      }));

      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue(schedules);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      const startedCount = response.results.filter((r: any) => r.status === 'started').length;
      const delayedCount = response.results.filter((r: any) => r.status === 'delayed').length;

      expect(startedCount).toBe(3);
      expect(delayedCount).toBe(0);
    });
  });

  describe('Email Campaign Sync After Scheduled Chat Run', () => {
    const mockUserId = 'test-user-123';
    const mockScheduleId = 'test-schedule-123';
    
    const baseSchedule = {
      scheduleId: mockScheduleId,
      taskId: 'task-123',
      userId: mockUserId,
      frequency: 'daily',
      nextRunTime: new Date().toISOString(),
      status: 'active',
      createdAt: new Date().toISOString(),
      scheduleName: 'Test Schedule',
      startingMessage: 'Hello',
      emailCampaignTaskId: 'campaign-task-456',
    };

    beforeEach(() => {
      jest.clearAllMocks();
      // Setup default mocks needed for runScheduledChat
      mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
      mockAgentModeService.generateSessionTitle.mockResolvedValue('Generated Title');
      mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(void 0 as any);
      mockChatbotDb.addMessageToSession.mockResolvedValue(void 0 as any);
      mockChatbotDb.addMessagesToSession.mockResolvedValue(void 0 as any);
      mockChatbotDb.updateSessionTitle.mockResolvedValue(void 0 as any);
      mockTaskDb.getTaskExecutionById.mockResolvedValue(null as any);
    });

    it('should sync email campaign execution after scheduled chat run with HTML URLs', async () => {
      const scheduleWithCampaign = { ...baseSchedule };
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([scheduleWithCampaign]);
      
      const sessionWithMessages = {
        sessionId: 'session-123',
        userId: mockUserId,
        messages: [
          { role: 'user' as const, content: 'Hello' },
          { role: 'assistant' as const, content: 'Report: https://agentweb-user-files.s3.us-west-2.amazonaws.com/reports/report1.html' },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        emailCampaignTaskId: 'campaign-task-456',
      } as any;

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: 'Report: https://agentweb-user-files.s3.us-west-2.amazonaws.com/reports/report1.html',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });
      mockChatbotDb.createChatSession.mockResolvedValue({
        sessionId: 'session-123',
        userId: mockUserId,
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        emailCampaignTaskId: 'campaign-task-456',
      });
      // getChatSession returns session with messages (for sync to find HTML URLs)
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithMessages);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      // Wait for async runScheduledChat to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should create execution and sync HTML URLs
      expect(mockTaskDb.createTaskExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: 'agentmode_session-123',
          taskId: 'campaign-task-456',
          userId: mockUserId,
        })
      );
      expect(mockTaskDb.updateTaskExecution).toHaveBeenCalledWith(
        'agentmode_session-123',
        expect.objectContaining({
          result_files: expect.arrayContaining([
            expect.objectContaining({ url: expect.stringContaining('report1.html'), is_html: true })
          ])
        })
      );
      expect(mockTaskDb.updateTaskExecution).toHaveBeenCalledWith(
        'agentmode_session-123',
        expect.objectContaining({ completedAt: expect.any(String) })
      );
    });

    it('should not sync if schedule has no emailCampaignTaskId', async () => {
      const scheduleWithoutCampaign = { ...baseSchedule, emailCampaignTaskId: undefined };
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([scheduleWithoutCampaign]);
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: 'Some content',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });
      mockChatbotDb.createChatSession.mockResolvedValue({
        sessionId: 'session-123',
        userId: mockUserId,
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      // Should not call task execution sync
      expect(mockTaskDb.createTaskExecution).not.toHaveBeenCalled();
      expect(mockTaskDb.updateTaskExecution).not.toHaveBeenCalled();
    });

    it('should update existing execution with new HTML URLs', async () => {
      const scheduleWithCampaign = { ...baseSchedule };
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([scheduleWithCampaign]);
      
      const sessionWithMessages = {
        sessionId: 'session-123',
        userId: mockUserId,
        messages: [
          { role: 'assistant' as const, content: 'Old: https://agentweb-user-files.s3.us-west-2.amazonaws.com/reports/old.html New: https://agentweb-user-files.s3.us-west-2.amazonaws.com/reports/new.html' },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        emailCampaignTaskId: 'campaign-task-456',
      } as any;

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: 'New report: https://agentweb-user-files.s3.us-west-2.amazonaws.com/reports/new.html',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });
      mockChatbotDb.createChatSession.mockResolvedValue({
        sessionId: 'session-123',
        userId: mockUserId,
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        emailCampaignTaskId: 'campaign-task-456',
      });
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithMessages);
      
      mockTaskDb.getTaskExecutionById.mockResolvedValue({
        executionId: 'agentmode_session-123',
        taskId: 'campaign-task-456',
        userId: mockUserId,
        result_files: [
          { url: 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/reports/old.html', filename: 'old.html', token: 't', is_html: true }
        ],
      });

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      // Wait for async runScheduledChat to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should update with new URL, keeping old one
      expect(mockTaskDb.updateTaskExecution).toHaveBeenCalledWith(
        'agentmode_session-123',
        expect.objectContaining({
          result_files: expect.arrayContaining([
            expect.objectContaining({ url: expect.stringContaining('old.html') }),
            expect.objectContaining({ url: expect.stringContaining('new.html'), is_html: true })
          ])
        })
      );
      // Should not create a new execution
      expect(mockTaskDb.createTaskExecution).not.toHaveBeenCalled();
    });

    it('should save failure run result and send error email when runScheduledChat throws', async () => {
      const scheduleWithEmail = {
        ...baseSchedule,
        frequency: 'daily',
        emailNotifications: ['alert@example.com'],
      };
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([scheduleWithEmail]);

      // Make createChatSession reject to simulate a runtime crash in runScheduledChat
      mockChatbotDb.createChatSession.mockRejectedValue(new Error('LLM provider timeout'));

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      // Wait for the fire-and-forget promise (.catch handler) to settle
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should save a failure run result to the database
      // Note: actualResponse is deleted before storing to save space
      expect(mockScheduleDb.addRunResult).toHaveBeenCalledWith(
        scheduleWithEmail.scheduleId,
        expect.objectContaining({
          scheduleId: scheduleWithEmail.scheduleId,
          status: 'failure',
          passed: false,
          sessionId: '',
          attempt: 0,
        })
      );

      // Note: Email is NOT sent when sessionId is empty (session creation failed)
      // This is by design - only send emails when a session actually executed
      expect(mockEmailService.sendScheduledChatResultEmail).not.toHaveBeenCalled();
    });

    it('should handle sync errors gracefully without failing the run', async () => {
      const scheduleWithCampaign = { ...baseSchedule };
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([scheduleWithCampaign]);
      
      const initialSession = {
        sessionId: 'session-123',
        userId: mockUserId,
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        emailCampaignTaskId: 'campaign-task-456',
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: 'Some content',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });
      mockChatbotDb.createChatSession.mockResolvedValue(initialSession);
      
      // getChatSession works during the run, but fails during sync
      let callCount = 0;
      mockChatbotDb.getChatSession.mockImplementation(() => {
        callCount++;
        // During run, return session normally
        if (callCount <= 5) {
          return Promise.resolve(initialSession);
        }
        // During sync, throw error
        throw new Error('Database error');
      });

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      // Should not throw, just log the error
      await expect(agentModeController.runScheduledChats(mockReq, mockRes)).resolves.not.toThrow();
      // The run should still complete successfully
      expect(mockRes.json).toHaveBeenCalled();
    });
  });

  describe('updateScheduledChat endpoint', () => {
    const mockUserId = 'test-user-123';
    const mockScheduleId = 'test-schedule-456';
    const originalNextRunTime = '2025-01-15T09:00:00.000Z';

    const existingSchedule = {
      scheduleId: mockScheduleId,
      taskId: 'task-123',
      userId: mockUserId,
      frequency: 'daily',
      nextRunTime: originalNextRunTime,
      status: 'active',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      scheduleName: 'Original Schedule Name',
      description: 'Original description',
      startingMessage: 'Original starting message',
      keywords: ['original', 'keywords'],
      requiredFunctionCalls: ['original_function'],
      functionCallMinCalls: { original_function: 1 },
      emailNotifications: ['original@example.com'],
      dailyDigest: false,
      emailCampaignTaskId: 'original-campaign-123',
      type: 'scheduled_chat',
    };

    beforeEach(() => {
      jest.clearAllMocks();
      mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule);
      mockScheduleDb.updateSchedule.mockResolvedValue(undefined);
    });

    it('should update schedule without modifying nextRunTime', async () => {
      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          scheduleName: 'Updated Schedule Name',
          description: 'Updated description',
          startingMessage: 'Updated starting message',
          scheduleFrequency: 'daily',
          keywords: ['updated', 'keywords'],
          requiredFunctionCalls: ['updated_function'],
          functionCallMinCalls: { updated_function: 2 },
          emailNotifications: ['updated@example.com'],
          dailyDigest: false,
          emailCampaignTaskId: 'updated-campaign-456',
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      // Verify updateSchedule was called with the right parameters
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          scheduleName: 'Updated Schedule Name',
          description: 'Updated description',
          startingMessage: 'Updated starting message',
          frequency: 'daily',
          keywords: ['updated', 'keywords'],
          requiredFunctionCalls: ['updated_function'],
          functionCallMinCalls: { updated_function: 2 },
          emailNotifications: ['updated@example.com'],
          dailyDigest: false,
          emailCampaignTaskId: 'updated-campaign-456',
          updatedAt: expect.any(String),
        })
      );

      // Verify nextRunTime was NOT included in the update
      const updateCall = mockScheduleDb.updateSchedule.mock.calls[0][1];
      expect(updateCall).not.toHaveProperty('nextRunTime');

      // Verify response returns the original nextRunTime
      expect(mockRes.json).toHaveBeenCalledWith({
        message: 'Scheduled chat updated successfully',
        nextRunTime: originalNextRunTime,
      });
    });

    it('should preserve nextRunTime even when changing frequency', async () => {
      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          scheduleName: 'Updated Schedule Name',
          description: 'Updated description',
          startingMessage: 'Updated starting message',
          scheduleFrequency: 'weekly', // Changed from daily to weekly
          keywords: ['updated', 'keywords'],
          requiredFunctionCalls: ['updated_function'],
          functionCallMinCalls: { updated_function: 1 },
          emailNotifications: ['updated@example.com'],
          dailyDigest: false,
          emailCampaignTaskId: null,
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      // Verify the frequency was updated
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          frequency: 'weekly',
        })
      );

      // Verify nextRunTime was NOT updated
      const updateCall = mockScheduleDb.updateSchedule.mock.calls[0][1];
      expect(updateCall).not.toHaveProperty('nextRunTime');

      // Verify response returns the original nextRunTime
      expect(mockRes.json).toHaveBeenCalledWith({
        message: 'Scheduled chat updated successfully',
        nextRunTime: originalNextRunTime,
      });
    });

    it('should return 404 if schedule does not exist', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(undefined);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: 'non-existent-schedule' },
        body: {
          scheduleName: 'Test',
          startingMessage: 'Test',
          scheduleFrequency: 'daily',
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Scheduled chat not found' });
    });

    it('should return 404 if schedule belongs to different user', async () => {
      const differentUserSchedule = {
        ...existingSchedule,
        userId: 'different-user-id',
      };
      mockScheduleDb.getScheduleById.mockResolvedValue(differentUserSchedule);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          scheduleName: 'Test',
          startingMessage: 'Test',
          scheduleFrequency: 'daily',
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Scheduled chat not found' });
    });

    it('should support partial updates by merging with existing schedule values', async () => {
      // Only send description — scheduleName, startingMessage, scheduleFrequency should come from existing
      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          description: 'Only updating the description',
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      // Should succeed (not 400)
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Scheduled chat updated successfully',
      }));

      // Verify existing values were preserved
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          scheduleName: existingSchedule.scheduleName,
          startingMessage: existingSchedule.startingMessage,
          frequency: existingSchedule.frequency,
          description: 'Only updating the description',
          keywords: existingSchedule.keywords,
          requiredFunctionCalls: existingSchedule.requiredFunctionCalls,
          functionCallMinCalls: existingSchedule.functionCallMinCalls,
          emailNotifications: existingSchedule.emailNotifications,
        })
      );
    });

    it('should allow updating just the starting message without other required fields', async () => {
      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          startingMessage: 'New starting message with a note about the redirect being fine',
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Scheduled chat updated successfully',
      }));

      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          scheduleName: existingSchedule.scheduleName,
          startingMessage: 'New starting message with a note about the redirect being fine',
          frequency: existingSchedule.frequency,
        })
      );
    });

    it('should handle dailyDigest setting correctly for hourly schedules', async () => {
      const hourlySchedule = {
        ...existingSchedule,
        frequency: 'hourly',
      };
      mockScheduleDb.getScheduleById.mockResolvedValue(hourlySchedule);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          scheduleName: 'Updated Hourly Schedule',
          description: 'Updated description',
          startingMessage: 'Updated starting message',
          scheduleFrequency: 'hourly',
          keywords: [],
          requiredFunctionCalls: [],
          functionCallMinCalls: {},
          emailNotifications: ['test@example.com'],
          dailyDigest: true, // Should be allowed for hourly
          emailCampaignTaskId: null,
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          frequency: 'hourly',
          dailyDigest: true,
        })
      );
    });

    it('should force dailyDigest to false for non-hourly schedules', async () => {
      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          scheduleName: 'Updated Daily Schedule',
          description: 'Updated description',
          startingMessage: 'Updated starting message',
          scheduleFrequency: 'daily',
          keywords: [],
          requiredFunctionCalls: [],
          functionCallMinCalls: {},
          emailNotifications: ['test@example.com'],
          dailyDigest: true, // Should be ignored for daily
          emailCampaignTaskId: null,
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          frequency: 'daily',
          dailyDigest: false, // Should be forced to false
        })
      );
    });
  });

  describe('submitScheduledChatVariables endpoint', () => {
    const scheduleId = 'schedule-with-vars';
    const userId = 'test-user-123';

    it('should save values and trigger immediate run when all variables are provided', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue({
        scheduleId,
        userId,
        status: 'active',
        scheduleName: 'Vars Schedule',
        startingMessage: 'Run for {{company_name}} in {{target_market}}',
        variables: [{ name: 'company_name' }, { name: 'target_market' }],
        emailNotifications: [],
      } as any);

      const mockReq = {
        user: { userId },
        params: { scheduleId },
        body: {
          variableValues: {
            company_name: 'Acme Inc',
            target_market: 'SMB',
          },
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.submitScheduledChatVariables(mockReq, mockRes);

      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        scheduleId,
        expect.objectContaining({
          variableValues: {
            company_name: 'Acme Inc',
            target_market: 'SMB',
          },
          variableRequestStatus: 'provided',
        })
      );
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          missingVariables: [],
        })
      );
    });

    it('should save values without forcing immediate run when triggerRun is false', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue({
        scheduleId,
        userId,
        status: 'active',
        variables: [{ name: 'company_name' }],
      } as any);

      const mockReq = {
        user: { userId },
        params: { scheduleId },
        body: {
          triggerRun: false,
          variableValues: {
            company_name: 'Acme Inc',
          },
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.submitScheduledChatVariables(mockReq, mockRes);

      const payload = mockScheduleDb.updateSchedule.mock.calls[mockScheduleDb.updateSchedule.mock.calls.length - 1][1];
      expect(payload).not.toHaveProperty('nextRunTime');
    });
  });

  describe('Run Count Feature', () => {
    // Mock the scheduleDb.createSchedule to capture the schedule object
    const mockCreateSchedule = jest.fn();

    beforeEach(() => {
      // Add mock for createSchedule
      mockScheduleDb.createSchedule = mockCreateSchedule;
      mockCreateSchedule.mockClear();
    });

    describe('createScheduledChat', () => {
      it('should create schedule with default unlimited runCount when not provided', async () => {
        const mockReq = {
          user: { userId: mockUserId },
          body: {
            scheduleName: 'Test Schedule',
            startingMessage: 'Test message',
            scheduleFrequency: 'daily',
            keywords: [],
            requiredFunctionCalls: [],
            functionCallMinCalls: {},
            emailNotifications: ['test@example.com'],
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.createScheduledChat(mockReq, mockRes);

        expect(mockCreateSchedule).toHaveBeenCalledWith(
          expect.objectContaining({
            runCount: -1, // Should default to unlimited
          })
        );
      });

      it('should create schedule with specified limited runCount', async () => {
        const mockReq = {
          user: { userId: mockUserId },
          body: {
            scheduleName: 'Test Schedule',
            startingMessage: 'Test message',
            scheduleFrequency: 'daily',
            keywords: [],
            requiredFunctionCalls: [],
            functionCallMinCalls: {},
            emailNotifications: ['test@example.com'],
            runCount: 5,
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.createScheduledChat(mockReq, mockRes);

        expect(mockCreateSchedule).toHaveBeenCalledWith(
          expect.objectContaining({
            runCount: 5,
          })
        );
      });

      it('should reject invalid runCount values', async () => {
        const testCases = [
          { runCount: 0, errorMsg: 'runCount must be -1 (unlimited) or a positive integer' },
          { runCount: -5, errorMsg: 'runCount must be -1 (unlimited) or a positive integer' },
          { runCount: 1.5, errorMsg: 'runCount must be -1 (unlimited) or a positive integer' },
        ];

        for (const testCase of testCases) {
          const mockReq = {
            user: { userId: mockUserId },
            body: {
              scheduleName: 'Test Schedule',
              startingMessage: 'Test message',
              scheduleFrequency: 'daily',
              runCount: testCase.runCount,
            },
          } as unknown as Request;

          const mockRes = {
            json: jest.fn(),
            status: jest.fn().mockReturnThis(),
          } as unknown as Response;

          await agentModeController.createScheduledChat(mockReq, mockRes);

          expect(mockRes.status).toHaveBeenCalledWith(400);
          expect(mockRes.json).toHaveBeenCalledWith(
            expect.objectContaining({
              error: testCase.errorMsg,
            })
          );
        }
      });

      it('should create schedule with every_n_days frequency and frequencyIntervalDays', async () => {
        const mockReq = {
          user: { userId: mockUserId },
          body: {
            scheduleName: 'Every 3 Days Schedule',
            startingMessage: 'Test message',
            scheduleFrequency: 'every_n_days',
            frequencyIntervalDays: 3,
            keywords: [],
            requiredFunctionCalls: [],
            functionCallMinCalls: {},
            emailNotifications: ['test@example.com'],
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.createScheduledChat(mockReq, mockRes);

        expect(mockCreateSchedule).toHaveBeenCalledWith(
          expect.objectContaining({
            frequency: 'every_n_days',
            frequencyIntervalDays: 3,
          })
        );
      });

      it('should reject every_n_days without frequencyIntervalDays', async () => {
        const mockReq = {
          user: { userId: mockUserId },
          body: {
            scheduleName: 'Bad Schedule',
            startingMessage: 'Test message',
            scheduleFrequency: 'every_n_days',
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.createScheduledChat(mockReq, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith(
          expect.objectContaining({
            error: 'frequencyIntervalDays must be a positive integer when frequency is every_n_days',
          })
        );
      });

      it('should reject every_n_days with invalid frequencyIntervalDays', async () => {
        const testCases = [
          { frequencyIntervalDays: 0 },
          { frequencyIntervalDays: -1 },
          { frequencyIntervalDays: 1.5 },
        ];

        for (const testCase of testCases) {
          const mockReq = {
            user: { userId: mockUserId },
            body: {
              scheduleName: 'Bad Schedule',
              startingMessage: 'Test message',
              scheduleFrequency: 'every_n_days',
              frequencyIntervalDays: testCase.frequencyIntervalDays,
            },
          } as unknown as Request;

          const mockRes = {
            json: jest.fn(),
            status: jest.fn().mockReturnThis(),
          } as unknown as Response;

          await agentModeController.createScheduledChat(mockReq, mockRes);

          expect(mockRes.status).toHaveBeenCalledWith(400);
          expect(mockRes.json).toHaveBeenCalledWith(
            expect.objectContaining({
              error: 'frequencyIntervalDays must be a positive integer when frequency is every_n_days',
            })
          );
        }
      });

      it('should not include frequencyIntervalDays for non-every_n_days frequency', async () => {
        const mockReq = {
          user: { userId: mockUserId },
          body: {
            scheduleName: 'Daily Schedule',
            startingMessage: 'Test message',
            scheduleFrequency: 'daily',
            frequencyIntervalDays: 5, // Should be ignored
            keywords: [],
            requiredFunctionCalls: [],
            functionCallMinCalls: {},
            emailNotifications: ['test@example.com'],
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.createScheduledChat(mockReq, mockRes);

        expect(mockCreateSchedule).toHaveBeenCalledWith(
          expect.not.objectContaining({
            frequencyIntervalDays: expect.anything(),
          })
        );
      });

      it('should parse variables from startingMessage and keep provided descriptions', async () => {
        const mockReq = {
          user: { userId: mockUserId },
          body: {
            scheduleName: 'Variable Schedule',
            startingMessage: 'Summarize {{company_name}} for {{target_market}}',
            emailNotifications: ['notify@example.com'],
            scheduleFrequency: 'daily',
            variables: [
              { name: 'company_name', description: 'Company legal name' },
              { name: 'target_market', description: 'Primary market segment' },
            ],
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.createScheduledChat(mockReq, mockRes);

        expect(mockCreateSchedule).toHaveBeenCalledWith(
          expect.objectContaining({
            variables: [
              { name: 'company_name', description: 'Company legal name' },
              { name: 'target_market', description: 'Primary market segment' },
            ],
            variableRequestStatus: 'pending',
          })
        );
      });

      it('should default to user email when creating variable schedule without email notifications', async () => {
        const mockReq = {
          user: { userId: mockUserId, email: 'owner@example.com' },
          body: {
            scheduleName: 'Variable Schedule',
            startingMessage: 'Summarize {{company_name}}',
            scheduleFrequency: 'daily',
            emailNotifications: [],
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.createScheduledChat(mockReq, mockRes);

        // No longer rejects — falls back to user's own email
        expect(mockRes.status).not.toHaveBeenCalledWith(400);
        expect(mockCreateSchedule).toHaveBeenCalledWith(
          expect.objectContaining({
            emailNotifications: ['owner@example.com'],
          })
        );
      });
    });

    describe('updateScheduledChat', () => {
      it('should update schedule with new runCount', async () => {
        const mockReq = {
          user: { userId: mockUserId },
          params: { scheduleId: mockScheduleId },
          body: {
            scheduleName: 'Updated Schedule',
            startingMessage: 'Updated message',
            scheduleFrequency: 'daily',
            keywords: [],
            requiredFunctionCalls: [],
            functionCallMinCalls: {},
            emailNotifications: ['test@example.com'],
            runCount: 10,
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.updateScheduledChat(mockReq, mockRes);

        expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
          mockScheduleId,
          expect.objectContaining({
            runCount: 10,
          })
        );
      });

      it('should update schedule to unlimited runCount', async () => {
        const mockReq = {
          user: { userId: mockUserId },
          params: { scheduleId: mockScheduleId },
          body: {
            scheduleName: 'Updated Schedule',
            startingMessage: 'Updated message',
            scheduleFrequency: 'daily',
            keywords: [],
            requiredFunctionCalls: [],
            functionCallMinCalls: {},
            emailNotifications: ['test@example.com'],
            runCount: -1,
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.updateScheduledChat(mockReq, mockRes);

        expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
          mockScheduleId,
          expect.objectContaining({
            runCount: -1,
          })
        );
      });

      it('should reject invalid runCount values in update', async () => {
        const mockReq = {
          user: { userId: mockUserId },
          params: { scheduleId: mockScheduleId },
          body: {
            scheduleName: 'Updated Schedule',
            startingMessage: 'Updated message',
            scheduleFrequency: 'daily',
            runCount: 0, // Invalid
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.updateScheduledChat(mockReq, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith(
          expect.objectContaining({
            error: 'runCount must be -1 (unlimited) or a positive integer',
          })
        );
      });

      it('should reject updating schedule without email notifications (no variables)', async () => {
        mockScheduleDb.getScheduleById.mockResolvedValue({
          scheduleId: mockScheduleId,
          userId: mockUserId,
          status: 'active',
          nextRunTime: '2025-01-15T09:00:00.000Z',
          emailNotifications: [],
        } as any);

        const mockReq = {
          user: { userId: mockUserId },
          params: { scheduleId: mockScheduleId },
          body: {
            scheduleName: 'Updated Schedule',
            startingMessage: 'Give me a marketing summary',
            scheduleFrequency: 'daily',
            emailNotifications: [],
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.updateScheduledChat(mockReq, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith({
          error: 'At least one email notification is required for scheduled chats'
        });
      });

      it('should reject updating schedule without email notifications (with variables)', async () => {
        mockScheduleDb.getScheduleById.mockResolvedValue({
          scheduleId: mockScheduleId,
          userId: mockUserId,
          status: 'active',
          nextRunTime: '2025-01-15T09:00:00.000Z',
          emailNotifications: [],
        } as any);

        const mockReq = {
          user: { userId: mockUserId },
          params: { scheduleId: mockScheduleId },
          body: {
            scheduleName: 'Updated Schedule',
            startingMessage: 'Analyze {{company_name}}',
            scheduleFrequency: 'daily',
            emailNotifications: [],
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.updateScheduledChat(mockReq, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith({
          error: 'At least one email notification is required for scheduled chats'
        });
      });
    });
  });

  describe('getScheduledChats - Sorting', () => {
    // Mock getSchedulesByUserId to return schedules
    beforeEach(() => {
      mockScheduleDb.getSchedulesByUserId = jest.fn();
    });

    it('should sort scheduled chats by createdAt descending (newest first)', async () => {
      const oldSchedule = {
        scheduleId: 'old-schedule',
        scheduleName: 'Old Schedule',
        userId: mockUserId,
        type: 'scheduled_chat',
        createdAt: '2026-01-01T10:00:00.000Z',
        status: 'active',
        frequency: 'daily',
        nextRunTime: '2026-01-28T10:00:00.000Z',
      };

      const newSchedule = {
        scheduleId: 'new-schedule',
        scheduleName: 'New Schedule',
        userId: mockUserId,
        type: 'scheduled_chat',
        createdAt: '2026-01-26T10:00:00.000Z',
        status: 'active',
        frequency: 'daily',
        nextRunTime: '2026-01-28T10:00:00.000Z',
      };

      const middleSchedule = {
        scheduleId: 'middle-schedule',
        scheduleName: 'Middle Schedule',
        userId: mockUserId,
        type: 'scheduled_chat',
        createdAt: '2026-01-15T10:00:00.000Z',
        status: 'active',
        frequency: 'daily',
        nextRunTime: '2026-01-28T10:00:00.000Z',
      };

      // Return schedules in random order
      mockScheduleDb.getSchedulesByUserId.mockResolvedValue([
        middleSchedule,
        oldSchedule,
        newSchedule,
      ]);

      const mockReq = {
        user: { userId: mockUserId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.getScheduledChats(mockReq, mockRes);

      // Verify the response is sorted by createdAt descending
      expect(mockRes.json).toHaveBeenCalledWith([
        newSchedule,    // 2026-01-26 (newest)
        middleSchedule, // 2026-01-15
        oldSchedule,    // 2026-01-01 (oldest)
      ]);
    });

    it('should handle schedules without createdAt field', async () => {
      const scheduleWithCreatedAt = {
        scheduleId: 'schedule-1',
        scheduleName: 'Schedule 1',
        userId: mockUserId,
        type: 'scheduled_chat',
        createdAt: '2026-01-26T10:00:00.000Z',
        status: 'active',
        frequency: 'daily',
        nextRunTime: '2026-01-28T10:00:00.000Z',
      };

      const scheduleWithoutCreatedAt = {
        scheduleId: 'schedule-2',
        scheduleName: 'Schedule 2',
        userId: mockUserId,
        type: 'scheduled_chat',
        // No createdAt field
        status: 'active',
        frequency: 'daily',
        nextRunTime: '2026-01-28T10:00:00.000Z',
      };

      mockScheduleDb.getSchedulesByUserId.mockResolvedValue([
        scheduleWithoutCreatedAt,
        scheduleWithCreatedAt,
      ]);

      const mockReq = {
        user: { userId: mockUserId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.getScheduledChats(mockReq, mockRes);

      // Schedule with createdAt should come first (newest)
      // Schedule without createdAt should be treated as epoch 0 (oldest)
      expect(mockRes.json).toHaveBeenCalledWith([
        scheduleWithCreatedAt,
        scheduleWithoutCreatedAt,
      ]);
    });

    it('should filter out non-scheduled_chat types before sorting', async () => {
      const scheduledChat = {
        scheduleId: 'scheduled-chat',
        scheduleName: 'Scheduled Chat',
        userId: mockUserId,
        type: 'scheduled_chat',
        createdAt: '2026-01-26T10:00:00.000Z',
        status: 'active',
        frequency: 'daily',
        nextRunTime: '2026-01-28T10:00:00.000Z',
      };

      const taskSchedule = {
        scheduleId: 'task-schedule',
        scheduleName: 'Task Schedule',
        userId: mockUserId,
        type: 'task',
        createdAt: '2026-01-27T10:00:00.000Z', // Newer but wrong type
        status: 'active',
        frequency: 'daily',
        nextRunTime: '2026-01-28T10:00:00.000Z',
      };

      mockScheduleDb.getSchedulesByUserId.mockResolvedValue([
        taskSchedule,
        scheduledChat,
      ]);

      const mockReq = {
        user: { userId: mockUserId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.getScheduledChats(mockReq, mockRes);

      // Should only return scheduled_chat type
      expect(mockRes.json).toHaveBeenCalledWith([scheduledChat]);
    });
  });

  describe('subscription wildcard handling', () => {
    const makeReqRes = () => {
      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
      } as unknown as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;
      return { mockReq, mockRes };
    };

    it('should allow scheduled chat to run when subscription returns wildcard ["*"]', async () => {
      // Override the mock to return wildcard
      mockedGetAllowedFunctionCalls.mockResolvedValueOnce(['*']);

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

      // Should NOT send error email — wildcard means all tools are allowed
      expect(mockEmailService.sendScheduledChatErrorEmail).not.toHaveBeenCalled();

      // Should have run successfully (worker was called)
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalled();

      // Response should indicate success, not subscription failure
      expect(result).toEqual(
        expect.objectContaining({
          status: 'success',
        })
      );
    });

    it('should block scheduled chat and send error email when required tools are disallowed', async () => {
      // Override the mock to return a restricted set missing 'analyze_competitors'
      mockedGetAllowedFunctionCalls.mockResolvedValueOnce(['get_marketing_tips', 'create_work_plan']);

      // Use a schedule with email notifications
      const scheduleWithEmails = {
        ...baseSchedule,
        requiredFunctionCalls: ['get_marketing_tips', 'analyze_competitors'],
        emailNotifications: ['test@example.com'],
      };

      await runScheduledChat(scheduleWithEmails, mockUserId, true);

      // Should send error email because analyze_competitors is not allowed
      expect(mockEmailService.sendScheduledChatErrorEmail).toHaveBeenCalledWith(
        ['test@example.com'],
        baseSchedule.scheduleName,
        ['analyze_competitors'],
        baseSchedule.scheduleId
      );

      // Should not have called the worker
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).not.toHaveBeenCalled();
    });

    it('should block scheduled chat when subscription returns empty array', async () => {
      mockedGetAllowedFunctionCalls.mockResolvedValueOnce([]);

      await runScheduledChat(baseSchedule, mockUserId, true);

      expect(mockEmailService.sendScheduledChatErrorEmail).toHaveBeenCalled();
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).not.toHaveBeenCalled();
    });
  });

  describe('auto-install skills for required functions', () => {
    it('should auto-install skills that contain required function calls', async () => {
      const publishedSkills = [
        { skillId: 'marketing-skill', name: 'Marketing', toolNames: ['get_marketing_tips', 'read_brand_guidelines'] },
        { skillId: 'research-skill', name: 'Research', toolNames: ['analyze_competitors', 'search_web'] },
        { skillId: 'unrelated-skill', name: 'Unrelated', toolNames: ['generate_image'] },
      ];
      mockedSkillService.getPublishedSkills.mockResolvedValue(publishedSkills as any);
      mockedGetAllowedSkills.mockResolvedValue(['*']);

      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      await runScheduledChat(baseSchedule, mockUserId, true);

      // Should install only skills containing required tools
      expect(mockAgentModeService.installSkills).toHaveBeenCalledWith(
        expect.arrayContaining(['marketing-skill', 'research-skill']),
        mockUserId,
        'test-session-123'
      );
      // Should not install unrelated skill
      const installedIds = (mockAgentModeService.installSkills as jest.Mock).mock.calls[0][0];
      expect(installedIds).not.toContain('unrelated-skill');
    });

    it('should only install subscription-allowed skills', async () => {
      const publishedSkills = [
        { skillId: 'marketing-skill', name: 'Marketing', toolNames: ['get_marketing_tips'] },
        { skillId: 'research-skill', name: 'Research', toolNames: ['analyze_competitors'] },
      ];
      mockedSkillService.getPublishedSkills.mockResolvedValue(publishedSkills as any);
      // Only marketing-skill is allowed
      mockedGetAllowedSkills.mockResolvedValue(['marketing-skill']);

      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      await runScheduledChat(baseSchedule, mockUserId, true);

      // Should only install the allowed skill
      const installedIds = (mockAgentModeService.installSkills as jest.Mock).mock.calls[0][0];
      expect(installedIds).toContain('marketing-skill');
      expect(installedIds).not.toContain('research-skill');
    });

    it('should not call installSkills when no required functions are specified', async () => {
      const scheduleNoFunctions = {
        ...baseSchedule,
        requiredFunctionCalls: [],
        keywords: [],
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        ...mockResponse,
        content: 'Some response',
        toolCalls: [],
      });

      await runScheduledChat(scheduleNoFunctions, mockUserId, true);

      expect(mockAgentModeService.installSkills).not.toHaveBeenCalled();
    });

    it('should install __other_skills__ when required tools are not in any published skill', async () => {
      const publishedSkills = [
        { skillId: 'marketing-skill', name: 'Marketing', toolNames: ['get_marketing_tips'] },
      ];
      mockedSkillService.getPublishedSkills.mockResolvedValue(publishedSkills as any);
      mockedGetAllowedSkills.mockResolvedValue(['*']);

      // analyze_competitors is not in any published skill
      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      await runScheduledChat(baseSchedule, mockUserId, true);

      const installedIds = (mockAgentModeService.installSkills as jest.Mock).mock.calls[0][0];
      expect(installedIds).toContain('marketing-skill');
      expect(installedIds).toContain('__other_skills__');
    });

    it('should handle auto-install errors gracefully and still run the chat', async () => {
      mockedSkillService.getPublishedSkills.mockRejectedValue(new Error('Skill service down'));

      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      await runScheduledChat(baseSchedule, mockUserId, true);

      // Should still run the chat despite auto-install failure
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalled();
    });
  });

  describe('decrement bug fix - function call counts accumulate across attempts', () => {
    it('should accumulate function call counts across attempts and succeed when all are met', async () => {
      let callCount = 0;
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First attempt: only get_marketing_tips, missing analyze_competitors
          return Promise.resolve({
            ...mockResponse,
            content: 'Here are some general tips.',
            toolCalls: [{ name: 'get_marketing_tips', arguments: {} }],
          });
        } else {
          // Second attempt: calls analyze_competitors
          return Promise.resolve({
            ...mockResponse,
            content: 'Here are some marketing strategy and competitor analysis.',
            toolCalls: [{ name: 'analyze_competitors', arguments: {} }],
          });
        }
      });

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // Should succeed on second attempt since both functions were called across attempts
      expect(result).toEqual(
        expect.objectContaining({
          status: 'success',
          passed: true,
          functionCallMatches: expect.arrayContaining(['get_marketing_tips', 'analyze_competitors']),
          functionCallMisses: [],
        })
      );
      // Should have needed exactly 2 attempts
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(2);
    });
  });

  describe('createScheduledChat - email normalization for variables', () => {
    const mockCreateSchedule = jest.fn();

    beforeEach(() => {
      mockScheduleDb.createSchedule = mockCreateSchedule;
      mockCreateSchedule.mockClear();
    });

    it('should default to user email when variables present but no emailNotifications provided', async () => {
      const mockReq = {
        user: { userId: mockUserId, email: 'owner@example.com' },
        body: {
          scheduleName: 'SEO Scan',
          startingMessage: 'Scan {{website}} for SEO issues',
          scheduleFrequency: 'weekly',
          // No emailNotifications provided
        },
      } as unknown as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.createScheduledChat(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockCreateSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          emailNotifications: ['owner@example.com'],
        })
      );
    });

    it('should normalize emailNotifications string to array when variables present', async () => {
      const mockReq = {
        user: { userId: mockUserId, email: 'owner@example.com' },
        body: {
          scheduleName: 'SEO Scan',
          startingMessage: 'Scan {{website}} for SEO issues',
          scheduleFrequency: 'weekly',
          emailNotifications: 'user@rankai.ai', // string, not array
        },
      } as unknown as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.createScheduledChat(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockCreateSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          emailNotifications: ['user@rankai.ai'],
        })
      );
    });

    it('should not require email when all variable values are pre-filled', async () => {
      const mockReq = {
        user: { userId: mockUserId, email: 'owner@example.com' },
        body: {
          scheduleName: 'SEO Scan',
          startingMessage: 'Scan {{website}} for SEO issues',
          scheduleFrequency: 'weekly',
          variableValues: { website: 'rankai.ai' },
          // No emailNotifications
        },
      } as unknown as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.createScheduledChat(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockCreateSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          emailNotifications: [], // pre-filled vars → no email needed
          variableValues: { website: 'rankai.ai' },
        })
      );
    });

    it('should default to user email when no variables and no emailNotifications provided', async () => {
      const mockReq = {
        user: { userId: mockUserId, email: 'owner@example.com' },
        body: {
          scheduleName: 'Website Scan',
          startingMessage: 'Scan https://example.com for issues',
          scheduleFrequency: 'weekly',
          // No variables, no emailNotifications
        },
      } as unknown as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.createScheduledChat(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockCreateSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          emailNotifications: ['owner@example.com'],
        })
      );
    });

    it('should default to user email when no variables and explicit empty emailNotifications provided', async () => {
      const mockReq = {
        user: { userId: mockUserId, email: 'owner@example.com' },
        body: {
          scheduleName: 'Website Scan',
          startingMessage: 'Scan https://example.com for issues',
          scheduleFrequency: 'daily',
          emailNotifications: [], // explicitly empty
        },
      } as unknown as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.createScheduledChat(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockCreateSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          emailNotifications: ['owner@example.com'],
        })
      );
    });

    it('should use admin email as fallback on delegate access', async () => {
      const mockReq = {
        user: { userId: 'customer-456', email: 'customer@example.com' },
        delegateInfo: {
          adminUserId: mockUserId,
          adminEmail: 'admin@example.com',
          isDelegated: true,
        },
        body: {
          scheduleName: 'Website Scan',
          startingMessage: 'Scan https://example.com for issues',
          scheduleFrequency: 'weekly',
          // No emailNotifications
        },
      } as unknown as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.createScheduledChat(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockCreateSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          emailNotifications: ['admin@example.com'],
        })
      );
    });
  });
});
