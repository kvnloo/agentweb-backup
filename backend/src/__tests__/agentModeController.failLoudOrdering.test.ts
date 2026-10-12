/**
 * FAIL-LOUD selected model: ordering guarantees (WP-G). The model is validated
 * BEFORE /generate mutates the session (approval-deck answer/cancel, work-plan input
 * answer), a paused account keeps its 429, and session creation treats only an
 * EXPLICIT requestedLlmModel as a selection. Preamble lifted from
 * agentModeController.failLoudSelectedModel.test.ts.
 */
import { Request, Response } from 'express';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    updateSessionApprovalDeck: jest.fn(),
    updateSessionWorkPlanInputRequest: jest.fn(),
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

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  scheduleDb: {},
  taskDb: {},
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
    cancelSession: jest.fn(),
  },
}));

const DEFAULT_MODEL = 'gpt-5-chat-2';
const SERVED = [DEFAULT_MODEL, 'gemini-3.5-flash', 'gpt-5.5'];
const UNSERVED = 'retired-model-9';
const INTERNAL_ONLY = 'internal-judge-1';
const REGISTRY = new Set([...SERVED, INTERNAL_ONLY, 'legacy-old-alias-target']);

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    getReportsModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    getCustomerSupportDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    // internalOnly ids are registry keys but excluded from the supported set.
    getSupportedModels: jest.fn(async () => ['gpt-5-chat-2', 'gemini-3.5-flash', 'gpt-5.5']),
    // Mirrors the real behaviour: unknown ids fall back to the default, registry ids pass.
    resolveGenerationModel: jest.fn((model: string) => {
      const registry = new Set(['gpt-5-chat-2', 'gemini-3.5-flash', 'gpt-5.5', 'internal-judge-1', 'legacy-old-alias-target']);
      const normalized = model === 'legacy-old-alias' ? 'legacy-old-alias-target' : model;
      return registry.has(normalized)
        ? { model: normalized, fellBack: false, requestedModel: model }
        : { model: 'gpt-5-chat-2', fellBack: true, requestedModel: model };
    }),
    submitApprovalDeckAnswers: jest.fn(),
    getModelDisplayName: jest.fn((id: string) => (id === 'gpt-5.5' ? 'GPT-5.5' : undefined)),
    generateSessionTitle: jest.fn().mockResolvedValue('Test Title'),
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('System prompt'),
    generateDiagnosticMessage: jest.fn().mockResolvedValue(null),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
  },
  AgentModeService: jest.fn(),
}));

jest.mock('../services/llmUsagePolicyResolverService', () => ({
  getEffectiveLlmUsagePolicy: jest.fn(),
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(),
  incrementUserTokenUsage: jest.fn(),
  deriveBlockedByCost: jest.fn(() => ({ blockedByCost: false })),
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
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue([]),
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
}));

import {
  agentModeController,
  activeSessionGenerations,
  resolveEffectiveModelForUser,
} from '../controllers/agentModeController';
import { ModelUnavailableError, buildModelUnavailableBody, isModelUnavailableError } from '../services/agentMode/modelUnavailable';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { userDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { getEffectiveLlmUsagePolicy } from '../services/llmUsagePolicyResolverService';
import { checkTokenUsage, incrementUserTokenUsage } from '../services/tokenUsageService';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockPolicy = getEffectiveLlmUsagePolicy as jest.Mock;
const mockCheckTokenUsage = checkTokenUsage as jest.Mock;
const mockIncrementUsage = incrementUserTokenUsage as jest.Mock;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;

const OWNER = 'user-owner';
const SESSION_ID = 'session-1';
const FULL_CHOICE = { usageMode: 'full_choice', admissionAllowed: true, reason: 'policy_not_enforced' };

const MESSAGE = 'Please draft the launch email';

const expectedMessage = (label: string) =>
  `The model you selected (${label}) isn't available right now, so nothing was sent to a different model. Choose another model and try again.`;

const makeRes = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((payload: any) => { res.body = payload; return res; });
  return res as Response & { statusCode: number; body: any };
};

const generateReq = (body: Record<string, unknown>, isAdmin = false) => ({
  user: { userId: OWNER, isAdmin },
  body: { sessionId: SESSION_ID, userMessage: MESSAGE, attachments: [], ...body },
  method: 'POST',
  path: '/api/agent-mode/generate',
  ip: '127.0.0.1',
  socket: { remoteAddress: '127.0.0.1' },
  on: jest.fn(),
} as unknown as Request);

const baseSession = (llmModel?: string) => ({
  sessionId: SESSION_ID,
  userId: OWNER,
  sessionType: 'regular',
  title: 'Chat',
  messages: [],
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
  portalType: 'agent' as const,
  pageIdentifier: 'agent-mode',
  ...(llmModel ? { llmModel } : {}),
});

const workerResult = { content: 'OK', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] };

beforeEach(() => {
  jest.clearAllMocks();
  activeSessionGenerations.clear();
  mockPolicy.mockResolvedValue({ billingUserId: OWNER, policy: null, costUsedMicroUsd: 0, tokenUsed: 0, mode: FULL_CHOICE });
  mockCheckTokenUsage.mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null, bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-07',
  });
  mockChatbotDb.getChatSession.mockResolvedValue(baseSession('gpt-5.5') as any);
  (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
  mockChatbotDb.addMessageToSession.mockResolvedValue(baseSession() as any);
  mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
  mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
  mockChatbotDb.updateSessionLlmModel.mockResolvedValue(baseSession('gpt-5.5') as any);
  mockChatbotDb.createChatSession.mockResolvedValue(baseSession() as any);
  mockWorker.runInWorker.mockResolvedValue(workerResult as any);
  mockUserDb.getUserById.mockResolvedValue({ userId: OWNER, isAdmin: false } as any);
});


const createReq = (body: Record<string, unknown>) => ({ user: { userId: OWNER }, body } as unknown as Request);

const sessionWithPending = (llmModel?: string) => ({
  ...baseSession(llmModel),
  pendingApprovalDeck: { deckId: 'deck-1', items: [] },
  pendingWorkPlanInput: { requestId: 'req-1', fields: [] },
});

const assertSessionUntouched = () => {
  expect(mockChatbotDb.updateSessionApprovalDeck).not.toHaveBeenCalled();
  expect(mockChatbotDb.updateSessionWorkPlanInputRequest).not.toHaveBeenCalled();
  expect(mockAgentModeService.submitApprovalDeckAnswers).not.toHaveBeenCalled();
  expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
  expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
  expect(mockWorker.runInWorker).not.toHaveBeenCalled();
  expect(activeSessionGenerations.has(SESSION_ID)).toBe(false);
};

describe('/generate validates the model before ANY session mutation', () => {
  beforeEach(() => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWithPending('gpt-5.5') as any);
  });

  it('deck answer + unserved model: 422, pending deck and work-plan state untouched', async () => {
    const res = makeRes();
    await agentModeController.generateResponse(
      generateReq({ llmModel: UNSERVED, deckAnswer: { deckId: 'deck-1', answers: [{ itemId: 'i1', verdict: 'approve' }] } }),
      res,
    );
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable', requestedModel: UNSERVED });
    assertSessionUntouched();
  });

  it('deck cancel + unserved request model: 422, deck not cleared', async () => {
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: UNSERVED, deckCancel: { deckId: 'deck-1' } }), res);
    expect(res.statusCode).toBe(422);
    assertSessionUntouched();
  });

  it('work-plan input answer + unserved model: 422, answer not persisted', async () => {
    const res = makeRes();
    await agentModeController.generateResponse(
      generateReq({ llmModel: UNSERVED, workPlanInputAnswer: { requestId: 'req-1', values: { a: 'b' } } }),
      res,
    );
    expect(res.statusCode).toBe(422);
    assertSessionUntouched();
  });

  it('paused (cost cap) + deck answer + unserved model: plain 429, never 422', async () => {
    mockPolicy.mockResolvedValue({
      billingUserId: OWNER, policy: null, costUsedMicroUsd: 0, tokenUsed: 0,
      mode: { usageMode: 'paused', admissionAllowed: false, reason: 'hard_threshold_reached' },
    });
    const res = makeRes();
    await agentModeController.generateResponse(
      generateReq({ llmModel: UNSERVED, deckCancel: { deckId: 'other' } }),
      res,
    );
    expect(res.statusCode).not.toBe(422);
    expect(res.body?.code).not.toBe('model_unavailable');
  });

  it('exhausted allowance + unserved model keeps the plain usage_paused 429 with its policy fields', async () => {
    mockCheckTokenUsage.mockResolvedValue({
      allowed: false, warning: false, used: 1, allowance: 1, bonus: 0, effectiveAllowance: 1, percentUsed: 100,
      month: '2026-07', usagePolicyVersion: 'v1',
    });
    mockChatbotDb.getChatSession.mockResolvedValue(baseSession('gpt-5.5') as any);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: UNSERVED }), res);
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ code: 'usage_paused', usageMode: 'paused' });
  });

  it('paused + served model: the existing 429 still carries policy fields (blocked decision)', async () => {
    mockPolicy.mockResolvedValue({
      billingUserId: OWNER, policy: null, costUsedMicroUsd: 0, tokenUsed: 0,
      mode: { usageMode: 'paused', admissionAllowed: false, reason: 'hard_threshold_reached' },
    });
    mockChatbotDb.getChatSession.mockResolvedValue(baseSession('gpt-5.5') as any);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: 'gpt-5.5' }), res);
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ code: 'usage_paused', modelSelection: 'blocked' });
  });

  it('no explicit model anywhere: runs on the default (no 422 about a model nobody selected)', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(baseSession() as any);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({}), res);
    expect(res.statusCode).toBe(200);
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: DEFAULT_MODEL }), expect.anything());
  });
});

describe('createSession: only an explicit requestedLlmModel is a selection', () => {
  it('a misconfigured (unserved) default with no explicit model does not 422; the old safety net applies', async () => {
    mockAgentModeService.getDefaultModel.mockResolvedValueOnce(UNSERVED);
    const res = makeRes();
    await agentModeController.createSession(createReq({ portalType: 'agent' }), res);
    expect(res.statusCode).toBe(201);
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, DEFAULT_MODEL, expect.anything());
  });

  it('an explicit unserved requestedLlmModel still 422s', async () => {
    const res = makeRes();
    await agentModeController.createSession(createReq({ portalType: 'agent', llmModel: UNSERVED }), res);
    expect(res.statusCode).toBe(422);
    expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
  });
});
