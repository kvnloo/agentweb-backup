/** ENG-110: cap on interactive /verified-generate; scheduled/other runVerifiedChat callers are exempt. */
import { Request, Response } from 'express';
import {
  agentModeController,
  activeSessionGenerations,
  tryClaimSessionGeneration,
  releaseSessionGeneration,
  claimSessionGenerationWithRetry,
  isSessionBusyError,
  runVerifiedChat,
  RUN_VERIFIED_CHAT_LOCK_TIMEOUT_LONG_MS,
} from '../controllers/agentModeController';
import { settingsService } from '../services/settingsService';
import { __resetConcurrentGenerationCapForTests, __activeGenerationCountForTests } from '../services/agentMode/concurrentGenerationCap';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';

jest.mock('../services/tokenUsageService', () => ({
  ...jest.requireActual('../services/tokenUsageService'),
  checkTokenUsage: jest.fn().mockResolvedValue({ allowed: true, warning: false, month: '2026-07' }),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getReportGenerationDefaultModel: jest.fn(),
    getImageGenerationDefaultModel: jest.fn(),
    getVideoGenerationDefaultModel: jest.fn(),
    getDefaultModel: jest.fn().mockResolvedValue('default-model'),
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('system prompt'),
    generateSessionTitle: jest.fn().mockResolvedValue('Title'),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
  },
  AgentModeService: jest.fn(),
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
  },
}));

jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn() } }));

jest.mock('../services/emailService', () => ({
  emailService: { sendOncallAlert: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {},
  taskDb: {},
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

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

const workerResponse = (content: string) => ({
  content,
  toolCalls: [{ name: 'update_html_file', result: { success: true } }],
  knowledgeBaseQueries: [],
  sources: [],
  responseMessages: [],
});

const getSetting = settingsService.getSetting as jest.Mock;

describe('verified-generate per-user cap (ENG-110)', () => {
  const userId = 'user-cap';
  const session = (id: string) => ({ sessionId: id, userId, messages: [], llmModel: 'default-model' });
  const makeReq = (sessionId: string) =>
    ({
      user: { userId, email: 'test@example.com' },
      body: {
        sessionId, startingMessage: 'Generate the report.',
        requiredFunctions: [{ functionName: 'update_html_file', minCount: 1 }],
        keywords: [], attachments: [], maxAttempts: 1,
      },
      on: jest.fn(),
    } as unknown as Request);
  const makeRes = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response);
  const runParams = (sessionId: string) => ({
    sessionId, userId, startingMessage: 'go', keywords: [],
    requiredFunctions: [{ functionName: 'update_html_file', minCount: 1 }], maxAttempts: 1, attachments: [],
  });

  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    __resetConcurrentGenerationCapForTests();
    getSetting.mockImplementation(async (name: string) => (name === 'max_concurrent_generations_per_user' ? { settingValue: '1' } : null));
    mockChatbotDb.getChatSession.mockImplementation(async (id: string) => session(id) as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    mockAgentModeService.getReportGenerationDefaultModel.mockResolvedValue('report-gen-model');
    mockWorkerService.runInWorker.mockResolvedValue(workerResponse('Done') as any);
  });

  const hang = () => {
    let finish!: (v: any) => void;
    mockWorkerService.runInWorker.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    return () => finish(workerResponse('Done'));
  };
  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setImmediate(r));
    expect(cond()).toBe(true);
  };

  it('returns 429 TOO_MANY_CONCURRENT_RUNS over the cap, releases the session lock, and frees on completion', async () => {
    const finish = hang();
    const first = agentModeController.verifiedGenerate(makeReq('a'), makeRes());
    await waitFor(() => __activeGenerationCountForTests(userId) === 1);

    const res = makeRes();
    await agentModeController.verifiedGenerate(makeReq('b'), res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'TOO_MANY_CONCURRENT_RUNS', limit: 1,
      message: 'You have 1 chats generating at once. Wait for one to finish, then try again.',
      userMessageSaved: false, // ENG-2641: refused before the starting message was stored
    }));
    expect(activeSessionGenerations.has('b')).toBe(false);
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);

    finish();
    await first;
    expect(__activeGenerationCountForTests(userId)).toBe(0);
    expect(activeSessionGenerations.size).toBe(0);
  });

  it('releases the slot when the run throws', async () => {
    mockWorkerService.runInWorker.mockRejectedValue(new Error('boom'));
    await runVerifiedChat(runParams('a'), { capInteractiveUserId: userId }).catch(() => undefined);
    expect(__activeGenerationCountForTests(userId)).toBe(0);
    expect(activeSessionGenerations.size).toBe(0);
  });

  it('scheduled/non-interactive callers (no capInteractiveUserId) neither count nor are blocked', async () => {
    const finish = hang();
    const interactive = agentModeController.verifiedGenerate(makeReq('a'), makeRes());
    await waitFor(() => __activeGenerationCountForTests(userId) === 1);

    const scheduled = await runVerifiedChat(runParams('sched-1'));
    expect(scheduled.success).toBe(true);
    expect(__activeGenerationCountForTests(userId)).toBe(1);

    finish();
    await interactive;
  });
});
