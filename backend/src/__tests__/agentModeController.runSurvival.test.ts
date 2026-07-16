/**
 * Run-survival core — interactive /generate lane (ENG-147).
 *
 * Pins the /generate intake contract when the run store is enabled:
 *  - a runId is minted ONCE at intake and recorded as a durable run record
 *  - an idempotency submit-lock (sha256(sessionId+userMessage+llmModel))
 *    dedupes duplicate submits ACROSS restarts/retries — the loser gets the
 *    existing 409 SESSION_BUSY shape plus the in-flight runId
 *  - worker death mid-run marks the run record `interrupted` and the next
 *    /generate is accepted immediately
 *  - run-record creation failure aborts the request loudly (NO-FALLBACK)
 *  - flag off → today's exact behavior, zero run-store calls
 *
 * The run store is fully mocked here — these tests assert the intake wiring;
 * DynamoDB semantics live in runStore.test.ts, and the genuine concurrency
 * acceptance is in agentModeController.sessionIdempotency.test.ts.
 */
import { Request, Response } from 'express';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
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
    generateSessionTitle: jest.fn().mockResolvedValue('Test Title'),
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('System prompt'),
    generateDiagnosticMessage: jest.fn().mockResolvedValue(null),
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

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue([]),
}));

jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/durableLandingService', () => ({
  findInFlightJobForSession: jest.fn().mockResolvedValue(null),
  claimCompletion: jest.fn().mockResolvedValue(false),
  markAwaitingReconnect: jest.fn().mockResolvedValue(undefined),
}));

// The run store is fully mocked — controller tests assert the intake wiring,
// not DynamoDB behavior (that's runStore.test.ts).
jest.mock('../services/agentMode/runStore', () => ({
  isRunStoreEnabled: jest.fn().mockReturnValue(true),
  interactiveIdempotencyKey: jest.requireActual('../services/agentMode/runStore').interactiveIdempotencyKey,
  scheduledIdempotencyKey: jest.requireActual('../services/agentMode/runStore').scheduledIdempotencyKey,
  createSessionIdempotencyKey: jest.requireActual('../services/agentMode/runStore').createSessionIdempotencyKey,
  claimIdempotency: jest.fn().mockResolvedValue({ claimed: true }),
  releaseIdempotency: jest.fn().mockResolvedValue(undefined),
  recordIdempotencySessionId: jest.fn().mockResolvedValue(undefined),
  createRunRecord: jest.fn().mockResolvedValue(undefined),
  markRunTerminal: jest.fn().mockResolvedValue(undefined),
  IDEM_TTL_INTERACTIVE_S: 600,
  IDEM_TTL_SCHEDULED_S: 86400,
}));

import { agentModeController, activeSessionGenerations } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { findInFlightJobForSession, markAwaitingReconnect } from '../services/durableLandingService';
import * as runStore from '../services/agentMode/runStore';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockRunStore = runStore as jest.Mocked<typeof runStore>;

const workerResult = {
  content: 'OK',
  toolCalls: [],
  knowledgeBaseQueries: [],
  sources: [],
  responseMessages: [],
};

describe('AgentModeController — run-survival intake (interactive lane)', () => {
  const mockUserId = 'user-rs';
  const mockSessionId = 'session-rs';
  const mockSession = {
    sessionId: mockSessionId,
    userId: mockUserId,
    title: 'RS Session',
    messages: [],
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    portalType: 'agent' as const,
    pageIdentifier: 'agent-mode',
    llmModel: 'gpt-5-chat-2',
  };

  const makeReq = (sessionId: string, message = 'Hello') =>
    ({
      user: { userId: mockUserId, email: 'test@example.com' },
      body: { sessionId, userMessage: message, llmModel: 'gpt-5-chat-2', attachments: [] },
      method: 'POST',
      path: '/api/agent-mode/generate',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      on: jest.fn(),
    } as unknown as Request);

  const makeRes = () =>
    ({
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response);

  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    (mockRunStore.isRunStoreEnabled as jest.Mock).mockReturnValue(true);
    (mockRunStore.claimIdempotency as jest.Mock).mockResolvedValue({ claimed: true });
    (mockRunStore.createRunRecord as jest.Mock).mockResolvedValue(undefined);
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(mockSession as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
  });

  it('mints one runId at intake, records the run, and marks it completed on success', async () => {
    mockWorkerService.runInWorker.mockResolvedValueOnce(workerResult as any);

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(mockSessionId), res);

    expect(mockRunStore.createRunRecord).toHaveBeenCalledTimes(1);
    const recorded = (mockRunStore.createRunRecord as jest.Mock).mock.calls[0][0];
    expect(recorded.kind).toBe('interactive');
    expect(recorded.sessionId).toBe(mockSessionId);
    expect(recorded.userId).toBe(mockUserId);
    expect(recorded.runId).toBeTruthy();

    expect(mockRunStore.markRunTerminal).toHaveBeenCalledWith(recorded.runId, 'completed');
    expect(mockRunStore.releaseIdempotency).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalled();
  });

  it('duplicate submit loses the idempotency claim → 409 SESSION_BUSY with the in-flight runId, and exactly one generation runs', async () => {
    (mockRunStore.claimIdempotency as jest.Mock)
      .mockResolvedValueOnce({ claimed: true })
      .mockResolvedValueOnce({ claimed: false, inFlightRunId: 'run-in-flight' });

    // First submit: hold the worker until we've fired the duplicate.
    let resolveWorker!: (v: any) => void;
    mockWorkerService.runInWorker.mockImplementationOnce(
      () => new Promise((resolve) => { resolveWorker = resolve; })
    );

    const res1 = makeRes();
    const first = agentModeController.generateResponse(makeReq(mockSessionId, 'same msg'), res1);
    await new Promise((r) => setImmediate(r));

    const res2 = makeRes();
    await agentModeController.generateResponse(makeReq(mockSessionId, 'same msg'), res2);

    expect(res2.status).toHaveBeenCalledWith(409);
    const body = (res2.json as jest.Mock).mock.calls[0][0];
    expect(body.code).toBe('SESSION_BUSY');
    expect(body.runId).toBe('run-in-flight');

    resolveWorker(workerResult);
    await first;

    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
    // The loser must NOT release the winner's idempotency claim.
    expect(mockRunStore.releaseIdempotency).toHaveBeenCalledTimes(1);
  });

  it('in-memory lock busy (idem claimed but Set occupied) → releases the fresh idem claim before returning 409', async () => {
    activeSessionGenerations.add(mockSessionId);

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(mockSessionId), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockRunStore.releaseIdempotency).toHaveBeenCalledTimes(1);
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('worker death mid-run → run record marked interrupted (worker_exit), locks released, next /generate accepted immediately', async () => {
    const crash: any = new Error('Worker process exited with code 1 and signal null');
    mockWorkerService.runInWorker.mockRejectedValueOnce(crash);

    const res1 = makeRes();
    await agentModeController.generateResponse(makeReq(mockSessionId), res1);

    expect(mockRunStore.markRunTerminal).toHaveBeenCalledWith(
      expect.any(String),
      'interrupted',
      expect.objectContaining({ finishReason: 'worker_exit' })
    );

    // Lock + idem released → next submit accepted immediately (no 10-min lockout).
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
    expect(mockRunStore.releaseIdempotency).toHaveBeenCalled();

    mockWorkerService.runInWorker.mockResolvedValueOnce(workerResult as any);
    const res2 = makeRes();
    await agentModeController.generateResponse(makeReq(mockSessionId), res2);
    expect((res2.json as jest.Mock).mock.calls[0][0].content).toBe('OK');
  });

  it('non-shutdown generation error → run record marked failed', async () => {
    mockWorkerService.runInWorker.mockRejectedValueOnce(new Error('kaboom'));

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(mockSessionId), res);

    expect(mockRunStore.markRunTerminal).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      expect.objectContaining({ finishReason: 'error' })
    );
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
  });

  it('run-record creation failure aborts LOUDLY (500) and releases both locks (NO-FALLBACK)', async () => {
    (mockRunStore.createRunRecord as jest.Mock).mockRejectedValueOnce(new Error('AW-AgentRuns unavailable'));

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(mockSessionId), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
    expect(mockRunStore.releaseIdempotency).toHaveBeenCalledTimes(1);
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
  });

  describe('durable-landing still-building early returns (run records must not stay "running" for 30d)', () => {
    afterEach(() => {
      delete process.env.DURABLE_LANDING_GENERATION;
    });

    it('pre-generation reconnect (build already in flight) → run record marked terminal with finishReason detached_still_building, locks released', async () => {
      process.env.DURABLE_LANDING_GENERATION = 'true';
      (findInFlightJobForSession as jest.Mock).mockResolvedValueOnce({
        id: 'page-1',
        awaitingReconnect: true,
      });

      const res = makeRes();
      await agentModeController.generateResponse(makeReq(mockSessionId), res);

      expect((res.json as jest.Mock).mock.calls[0][0].stillBuilding).toBe(true);
      expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
      expect(mockRunStore.markRunTerminal).toHaveBeenCalledWith(
        expect.any(String),
        'completed',
        expect.objectContaining({ finishReason: 'detached_still_building' })
      );
      expect(mockRunStore.releaseIdempotency).toHaveBeenCalledTimes(1);
      expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
    });

    it('generation timeout with a build still in flight (detach path) → run record marked terminal with finishReason detached_still_building, locks released', async () => {
      // Not gated on DURABLE_LANDING_GENERATION (see controller comment) —
      // trigger via a generation rejection tagged isGenerationTimeout.
      const timeoutErr: any = new Error('Generation timed out');
      timeoutErr.isGenerationTimeout = true;
      mockWorkerService.runInWorker.mockRejectedValueOnce(timeoutErr);
      (findInFlightJobForSession as jest.Mock).mockResolvedValueOnce({
        id: 'page-2',
        awaitingReconnect: false,
      });

      const res = makeRes();
      await agentModeController.generateResponse(makeReq(mockSessionId), res);

      expect(markAwaitingReconnect).toHaveBeenCalledWith('page-2');
      expect((res.json as jest.Mock).mock.calls[0][0].stillBuilding).toBe(true);
      expect(mockRunStore.markRunTerminal).toHaveBeenCalledWith(
        expect.any(String),
        'completed',
        expect.objectContaining({ finishReason: 'detached_still_building' })
      );
      expect(mockRunStore.releaseIdempotency).toHaveBeenCalledTimes(1);
      expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
    });
  });

  it('BEHAVIOR-PRESERVING: flag off → zero run-store calls, normal response (today\'s exact behavior)', async () => {
    (mockRunStore.isRunStoreEnabled as jest.Mock).mockReturnValue(false);
    mockWorkerService.runInWorker.mockResolvedValueOnce(workerResult as any);

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(mockSessionId), res);

    expect(mockRunStore.claimIdempotency).not.toHaveBeenCalled();
    expect(mockRunStore.createRunRecord).not.toHaveBeenCalled();
    expect(mockRunStore.markRunTerminal).not.toHaveBeenCalled();
    expect(mockRunStore.releaseIdempotency).not.toHaveBeenCalled();
    expect((res.json as jest.Mock).mock.calls[0][0].content).toBe('OK');
  });
});
