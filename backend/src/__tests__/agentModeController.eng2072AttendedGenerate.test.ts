/**
 * ENG-2072 — a user can reopen a schedule-created session from the customer
 * portal's "Scheduled" sidebar tab and keep chatting in it
 * (useAgentModeChat.tsx:429 posts to POST /api/agent-mode/generate, i.e.
 * agentModeController.generateResponse). That turn is genuinely ATTENDED even
 * though session.sessionType === 'scheduled' records how the session was
 * CREATED. This must never force hands-off work-plan autocomplete.
 *
 * generateResponse -> generateSessionResponse -> the isUnattendedRun value it
 * was given -> generateMarketingResponseWorkerService.runInWorker's params is
 * the single choke point every caller's signal passes through before it can
 * reach createWorkPlan/modifyWorkPlan/applyPredefinedWorkPlan (via the worker
 * process and toolDispatch's ToolContext) — so asserting on runInWorker's call
 * args is a faithful regression check for the live /generate route.
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
    getSupportedModels: jest.fn().mockResolvedValue(['gpt-5-chat-2']),
    resolveGenerationModel: jest.fn((model: string) => ({
      model,
      fellBack: false,
      requestedModel: model,
    })),
    generateSessionTitle: jest.fn().mockResolvedValue('Test Title'),
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('System prompt'),
    generateDiagnosticMessage: jest.fn().mockResolvedValue(null),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
  },
  AgentModeService: jest.fn(),
}));

jest.mock('../services/llmUsagePolicyResolverService', () => ({
  getEffectiveLlmUsagePolicy: jest.fn().mockResolvedValue({
    billingUserId: 'user-owner',
    policy: null,
    costUsedMicroUsd: 0,
    tokenUsed: 0,
    mode: { usageMode: 'full_choice', reason: 'no_policy' },
  }),
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
  isProviderNoEndpointsError: jest.fn().mockReturnValue(false),
}));

import { agentModeController, activeSessionGenerations } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

const ownerId = 'user-owner';
const sessionId = 'session-reopened-scheduled';

const scheduledSession = {
  sessionId,
  userId: ownerId,
  sessionType: 'scheduled',
  title: 'Luma Event Lead Engagement',
  messages: [],
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
  portalType: 'agent' as const,
  pageIdentifier: 'agent-mode',
  llmModel: 'gpt-5-chat-2',
};

const workerResult = {
  content: 'OK',
  toolCalls: [],
  knowledgeBaseQueries: [],
  sources: [],
  responseMessages: [],
};

const makeReq = () =>
  ({
    user: { userId: ownerId },
    body: {
      sessionId,
      userMessage: 'Create a work plan to review this week\'s leads',
      llmModel: 'gpt-5-chat-2',
      attachments: [],
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

describe('ENG-2072: reopening a scheduled session for a live turn is ATTENDED', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    mockChatbotDb.getChatSession.mockResolvedValue(scheduledSession as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(scheduledSession as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(scheduledSession as any);
    mockWorkerService.runInWorker.mockResolvedValue(workerResult as any);
  });

  it('POST /api/agent-mode/generate on a schedule-created session signals isUnattendedRun: false', async () => {
    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
    expect(mockWorkerService.runInWorker).toHaveBeenCalledWith(
      expect.objectContaining({ isUnattendedRun: false }),
      expect.anything(),
    );
  });
});
