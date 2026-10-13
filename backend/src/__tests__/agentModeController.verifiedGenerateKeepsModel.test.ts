/**
 * /verified-generate keeps the model the user chose. runVerifiedChat's task-type defaults
 * (report / image / video) are system defaults for callers that pass no model (scheduled,
 * Slack, email, result endpoints, revisions); on the interactive endpoint they must never
 * overwrite a user-picked model, stored (session.llmModel) or explicit (request llmModel).
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
    getReportGenerationDefaultModel: jest.fn().mockResolvedValue('report-model'),
    getImageGenerationDefaultModel: jest.fn().mockResolvedValue('image-model'),
    getVideoGenerationDefaultModel: jest.fn().mockResolvedValue('video-model'),
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
  skillService: { getInstalledSkills: jest.fn().mockResolvedValue([]), getPublishedSkills: jest.fn().mockResolvedValue([]) },
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
  runVerifiedChat,
} from '../controllers/agentModeController';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
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


const verifiedReq = (extra: Record<string, unknown> = {}, requiredFunctions = [{ functionName: 'update_html_file', minCount: 1 }]) => ({
  user: { userId: OWNER },
  body: { sessionId: SESSION_ID, startingMessage: 'do the thing', requiredFunctions, keywords: [], attachments: [], maxAttempts: 1, ...extra },
  on: jest.fn(),
} as unknown as Request);

const modelWrites = () => mockChatbotDb.updateSessionLlmModel.mock.calls.map((c) => c[1]);
const workerModels = () => mockWorker.runInWorker.mock.calls.map((c) => (c[0] as any).llmModel);
const reportTool = { content: 'OK', toolCalls: [{ name: 'update_html_file', result: { success: true } }], knowledgeBaseQueries: [], sources: [], responseMessages: [] };

describe('verifiedGenerate keeps the selected model', () => {
  beforeEach(() => { mockWorker.runInWorker.mockResolvedValue(reportTool as any); });

  it.each([
    ['update_html_file', 'report-model'],
    ['generate_image', 'image-model'],
    ['generate_video', 'video-model'],
  ])('stored model survives a %s task: never overwritten by %s', async (fn, taskModel) => {
    mockChatbotDb.getChatSession.mockResolvedValue(session('gemini-3.5-flash') as any);
    const res = makeRes();
    await agentModeController.verifiedGenerate(verifiedReq({}, [{ functionName: fn, minCount: 1 }]), res);
    expect(modelWrites()).not.toContain(taskModel);
    expect(workerModels()).toEqual(['gemini-3.5-flash']);
  });

  it('an explicit request model wins over the stored one and the task default, and is stored', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(session('gpt-5.5') as any);
    await agentModeController.verifiedGenerate(verifiedReq({ llmModel: 'gemini-3.5-flash' }), makeRes());
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, 'gemini-3.5-flash', expect.anything());
    expect(modelWrites()).not.toContain('report-model');
    expect(workerModels()).toEqual(['gemini-3.5-flash']);
  });

  it('an explicit model equal to the stored one is not rewritten', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(session('gpt-5.5') as any);
    await agentModeController.verifiedGenerate(verifiedReq({ llmModel: ' gpt-5.5 ' }), makeRes());
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    expect(workerModels()).toEqual(['gpt-5.5']);
  });

  it.each([
    [UNSERVED, 'not_served'],
    ['internal-judge-1', 'not_selectable'],
    ['live-voice-1', 'not_selectable'],
  ])('an unavailable explicit model %s returns the 422 model_unavailable, not a swap', async (picked, reason) => {
    mockChatbotDb.getChatSession.mockResolvedValue(session('gpt-5.5') as any);
    const res = makeRes();
    await agentModeController.verifiedGenerate(verifiedReq({ llmModel: picked }), res);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable', requestedModel: picked, reason });
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('a 422 releases nothing it did not take: the session lock is free for the next turn', async () => {
    await agentModeController.verifiedGenerate(verifiedReq({ llmModel: UNSERVED }), makeRes());
    expect(activeSessionGenerations.has(SESSION_ID)).toBe(false);
  });

  it('no selection at all: the task-type default still applies', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(session() as any);
    await agentModeController.verifiedGenerate(verifiedReq(), makeRes());
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, 'report-model');
    expect(workerModels()).toEqual(['report-model']);
  });

  it('a blank request model is ignored (falls back to the stored model)', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(session('gpt-5.5') as any);
    await agentModeController.verifiedGenerate(verifiedReq({ llmModel: '   ' }), makeRes());
    expect(workerModels()).toEqual(['gpt-5.5']);
  });
});

describe('system callers of runVerifiedChat are unchanged', () => {
  it('a caller that passes no model still gets the task-type default over the stored model', async () => {
    mockWorker.runInWorker.mockResolvedValue(reportTool as any);
    mockChatbotDb.getChatSession.mockResolvedValue(session('gpt-5.5') as any);
    await runVerifiedChat({
      sessionId: SESSION_ID, userId: OWNER, startingMessage: 'go', keywords: [],
      requiredFunctions: [{ functionName: 'update_html_file', minCount: 1 }], maxAttempts: 1, attachments: [],
    });
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, 'report-model');
    expect(workerModels()).toEqual(['report-model']);
  });

  it('a caller that passes a model (scheduled pin) keeps it', async () => {
    mockWorker.runInWorker.mockResolvedValue(reportTool as any);
    await runVerifiedChat({
      sessionId: SESSION_ID, userId: OWNER, startingMessage: 'go', keywords: [],
      requiredFunctions: [{ functionName: 'update_html_file', minCount: 1 }], maxAttempts: 1, attachments: [],
      llmModel: 'gemini-3.5-flash',
    });
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    expect(workerModels()).toEqual(['gemini-3.5-flash']);
  });
});
