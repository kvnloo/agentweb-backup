import { Request, Response } from 'express';

// Mock all dependencies before importing the controller
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    createOrReuseInteractiveShare: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getReportGenerationDefaultModel: jest.fn(),
    getImageGenerationDefaultModel: jest.fn(),
    getVideoGenerationDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    generateMarketingResponse: jest.fn(),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
  },
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendOncallAlert: jest.fn().mockResolvedValue(undefined),
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

// Import mocked services
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { agentModeService } from '../services/agentModeService';
import { agentModeController } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockGenerateMarketingResponseWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;

describe('AgentModeController - Verified Generate', () => {
  const mockUserId = 'test-user-123';
  const mockSessionId = 'test-session-123';
  
  const mockSession = {
    sessionId: mockSessionId,
    userId: mockUserId,
    title: 'Test Session',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockResponse = {
    content: 'Generated content',
    toolCalls: [
      { name: 'generate_image', arguments: { prompt: 'test' } },
    ],
    knowledgeBaseQueries: [],
    sources: [],
    responseMessages: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup default mocks
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.createOrReuseInteractiveShare.mockResolvedValue('http://ishare.test/session');
    mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(mockResponse);
    mockAgentModeService.getDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getReportGenerationDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getImageGenerationDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getVideoGenerationDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
  });

  describe('verifiedGenerate endpoint', () => {
    it('should successfully verify function calls on first attempt', async () => {
      const successfulResponse = {
        ...mockResponse,
        content: 'Image generated successfully',
        toolCalls: [
          { name: 'generate_image', arguments: { prompt: 'test image' } },
        ],
      };
      
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      let disconnectCallback: (() => void) | undefined;
      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          startingMessage: 'Create an image',
          requiredFunctions: [{ functionName: 'generate_image', minCount: 1 }],
          keywords: [],
          attachments: [],
        },
        on: jest.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            disconnectCallback = callback;
          }
        }),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        on: jest.fn(),
      } as unknown as Response;

      await agentModeController.verifiedGenerate(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: 'All required functions were called successfully.',
          functionCallMatches: ['generate_image'],
          functionCallMisses: [],
          attempts: 1,
        })
      );
    });

    it('should retry when function calls are not met', async () => {
      // First attempt: no function calls
      const incompleteResponse = {
        ...mockResponse,
        content: 'Working on it...',
        toolCalls: [],
      };
      
      // Second attempt: has the required function call
      const completeResponse = {
        ...mockResponse,
        content: 'Image generated',
        toolCalls: [
          { name: 'generate_image', arguments: { prompt: 'test' } },
        ],
      };

      mockGenerateMarketingResponseWorkerService.runInWorker
        .mockResolvedValueOnce(incompleteResponse)
        .mockResolvedValueOnce(completeResponse);

      let disconnectCallback: (() => void) | undefined;
      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          startingMessage: 'Create an image',
          requiredFunctions: [{ functionName: 'generate_image', minCount: 1 }],
          keywords: [],
          attachments: [],
          maxAttempts: 5,
        },
        on: jest.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            disconnectCallback = callback;
          }
        }),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        on: jest.fn(),
      } as unknown as Response;

      await agentModeController.verifiedGenerate(mockReq, mockRes);

      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(2);
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          attempts: 2,
        })
      );
    });

    it('should handle multiple required function calls', async () => {
      const successfulResponse = {
        ...mockResponse,
        content: 'Images generated',
        toolCalls: [
          { name: 'generate_image', arguments: { prompt: 'image1' } },
          { name: 'generate_image', arguments: { prompt: 'image2' } },
        ],
      };
      
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      let disconnectCallback: (() => void) | undefined;
      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          startingMessage: 'Create 2 images',
          requiredFunctions: [{ functionName: 'generate_image', minCount: 2 }],
          keywords: [],
          attachments: [],
        },
        on: jest.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            disconnectCallback = callback;
          }
        }),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        on: jest.fn(),
      } as unknown as Response;

      await agentModeController.verifiedGenerate(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          functionStatus: expect.arrayContaining([
            expect.objectContaining({
              functionName: 'generate_image',
              requiredCount: 2,
              actualCount: 2,
              met: true,
            }),
          ]),
        })
      );
    });

    it('should validate required fields', async () => {
      let disconnectCallback: (() => void) | undefined;
      const mockReq = {
        user: { userId: mockUserId },
        body: {
          // Missing sessionId
          startingMessage: 'Create an image',
          requiredFunctions: [{ functionName: 'generate_image', minCount: 1 }],
        },
        on: jest.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            disconnectCallback = callback;
          }
        }),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        on: jest.fn(),
      } as unknown as Response;

      await agentModeController.verifiedGenerate(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Session ID is required',
        })
      );
    });

    it('should validate starting message', async () => {
      let disconnectCallback: (() => void) | undefined;
      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          startingMessage: '', // Empty message
          requiredFunctions: [{ functionName: 'generate_image', minCount: 1 }],
        },
        on: jest.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            disconnectCallback = callback;
          }
        }),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        on: jest.fn(),
      } as unknown as Response;

      await agentModeController.verifiedGenerate(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Starting message is required',
        })
      );
    });

    it('should allow empty requiredFunctions array', async () => {
      let disconnectCallback: (() => void) | undefined;
      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          startingMessage: 'Create an image',
          requiredFunctions: [], // Empty array
        },
        on: jest.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            disconnectCallback = callback;
          }
        }),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        on: jest.fn(),
      } as unknown as Response;

      await agentModeController.verifiedGenerate(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should allow missing requiredFunctions', async () => {
      let disconnectCallback: (() => void) | undefined;
      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          startingMessage: 'Create a report',
          keywords: [],
          attachments: [],
        },
        on: jest.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            disconnectCallback = callback;
          }
        }),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        on: jest.fn(),
      } as unknown as Response;

      await agentModeController.verifiedGenerate(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          functionCallMisses: [],
        })
      );
    });

    it('should validate requiredFunctions format', async () => {
      let disconnectCallback: (() => void) | undefined;
      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          startingMessage: 'Create an image',
          requiredFunctions: [{ functionName: 'generate_image' }], // Missing minCount
        },
        on: jest.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            disconnectCallback = callback;
          }
        }),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        on: jest.fn(),
      } as unknown as Response;

      await agentModeController.verifiedGenerate(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('minCount'),
        })
      );
    });

    it('should return 404 when session not found', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(null);

      let disconnectCallback: (() => void) | undefined;
      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: 'non-existent-session',
          startingMessage: 'Create an image',
          requiredFunctions: [{ functionName: 'generate_image', minCount: 1 }],
        },
        on: jest.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            disconnectCallback = callback;
          }
        }),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        on: jest.fn(),
      } as unknown as Response;

      await agentModeController.verifiedGenerate(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Session not found',
        })
      );
    });

    it('should return 403 when user does not own session', async () => {
      const otherUserSession = {
        ...mockSession,
        userId: 'other-user-456',
      };
      mockChatbotDb.getChatSession.mockResolvedValue(otherUserSession);

      let disconnectCallback: (() => void) | undefined;
      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          startingMessage: 'Create an image',
          requiredFunctions: [{ functionName: 'generate_image', minCount: 1 }],
        },
        on: jest.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            disconnectCallback = callback;
          }
        }),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        on: jest.fn(),
      } as unknown as Response;

      await agentModeController.verifiedGenerate(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Access denied to this session',
        })
      );
    });

    it('should register client disconnection handler', async () => {
      const successfulResponse = {
        ...mockResponse,
        content: 'Image generated',
        toolCalls: [
          { name: 'generate_image', arguments: { prompt: 'test' } },
        ],
      };
      
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      let disconnectCallback: (() => void) | undefined;
      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          startingMessage: 'Create an image',
          requiredFunctions: [{ functionName: 'generate_image', minCount: 1 }],
          keywords: [],
          attachments: [],
        },
        on: jest.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            disconnectCallback = callback;
          }
        }),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        on: jest.fn(),
      } as unknown as Response;

      await agentModeController.verifiedGenerate(mockReq, mockRes);

      // Verify that the disconnect handler was registered
      expect(mockReq.on).toHaveBeenCalledWith('close', expect.any(Function));
      // Verify that disconnectCallback was set
      expect(disconnectCallback).toBeDefined();
      // Response should still be sent if operation completes before disconnect
      expect(mockRes.json).toHaveBeenCalled();
    });

    it('should handle keywords verification', async () => {
      const successfulResponse = {
        ...mockResponse,
        content: 'This is a marketing strategy for your business',
        toolCalls: [
          { name: 'generate_image', arguments: { prompt: 'test' } },
        ],
      };
      
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      let disconnectCallback: (() => void) | undefined;
      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          startingMessage: 'Create an image with marketing content',
          requiredFunctions: [{ functionName: 'generate_image', minCount: 1 }],
          keywords: ['marketing', 'strategy'],
          attachments: [],
        },
        on: jest.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            disconnectCallback = callback;
          }
        }),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        on: jest.fn(),
      } as unknown as Response;

      await agentModeController.verifiedGenerate(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          keywordMatches: expect.arrayContaining(['marketing', 'strategy']),
          keywordMisses: [],
        })
      );
    });

    it('should handle work plan completion', async () => {
      const sessionWithWorkPlan = {
        ...mockSession,
        workPlan: {
          title: 'Test Work Plan',
          steps: [
            { stepCount: 1, title: 'Step 1', status: 'completed' as const },
            { stepCount: 2, title: 'Step 2', status: 'completed' as const },
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithWorkPlan);

      const successfulResponse = {
        ...mockResponse,
        content: 'Work plan completed',
        toolCalls: [
          { name: 'generate_image', arguments: { prompt: 'test' } },
        ],
        workPlan: {
          title: 'Test Work Plan',
          steps: [
            { stepCount: 1, title: 'Step 1', status: 'completed' as const },
            { stepCount: 2, title: 'Step 2', status: 'completed' as const },
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      let disconnectCallback: (() => void) | undefined;
      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          startingMessage: 'Execute work plan',
          requiredFunctions: [{ functionName: 'generate_image', minCount: 1 }],
          keywords: [],
          attachments: [],
        },
        on: jest.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            disconnectCallback = callback;
          }
        }),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        on: jest.fn(),
      } as unknown as Response;

      await agentModeController.verifiedGenerate(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          workPlanCompleted: true,
        })
      );
    });

    it('should enforce high minCount for multiple variations', async () => {
      // First attempt: only 3 generate_image calls
      const partialResponse = {
        ...mockResponse,
        content: 'Generated 3 images',
        toolCalls: [
          { name: 'generate_image', arguments: { prompt: 'image1' } },
          { name: 'generate_image', arguments: { prompt: 'image2' } },
          { name: 'generate_image', arguments: { prompt: 'image3' } },
        ],
      };

      // Second attempt: 2 more generate_image calls to reach 5 total
      const remainingResponse = {
        ...mockResponse,
        content: 'Generated remaining images',
        toolCalls: [
          { name: 'generate_image', arguments: { prompt: 'image4' } },
          { name: 'generate_image', arguments: { prompt: 'image5' } },
        ],
      };

      mockGenerateMarketingResponseWorkerService.runInWorker
        .mockResolvedValueOnce(partialResponse)
        .mockResolvedValueOnce(remainingResponse);

      let disconnectCallback: (() => void) | undefined;
      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          startingMessage: 'Create images. Generate 5 variations.',
          requiredFunctions: [{ functionName: 'generate_image', minCount: 5 }],
          keywords: [],
          attachments: [],
          maxAttempts: 10,
        },
        on: jest.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            disconnectCallback = callback;
          }
        }),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        on: jest.fn(),
      } as unknown as Response;

      await agentModeController.verifiedGenerate(mockReq, mockRes);

      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(2);
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          attempts: 2,
          functionStatus: expect.arrayContaining([
            expect.objectContaining({
              functionName: 'generate_image',
              requiredCount: 5,
              actualCount: 5,
              met: true,
            }),
          ]),
        })
      );
    });

    it('should enforce minCount for variations multiplied by ICPs', async () => {
      // Simulates 2 ICPs * 3 variations = minCount 6
      const successfulResponse = {
        ...mockResponse,
        content: 'Generated all images',
        toolCalls: [
          { name: 'generate_image', arguments: { prompt: 'icp1-v1' } },
          { name: 'generate_image', arguments: { prompt: 'icp1-v2' } },
          { name: 'generate_image', arguments: { prompt: 'icp1-v3' } },
          { name: 'generate_image', arguments: { prompt: 'icp2-v1' } },
          { name: 'generate_image', arguments: { prompt: 'icp2-v2' } },
          { name: 'generate_image', arguments: { prompt: 'icp2-v3' } },
        ],
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      let disconnectCallback: (() => void) | undefined;
      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          startingMessage: 'Create images for 2 ICPs with 3 variations each',
          requiredFunctions: [{ functionName: 'generate_image', minCount: 6 }],
          keywords: [],
          attachments: [],
          maxAttempts: 10,
        },
        on: jest.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            disconnectCallback = callback;
          }
        }),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        on: jest.fn(),
      } as unknown as Response;

      await agentModeController.verifiedGenerate(mockReq, mockRes);

      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(1);
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          attempts: 1,
          functionStatus: expect.arrayContaining([
            expect.objectContaining({
              functionName: 'generate_image',
              requiredCount: 6,
              actualCount: 6,
              met: true,
            }),
          ]),
        })
      );
    });

    it('should use default maxAttempts of 5 when not provided', async () => {
      const incompleteResponse = {
        ...mockResponse,
        content: 'Working...',
        toolCalls: [],
      };
      
      // Mock to return incomplete response for all attempts
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(incompleteResponse);

      let disconnectCallback: (() => void) | undefined;
      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          startingMessage: 'Create an image',
          requiredFunctions: [{ functionName: 'generate_image', minCount: 1 }],
          keywords: [],
          attachments: [],
          // maxAttempts not provided
        },
        on: jest.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            disconnectCallback = callback;
          }
        }),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        on: jest.fn(),
      } as unknown as Response;

      await agentModeController.verifiedGenerate(mockReq, mockRes);

      // Should retry 5 times (default maxAttempts)
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(5);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          attempts: 5,
        })
      );
    });

    it('should handle errors gracefully', async () => {
      // Mock error on first attempt, which will be retried until maxAttempts
      mockGenerateMarketingResponseWorkerService.runInWorker.mockRejectedValue(
        new Error('Worker service error')
      );

      let disconnectCallback: (() => void) | undefined;
      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          startingMessage: 'Create an image',
          requiredFunctions: [{ functionName: 'generate_image', minCount: 1 }],
          keywords: [],
          attachments: [],
        },
        on: jest.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            disconnectCallback = callback;
          }
        }),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        on: jest.fn(),
      } as unknown as Response;

      await agentModeController.verifiedGenerate(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Failed to perform verified generation',
          message: expect.any(String), // Error message may vary
        })
      );
    });
  });
});
