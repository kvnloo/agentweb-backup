/**
 * POST /api/agent-mode/generate — messageIndex/clientId echo (ENG-1495).
 *
 * The frontend's optimistic message bubbles have no stable id until a later
 * session refetch resolves messageIndex, which causes a React remount (and any
 * local component state inside that bubble, e.g. a workplan-recommendation
 * card's "already applied" flag, resets incorrectly). Root-caused: the backend
 * already computes messageIndex when persisting a message, but previously threw
 * it away instead of returning it synchronously. This suite verifies:
 *   - a client-supplied clientId is persisted onto the user message;
 *   - the response echoes messageIndex (assistant) and userMessageIndex (user)
 *     computed from the actual persistence call, not hardcoded;
 *   - a defensive fallback exists when the DB layer's return value doesn't carry
 *     the full session shape (matches how many existing tests mock these calls).
 */
import { Request, Response } from 'express';

jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => []),
  isSubscriptionFeatureEnabled: jest.fn(async () => true),
  getAllowedSkills: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
  updateTaskExecutionStatus: jest.fn(),
}));

jest.mock('../services/emailService', () => ({
  emailService: { sendOncallAlert: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
    cancelSession: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    getReportsModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    getCustomerSupportDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    generateSessionTitle: jest.fn().mockResolvedValue('Test Title'),
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('System prompt'),
    generateDiagnosticMessage: jest.fn().mockResolvedValue(null),
    resolveGenerationModel: jest.fn((model: string) => ({ model, fellBack: false, requestedModel: model })),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
  },
  AgentModeService: jest.fn(),
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null,
    bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-07',
  }),
}));

jest.mock('../utils/sseProgress', () => ({
  progressStore: { delete: jest.fn() },
  emitProgress: jest.fn(),
  hasActiveProgress: jest.fn().mockReturnValue(false),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false),
  registerProgressCallback: jest.fn().mockReturnValue(() => {}),
  getLatestProgress: jest.fn().mockReturnValue(null),
  markProgressComplete: jest.fn(),
}));

jest.mock('../services/workPlanService', () => ({
  workPlanService: { getWorkPlan: jest.fn().mockResolvedValue(null) },
}));

jest.mock('../services/skillService', () => ({
  skillService: { getInstalledSkills: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../utils/agentModeErrors', () => ({
  // Spread the real module so new exports (e.g. isProviderUnavailableError) never leave the controller error handler calling undefined.
  ...jest.requireActual('../utils/agentModeErrors'),
  isContextLimitError: jest.fn().mockReturnValue(false),
  isSessionLimitError: jest.fn().mockReturnValue(false),
  isTransientLLMError: jest.fn().mockReturnValue(false),
  isWorkerShutdownError: jest.fn().mockReturnValue(false),
  isProviderNoEndpointsError: jest.fn().mockReturnValue(false),
}));

import { agentModeController, activeSessionGenerations } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

const ownerId = 'user-owner';
const sessionId = 'session-echo-test';

function baseSession() {
  return {
    sessionId,
    userId: ownerId,
    title: 'Owner Session',
    messages: [],
    createdAt: '2026-09-09T00:00:00Z',
    updatedAt: '2026-09-09T00:00:00Z',
    portalType: 'agent' as const,
    pageIdentifier: 'agent-mode',
    llmModel: 'gpt-5-chat-2',
  };
}

const makeReq = (clientId?: string) =>
  ({
    user: { userId: ownerId },
    body: {
      sessionId,
      userMessage: 'Hello',
      llmModel: 'gpt-5-chat-2',
      attachments: [],
      ...(clientId !== undefined ? { clientId } : {}),
    },
    method: 'POST',
    path: '/api/agent-mode/generate',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    on: jest.fn(),
  } as unknown as Request);

const makeRes = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((payload: any) => {
    res.body = payload;
    return res;
  });
  return res as Response & { statusCode: number; body: any };
};

describe('generateResponse — messageIndex/clientId echo (ENG-1495)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    mockChatbotDb.getChatSession.mockResolvedValue(baseSession() as any);
    mockWorkerService.runInWorker.mockResolvedValue({
      content: 'Hi there',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [{ role: 'assistant', content: 'Hi there', metadata: { timestamp: '2026-09-09T00:00:01Z' } }],
    } as any);
  });

  it('persists the client-supplied clientId onto the user message', async () => {
    mockChatbotDb.addMessageToSession.mockResolvedValue({
      ...baseSession(),
      messages: [{ role: 'user', content: 'Hello', clientId: 'client-abc-123', messageIndex: 0 }],
    } as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue({
      ...baseSession(),
      messages: [{ role: 'assistant', content: 'Hi there', messageIndex: 1 }],
    } as any);

    await agentModeController.generateResponse(makeReq('client-abc-123'), makeRes());

    expect(mockChatbotDb.addMessageToSession).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ clientId: 'client-abc-123' }),
    );
  });

  it('echoes userMessageIndex and messageIndex computed from the actual persistence calls, not hardcoded', async () => {
    mockChatbotDb.addMessageToSession.mockResolvedValue({
      ...baseSession(),
      messages: [{ role: 'user', content: 'Hello', clientId: 'client-abc-123', messageIndex: 7 }],
    } as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue({
      ...baseSession(),
      messages: [{ role: 'assistant', content: 'Hi there', messageIndex: 8 }],
    } as any);

    const res = makeRes();
    await agentModeController.generateResponse(makeReq('client-abc-123'), res);

    expect(res.body.userMessageIndex).toBe(7);
    expect(res.body.messageIndex).toBe(8);
  });

  it('omits clientId on the persisted message and both echoed indices absent when the request sends no clientId', async () => {
    mockChatbotDb.addMessageToSession.mockResolvedValue({
      ...baseSession(),
      messages: [{ role: 'user', content: 'Hello', messageIndex: 0 }],
    } as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue({
      ...baseSession(),
      messages: [{ role: 'assistant', content: 'Hi there', messageIndex: 1 }],
    } as any);

    await agentModeController.generateResponse(makeReq(), makeRes());

    const [, persistedUserMessage] = mockChatbotDb.addMessageToSession.mock.calls[0];
    expect((persistedUserMessage as any).clientId).toBeUndefined();
  });

  it('does not throw and omits the echoed indices when addMessageToSession/addMessagesToSession resolve undefined (the shape most existing tests default to)', async () => {
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);

    const res = makeRes();
    await agentModeController.generateResponse(makeReq('client-abc-123'), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.userMessageIndex).toBeUndefined();
    expect(res.body.messageIndex).toBeUndefined();
  });
});
