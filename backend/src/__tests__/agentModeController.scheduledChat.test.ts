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
  },
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-run-id-123'),
}));

// Import mocked services
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb } from '../services/db';
import { agentModeController } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;

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

      // Should have been called 6 times (maxTries = 6)
      expect(mockAgentModeService.generateMarketingResponse).toHaveBeenCalledTimes(6);
      
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'failure',
          passed: false,
          attempt: 6, // Last attempt
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

      // Should have been called 6 times (all attempts)
      expect(mockAgentModeService.generateMarketingResponse).toHaveBeenCalledTimes(6);
      
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'failure',
          passed: false,
          attempt: 6,
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

      // Should have been called 6 times (error on attempt 2, but continued)
      expect(mockAgentModeService.generateMarketingResponse).toHaveBeenCalledTimes(6);
      
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'failure',
          passed: false,
          attempt: 6,
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
    it('should process multiple scheduled chats with 6 iterations each', async () => {
      const schedules = [
        { ...baseSchedule, scheduleId: 'schedule-1' },
        { ...baseSchedule, scheduleId: 'schedule-2', scheduleName: 'Test Schedule 2' },
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
            expect.objectContaining({ scheduleId: 'schedule-1' }),
            expect.objectContaining({ scheduleId: 'schedule-2' }),
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
  });
});
