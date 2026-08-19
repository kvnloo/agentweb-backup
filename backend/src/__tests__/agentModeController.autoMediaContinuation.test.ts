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
} from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { requestCancel } from '../utils/sseProgress';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';

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
const mockRequestCancel = requestCancel as jest.Mock;
const mockSendOncallAlert = sendAgentModeOncallAlert as jest.Mock;

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
    delete process.env.AGENT_RUN_STORE;
    mockSendOncallAlert.mockResolvedValue(undefined);
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
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
   * ENG-1239 (rework): the auto-continuation chain is purely in-process — a deploy or
   * crash between rounds loses it with no record it was ever attempted. getSession is a
   * durability backstop: any later touch of the session re-checks whether the tail of
   * history still shows an unresolved pause and re-fires the resume if so.
   */
  describe('getSession durability backstop', () => {
    const makeGetSessionReq = () =>
      ({ params: { sessionId: mockSessionId }, user: { userId: mockUserId, isAdmin: false } } as unknown as Request);

    it('re-fires the auto-continuation when the session is reopened with an unresolved deferral and nothing running', async () => {
      const sessionWithUnresolvedDeferral = {
        ...mockSession,
        messages: [{
          role: 'assistant',
          content: '3 done',
          timestamp: '2026-08-14T18:21:12.708Z',
          metadata: { kind: 'generation-timeout-continuation', mediaBudgetDeferred: true, timestamp: '2026-08-14T18:21:12.708Z' },
        }],
      };
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithUnresolvedDeferral as any);
      mockWorkerService.runInWorker.mockResolvedValueOnce(workerResponse('All 4 creatives are ready.', [imageToolCall(4)]));

      const res = makeRes();
      await agentModeController.getSession(makeGetSessionReq(), res);
      await flush();

      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
      const callArgs = mockWorkerService.runInWorker.mock.calls[0][0] as any;
      expect(callArgs.messageContent).toMatch(/automatic continuation/i);
    });

    it('does NOT re-fire while a generation is already active for the session (avoids racing an in-flight resume)', async () => {
      activeSessionGenerations.add(mockSessionId);
      const sessionWithUnresolvedDeferral = {
        ...mockSession,
        messages: [{
          role: 'assistant', content: '3 done', timestamp: '2026-08-14T18:21:12.708Z',
          metadata: { kind: 'generation-timeout-continuation', mediaBudgetDeferred: true, timestamp: '2026-08-14T18:21:12.708Z' },
        }],
      };
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithUnresolvedDeferral as any);

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
  });
});
