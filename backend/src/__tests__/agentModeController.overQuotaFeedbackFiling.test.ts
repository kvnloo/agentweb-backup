/**
 * ENG-527 — product-feedback filing through Emma is never token-limited.
 * AC2: an over-quota user who explicitly asks Emma to file (feedbackIntent) gets a tracked link,
 *      with zero LLM/worker calls.
 * AC3: ordinary over-quota generation keeps the existing 429.
 * AC4: a failed filing is surfaced clearly and never reported as tracked.
 * AC5: Emma uses the same shared policy as the UI form (fileProductFeedback).
 * Preamble lifted from agentModeController.failLoudOrdering.test.ts.
 */
jest.mock('../services/productFeedbackFiling', () => ({
  ...jest.requireActual('../services/productFeedbackFiling'),
  fileProductFeedback: jest.fn(),
}));
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



import { fileProductFeedback } from '../services/productFeedbackFiling';
import { ReportReplayCapacityError } from '../utils/reportIntake';

const mockFile = fileProductFeedback as jest.Mock;
const OVER_QUOTA = {
  allowed: false, warning: false, used: 3_033_275, allowance: 3_000_000, bonus: 0,
  effectiveAllowance: 3_000_000, percentUsed: 101, month: '2026-07',
};

describe('ENG-527 over-quota Emma feedback filing', () => {
  beforeEach(() => {
    mockCheckTokenUsage.mockResolvedValue(OVER_QUOTA);
    mockChatbotDb.getChatSession.mockResolvedValue(baseSession() as any);
  });

  it('AC2: over-quota feature request via Emma is filed and returns the tracked link, no LLM call', async () => {
    mockFile.mockResolvedValue({
      title: 'Feature Request: x', replayed: false, issueId: 'AGW-1',
      filed: { pageId: '1', trackerUrl: 'https://fb/t/1', userUrl: 'https://fb/p/1', deduped: false, tracker: 'Featurebase' },
    });
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ feedbackIntent: 'feature_request', userMessage: 'Add CSV export' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.content).toContain('https://fb/p/1');
    expect(res.body.feedbackFiled).toMatchObject({ type: 'feature_request', trackerUrl: 'https://fb/p/1' });
    expect(mockFile).toHaveBeenCalledWith(expect.objectContaining({
      reportType: 'feature_request', description: 'Add CSV export', sessionId: SESSION_ID,
      user: expect.objectContaining({ userId: OWNER }),
    }));
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    expect(mockIncrementUsage).not.toHaveBeenCalled();
  });

  it('AC2: over-quota bug report via Emma is filed', async () => {
    mockFile.mockResolvedValue({
      title: 'Bug: y', replayed: false,
      filed: { pageId: '2', trackerUrl: 'https://fb/t/2', deduped: true, tracker: 'Featurebase' },
    });
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ feedbackIntent: 'bug', userMessage: 'Export crashes' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.feedbackFiled).toMatchObject({ type: 'bug', trackerUrl: 'https://fb/t/2', deduped: true });
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
  });

  it('AC3: ordinary over-quota generation still gets the existing 429 and never files', async () => {
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({}), res);
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ code: 'usage_paused' });
    expect(mockFile).not.toHaveBeenCalled();
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
  });

  it('AC3: an unknown feedbackIntent cannot bypass the quota gate', async () => {
    for (const intent of ['improvement', 'generate', '__proto__', 'toString']) {
      const res = makeRes();
      await agentModeController.generateResponse(generateReq({ feedbackIntent: intent }), res);
      expect(res.statusCode).toBe(429);
    }
    expect(mockFile).not.toHaveBeenCalled();
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
  });

  it('AC4: a failed filing is surfaced and never reported as tracked', async () => {
    mockFile.mockRejectedValue(new Error('featurebase 500'));
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ feedbackIntent: 'bug' }), res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ code: 'feedback_filing_failed', feedbackFiled: null });
    expect(JSON.stringify(res.body)).not.toMatch(/being tracked/);
  });

  it('AC4: replay-capacity pressure answers a retryable 503, nothing claimed', async () => {
    mockFile.mockRejectedValue(new ReportReplayCapacityError());
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ feedbackIntent: 'feature_request' }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.feedbackFiled).toBeNull();
  });

  it('within allowance, feedbackIntent does not short-circuit normal generation', async () => {
    mockCheckTokenUsage.mockResolvedValue({ ...OVER_QUOTA, allowed: true, used: 0, percentUsed: 0 });
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ feedbackIntent: 'bug' }), res);
    expect(mockFile).not.toHaveBeenCalled();
  });
  it('Opslane P1: with no tracker link, never says "being tracked:" and returns null link', async () => {
    mockFile.mockResolvedValue({
      title: 'Bug: z', replayed: false, issueId: 'AGW-9',
      filed: { pageId: '9', trackerUrl: '', userUrl: '', deduped: false, tracker: 'Featurebase' },
    });
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ feedbackIntent: 'bug', userMessage: 'export crashes on csv' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.content).not.toMatch(/being tracked/);
    expect(res.body.content).toContain('AGW-9');
    expect(res.body.feedbackFiled).toMatchObject({ trackerUrl: null, issueId: 'AGW-9' });
  });

  it('Opslane P2: the filed turn is persisted to the session', async () => {
    mockFile.mockResolvedValue({
      title: 'Bug: y', replayed: false,
      filed: { pageId: '2', trackerUrl: 'https://fb/t/2', deduped: false, tracker: 'Featurebase' },
    });
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ feedbackIntent: 'bug', userMessage: 'dashboard crashes' }), res);
    expect(res.statusCode).toBe(200);
    expect(mockChatbotDb.addMessagesToSession).toHaveBeenCalledWith(SESSION_ID, [
      expect.objectContaining({ role: 'user', content: 'dashboard crashes' }),
      expect.objectContaining({ role: 'assistant', content: res.body.content }),
    ]);
  });

  it('Opslane P2: a transcript write failure does not un-report a successful filing', async () => {
    mockFile.mockResolvedValue({
      title: 'Bug: y', replayed: false,
      filed: { pageId: '2', trackerUrl: 'https://fb/t/2', deduped: false, tracker: 'Featurebase' },
    });
    mockChatbotDb.addMessagesToSession.mockRejectedValue(new Error('ddb down'));
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ feedbackIntent: 'bug', userMessage: 'x' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.feedbackFiled).toMatchObject({ trackerUrl: 'https://fb/t/2' });
  });

  it('Opslane P2: a blank over-quota report is a 400, nothing filed', async () => {
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ feedbackIntent: 'bug', userMessage: '   ' }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'Description is required', feedbackFiled: null });
    expect(mockFile).not.toHaveBeenCalled();
  });
});
