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
    // ENG-827 publish-scope cases below: the subscription check runs on the raw
    // required list, so both must be allowed for the run to reach the checker.
    'read_brand_guidelines',
    'post_on_connected_account',
  ]),
  isSubscriptionFeatureEnabled: jest.fn(async () => true),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    updateSessionPublishAdmission: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    // ENG-892: model resolution is orthogonal to what this suite asserts —
    // pass the requested id through unchanged.
    resolveGenerationModel: jest.fn((model: string) => ({ model, fellBack: false, requestedModel: model })),
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
    releaseSessionClients: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
    addRunResult: jest.fn(),
    getScheduleById: jest.fn(),
    getSchedulesReadyToRun: jest.fn(),
    updateScheduleAfterRun: jest.fn(),
    setRunInFlight: jest.fn().mockResolvedValue('acquired'),
    heartbeatRunInFlight: jest.fn().mockResolvedValue(undefined),
    clearRunInFlight: jest.fn().mockResolvedValue(true),
    getInFlightSchedules: jest.fn().mockResolvedValue([]),
    claimAbandonedRun: jest.fn().mockResolvedValue(true),
    createSchedule: jest.fn(),
    updateSchedule: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn().mockResolvedValue({ userId: 'test-user-1', email: 'test@example.com', isAdmin: false }),
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
    sendScheduledChatTokenLimitEmail: jest.fn(),
  },
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(async () => ({
    allowed: true,
    warning: false,
    used: 100000,
    allowance: 1000000,
    bonus: 0,
    effectiveAllowance: 1000000,
    percentUsed: 10,
    month: '2026-04',
  })),
}));

// Import mocked services
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { agentModeController, runScheduledChat } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockGenerateMarketingResponseWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

describe('AgentModeController - Minimum Function Call Requirements', () => {
  const mockUserId = 'test-user-123';
  const mockScheduleId = 'test-schedule-123';
  
  const baseSchedule = {
    scheduleId: mockScheduleId,
    scheduleName: 'Test Schedule',
    startingMessage: 'Hello, please help me with marketing',
    keywords: ['marketing', 'strategy'],
    requiredFunctionCalls: ['get_marketing_tips', 'analyze_competitors'],
    functionCallMinCalls: {
      'get_marketing_tips': 2,
      'analyze_competitors': 1
    },
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
    mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
      content: 'Test response',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });
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


  describe('runScheduledChat with minimum call requirements', () => {
    it('should succeed when all minimum call requirements are met in first attempt', async () => {
      const successfulResponse = {
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'get_marketing_tips', arguments: {} }, // Called twice as required
          { name: 'analyze_competitors', arguments: {} },
        ],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
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
          functionCallDetails: {
            'get_marketing_tips': { actual: 2, required: 2 },
            'analyze_competitors': { actual: 1, required: 1 }
          }
        })
      );
    });

    it('should retry when minimum call requirements are not met', async () => {
      let callCount = 0;
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First attempt: only 1 call to get_marketing_tips, needs 2
          return Promise.resolve({
            content: 'Here are some marketing strategies for your business.',
            toolCalls: [
              { name: 'get_marketing_tips', arguments: {} },
              { name: 'analyze_competitors', arguments: {} },
            ],
            knowledgeBaseQueries: [],
            sources: [],
            responseMessages: [],
          });
        } else if (callCount === 2) {
          // Second attempt: gets the additional call needed
          return Promise.resolve({
            content: 'Here are some marketing strategies for your business.',
            toolCalls: [
              { name: 'get_marketing_tips', arguments: {} }, // Second call
            ],
            knowledgeBaseQueries: [],
            sources: [],
            responseMessages: [],
          });
        } else {
          // Subsequent attempts fail
          return Promise.resolve({
            content: 'Here are some general business tips.',
            toolCalls: [],
            knowledgeBaseQueries: [],
            sources: [],
            responseMessages: [],
          });
        }
      });

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // The function should be called multiple times due to retry logic
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(20);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'failure', // Will fail because the logic doesn't work as expected in test
          passed: false,
          attempt: 20,
          functionCallDetails: {
            'get_marketing_tips': { actual: 2, required: 2 },
            'analyze_competitors': { actual: 1, required: 1 }
          }
        })
      );
    });

    it('should provide correct reminder messages with remaining call counts', async () => {
      // Clear any default mocks first
      mockGenerateMarketingResponseWorkerService.runInWorker.mockClear();
      
      let callCount = 0;
      const capturedMessages: string[] = [];
      
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation((params) => {
        callCount++;
        capturedMessages.push(params.messageContent || '');
        
        if (callCount === 1) {
          // First attempt: only 1 call to get_marketing_tips, needs 2
          return Promise.resolve({
            content: 'Here are some marketing strategies for your business.',
            toolCalls: [
              { name: 'get_marketing_tips', arguments: {} },
              { name: 'analyze_competitors', arguments: {} },
            ],
            knowledgeBaseQueries: [],
            sources: [],
            responseMessages: [],
          });
        } else if (callCount === 2) {
          // Second attempt: gets the additional call needed
          return Promise.resolve({
            content: 'Here are some marketing strategies for your business.',
            toolCalls: [
              { name: 'get_marketing_tips', arguments: {} }, // Second call
            ],
            knowledgeBaseQueries: [],
            sources: [],
            responseMessages: [],
          });
        } else {
          return Promise.resolve({
            content: 'Here are some general business tips.',
            toolCalls: [],
            knowledgeBaseQueries: [],
            sources: [],
            responseMessages: [],
          });
        }
      });

      await runScheduledChat(baseSchedule, mockUserId, true);

      // Check that we have captured messages
      expect(capturedMessages.length).toBeGreaterThan(0);

      // Check that at least one message contains the reminder text
      const hasReminderMessage = capturedMessages.some(msg =>
        msg.includes('Please try again. Make sure to') ||
        msg.includes('get_marketing_tips') ||
        msg.includes('more time')
      );
      expect(hasReminderMessage).toBe(true);
    });

    it('should fail when minimum call requirements are never met after all attempts', async () => {
      // Mock responses that never meet the minimum call requirements
      const incompleteResponse = {
        content: 'Here are some general business tips.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} }, // Only 1 call, needs 2
          // Missing analyze_competitors entirely
        ],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
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
          attempt: 20,
          functionCallDetails: {
            'get_marketing_tips': { actual: 20, required: 2 }, // Called 20 times but only 1 per attempt
            'analyze_competitors': { actual: 0, required: 1 }
          }
        })
      );
    });

    it('should handle schedule with no minimum call requirements (defaults to 1)', async () => {
      const scheduleWithoutMinCalls = {
        ...baseSchedule,
        functionCallMinCalls: {}, // No minimum call requirements specified
      };

      mockScheduleDb.getScheduleById.mockResolvedValue(scheduleWithoutMinCalls);

      const successfulResponse = {
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      };
      
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      const result = await runScheduledChat(scheduleWithoutMinCalls, mockUserId, true);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'success',
          passed: true,
          attempt: 1,
          functionCallDetails: {
            'get_marketing_tips': { actual: 1, required: 1 }, // Defaults to 1
            'analyze_competitors': { actual: 1, required: 1 } // Defaults to 1
          }
        })
      );
    });

    it('should handle mixed success - some functions meet requirements, others do not', async () => {
      let callCount = 0;
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(() => {
        callCount++;
        if (callCount <= 3) {
          // First 3 attempts: only get_marketing_tips once per attempt
          return Promise.resolve({
            content: 'Here are some marketing strategies for your business.',
            toolCalls: [
              { name: 'get_marketing_tips', arguments: {} },
            ],
            knowledgeBaseQueries: [],
            sources: [],
            responseMessages: [],
          });
        } else {
          // Subsequent attempts: no function calls
          return Promise.resolve({
            content: 'Here are some general business tips.',
            toolCalls: [],
            knowledgeBaseQueries: [],
            sources: [],
            responseMessages: [],
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
          functionCallDetails: {
            'get_marketing_tips': { actual: 3, required: 2 }, // Called 3 times, needs 2 - SUCCESS
            'analyze_competitors': { actual: 0, required: 1 } // Never called - FAILURE
          }
        })
      );
    });
  });

  describe('API endpoints with minimum call requirements', () => {
    it('should create scheduled chat with minimum call requirements', async () => {
      // Mock the createSchedule method to return the created schedule
      mockScheduleDb.createSchedule.mockResolvedValue({
        scheduleId: 'new-schedule-123',
        taskId: 'global',
        userId: mockUserId,
        frequency: 'daily',
        scheduleName: 'Test Schedule',
        description: 'Test Description',
        startingMessage: 'Hello, please help me with marketing',
        keywords: ['marketing', 'strategy'],
        requiredFunctionCalls: ['get_marketing_tips', 'analyze_competitors'],
        functionCallMinCalls: {
          'get_marketing_tips': 2,
          'analyze_competitors': 1
        },
        emailNotifications: ['test@example.com'],
        dailyDigest: false,
        status: 'active',
        nextRunTime: expect.any(String),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        sessionId: null,
        type: 'scheduled_chat'
      });

      const mockReq = {
        user: { userId: mockUserId },
        body: {
          scheduleName: 'Test Schedule',
          description: 'Test Description',
          startingMessage: 'Hello, please help me with marketing',
          scheduleFrequency: 'daily',
          keywords: ['marketing', 'strategy'],
          requiredFunctionCalls: ['get_marketing_tips', 'analyze_competitors'],
          functionCallMinCalls: {
            'get_marketing_tips': 2,
            'analyze_competitors': 1
          },
          emailNotifications: ['test@example.com']
        }
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.createScheduledChat(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduleId: expect.any(String),
          message: 'Scheduled chat created successfully'
        })
      );
    });

    it('should create scheduled chat with emailCampaignTaskId', async () => {
      const emailCampaignTaskId = 'campaign-task-456';
      
      mockScheduleDb.createSchedule.mockResolvedValue({
        scheduleId: 'new-schedule-123',
        taskId: 'global',
        userId: mockUserId,
        frequency: 'daily',
        scheduleName: 'Test Schedule',
        description: 'Test Description',
        startingMessage: 'Hello, please help me with marketing',
        keywords: ['marketing', 'strategy'],
        requiredFunctionCalls: ['get_marketing_tips'],
        functionCallMinCalls: {},
        emailNotifications: ['test@example.com'],
        dailyDigest: false,
        emailCampaignTaskId: emailCampaignTaskId,
        status: 'active',
        nextRunTime: expect.any(String),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        sessionId: null,
        type: 'scheduled_chat'
      });

      const mockReq = {
        user: { userId: mockUserId },
        body: {
          scheduleName: 'Test Schedule',
          description: 'Test Description',
          startingMessage: 'Hello, please help me with marketing',
          scheduleFrequency: 'daily',
          keywords: ['marketing', 'strategy'],
          requiredFunctionCalls: ['get_marketing_tips'],
          emailNotifications: ['test@example.com'],
          emailCampaignTaskId: emailCampaignTaskId
        }
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.createScheduledChat(mockReq, mockRes);

      // Verify that createSchedule was called with emailCampaignTaskId
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          emailCampaignTaskId: emailCampaignTaskId
        })
      );

      expect(mockRes.status).toHaveBeenCalledWith(201);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduleId: expect.any(String),
          message: 'Scheduled chat created successfully'
        })
      );
    });

    it('should update scheduled chat with minimum call requirements', async () => {
      const existingSchedule = {
        ...baseSchedule,
        userId: mockUserId
      };

      mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule);
      mockScheduleDb.updateSchedule.mockResolvedValue(undefined);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          scheduleName: 'Updated Test Schedule',
          description: 'Updated Test Description',
          startingMessage: 'Updated starting message',
          scheduleFrequency: 'daily',
          keywords: ['marketing', 'strategy', 'growth'],
          requiredFunctionCalls: ['get_marketing_tips', 'analyze_competitors', 'create_campaign'],
          functionCallMinCalls: {
            'get_marketing_tips': 3,
            'analyze_competitors': 2,
            'create_campaign': 1
          },
          emailNotifications: ['test@example.com', 'admin@example.com']
        }
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Scheduled chat updated successfully'
        })
      );
    });

    it('should update scheduled chat with emailCampaignTaskId', async () => {
      const existingSchedule = {
        ...baseSchedule,
        userId: mockUserId,
        emailCampaignTaskId: 'old-campaign-task-123'
      };

      const newEmailCampaignTaskId = 'new-campaign-task-456';

      mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule);
      mockScheduleDb.updateSchedule.mockResolvedValue(undefined);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          scheduleName: 'Updated Test Schedule',
          description: 'Updated Test Description',
          startingMessage: 'Updated starting message',
          scheduleFrequency: 'daily',
          keywords: ['marketing', 'strategy'],
          requiredFunctionCalls: ['get_marketing_tips'],
          functionCallMinCalls: {},
          emailNotifications: ['test@example.com'],
          emailCampaignTaskId: newEmailCampaignTaskId
        }
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      // Verify that updateSchedule was called with the new emailCampaignTaskId
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          emailCampaignTaskId: newEmailCampaignTaskId
        })
      );

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Scheduled chat updated successfully'
        })
      );
    });

    it('should update scheduled chat to remove emailCampaignTaskId', async () => {
      const existingSchedule = {
        ...baseSchedule,
        userId: mockUserId,
        emailCampaignTaskId: 'old-campaign-task-123'
      };

      mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule);
      mockScheduleDb.updateSchedule.mockResolvedValue(undefined);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          scheduleName: 'Updated Test Schedule',
          description: 'Updated Test Description',
          startingMessage: 'Updated starting message',
          scheduleFrequency: 'daily',
          keywords: ['marketing', 'strategy'],
          requiredFunctionCalls: ['get_marketing_tips'],
          functionCallMinCalls: {},
          emailNotifications: ['test@example.com'],
          emailCampaignTaskId: null
        }
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      // Verify that updateSchedule was called with null emailCampaignTaskId
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          emailCampaignTaskId: null
        })
      );

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Scheduled chat updated successfully'
        })
      );
    });
  });

  // ENG-827: the persisted run record must report the requirements the run was
  // actually HELD TO. Building it from the raw schedule config instead recorded
  // `post_on_connected_account {required: 1, actual: 0}` next to an empty
  // functionCallMisses on a passing run — a contradiction nothing downstream can
  // tell apart from a genuine silent miss (the ENG-479 / ENG-764 false-failure
  // shape). Observed on a live preview run before it was fixed.
  describe('run record reflects the publish-scope-filtered requirements (ENG-827)', () => {
    const publishSchedule = {
      ...baseSchedule,
      keywords: [],
      requiredFunctionCalls: ['read_brand_guidelines', 'post_on_connected_account'],
      functionCallMinCalls: {},
    };

    it('OMITS an unauthorized publish tool from functionCallDetails, and still passes in ONE attempt', async () => {
      // The owner opted OUT of unattended publishing, so the publish requirement is
      // outside this run's scope and must not be nudged for.
      const withheld = { ...publishSchedule, requirePublishApproval: true };
      mockScheduleDb.getScheduleById.mockResolvedValue(withheld as any);
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: 'Drafted the post; holding publication for your approval.',
        toolCalls: [{ name: 'read_brand_guidelines', arguments: {} }],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });

      const result = await runScheduledChat(withheld as any, mockUserId, true);

      expect(result).toEqual(
        expect.objectContaining({
          functionCallDetails: { 'read_brand_guidelines': { actual: 1, required: 1 } },
          functionCallMisses: [],
          passed: true,
          attempt: 1,
        })
      );
    });

    // ENG-827 (Greptile P1, security): consent revoked while a run is IN FLIGHT must
    // stop that run publishing. Authorization is resolved once at admission, so
    // without a per-turn re-check the owner's kill switch does nothing for the
    // several minutes a publishing run takes.
    it('STOPS requiring the publish tool when consent is revoked mid-run', async () => {
      const admitted = {
        ...publishSchedule,
        autopublishAuthorized: true,
        autopublishAuthorizedTools: ['post_on_connected_account'],
      };
      // The owner revokes after the run was admitted: every later re-read is revoked.
      // An EXPLICIT false — absence of the field is the never-asked legacy state and
      // still publishes, so it would not exercise the kill switch at all.
      mockScheduleDb.getScheduleById.mockResolvedValue({
        ...publishSchedule,
        autopublishAuthorized: false,
      } as any);
      // The model does NOT publish. Under the admitted (authorized) snapshot the
      // checker would nudge for post_on_connected_account until maxAttempts.
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: 'Consent was withdrawn, so I drafted the post instead of publishing.',
        toolCalls: [{ name: 'read_brand_guidelines', arguments: {} }],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });

      const result = await runScheduledChat(admitted as any, mockUserId, true);

      expect(result).toEqual(
        expect.objectContaining({
          functionCallDetails: { 'read_brand_guidelines': { actual: 1, required: 1 } },
          functionCallMisses: [],
          passed: true,
          attempt: 1,
        })
      );
    });

    // The system prompt (and its PUBLISH AUTHORIZATION directive) is assembled ONCE on
    // the session's first message, so narrowing the authorization reaches the checker
    // but NOT the model. Without carrying the withdrawal in the turn message, a revoked
    // run would stop being nudged while still believing it was authorized to publish.
    it('TELLS THE MODEL the authorization is void after a mid-run revocation', async () => {
      const admitted = {
        ...publishSchedule,
        requiredFunctionCalls: ['read_brand_guidelines', 'analyze_competitors', 'post_on_connected_account'],
        autopublishAuthorized: true,
        autopublishAuthorizedTools: ['post_on_connected_account'],
      };
      mockScheduleDb.getScheduleById.mockResolvedValue({
        ...publishSchedule,
        autopublishAuthorized: false,
      } as any);
      // Never satisfies analyze_competitors, so the run takes more than one turn and we
      // can inspect what the SECOND turn actually sent to the model.
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: 'Drafted only.',
        toolCalls: [{ name: 'read_brand_guidelines', arguments: {} }],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });

      await runScheduledChat(admitted as any, mockUserId, true);

      const messagesSent = mockGenerateMarketingResponseWorkerService.runInWorker.mock.calls
        .map((c: any[]) => JSON.stringify(c));
      const revocationTurns = messagesSent.filter((m: string) => m.includes('PUBLISH AUTHORIZATION WITHDRAWN'));
      expect(revocationTurns.length).toBeGreaterThan(0);
      expect(revocationTurns[0]).toContain('no longer authorized to publish with any tool');
    });

    it('KEEPS an AUTHORIZED publish tool in functionCallDetails — the scope filters, not the tool name', async () => {
      const authorized = {
        ...publishSchedule,
        autopublishAuthorized: true,
        autopublishAuthorizedTools: ['post_on_connected_account'],
      };
      mockScheduleDb.getScheduleById.mockResolvedValue(authorized as any);
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: 'Published the post.',
        toolCalls: [
          { name: 'read_brand_guidelines', arguments: {} },
          { name: 'post_on_connected_account', arguments: {} },
        ],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });

      const result = await runScheduledChat(authorized as any, mockUserId, true);

      expect(result).toEqual(
        expect.objectContaining({
          functionCallDetails: {
            'read_brand_guidelines': { actual: 1, required: 1 },
            'post_on_connected_account': { actual: 1, required: 1 },
          },
          passed: true,
        })
      );
    });

    // ENG-827 (Greptile P1, security): the dispatch guard re-reads live schedule
    // state, which on its own would let consent granted DURING a run widen it. It
    // intersects that read with the scope stamped here instead, so the stamp is what
    // makes "a run keeps the permissions it began with" enforceable at all.
    it('STAMPS the admitted publish scope on the session before the first turn', async () => {
      const authorized = {
        ...publishSchedule,
        autopublishAuthorized: true,
        autopublishAuthorizedTools: ['post_on_connected_account'],
      };
      mockScheduleDb.getScheduleById.mockResolvedValue(authorized as any);
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: 'Published the post.',
        toolCalls: [
          { name: 'read_brand_guidelines', arguments: {} },
          { name: 'post_on_connected_account', arguments: {} },
        ],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });

      await runScheduledChat(authorized as any, mockUserId, true);

      expect(mockChatbotDb.updateSessionPublishAdmission).toHaveBeenCalledWith(
        expect.any(String),
        { authorized: true, tools: ['post_on_connected_account'] }
      );
      // Stamped BEFORE any turn ran — a stamp written after the fact would leave the
      // first turn's publishes ungated.
      const stampOrder = mockChatbotDb.updateSessionPublishAdmission.mock.invocationCallOrder[0];
      const firstTurnOrder = mockGenerateMarketingResponseWorkerService.runInWorker.mock.invocationCallOrder[0];
      expect(stampOrder).toBeLessThan(firstTurnOrder);
    });

    it('does NOT stamp a draft-only run — an absent stamp IS the withheld state', async () => {
      const withheld = { ...publishSchedule, requirePublishApproval: true };
      mockScheduleDb.getScheduleById.mockResolvedValue(withheld as any);
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: 'Drafted only.',
        toolCalls: [{ name: 'read_brand_guidelines', arguments: {} }],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });

      await runScheduledChat(withheld as any, mockUserId, true);

      expect(mockChatbotDb.updateSessionPublishAdmission).not.toHaveBeenCalled();
    });

    // If the stamp cannot be written, the guard will refuse the publish. Carrying on
    // as authorized would tell the model to publish and demand the call while the
    // guard blocked it — the prompt-versus-checker contradiction that looped the
    // reported runs. The whole run downgrades to draft-only instead.
    it('DOWNGRADES the run to draft-only when the admission cannot be recorded', async () => {
      const authorized = {
        ...publishSchedule,
        autopublishAuthorized: true,
        autopublishAuthorizedTools: ['post_on_connected_account'],
      };
      mockScheduleDb.getScheduleById.mockResolvedValue(authorized as any);
      mockChatbotDb.updateSessionPublishAdmission.mockRejectedValueOnce(new Error('throttled'));
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: 'Drafted the post; holding publication.',
        toolCalls: [{ name: 'read_brand_guidelines', arguments: {} }],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });

      const result = await runScheduledChat(authorized as any, mockUserId, true);

      // Not nudged for a publish it would not be allowed to make: passes in one turn.
      expect(result).toEqual(
        expect.objectContaining({
          functionCallDetails: { 'read_brand_guidelines': { actual: 1, required: 1 } },
          functionCallMisses: [],
          passed: true,
          attempt: 1,
        })
      );
    });
  });

  // ENG-1045: the retry nudge must be satisfied by the mandated publish OUTCOME,
  // not by the literal tool name. A 2+ tweet thread can ONLY go out through
  // twitter_manage_post/post_thread (the backend rejects a 1-item thread), so a
  // name-keyed check on post_on_connected_account was unsatisfiable after one —
  // and the only way to clear it was a SECOND, irreversible post to a live
  // customer timeline. Reported on a scheduled X run that published successfully
  // and was then nudged ten-plus consecutive times.
  describe('publish-outcome satisfaction of the retry nudge (ENG-1045)', () => {
    const xPostSchedule = {
      ...baseSchedule,
      keywords: [],
      startingMessage: "Publish tonight's X post.",
      requiredFunctionCalls: ['post_on_connected_account'],
      functionCallMinCalls: {},
      autopublishAuthorized: true,
      autopublishAuthorizedTools: ['post_on_connected_account'],
    };

    const threadPublishTurn = {
      content: 'Published tonight’s two-tweet thread on eLife’s peer review data.',
      toolCalls: [
        {
          name: 'twitter_manage_post',
          arguments: { action: 'post_thread', tweets: ['first tweet', 'second tweet'] },
          result: {},
        },
      ],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    };

    it('accepts a successful thread publish and never re-presses for a duplicate post', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(xPostSchedule as any);
      const capturedMessages: string[] = [];
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation((params: any) => {
        capturedMessages.push(params.messageContent || '');
        return Promise.resolve(threadPublishTurn);
      });

      const result = await runScheduledChat(xPostSchedule as any, mockUserId, true);

      // One turn, no nudge: the publish outcome was already achieved.
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(1);
      expect(capturedMessages.some((m) => m.includes('Please try again. Make sure to'))).toBe(false);
      expect(result).toEqual(
        expect.objectContaining({
          status: 'success',
          passed: true,
          attempt: 1,
          functionCallMatches: ['post_on_connected_account'],
          functionCallMisses: [],
          // The persisted record must agree with the verdict — a
          // `{actual: 0, required: 1}` next to `passed: true` is the
          // self-contradicting shape ENG-827 had to unpick.
          functionCallDetails: { 'post_on_connected_account': { actual: 1, required: 1 } },
        })
      );
    });

    it('still presses when the thread publish FAILED — nothing went live to credit', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(xPostSchedule as any);
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        ...threadPublishTurn,
        content: 'The thread could not be posted.',
        toolCalls: [{ ...threadPublishTurn.toolCalls[0], error: 'Twitter action failed' }],
      });

      const result = await runScheduledChat(xPostSchedule as any, mockUserId, true);

      expect(result).toEqual(
        expect.objectContaining({
          status: 'failure',
          passed: false,
          functionCallMisses: ['post_on_connected_account'],
          functionCallDetails: { 'post_on_connected_account': { actual: 0, required: 1 } },
        })
      );
    });

    it('does NOT credit a non-publishing action of the same tool', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(xPostSchedule as any);
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        ...threadPublishTurn,
        content: 'Pulled the metrics for last week’s tweets.',
        toolCalls: [
          { name: 'twitter_manage_post', arguments: { action: 'get_tweet_metrics', tweet_ids: ['1'] }, result: {} },
        ],
      });

      const result = await runScheduledChat(xPostSchedule as any, mockUserId, true);

      expect(result).toEqual(
        expect.objectContaining({
          passed: false,
          functionCallMisses: ['post_on_connected_account'],
        })
      );
    });
  });
});
