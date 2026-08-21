import { Request, Response } from 'express';

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    getSupportedModels: jest.fn().mockResolvedValue(['gpt-5-chat-2']),
    resolveGenerationModel: jest.fn((model: string) => ({
      model,
      fellBack: false,
      requestedModel: model,
    })),
  },
  AgentModeService: jest.fn(),
}));

jest.mock('../services/llmUsagePolicyResolverService', () => ({
  getEffectiveLlmUsagePolicy: jest.fn().mockResolvedValue({
    billingUserId: 'test-user-123',
    policy: null,
    costUsedMicroUsd: 0,
    tokenUsed: 0,
    mode: { usageMode: 'full_choice', reason: 'no_policy' },
  }),
}));

import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    getUserSessions: jest.fn(),
    updateSessionLlmModel: jest.fn(),
  }
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;

describe('AgentModeController - createSession', () => {
  const mockUserId = 'test-user-123';
  const mockSession = {
    sessionId: 'test-session-123',
    userId: mockUserId,
    title: 'New Chat Session',
    messages: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    portalType: 'agent' as const,
    pageIdentifier: 'agent-mode',
    sessionType: 'regular' as const,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.createChatSession.mockResolvedValue(mockSession as any);
    // Mock updateSessionLlmModel to return session with llmModel
    mockChatbotDb.updateSessionLlmModel = jest.fn().mockResolvedValue({
      ...mockSession,
      llmModel: 'gpt-5-chat-2',
    } as any);
  });

  it('should create session with default sessionType "regular"', async () => {
    const mockReq = {
      user: { userId: mockUserId },
      body: {
        portalType: 'agent',
        pageIdentifier: 'agent-mode'
      }
    } as unknown as Request;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await agentModeController.createSession(mockReq, mockRes);

    expect(mockChatbotDb.createChatSession).toHaveBeenCalledWith(
      mockUserId,
      undefined,
      'agent',
      'agent-mode',
      undefined,
      undefined,
      undefined,
      undefined,
      'regular',
      undefined // delegateInfo
    );
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(
      mockSession.sessionId,
      'gpt-5-chat-2',
      expect.objectContaining({
        requestedModel: 'gpt-5-chat-2',
        effectiveModel: 'gpt-5-chat-2',
        modelSelection: 'honored',
        usageMode: 'full_choice',
      }),
    );
    expect(mockRes.status).toHaveBeenCalledWith(201);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      ...mockSession,
      llmModel: 'gpt-5-chat-2',
      requestedModel: 'gpt-5-chat-2',
      effectiveModel: 'gpt-5-chat-2',
      modelSelection: 'honored',
      usageMode: 'full_choice',
    }));
  });

  it('should create session with sessionType "image-generation" when provided', async () => {
    const mockSessionWithImageType = {
      ...mockSession,
      sessionType: 'image-generation' as const,
    };
    mockChatbotDb.createChatSession.mockResolvedValue(mockSessionWithImageType as any);
    mockChatbotDb.updateSessionLlmModel = jest.fn().mockResolvedValue({
      ...mockSessionWithImageType,
      llmModel: 'gpt-5-chat-2',
    } as any);

    const mockReq = {
      user: { userId: mockUserId },
      body: {
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        sessionType: 'image-generation'
      }
    } as unknown as Request;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await agentModeController.createSession(mockReq, mockRes);

    expect(mockChatbotDb.createChatSession).toHaveBeenCalledWith(
      mockUserId,
      undefined,
      'agent',
      'agent-mode',
      undefined,
      undefined,
      undefined,
      undefined,
      'image-generation',
      undefined // delegateInfo
    );
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(
      mockSessionWithImageType.sessionId,
      'gpt-5-chat-2',
      undefined,
    );
    expect(mockRes.status).toHaveBeenCalledWith(201);
    expect(mockRes.json).toHaveBeenCalledWith({
      ...mockSessionWithImageType,
      llmModel: 'gpt-5-chat-2',
    });
  });

  it('should handle errors gracefully', async () => {
    mockChatbotDb.createChatSession.mockRejectedValue(new Error('Database error'));

    const mockReq = {
      user: { userId: mockUserId },
      body: {
        portalType: 'agent',
        pageIdentifier: 'agent-mode'
      }
    } as unknown as Request;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await agentModeController.createSession(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({ error: 'Failed to create session' });
  });
});
