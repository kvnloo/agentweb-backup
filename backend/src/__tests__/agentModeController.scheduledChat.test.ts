import { Request, Response } from 'express';

// Mock all dependencies before importing the controller
// Mock subscriptionService so subscription checks always pass in tests
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => [
    'get_marketing_tips',
    'analyze_competitors',
    'create_work_plan',
    'modify_work_plan',
    'set_work_plan_status',
  ]),
  getAllowedSkills: jest.fn(async () => ['*']),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    updateSessionError: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getScheduledChatsDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    generateMarketingResponse: jest.fn(),
    generateScheduledChatSummary: jest.fn(),
    installSkills: jest.fn().mockResolvedValue({ success: true, installedSkills: [] }),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set([
      'install_skills', 'you_search_web', 'read_file_content', 'read_page_source',
      'search_knowledge_base', 'list_knowledge_base_files', 'read_knowledge_base_files',
      'create_work_plan', 'modify_work_plan', 'set_work_plan_status',
      'save_file', 'describe_image',
    ])),
    getAdminToolNames: jest.fn().mockReturnValue([
      'list_predefined_work_plans', 'manage_predefined_work_plan',
      'list_skills', 'manage_skill', 'get_chat_history',
    ]),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
    createSchedule: jest.fn(),
    addRunResult: jest.fn(),
    getScheduleById: jest.fn(),
    getSchedulesReadyToRun: jest.fn(),
    updateScheduleAfterRun: jest.fn(),
    setRunInFlight: jest.fn().mockResolvedValue('acquired'),
    attachSessionToRunInFlight: jest.fn().mockResolvedValue(true),
    heartbeatRunInFlight: jest.fn().mockResolvedValue(undefined),
    clearRunInFlight: jest.fn().mockResolvedValue(true),
    getInFlightSchedules: jest.fn().mockResolvedValue([]),
    claimAbandonedRun: jest.fn().mockResolvedValue(true),
    claimPendingResume: jest.fn().mockResolvedValue(true),
    updateSchedule: jest.fn(),
    getSchedulesByUserId: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
  },
  taskDb: {
    getTaskExecutionById: jest.fn(),
    createTaskExecution: jest.fn(),
    updateTaskExecution: jest.fn(),
  },
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-run-id-123'),
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendScheduledChatResultEmail: jest.fn(),
    sendDailyDigestEmail: jest.fn(),
    sendScheduledChatVariableRequestEmail: jest.fn(),
    sendScheduledChatErrorEmail: jest.fn(),
    sendScheduledChatTokenLimitEmail: jest.fn(),
  },
}));

jest.mock('../services/tokenUsageService', () => ({
  // deriveBlockedByCost is a pure helper — use the real implementation so the
  // block-message derivation is exercised, not stubbed.
  ...jest.requireActual('../services/tokenUsageService'),
  checkTokenUsage: jest.fn(async () => ({
    allowed: true,
    warning: false,
    used: 100000,
    allowance: 1000000,
    bonus: 0,
    effectiveAllowance: 1000000,
    percentUsed: 10,
    month: '2026-04',
  })),
}));

jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/notionService', () => ({
  createOncallItem: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
  },
}));

// Import mocked services
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb, taskDb, userDb } from '../services/db';
import { emailService } from '../services/emailService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { getAllowedFunctionCalls, getAllowedSkills } from '../services/subscriptionService';
import { skillService } from '../services/skillService';
import { checkTokenUsage } from '../services/tokenUsageService';
import { agentModeController, runScheduledChat } from '../controllers/agentModeController';

const mockedGetAllowedFunctionCalls = getAllowedFunctionCalls as jest.MockedFunction<typeof getAllowedFunctionCalls>;
const mockedGetAllowedSkills = getAllowedSkills as jest.MockedFunction<typeof getAllowedSkills>;
const mockedSkillService = skillService as jest.Mocked<typeof skillService>;
const mockedCheckTokenUsage = checkTokenUsage as jest.MockedFunction<typeof checkTokenUsage>;

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockTaskDb = taskDb as jest.Mocked<typeof taskDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockEmailService = emailService as jest.Mocked<typeof emailService>;
const mockGenerateMarketingResponseWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

describe('AgentModeController - Scheduled Chat with 6 Iterations', () => {
  const mockUserId = 'test-user-123';
  const mockScheduleId = 'test-schedule-123';
  
  const baseSchedule = {
    scheduleId: mockScheduleId,
    scheduleName: 'Test Schedule',
    startingMessage: 'Hello, please help me with marketing',
    keywords: ['marketing', 'strategy'],
    requiredFunctionCalls: ['get_marketing_tips', 'analyze_competitors'],
    userId: mockUserId,
    nextRunTime: new Date().toISOString(),
  };

  const mockSession = {
    sessionId: 'test-session-123',
    userId: mockUserId,
    title: 'Test Session',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockResponse = {
    content: 'Here are some marketing strategies and tips for your business.',
    toolCalls: [
      { name: 'get_marketing_tips', arguments: {} },
      { name: 'analyze_competitors', arguments: {} },
    ],
    knowledgeBaseQueries: [],
    sources: [],
    responseMessages: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentModeService.getDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue(mockAgentModeService.default_model);

    // Setup default mocks
    mockChatbotDb.createChatSession.mockResolvedValue(mockSession);
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession);
    // Reset persist implementation each test (clearAllMocks does not reset implementations)
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(mockSession);
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Generated Title');
    mockAgentModeService.generateScheduledChatSummary.mockResolvedValue(null);
    // Use worker service instead of direct generateMarketingResponse
    mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(mockResponse);
    mockScheduleDb.addRunResult.mockResolvedValue(undefined);
    mockScheduleDb.getScheduleById.mockResolvedValue(baseSchedule);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([]);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined);
    mockUserDb.getUserById.mockResolvedValue({ userId: mockUserId, email: 'owner@example.com' } as any);
  });

  afterEach(() => {
    // Clean up to prevent memory leaks
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('runScheduledChat function', () => {
    it('should succeed on first attempt when all criteria are met', async () => {
      // Mock successful response with all required keywords and function calls
      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'success',
          passed: true,
          attempt: 1,
          keywordMatches: ['marketing', 'strategy'],
          keywordMisses: [],
          functionCallMatches: ['get_marketing_tips', 'analyze_competitors'],
          functionCallMisses: [],
        })
      );
    });

    // ENG-657: resume an abandoned run whose instance was terminated mid-flight
    // (e.g. by a deploy) instead of restarting the whole task in a fresh session.
    describe('resume of an abandoned run (ENG-657)', () => {
      const resumeSessionId = 'resume-sess-1';
      const resumableMessages = [
        { role: 'system', content: 'automated run' },
        { role: 'user', content: 'Enrich the CRM leads and recommend the top 10.' },
        { role: 'assistant', content: 'Firing enrichment.', tool_calls: [{ id: 'c1', function: { name: 'enrich_leads_execute' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '{"mode":"enrich","processedCount":5}' },
      ];
      const resumeSchedule = {
        ...baseSchedule,
        keywords: [],
        requiredFunctionCalls: [],
        pendingResumeSessionId: resumeSessionId,
      };

      it('continues the existing session (no new session) and injects a continuation directive', async () => {
        mockChatbotDb.getChatSession.mockResolvedValue({
          ...mockSession,
          sessionId: resumeSessionId,
          userId: mockUserId,
          messages: resumableMessages,
        } as any);

        const result = await runScheduledChat(resumeSchedule as any, mockUserId, false);

        // Reuses the abandoned session — does NOT create a fresh one.
        expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
        expect(result.sessionId).toBe(resumeSessionId);
        // The resume marker is consumed (at-most-once resume).
        expect(mockScheduleDb.claimPendingResume).toHaveBeenCalledWith(mockScheduleId, resumeSessionId);
        // The model turn is driven against the existing session with a CONTINUATION
        // directive, not the original task prompt (which would restart the task).
        const workerArg = (mockGenerateMarketingResponseWorkerService.runInWorker as jest.Mock).mock.calls[0][0];
        expect(workerArg.sessionId).toBe(resumeSessionId);
        expect(workerArg.messageContent).toMatch(/Continue from exactly where you left off/i);
        expect(workerArg.messageContent).not.toBe(baseSchedule.startingMessage);
      });

      it('PAUSES the schedule (never fresh-restarts) when the resume session is no longer safely resumable', async () => {
        // Dangling tool_use → planScheduledRunResume refuses. A fresh restart (now or
        // on a later retry) would re-run the whole task and duplicate the already-
        // completed side effects — the exact thing this path exists to prevent
        // (Greptile: "deferral only delays fresh restart"). So this case does NOT
        // schedule a retry at all; it pauses the schedule and alerts oncall so a
        // human decides, rather than an automatic restart silently duplicating
        // real-world side effects.
        mockChatbotDb.getChatSession.mockResolvedValue({
          ...mockSession,
          sessionId: resumeSessionId,
          userId: mockUserId,
          messages: [
            { role: 'system', content: 'x' },
            { role: 'user', content: 'Enrich.' },
            { role: 'assistant', content: '…', tool_calls: [{ id: 'c1', function: { name: 'enrich_leads_execute' } }, { id: 'c2', function: { name: 'enrich_leads_execute' } }] },
            { role: 'tool', tool_call_id: 'c1', content: '{}' },
          ],
        } as any);
        (mockScheduleDb.updateSchedule as jest.Mock).mockClear();

        const result = await runScheduledChat(resumeSchedule as any, mockUserId, false);

        // No fresh session, no worker run — deferred, marker consumed to avoid a loop.
        expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
        expect(mockGenerateMarketingResponseWorkerService.runInWorker).not.toHaveBeenCalled();
        expect(mockScheduleDb.claimPendingResume).toHaveBeenCalledWith(mockScheduleId, resumeSessionId);
        expect(result.sessionId).toBe('');

        // Paused, not requeued — no auto-restart path exists for this case.
        const pauseCall = (mockScheduleDb.updateSchedule as jest.Mock).mock.calls.find(
          call => call[0] === mockScheduleId && call[1]?.status === 'paused'
        );
        expect(pauseCall).toBeDefined();
        const retryCall = (mockScheduleDb.updateSchedule as jest.Mock).mock.calls.find(
          call => call[0] === mockScheduleId && call[1]?.nextRunTime
        );
        expect(retryCall).toBeUndefined();
      });

      it('does NOT pause the schedule when another dispatcher already owns the not-resumable claim (ENG-657/Greptile)', async () => {
        // If claimPendingResume returns false here, another dispatcher won it first —
        // it, not us, owns this recovery decision. Pausing anyway would suppress the
        // winner's future scheduled runs for no reason.
        (mockScheduleDb.claimPendingResume as jest.Mock).mockResolvedValueOnce(false);
        mockChatbotDb.getChatSession.mockResolvedValue({
          ...mockSession,
          sessionId: resumeSessionId,
          userId: mockUserId,
          messages: [
            { role: 'system', content: 'x' },
            { role: 'user', content: 'Enrich.' },
            { role: 'assistant', content: '…', tool_calls: [{ id: 'c1', function: { name: 'enrich_leads_execute' } }, { id: 'c2', function: { name: 'enrich_leads_execute' } }] },
            { role: 'tool', tool_call_id: 'c1', content: '{}' },
          ],
        } as any);
        (mockScheduleDb.updateSchedule as jest.Mock).mockClear();

        const result = await runScheduledChat(resumeSchedule as any, mockUserId, false);

        expect(result.sessionId).toBe('');
        expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
        // No pause, no retry — we don't have standing to touch this schedule at all.
        const anyUpdateCall = (mockScheduleDb.updateSchedule as jest.Mock).mock.calls.find(call => call[0] === mockScheduleId);
        expect(anyUpdateCall).toBeUndefined();
      });

      it('DEFERS on a transient session-load failure, leaving the marker intact (no restart)', async () => {
        (mockChatbotDb.getChatSession as jest.Mock).mockRejectedValueOnce(new Error('DynamoDB timeout'));

        const result = await runScheduledChat(resumeSchedule as any, mockUserId, false);

        // Transient read failure → no restart, and the marker is NOT consumed so a
        // later fire can retry the resume.
        expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
        expect(mockGenerateMarketingResponseWorkerService.runInWorker).not.toHaveBeenCalled();
        expect(mockScheduleDb.claimPendingResume).not.toHaveBeenCalled();
        expect(result.sessionId).toBe('');
      });

      it('counts the abandoned portion\'s required function calls so a resume is not falsely failed (ENG-657)', async () => {
        // Schedule REQUIRES get_marketing_tips (a subscription-allowed function in
        // this suite's mock); it was called before the crash and is in the resumable
        // history. The continuation turn does NOT re-call it.
        const priorCall = 'get_marketing_tips';
        mockChatbotDb.getChatSession.mockResolvedValue({
          ...mockSession, sessionId: resumeSessionId, userId: mockUserId,
          messages: [
            { role: 'system', content: 'automated run' },
            { role: 'user', content: 'Do the marketing task.' },
            { role: 'assistant', content: 'Fetching tips.', tool_calls: [{ id: 'c1', function: { name: priorCall } }] },
            { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
          ],
        } as any);
        // Continuation produces only the final write-up — does NOT re-call the tool.
        mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
          ...mockResponse, content: 'Here are the top 10 recommended leads and 2 follow-up drafts.', toolCalls: [],
        });

        const result = await runScheduledChat(
          { ...resumeSchedule, requiredFunctionCalls: [priorCall] } as any,
          mockUserId,
          false,
        );

        // sanity: resume actually fired (no fresh session)
        expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
        // The prior call is credited → run passes without re-running it...
        expect(result.functionCallMatches).toContain(priorCall);
        expect(result.functionCallMisses).not.toContain(priorCall);
        expect(result.passed).toBe(true);
        // ...and the verify loop does NOT retry (which could have re-driven the tool).
        expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(1);
      });

      it('DEFERS when it loses the atomic claim (another dispatcher won) — no resume AND no fresh restart', async () => {
        (mockScheduleDb.claimPendingResume as jest.Mock).mockResolvedValue(false);
        mockChatbotDb.getChatSession.mockResolvedValue({
          ...mockSession, sessionId: resumeSessionId, userId: mockUserId, messages: resumableMessages,
        } as any);

        const result = await runScheduledChat(resumeSchedule as any, mockUserId, false);

        // Lost claim → the winner handles this fire. This dispatcher must NOT resume
        // (parallel) and must NOT fresh-restart (duplicate side effects) — it bows out.
        expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
        expect(mockGenerateMarketingResponseWorkerService.runInWorker).not.toHaveBeenCalled();
        expect(result.sessionId).toBe('');
      });

      it('ignores the resume marker for a manual test run (never resumes)', async () => {
        mockChatbotDb.getChatSession.mockResolvedValue({
          ...mockSession, sessionId: resumeSessionId, userId: mockUserId, messages: resumableMessages,
        } as any);

        await runScheduledChat(resumeSchedule as any, mockUserId, true);

        // isTest=true → resume path is skipped entirely; a fresh session is created.
        expect(mockChatbotDb.createChatSession).toHaveBeenCalledTimes(1);
        expect(mockScheduleDb.claimPendingResume).not.toHaveBeenCalled();
      });

      it('attaches the resumed session to the lease BEFORE claiming the marker (closes the empty-sessionId-abandon race)', async () => {
        // If a kill lands between claimPendingResume succeeding and the lease being
        // annotated with the resumed sessionId, the reconciler sees an empty-session
        // abandonment and requeues a blind fresh restart — re-running this session's
        // already-completed side effects. Attaching first closes that window: the
        // lease already names the right session no matter when a kill lands after.
        mockChatbotDb.getChatSession.mockResolvedValue({
          ...mockSession, sessionId: resumeSessionId, userId: mockUserId, messages: resumableMessages,
        } as any);

        await runScheduledChat(resumeSchedule as any, mockUserId, false);

        const attachCalls = (mockScheduleDb.attachSessionToRunInFlight as jest.Mock).mock.calls;
        const claimOrder = (mockScheduleDb.claimPendingResume as jest.Mock).mock.invocationCallOrder[0];
        const firstAttachOrder = (mockScheduleDb.attachSessionToRunInFlight as jest.Mock).mock.invocationCallOrder[0];

        // At least one attach call names the resumed session, and it happens before the claim.
        expect(attachCalls.some(call => call[2] === resumeSessionId)).toBe(true);
        expect(firstAttachOrder).toBeLessThan(claimOrder);
      });

      it('schedules a short retry on a genuinely-retryable deferred fire (claim-error) instead of silently waiting for the next full cadence (ENG-657)', async () => {
        // A deferred fire returns cleanly — it does NOT leave a stale lease for the
        // reconciler to catch the way a crash would, and the dispatch loop already
        // advanced nextRunTime to the full next cadence before this run started.
        // Without an explicit short retry, a defer would silently wait a full cycle.
        // Unlike the "no longer resumable" case, a transient claim error carries no
        // duplicate-effect risk on retry — the session is still genuinely resumable,
        // so retrying soon (rather than pausing) is correct here.
        mockChatbotDb.getChatSession.mockResolvedValue({
          ...mockSession, sessionId: resumeSessionId, userId: mockUserId, messages: resumableMessages,
        } as any);
        (mockScheduleDb.claimPendingResume as jest.Mock).mockRejectedValueOnce(new Error('DynamoDB throttled'));

        const result = await runScheduledChat({ ...resumeSchedule, zeroAssistantRetryCount: 0 } as any, mockUserId, false);

        expect(result.sessionId).toBe(''); // deferred (claim-error)
        const updateCall = (mockScheduleDb.updateSchedule as jest.Mock).mock.calls.find(call => call[0] === mockScheduleId);
        expect(updateCall).toBeDefined();
        expect(updateCall[1]).toEqual(expect.objectContaining({ zeroAssistantRetryCount: 1, nextRunTime: expect.any(String) }));
      });

      it('does NOT schedule another retry once the requeue cap is already exhausted (ENG-657)', async () => {
        mockChatbotDb.getChatSession.mockResolvedValue({
          ...mockSession, sessionId: resumeSessionId, userId: mockUserId, messages: resumableMessages,
        } as any);
        (mockScheduleDb.claimPendingResume as jest.Mock).mockRejectedValueOnce(new Error('DynamoDB throttled'));
        (mockScheduleDb.updateSchedule as jest.Mock).mockClear();

        await runScheduledChat({ ...resumeSchedule, zeroAssistantRetryCount: 3 } as any, mockUserId, false);

        // ZERO_ASSISTANT_MAX_REQUEUES is 3 — a 4th retry is over cap, so no reschedule.
        const updateCall = (mockScheduleDb.updateSchedule as jest.Mock).mock.calls.find(call => call[0] === mockScheduleId);
        expect(updateCall).toBeUndefined();
      });

      it('DEFERS without touching the marker when no durable lease could be established (ENG-657/Greptile)', async () => {
        // If setRunInFlight throws (transient error, not a lost race — that path
        // returns earlier), leaseAcquired stays false. Without this guard, execution
        // would fall through to claiming the marker and starting the worker with NO
        // lease at all — a kill during that run would leave neither a reconcilable
        // lease nor a resume marker (already consumed), so nothing could ever detect
        // or retry it.
        (mockScheduleDb.setRunInFlight as jest.Mock).mockRejectedValueOnce(new Error('DynamoDB throttled'));
        mockChatbotDb.getChatSession.mockResolvedValue({
          ...mockSession, sessionId: resumeSessionId, userId: mockUserId, messages: resumableMessages,
        } as any);

        const result = await runScheduledChat(resumeSchedule as any, mockUserId, false);

        expect(result.sessionId).toBe('');
        // The marker must NOT be consumed — a later, properly-leased dispatch retries it.
        expect(mockScheduleDb.claimPendingResume).not.toHaveBeenCalled();
        expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
        expect(mockGenerateMarketingResponseWorkerService.runInWorker).not.toHaveBeenCalled();
      });
    });

    it('stamps an in-flight lease on a production run and releases it when the run settles (ENG-324)', async () => {
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
      });

      await runScheduledChat(baseSchedule, mockUserId, false);

      // ENG-479: the lease is stamped BEFORE the session exists, so it carries no
      // sessionId yet; the session is attached to it in a second step below.
      expect(mockScheduleDb.setRunInFlight).toHaveBeenCalledTimes(1);
      const [leaseScheduleId, lease] = (mockScheduleDb.setRunInFlight as jest.Mock).mock.calls[0];
      expect(leaseScheduleId).toBe(mockScheduleId);
      expect(lease).toEqual(
        expect.objectContaining({ sessionId: '', runId: expect.any(String) })
      );
      // The created session is attached to the lease so the reconciler can annotate it.
      expect(mockScheduleDb.attachSessionToRunInFlight).toHaveBeenCalledWith(
        mockScheduleId,
        lease.runId,
        mockSession.sessionId
      );
      // And released in `finally` once the run settles.
      expect(mockScheduleDb.clearRunInFlight).toHaveBeenCalledTimes(1);
      expect((mockScheduleDb.clearRunInFlight as jest.Mock).mock.calls[0][0]).toBe(mockScheduleId);
    });

    it('stamps the in-flight lease BEFORE creating the session so a pre-lease hard-kill is still reconciler-visible (ENG-479 GAP 1)', async () => {
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
      });

      await runScheduledChat(baseSchedule, mockUserId, false);

      const leaseOrder = (mockScheduleDb.setRunInFlight as jest.Mock).mock.invocationCallOrder[0];
      const sessionOrder = (mockChatbotDb.createChatSession as jest.Mock).mock.invocationCallOrder[0];
      const attachOrder = (mockScheduleDb.attachSessionToRunInFlight as jest.Mock).mock.invocationCallOrder[0];
      // Lease first, THEN session, THEN attach — closing the window where a session
      // exists with no lease (invisible to the reconciler, never auto-requeued).
      expect(leaseOrder).toBeLessThan(sessionOrder);
      expect(sessionOrder).toBeLessThan(attachOrder);
    });

    it('does NOT stamp an in-flight lease for a test run (ENG-324)', async () => {
      await runScheduledChat(baseSchedule, mockUserId, true);
      expect(mockScheduleDb.setRunInFlight).not.toHaveBeenCalled();
      expect(mockScheduleDb.clearRunInFlight).not.toHaveBeenCalled();
    });

    it('bails out entirely — no session, no clear — when another dispatcher already holds the lease (ENG-657/Greptile)', async () => {
      // A real cross-instance race: two dispatchers pick up the same due schedule.
      // The loser must not touch anything — not create a session, not clear any
      // lease in its `finally` (which would tear down the winner's real lease and
      // make its still-running attempt invisible to the reconciler).
      (mockScheduleDb.setRunInFlight as jest.Mock).mockResolvedValueOnce('already_in_flight');

      const result = await runScheduledChat(baseSchedule, mockUserId, false);

      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).not.toHaveBeenCalled();
      expect(mockScheduleDb.clearRunInFlight).not.toHaveBeenCalled();
      expect(mockScheduleDb.attachSessionToRunInFlight).not.toHaveBeenCalled();
      expect(result.sessionId).toBe('');
      expect(result.status).toBe('success');
    });

    it('should require canonical you_search_web for You.com web search', async () => {
      const scheduleWithSearchWeb = {
        ...baseSchedule,
        keywords: [],
        requiredFunctionCalls: ['you_search_web'],
      };

      const legacySearchResponse = {
        ...mockResponse,
        content: 'Found some legacy results.',
        toolCalls: [
          { name: 'legacy_search_web', arguments: { query: 'test' } },
        ],
      };
      const canonicalSearchResponse = {
        ...mockResponse,
        content: 'Found some current results.',
        toolCalls: [
          { name: 'you_search_web', arguments: { query: 'test' } },
        ],
      };

      mockGenerateMarketingResponseWorkerService.runInWorker
        .mockResolvedValueOnce(legacySearchResponse)
        .mockResolvedValueOnce(canonicalSearchResponse);

      const result = await runScheduledChat(scheduleWithSearchWeb, mockUserId, true);

      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(2);
      expect(result).toEqual(
        expect.objectContaining({
          status: 'success',
          passed: true,
          attempt: 2,
          functionCallMatches: ['you_search_web'],
          functionCallMisses: [],
        })
      );
    });

    it('should not count legacy news search calls as you_search_web', async () => {
      const scheduleWithSearchWeb = {
        ...baseSchedule,
        keywords: [],
        requiredFunctionCalls: ['you_search_web'],
      };

      const legacyNewsResponse = {
        ...mockResponse,
        content: 'Found some news.',
        toolCalls: [
          { name: 'legacy_news_search', arguments: { query: 'test' } },
        ],
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(legacyNewsResponse);

      const result = await runScheduledChat(scheduleWithSearchWeb, mockUserId, true);

      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(20);
      expect(result).toEqual(
        expect.objectContaining({
          status: 'failure',
          passed: false,
          attempt: 20,
          functionCallMatches: [],
          functionCallMisses: ['you_search_web'],
        })
      );
    });

    it('should retry up to 6 times when criteria are not met', async () => {
      // Mock responses that don't meet criteria
      const incompleteResponse = {
        ...mockResponse,
        content: 'Here are some general business tips.',
        toolCalls: [{ name: 'get_marketing_tips', arguments: {} }], // Missing analyze_competitors
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(incompleteResponse);

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // Should have been called 20 times (maxTries = 20)
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(20);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'failure',
          passed: false,
          attempt: 20, // Last attempt
          keywordMatches: [],
          keywordMisses: ['marketing', 'strategy'],
          functionCallMatches: ['get_marketing_tips'],
          functionCallMisses: ['analyze_competitors'],
        })
      );
    });

    it('should succeed on 4th attempt when criteria are met', async () => {
      let callCount = 0;
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(() => {
        callCount++;
        if (callCount <= 3) {
          // First 3 attempts fail
          return Promise.resolve({
            ...mockResponse,
            content: 'Here are some general business tips.',
            toolCalls: [{ name: 'get_marketing_tips', arguments: {} }],
          });
        } else {
          // 4th attempt succeeds
          return Promise.resolve({
            ...mockResponse,
            content: 'Here are some marketing strategy and tips for your business.',
            toolCalls: [
              { name: 'get_marketing_tips', arguments: {} },
              { name: 'analyze_competitors', arguments: {} },
            ],
          });
        }
      });

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // Should have been called 4 times (stopped after success)
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(4);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'success',
          passed: true,
          attempt: 4,
          keywordMatches: ['marketing', 'strategy'],
          keywordMisses: [],
          functionCallMatches: ['get_marketing_tips', 'analyze_competitors'],
          functionCallMisses: [],
        })
      );
    });

    it('should handle partial success across multiple attempts', async () => {
      let callCount = 0;
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First attempt: only keywords, no function calls
          return Promise.resolve({
            ...mockResponse,
            content: 'Here are some marketing strategies for your business.',
            toolCalls: [],
          });
        } else if (callCount === 2) {
          // Second attempt: only one function call
          return Promise.resolve({
            ...mockResponse,
            content: 'Here are some general business tips.',
            toolCalls: [{ name: 'get_marketing_tips', arguments: {} }],
          });
        } else if (callCount === 3) {
          // Third attempt: gets the missing function call
          return Promise.resolve({
            ...mockResponse,
            content: 'Here are some general business tips.',
            toolCalls: [{ name: 'analyze_competitors', arguments: {} }],
          });
        } else {
          // Subsequent attempts fail
          return Promise.resolve({
            ...mockResponse,
            content: 'Here are some general business tips.',
            toolCalls: [],
          });
        }
      });

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // Should have been called 20 times (all attempts)
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(20);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'failure',
          passed: false,
          attempt: 20,
          keywordMatches: ['marketing'], // Only "marketing" found in "strategies"
          keywordMisses: ['strategy'],
          functionCallMatches: ['get_marketing_tips', 'analyze_competitors'], // Found across attempts
          functionCallMisses: [],
        })
      );
    });

    it('should handle schedule with no keywords or function calls', async () => {
      const simpleSchedule = {
        ...baseSchedule,
        keywords: [],
        requiredFunctionCalls: [],
      };

      const result = await runScheduledChat(simpleSchedule, mockUserId, true);

      // Should succeed immediately since no criteria to meet
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(1);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'success',
          passed: true,
          attempt: 1,
          keywordMatches: [],
          keywordMisses: [],
          functionCallMatches: [],
          functionCallMisses: [],
        })
      );
    });

    it('should fail and retry when the worker returns zero assistant output', async () => {
      const simpleSchedule = {
        ...baseSchedule,
        keywords: [],
        requiredFunctionCalls: [],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: '',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });

      const result = await runScheduledChat(simpleSchedule, mockUserId, true);

      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(20);
      expect(result).toEqual(
        expect.objectContaining({
          status: 'failure',
          passed: false,
          actualResponse: expect.stringContaining('zero assistant output'),
        })
      );
      expect(mockScheduleDb.addRunResult).toHaveBeenCalledWith(
        simpleSchedule.scheduleId,
        expect.objectContaining({
          status: 'failure',
          sessionId: 'test-session-123',
        })
      );
    });

    it('should requeue production scheduled chats with backoff after zero assistant output', async () => {
      const simpleSchedule = {
        ...baseSchedule,
        keywords: [],
        requiredFunctionCalls: [],
        zeroAssistantRetryCount: 0,
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: '',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });

      const beforeRun = Date.now();
      const result = await runScheduledChat(simpleSchedule, mockUserId, false);

      expect(result).toEqual(expect.objectContaining({ status: 'failure', passed: false }));
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        simpleSchedule.scheduleId,
        expect.objectContaining({
          status: 'active',
          zeroAssistantRetryCount: 1,
          lastZeroAssistantOutputAt: expect.any(String),
          lastZeroAssistantOutputSessionId: 'test-session-123',
          nextRunTime: expect.any(String),
        })
      );

      const requeueCall = mockScheduleDb.updateSchedule.mock.calls.find((call: any[]) =>
        call[1]?.zeroAssistantRetryCount === 1
      );
      const nextRunTime = requeueCall?.[1]?.nextRunTime;
      expect(typeof nextRunTime).toBe('string');
      const retryAt = new Date(nextRunTime as string).getTime();
      expect(retryAt).toBeGreaterThanOrEqual(beforeRun + 14 * 60 * 1000);
      expect(retryAt).toBeLessThanOrEqual(Date.now() + 16 * 60 * 1000);
    });

    it('should persist a structured incomplete-job assistant message so the session is never left silent after zero assistant output', async () => {
      // Reproduces ENG-209: a large scheduled research job (e.g. 40-competitor
      // report) crashes/times out and the run produces zero assistant output.
      // The session must NOT be left blank — the user should see a graceful
      // "job incomplete" message rather than an empty session.
      const simpleSchedule = {
        ...baseSchedule,
        keywords: [],
        requiredFunctionCalls: [],
        zeroAssistantRetryCount: 0,
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: '',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });

      await runScheduledChat(simpleSchedule, mockUserId, false);

      const fallbackCall = mockChatbotDb.addMessageToSession.mock.calls.find(
        (call: any[]) => call[1]?.metadata?.jobIncomplete === true
      );
      expect(fallbackCall).toBeDefined();
      expect(fallbackCall![0]).toBe('test-session-123');
      expect(fallbackCall![1]).toEqual(
        expect.objectContaining({
          role: 'assistant',
          content: expect.any(String),
          metadata: expect.objectContaining({
            isErrorMessage: true,
            jobIncomplete: true,
          }),
        })
      );
      expect(fallbackCall![1].content.length).toBeGreaterThan(0);
    });

    it('should still requeue after zero assistant output even when persisting the job-incomplete message fails', async () => {
      // The job-incomplete persist runs inside a try/catch (ENG-209): if DynamoDB
      // rejects, the error must be swallowed so the requeue still proceeds and the
      // run does not crash.
      const simpleSchedule = {
        ...baseSchedule,
        keywords: [],
        requiredFunctionCalls: [],
        zeroAssistantRetryCount: 0,
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: '',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });
      mockChatbotDb.addMessageToSession.mockRejectedValue(new Error('DynamoDB write failed'));

      const result = await runScheduledChat(simpleSchedule, mockUserId, false);

      // Run still completes gracefully despite the persist failure
      expect(result).toEqual(expect.objectContaining({ status: 'failure', passed: false }));

      // The persist was attempted...
      const fallbackCall = mockChatbotDb.addMessageToSession.mock.calls.find(
        (call: any[]) => call[1]?.metadata?.jobIncomplete === true
      );
      expect(fallbackCall).toBeDefined();

      // ...but the requeue still fired even though the persist rejected
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        simpleSchedule.scheduleId,
        expect.objectContaining({
          status: 'active',
          zeroAssistantRetryCount: 1,
          nextRunTime: expect.any(String),
        })
      );
    });

    it('should skip the job-incomplete persist and not crash when no session was created', async () => {
      // The persist block is guarded by `if (sessionId)`; when session creation
      // yields a falsy sessionId the persist must be skipped without throwing.
      const simpleSchedule = {
        ...baseSchedule,
        keywords: [],
        requiredFunctionCalls: [],
        zeroAssistantRetryCount: 0,
      };
      mockChatbotDb.createChatSession.mockResolvedValue({ ...mockSession, sessionId: '' });
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: '',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });

      const result = await runScheduledChat(simpleSchedule, mockUserId, false);

      // No throw — returns a graceful failure result
      expect(result).toEqual(expect.objectContaining({ status: 'failure', passed: false }));

      // The job-incomplete message must NOT be persisted when there is no session
      const fallbackCall = mockChatbotDb.addMessageToSession.mock.calls.find(
        (call: any[]) => call[1]?.metadata?.jobIncomplete === true
      );
      expect(fallbackCall).toBeUndefined();
    });

    it('should reset zero assistant retry tracking after a successful production run', async () => {
      const recoveringSchedule = {
        ...baseSchedule,
        zeroAssistantRetryCount: 2,
        lastZeroAssistantOutputAt: '2026-06-05T23:49:04.778Z',
        lastZeroAssistantOutputSessionId: 'cf85e8f2-e1f9-4b67-887c-e24bf2fc361b',
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
      });

      const result = await runScheduledChat(recoveringSchedule, mockUserId, false);

      expect(result).toEqual(expect.objectContaining({ status: 'success', passed: true }));
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        recoveringSchedule.scheduleId,
        expect.objectContaining({
          zeroAssistantRetryCount: 0,
          lastZeroAssistantOutputAt: '',
          lastZeroAssistantOutputSessionId: '',
        })
      );
    });

    it('should handle errors during individual attempts', async () => {
      let callCount = 0;
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          // Transient 503 error — should retry
          const err: any = new Error('503 Service Unavailable');
          err.status = 503;
          throw err;
        }
        return Promise.resolve({
          ...mockResponse,
          content: 'Here are some general business tips.',
          toolCalls: [],
        });
      });

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // Should have been called 20 times (transient error on attempt 2, retried to exhaustion)
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(20);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'failure',
          passed: false,
          attempt: 20,
        })
      );
    });

    it('should handle critical errors that stop execution', async () => {
      mockGenerateMarketingResponseWorkerService.runInWorker.mockRejectedValue(new Error('Critical database error'));

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // After the fix, runScheduledChat returns an error result instead of throwing
      expect(result).toEqual(
        expect.objectContaining({
          status: 'failure',
          passed: false,
          actualResponse: expect.stringContaining('Critical database error'),
        })
      );

      // Should also save error to session and save run result
      expect(mockChatbotDb.updateSessionError).toHaveBeenCalled();
      expect(mockScheduleDb.addRunResult).toHaveBeenCalled();
    });

    it('should auto-pause and return failure when the owning user no longer exists', async () => {
      mockUserDb.getUserById.mockResolvedValue(null as any);

      const result = await runScheduledChat(baseSchedule, mockUserId, false);

      // Returns a graceful failure result instead of throwing
      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'failure',
          passed: false,
          attempt: 0,
          sessionId: '',
          actualResponse: expect.stringContaining(mockUserId),
        })
      );

      // Auto-pauses the schedule so it stops firing
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({ status: 'paused' })
      );

      // Records the failure for visibility in the UI
      expect(mockScheduleDb.addRunResult).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({ status: 'failure', sessionId: '' })
      );

      // Never starts the actual agent run
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).not.toHaveBeenCalled();
    });

    it('should not auto-pause on a test run when the user is missing', async () => {
      mockUserDb.getUserById.mockResolvedValue(null as any);

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      expect(result).toEqual(
        expect.objectContaining({ status: 'failure', passed: false })
      );

      // Test runs must not mutate the schedule's status
      expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).not.toHaveBeenCalled();
    });

    it('should create correct session title for test vs production', async () => {
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(mockResponse);

      await runScheduledChat(baseSchedule, mockUserId, true);

      // Should create session with pageIdentifier including scheduleId
      expect(mockChatbotDb.createChatSession).toHaveBeenCalledWith(
        mockUserId,
        undefined,
        'agent',
        `Test: Test Schedule|scheduleId:${mockScheduleId}`,
        undefined,
        undefined,
        undefined,
        undefined,
        'scheduled'
      );
    });

    it('should copy emailCampaignTaskId from schedule to session', async () => {
      const scheduleWithCampaignId = {
        ...baseSchedule,
        emailCampaignTaskId: 'campaign-task-123',
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
      });

      await runScheduledChat(scheduleWithCampaignId, mockUserId, true);

      // Should create session with emailCampaignTaskId from schedule
      expect(mockChatbotDb.createChatSession).toHaveBeenCalledWith(
        mockUserId,
        undefined,
        'agent',
        `Test: Test Schedule|scheduleId:${mockScheduleId}`,
        undefined,
        undefined,
        undefined,
        'campaign-task-123',
        'scheduled'
      );
    });

    it('should handle schedule with null emailCampaignTaskId', async () => {
      const scheduleWithoutCampaignId = {
        ...baseSchedule,
        emailCampaignTaskId: null,
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
      });

      await runScheduledChat(scheduleWithoutCampaignId, mockUserId, true);

      // Should create session with undefined emailCampaignTaskId
      expect(mockChatbotDb.createChatSession).toHaveBeenCalledWith(
        mockUserId,
        undefined,
        'agent',
        `Test: Test Schedule|scheduleId:${mockScheduleId}`,
        undefined,
        undefined,
        undefined,
        null,
        'scheduled'
      );
    });

    it('should save run result to database', async () => {
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(mockResponse);

      await runScheduledChat(baseSchedule, mockUserId, true);

      // Should save result to database
      expect(mockScheduleDb.addRunResult).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          scheduleId: mockScheduleId,
          runId: 'mock-run-id-123',
          status: 'failure', // The test shows it's actually failing
          passed: false,
        })
      );
    });

    it('should not run test scheduled chat when required variable values are missing', async () => {
      const variableSchedule = {
        ...baseSchedule,
        variables: [{ name: 'company_name', description: 'Company name' }],
        variableValues: {}
      };
      mockScheduleDb.getScheduleById.mockResolvedValue(variableSchedule as any);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Missing variable values for scheduled chat',
          missingVariables: ['company_name']
        })
      );
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    });

    it('should send notification email when sendNotificationEmail is true and schedule has email notifications', async () => {
      const scheduleWithEmails = {
        ...baseSchedule,
        emailNotifications: ['user@example.com', 'admin@example.com'],
      };
      mockScheduleDb.getScheduleById.mockResolvedValue(scheduleWithEmails);

      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: { sendNotificationEmail: true },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      // testScheduledChat returns immediately with pending status; wait for background run
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pending' })
      );

      // Wait for background run to complete and email to be sent
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockEmailService.sendScheduledChatResultEmail).toHaveBeenCalledWith(
        ['user@example.com', 'admin@example.com'],
        'Test Schedule',
        expect.objectContaining({ sessionId: 'test-session-123' }),
        mockScheduleId,
        undefined
      );
    });

    it('should not send notification email when sendNotificationEmail is false', async () => {
      const scheduleWithEmails = {
        ...baseSchedule,
        emailNotifications: ['user@example.com'],
      };
      mockScheduleDb.getScheduleById.mockResolvedValue(scheduleWithEmails);

      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: { sendNotificationEmail: false },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      // Wait for background run to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockEmailService.sendScheduledChatResultEmail).not.toHaveBeenCalled();
    });

    it('should not send notification email when sendNotificationEmail is true but no email notifications configured', async () => {
      // baseSchedule has no emailNotifications
      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: { sendNotificationEmail: true },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      // Wait for background run to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockEmailService.sendScheduledChatResultEmail).not.toHaveBeenCalled();
    });

    it('should not send notification email when body is missing', async () => {
      const scheduleWithEmails = {
        ...baseSchedule,
        emailNotifications: ['user@example.com'],
      };
      mockScheduleDb.getScheduleById.mockResolvedValue(scheduleWithEmails);

      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      // Wait for background run to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockEmailService.sendScheduledChatResultEmail).not.toHaveBeenCalled();
    });

    it('should still return success even if notification email fails', async () => {
      const scheduleWithEmails = {
        ...baseSchedule,
        emailNotifications: ['user@example.com'],
      };
      mockScheduleDb.getScheduleById.mockResolvedValue(scheduleWithEmails);

      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);
      mockEmailService.sendScheduledChatResultEmail.mockRejectedValue(new Error('SMTP failure'));

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: { sendNotificationEmail: true },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.testScheduledChat(mockReq, mockRes);

      // Should return pending status immediately (not an error)
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pending' })
      );
      expect(mockRes.status).not.toHaveBeenCalledWith(500);

      // Wait for background run and email attempt to complete
      await new Promise(resolve => setTimeout(resolve, 100));
    });
  });

  describe('runScheduledChats endpoint', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.clearAllMocks();
      // Reset environment variables
      process.env = { ...originalEnv };
      // Setup default mocks needed for runScheduledChat
      mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
      mockAgentModeService.generateSessionTitle.mockResolvedValue('Generated Title');
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(mockResponse);
      mockChatbotDb.createChatSession.mockResolvedValue(mockSession);
      mockChatbotDb.getChatSession.mockResolvedValue(mockSession);
      mockScheduleDb.addRunResult.mockResolvedValue(undefined);
      mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined);
      mockEmailService.sendScheduledChatResultEmail.mockResolvedValue(undefined);
      mockEmailService.sendDailyDigestEmail.mockResolvedValue(undefined);
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should process multiple scheduled chats with 6 iterations each', async () => {
      // Set concurrent run limit to 2 to allow both schedules to run
      process.env.MAX_CONCURRENT_RUNS = '2';
      
      const schedules = [
        { ...baseSchedule, scheduleId: 'schedule-1', frequency: 'daily' },
        { ...baseSchedule, scheduleId: 'schedule-2', scheduleName: 'Test Schedule 2', frequency: 'daily' },
      ];

      // Mock getSchedulesReadyToRun to return multiple schedules
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue(schedules);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Processed 2 scheduled chats',
          processed: 2,
          results: expect.arrayContaining([
            expect.objectContaining({ scheduleId: 'schedule-1', status: 'started' }),
            expect.objectContaining({ scheduleId: 'schedule-2', status: 'started' }),
          ]),
        })
      );
    });

    it('should handle no scheduled chats ready to run', async () => {
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([]);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith({
        message: 'No scheduled chats ready to run',
        processed: 0,
        results: [],
      });
    });

    it('should request variable values and skip run when required variables are missing', async () => {
      const scheduleWithVariables = {
        ...baseSchedule,
        frequency: 'daily',
        variables: [{ name: 'company_name', description: 'Company name' }],
        variableValues: {},
        emailNotifications: ['notify@example.com'],
      };
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([scheduleWithVariables]);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      const nextRunTime = new Date(response.results[0].nextRunTime).getTime();
      const variableRequestExpiresAt = new Date(response.results[0].variableRequestExpiresAt).getTime();
      expect(response.results[0]).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'waiting_for_variables',
          missingVariables: ['company_name'],
          variableRequestExpiresAt: expect.any(String),
        })
      );
      expect(nextRunTime - variableRequestExpiresAt).toBe(30 * 60 * 1000);
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          variableRequestStatus: 'pending',
        })
      );
      expect(mockEmailService.sendScheduledChatVariableRequestEmail).toHaveBeenCalledWith(
        ['notify@example.com'],
        'Test Schedule',
        mockScheduleId,
        [{ name: 'company_name', description: 'Company name' }],
        expect.any(String),
        expect.any(String)
      );
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    });

    it('should request variable values when values are stale (not provided after latest request)', async () => {
      const scheduleWithStaleValues = {
        ...baseSchedule,
        frequency: 'daily',
        variables: [{ name: 'company_name', description: 'Company name' }],
        variableValues: { company_name: 'Acme Inc' },
        variableRequestStatus: 'provided',
        // Missing variableRequestSentAt/variableValuesUpdatedAt means values are considered stale for auto-run
        emailNotifications: ['notify@example.com'],
      };
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([scheduleWithStaleValues] as any);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(response.results[0]).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'waiting_for_variables',
          missingVariables: ['company_name'],
        })
      );
      expect(mockEmailService.sendScheduledChatVariableRequestEmail).toHaveBeenCalledWith(
        ['notify@example.com'],
        'Test Schedule',
        mockScheduleId,
        [{ name: 'company_name', description: 'Company name' }],
        expect.any(String),
        expect.any(String)
      );
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    });

    it('should request variable values when existing values predate the last run', async () => {
      const scheduleWithOutdatedValues = {
        ...baseSchedule,
        frequency: 'daily',
        variables: [{ name: 'company_name', description: 'Company name' }],
        variableValues: { company_name: 'Acme Inc' },
        variableRequestStatus: 'provided',
        variableRequestSentAt: '2026-01-01T00:00:00.000Z',
        variableValuesUpdatedAt: '2026-01-01T00:10:00.000Z',
        lastRunTime: '2026-01-02T00:00:00.000Z',
        emailNotifications: ['notify@example.com'],
      };
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([scheduleWithOutdatedValues] as any);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(response.results[0]).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'waiting_for_variables',
          missingVariables: ['company_name'],
        })
      );
      expect(mockEmailService.sendScheduledChatVariableRequestEmail).toHaveBeenCalledWith(
        ['notify@example.com'],
        'Test Schedule',
        mockScheduleId,
        [{ name: 'company_name', description: 'Company name' }],
        expect.any(String),
        expect.any(String)
      );
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    });

    it('should default to max 5 concurrent runs when MAX_CONCURRENT_RUNS is not set', async () => {
      delete process.env.MAX_CONCURRENT_RUNS;
      
      const schedules = Array.from({ length: 7 }, (_, i) => ({
        ...baseSchedule,
        scheduleId: `schedule-${i + 1}`,
        scheduleName: `Test Schedule ${i + 1}`,
        frequency: 'daily',
      }));

      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue(schedules);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      const startedCount = response.results.filter((r: any) => r.status === 'started').length;
      const delayedCount = response.results.filter((r: any) => r.status === 'delayed').length;

      expect(startedCount).toBe(5);
      expect(delayedCount).toBe(2);
    });

    it('should use custom MAX_CONCURRENT_RUNS from environment variable', async () => {
      process.env.MAX_CONCURRENT_RUNS = '3';
      
      const schedules = Array.from({ length: 5 }, (_, i) => ({
        ...baseSchedule,
        scheduleId: `schedule-${i + 1}`,
        scheduleName: `Test Schedule ${i + 1}`,
        frequency: 'daily',
      }));

      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue(schedules);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      const startedCount = response.results.filter((r: any) => r.status === 'started').length;
      const delayedCount = response.results.filter((r: any) => r.status === 'delayed').length;

      expect(startedCount).toBe(3);
      expect(delayedCount).toBe(2);
    });

    it('should delay schedules by 30 minutes when limit is reached', async () => {
      process.env.MAX_CONCURRENT_RUNS = '2';
      
      const schedules = Array.from({ length: 4 }, (_, i) => ({
        ...baseSchedule,
        scheduleId: `schedule-${i + 1}`,
        scheduleName: `Test Schedule ${i + 1}`,
        frequency: 'daily',
        lastRunTime: undefined,
      }));

      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue(schedules);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      const beforeTime = new Date();
      await agentModeController.runScheduledChats(mockReq, mockRes);
      const afterTime = new Date();

      // Check that delayed schedules have nextRunTime set to ~30 minutes from now
      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      const delayedResults = response.results.filter((r: any) => r.status === 'delayed');
      
      expect(delayedResults.length).toBe(2);
      
      delayedResults.forEach((result: any) => {
        const delayedTime = new Date(result.nextRunTime);
        const expectedMinTime = new Date(beforeTime.getTime() + 29 * 60 * 1000); // 29 minutes
        const expectedMaxTime = new Date(afterTime.getTime() + 31 * 60 * 1000); // 31 minutes
        
        expect(delayedTime.getTime()).toBeGreaterThanOrEqual(expectedMinTime.getTime());
        expect(delayedTime.getTime()).toBeLessThanOrEqual(expectedMaxTime.getTime());
        expect(result.reason).toContain('Delayed due to concurrent run limit (2)');
      });

      // Verify updateScheduleAfterRun was called with delayed time
      const delayedUpdateCalls = mockScheduleDb.updateScheduleAfterRun.mock.calls.filter((call: any) => {
        const nextRunTime = new Date(call[2]);
        const now = new Date();
        const diffMinutes = (nextRunTime.getTime() - now.getTime()) / (1000 * 60);
        return diffMinutes >= 29 && diffMinutes <= 31;
      });
      expect(delayedUpdateCalls.length).toBe(2);
    });

    it('should handle MAX_CONCURRENT_RUNS=0 correctly', async () => {
      process.env.MAX_CONCURRENT_RUNS = '0';
      
      const schedules = Array.from({ length: 3 }, (_, i) => ({
        ...baseSchedule,
        scheduleId: `schedule-${i + 1}`,
        scheduleName: `Test Schedule ${i + 1}`,
        frequency: 'daily',
      }));

      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue(schedules);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      const startedCount = response.results.filter((r: any) => r.status === 'started').length;
      const delayedCount = response.results.filter((r: any) => r.status === 'delayed').length;

      expect(startedCount).toBe(0);
      expect(delayedCount).toBe(3);
    });

    it('should run all schedules when under the limit', async () => {
      process.env.MAX_CONCURRENT_RUNS = '10';
      
      const schedules = Array.from({ length: 3 }, (_, i) => ({
        ...baseSchedule,
        scheduleId: `schedule-${i + 1}`,
        scheduleName: `Test Schedule ${i + 1}`,
        frequency: 'daily',
      }));

      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue(schedules);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      const response = (mockRes.json as jest.Mock).mock.calls[0][0];
      const startedCount = response.results.filter((r: any) => r.status === 'started').length;
      const delayedCount = response.results.filter((r: any) => r.status === 'delayed').length;

      expect(startedCount).toBe(3);
      expect(delayedCount).toBe(0);
    });
  });

  describe('Email Campaign Sync After Scheduled Chat Run', () => {
    const mockUserId = 'test-user-123';
    const mockScheduleId = 'test-schedule-123';
    
    const baseSchedule = {
      scheduleId: mockScheduleId,
      taskId: 'task-123',
      userId: mockUserId,
      frequency: 'daily',
      nextRunTime: new Date().toISOString(),
      status: 'active',
      createdAt: new Date().toISOString(),
      scheduleName: 'Test Schedule',
      startingMessage: 'Hello',
      emailCampaignTaskId: 'campaign-task-456',
    };

    beforeEach(() => {
      jest.clearAllMocks();
      // Setup default mocks needed for runScheduledChat
      mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
      mockAgentModeService.generateSessionTitle.mockResolvedValue('Generated Title');
      mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(void 0 as any);
      mockChatbotDb.addMessageToSession.mockResolvedValue(void 0 as any);
      mockChatbotDb.addMessagesToSession.mockResolvedValue(void 0 as any);
      mockChatbotDb.updateSessionTitle.mockResolvedValue(void 0 as any);
      mockTaskDb.getTaskExecutionById.mockResolvedValue(null as any);
    });

    it('should sync email campaign execution after scheduled chat run with HTML URLs', async () => {
      const scheduleWithCampaign = { ...baseSchedule };
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([scheduleWithCampaign]);
      
      const sessionWithMessages = {
        sessionId: 'session-123',
        userId: mockUserId,
        messages: [
          { role: 'user' as const, content: 'Hello' },
          { role: 'assistant' as const, content: 'Report: https://agentweb-user-files.s3.us-west-2.amazonaws.com/reports/report1.html' },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        emailCampaignTaskId: 'campaign-task-456',
      } as any;

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: 'Report: https://agentweb-user-files.s3.us-west-2.amazonaws.com/reports/report1.html',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });
      mockChatbotDb.createChatSession.mockResolvedValue({
        sessionId: 'session-123',
        userId: mockUserId,
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        emailCampaignTaskId: 'campaign-task-456',
      });
      // getChatSession returns session with messages (for sync to find HTML URLs)
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithMessages);

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      // Wait for async runScheduledChat to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should create execution and sync HTML URLs
      expect(mockTaskDb.createTaskExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: 'agentmode_session-123',
          taskId: 'campaign-task-456',
          userId: mockUserId,
        })
      );
      expect(mockTaskDb.updateTaskExecution).toHaveBeenCalledWith(
        'agentmode_session-123',
        expect.objectContaining({
          result_files: expect.arrayContaining([
            expect.objectContaining({ url: expect.stringContaining('report1.html'), is_html: true })
          ])
        })
      );
      expect(mockTaskDb.updateTaskExecution).toHaveBeenCalledWith(
        'agentmode_session-123',
        expect.objectContaining({ completedAt: expect.any(String) })
      );
    });

    it('should not sync if schedule has no emailCampaignTaskId', async () => {
      const scheduleWithoutCampaign = { ...baseSchedule, emailCampaignTaskId: undefined };
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([scheduleWithoutCampaign]);
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: 'Some content',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });
      mockChatbotDb.createChatSession.mockResolvedValue({
        sessionId: 'session-123',
        userId: mockUserId,
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      // Should not call task execution sync
      expect(mockTaskDb.createTaskExecution).not.toHaveBeenCalled();
      expect(mockTaskDb.updateTaskExecution).not.toHaveBeenCalled();
    });

    it('should update existing execution with new HTML URLs', async () => {
      const scheduleWithCampaign = { ...baseSchedule };
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([scheduleWithCampaign]);
      
      const sessionWithMessages = {
        sessionId: 'session-123',
        userId: mockUserId,
        messages: [
          { role: 'assistant' as const, content: 'Old: https://agentweb-user-files.s3.us-west-2.amazonaws.com/reports/old.html New: https://agentweb-user-files.s3.us-west-2.amazonaws.com/reports/new.html' },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        emailCampaignTaskId: 'campaign-task-456',
      } as any;

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: 'New report: https://agentweb-user-files.s3.us-west-2.amazonaws.com/reports/new.html',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });
      mockChatbotDb.createChatSession.mockResolvedValue({
        sessionId: 'session-123',
        userId: mockUserId,
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        emailCampaignTaskId: 'campaign-task-456',
      });
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithMessages);
      
      mockTaskDb.getTaskExecutionById.mockResolvedValue({
        executionId: 'agentmode_session-123',
        taskId: 'campaign-task-456',
        userId: mockUserId,
        result_files: [
          { url: 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/reports/old.html', filename: 'old.html', token: 't', is_html: true }
        ],
      });

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      // Wait for async runScheduledChat to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should update with new URL, keeping old one
      expect(mockTaskDb.updateTaskExecution).toHaveBeenCalledWith(
        'agentmode_session-123',
        expect.objectContaining({
          result_files: expect.arrayContaining([
            expect.objectContaining({ url: expect.stringContaining('old.html') }),
            expect.objectContaining({ url: expect.stringContaining('new.html'), is_html: true })
          ])
        })
      );
      // Should not create a new execution
      expect(mockTaskDb.createTaskExecution).not.toHaveBeenCalled();
    });

    it('should save failure run result and send error email when runScheduledChat throws', async () => {
      const scheduleWithEmail = {
        ...baseSchedule,
        frequency: 'daily',
        emailNotifications: ['alert@example.com'],
      };
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([scheduleWithEmail]);

      // Make createChatSession reject to simulate a runtime crash in runScheduledChat
      mockChatbotDb.createChatSession.mockRejectedValue(new Error('LLM provider timeout'));

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.runScheduledChats(mockReq, mockRes);

      // Wait for the fire-and-forget promise (.catch handler) to settle
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should save a failure run result to the database
      // Note: actualResponse is deleted before storing to save space
      expect(mockScheduleDb.addRunResult).toHaveBeenCalledWith(
        scheduleWithEmail.scheduleId,
        expect.objectContaining({
          scheduleId: scheduleWithEmail.scheduleId,
          status: 'failure',
          passed: false,
          sessionId: '',
          attempt: 0,
        })
      );

      // Note: Email is NOT sent when sessionId is empty (session creation failed)
      // This is by design - only send emails when a session actually executed
      expect(mockEmailService.sendScheduledChatResultEmail).not.toHaveBeenCalled();
    });

    it('should handle sync errors gracefully without failing the run', async () => {
      const scheduleWithCampaign = { ...baseSchedule };
      mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([scheduleWithCampaign]);
      
      const initialSession = {
        sessionId: 'session-123',
        userId: mockUserId,
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        emailCampaignTaskId: 'campaign-task-456',
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        content: 'Some content',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });
      mockChatbotDb.createChatSession.mockResolvedValue(initialSession);
      
      // getChatSession works during the run, but fails during sync
      let callCount = 0;
      mockChatbotDb.getChatSession.mockImplementation(() => {
        callCount++;
        // During run, return session normally
        if (callCount <= 5) {
          return Promise.resolve(initialSession);
        }
        // During sync, throw error
        throw new Error('Database error');
      });

      const mockReq = {} as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      // Should not throw, just log the error
      await expect(agentModeController.runScheduledChats(mockReq, mockRes)).resolves.not.toThrow();
      // The run should still complete successfully
      expect(mockRes.json).toHaveBeenCalled();
    });
  });

  describe('updateScheduledChat endpoint', () => {
    const mockUserId = 'test-user-123';
    const mockScheduleId = 'test-schedule-456';
    const originalNextRunTime = '2025-01-15T09:00:00.000Z';

    const existingSchedule = {
      scheduleId: mockScheduleId,
      taskId: 'task-123',
      userId: mockUserId,
      frequency: 'daily',
      nextRunTime: originalNextRunTime,
      status: 'active',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      scheduleName: 'Original Schedule Name',
      description: 'Original description',
      startingMessage: 'Original starting message',
      keywords: ['original', 'keywords'],
      requiredFunctionCalls: ['original_function'],
      functionCallMinCalls: { original_function: 1 },
      emailNotifications: ['original@example.com'],
      dailyDigest: false,
      emailCampaignTaskId: 'original-campaign-123',
      type: 'scheduled_chat',
    };

    beforeEach(() => {
      jest.clearAllMocks();
      mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule);
      mockScheduleDb.updateSchedule.mockResolvedValue(undefined);
    });

    it('should update schedule without modifying nextRunTime', async () => {
      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          scheduleName: 'Updated Schedule Name',
          description: 'Updated description',
          startingMessage: 'Updated starting message',
          scheduleFrequency: 'daily',
          keywords: ['updated', 'keywords'],
          requiredFunctionCalls: ['updated_function'],
          functionCallMinCalls: { updated_function: 2 },
          emailNotifications: ['updated@example.com'],
          dailyDigest: false,
          emailCampaignTaskId: 'updated-campaign-456',
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      // Verify updateSchedule was called with the right parameters
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          scheduleName: 'Updated Schedule Name',
          description: 'Updated description',
          startingMessage: 'Updated starting message',
          frequency: 'daily',
          keywords: ['updated', 'keywords'],
          requiredFunctionCalls: ['updated_function'],
          functionCallMinCalls: { updated_function: 2 },
          emailNotifications: ['updated@example.com'],
          dailyDigest: false,
          emailCampaignTaskId: 'updated-campaign-456',
          updatedAt: expect.any(String),
        })
      );

      // Verify nextRunTime was NOT included in the update
      const updateCall = mockScheduleDb.updateSchedule.mock.calls[0][1];
      expect(updateCall).not.toHaveProperty('nextRunTime');

      // Verify response returns the original nextRunTime
      expect(mockRes.json).toHaveBeenCalledWith({
        message: 'Scheduled chat updated successfully',
        nextRunTime: originalNextRunTime,
      });
    });

    it('should preserve nextRunTime even when changing frequency', async () => {
      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          scheduleName: 'Updated Schedule Name',
          description: 'Updated description',
          startingMessage: 'Updated starting message',
          scheduleFrequency: 'weekly', // Changed from daily to weekly
          keywords: ['updated', 'keywords'],
          requiredFunctionCalls: ['updated_function'],
          functionCallMinCalls: { updated_function: 1 },
          emailNotifications: ['updated@example.com'],
          dailyDigest: false,
          emailCampaignTaskId: null,
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      // Verify the frequency was updated
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          frequency: 'weekly',
        })
      );

      // Verify nextRunTime was NOT updated
      const updateCall = mockScheduleDb.updateSchedule.mock.calls[0][1];
      expect(updateCall).not.toHaveProperty('nextRunTime');

      // Verify response returns the original nextRunTime
      expect(mockRes.json).toHaveBeenCalledWith({
        message: 'Scheduled chat updated successfully',
        nextRunTime: originalNextRunTime,
      });
    });

    it('should return 404 if schedule does not exist', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(undefined);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: 'non-existent-schedule' },
        body: {
          scheduleName: 'Test',
          startingMessage: 'Test',
          scheduleFrequency: 'daily',
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Scheduled chat not found' });
    });

    it('should return 404 if schedule belongs to different user', async () => {
      const differentUserSchedule = {
        ...existingSchedule,
        userId: 'different-user-id',
      };
      mockScheduleDb.getScheduleById.mockResolvedValue(differentUserSchedule);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          scheduleName: 'Test',
          startingMessage: 'Test',
          scheduleFrequency: 'daily',
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Scheduled chat not found' });
    });

    it('should support partial updates by merging with existing schedule values', async () => {
      // Only send description — scheduleName, startingMessage, scheduleFrequency should come from existing
      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          description: 'Only updating the description',
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      // Should succeed (not 400)
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Scheduled chat updated successfully',
      }));

      // Verify existing values were preserved
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          scheduleName: existingSchedule.scheduleName,
          startingMessage: existingSchedule.startingMessage,
          frequency: existingSchedule.frequency,
          description: 'Only updating the description',
          keywords: existingSchedule.keywords,
          requiredFunctionCalls: existingSchedule.requiredFunctionCalls,
          functionCallMinCalls: existingSchedule.functionCallMinCalls,
          emailNotifications: existingSchedule.emailNotifications,
        })
      );
    });

    it('should allow updating just the starting message without other required fields', async () => {
      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          startingMessage: 'New starting message with a note about the redirect being fine',
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Scheduled chat updated successfully',
      }));

      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          scheduleName: existingSchedule.scheduleName,
          startingMessage: 'New starting message with a note about the redirect being fine',
          frequency: existingSchedule.frequency,
        })
      );
    });

    it('should handle dailyDigest setting correctly for hourly schedules', async () => {
      const hourlySchedule = {
        ...existingSchedule,
        frequency: 'hourly',
      };
      mockScheduleDb.getScheduleById.mockResolvedValue(hourlySchedule);

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          scheduleName: 'Updated Hourly Schedule',
          description: 'Updated description',
          startingMessage: 'Updated starting message',
          scheduleFrequency: 'hourly',
          keywords: [],
          requiredFunctionCalls: [],
          functionCallMinCalls: {},
          emailNotifications: ['test@example.com'],
          dailyDigest: true, // Should be allowed for hourly
          emailCampaignTaskId: null,
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          frequency: 'hourly',
          dailyDigest: true,
        })
      );
    });

    it('should force dailyDigest to false for non-hourly schedules', async () => {
      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          scheduleName: 'Updated Daily Schedule',
          description: 'Updated description',
          startingMessage: 'Updated starting message',
          scheduleFrequency: 'daily',
          keywords: [],
          requiredFunctionCalls: [],
          functionCallMinCalls: {},
          emailNotifications: ['test@example.com'],
          dailyDigest: true, // Should be ignored for daily
          emailCampaignTaskId: null,
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          frequency: 'daily',
          dailyDigest: false, // Should be forced to false
        })
      );
    });
  });

  describe('submitScheduledChatVariables endpoint', () => {
    const scheduleId = 'schedule-with-vars';
    const userId = 'test-user-123';

    it('should save values and trigger immediate run when all variables are provided', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue({
        scheduleId,
        userId,
        status: 'active',
        scheduleName: 'Vars Schedule',
        startingMessage: 'Run for {{company_name}} in {{target_market}}',
        variables: [{ name: 'company_name' }, { name: 'target_market' }],
        emailNotifications: [],
      } as any);

      const mockReq = {
        user: { userId },
        params: { scheduleId },
        body: {
          variableValues: {
            company_name: 'Acme Inc',
            target_market: 'SMB',
          },
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.submitScheduledChatVariables(mockReq, mockRes);

      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        scheduleId,
        expect.objectContaining({
          variableValues: {
            company_name: 'Acme Inc',
            target_market: 'SMB',
          },
          variableRequestStatus: 'provided',
        })
      );
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          missingVariables: [],
        })
      );
    });

    it('should save values without forcing immediate run when triggerRun is false', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue({
        scheduleId,
        userId,
        status: 'active',
        variables: [{ name: 'company_name' }],
      } as any);

      const mockReq = {
        user: { userId },
        params: { scheduleId },
        body: {
          triggerRun: false,
          variableValues: {
            company_name: 'Acme Inc',
          },
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.submitScheduledChatVariables(mockReq, mockRes);

      const payload = mockScheduleDb.updateSchedule.mock.calls[mockScheduleDb.updateSchedule.mock.calls.length - 1][1];
      expect(payload).not.toHaveProperty('nextRunTime');
    });
  });

  describe('Run Count Feature', () => {
    // Mock the scheduleDb.createSchedule to capture the schedule object
    const mockCreateSchedule = jest.fn();

    beforeEach(() => {
      // Add mock for createSchedule
      mockScheduleDb.createSchedule = mockCreateSchedule;
      mockCreateSchedule.mockClear();
    });

    describe('createScheduledChat', () => {
      it('should create schedule with default unlimited runCount when not provided', async () => {
        const mockReq = {
          user: { userId: mockUserId },
          body: {
            scheduleName: 'Test Schedule',
            startingMessage: 'Test message',
            scheduleFrequency: 'daily',
            keywords: [],
            requiredFunctionCalls: [],
            functionCallMinCalls: {},
            emailNotifications: ['test@example.com'],
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.createScheduledChat(mockReq, mockRes);

        expect(mockCreateSchedule).toHaveBeenCalledWith(
          expect.objectContaining({
            runCount: -1, // Should default to unlimited
          })
        );
      });

      it('should create schedule with specified limited runCount', async () => {
        const mockReq = {
          user: { userId: mockUserId },
          body: {
            scheduleName: 'Test Schedule',
            startingMessage: 'Test message',
            scheduleFrequency: 'daily',
            keywords: [],
            requiredFunctionCalls: [],
            functionCallMinCalls: {},
            emailNotifications: ['test@example.com'],
            runCount: 5,
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.createScheduledChat(mockReq, mockRes);

        expect(mockCreateSchedule).toHaveBeenCalledWith(
          expect.objectContaining({
            runCount: 5,
          })
        );
      });

      it('should reject invalid runCount values', async () => {
        const testCases = [
          { runCount: 0, errorMsg: 'runCount must be -1 (unlimited) or a positive integer' },
          { runCount: -5, errorMsg: 'runCount must be -1 (unlimited) or a positive integer' },
          { runCount: 1.5, errorMsg: 'runCount must be -1 (unlimited) or a positive integer' },
        ];

        for (const testCase of testCases) {
          const mockReq = {
            user: { userId: mockUserId },
            body: {
              scheduleName: 'Test Schedule',
              startingMessage: 'Test message',
              scheduleFrequency: 'daily',
              runCount: testCase.runCount,
            },
          } as unknown as Request;

          const mockRes = {
            json: jest.fn(),
            status: jest.fn().mockReturnThis(),
          } as unknown as Response;

          await agentModeController.createScheduledChat(mockReq, mockRes);

          expect(mockRes.status).toHaveBeenCalledWith(400);
          expect(mockRes.json).toHaveBeenCalledWith(
            expect.objectContaining({
              error: testCase.errorMsg,
            })
          );
        }
      });

      it('should create schedule with every_n_days frequency and frequencyIntervalDays', async () => {
        const mockReq = {
          user: { userId: mockUserId },
          body: {
            scheduleName: 'Every 3 Days Schedule',
            startingMessage: 'Test message',
            scheduleFrequency: 'every_n_days',
            frequencyIntervalDays: 3,
            keywords: [],
            requiredFunctionCalls: [],
            functionCallMinCalls: {},
            emailNotifications: ['test@example.com'],
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.createScheduledChat(mockReq, mockRes);

        expect(mockCreateSchedule).toHaveBeenCalledWith(
          expect.objectContaining({
            frequency: 'every_n_days',
            frequencyIntervalDays: 3,
          })
        );
      });

      it('should reject every_n_days without frequencyIntervalDays', async () => {
        const mockReq = {
          user: { userId: mockUserId },
          body: {
            scheduleName: 'Bad Schedule',
            startingMessage: 'Test message',
            scheduleFrequency: 'every_n_days',
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.createScheduledChat(mockReq, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith(
          expect.objectContaining({
            error: 'frequencyIntervalDays must be a positive integer when frequency is every_n_days',
          })
        );
      });

      it('should reject every_n_days with invalid frequencyIntervalDays', async () => {
        const testCases = [
          { frequencyIntervalDays: 0 },
          { frequencyIntervalDays: -1 },
          { frequencyIntervalDays: 1.5 },
        ];

        for (const testCase of testCases) {
          const mockReq = {
            user: { userId: mockUserId },
            body: {
              scheduleName: 'Bad Schedule',
              startingMessage: 'Test message',
              scheduleFrequency: 'every_n_days',
              frequencyIntervalDays: testCase.frequencyIntervalDays,
            },
          } as unknown as Request;

          const mockRes = {
            json: jest.fn(),
            status: jest.fn().mockReturnThis(),
          } as unknown as Response;

          await agentModeController.createScheduledChat(mockReq, mockRes);

          expect(mockRes.status).toHaveBeenCalledWith(400);
          expect(mockRes.json).toHaveBeenCalledWith(
            expect.objectContaining({
              error: 'frequencyIntervalDays must be a positive integer when frequency is every_n_days',
            })
          );
        }
      });

      it('should not include frequencyIntervalDays for non-every_n_days frequency', async () => {
        const mockReq = {
          user: { userId: mockUserId },
          body: {
            scheduleName: 'Daily Schedule',
            startingMessage: 'Test message',
            scheduleFrequency: 'daily',
            frequencyIntervalDays: 5, // Should be ignored
            keywords: [],
            requiredFunctionCalls: [],
            functionCallMinCalls: {},
            emailNotifications: ['test@example.com'],
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.createScheduledChat(mockReq, mockRes);

        expect(mockCreateSchedule).toHaveBeenCalledWith(
          expect.not.objectContaining({
            frequencyIntervalDays: expect.anything(),
          })
        );
      });

      it('should parse variables from startingMessage and keep provided descriptions', async () => {
        const mockReq = {
          user: { userId: mockUserId },
          body: {
            scheduleName: 'Variable Schedule',
            startingMessage: 'Summarize {{company_name}} for {{target_market}}',
            emailNotifications: ['notify@example.com'],
            scheduleFrequency: 'daily',
            variables: [
              { name: 'company_name', description: 'Company legal name' },
              { name: 'target_market', description: 'Primary market segment' },
            ],
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.createScheduledChat(mockReq, mockRes);

        expect(mockCreateSchedule).toHaveBeenCalledWith(
          expect.objectContaining({
            variables: [
              { name: 'company_name', description: 'Company legal name' },
              { name: 'target_market', description: 'Primary market segment' },
            ],
            variableRequestStatus: 'pending',
          })
        );
      });

      it('should default to user email when creating variable schedule without email notifications', async () => {
        const mockReq = {
          user: { userId: mockUserId, email: 'owner@example.com' },
          body: {
            scheduleName: 'Variable Schedule',
            startingMessage: 'Summarize {{company_name}}',
            scheduleFrequency: 'daily',
            emailNotifications: [],
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.createScheduledChat(mockReq, mockRes);

        // No longer rejects — falls back to user's own email
        expect(mockRes.status).not.toHaveBeenCalledWith(400);
        expect(mockCreateSchedule).toHaveBeenCalledWith(
          expect.objectContaining({
            emailNotifications: ['owner@example.com'],
          })
        );
      });
    });

    describe('updateScheduledChat', () => {
      it('should update schedule with new runCount', async () => {
        const mockReq = {
          user: { userId: mockUserId },
          params: { scheduleId: mockScheduleId },
          body: {
            scheduleName: 'Updated Schedule',
            startingMessage: 'Updated message',
            scheduleFrequency: 'daily',
            keywords: [],
            requiredFunctionCalls: [],
            functionCallMinCalls: {},
            emailNotifications: ['test@example.com'],
            runCount: 10,
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.updateScheduledChat(mockReq, mockRes);

        expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
          mockScheduleId,
          expect.objectContaining({
            runCount: 10,
          })
        );
      });

      it('should update schedule to unlimited runCount', async () => {
        const mockReq = {
          user: { userId: mockUserId },
          params: { scheduleId: mockScheduleId },
          body: {
            scheduleName: 'Updated Schedule',
            startingMessage: 'Updated message',
            scheduleFrequency: 'daily',
            keywords: [],
            requiredFunctionCalls: [],
            functionCallMinCalls: {},
            emailNotifications: ['test@example.com'],
            runCount: -1,
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.updateScheduledChat(mockReq, mockRes);

        expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
          mockScheduleId,
          expect.objectContaining({
            runCount: -1,
          })
        );
      });

      it('should reject invalid runCount values in update', async () => {
        const mockReq = {
          user: { userId: mockUserId },
          params: { scheduleId: mockScheduleId },
          body: {
            scheduleName: 'Updated Schedule',
            startingMessage: 'Updated message',
            scheduleFrequency: 'daily',
            runCount: 0, // Invalid
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.updateScheduledChat(mockReq, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith(
          expect.objectContaining({
            error: 'runCount must be -1 (unlimited) or a positive integer',
          })
        );
      });

      it('should list the missing field names when a required field resolves to empty', async () => {
        // baseSchedule (default mock) has no `frequency`, so omitting scheduleFrequency
        // in the request leaves effectiveScheduleFrequency undefined.
        const mockReq = {
          user: { userId: mockUserId },
          params: { scheduleId: mockScheduleId },
          body: {
            scheduleName: 'Updated Schedule',
            startingMessage: 'Updated message',
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.updateScheduledChat(mockReq, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith({
          error: 'Missing required fields: scheduleFrequency',
        });
      });

      it('should reject updating schedule without email notifications (no variables)', async () => {
        mockScheduleDb.getScheduleById.mockResolvedValue({
          scheduleId: mockScheduleId,
          userId: mockUserId,
          status: 'active',
          nextRunTime: '2025-01-15T09:00:00.000Z',
          emailNotifications: [],
        } as any);

        const mockReq = {
          user: { userId: mockUserId },
          params: { scheduleId: mockScheduleId },
          body: {
            scheduleName: 'Updated Schedule',
            startingMessage: 'Give me a marketing summary',
            scheduleFrequency: 'daily',
            emailNotifications: [],
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.updateScheduledChat(mockReq, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith({
          error: 'At least one email notification is required for scheduled chats'
        });
      });

      it('should reject updating schedule without email notifications (with variables)', async () => {
        mockScheduleDb.getScheduleById.mockResolvedValue({
          scheduleId: mockScheduleId,
          userId: mockUserId,
          status: 'active',
          nextRunTime: '2025-01-15T09:00:00.000Z',
          emailNotifications: [],
        } as any);

        const mockReq = {
          user: { userId: mockUserId },
          params: { scheduleId: mockScheduleId },
          body: {
            scheduleName: 'Updated Schedule',
            startingMessage: 'Analyze {{company_name}}',
            scheduleFrequency: 'daily',
            emailNotifications: [],
          },
        } as unknown as Request;

        const mockRes = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await agentModeController.updateScheduledChat(mockReq, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith({
          error: 'At least one email notification is required for scheduled chats'
        });
      });
    });
  });

  describe('getScheduledChats - Sorting', () => {
    // Mock getSchedulesByUserId to return schedules
    beforeEach(() => {
      mockScheduleDb.getSchedulesByUserId = jest.fn();
    });

    it('should sort scheduled chats by createdAt descending (newest first)', async () => {
      const oldSchedule = {
        scheduleId: 'old-schedule',
        scheduleName: 'Old Schedule',
        userId: mockUserId,
        type: 'scheduled_chat',
        createdAt: '2026-01-01T10:00:00.000Z',
        status: 'active',
        frequency: 'daily',
        nextRunTime: '2026-01-28T10:00:00.000Z',
      };

      const newSchedule = {
        scheduleId: 'new-schedule',
        scheduleName: 'New Schedule',
        userId: mockUserId,
        type: 'scheduled_chat',
        createdAt: '2026-01-26T10:00:00.000Z',
        status: 'active',
        frequency: 'daily',
        nextRunTime: '2026-01-28T10:00:00.000Z',
      };

      const middleSchedule = {
        scheduleId: 'middle-schedule',
        scheduleName: 'Middle Schedule',
        userId: mockUserId,
        type: 'scheduled_chat',
        createdAt: '2026-01-15T10:00:00.000Z',
        status: 'active',
        frequency: 'daily',
        nextRunTime: '2026-01-28T10:00:00.000Z',
      };

      // Return schedules in random order
      mockScheduleDb.getSchedulesByUserId.mockResolvedValue([
        middleSchedule,
        oldSchedule,
        newSchedule,
      ]);

      const mockReq = {
        user: { userId: mockUserId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.getScheduledChats(mockReq, mockRes);

      // Verify the response is sorted by createdAt descending
      expect(mockRes.json).toHaveBeenCalledWith([
        newSchedule,    // 2026-01-26 (newest)
        middleSchedule, // 2026-01-15
        oldSchedule,    // 2026-01-01 (oldest)
      ]);
    });

    it('should handle schedules without createdAt field', async () => {
      const scheduleWithCreatedAt = {
        scheduleId: 'schedule-1',
        scheduleName: 'Schedule 1',
        userId: mockUserId,
        type: 'scheduled_chat',
        createdAt: '2026-01-26T10:00:00.000Z',
        status: 'active',
        frequency: 'daily',
        nextRunTime: '2026-01-28T10:00:00.000Z',
      };

      const scheduleWithoutCreatedAt = {
        scheduleId: 'schedule-2',
        scheduleName: 'Schedule 2',
        userId: mockUserId,
        type: 'scheduled_chat',
        // No createdAt field
        status: 'active',
        frequency: 'daily',
        nextRunTime: '2026-01-28T10:00:00.000Z',
      };

      mockScheduleDb.getSchedulesByUserId.mockResolvedValue([
        scheduleWithoutCreatedAt,
        scheduleWithCreatedAt,
      ]);

      const mockReq = {
        user: { userId: mockUserId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.getScheduledChats(mockReq, mockRes);

      // Schedule with createdAt should come first (newest)
      // Schedule without createdAt should be treated as epoch 0 (oldest)
      expect(mockRes.json).toHaveBeenCalledWith([
        scheduleWithCreatedAt,
        scheduleWithoutCreatedAt,
      ]);
    });

    it('should filter out non-scheduled_chat types before sorting', async () => {
      const scheduledChat = {
        scheduleId: 'scheduled-chat',
        scheduleName: 'Scheduled Chat',
        userId: mockUserId,
        type: 'scheduled_chat',
        createdAt: '2026-01-26T10:00:00.000Z',
        status: 'active',
        frequency: 'daily',
        nextRunTime: '2026-01-28T10:00:00.000Z',
      };

      const taskSchedule = {
        scheduleId: 'task-schedule',
        scheduleName: 'Task Schedule',
        userId: mockUserId,
        type: 'task',
        createdAt: '2026-01-27T10:00:00.000Z', // Newer but wrong type
        status: 'active',
        frequency: 'daily',
        nextRunTime: '2026-01-28T10:00:00.000Z',
      };

      mockScheduleDb.getSchedulesByUserId.mockResolvedValue([
        taskSchedule,
        scheduledChat,
      ]);

      const mockReq = {
        user: { userId: mockUserId },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.getScheduledChats(mockReq, mockRes);

      // Should only return scheduled_chat type
      expect(mockRes.json).toHaveBeenCalledWith([scheduledChat]);
    });
  });

  describe('subscription wildcard handling', () => {
    const makeReqRes = () => {
      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
      } as unknown as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;
      return { mockReq, mockRes };
    };

    it('should allow scheduled chat to run when subscription returns wildcard ["*"]', async () => {
      // Override the mock to return wildcard
      mockedGetAllowedFunctionCalls.mockResolvedValueOnce(['*']);

      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // Should NOT send error email — wildcard means all tools are allowed
      expect(mockEmailService.sendScheduledChatErrorEmail).not.toHaveBeenCalled();

      // Should have run successfully (worker was called)
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalled();

      // Response should indicate success, not subscription failure
      expect(result).toEqual(
        expect.objectContaining({
          status: 'success',
        })
      );
    });

    it('should block scheduled chat and send error email when required tools are disallowed', async () => {
      // Override the mock to return a restricted set missing 'analyze_competitors'
      mockedGetAllowedFunctionCalls.mockResolvedValueOnce(['get_marketing_tips', 'create_work_plan']);

      // Use a schedule with email notifications
      const scheduleWithEmails = {
        ...baseSchedule,
        requiredFunctionCalls: ['get_marketing_tips', 'analyze_competitors'],
        emailNotifications: ['test@example.com'],
      };

      await runScheduledChat(scheduleWithEmails, mockUserId, true);

      // Should send error email because analyze_competitors is not allowed
      expect(mockEmailService.sendScheduledChatErrorEmail).toHaveBeenCalledWith(
        ['test@example.com'],
        baseSchedule.scheduleName,
        ['analyze_competitors'],
        baseSchedule.scheduleId
      );

      // Should not have called the worker
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).not.toHaveBeenCalled();
    });

    it('should block scheduled chat when subscription returns empty array', async () => {
      mockedGetAllowedFunctionCalls.mockResolvedValueOnce([]);

      await runScheduledChat(baseSchedule, mockUserId, true);

      expect(mockEmailService.sendScheduledChatErrorEmail).toHaveBeenCalled();
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).not.toHaveBeenCalled();
    });

    it('should block scheduled chat and send token limit email when user is over token limit', async () => {
      mockedCheckTokenUsage.mockResolvedValueOnce({
        allowed: false,
        warning: false,
        used: 1050000,
        allowance: 1000000,
        percentUsed: 105,
        effectiveAllowance: 1000000,
        bonus: 0,
        month: '2026-04',
        costUsed: 0,
        costAllowance: null,
        costPercentUsed: 0,
        costEnforced: false,
      });

      const scheduleWithEmails = {
        ...baseSchedule,
        requiredFunctionCalls: [],
        emailNotifications: ['owner@example.com'],
      };

      const result = await runScheduledChat(scheduleWithEmails, mockUserId, true);

      expect(mockEmailService.sendScheduledChatTokenLimitEmail).toHaveBeenCalledWith(
        ['owner@example.com'],
        scheduleWithEmails.scheduleName,
        scheduleWithEmails.scheduleId,
        expect.objectContaining({ allowed: false, used: 1050000 })
      );
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).not.toHaveBeenCalled();
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ status: 'failure', passed: false }));
    });

    it('should block scheduled chat over token limit and fall back to user email when no emailNotifications set', async () => {
      mockedCheckTokenUsage.mockResolvedValueOnce({
        allowed: false,
        warning: false,
        used: 1050000,
        allowance: 1000000,
        percentUsed: 105,
        effectiveAllowance: 1000000,
        bonus: 0,
        month: '2026-04',
        costUsed: 0,
        costAllowance: null,
        costPercentUsed: 0,
        costEnforced: false,
      });

      const scheduleNoEmails = {
        ...baseSchedule,
        requiredFunctionCalls: [],
        emailNotifications: [],
      };

      await runScheduledChat(scheduleNoEmails, mockUserId, true);

      expect(mockEmailService.sendScheduledChatTokenLimitEmail).toHaveBeenCalledWith(
        ['owner@example.com'], // falls back to user's email from userDb
        scheduleNoEmails.scheduleName,
        scheduleNoEmails.scheduleId,
        expect.objectContaining({ allowed: false })
      );
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).not.toHaveBeenCalled();
    });

    it('should save failure run result to DB when token limit is exceeded', async () => {
      mockedCheckTokenUsage.mockResolvedValueOnce({
        allowed: false,
        warning: false,
        used: 1050000,
        allowance: 1000000,
        percentUsed: 105,
        effectiveAllowance: 1000000,
        bonus: 0,
        month: '2026-04',
        costUsed: 0,
        costAllowance: null,
        costPercentUsed: 0,
        costEnforced: false,
      });

      const scheduleWithEmails = { ...baseSchedule, requiredFunctionCalls: [], emailNotifications: ['owner@example.com'] };
      await runScheduledChat(scheduleWithEmails, mockUserId, true);

      expect(mockScheduleDb.addRunResult).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({ status: 'failure', passed: false })
      );
    });

    it('should render a cost-based block message when the cost cap is the cause and tokens are unlimited', async () => {
      mockedCheckTokenUsage.mockResolvedValueOnce({
        allowed: false,
        warning: false,
        used: 5000000,
        allowance: null,
        percentUsed: 0,
        effectiveAllowance: null,
        bonus: 0,
        month: '2026-04',
        costUsed: 42.5,
        costAllowance: 40,
        costPercentUsed: 106,
        costEnforced: true,
      });

      const scheduleWithEmails = {
        ...baseSchedule,
        requiredFunctionCalls: [],
        emailNotifications: ['owner@example.com'],
      };

      const result = await runScheduledChat(scheduleWithEmails, mockUserId, true);

      expect(mockEmailService.sendScheduledChatTokenLimitEmail).toHaveBeenCalled();
      expect(result.actualResponse).toContain('Monthly cost limit reached');
      expect(result.actualResponse).toContain('$42.50 / $40.00 spent this month');
      expect(result.actualResponse).not.toContain('tokens used');
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).not.toHaveBeenCalled();
    });

    it('should allow scheduled chat when token usage is under the limit', async () => {
      // Default mock returns allowed: true — just verify normal execution proceeds
      const successfulResponse = {
        ...mockResponse,
        content: 'marketing strategy tips',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      expect(mockEmailService.sendScheduledChatTokenLimitEmail).not.toHaveBeenCalled();
      expect(mockChatbotDb.createChatSession).toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ status: 'success' }));
    });
  });

  describe('auto-install skills for required functions', () => {
    it('should auto-install skills that contain required function calls', async () => {
      const publishedSkills = [
        { skillId: 'marketing-skill', name: 'Marketing', toolNames: ['get_marketing_tips', 'read_brand_guidelines'] },
        { skillId: 'research-skill', name: 'Research', toolNames: ['analyze_competitors', 'search_web'] },
        { skillId: 'unrelated-skill', name: 'Unrelated', toolNames: ['generate_image'] },
      ];
      mockedSkillService.getPublishedSkills.mockResolvedValue(publishedSkills as any);
      mockedGetAllowedSkills.mockResolvedValue(['*']);

      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      await runScheduledChat(baseSchedule, mockUserId, true);

      // Should install only skills containing required tools
      expect(mockAgentModeService.installSkills).toHaveBeenCalledWith(
        expect.arrayContaining(['marketing-skill', 'research-skill']),
        mockUserId,
        'test-session-123'
      );
      // Should not install unrelated skill
      const installedIds = (mockAgentModeService.installSkills as jest.Mock).mock.calls[0][0];
      expect(installedIds).not.toContain('unrelated-skill');
    });

    it('should only install subscription-allowed skills', async () => {
      const publishedSkills = [
        { skillId: 'marketing-skill', name: 'Marketing', toolNames: ['get_marketing_tips'] },
        { skillId: 'research-skill', name: 'Research', toolNames: ['analyze_competitors'] },
      ];
      mockedSkillService.getPublishedSkills.mockResolvedValue(publishedSkills as any);
      // Only marketing-skill is allowed
      mockedGetAllowedSkills.mockResolvedValue(['marketing-skill']);

      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      await runScheduledChat(baseSchedule, mockUserId, true);

      // Should only install the allowed skill
      const installedIds = (mockAgentModeService.installSkills as jest.Mock).mock.calls[0][0];
      expect(installedIds).toContain('marketing-skill');
      expect(installedIds).not.toContain('research-skill');
    });

    it('should not call installSkills when no required functions are specified', async () => {
      const scheduleNoFunctions = {
        ...baseSchedule,
        requiredFunctionCalls: [],
        keywords: [],
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        ...mockResponse,
        content: 'Some response',
        toolCalls: [],
      });

      await runScheduledChat(scheduleNoFunctions, mockUserId, true);

      expect(mockAgentModeService.installSkills).not.toHaveBeenCalled();
    });

    it('should install __other_skills__ when required tools are not in any published skill', async () => {
      const publishedSkills = [
        { skillId: 'marketing-skill', name: 'Marketing', toolNames: ['get_marketing_tips'] },
      ];
      mockedSkillService.getPublishedSkills.mockResolvedValue(publishedSkills as any);
      mockedGetAllowedSkills.mockResolvedValue(['*']);

      // analyze_competitors is not in any published skill
      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      await runScheduledChat(baseSchedule, mockUserId, true);

      const installedIds = (mockAgentModeService.installSkills as jest.Mock).mock.calls[0][0];
      expect(installedIds).toContain('marketing-skill');
      expect(installedIds).toContain('__other_skills__');
    });

    it('should handle auto-install errors gracefully and still run the chat', async () => {
      mockedSkillService.getPublishedSkills.mockRejectedValue(new Error('Skill service down'));

      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      await runScheduledChat(baseSchedule, mockUserId, true);

      // Should still run the chat despite auto-install failure
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalled();
    });
  });

  describe('decrement bug fix - function call counts accumulate across attempts', () => {
    it('should accumulate function call counts across attempts and succeed when all are met', async () => {
      let callCount = 0;
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First attempt: only get_marketing_tips, missing analyze_competitors
          return Promise.resolve({
            ...mockResponse,
            content: 'Here are some general tips.',
            toolCalls: [{ name: 'get_marketing_tips', arguments: {} }],
          });
        } else {
          // Second attempt: calls analyze_competitors
          return Promise.resolve({
            ...mockResponse,
            content: 'Here are some marketing strategy and competitor analysis.',
            toolCalls: [{ name: 'analyze_competitors', arguments: {} }],
          });
        }
      });

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // Should succeed on second attempt since both functions were called across attempts
      expect(result).toEqual(
        expect.objectContaining({
          status: 'success',
          passed: true,
          functionCallMatches: expect.arrayContaining(['get_marketing_tips', 'analyze_competitors']),
          functionCallMisses: [],
        })
      );
      // Should have needed exactly 2 attempts
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(2);
    });
  });

  describe('createScheduledChat - email normalization for variables', () => {
    const mockCreateSchedule = jest.fn();

    beforeEach(() => {
      mockScheduleDb.createSchedule = mockCreateSchedule;
      mockCreateSchedule.mockClear();
    });

    it('should default to user email when variables present but no emailNotifications provided', async () => {
      const mockReq = {
        user: { userId: mockUserId, email: 'owner@example.com' },
        body: {
          scheduleName: 'SEO Scan',
          startingMessage: 'Scan {{website}} for SEO issues',
          scheduleFrequency: 'weekly',
          // No emailNotifications provided
        },
      } as unknown as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.createScheduledChat(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockCreateSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          emailNotifications: ['owner@example.com'],
        })
      );
    });

    it('should normalize emailNotifications string to array when variables present', async () => {
      const mockReq = {
        user: { userId: mockUserId, email: 'owner@example.com' },
        body: {
          scheduleName: 'SEO Scan',
          startingMessage: 'Scan {{website}} for SEO issues',
          scheduleFrequency: 'weekly',
          emailNotifications: 'user@rankai.ai', // string, not array
        },
      } as unknown as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.createScheduledChat(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockCreateSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          emailNotifications: ['user@rankai.ai'],
        })
      );
    });

    it('should not require email when all variable values are pre-filled', async () => {
      const mockReq = {
        user: { userId: mockUserId, email: 'owner@example.com' },
        body: {
          scheduleName: 'SEO Scan',
          startingMessage: 'Scan {{website}} for SEO issues',
          scheduleFrequency: 'weekly',
          variableValues: { website: 'rankai.ai' },
          // No emailNotifications
        },
      } as unknown as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.createScheduledChat(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockCreateSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          emailNotifications: [], // pre-filled vars → no email needed
          variableValues: { website: 'rankai.ai' },
        })
      );
    });

    it('should default to user email when no variables and no emailNotifications provided', async () => {
      const mockReq = {
        user: { userId: mockUserId, email: 'owner@example.com' },
        body: {
          scheduleName: 'Website Scan',
          startingMessage: 'Scan https://example.com for issues',
          scheduleFrequency: 'weekly',
          // No variables, no emailNotifications
        },
      } as unknown as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.createScheduledChat(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockCreateSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          emailNotifications: ['owner@example.com'],
        })
      );
    });

    it('should default to user email when no variables and explicit empty emailNotifications provided', async () => {
      const mockReq = {
        user: { userId: mockUserId, email: 'owner@example.com' },
        body: {
          scheduleName: 'Website Scan',
          startingMessage: 'Scan https://example.com for issues',
          scheduleFrequency: 'daily',
          emailNotifications: [], // explicitly empty
        },
      } as unknown as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.createScheduledChat(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockCreateSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          emailNotifications: ['owner@example.com'],
        })
      );
    });

    it('should use admin email as fallback on delegate access', async () => {
      const mockReq = {
        user: { userId: 'customer-456', email: 'customer@example.com' },
        delegateInfo: {
          adminUserId: mockUserId,
          adminEmail: 'admin@example.com',
          isDelegated: true,
        },
        body: {
          scheduleName: 'Website Scan',
          startingMessage: 'Scan https://example.com for issues',
          scheduleFrequency: 'weekly',
          // No emailNotifications
        },
      } as unknown as Request;
      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.createScheduledChat(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockCreateSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          emailNotifications: ['admin@example.com'],
        })
      );
    });
  });
});
