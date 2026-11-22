import { Request, Response } from 'express';
import { settingsService } from '../services/settingsService';
import { __resetConcurrentGenerationCapForTests, __activeGenerationCountForTests } from '../services/agentMode/concurrentGenerationCap';
import { agentModeController, activeSessionGenerations, drainActiveSessionGenerations } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';

jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn() } }));

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    createOrReuseInteractiveShare: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    updateSessionApprovalDeck: jest.fn(),
    updateSessionWorkPlanInputRequest: jest.fn(),
  },
  updateTaskExecutionStatus: jest.fn(),
}));

jest.mock('../services/agentMode/core/workPlanInputRequest', () => ({
  ...jest.requireActual('../services/agentMode/core/workPlanInputRequest'),
  resolveWorkPlanInputAnswer: jest.fn().mockReturnValue({ answer: { values: { a: 'b' } } }),
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendOncallAlert: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
    cancelSession: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    generateSessionTitle: jest.fn().mockResolvedValue('Test Title'),
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('System prompt'),
    generateDiagnosticMessage: jest.fn().mockResolvedValue(null),
    submitApprovalDeckAnswers: jest.fn(),
  },
  AgentModeService: jest.fn(),
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null,
    bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-03',
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

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const getSetting = settingsService.getSetting as jest.Mock;

const EMPTY = { content: '', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] };

describe('AgentModeController - per-user concurrent generation cap (ENG-110)', () => {
  const userId = 'user-cap';
  const sessionFor = (id: string, owner = userId) => ({
    sessionId: id, userId: owner, title: 't', messages: [], createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z', portalType: 'agent' as const, pageIdentifier: 'agent-mode', llmModel: 'gpt-5-chat-2',
  });
  const makeReq = (sessionId: string) => ({
    user: { userId, email: 'test@example.com' },
    body: { sessionId, userMessage: `hello ${sessionId}`, llmModel: 'gpt-5-chat-2', attachments: [] },
    method: 'POST', path: '/api/agent-mode/generate', ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' }, on: jest.fn(),
  } as unknown as Request);
  const makeRes = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response);

  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setImmediate(r));
    expect(cond()).toBe(true);
  };

  /** Start a request whose generation hangs until the returned resolver is called. */
  const startHanging = (sessionId: string) => {
    let resolve!: (v: any) => void;
    mockWorkerService.runInWorker.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const res = makeRes();
    const done = agentModeController.generateResponse(makeReq(sessionId), res);
    return { res, done, finish: () => resolve(EMPTY) };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    __resetConcurrentGenerationCapForTests();
    getSetting.mockResolvedValue(null); // default limit 3
    mockChatbotDb.getChatSession.mockImplementation(async (id: string) => sessionFor(id) as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue({} as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
  });

  it('admits 3 concurrent chats, answers the 4th with 429 TOO_MANY_CONCURRENT_RUNS, and frees the session lock', async () => {
    const runs = ['a', 'b', 'c'].map((s) => startHanging(s));
    await waitFor(() => __activeGenerationCountForTests(userId) === 3);

    const res4 = makeRes();
    await agentModeController.generateResponse(makeReq('d'), res4);
    expect(res4.status).toHaveBeenCalledWith(429);
    expect(res4.json).toHaveBeenCalledWith({
      error: 'Too many concurrent runs',
      code: 'TOO_MANY_CONCURRENT_RUNS',
      message: 'You have 3 chats generating at once. Wait for one to finish, then try again.',
      limit: 3,
    });
    expect(activeSessionGenerations.has('d')).toBe(false);
    expect(__activeGenerationCountForTests(userId)).toBe(3);

    runs[0].finish();
    await runs[0].done;
    expect(__activeGenerationCountForTests(userId)).toBe(2);
    runs.slice(1).forEach((r) => r.finish());
    await Promise.all(runs.map((r) => r.done));
    expect(__activeGenerationCountForTests(userId)).toBe(0);
  });

  it('a 409 SESSION_BUSY on the same session does not consume or leak a slot', async () => {
    const first = startHanging('a');
    await waitFor(() => __activeGenerationCountForTests(userId) === 1);
    const res2 = makeRes();
    await agentModeController.generateResponse(makeReq('a'), res2);
    expect(res2.status).toHaveBeenCalledWith(409);
    expect(__activeGenerationCountForTests(userId)).toBe(1);
    first.finish();
    await first.done;
    expect(__activeGenerationCountForTests(userId)).toBe(0);
  });

  it('releases the slot when generation throws after the claim', async () => {
    mockWorkerService.runInWorker.mockRejectedValueOnce(new Error('boom'));
    const res = makeRes();
    await agentModeController.generateResponse(makeReq('a'), res);
    expect(__activeGenerationCountForTests(userId)).toBe(0);
    expect(activeSessionGenerations.size).toBe(0);
  });

  it('releases the slot when a step between the claim and the work throws', async () => {
    const { checkTokenUsage } = require('../services/tokenUsageService');
    (checkTokenUsage as jest.Mock).mockRejectedValueOnce(new Error('usage lookup failed'));
    await agentModeController.generateResponse(makeReq('a'), makeRes());
    expect(__activeGenerationCountForTests(userId)).toBe(0);
    expect(activeSessionGenerations.size).toBe(0);
  });

  it('releases the slot when the client disconnects mid-run (response never written)', async () => {
    const req = makeReq('a');
    const res = makeRes();
    let resolve!: (v: any) => void;
    mockWorkerService.runInWorker.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const done = agentModeController.generateResponse(req, res);
    await waitFor(() => __activeGenerationCountForTests(userId) === 1);
    const onClose = (req.on as jest.Mock).mock.calls.find((c) => c[0] === 'close')?.[1];
    if (onClose) onClose();
    resolve(EMPTY);
    await done;
    expect(__activeGenerationCountForTests(userId)).toBe(0);
  });

  it('setting 0 means unlimited', async () => {
    getSetting.mockResolvedValue({ settingValue: '0' });
    const runs = ['a', 'b', 'c', 'd', 'e'].map((s) => startHanging(s));
    await waitFor(() => __activeGenerationCountForTests(userId) === 5);
    runs.forEach((r) => r.finish());
    await Promise.all(runs.map((r) => r.done));
    expect(__activeGenerationCountForTests(userId)).toBe(0);
  });

  it('garbage setting falls back to 3', async () => {
    getSetting.mockResolvedValue({ settingValue: 'lots' });
    const runs = ['a', 'b', 'c'].map((s) => startHanging(s));
    await waitFor(() => __activeGenerationCountForTests(userId) === 3);
    const res = makeRes();
    await agentModeController.generateResponse(makeReq('d'), res);
    expect(res.status).toHaveBeenCalledWith(429);
    runs.forEach((r) => r.finish());
    await Promise.all(runs.map((r) => r.done));
  });

  it('another user is not affected by this user being at the cap', async () => {
    getSetting.mockResolvedValue({ settingValue: '1' });
    const run = startHanging('a');
    await waitFor(() => __activeGenerationCountForTests(userId) === 1);
    mockChatbotDb.getChatSession.mockImplementation(async (id: string) => sessionFor(id, 'someone-else') as any);
    const other = { ...makeReq('z'), user: { userId: 'someone-else', email: 'o@example.com' } } as any;
    other.body = { ...other.body, sessionId: 'z' };
    mockWorkerService.runInWorker.mockResolvedValueOnce(EMPTY as any);
    const res = makeRes();
    await agentModeController.generateResponse(other, res);
    expect(res.status).not.toHaveBeenCalledWith(429);
    run.finish();
    await run.done;
  });

  describe('answer/cancel turns are never refused after consuming their pending state', () => {
    const setAtCap = async () => {
      getSetting.mockResolvedValue({ settingValue: '1' });
      const run = startHanging('other');
      await waitFor(() => __activeGenerationCountForTests(userId) === 1);
      return run;
    };
    const withPending = (extra: Record<string, unknown>) =>
      mockChatbotDb.getChatSession.mockImplementation(async (id: string) => ({ ...sessionFor(id), ...extra }) as any);
    const reqWith = (body: Record<string, unknown>) => {
      const r = makeReq('paused') as any;
      r.body = { ...r.body, ...body };
      return r as Request;
    };
    const agentSvc = () => require('../services/agentModeService').agentModeService;

    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, () => void, () => jest.Mock]> = [
      ['deckAnswer', { deckAnswer: { deckId: 'd1', answers: [] } }, { pendingApprovalDeck: { deckId: 'd1', items: [] } },
        () => agentSvc().submitApprovalDeckAnswers.mockResolvedValue({ outcome: 'ok', summary: null, answeredDeck: { answers: [], items: [] } }),
        () => agentSvc().submitApprovalDeckAnswers],
      ['deckCancel', { deckCancel: { deckId: 'd1' } }, { pendingApprovalDeck: { deckId: 'd1', items: [] } },
        () => (mockChatbotDb as any).updateSessionApprovalDeck.mockResolvedValue(true),
        () => (mockChatbotDb as any).updateSessionApprovalDeck],
      ['workPlanInputAnswer', { workPlanInputAnswer: { requestId: 'r1', values: { a: 'b' } } }, { pendingWorkPlanInput: { requestId: 'r1' } },
        () => (mockChatbotDb as any).updateSessionWorkPlanInputRequest.mockResolvedValue(true),
        () => (mockChatbotDb as any).updateSessionWorkPlanInputRequest],
    ];

    it.each(cases)('%s at the cap: no 429 after the side effect; the turn runs and is counted', async (_n, body, pending, arm, sideEffect) => {
      const other = await setAtCap();
      withPending(pending);
      arm();
      let resolve!: (v: any) => void;
      mockWorkerService.runInWorker.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
      const res = makeRes();
      const done = agentModeController.generateResponse(reqWith(body), res);
      await waitFor(() => __activeGenerationCountForTests(userId) === 2);
      expect(sideEffect()).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalledWith(429);
      resolve(EMPTY);
      await done;
      other.finish();
      await other.done;
      expect(__activeGenerationCountForTests(userId)).toBe(0);
    });

    it('a plain message on a new session at the cap is still refused (and consumes nothing)', async () => {
      const other = await setAtCap();
      const res = makeRes();
      await agentModeController.generateResponse(makeReq('fresh'), res);
      expect(res.status).toHaveBeenCalledWith(429);
      expect((mockChatbotDb as any).updateSessionApprovalDeck).not.toHaveBeenCalled();
      other.finish();
      await other.done;
    });
  });

  it('an ADMIN generating in a CUSTOMER session is counted against the customer, not the admin', async () => {
    getSetting.mockResolvedValue({ settingValue: '1' });
    mockChatbotDb.getChatSession.mockImplementation(async (id: string) => sessionFor(id, 'customer-1') as any);
    let resolve!: (v: any) => void;
    mockWorkerService.runInWorker.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const req = makeReq('cust-session') as any;
    req.user = { userId: 'admin-1', email: 'a@example.com', isAdmin: true };
    const done = agentModeController.generateResponse(req, makeRes());
    await waitFor(() => __activeGenerationCountForTests('customer-1') === 1);
    expect(__activeGenerationCountForTests('admin-1')).toBe(0);
    resolve(EMPTY);
    await done;
    expect(__activeGenerationCountForTests('customer-1')).toBe(0);
  });
});
