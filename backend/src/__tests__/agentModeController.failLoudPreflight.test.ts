/**
 * Entry points that run the SESSION-STORED model (conversable, verifiedGenerate). A model
 * merely STORED on a session is NOT an explicit selection (only a request-carried model or
 * a schedule pin is), so a retired / internalOnly / live-voice stored model never 422s:
 * it falls back to the current default (conversable, verifiedGenerate stores the default
 * on the session first). generateSessionResponse stays lenient for system-assigned flows
 * (Slack, GTM, ...).
 */
import { Request, Response } from 'express';

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
const UNSERVED = 'retired-model-9';

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    getReportsModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    getCustomerSupportDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    // internalOnly ids are registry keys but excluded from the supported set.
    // Like the real getSupportedModels(false), the live-voice id IS in the supported set.
    getSupportedModels: jest.fn(async () => ['gpt-5-chat-2', 'gemini-3.5-flash', 'gpt-5.5', 'live-voice-1']),
    isLiveModel: jest.fn((id: string) => id === 'live-voice-1'),
    // Mirrors the real behaviour: unknown ids fall back to the default, registry ids pass.
    resolveGenerationModel: jest.fn((model: string) => {
      const registry = new Set(['gpt-5-chat-2', 'gemini-3.5-flash', 'gpt-5.5', 'internal-judge-1', 'legacy-old-alias-target', 'live-voice-1']);
      const normalized = model === 'legacy-old-alias' ? 'legacy-old-alias-target' : model;
      return registry.has(normalized)
        ? { model: normalized, fellBack: false, requestedModel: model }
        : { model: 'gpt-5-chat-2', fellBack: true, requestedModel: model };
    }),
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
  generateSessionResponse,
} from '../controllers/agentModeController';
import { ModelUnavailableError } from '../services/agentMode/modelUnavailable';
import { isTransientLLMError, isSessionLimitError } from '../utils/agentModeErrors';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { incrementUserTokenUsage } from '../services/tokenUsageService';
import { getEffectiveLlmUsagePolicy } from '../services/llmUsagePolicyResolverService';
import { checkTokenUsage } from '../services/tokenUsageService';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockAlert = sendAgentModeOncallAlert as jest.Mock;

const OWNER = 'user-owner';
const SESSION_ID = 'session-1';
const MESSAGE = 'hello';

const session = (llmModel?: string) => ({
  sessionId: SESSION_ID, userId: OWNER, sessionType: 'regular', title: 'Chat', messages: [],
  createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
  portalType: 'agent' as const, pageIdentifier: 'agent-mode',
  interactiveShareMetadata: { isActive: true, token: 'tok', sharedAt: '2026-07-01T00:00:00Z' },
  ...(llmModel ? { llmModel } : {}),
});

const makeRes = () => {
  const res: any = { statusCode: 200, body: undefined, headersSent: false };
  res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
  res.json = jest.fn((p: any) => { res.body = p; return res; });
  return res as Response & { statusCode: number; body: any };
};


beforeEach(() => {
  jest.clearAllMocks();
  activeSessionGenerations.clear();
  (getEffectiveLlmUsagePolicy as jest.Mock).mockResolvedValue({
    billingUserId: OWNER, policy: null, costUsedMicroUsd: 0, tokenUsed: 0,
    mode: { usageMode: 'full_choice', admissionAllowed: true, reason: 'policy_not_enforced' },
  });
  (checkTokenUsage as jest.Mock).mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null, bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-07',
  });
  mockChatbotDb.getChatSession.mockResolvedValue(session('gpt-5.5') as any);
  (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
  mockChatbotDb.addMessageToSession.mockResolvedValue(session() as any);
  mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
  mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
  mockChatbotDb.updateSessionLlmModel.mockResolvedValue(session() as any);
  mockWorker.runInWorker.mockResolvedValue({ content: 'OK', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] } as any);
});

describe('generateSessionResponse (system-assigned flows keep the fallback)', () => {
  it('does NOT throw for a stale stored model: Slack/GTM/onboarding have no picker, so it runs on the fallback', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(session(UNSERVED) as any);
    await expect(generateSessionResponse(SESSION_ID, MESSAGE, OWNER, UNSERVED)).resolves.toBeDefined();
    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('the typed error is neither transient nor session-limit, so runVerifiedChat never retries it', () => {
    const err = new ModelUnavailableError(UNSERVED, 'not_served');
    expect(isTransientLLMError(err)).toBe(false);
    expect(isSessionLimitError(err)).toBe(false);
  });
});

describe('conversable generate (visitor selects nothing)', () => {
  it('a stored retired model falls back to the default: no 422, runs', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(session(UNSERVED) as any);
    const res = makeRes();
    await agentModeController.generateConversableResponse({
      params: { shareId: SESSION_ID },
      body: { userMessage: MESSAGE, attachments: [] },
      conversableSession: session(UNSERVED),
      on: jest.fn(),
    } as unknown as Request, res);

    expect(res.statusCode).not.toBe(422);
    expect(res.body).toMatchObject({ content: 'OK' });
  });

  it('a stored internalOnly model runs on the default, never the stored one', async () => {
    const res = makeRes();
    await agentModeController.generateConversableResponse({
      params: { shareId: SESSION_ID },
      body: { userMessage: MESSAGE, attachments: [] },
      conversableSession: session('internal-judge-1'),
      on: jest.fn(),
    } as unknown as Request, res);
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: DEFAULT_MODEL }), expect.anything());
  });
});

describe('conversable generate: stored live-voice model', () => {
  it('runs a text chat on the default, never the live id', async () => {
    const res = makeRes();
    await agentModeController.generateConversableResponse({
      params: { shareId: SESSION_ID },
      body: { userMessage: MESSAGE, attachments: [] },
      conversableSession: session('live-voice-1'),
      on: jest.fn(),
    } as unknown as Request, res);
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: DEFAULT_MODEL }), expect.anything());
  });
});

describe('verifiedGenerate (stored model is not a selection)', () => {
  const verifiedReq = () => ({
    user: { userId: OWNER },
    body: { sessionId: SESSION_ID, startingMessage: 'do the thing', requiredFunctions: [], keywords: [], attachments: [] },
    on: jest.fn(),
  } as unknown as Request);

  it.each([UNSERVED, 'internal-judge-1'])('a stored %s model runs on the default: no 422, no 500, never the stored model', async (stored) => {
    mockChatbotDb.getChatSession.mockResolvedValue(session(stored) as any);
    const res = makeRes();
    await agentModeController.verifiedGenerate(verifiedReq(), res);

    expect(res.statusCode).not.toBe(422);
    expect(res.statusCode).not.toBe(500);
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('a stored live-voice model is replaced by the default before the run reads the session', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(session('live-voice-1') as any);
    await agentModeController.verifiedGenerate(verifiedReq(), makeRes());
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, DEFAULT_MODEL, expect.anything(), 'system');
  });

  it('a stored internalOnly model is replaced by the default before the run reads the session', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(session('internal-judge-1') as any);
    await agentModeController.verifiedGenerate(verifiedReq(), makeRes());
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, DEFAULT_MODEL, expect.anything(), 'system');
  });
});
