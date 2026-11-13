/**
 * ENG-1239: a media-heavy interactive turn that hits the per-turn media time budget
 * (toolDispatch's media_generation_time_budget deferral) used to end the turn by asking
 * the user to reply "continue" — three of four requested images delivered, the fourth
 * silently left for the customer to notice and re-prompt for (production incident,
 * session 822c1ed4, 2026-08-14).
 *
 * The fix fires that continuation itself, detached from the request that just returned,
 * reusing generateSessionResponse exactly as a real "continue" reply would (so the
 * existing ENG-510 asset-dedup makes it idempotent). This test simulates the exact
 * reported shape — 3 completed images + a deferred 4th — and proves the 4th is resumed
 * automatically, delivered exactly once, and pushed to the live session over Socket.IO,
 * with no further auto-continuation once the batch is complete.
 */
import { Request, Response } from 'express';
import {
  agentModeController,
  activeSessionGenerations,
  autoContinuationSessions,
  preemptAutoContinuationAndWait,
  sessionGenerationOwners,
  releaseSessionGeneration,
} from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { requestCancel } from '../utils/sseProgress';
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
    getChatSessionRecord: jest.fn(),
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
  TURN_ADMISSION: { recordAdmission: true },
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
  // Spread the real module so new exports (e.g. isProviderUnavailableError) never leave the controller error handler calling undefined.
  ...jest.requireActual('../utils/agentModeErrors'),
  isContextLimitError: jest.fn().mockReturnValue(false),
  isSessionLimitError: jest.fn().mockReturnValue(false),
  isTransientLLMError: jest.fn().mockReturnValue(false),
  isWorkerShutdownError: jest.fn().mockReturnValue(false),
  isProviderNoEndpointsError: jest.fn().mockReturnValue(false),
}));

const mockIoEmit = jest.fn();
const mockIoTo = jest.fn().mockReturnValue({ emit: mockIoEmit });
jest.mock('../server', () => ({
  io: { to: mockIoTo },
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockRequestCancel = requestCancel as jest.Mock;
const mockSendOncallAlert = sendAgentModeOncallAlert as jest.Mock;
const mockCheckTokenUsage = checkTokenUsage as jest.Mock;

describe('AgentModeController - automatic media-batch continuation (ENG-1239)', () => {
  const mockUserId = 'user-media-batch';
  const mockSessionId = 'session-media-batch';
  const mockSession = {
    sessionId: mockSessionId,
    userId: mockUserId,
    title: 'Four Ad Creatives',
    messages: [],
    createdAt: '2026-08-14T00:00:00Z',
    updatedAt: '2026-08-14T00:00:00Z',
    portalType: 'agent' as const,
    pageIdentifier: 'agent-mode',
    llmModel: 'gpt-5-chat-2',
  };

  const makeReq = (message = 'Generate four 4:5 ad creatives') =>
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

  const imageToolCall = (n: number) => ({
    id: `tc-img-${n}`,
    name: 'generate_image',
    arguments: { prompt: `creative ${n}` },
    result: { success: true, imageUrl: `https://s3/creative-${n}.png`, filename: `creative-${n}.png` },
    duration: 4000,
  });

  const deferredToolCall = () => ({
    id: 'tc-img-4',
    name: 'generate_image',
    arguments: { prompt: 'creative 4' },
    result: { deferred: true, reason: 'media_generation_time_budget' },
    duration: 0,
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
        timestamp: '2026-08-14T18:20:51.000Z',
        metadata: { timestamp: '2026-08-14T18:20:51.000Z', toolCalls },
      },
    ],
    cancelled: false,
    persistedResponseCount: 0,
  });

  // Let the setImmediate-deferred auto-continuation (and its own chained promises)
  // fully settle before asserting.
  const flush = async (rounds = 20) => {
    for (let i = 0; i < rounds; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    autoContinuationSessions.clear();
    sessionGenerationOwners.clear();
    delete process.env.AGENT_RUN_STORE;
    mockSendOncallAlert.mockResolvedValue(undefined);
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
    (mockChatbotDb as any).getChatSessionRecord.mockResolvedValue(mockSession as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(mockSession as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(undefined as any);
  });

  it('auto-resumes a deferred 4th image after 3 succeed, delivers it exactly once, and pushes it live', async () => {
    mockWorkerService.runInWorker
      // Turn 1 (the customer's real request): 3 images succeed, the 4th is deferred —
      // matches the reported production session exactly.
      .mockResolvedValueOnce(
        workerResponse(
          '⚠️ Media generation paused for this turn — 3 of 4 images are done. Reply "continue" to get the last one.',
          [imageToolCall(1), imageToolCall(2), imageToolCall(3), deferredToolCall()],
        ),
      )
      // Turn 2 (the automatic continuation, NOT typed by the customer): the still-missing
      // 4th image completes and nothing further is deferred.
      .mockResolvedValueOnce(
        workerResponse('All 4 creatives are ready.', [
          { ...imageToolCall(4) },
        ]),
      );

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);

    // The customer's own request returns immediately with the partial batch — it does
    // NOT block on the background continuation.
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('3 of 4') }),
    );
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
    // Lock released for the customer's own request even though a background
    // continuation is about to claim it again.
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);

    await flush();

    // The batch auto-completed: exactly ONE additional worker turn ran (no polling loop,
    // no re-derivation of images 1-3), and it was NOT the customer typing "continue" —
    // it's the internal system-authored continuation directive.
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(2);
    const secondCallArgs = mockWorkerService.runInWorker.mock.calls[1][0] as any;
    expect(secondCallArgs.messageContent).toMatch(/automatic continuation/i);
    expect(secondCallArgs.messageContent).not.toBe('continue');

    // The finished 4th image reached the open session live over Socket.IO — the customer
    // sees the final outcome without reloading or re-prompting.
    expect(mockIoTo).toHaveBeenCalledWith(`user:${mockUserId}`);
    expect(mockIoEmit).toHaveBeenCalledWith(
      'session-message-appended',
      expect.objectContaining({
        sessionId: mockSessionId,
        message: expect.objectContaining({ content: 'All 4 creatives are ready.' }),
      }),
    );

    // Batch is complete (turn 2 had no deferred tool call) — no further rounds, and the
    // continuation's own lock is released.
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(2);
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
  });

  it('ENG-1495: the live-delivered continuation message carries the real persisted messageIndex, not just the content', async () => {
    // The default beforeEach mocks addMessagesToSession to resolve undefined (most
    // tests here don't care about the return value) -- override it for this test with
    // a realistic persisted-session shape so the messageIndex genuinely flows through
    // generateSessionResponse's own stamping into the socket emit, rather than only
    // exercising the defensive undefined-fallback path every other test in this file does.
    mockChatbotDb.addMessagesToSession.mockResolvedValue({
      ...mockSession,
      messages: [
        ...(mockSession.messages || []),
        {
          role: 'assistant',
          content: 'All 4 creatives are ready.',
          timestamp: '2026-08-14T18:20:51.000Z',
          metadata: { timestamp: '2026-08-14T18:20:51.000Z' },
          messageIndex: 42,
        },
      ],
    } as any);

    mockWorkerService.runInWorker
      .mockResolvedValueOnce(
        workerResponse(
          '⚠️ Media generation paused for this turn — 3 of 4 images are done. Reply "continue" to get the last one.',
          [imageToolCall(1), imageToolCall(2), imageToolCall(3), deferredToolCall()],
        ),
      )
      .mockResolvedValueOnce(
        workerResponse('All 4 creatives are ready.', [
          { ...imageToolCall(4) },
        ]),
      );

    await agentModeController.generateResponse(makeReq(), makeRes());
    await flush();

    expect(mockIoEmit).toHaveBeenCalledWith(
      'session-message-appended',
      expect.objectContaining({
        sessionId: mockSessionId,
        message: expect.objectContaining({
          content: 'All 4 creatives are ready.',
          messageIndex: 42,
        }),
      }),
    );
  });

  it('does not auto-continue when nothing was deferred (ordinary single-image turn)', async () => {
    mockWorkerService.runInWorker.mockResolvedValueOnce(
      workerResponse('Here is your image.', [imageToolCall(1)]),
    );

    const res = makeRes();
    await agentModeController.generateResponse(makeReq('Generate one image'), res);
    await flush();

    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
    expect(mockIoEmit).not.toHaveBeenCalled();
  });

  it('stops after AUTO_MEDIA_CONTINUATION_MAX_ROUNDS rounds instead of retrying forever', async () => {
    const AUTO_MEDIA_CONTINUATION_MAX_ROUNDS = 4;
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // A persistently slow/broken provider: the customer's own turn AND every single
    // auto-continuation round come back still deferring the 4th image.
    mockWorkerService.runInWorker.mockResolvedValue(
      workerResponse(
        '⚠️ Media generation paused for this turn — 3 of 4 images are done. Reply "continue" to get the last one.',
        [imageToolCall(1), imageToolCall(2), imageToolCall(3), deferredToolCall()],
      ),
    );

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    await flush(200);

    // 1 customer turn + AUTO_MEDIA_CONTINUATION_MAX_ROUNDS auto-continuation rounds — the
    // cap stops the (round + 1) recursion from ever firing a 5th continuation attempt.
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1 + AUTO_MEDIA_CONTINUATION_MAX_ROUNDS);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`${AUTO_MEDIA_CONTINUATION_MAX_ROUNDS} rounds`),
    );
    // The last round's lock still released — the cap doesn't leave the session wedged.
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);

    consoleErrorSpy.mockRestore();
  });

  it('ENG-110: a REAL continuation holds the lock without a cap slot yet is listed by /generating for its owner only, then released with no owner leak', async () => {
    const seen: any = {};
    const listFor = async (userId: string) => {
      const r = makeRes();
      await agentModeController.getGeneratingSessions({ user: { userId } } as any, r);
      return (r.json as jest.Mock).mock.calls[0][0].sessionIds;
    };
    mockWorkerService.runInWorker
      .mockResolvedValueOnce(
        workerResponse('paused', [imageToolCall(1), imageToolCall(2), imageToolCall(3), deferredToolCall()]),
      )
      .mockImplementationOnce(async () => {
        seen.continuation = autoContinuationSessions.has(mockSessionId);
        seen.owner = sessionGenerationOwners.get(mockSessionId);
        seen.ownerList = await listFor(mockUserId);
        seen.otherList = await listFor('someone-else');
        const gr = makeRes();
        await agentModeController.getSession({ params: { sessionId: mockSessionId }, user: { userId: mockUserId } } as any, gr);
        seen.isGenerating = (gr.json as jest.Mock).mock.calls[0]?.[0]?.isGenerating;
        return workerResponse('All 4 creatives are ready.', [imageToolCall(4)]);
      });

    await agentModeController.generateResponse(makeReq(), makeRes());
    await flush();

    expect(seen.continuation).toBe(true);
    expect(seen.owner).toBe(mockUserId);
    expect(seen.ownerList).toEqual([mockSessionId]);
    expect(seen.otherList).toEqual([]);
    expect(seen.isGenerating).toBe(true);
    expect(sessionGenerationOwners.size).toBe(0);
    expect(activeSessionGenerations.size).toBe(0);
    expect(await listFor(mockUserId)).toEqual([]);
  });

  it('releases the lock and does not recurse when a continuation call rejects outright', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    mockWorkerService.runInWorker
      // Turn 1: the customer's real request, 3 of 4 delivered, the 4th deferred.
      .mockResolvedValueOnce(
        workerResponse(
          '⚠️ Media generation paused for this turn — 3 of 4 images are done. Reply "continue" to get the last one.',
          [imageToolCall(1), imageToolCall(2), imageToolCall(3), deferredToolCall()],
        ),
      )
      // Turn 2: the auto-continuation itself fails outright (e.g. a provider outage),
      // not just another deferral.
      .mockRejectedValueOnce(new Error('provider outage'));

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    await flush();

    // Exactly one continuation attempt was made — the hard failure must not be treated
    // as "still deferred" and retried.
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('media auto-continuation failed'),
      expect.any(Error),
    );
    // The lock from the failed continuation attempt was released, not left held.
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);

    consoleErrorSpy.mockRestore();
  });

  /**
   * ENG-1719 — live-found alongside the identical work-plan defect (see
   * agentModeController.workPlanAutoContinuation.test.ts). A media continuation round
   * killed by withGenerationTimeout rejects rather than resolving, and `stillDeferred` was
   * assigned only in `.then()` — a timed-out round silently ended the retry chain without
   * consuming a round, so AUTO_MEDIA_CONTINUATION_MAX_ROUNDS's exhaustion message/alert
   * never fired and an unresolved media batch died with no notice.
   */
  describe('ENG-1719: a media continuation round killed by the generation timeout', () => {
    const timeoutError = () => Object.assign(new Error('Generation timed out'), { isGenerationTimeout: true });
    // hasPersistedMediaBudgetDeferral only checks the marker's timestamp is >= the round's
    // start — a far-future timestamp satisfies that regardless of real wall-clock timing,
    // since this file uses real timers (setImmediate-based flush), not fake ones.
    const deferredMarkerMessage = () => ({
      role: 'assistant',
      content: 'placeholder',
      timestamp: '2030-01-01T00:00:00.000Z',
      metadata: { timestamp: '2030-01-01T00:00:00.000Z', mediaBudgetDeferred: true },
    });

    it('still clears the progress entry when the round times out, so the tab does not spin forever', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockWorkerService.runInWorker
        .mockResolvedValueOnce(
          workerResponse(
            '⚠️ Media generation paused for this turn — 3 of 4 images are done. Reply "continue" to get the last one.',
            [imageToolCall(1), imageToolCall(2), imageToolCall(3), deferredToolCall()],
          ),
        )
        // The continuation round itself times out. The post-timeout re-read below reports
        // the batch as no longer deferred, so nothing retries — isolates this test to the
        // progress-cleanup behavior specifically.
        .mockRejectedValueOnce(timeoutError());
      (mockChatbotDb as any).getChatSessionRecord.mockResolvedValue(mockSession as any); // no deferral marker

      const res = makeRes();
      await agentModeController.generateResponse(makeReq(), res);
      await flush();

      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(2);
      expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
      expect(autoContinuationSessions.has(mockSessionId)).toBe(false);

      consoleErrorSpy.mockRestore();
    });

    it('keeps the retry chain alive by re-reading the persisted deferral marker instead of ending silently', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockWorkerService.runInWorker
        .mockResolvedValueOnce(
          workerResponse(
            '⚠️ Media generation paused for this turn — 3 of 4 images are done. Reply "continue" to get the last one.',
            [imageToolCall(1), imageToolCall(2), imageToolCall(3), deferredToolCall()],
          ),
        )
        .mockRejectedValueOnce(timeoutError())
        .mockResolvedValueOnce(workerResponse('All 4 creatives are ready.', [imageToolCall(4)]));
      (mockChatbotDb as any).getChatSessionRecord.mockResolvedValue({
        ...mockSession,
        messages: [deferredMarkerMessage()],
      } as any);

      const res = makeRes();
      await agentModeController.generateResponse(makeReq(), res);
      await flush();

      // 1 customer turn + the timed-out round + the re-fired round that finally lands it.
      // Before the fix the chain stopped at 2, leaving the 4th image permanently missing.
      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(3);
      expect(activeSessionGenerations.has(mockSessionId)).toBe(false);

      consoleErrorSpy.mockRestore();
    });

    it('fails CLOSED when the post-timeout re-read also fails, rather than retrying blind', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockWorkerService.runInWorker
        .mockResolvedValueOnce(
          workerResponse(
            '⚠️ Media generation paused for this turn — 3 of 4 images are done. Reply "continue" to get the last one.',
            [imageToolCall(1), imageToolCall(2), imageToolCall(3), deferredToolCall()],
          ),
        )
        .mockRejectedValueOnce(timeoutError());
      (mockChatbotDb as any).getChatSessionRecord.mockRejectedValue(new Error('DynamoDB throttled'));

      const res = makeRes();
      await agentModeController.generateResponse(makeReq(), res);
      await flush();

      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(2);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('media auto-continuation could not re-read session'),
        expect.any(Error),
      );
      expect(activeSessionGenerations.has(mockSessionId)).toBe(false);

      consoleErrorSpy.mockRestore();
    });
  });

  /**
   * ENG-1239 (rework, code review): every other generateSessionResponse call site gates on
   * the customer's token/cost allowance before generating — scheduleAutoMediaContinuation
   * bypassed that gate entirely, which would let an auto-continuation generate (and bill)
   * an image for a customer whose allowance is already exhausted. The fix added a
   * checkTokenUsage call before claiming the session lock; these two tests cover the
   * skip-on-exhausted and fail-closed-on-error branches, which had no coverage.
   */
  describe('checkTokenUsage entitlement gate', () => {
    it('does NOT auto-continue when the customer has exhausted their usage allowance', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      // The customer's own turn 1 request passes through its own, separate checkTokenUsage
      // gate (agentModeController's main request handler) before ever reaching
      // scheduleAutoMediaContinuation's gate — queue that first call as allowed so turn 1
      // succeeds normally, then make the auto-continuation's OWN check the exhausted one.
      mockCheckTokenUsage
        .mockResolvedValueOnce({
          allowed: true, warning: false, used: 0, allowance: 100,
          bonus: 0, effectiveAllowance: 100, percentUsed: 0, month: '2026-08',
        })
        .mockResolvedValueOnce({
          allowed: false, warning: true, used: 100, allowance: 100,
          bonus: 0, effectiveAllowance: 100, percentUsed: 100, month: '2026-08',
        });

      // Turn 1 (the customer's real request): 3 images succeed, the 4th is deferred.
      mockWorkerService.runInWorker.mockResolvedValueOnce(
        workerResponse(
          '⚠️ Media generation paused for this turn — 3 of 4 images are done. Reply "continue" to get the last one.',
          [imageToolCall(1), imageToolCall(2), imageToolCall(3), deferredToolCall()],
        ),
      );

      const res = makeRes();
      await agentModeController.generateResponse(makeReq(), res);
      await flush();

      // The usage check ran before any continuation work, and no second worker turn
      // (the auto-continuation itself) was ever attempted — no image generated, no charge.
      // A turn gate (ENG-668): it may record a pay-as-you-go admission.
      expect(mockCheckTokenUsage).toHaveBeenCalledWith(mockUserId, { recordAdmission: true });
      expect(mockCheckTokenUsage).toHaveBeenCalledTimes(2);
      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('usage limit'),
      );
      // The manual "continue" prompt is left as the customer's only path — no lock held.
      expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
      expect(mockIoEmit).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('fails closed (does not auto-continue) when the usage check itself errors', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      // Same reasoning as above: turn 1's own gate must pass first so it reaches the
      // deferred state; the auto-continuation's own check is the one that errors.
      mockCheckTokenUsage
        .mockResolvedValueOnce({
          allowed: true, warning: false, used: 0, allowance: 100,
          bonus: 0, effectiveAllowance: 100, percentUsed: 0, month: '2026-08',
        })
        .mockRejectedValueOnce(new Error('DynamoDB throttled'));

      mockWorkerService.runInWorker.mockResolvedValueOnce(
        workerResponse(
          '⚠️ Media generation paused for this turn — 3 of 4 images are done. Reply "continue" to get the last one.',
          [imageToolCall(1), imageToolCall(2), imageToolCall(3), deferredToolCall()],
        ),
      );

      const res = makeRes();
      await agentModeController.generateResponse(makeReq(), res);
      await flush();

      // A lookup failure must not be treated as "allowed" — no continuation attempt,
      // no crash (this call site is unawaited fire-and-forget and must never reject).
      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('usage check failed'),
        expect.any(Error),
      );
      expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
      expect(mockIoEmit).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });

  /**
   * ENG-1239 (rework, found via live testing on the preview): a continuation preempted by
   * a genuine customer message (see preemptAutoContinuationAndWait) sends a cooperative
   * cancel signal, but an already-dispatched provider call can't be aborted — the image
   * finishes and is correctly saved regardless. The loop then stops (cancelled: true)
   * BEFORE composing a closing reply, so `content` comes back empty even though a new
   * asset landed — leaving a bare, unexplained image-generated marker in history with no
   * "batch complete" narration (confirmed live: session a3e1dda2, 2026-08-19). This must
   * still close the loop out explicitly instead of silently dropping the wrap-up.
   */
  it('leaves an explicit closing note when a preempted (cancelled) continuation still lands a new image', async () => {
    mockWorkerService.runInWorker
      .mockResolvedValueOnce(
        workerResponse(
          '⚠️ Media generation paused for this turn — 3 of 4 images are done. Reply "continue" to get the last one.',
          [imageToolCall(1), imageToolCall(2), imageToolCall(3), deferredToolCall()],
        ),
      )
      // Turn 2 (the continuation): cancelled mid-flight by a preempting request, but the
      // already-in-flight 4th image finished anyway — no composed content, cancelled: true.
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [imageToolCall(4)],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
        cancelled: true,
        persistedResponseCount: 0,
      });

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    await flush();

    expect(mockChatbotDb.addMessageToSession).toHaveBeenCalledWith(
      mockSessionId,
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringMatching(/finished|complete/i),
      }),
    );
    expect(mockIoTo).toHaveBeenCalledWith(`user:${mockUserId}`);
    expect(mockIoEmit).toHaveBeenCalledWith(
      'session-message-appended',
      expect.objectContaining({
        message: expect.objectContaining({ content: expect.stringMatching(/finished|complete/i) }),
      }),
    );
    // Cancelled + no longer deferred (the toolCalls ledger shows a success, not another
    // defer) — must not be mistaken for "still deferred" and recursed into another round.
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(2);
  });

  it('does NOT leave a closing note when a cancelled continuation produced nothing new (avoid a confusing empty message)', async () => {
    mockWorkerService.runInWorker
      .mockResolvedValueOnce(
        workerResponse(
          '⚠️ Media generation paused for this turn — 3 of 4 images are done. Reply "continue" to get the last one.',
          [imageToolCall(1), imageToolCall(2), imageToolCall(3), deferredToolCall()],
        ),
      )
      // Cancelled before the 4th image call even started — nothing new to report.
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
        cancelled: true,
        persistedResponseCount: 0,
      });

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    await flush();

    expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalledWith(
      mockSessionId,
      expect.objectContaining({ content: expect.stringMatching(/asset.*finished/i) }),
    );
    expect(mockIoEmit).not.toHaveBeenCalled();
  });

  /**
   * ENG-1239 (rework): the tests above all simulate a turn that returns SUCCESSFULLY
   * with a deferred tool call in its `toolCalls` ledger — the "soft" case. Pulling the
   * real production session (822c1ed4, 2026-08-14) message-by-message showed the actual
   * reported incident took a DIFFERENT path: the model's own wrap-up reply itself ran
   * past the whole-turn hard cap (GENERATION_TIMEOUT_MS), so `withGenerationTimeout`
   * rejected with `isGenerationTimeout` and the request never got a `response` object at
   * all — the customer-facing message came from the separate ENG-510 partial-delivery
   * catch branch instead (`kind: 'generation-timeout-continuation'`), which never called
   * scheduleAutoMediaContinuation. These tests cover that branch directly.
   */
  describe('whole-turn hard-timeout variant (the actual reported incident shape)', () => {
    const timeoutError = () => {
      const err: any = new Error(`Generation timed out after 600000ms for session ${mockSessionId}.`);
      err.isGenerationTimeout = true;
      return err;
    };

    const imageMarker = (n: number, iso: string) => ({
      role: 'tool',
      metadata: { kind: 'image-generated', imageUrl: `https://s3/creative-${n}.png`, imageFilename: `creative-${n}.png`, timestamp: iso },
    });

    const deferredMarker = (iso: string) => ({
      role: 'tool',
      metadata: { mediaBudgetDeferred: true, timestamp: iso },
    });

    it('auto-resumes after a whole-turn hard timeout when 3 images landed and a media-budget deferral was persisted', async () => {
      const futureIso = new Date(Date.now() + 5000).toISOString();
      mockChatbotDb.getChatSession.mockImplementation(async (id: string, consistentRead?: boolean) =>
        consistentRead
          ? ({ ...mockSession, messages: [imageMarker(1, futureIso), imageMarker(2, futureIso), imageMarker(3, futureIso), deferredMarker(futureIso)] } as any)
          : (mockSession as any),
      );
      mockWorkerService.runInWorker
        .mockRejectedValueOnce(timeoutError()) // the customer's own turn hits the hard cap
        .mockResolvedValueOnce(workerResponse('All 4 creatives are ready.', [imageToolCall(4)])); // the auto-continuation

      const res = makeRes();
      await agentModeController.generateResponse(makeReq(), res);

      // The customer's own request still gets the ENG-510 partial-delivery response
      // immediately — it does not block on the background continuation.
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ partialMediaDelivery: true }),
      );
      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);

      await flush();

      // The batch auto-completed via exactly one background continuation round, fired
      // by the SERVER (not the customer retyping "continue"), and delivered live.
      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(2);
      const secondCallArgs = mockWorkerService.runInWorker.mock.calls[1][0] as any;
      expect(secondCallArgs.messageContent).toMatch(/automatic continuation/i);
      expect(mockIoTo).toHaveBeenCalledWith(`user:${mockUserId}`);
      expect(mockIoEmit).toHaveBeenCalledWith(
        'session-message-appended',
        expect.objectContaining({ message: expect.objectContaining({ content: 'All 4 creatives are ready.' }) }),
      );
      expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
    });

    it('does NOT auto-continue on a whole-turn hard timeout when nothing was actually deferred', async () => {
      const futureIso = new Date(Date.now() + 5000).toISOString();
      // 3 images landed before the cap fired, but no mediaBudgetDeferred marker — e.g.
      // an unrelated slow step (not a 4th deferred image) is what blew the turn budget.
      mockChatbotDb.getChatSession.mockImplementation(async (id: string, consistentRead?: boolean) =>
        consistentRead
          ? ({ ...mockSession, messages: [imageMarker(1, futureIso), imageMarker(2, futureIso), imageMarker(3, futureIso)] } as any)
          : (mockSession as any),
      );
      mockWorkerService.runInWorker.mockRejectedValueOnce(timeoutError());

      const res = makeRes();
      await agentModeController.generateResponse(makeReq(), res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ partialMediaDelivery: true }));

      await flush();

      // No unwanted extra continuation call — nothing was actually left deferred.
      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
      expect(mockIoEmit).not.toHaveBeenCalled();
    });

    // ENG-1719: the work-plan/media guard on this timeout path was gated on
    // hasPersistedMediaBudgetDeferral ALONE — true whenever a deferral marker exists,
    // regardless of whether any image actually completed. buildTimeoutContinuationMessage
    // (what actually decides whether the media continuation fires) returns null when zero
    // images completed — so a deferral marker persisted with zero completed images
    // suppressed the work-plan continuation for a media continuation that was NEVER
    // going to fire either. Neither ran. This is the interaction-bug regression test.
    it('still auto-continues the WORK PLAN when a deferral marker exists but zero images completed', async () => {
      const futureIso = new Date(Date.now() + 5000).toISOString();
      const pendingWorkPlan = {
        planId: 'plan-1',
        autocomplete: true,
        steps: [{ stepCount: 1, status: 'pending' }],
      };
      // A deferral marker WAS persisted, but no image-generated markers — the cap fired
      // before the first image in the batch finished, so buildTimeoutContinuationMessage
      // will see zero images and return null (media's own gate never opens).
      mockChatbotDb.getChatSession.mockImplementation(async (id: string, consistentRead?: boolean) =>
        consistentRead
          ? ({ ...mockSession, workPlan: pendingWorkPlan, messages: [deferredMarker(futureIso)] } as any)
          : (mockSession as any),
      );
      // scheduleAutoWorkPlanContinuation's own pre-fire recheck reads the base record via
      // getChatSessionRecord, independent of the getChatSession(..., true) call above.
      (mockChatbotDb as any).getChatSessionRecord.mockResolvedValue({ ...mockSession, workPlan: pendingWorkPlan } as any);
      mockWorkerService.runInWorker
        .mockRejectedValueOnce(timeoutError()) // the customer's own turn hits the hard cap
        .mockResolvedValueOnce(workerResponse('Step 1 complete.', [])); // the work-plan auto-continuation

      const res = makeRes();
      await agentModeController.generateResponse(makeReq(), res);
      // Nothing was salvageable for the CUSTOMER-FACING response in this exact scenario
      // (zero images, no other salvaged work) — it correctly falls through to the generic
      // 504. That's expected and irrelevant to what this test checks: the work-plan
      // continuation is scheduled via setImmediate BEFORE that fallthrough decision, so it
      // fires regardless of what the customer's own response ends up being.
      expect(res.status).toHaveBeenCalledWith(504);
      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);

      await flush();

      // Before the fix: neither continuation fired (stuck at 1 call forever). After the
      // fix: the work-plan continuation correctly takes over since media's own gate never
      // would have opened for this turn.
      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(2);
      const secondCallArgs = mockWorkerService.runInWorker.mock.calls[1][0] as any;
      expect(secondCallArgs.messageContent).toMatch(/automatic continuation/i);
    });

    it('also auto-resumes on the interactive-share route after a whole-turn hard timeout', async () => {
      const shareId = 'ishare-media-batch';
      const conversableToken = 'tok-media-batch';
      const futureIso = new Date(Date.now() + 5000).toISOString();
      const shareSession = {
        ...mockSession,
        sessionId: shareId,
        interactiveShareMetadata: {
          isActive: true,
          token: conversableToken,
          sharedAt: new Date().toISOString(),
          expiresAt: '2099-01-01T00:00:00Z',
        },
      };
      mockChatbotDb.getChatSession.mockImplementation(async (id: string, consistentRead?: boolean) =>
        consistentRead
          ? ({ ...shareSession, messages: [imageMarker(1, futureIso), imageMarker(2, futureIso), imageMarker(3, futureIso), deferredMarker(futureIso)] } as any)
          : (shareSession as any),
      );
      mockWorkerService.runInWorker
        .mockRejectedValueOnce(timeoutError())
        .mockResolvedValueOnce(workerResponse('All 4 creatives are ready.', [imageToolCall(4)]));

      const shareReq = {
        params: { shareId },
        query: { conversable: conversableToken },
        body: { userMessage: 'Generate four 4:5 ad creatives', attachments: [] },
        ip: '127.0.0.1',
        headers: {},
      } as unknown as Request;
      const res = makeRes();
      await agentModeController.generateSharedResponse(shareReq, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ partialMediaDelivery: true }));

      await flush();

      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(2);
      const secondCallArgs = mockWorkerService.runInWorker.mock.calls[1][0] as any;
      expect(secondCallArgs.messageContent).toMatch(/automatic continuation/i);
      expect(mockIoTo).toHaveBeenCalledWith(`user:${mockUserId}`);
      // ENG-2816: the follow-up of a VISITOR's turn is a visitor turn too, not one with the owner's full tool set.
      expect((mockWorkerService.runInWorker.mock.calls[0][0] as any).isInteractiveShare).toBe(true);
      expect(secondCallArgs.isInteractiveShare).toBe(true);
    });

    it('ENG-2816: a visitor\'s follow-up keeps the flag through EVERY round of a persistently slow provider', async () => {
      const shareId = 'ishare-media-batch-chain';
      const conversableToken = 'tok-media-batch-chain';
      const futureIso = new Date(Date.now() + 5000).toISOString();
      const shareSession = {
        ...mockSession,
        sessionId: shareId,
        interactiveShareMetadata: { isActive: true, token: conversableToken, sharedAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00Z' },
      };
      mockChatbotDb.getChatSession.mockImplementation(async (id: string, consistentRead?: boolean) =>
        consistentRead
          ? ({ ...shareSession, messages: [imageMarker(1, futureIso), imageMarker(2, futureIso), imageMarker(3, futureIso), deferredMarker(futureIso)] } as any)
          : (shareSession as any),
      );
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockWorkerService.runInWorker
        .mockRejectedValueOnce(timeoutError())
        .mockResolvedValue(workerResponse(
          '⚠️ Media generation paused for this turn — 3 of 4 images are done.',
          [imageToolCall(1), imageToolCall(2), imageToolCall(3), deferredToolCall()],
        ));

      await agentModeController.generateSharedResponse({
        params: { shareId },
        query: { conversable: conversableToken },
        body: { userMessage: 'Generate four 4:5 ad creatives', attachments: [] },
        ip: '127.0.0.1',
        headers: {},
      } as unknown as Request, makeRes());
      await flush(200);

      // The visitor's own turn plus every continuation round (the cap is 4): none of them may run unflagged.
      const calls = mockWorkerService.runInWorker.mock.calls as any[];
      expect(calls.length).toBeGreaterThanOrEqual(3);
      for (const c of calls) expect(c[0].isInteractiveShare).toBe(true);
      consoleErrorSpy.mockRestore();
    });

    it('ENG-2816: the follow-up of the share link OWNER\'s own turn stays an owner turn', async () => {
      const shareId = 'ishare-media-batch-owner';
      const conversableToken = 'tok-media-batch-owner';
      const futureIso = new Date(Date.now() + 5000).toISOString();
      const shareSession = {
        ...mockSession,
        sessionId: shareId,
        interactiveShareMetadata: { isActive: true, token: conversableToken, sharedAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00Z' },
      };
      mockChatbotDb.getChatSession.mockImplementation(async (id: string, consistentRead?: boolean) =>
        consistentRead
          ? ({ ...shareSession, messages: [imageMarker(1, futureIso), imageMarker(2, futureIso), imageMarker(3, futureIso), deferredMarker(futureIso)] } as any)
          : (shareSession as any),
      );
      mockWorkerService.runInWorker
        .mockRejectedValueOnce(timeoutError())
        .mockResolvedValueOnce(workerResponse('All 4 creatives are ready.', [imageToolCall(4)]));
      const ownerCheck = jest.spyOn(require('../services/shareViewerIdentity'), 'isSessionOwnerRequest').mockResolvedValue(true);
      try {
        const shareReq = {
          params: { shareId },
          query: { conversable: conversableToken },
          body: { userMessage: 'Generate four 4:5 ad creatives', attachments: [] },
          ip: '127.0.0.1',
          headers: { authorization: 'Bearer owner.jwt' },
        } as unknown as Request;
        await agentModeController.generateSharedResponse(shareReq, makeRes());
        await flush();
        expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(2);
        expect((mockWorkerService.runInWorker.mock.calls[0][0] as any).isInteractiveShare).toBe(false);
        expect((mockWorkerService.runInWorker.mock.calls[1][0] as any).isInteractiveShare).toBe(false);
      } finally {
        ownerCheck.mockRestore();
      }
    });
  });

  /**
   * ENG-1239 (rework): a genuine customer message that collided with a background
   * auto-continuation used to get a flat 409 SESSION_BUSY — for a request the customer
   * had every right to make, blocked by work they never asked for or knew was running.
   * preemptAutoContinuationAndWait cancels the continuation and gives it a bounded
   * window to actually release before falling back to the old 409. Tested directly
   * (rather than driving the full /generate handler through real multi-second timing)
   * so the test stays fast and isolates the preemption logic itself.
   */
  describe('preemptAutoContinuationAndWait', () => {
    it('is a no-op (returns false, no cancel calls) when the lock is held by a REAL request, not an auto-continuation', async () => {
      activeSessionGenerations.add(mockSessionId); // some other real request holds it
      // deliberately NOT added to autoContinuationSessions

      const preempted = await preemptAutoContinuationAndWait(mockSessionId);

      expect(preempted).toBe(false);
      expect(mockRequestCancel).not.toHaveBeenCalled();
      expect(mockWorkerService.cancelSession).not.toHaveBeenCalled();
    });

    it('ENG-110: the preempting request\'s re-claim records its owner (polling loop path)', async () => {
      activeSessionGenerations.add(mockSessionId);
      autoContinuationSessions.add(mockSessionId);
      const p = preemptAutoContinuationAndWait(mockSessionId, 'owner-1');
      setTimeout(() => activeSessionGenerations.delete(mockSessionId), 10);
      expect(await p).toBe(true);
      expect(sessionGenerationOwners.get(mockSessionId)).toBe('owner-1');
      releaseSessionGeneration(mockSessionId);
      expect(sessionGenerationOwners.size).toBe(0);
    });

    it('ENG-110: the preempting request\'s FINAL re-claim (after the window) records its owner', async () => {
      autoContinuationSessions.add(mockSessionId); // continuation flagged, lock already free
      const realNow = Date.now();
      const nowSpy = jest.spyOn(Date, 'now')
        .mockReturnValueOnce(realNow) // deadline computation
        .mockReturnValue(realNow + 10 * 60 * 1000); // window already over: loop skipped
      try {
        expect(await preemptAutoContinuationAndWait(mockSessionId, 'owner-2')).toBe(true);
      } finally {
        nowSpy.mockRestore();
      }
      expect(sessionGenerationOwners.get(mockSessionId)).toBe('owner-2');
      releaseSessionGeneration(mockSessionId);
    });

    it('cancels the auto-continuation and re-claims the lock once it releases within the window', async () => {
      activeSessionGenerations.add(mockSessionId);
      autoContinuationSessions.add(mockSessionId);

      const preemptPromise = preemptAutoContinuationAndWait(mockSessionId);
      // Simulate the cancelled continuation's own .finally() releasing the lock shortly
      // after cancellation is requested (cooperative — not instant).
      setTimeout(() => {
        autoContinuationSessions.delete(mockSessionId);
        activeSessionGenerations.delete(mockSessionId);
      }, 10);

      const preempted = await preemptPromise;

      expect(preempted).toBe(true);
      expect(mockRequestCancel).toHaveBeenCalledWith(mockSessionId);
      expect(mockWorkerService.cancelSession).toHaveBeenCalledWith(mockSessionId);
      // The lock is now held for the caller (the real request), not left free.
      expect(activeSessionGenerations.has(mockSessionId)).toBe(true);
    });
  });

  /**
   * ENG-1239 (rework): after the round cap, the customer's last visible signal used to be
   * indistinguishable from an ordinary single deferral — nothing told them automatic
   * retries had been exhausted, and nobody but a console.error would know a provider was
   * this degraded. This closes both gaps.
   */
  it('leaves an explicit closing message and pages on-call once the round cap is exhausted', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockWorkerService.runInWorker.mockResolvedValue(
      workerResponse(
        '⚠️ Media generation paused for this turn — 3 of 4 images are done. Reply "continue" to get the last one.',
        [imageToolCall(1), imageToolCall(2), imageToolCall(3), deferredToolCall()],
      ),
    );

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    await flush(200);

    expect(mockChatbotDb.addMessageToSession).toHaveBeenCalledWith(
      mockSessionId,
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringMatching(/wasn't able to finish this batch automatically/i),
        metadata: expect.objectContaining({ kind: 'auto-continuation-exhausted' }),
      }),
    );
    expect(mockIoEmit).toHaveBeenCalledWith(
      'session-message-appended',
      expect.objectContaining({
        message: expect.objectContaining({ content: expect.stringMatching(/wasn't able to finish/i) }),
      }),
    );
    expect(mockSendOncallAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringMatching(/retry cap/i),
        context: expect.objectContaining({ sessionId: mockSessionId }),
      }),
    );

    consoleErrorSpy.mockRestore();
  });

  /**
   * CodeRabbit (PR #2479): the exhaustion branch's live-delivery step
   * (`io.to(...).emit(...)`) ran outside any try/catch, and every floating invocation of
   * scheduleAutoMediaContinuation (every setImmediate kickoff, plus the recursive
   * round+1 call) had no `.catch`. The function's own contract (see the comment above
   * checkTokenUsage) says it must never reject — but an emit failure here would reject
   * it anyway, and under Node's default `--unhandled-rejections=throw` an unhandled
   * rejection on a fire-and-forget call crashes the whole backend process, not just this
   * one session's turn. This proves a live-delivery failure during exhaustion is caught
   * and logged instead of becoming an unhandled rejection.
   */
  it('does not crash the process when live-delivery fails while persisting the exhaustion closing note', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    // Empty content on every round so the REGULAR (non-exhaustion) live-push branch
    // never calls io.to() at all — stillDeferred is driven by toolCalls, independent
    // of content, so recursion still runs all the way to the exhaustion round. This
    // isolates the mocked throw to the exhaustion branch's OWN io.to() call specifically.
    mockWorkerService.runInWorker.mockResolvedValue(
      workerResponse('', [imageToolCall(1), imageToolCall(2), imageToolCall(3), deferredToolCall()]),
    );
    mockIoTo.mockImplementationOnce(() => {
      throw new Error('socket server not initialized');
    });

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    await flush(200);
    // Give a genuinely unhandled rejection (if this regressed) a macrotask to surface —
    // flush() only drains microtasks/setImmediate, not the process-level event.
    await new Promise((resolve) => setTimeout(resolve, 10));

    process.off('unhandledRejection', onUnhandledRejection);

    expect(unhandledRejections).toEqual([]);
    // The closing note was still persisted — the failure is in DELIVERING it live, not
    // in producing it.
    expect(mockChatbotDb.addMessageToSession).toHaveBeenCalledWith(
      mockSessionId,
      expect.objectContaining({ metadata: expect.objectContaining({ kind: 'auto-continuation-exhausted' }) }),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to emit'),
      expect.any(Error),
    );

    consoleErrorSpy.mockRestore();
  });

  /**
   * ENG-1239 (rework): the auto-continuation chain is purely in-process — a deploy or
   * crash between rounds loses it with no record it was ever attempted. getSession is a
   * durability backstop: any later touch of the session re-checks whether the tail of
   * history still shows an unresolved pause and re-fires the resume if so.
   */
  describe('getSession durability backstop', () => {
    const recentIso = () => new Date(Date.now() - 5000).toISOString();
    const staleIso = () => new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago

    const makeGetSessionReq = (userOverride?: Partial<{ userId: string; isAdmin: boolean }>, delegateInfo?: any) =>
      ({
        params: { sessionId: mockSessionId },
        user: { userId: mockUserId, isAdmin: false, ...userOverride },
        ...(delegateInfo ? { delegateInfo } : {}),
      } as unknown as Request);

    const sessionWithDeferralAt = (iso: string) => ({
      ...mockSession,
      messages: [{
        role: 'assistant',
        content: '3 done',
        timestamp: iso,
        metadata: { kind: 'generation-timeout-continuation', mediaBudgetDeferred: true, timestamp: iso },
      }],
    });

    it('re-fires the auto-continuation when the GENUINE owner reopens a recent, unresolved deferral with nothing running', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithDeferralAt(recentIso()) as any);
      mockWorkerService.runInWorker.mockResolvedValueOnce(workerResponse('All 4 creatives are ready.', [imageToolCall(4)]));

      const res = makeRes();
      await agentModeController.getSession(makeGetSessionReq(), res);
      await flush();

      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
      const callArgs = mockWorkerService.runInWorker.mock.calls[0][0] as any;
      expect(callArgs.messageContent).toMatch(/automatic continuation/i);
    });

    it('ENG-2816: the owner reopening a chat whose deferred request was a VISITOR\'s resumes it as a visitor turn', async () => {
      const iso = recentIso();
      mockChatbotDb.getChatSession.mockResolvedValue({
        ...mockSession,
        messages: [
          { role: 'user', content: 'make four creatives', metadata: { timestamp: iso, ishareSender: { isAnonymous: true } } },
          { role: 'assistant', content: '3 done', timestamp: iso, metadata: { kind: 'generation-timeout-continuation', mediaBudgetDeferred: true, timestamp: iso } },
        ],
      } as any);
      mockWorkerService.runInWorker.mockResolvedValueOnce(workerResponse('All 4 creatives are ready.', [imageToolCall(4)]));

      await agentModeController.getSession(makeGetSessionReq(), makeRes());
      await flush();

      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
      expect((mockWorkerService.runInWorker.mock.calls[0][0] as any).isInteractiveShare).toBe(true);
    });

    it('ENG-2816: the owner reopening a chat whose deferred request was their own resumes as an owner turn, as before', async () => {
      const iso = recentIso();
      mockChatbotDb.getChatSession.mockResolvedValue({
        ...mockSession,
        messages: [
          { role: 'user', content: 'make four creatives', metadata: { timestamp: iso } },
          { role: 'assistant', content: '3 done', timestamp: iso, metadata: { kind: 'generation-timeout-continuation', mediaBudgetDeferred: true, timestamp: iso } },
        ],
      } as any);
      mockWorkerService.runInWorker.mockResolvedValueOnce(workerResponse('All 4 creatives are ready.', [imageToolCall(4)]));

      await agentModeController.getSession(makeGetSessionReq(), makeRes());
      await flush();

      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
      expect((mockWorkerService.runInWorker.mock.calls[0][0] as any).isInteractiveShare).toBe(false);
    });

    it('does NOT re-fire while a generation is already active for the session (avoids racing an in-flight resume)', async () => {
      activeSessionGenerations.add(mockSessionId);
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithDeferralAt(recentIso()) as any);

      const res = makeRes();
      await agentModeController.getSession(makeGetSessionReq(), res);
      await flush();

      expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
    });

    it('does NOT re-fire for an ordinary session with no unresolved deferral', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue({
        ...mockSession,
        messages: [{ role: 'assistant', content: 'All done, no batch pending.' }],
      } as any);

      const res = makeRes();
      await agentModeController.getSession(makeGetSessionReq(), res);
      await flush();

      expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
    });

    // ENG-1239 (rework): a passive READ (opening a page) must never spend a customer's
    // credits on their behalf unless it's genuinely them, right now — not staff looking,
    // not an old abandoned batch resurfacing unprompted.
    it('does NOT re-fire when an ADMIN directly views another customer\'s session (no delegation)', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithDeferralAt(recentIso()) as any);

      const res = makeRes();
      await agentModeController.getSession(makeGetSessionReq({ userId: 'admin-1', isAdmin: true }), res);
      await flush();

      expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
    });

    it('does NOT re-fire for a DELEGATED session (admin acting as the customer, but not the customer themselves)', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithDeferralAt(recentIso()) as any);

      const res = makeRes();
      // Per the delegation model, req.user.userId is already the TARGET customer's id —
      // delegateInfo.isDelegated is the only signal distinguishing this from a real login.
      await agentModeController.getSession(makeGetSessionReq({}, { isDelegated: true, adminUserId: 'admin-1' }), res);
      await flush();

      expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
    });

    it('does NOT re-fire for a STALE deferral (abandoned batch resurfacing on a much-later, unrelated visit)', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithDeferralAt(staleIso()) as any);

      const res = makeRes();
      await agentModeController.getSession(makeGetSessionReq(), res);
      await flush();

      expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
    });
  });

  /**
   * ENG-1239 (rework): if a prior recovery attempt was ITSELF interrupted (process died
   * after persisting the [SYSTEM] directive but before replying — see the durability
   * backstop above), firing another attempt used to persist a SECOND, redundant directive
   * on top of the still-dangling first one. Harmless functionally (both hidden from the
   * customer, no duplicate images — proven live), but it lets hidden rows accumulate.
   */
  describe('duplicate dangling-directive suppression', () => {
    it('does NOT persist a second directive when the tail is already a dangling auto-continuation directive', async () => {
      const sessionWithDanglingDirective = {
        ...mockSession,
        messages: [
          { role: 'assistant', content: '3 done', metadata: { kind: 'generation-timeout-continuation', mediaBudgetDeferred: true } },
          {
            role: 'user',
            content: '[SYSTEM] This is an automatic continuation...',
            metadata: { kind: 'auto-continuation', timestamp: new Date(Date.now() - 5000).toISOString() },
          },
        ],
      };
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithDanglingDirective as any);
      mockWorkerService.runInWorker.mockResolvedValueOnce(workerResponse('All 4 creatives are ready.', [imageToolCall(4)]));

      // Drives the same round-1 auto-continuation call the durability backstop fires,
      // against a session whose tail is already the dangling directive from a prior,
      // itself-interrupted attempt.
      const res = makeRes();
      await agentModeController.getSession(
        { params: { sessionId: mockSessionId }, user: { userId: mockUserId, isAdmin: false } } as unknown as Request,
        res,
      );
      await flush();

      const persistedKinds = mockChatbotDb.addMessageToSession.mock.calls
        .map((call) => (call[1] as any)?.metadata?.kind);
      expect(persistedKinds.filter((k) => k === 'auto-continuation')).toHaveLength(0);
      // The batch still completes — suppressing the duplicate directive doesn't block the resume.
      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
    });
  });
});
