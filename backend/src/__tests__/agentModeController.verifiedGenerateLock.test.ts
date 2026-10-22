/**
 * ENG-1696: /generate and /verified-generate could run concurrently on the same
 * sessionId and both write session.workPlan — chatbotService.updateSessionWorkPlan
 * is a plain unconditional DynamoDB overwrite, so whichever call wrote last
 * silently discarded the other's workPlan state. runVerifiedChat (the function
 * every verified-generate-shaped caller funnels through — the interactive
 * /verified-generate endpoint, scheduled runs, Slack revisions, image reports,
 * human-eval actions, result endpoints) never claimed the same activeSessionGenerations
 * lock /generate already uses.
 *
 * Fix: runVerifiedChat now claims that lock itself (via claimSessionGenerationWithRetry,
 * a bounded retry instead of an instant reject, since brief overlap is the common,
 * legitimate case), held for its whole multi-attempt run, and releases it on every
 * exit path (success, failure, or a caller-side lock timeout).
 */
import { Request, Response } from 'express';
import {
  agentModeController,
  activeSessionGenerations,
  sessionGenerationOwners,
  tryClaimSessionGeneration,
  releaseSessionGeneration,
  claimSessionGenerationWithRetry,
  isSessionBusyError,
  runVerifiedChat,
  RUN_VERIFIED_CHAT_LOCK_TIMEOUT_LONG_MS,
} from '../controllers/agentModeController';
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

describe('claimSessionGenerationWithRetry (ENG-1696)', () => {
  const sessionId = 'session-retry-unit';

  beforeEach(() => {
    activeSessionGenerations.clear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('claims immediately when the session is free, with no wait', async () => {
    const claimed = await claimSessionGenerationWithRetry(sessionId);
    expect(claimed).toBe(true);
    expect(activeSessionGenerations.has(sessionId)).toBe(true);
  });

  it('retries while busy and succeeds once the holder releases mid-wait', async () => {
    tryClaimSessionGeneration(sessionId); // simulate /generate holding it

    const claimPromise = claimSessionGenerationWithRetry(sessionId, { retries: 6, delayMs: 2000 });

    // Advance past 2 retries' worth of backoff — still held, should not have resolved yet.
    await jest.advanceTimersByTimeAsync(4000);
    releaseSessionGeneration(sessionId); // simulate /generate finishing
    await jest.advanceTimersByTimeAsync(2000); // next poll now sees it free

    expect(await claimPromise).toBe(true);
  });

  it('gives up and returns false once the retry budget is exhausted', async () => {
    tryClaimSessionGeneration(sessionId); // never released for the rest of this test

    const claimPromise = claimSessionGenerationWithRetry(sessionId, { retries: 3, delayMs: 1000 });
    await jest.advanceTimersByTimeAsync(3000);

    expect(await claimPromise).toBe(false);
    // The original holder's claim is untouched — a failed claimant must not evict it.
    expect(activeSessionGenerations.has(sessionId)).toBe(true);
  });
});

describe('runVerifiedChat participates in the shared session-generation lock (ENG-1696)', () => {
  const sessionId = 'session-verified-lock';
  const baseSession = {
    sessionId,
    userId: 'user-1',
    messages: [],
    llmModel: 'default-model',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    activeSessionGenerations.clear();

    mockChatbotDb.getChatSession.mockResolvedValue(baseSession as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    mockAgentModeService.getReportGenerationDefaultModel.mockResolvedValue('report-gen-model');
    mockWorkerService.runInWorker.mockResolvedValue(workerResponse('Done') as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('never calls the worker while /generate holds the lock — the corruption path this fix closes', async () => {
    tryClaimSessionGeneration(sessionId); // simulate a live /generate turn in progress

    const runPromise = runVerifiedChat({
      sessionId,
      userId: 'user-1',
      startingMessage: 'Generate the report.',
      keywords: [],
      requiredFunctions: [{ functionName: 'update_html_file', minCount: 1 }],
      maxAttempts: 1,
      attachments: [],
    });
    // Swallow the eventual rejection so it doesn't surface as an unhandled rejection
    // before the assertions below run.
    const outcome = runPromise.then(
      () => ({ threw: false as const }),
      (error) => ({ threw: true as const, error }),
    );

    await jest.advanceTimersByTimeAsync(20000); // exhausts the default retry budget (~12s)

    const result = await outcome;
    expect(result.threw).toBe(true);
    if (result.threw) {
      expect(isSessionBusyError(result.error)).toBe(true);
    }
    // The whole point: no write happened while /generate was still holding the session.
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
    expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
  });

  it('ENG-110: runVerifiedChat records the caller as the lock owner while it runs (so /generating lists scheduled/Slack/email runs) and clears it after', async () => {
    let ownerDuring: string | undefined;
    mockWorkerService.runInWorker.mockImplementationOnce(async () => {
      ownerDuring = sessionGenerationOwners.get(sessionId);
      return workerResponse('Done') as any;
    });
    await runVerifiedChat({
      sessionId,
      userId: 'user-1',
      startingMessage: 'Generate the report.',
      keywords: [],
      requiredFunctions: [{ functionName: 'update_html_file', minCount: 1 }],
      maxAttempts: 1,
      attachments: [],
    });
    expect(ownerDuring).toBe('user-1');
    expect(sessionGenerationOwners.size).toBe(0);
  });

  it('proceeds normally once the lock is free, and releases it again on success', async () => {
    const result = await runVerifiedChat({
      sessionId,
      userId: 'user-1',
      startingMessage: 'Generate the report.',
      keywords: [],
      requiredFunctions: [{ functionName: 'update_html_file', minCount: 1 }],
      maxAttempts: 1,
      attachments: [],
    });

    expect(result.success).toBe(true);
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
    // Released — a /generate call for this session right after must succeed.
    expect(activeSessionGenerations.has(sessionId)).toBe(false);
    expect(tryClaimSessionGeneration(sessionId)).toBe(true);
  });

  it('ENG-1719: releases the lock if the run itself hangs, instead of holding it forever', async () => {
    // The worker call never settles — simulates a stuck LLM/tool call inside
    // runVerifiedChatInner's attempt loop, which (per ENG-907) has no per-attempt
    // deadline of its own. Before this fix, runVerifiedChat had no outer bound either,
    // so this would hold activeSessionGenerations until a process restart.
    mockWorkerService.runInWorker.mockImplementationOnce(() => new Promise(() => {}));

    const runPromise = runVerifiedChat({
      sessionId,
      userId: 'user-1',
      startingMessage: 'Generate the report.',
      keywords: [],
      requiredFunctions: [{ functionName: 'update_html_file', minCount: 1 }],
      maxAttempts: 1,
      attachments: [],
    });
    const outcome = runPromise.then(
      () => ({ threw: false as const }),
      (error: any) => ({ threw: true as const, error }),
    );

    // Comfortably past the default 90-minute RUN_VERIFIED_CHAT_LOCK_TIMEOUT_MS — fake
    // timers make this instant, the real wall-clock duration doesn't matter here.
    await jest.advanceTimersByTimeAsync(91 * 60 * 1000);

    const result = await outcome;
    expect(result.threw).toBe(true);
    if (result.threw) {
      expect(result.error.isGenerationTimeout).toBe(true);
      // Distinct from SessionBusyError — this is "the run itself hung", not "someone
      // else is holding the lock".
      expect(isSessionBusyError(result.error)).toBe(false);
    }
    // The whole point: the lock released even though the worker call never resolved.
    expect(activeSessionGenerations.has(sessionId)).toBe(false);
    expect(tryClaimSessionGeneration(sessionId)).toBe(true);
  });

  it('ENG-1719 follow-up: a caller-supplied lockTimeoutMs overrides the short default', async () => {
    // Headless callers (runScheduledChat, resultEndpointController) pass
    // RUN_VERIFIED_CHAT_LOCK_TIMEOUT_LONG_MS explicitly. Prove the override is
    // actually honored: the short default alone would have released this lock
    // by 91 minutes (previous test) — this run must still hold it there, and only
    // release once the LONG ceiling is reached.
    mockWorkerService.runInWorker.mockImplementationOnce(() => new Promise(() => {}));

    const runPromise = runVerifiedChat({
      sessionId,
      userId: 'user-1',
      startingMessage: 'Generate the report.',
      keywords: [],
      requiredFunctions: [{ functionName: 'update_html_file', minCount: 1 }],
      maxAttempts: 1,
      attachments: [],
    }, { lockTimeoutMs: RUN_VERIFIED_CHAT_LOCK_TIMEOUT_LONG_MS });
    const outcome = runPromise.then(
      () => ({ threw: false as const }),
      (error: any) => ({ threw: true as const, error }),
    );

    // Past the SHORT default (90 min) but still well inside the LONG ceiling (6 hr) —
    // must still be holding the lock here if the override is honored.
    await jest.advanceTimersByTimeAsync(120 * 60 * 1000);
    expect(activeSessionGenerations.has(sessionId)).toBe(true);

    // Now past the LONG ceiling too — must release.
    await jest.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
    const result = await outcome;
    expect(result.threw).toBe(true);
    if (result.threw) {
      expect(result.error.isGenerationTimeout).toBe(true);
    }
    expect(activeSessionGenerations.has(sessionId)).toBe(false);
    expect(tryClaimSessionGeneration(sessionId)).toBe(true);
  });

  it('releases the lock even when the run fails internally', async () => {
    mockChatbotDb.getChatSession.mockRejectedValueOnce(new Error('DynamoDB throttled'));

    await expect(
      runVerifiedChat({
        sessionId,
        userId: 'user-1',
        startingMessage: 'Generate the report.',
        keywords: [],
        requiredFunctions: [{ functionName: 'update_html_file', minCount: 1 }],
        maxAttempts: 1,
        attachments: [],
      }),
    ).rejects.toThrow();

    expect(activeSessionGenerations.has(sessionId)).toBe(false);
  });

  it('a second concurrent runVerifiedChat call for the same session waits, does not corrupt state', async () => {
    // First call holds the lock for its whole run (simulated via a worker call that
    // doesn't resolve until we say so), matching one claim per invocation, not per attempt.
    let resolveFirstWorkerCall: (value: any) => void = () => {};
    mockWorkerService.runInWorker.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirstWorkerCall = resolve; }),
    );

    const first = runVerifiedChat({
      sessionId,
      userId: 'user-1',
      startingMessage: 'First run.',
      keywords: [],
      requiredFunctions: [{ functionName: 'update_html_file', minCount: 1 }],
      maxAttempts: 1,
      attachments: [],
    });
    await jest.advanceTimersByTimeAsync(0); // let the first call actually claim + call the worker

    mockWorkerService.runInWorker.mockResolvedValue(workerResponse('Second run done') as any);
    const second = runVerifiedChat({
      sessionId,
      userId: 'user-1',
      startingMessage: 'Second run.',
      keywords: [],
      requiredFunctions: [{ functionName: 'update_html_file', minCount: 1 }],
      maxAttempts: 1,
      attachments: [],
    });

    await jest.advanceTimersByTimeAsync(6000); // second call is mid-retry, first still running
    resolveFirstWorkerCall(workerResponse('First run done'));
    await jest.advanceTimersByTimeAsync(6000); // second call's next poll sees it free now

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
    // Never both in flight at once — worker calls were serialized, not interleaved.
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(2);
  });
});

describe('POST /verified-generate returns 409 SESSION_BUSY on lock timeout (ENG-1696)', () => {
  const sessionId = 'session-http-lock';
  const baseSession = {
    sessionId,
    userId: 'user-1',
    messages: [],
    llmModel: 'default-model',
  };

  const makeReq = () =>
    ({
      user: { userId: 'user-1', email: 'test@example.com' },
      body: {
        sessionId,
        startingMessage: 'Generate the report.',
        requiredFunctions: [{ functionName: 'update_html_file', minCount: 1 }],
        keywords: [],
        attachments: [],
        maxAttempts: 1,
      },
      on: jest.fn(),
    } as unknown as Request);

  const makeRes = () =>
    ({
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    activeSessionGenerations.clear();
    mockChatbotDb.getChatSession.mockResolvedValue(baseSession as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns 409 SESSION_BUSY, matching /generate\'s own shape, without paging oncall', async () => {
    tryClaimSessionGeneration(sessionId); // a live /generate turn holds this session

    const res = makeRes();
    const handlerPromise = agentModeController.verifiedGenerate(makeReq(), res);
    await jest.advanceTimersByTimeAsync(20000); // exhaust the retry budget
    await handlerPromise;

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Session is busy',
        code: 'SESSION_BUSY',
      }),
    );
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });
});
