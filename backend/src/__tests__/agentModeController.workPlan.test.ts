import { Request, Response } from 'express';
import { agentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';

// Mock the dependencies
jest.mock('../services/agentModeService');
jest.mock('../services/chatbotService');
jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
}));

// Import controller after mocks are set up
const agentModeController = require('../controllers/agentModeController').agentModeController;

describe('AgentModeController - Work Plan Integration', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  const mockUser = {
    userId: 'user-123',
    email: 'test@example.com',
    role: 'customer',
  };

  const mockSession = {
    sessionId: 'session-456',
    userId: 'user-123',
    messages: [
      {
        role: 'user',
        content: 'Start onboarding',
        timestamp: '2025-01-15T09:00:00.000Z',
      },
    ],
    createdAt: '2025-01-15T09:00:00.000Z',
    updatedAt: '2025-01-15T09:00:00.000Z',
  };

  const mockWorkPlan = {
    title: 'Client Onboarding',
    steps: [
      {
        stepCount: 1,
        title: 'Analyze website',
        status: 'completed' as const,
        completedAt: '2025-01-15T10:00:00.000Z',
      },
      {
        stepCount: 2,
        title: 'Update guidelines',
        status: 'pending' as const,
      },
    ],
    createdAt: '2025-01-15T09:30:00.000Z',
    updatedAt: '2025-01-15T10:00:00.000Z',
  };

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnThis();

    mockRequest = {
      user: mockUser as any,
      body: {
        sessionId: 'session-456',
        userMessage: 'Continue with next step',
      },
    };

    mockResponse = {
      json: jsonMock,
      status: statusMock,
    };

    jest.clearAllMocks();
  });

  describe('generateResponse with work plan', () => {
    it('should include workPlan in response when Emma creates one', async () => {
      const mockResponseMessages = [
        {
          role: 'assistant',
          content: "I've created a work plan for your onboarding",
          timestamp: '2025-01-15T10:00:00.000Z',
        },
      ];

      (chatbotDb.getChatSession as jest.Mock)
        .mockResolvedValueOnce(mockSession) // First call (before adding user message)
        .mockResolvedValueOnce({
          ...mockSession,
          messages: [
            ...mockSession.messages,
            {
              role: 'user',
              content: 'Continue with next step',
              timestamp: '2025-01-15T10:00:00.000Z',
            },
          ],
        }) // Second call (after adding user message)
        .mockResolvedValueOnce({
          ...mockSession,
          workPlan: mockWorkPlan,
        }); // Third call (final session with workPlan)

      (chatbotDb.addMessageToSession as jest.Mock).mockResolvedValue(undefined);
      (chatbotDb.addMessagesToSession as jest.Mock).mockResolvedValue(undefined);
      (chatbotDb.updateSessionTitle as jest.Mock).mockResolvedValue(undefined);

      (agentModeService.generateMarketingResponse as jest.Mock).mockResolvedValue({
        content: "I've created a work plan for your onboarding",
        toolCalls: [
          {
            id: 'call_123',
            type: 'function',
            function: {
              name: 'create_work_plan',
              arguments: JSON.stringify({
                title: 'Client Onboarding',
                steps: [
                  { stepCount: 1, title: 'Analyze website' },
                  { stepCount: 2, title: 'Update guidelines' },
                ],
              }),
            },
          },
        ],
        responseMessages: mockResponseMessages,
        knowledgeBaseQueries: [],
        sources: [],
      });

      (agentModeService.getMarketingSystemPrompt as jest.Mock).mockResolvedValue(
        'You are Emma, a marketing assistant'
      );

      (agentModeService.generateSessionTitle as jest.Mock).mockResolvedValue(
        'Client Onboarding Session'
      );

      await agentModeController.generateResponse(
        mockRequest as Request,
        mockResponse as Response
      );

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "I've created a work plan for your onboarding",
          toolCalls: expect.any(Array),
          workPlan: mockWorkPlan,
        })
      );
    });

    it('should include updated workPlan when status changes', async () => {
      const updatedWorkPlan = {
        ...mockWorkPlan,
        steps: [
          {
            ...mockWorkPlan.steps[0],
            status: 'completed' as const,
          },
          {
            ...mockWorkPlan.steps[1],
            status: 'completed' as const,
            completedAt: '2025-01-15T11:00:00.000Z',
          },
        ],
        updatedAt: '2025-01-15T11:00:00.000Z',
      };

      (chatbotDb.getChatSession as jest.Mock)
        .mockResolvedValueOnce({ ...mockSession, workPlan: mockWorkPlan })
        .mockResolvedValueOnce({ ...mockSession, workPlan: mockWorkPlan })
        .mockResolvedValueOnce({ ...mockSession, workPlan: updatedWorkPlan });

      (chatbotDb.addMessageToSession as jest.Mock).mockResolvedValue(undefined);
      (chatbotDb.addMessagesToSession as jest.Mock).mockResolvedValue(undefined);

      (agentModeService.generateMarketingResponse as jest.Mock).mockResolvedValue({
        content: 'Step 2 completed!',
        toolCalls: [],
        responseMessages: [
          {
            role: 'assistant',
            content: 'Step 2 completed!',
            timestamp: '2025-01-15T11:00:00.000Z',
          },
        ],
        knowledgeBaseQueries: [],
        sources: [],
      });

      await agentModeController.generateResponse(
        mockRequest as Request,
        mockResponse as Response
      );

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          workPlan: updatedWorkPlan,
        })
      );
    });

    it('should include undefined workPlan when none exists', async () => {
      (chatbotDb.getChatSession as jest.Mock)
        .mockResolvedValueOnce(mockSession)
        .mockResolvedValueOnce(mockSession)
        .mockResolvedValueOnce(mockSession); // No workPlan

      (chatbotDb.addMessageToSession as jest.Mock).mockResolvedValue(undefined);
      (chatbotDb.addMessagesToSession as jest.Mock).mockResolvedValue(undefined);

      (agentModeService.generateMarketingResponse as jest.Mock).mockResolvedValue({
        content: 'How can I help?',
        toolCalls: [],
        responseMessages: [
          {
            role: 'assistant',
            content: 'How can I help?',
            timestamp: '2025-01-15T10:00:00.000Z',
          },
        ],
        knowledgeBaseQueries: [],
        sources: [],
      });

      await agentModeController.generateResponse(
        mockRequest as Request,
        mockResponse as Response
      );

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          workPlan: undefined,
        })
      );
    });
  });

  describe('generateConversableResponse with work plan', () => {
    beforeEach(() => {
      mockRequest = {
        body: {
          userMessage: 'What is the status?',
        },
        conversableSession: mockSession,
      } as any;
    });

    it('should include workPlan in conversable response', async () => {
      (chatbotDb.getChatSession as jest.Mock)
        .mockResolvedValueOnce(mockSession)
        .mockResolvedValueOnce(mockSession)
        .mockResolvedValueOnce({ ...mockSession, workPlan: mockWorkPlan });

      (chatbotDb.addMessageToSession as jest.Mock).mockResolvedValue(undefined);
      (chatbotDb.addMessagesToSession as jest.Mock).mockResolvedValue(undefined);

      (agentModeService.generateMarketingResponse as jest.Mock).mockResolvedValue({
        content: 'Here is the current status',
        toolCalls: [],
        responseMessages: [
          {
            role: 'assistant',
            content: 'Here is the current status',
            timestamp: '2025-01-15T10:00:00.000Z',
          },
        ],
        knowledgeBaseQueries: [],
        sources: [],
      });

      await agentModeController.generateConversableResponse(
        mockRequest as Request,
        mockResponse as Response
      );

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Here is the current status',
          workPlan: mockWorkPlan,
        })
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle errors when fetching updated session fails', async () => {
      (chatbotDb.getChatSession as jest.Mock)
        .mockResolvedValueOnce(mockSession)
        .mockResolvedValueOnce(mockSession)
        .mockRejectedValueOnce(new Error('Database error'));

      (chatbotDb.addMessageToSession as jest.Mock).mockResolvedValue(undefined);
      (chatbotDb.addMessagesToSession as jest.Mock).mockResolvedValue(undefined);

      (agentModeService.generateMarketingResponse as jest.Mock).mockResolvedValue({
        content: 'Response',
        toolCalls: [],
        responseMessages: [
          {
            role: 'assistant',
            content: 'Response',
            timestamp: '2025-01-15T10:00:00.000Z',
          },
        ],
        knowledgeBaseQueries: [],
        sources: [],
      });

      await agentModeController.generateResponse(
        mockRequest as Request,
        mockResponse as Response
      );

      // Should still handle the error gracefully
      expect(statusMock).toHaveBeenCalledWith(500);
    });
  });
});

