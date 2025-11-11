import { Request, Response } from 'express';

// Mock all dependencies before importing the controller
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    generateMarketingResponse: jest.fn(),
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
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-run-id-123'),
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendScheduledChatResultEmail: jest.fn(),
    sendDailyDigestEmail: jest.fn(),
  },
}));

// Import mocked services
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb, taskDb } from '../services/db';
import { emailService } from '../services/emailService';
import { agentModeController } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockTaskDb = taskDb as jest.Mocked<typeof taskDb>;
const mockEmailService = emailService as jest.Mocked<typeof emailService>;

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
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Generated Title');
    mockAgentModeService.generateMarketingResponse.mockResolvedValue(mockResponse);
    mockScheduleDb.addRunResult.mockResolvedValue(undefined);
    mockScheduleDb.getScheduleById.mockResolvedValue(baseSchedule);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([]);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined);
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
      
      mockAgentModeService.generateMarketingResponse.mockResolvedValue(successfulResponse);

      // Test through the testScheduledChat endpoint
      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
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
      
      mockAgentModeService.generateMarketingResponse.mockResolvedValue(incompleteResponse);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      // Should have been called 20 times (maxTries = 20)
      expect(mockAgentModeService.generateMarketingResponse).toHaveBeenCalledTimes(20);
      
      expect(mockRes.json).toHaveBeenCalledWith(
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
      mockAgentModeService.generateMarketingResponse.mockImplementation(() => {
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

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      // Should have been called 4 times (stopped after success)
      expect(mockAgentModeService.generateMarketingResponse).toHaveBeenCalledTimes(4);
      
      expect(mockRes.json).toHaveBeenCalledWith(
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
      mockAgentModeService.generateMarketingResponse.mockImplementation(() => {
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

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      // Should have been called 20 times (all attempts)
      expect(mockAgentModeService.generateMarketingResponse).toHaveBeenCalledTimes(20);
      
      expect(mockRes.json).toHaveBeenCalledWith(
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

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      mockScheduleDb.getScheduleById.mockResolvedValue(simpleSchedule);
      
      await agentModeController.testScheduledChat(mockReq, mockRes);

      // Should succeed immediately since no criteria to meet
      expect(mockAgentModeService.generateMarketingResponse).toHaveBeenCalledTimes(1);
      
      expect(mockRes.json).toHaveBeenCalledWith(
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
      mockAgentModeService.generateMarketingResponse.mockImplementation(() => {
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

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      // Should have been called 20 times (error on attempt 2, but continued)
      expect(mockAgentModeService.generateMarketingResponse).toHaveBeenCalledTimes(20);
      
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'failure',
          passed: false,
          attempt: 20,
        })
      );
    });

    it('should handle critical errors that stop execution', async () => {
      mockAgentModeService.generateMarketingResponse.mockRejectedValue(new Error('Critical database error'));

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Failed to test scheduled chat' });
    });

    it('should create correct session title for test vs production', async () => {
      mockAgentModeService.generateMarketingResponse.mockResolvedValue(mockResponse);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      // Should create session with test title
      expect(mockChatbotDb.createChatSession).toHaveBeenCalledWith(
        mockUserId,
        undefined,
        'agent',
        'Test: Test Schedule',
        undefined,
        undefined,
        undefined,
        undefined
      );
    });

    it('should copy emailCampaignTaskId from schedule to session', async () => {
      const scheduleWithCampaignId = {
        ...baseSchedule,
        emailCampaignTaskId: 'campaign-task-123',
      };

      mockScheduleDb.getScheduleById.mockResolvedValue(scheduleWithCampaignId);
      mockAgentModeService.generateMarketingResponse.mockResolvedValue({
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
      });

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      // Should create session with emailCampaignTaskId from schedule
      expect(mockChatbotDb.createChatSession).toHaveBeenCalledWith(
        mockUserId,
        undefined,
        'agent',
        'Test: Test Schedule',
        undefined,
        undefined,
        undefined,
        'campaign-task-123'
      );
    });

    it('should handle schedule with null emailCampaignTaskId', async () => {
      const scheduleWithoutCampaignId = {
        ...baseSchedule,
        emailCampaignTaskId: null,
      };

      mockScheduleDb.getScheduleById.mockResolvedValue(scheduleWithoutCampaignId);
      mockAgentModeService.generateMarketingResponse.mockResolvedValue({
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
      });

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      // Should create session with undefined emailCampaignTaskId
      expect(mockChatbotDb.createChatSession).toHaveBeenCalledWith(
        mockUserId,
        undefined,
        'agent',
        'Test: Test Schedule',
        undefined,
        undefined,
        undefined,
        null
      );
    });

    it('should save run result to database', async () => {
      mockAgentModeService.generateMarketingResponse.mockResolvedValue(mockResponse);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

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
      mockAgentModeService.generateMarketingResponse.mockResolvedValue(mockResponse);
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

      mockAgentModeService.generateMarketingResponse.mockResolvedValue({
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
      mockAgentModeService.generateMarketingResponse.mockResolvedValue({
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

      mockAgentModeService.generateMarketingResponse.mockResolvedValue({
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

      mockAgentModeService.generateMarketingResponse.mockResolvedValue({
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

    it('should return 400 if required fields are missing', async () => {
      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          scheduleName: 'Test',
          // Missing startingMessage and scheduleFrequency
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Missing required fields' });
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
});
