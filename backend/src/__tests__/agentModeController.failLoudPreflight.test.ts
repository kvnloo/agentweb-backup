/**
 * FAIL-LOUD at the entry points that bypass resolveEffectiveModelForUser and run
 * the SESSION-STORED model through a person's action (conversable, verifiedGenerate):
 * a retired stored model 422s BEFORE any write or worker dispatch. generateSessionResponse
 * itself stays lenient so system-assigned flows (Slack, GTM, ...) keep the fallback.
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

const UNSERVED = 'retired-model-9';

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
const SHARED_MESSAGE = "This shared conversation can't continue right now because its model is no longer available. Ask the person who shared it to choose another model.";

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

const expectZeroWrites = () => {
  expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
  expect(mockChatbotDb.addMessagesToSession).not.toHaveBeenCalled();
  expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
  expect(mockChatbotDb.updateSessionTitle).not.toHaveBeenCalled();
  expect(mockWorker.runInWorker).not.toHaveBeenCalled();
  expect(incrementUserTokenUsage).not.toHaveBeenCalled();
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

describe('conversable generate', () => {
  it('422s with the shared body and leaks no model id or name', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(session(UNSERVED) as any);
    const res = makeRes();
    await agentModeController.generateConversableResponse({
      params: { shareId: SESSION_ID },
      body: { userMessage: MESSAGE, attachments: [] },
      conversableSession: session(UNSERVED),
      on: jest.fn(),
    } as unknown as Request, res);

    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ error: SHARED_MESSAGE, code: 'model_unavailable' });
    expect(JSON.stringify(res.body)).not.toContain(UNSERVED);
    expect(res.body.error.length).toBeGreaterThan(0);
    expectZeroWrites();
  });

  it('happy path unchanged', async () => {
    const res = makeRes();
    await agentModeController.generateConversableResponse({
      params: { shareId: SESSION_ID },
      body: { userMessage: MESSAGE, attachments: [] },
      conversableSession: session('gpt-5.5'),
      on: jest.fn(),
    } as unknown as Request, res);
    expect(res.body).toMatchObject({ content: 'OK' });
  });
});

describe('verifiedGenerate', () => {
  const verifiedReq = () => ({
    user: { userId: OWNER },
    body: { sessionId: SESSION_ID, startingMessage: 'do the thing', requiredFunctions: [], keywords: [], attachments: [] },
    on: jest.fn(),
  } as unknown as Request);

  it('422s with the normal body (no retry, no oncall alert, no 500) for an unserved stored model', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(session(UNSERVED) as any);
    const res = makeRes();
    await agentModeController.verifiedGenerate(verifiedReq(), res);

    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable', requestedModel: UNSERVED, reason: 'not_served' });
    expect(res.body.error).toContain(UNSERVED);
    expect(mockAlert).not.toHaveBeenCalled();
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
    expect(activeSessionGenerations.has(SESSION_ID)).toBe(false);
  });
});
