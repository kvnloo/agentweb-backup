import { Request, Response } from 'express';
import type { WorkPlanInputRequest } from '../services/agentMode/core/workPlanInputRequest';

// Mock all dependencies before importing the controller
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    updateSessionLlmModel: jest.fn(),
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
    getSupportedModels: jest.fn(),
    resolveGenerationModel: jest.fn((model: string) => ({ model, fellBack: false, requestedModel: model })),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
  },
}));

jest.mock('../services/llmUsagePolicyResolverService', () => ({
  getEffectiveLlmUsagePolicy: jest.fn(),
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
  },
}));

jest.mock('../utils/sseProgress', () => ({
  progressStore: {
    delete: jest.fn().mockReturnValue(true),
  },
  getLatestProgress: jest.fn().mockReturnValue(undefined),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false),
  emitProgress: jest.fn(),
}));

// ENG-705: generateSharedResponse now gates on the share owner's token
// allowance before generating. Stub it as "within limits" so these tests keep
// exercising model selection rather than the usage gate (which has its own
// suite in agentModeController.ishareUsageGate.test.ts).
jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({ allowed: true, warning: false, percentUsed: 0 }),
  incrementUserTokenUsage: jest.fn(),
}));

// Import mocked services
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { getEffectiveLlmUsagePolicy } from '../services/llmUsagePolicyResolverService';
import { progressStore } from '../utils/sseProgress';
import { agentModeController } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockGenerateMarketingResponseWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockProgressStore = progressStore as jest.Mocked<typeof progressStore>;
const mockGetEffectiveLlmUsagePolicy = getEffectiveLlmUsagePolicy as jest.Mock;

const optimizedPolicy = {
  version: 'starter-v1',
  enforcementState: 'enforce' as const,
  optimizationCostThresholdMicroUsd: 30_000_000,
  hardCostThresholdMicroUsd: 60_000_000,
  optimizedModelIds: ['gemini-3.1-flash-lite'],
  optimizedDefaultModel: 'gemini-3.1-flash-lite',
};

describe('AgentModeController - ishare Model Selection', () => {
  const mockSessionId = 'test-session-123';
  const mockConversableToken = 'test-conversable-token-123';

  const mockSessionWithModel = {
    sessionId: mockSessionId,
    userId: 'test-user-123',
    title: 'Test Session',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    interactiveShareMetadata: {
      isActive: true,
      token: mockConversableToken,
      sharedAt: new Date().toISOString()
    },
    llmModel: 'gemini-3-pro-preview' // Session has a specific model
  };

  const mockSessionWithoutModel = {
    ...mockSessionWithModel,
    llmModel: undefined // Session doesn't have a model set
  };

  const mockResponse = {
    content: 'Test response',
    toolCalls: [],
    knowledgeBaseQueries: [],
    sources: [],
    responseMessages: []
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentModeService.getDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getSupportedModels.mockResolvedValue([
      'gemini-3-pro-preview',
      'gemini-3.1-flash-lite',
      'gpt-5-chat-2',
    ]);
    mockGetEffectiveLlmUsagePolicy.mockResolvedValue({
      billingUserId: 'test-user-123',
      policy: null,
      costUsedMicroUsd: 0,
      tokenUsed: 0,
      mode: { usageMode: 'full_choice', admissionAllowed: true, reason: 'policy_not_enforced' },
    });
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Generated Title');
    mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(mockResponse);
    mockProgressStore.delete.mockReturnValue(true);
  });

  describe('getSharedConversation', () => {
    it('should return session with llmModel when session has model set', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(mockSessionWithModel);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);

      const mockReq = {
        params: { shareId: mockSessionId },
        query: { conversable: mockConversableToken },
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as unknown as Response;

      await agentModeController.getSharedConversation(mockReq, mockRes);

      expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith(mockSessionId);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({
            sessionId: mockSessionId,
            llmModel: 'gemini-3-pro-preview'
          })
        })
      );
    });

    it('ENG-112: a share viewer never receives the branch provenance (source session id/title) on row 0', async () => {
      const origin = { sourceSessionId: 'src-secret-id', sourceTitle: 'Source title', sourceMessageIndex: 2, branchedAt: 'x' };
      mockChatbotDb.getChatSession.mockResolvedValue({
        ...mockSessionWithModel,
        messages: [
          { role: 'system', content: 'SYS', metadata: { timestamp: 't', branchOrigin: origin } },
          { role: 'user', content: 'hi' },
        ],
      } as any);
      (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
      const mockReq = { params: { shareId: mockSessionId }, query: { conversable: mockConversableToken }, on: jest.fn() } as unknown as Request;
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;

      await agentModeController.getSharedConversation(mockReq, mockRes);

      const body = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(body.session.messages.length).toBeGreaterThan(0);
      expect(JSON.stringify(body)).not.toContain('src-secret-id');
      expect(JSON.stringify(body)).not.toContain('branchOrigin');
    });

    it('ENG-112: a share viewer never receives the session-level branchedFrom link', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue({
        ...mockSessionWithModel,
        branchedFrom: { sessionId: 'src-secret-id', rootSessionId: 'root-secret-id', messageIndex: 2, branchedAt: 'x' },
      } as any);
      (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
      const mockReq = { params: { shareId: mockSessionId }, query: { conversable: mockConversableToken }, on: jest.fn() } as unknown as Request;
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
      await agentModeController.getSharedConversation(mockReq, mockRes);
      const body = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(body.session.sessionId).toBe(mockSessionId);
      expect(JSON.stringify(body)).not.toContain('branchedFrom');
      expect(JSON.stringify(body)).not.toContain('root-secret-id');
    });

    it('ENG-112: the conversable session endpoint never serialises the session-level branchedFrom link', async () => {
      mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2' as any);
      const mockReq = {
        params: { sessionId: mockSessionId },
        conversableSession: { ...mockSessionWithModel, branchedFrom: { sessionId: 'src-secret-id', rootSessionId: 'root-secret-id', messageIndex: 2, branchedAt: 'x' } },
      } as unknown as Request;
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
      await agentModeController.getConversableSession(mockReq, mockRes);
      const body = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(body.sessionId).toBe(mockSessionId);
      expect(JSON.stringify(body)).not.toContain('branchedFrom');
      expect(JSON.stringify(body)).not.toContain('root-secret-id');
    });

    it('ENG-112: the conversable (plan/ishare) session endpoint never serialises the branch provenance either', async () => {
      const origin = { sourceSessionId: 'src-secret-id', sourceTitle: 'Source title', sourceMessageIndex: 2, branchedAt: 'x' };
      mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2' as any);
      const mockReq = {
        params: { sessionId: mockSessionId },
        conversableSession: {
          ...mockSessionWithModel,
          messages: [
            { role: 'system', content: 'SYS', metadata: { timestamp: 't', branchOrigin: origin } },
            { role: 'user', content: 'hi' },
          ],
        },
      } as unknown as Request;
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;

      await agentModeController.getConversableSession(mockReq, mockRes);

      const body = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(body.messages.length).toBeGreaterThan(0);
      expect(JSON.stringify(body)).not.toContain('src-secret-id');
      expect(JSON.stringify(body)).not.toContain('branchOrigin');
    });

    it('ENG-113: a share/ishare viewer never receives the saved Compare alternatives (unchosen answers)', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue({
        ...mockSessionWithModel,
        messages: [
          { role: 'system', content: 'SYS', metadata: { timestamp: 't' } },
          { role: 'user', content: 'hi' },
          {
            role: 'assistant', content: 'chosen answer', llm: 'gpt-5.5',
            metadata: { timestamp: 't', compareId: 'cmp-1', compareAlternatives: [{ model: 'm2', name: 'M2', provider: 'p', content: 'SECRET-UNCHOSEN-ANSWER', latencyMs: 1 }] },
          },
        ],
      } as any);
      (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
      const mockReq = { params: { shareId: mockSessionId }, query: { conversable: mockConversableToken }, on: jest.fn() } as unknown as Request;
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;

      await agentModeController.getSharedConversation(mockReq, mockRes);

      const body = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(JSON.stringify(body)).toContain('chosen answer');
      expect(JSON.stringify(body)).not.toContain('SECRET-UNCHOSEN-ANSWER');
      expect(JSON.stringify(body)).not.toContain('compareAlternatives');
    });

    it('ENG-113: the conversable (plan/ishare) session endpoint never serialises the saved Compare alternatives', async () => {
      mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2' as any);
      const mockReq = {
        params: { sessionId: mockSessionId },
        conversableSession: {
          ...mockSessionWithModel,
          messages: [
            { role: 'system', content: 'SYS', metadata: { timestamp: 't' } },
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'chosen answer', llm: 'gpt-5.5', metadata: { timestamp: 't', compareAlternatives: [{ model: 'm2', name: 'M2', provider: 'p', content: 'SECRET-UNCHOSEN-ANSWER', latencyMs: 1 }] } },
          ],
        },
      } as unknown as Request;
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;

      await agentModeController.getConversableSession(mockReq, mockRes);

      const body = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(JSON.stringify(body)).toContain('chosen answer');
      expect(JSON.stringify(body)).not.toContain('SECRET-UNCHOSEN-ANSWER');
    });

    it('should return session with default model when session does not have model set', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(mockSessionWithoutModel);

      const mockReq = {
        params: { shareId: mockSessionId },
        query: { conversable: mockConversableToken },
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as unknown as Response;

      await agentModeController.getSharedConversation(mockReq, mockRes);

      expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith(mockSessionId);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({
            sessionId: mockSessionId,
            llmModel: 'gpt-5-chat-2' // Should use default model
          })
        })
      );
    });

    // ENG-1635/1644 PR2: the pendingUserQuestion-exposure test that lived here
    // (ENG-396) is deleted — getSharedConversation no longer sends that field
    // at all, since nothing ever populates session.pendingUserQuestion anymore
    // (see the dedicated pendingApprovalDeck coverage right below, its
    // deck-of-one successor).

    // ENG-1635/1644 (ask_user_question retirement): found live, driving a real
    // deck-of-one through an interactive share link on env1 — this field was
    // missing entirely (pendingUserQuestion/pendingWorkPlanInput above were both
    // already exposed; pendingApprovalDeck, their sibling, was not). Without it,
    // a migrated ask_user_question/objective-gate halt (which no longer
    // populates pendingUserQuestion at all) rendered as the plain-text fallback
    // in ishare instead of a real card — the exact regression this migration's
    // own ishare-parity fix (useAgentModeSessions.ts) was supposed to prevent,
    // just one layer further back (the backend never sent the field the
    // frontend fix was reading).
    it('should expose pendingApprovalDeck so a shared card can render a deck-of-one halt (ENG-1635/1644)', async () => {
      const awaitingDeck = {
        deckId: 'deck-objective-1',
        status: 'awaiting',
        items: [
          {
            itemId: 'item-1',
            kind: 'meta_objective',
            question: 'Which Meta campaign objective should this campaign use?',
            options: [
              { id: 'leads', label: 'Leads', consequence: 'Optimizes for leads', recommended: true, why: 'pixel fires LEAD events' },
              { id: 'traffic', label: 'Traffic', consequence: 'Optimizes for clicks' },
            ],
            allowEmmaDecide: true,
            immutable: true,
          },
        ],
        createdAt: new Date().toISOString(),
      };
      mockChatbotDb.getChatSession.mockResolvedValue({
        ...mockSessionWithModel,
        pendingApprovalDeck: awaitingDeck as any,
      });

      const mockReq = {
        params: { shareId: mockSessionId },
        query: { conversable: mockConversableToken },
        on: jest.fn(),
      } as unknown as Request;
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as Response;

      await agentModeController.getSharedConversation(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({
            pendingApprovalDeck: expect.objectContaining({
              deckId: 'deck-objective-1',
              status: 'awaiting',
              items: expect.arrayContaining([
                expect.objectContaining({ itemId: 'item-1', kind: 'meta_objective', immutable: true }),
              ]),
            }),
          }),
        }),
      );
    });

    it('should expose a pending work-plan input request to interactive plan clients', async () => {
      const pendingWorkPlanInput: WorkPlanInputRequest = {
        requestId: 'request-1',
        stepCount: 1,
        title: 'Connect your event',
        prompt: 'Add the guest-list URL and registration window.',
        fields: [
          { id: 'guestListUrl', label: 'Guest-list URL', type: 'url', required: true },
        ],
        status: 'awaiting',
        createdAt: new Date().toISOString(),
      };
      mockChatbotDb.getChatSession.mockResolvedValue({
        ...mockSessionWithModel,
        pendingWorkPlanInput,
      });

      const mockReq = {
        params: { shareId: mockSessionId },
        query: { conversable: mockConversableToken },
        on: jest.fn(),
      } as unknown as Request;
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as Response;

      await agentModeController.getSharedConversation(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({
            pendingWorkPlanInput: {
              requestId: 'request-1',
              stepCount: 1,
              title: 'Connect your event',
              prompt: 'Add the guest-list URL and registration window.',
              fields: [{ id: 'guestListUrl', label: 'Guest-list URL', type: 'url', required: true }],
              status: 'awaiting',
              createdAt: pendingWorkPlanInput.createdAt,
            },
          }),
        }),
      );
    });
  });

  describe('generateSharedResponse', () => {
    it('should use session llmModel when session has model set (ignore request body model)', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(mockSessionWithModel);

      const mockReq = {
        params: { shareId: mockSessionId },
        query: { conversable: mockConversableToken },
        body: {
          userMessage: 'Test message',
          llmModel: 'gpt-4', // Different model in request body - should be ignored
          attachments: []
        },
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis()
      } as unknown as Response;

      await agentModeController.generateSharedResponse(mockReq, mockRes);

      expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith(mockSessionId);
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          llmModel: 'gemini-3-pro-preview' // Should use session's model, not request body's
        }),
        expect.any(Function)
      );
      expect(mockRes.json).toHaveBeenCalled();
    });

    it('should use default model when session does not have model set', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(mockSessionWithoutModel);

      const mockReq = {
        params: { shareId: mockSessionId },
        query: { conversable: mockConversableToken },
        body: {
          userMessage: 'Test message',
          llmModel: 'gpt-4', // Request body model should be ignored
          attachments: []
        },
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis()
      } as unknown as Response;

      await agentModeController.generateSharedResponse(mockReq, mockRes);

      expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith(mockSessionId);
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          llmModel: 'gpt-5-chat-2' // Should use default model
        }),
        expect.any(Function)
      );
      expect(mockRes.json).toHaveBeenCalled();
    });

    it('honors a stored premium model on a shared session past the former optimization threshold (ENG-1211)', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(mockSessionWithModel);
      mockGetEffectiveLlmUsagePolicy.mockResolvedValue({
        billingUserId: 'test-user-123',
        policy: optimizedPolicy,
        costUsedMicroUsd: 30_000_000,
        tokenUsed: 1,
        mode: { usageMode: 'optimized', admissionAllowed: true, reason: 'optimization_threshold_reached' },
      });

      const req = {
        params: { shareId: mockSessionId },
        query: { conversable: mockConversableToken },
        body: { userMessage: 'Test message', attachments: [] },
        on: jest.fn(),
      } as unknown as Request;
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response;

      await agentModeController.generateSharedResponse(req, res);

      // The stored model is dispatched unchanged; provider failure handling stays
      // inside the single OpenRouter request.
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          llmModel: 'gemini-3-pro-preview',
        }),
        expect.any(Function),
      );
    });

    it('stamps the honored model on an unstamped legacy shared session (ENG-1211)', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(mockSessionWithModel);
      mockAgentModeService.getSupportedModels.mockResolvedValue([
        'gemini-3-pro-preview',
        'gemini-3.1-flash-lite',
        'anthropic.claude-haiku-4-5-20251001-v1:0',
        'gpt-5-chat-2',
      ]);
      mockGetEffectiveLlmUsagePolicy.mockResolvedValue({
        billingUserId: 'test-user-123',
        policy: {
          ...optimizedPolicy,
          optimizedModelIds: ['gemini-3.1-flash-lite', 'anthropic.claude-haiku-4-5-20251001-v1:0'],
        },
        costUsedMicroUsd: 30_000_000,
        tokenUsed: 1,
        mode: { usageMode: 'optimized', admissionAllowed: true, reason: 'optimization_threshold_reached' },
      });

      const req = {
        params: { shareId: mockSessionId },
        query: { conversable: mockConversableToken },
        body: { userMessage: 'Test message', attachments: [] },
        on: jest.fn(),
      } as unknown as Request;
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response;

      await agentModeController.generateSharedResponse(req, res);

      // The session is stamped with the model policy actually honored.
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenLastCalledWith(
        mockSessionId,
        'gemini-3-pro-preview',
        expect.objectContaining({
          effectiveModel: 'gemini-3-pro-preview',
          modelSelection: 'honored',
          modelSelectionReason: 'requested_model_allowed',
        }),
      );
    });

    it('makes no provider call when the shared-session owner is paused by cost policy', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(mockSessionWithModel);
      mockGetEffectiveLlmUsagePolicy.mockResolvedValue({
        billingUserId: 'test-user-123',
        policy: optimizedPolicy,
        costUsedMicroUsd: 60_000_000,
        tokenUsed: 1,
        mode: { usageMode: 'paused', admissionAllowed: false, reason: 'hard_threshold_reached' },
      });

      const req = {
        params: { shareId: mockSessionId },
        query: { conversable: mockConversableToken },
        body: { userMessage: 'Test message', attachments: [] },
        on: jest.fn(),
      } as unknown as Request;
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response;

      await agentModeController.generateSharedResponse(req, res);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).not.toHaveBeenCalled();
    });

    it('should return 401 if conversable token is missing', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(mockSessionWithModel);

      const mockReq = {
        params: { shareId: mockSessionId },
        query: {}, // No conversable token
        body: {
          userMessage: 'Test message',
          attachments: []
        },
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis()
      } as unknown as Response;

      await agentModeController.generateSharedResponse(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Conversable token required' });
    });

    it('should return 401 if conversable token does not match', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(mockSessionWithModel);

      const mockReq = {
        params: { shareId: mockSessionId },
        query: { conversable: 'wrong-token' },
        body: {
          userMessage: 'Test message',
          attachments: []
        },
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis()
      } as unknown as Response;

      await agentModeController.generateSharedResponse(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Invalid or expired conversable token' });
    });
  });
});
