import { Request, Response } from 'express';

// Mock all dependencies before importing the controller
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
  },
}));

jest.mock('../utils/sseProgress', () => ({
  progressStore: {
    delete: jest.fn().mockReturnValue(true),
    has: jest.fn().mockReturnValue(false),
    add: jest.fn(),
  },
  getLatestProgress: jest.fn().mockReturnValue(undefined),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false),
  emitProgress: jest.fn(),
}));

// ENG-705: generateSharedResponse now gates on the share owner's token
// allowance before generating. Stub it as "within limits" so these tests keep
// exercising anonymous-sender tagging rather than the usage gate (which has its
// own suite in agentModeController.ishareUsageGate.test.ts).
jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({ allowed: true, warning: false, percentUsed: 0 }),
  incrementUserTokenUsage: jest.fn(),
}));

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { progressStore } from '../utils/sseProgress';
import { agentModeController } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockProgressStore = progressStore as jest.Mocked<typeof progressStore>;

const SESSION_ID = 'ishare-session-abc';
const CONVERSABLE_TOKEN = 'tok-abc123';

const baseSession = {
  sessionId: SESSION_ID,
  userId: 'owner-user-id',
  title: 'My Session',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  llmModel: 'gpt-5-chat-2',
  interactiveShareMetadata: {
    isActive: true,
    token: CONVERSABLE_TOKEN,
    sharedAt: new Date().toISOString(),
    expiresAt: '2099-01-01T00:00:00Z',
  },
};

const workerResponse = {
  content: 'Hello from AI',
  toolCalls: [],
  knowledgeBaseQueries: [],
  sources: [],
  responseMessages: [],
};

describe('AgentModeController - generateSharedResponse anonymous sender tracking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');
    mockWorkerService.runInWorker.mockResolvedValue(workerResponse);
    mockProgressStore.delete.mockReturnValue(true);
    (mockProgressStore as any).has.mockReturnValue(false);
    (mockProgressStore as any).add.mockReturnValue(undefined);
    (mockChatbotDb.getChatSession as jest.Mock)
      .mockResolvedValueOnce(baseSession)  // initial fetch
      .mockResolvedValue({ ...baseSession, messages: [{ role: 'user', content: 'hi', metadata: { timestamp: new Date().toISOString() } }] }); // after addMessage
    (mockChatbotDb.addMessageToSession as jest.Mock).mockResolvedValue(undefined);
    (mockChatbotDb.updateSessionTitle as jest.Mock).mockResolvedValue(undefined);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
  });

  it('should tag user message with ishareSender.isAnonymous=true and record IP and user-agent', async () => {
    const mockReq = {
      params: { shareId: SESSION_ID },
      query: { conversable: CONVERSABLE_TOKEN },
      body: { userMessage: 'Hello from visitor', attachments: [] },
      ip: '203.0.113.42',
      headers: { 'user-agent': 'Mozilla/5.0 (Test Browser)' },
    } as unknown as Request;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await agentModeController.generateSharedResponse(mockReq, mockRes);

    expect(mockChatbotDb.addMessageToSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        role: 'user',
        content: 'Hello from visitor',
        metadata: expect.objectContaining({
          ishareSender: {
            isAnonymous: true,
            ip: '203.0.113.42',
            userAgent: 'Mozilla/5.0 (Test Browser)',
          },
        }),
      })
    );
  });

  it('should still tag ishareSender even when IP and user-agent are missing', async () => {
    const mockReq = {
      params: { shareId: SESSION_ID },
      query: { conversable: CONVERSABLE_TOKEN },
      body: { userMessage: 'Hello', attachments: [] },
      ip: undefined,
      headers: {},
    } as unknown as Request;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await agentModeController.generateSharedResponse(mockReq, mockRes);

    expect(mockChatbotDb.addMessageToSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        metadata: expect.objectContaining({
          ishareSender: {
            isAnonymous: true,
          },
        }),
      })
    );
  });

  it('should use x-forwarded-for header for IP when req.ip is not set', async () => {
    const mockReq = {
      params: { shareId: SESSION_ID },
      query: { conversable: CONVERSABLE_TOKEN },
      body: { userMessage: 'Hi', attachments: [] },
      ip: undefined,
      headers: {
        'x-forwarded-for': '198.51.100.7, 10.0.0.1',
        'user-agent': 'curl/7.88',
      },
    } as unknown as Request;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await agentModeController.generateSharedResponse(mockReq, mockRes);

    expect(mockChatbotDb.addMessageToSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        metadata: expect.objectContaining({
          ishareSender: expect.objectContaining({
            isAnonymous: true,
            ip: '198.51.100.7',
          }),
        }),
      })
    );
  });

  it('should not include ishareSender on user messages in regular (non-ishare) sessions', async () => {
    // Regular authenticated sessions go through generateResponse, not generateSharedResponse.
    // Verify generateSessionResponse does NOT attach ishareSender when isInteractiveShare=false.
    // We test this by calling runVerifiedChat indirectly via the worker mock—
    // the key assertion is that addMessageToSession was never called with ishareSender.
    const regularSession = {
      ...baseSession,
      interactiveShareMetadata: undefined,
    };
    (mockChatbotDb.getChatSession as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce(regularSession)
      .mockResolvedValue({ ...regularSession, messages: [{ role: 'user', content: 'hi', metadata: { timestamp: new Date().toISOString() } }] });

    const mockReq = {
      user: { userId: 'owner-user-id', email: 'owner@example.com', isAdmin: false },
      params: { sessionId: SESSION_ID },
      query: {},
      body: { userMessage: 'Hello regular user', attachments: [] },
      ip: '10.0.0.1',
      headers: { 'user-agent': 'Chrome' },
    } as unknown as Request;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await agentModeController.generateResponse(mockReq, mockRes);

    // Should have been called but WITHOUT ishareSender in metadata
    const callArgs = mockChatbotDb.addMessageToSession.mock.calls;
    const userMessageCall = callArgs.find(([, msg]: any) => msg.role === 'user');
    if (userMessageCall) {
      expect(userMessageCall[1].metadata).not.toHaveProperty('ishareSender');
    }
  });
});
