/**
 * ENG-1684/ENG-1700/ENG-1699: scheduleAutoWorkPlanContinuation (the ENG-1684 fix, same shape
 * as ENG-1239's scheduleAutoMediaContinuation, which this file's structure mirrors) had zero
 * test coverage of its own prior to this file — only the pure predicate
 * (hasStalledAutocompleteWorkPlan, agentModeController.stalledAutocompletePlan.test.ts) was
 * tested. This gap is why two real bugs shipped uncaught:
 *
 * - ENG-1700: the predicate only fired on a turn with ZERO tool calls, never on a turn whose
 *   tool calls all failed (e.g. create_html_file's repeated TruncatedToolCallArgumentsError) —
 *   live-reproduced 2026-09-02, a plan hung ~10 minutes needing a human to type "continue".
 * - ENG-1699: the scheduled (setImmediate-deferred) continuation never re-checked whether the
 *   stall still held immediately before firing, only *after* to decide on a further round — a
 *   human's own turn resolving the stall in that gap still produced a confusing, unnecessary,
 *   customer-visible continuation message.
 */
import { Request, Response } from 'express';
import {
  agentModeController,
  activeSessionGenerations,
  autoContinuationSessions,
} from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import { checkTokenUsage } from '../services/tokenUsageService';

jest.mock('../services/durableLandingService', () => ({
  findInFlightJobForSession: jest.fn().mockResolvedValue(null),
  markAwaitingReconnect: jest.fn().mockResolvedValue(undefined),
  claimCompletion: jest.fn().mockResolvedValue(false),
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
    bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-08',
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
  isContextLimitError: jest.fn().mockReturnValue(false),
  isSessionLimitError: jest.fn().mockReturnValue(false),
  isTransientLLMError: jest.fn().mockReturnValue(false),
  isWorkerShutdownError: jest.fn().mockReturnValue(false),
}));

const mockIoEmit = jest.fn();
const mockIoTo = jest.fn().mockReturnValue({ emit: mockIoEmit });
jest.mock('../server', () => ({
  io: { to: mockIoTo },
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockSendOncallAlert = sendAgentModeOncallAlert as jest.Mock;
const mockCheckTokenUsage = checkTokenUsage as jest.Mock;

describe('AgentModeController - automatic work-plan continuation (ENG-1684/ENG-1700/ENG-1699)', () => {
  const mockUserId = 'user-workplan-stall';
  const mockSessionId = 'session-workplan-stall';

  const stalledWorkPlan = {
    planId: 'plan-1', autocomplete: true,
    steps: [{ stepCount: 1, status: 'pending' }],
  };
  const completedWorkPlan = {
    planId: 'plan-1', autocomplete: true,
    steps: [{ stepCount: 1, status: 'completed' }],
  };

  const baseSession = (workPlan: any) => ({
    sessionId: mockSessionId,
    userId: mockUserId,
    title: 'Reddit Pain Point Research Report',
    messages: [],
    createdAt: '2026-09-02T00:00:00Z',
    updatedAt: '2026-09-02T00:00:00Z',
    portalType: 'agent' as const,
    pageIdentifier: 'agent-mode',
    llmModel: 'gpt-5-chat-2',
    workPlan,
  });

  const makeReq = (message = 'Research pain points') =>
    ({
      user: { userId: mockUserId, email: 'test@example.com' },
      body: { sessionId: mockSessionId, userMessage: message, llmModel: 'gpt-5-chat-2', attachments: [] },
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

  const failedToolCall = () => ({
    id: 'tc-html-1',
    name: 'create_html_file',
    arguments: { content_draft: '<html>...' },
    error: 'TruncatedToolCallArgumentsError: cut off mid-object',
    duration: 500,
  });

  const workerResponse = (content: string, toolCalls: any[]) => ({
    content,
    toolCalls,
    knowledgeBaseQueries: [],
    sources: [],
    responseMessages: [
      {
        role: 'assistant',
        content,
        timestamp: '2026-09-02T09:12:01.000Z',
        metadata: { timestamp: '2026-09-02T09:12:01.000Z', toolCalls },
      },
    ],
    cancelled: false,
    persistedResponseCount: 0,
  });

  // Let the setImmediate-deferred auto-continuation (and its own chained promises) settle.
  const flush = async (rounds = 20) => {
    for (let i = 0; i < rounds; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    autoContinuationSessions.clear();
    delete process.env.AGENT_RUN_STORE;
    mockSendOncallAlert.mockResolvedValue(undefined);
    mockCheckTokenUsage.mockResolvedValue({
      allowed: true, warning: false, used: 0, allowance: null,
      bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-09',
    });
    mockChatbotDb.getChatSession.mockResolvedValue(baseSession(stalledWorkPlan) as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(baseSession(stalledWorkPlan) as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(undefined as any);
  });

  it('ENG-1700: auto-continues when every tool call this turn failed, not just when there were none', async () => {
    mockWorkerService.runInWorker
      // Turn 1 (the customer's real request): create_html_file fails, plan step still pending.
      .mockResolvedValueOnce(
        workerResponse('Steps 1-5 are done. Step 6 (HTML report) was interrupted.', [failedToolCall()]),
      )
      // Turn 2 (the automatic continuation): the report finally generates — and, exactly as a
      // real successful set_work_plan_status call would, the persisted session now reflects
      // the step as completed (workPlan comes from a fresh getChatSession read, not from the
      // worker's own return value, so the mock must model that causality explicitly).
      .mockImplementationOnce(async () => {
        mockChatbotDb.getChatSession.mockResolvedValue(baseSession(completedWorkPlan) as any);
        return workerResponse('Report generated.', []);
      });

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);

    await flush();

    // The all-failed turn triggered exactly one auto-continuation round — the ENG-1700 fix —
    // and stopped once the plan was actually complete, not a 3rd unnecessary round.
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(2);
    const secondCallArgs = mockWorkerService.runInWorker.mock.calls[1][0] as any;
    expect(secondCallArgs.messageContent).toMatch(/automatic continuation/i);
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
  });

  it('does not auto-continue when a tool call this turn actually succeeded', async () => {
    mockWorkerService.runInWorker.mockResolvedValueOnce(
      workerResponse('Working on it.', [{ id: 'tc-1', name: 'read_market_strategy', result: { success: true } }]),
    );

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    await flush();

    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
    expect(mockIoEmit).not.toHaveBeenCalled();
  });

  it('ENG-1699: does not fire the continuation if the stall was already resolved by the time it runs', async () => {
    // Turn 1: customer's real request stalls (all tool calls failed, step still pending).
    mockWorkerService.runInWorker.mockResolvedValueOnce(
      workerResponse('Step 6 was interrupted.', [failedToolCall()]),
    );

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);

    // Before the setImmediate-deferred continuation fires, the plan's own state has moved on
    // (e.g. a human's own message elsewhere completed the step) — simulate that by changing
    // what getChatSession returns from here on, exactly as a real concurrent write would.
    mockChatbotDb.getChatSession.mockResolvedValue(baseSession(completedWorkPlan) as any);

    await flush();

    // The ENG-1699 pre-fire recheck caught the now-resolved plan and skipped generating —
    // no second worker call, but the recheck itself DID run (proof it's the recheck path that
    // stopped this, not some unrelated reason).
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
    expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith(mockSessionId);
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
    expect(autoContinuationSessions.has(mockSessionId)).toBe(false);
  });

  it('ENG-1699: the recheck runs on round 1 too, not only on recursive rounds', async () => {
    // Same scenario as above, but asserting specifically on the very first scheduled round —
    // the recheck must not be special-cased to skip round 1.
    mockWorkerService.runInWorker.mockResolvedValueOnce(
      workerResponse('Step 6 was interrupted.', [failedToolCall()]),
    );
    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);

    const callsBeforeFlush = mockChatbotDb.getChatSession.mock.calls.length;
    mockChatbotDb.getChatSession.mockResolvedValue(baseSession(completedWorkPlan) as any);
    await flush();

    expect(mockChatbotDb.getChatSession.mock.calls.length).toBeGreaterThan(callsBeforeFlush);
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('ENG-1699 follow-up: fails OPEN (still generates) when the pre-fire recheck itself cannot read the session', async () => {
    // A transient DB error here must not be silently treated as "stall already resolved" —
    // that would drop the entire backstop with no operator visibility. The recheck should log
    // the failure and proceed to generate anyway, same as this function's pre-ENG-1699 behavior.
    // Only the recheck's OWN getChatSession call should reject: generateSessionResponse itself
    // also calls getChatSession internally to load/re-read the session, and those must keep
    // succeeding for round 2 to actually run — this isolates the recheck's failure specifically.
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    mockWorkerService.runInWorker
      .mockResolvedValueOnce(workerResponse('Step 6 was interrupted.', [failedToolCall()]))
      .mockImplementationOnce(async () => {
        mockChatbotDb.getChatSession.mockResolvedValue(baseSession(completedWorkPlan) as any);
        return workerResponse('Report generated.', []);
      });

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);

    // Reject exactly the next getChatSession call (the recheck's own) — every call after that
    // falls back to whatever mockResolvedValue is current, matching a real one-time transient error.
    mockChatbotDb.getChatSession.mockRejectedValueOnce(new Error('DynamoDB throttled'));
    await flush();

    // Failed open: the continuation still generated, it wasn't silently skipped.
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('pre-fire recheck failed to read session'),
      expect.any(Error),
    );
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);

    consoleErrorSpy.mockRestore();
  });

  it('does not double-fire alongside a media-budget deferral on the same turn', async () => {
    // A step whose tool is generate_image can hit BOTH detectors at once if they aren't
    // mutually exclusive — this is the interaction bug the ENG-1700 design review caught.
    const mediaDeferredCall = {
      id: 'tc-img-1', name: 'generate_image',
      result: { deferred: true, reason: 'media_generation_time_budget' },
    };
    mockWorkerService.runInWorker
      .mockResolvedValueOnce(workerResponse('Working on the image.', [mediaDeferredCall]))
      .mockResolvedValueOnce(workerResponse('Image ready.', [{ id: 'tc-img-1', name: 'generate_image', result: { success: true } }]));

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    await flush();

    // Exactly one continuation path fired (media's), not two racing for the same lock.
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(2);
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
    expect(autoContinuationSessions.has(mockSessionId)).toBe(false);
  });

  it('stops after AUTO_WORK_PLAN_CONTINUATION_MAX_ROUNDS rounds and posts a graceful closing message', async () => {
    const AUTO_WORK_PLAN_CONTINUATION_MAX_ROUNDS = 2; // ENG-1700 follow-up: lowered from 3
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // A persistently broken tool: every round, including the customer's own turn, fails.
    mockWorkerService.runInWorker.mockResolvedValue(
      workerResponse('Step 6 was interrupted.', [failedToolCall()]),
    );

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    await flush(200);

    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1 + AUTO_WORK_PLAN_CONTINUATION_MAX_ROUNDS);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`${AUTO_WORK_PLAN_CONTINUATION_MAX_ROUNDS} rounds`),
    );
    expect(mockChatbotDb.addMessageToSession).toHaveBeenCalledWith(
      mockSessionId,
      expect.objectContaining({ content: expect.stringContaining("wasn't able to finish this plan automatically") }),
    );
    expect(mockSendOncallAlert).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('exhausted its retry cap') }),
    );
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);

    consoleErrorSpy.mockRestore();
  });

  it('does NOT auto-continue when the customer has exhausted their usage allowance', async () => {
    // The customer's own turn must succeed normally first (checkTokenUsage=allowed here is a
    // separate, unrelated product gate on /generate itself) — only THEN does the allowance
    // become exhausted, isolating the auto-continuation's own usage gate from that other one.
    mockWorkerService.runInWorker.mockResolvedValueOnce(
      workerResponse('Step 6 was interrupted.', [failedToolCall()]),
    );

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);

    mockCheckTokenUsage.mockResolvedValue({
      allowed: false, warning: true, used: 100, allowance: 100,
      bonus: 0, effectiveAllowance: 100, percentUsed: 100, month: '2026-09',
    });
    await flush();

    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
  });

  it('releases the lock before recursing into the next round (lock-release ordering)', async () => {
    mockWorkerService.runInWorker
      .mockResolvedValueOnce(workerResponse('Step 6 was interrupted.', [failedToolCall()]))
      .mockResolvedValueOnce(workerResponse('Still stuck.', [failedToolCall()]))
      .mockImplementationOnce(async () => {
        mockChatbotDb.getChatSession.mockResolvedValue(baseSession(completedWorkPlan) as any);
        return workerResponse('Report generated.', []);
      });

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    await flush();

    // If round 1 hadn't released the lock before round 2's tryClaimSessionGeneration ran,
    // round 2 would never have fired at all (claim would always fail).
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(3);
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
    expect(autoContinuationSessions.has(mockSessionId)).toBe(false);
  });
});
