/**
 * ENG-1259 — cheap pre-check gate wiring in `runScheduledChat`.
 *
 * Recurring scheduled chats ran the ENTIRE multi-step generative flow before
 * determining whether there was anything worth doing. Evidence: PMPS's
 * `LUCAS — LinkedIn Thought Leadership (Mon/Wed/Fri)` scheduled chat, four
 * real occurrences that each ran the full flow (41-129 messages) before
 * concluding there was nothing to publish — "Schedule skipped" x3
 * ($21.61/$12.36/$12.32) and "Nothing Published" x1 ($11.35).
 *
 * These tests prove the gate wired into `runScheduledChat`:
 *  - exits BEFORE the primary generation model when the prior run had no
 *    actionable output and the cheap classifier is confident (AC1, AC3, AC5);
 *  - leaves the full flow completely unchanged when there IS actionable
 *    content, or when there is no signal to gate on at all (AC2);
 *  - fails TOWARD running on an ambiguous/low-confidence classification
 *    (AC4);
 *  - never applies to a resumed run or an interactive test run.
 */

jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => ['*']),
  getAllowedSkills: jest.fn(async () => ['*']),
  isSubscriptionFeatureEnabled: jest.fn(async () => true),
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
    resolveGenerationModel: jest.fn((model: string) => ({ model, fellBack: false, requestedModel: model })),
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getScheduledChatsDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    generateMarketingResponse: jest.fn(),
    generateScheduledChatSummary: jest.fn().mockResolvedValue(null),
    // ENG-1259 — the cheap pre-check gate's LLM call. Each test controls its
    // resolution explicitly; this default keeps unrelated tests on the
    // "proceed" path if they forget to set it.
    evaluateScheduledRunPreCheck: jest.fn().mockResolvedValue(null),
    installSkills: jest.fn().mockResolvedValue({ success: true, installedSkills: [] }),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set([
      'install_skills', 'search_web', 'read_file_content', 'read_page_source',
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
    releaseSessionClients: jest.fn(),
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
    claimAndPauseUnresumable: jest.fn().mockResolvedValue('paused'),
    updateSchedule: jest.fn().mockResolvedValue(undefined),
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
    sendScheduledRunFailedEmail: jest.fn(),
  },
}));

jest.mock('../services/tokenUsageService', () => ({
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

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb, userDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { runScheduledChat } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

describe('runScheduledChat — ENG-1259 cheap pre-check gate', () => {
  const mockUserId = 'test-user-lucas';
  const mockScheduleId = 'test-schedule-lucas';

  // Mirrors the real PMPS LUCAS schedule from the ENG-1259 evidence: a Mon/Wed/Fri
  // LinkedIn thought-leadership post, no keywords, one required write call.
  const lucasSchedule = {
    scheduleId: mockScheduleId,
    scheduleName: 'LUCAS — LinkedIn Thought Leadership (Mon/Wed/Fri)',
    startingMessage: 'Publish today\'s thought-leadership post only on Mon/Wed/Fri.',
    keywords: [],
    requiredFunctionCalls: [],
    functionCallMinCalls: {},
    userId: mockUserId,
  };

  const mockSession = {
    sessionId: 'lucas-session-1',
    userId: mockUserId,
    title: 'Scheduled: LUCAS',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockWorkerResponse = {
    content: 'Published a new thought-leadership post about the Q3 payments outlook.',
    toolCalls: [{ name: 'post_on_connected_account', arguments: {} }],
    knowledgeBaseQueries: [],
    sources: [],
    responseMessages: [],
  };

  // Reconstructed from the evidence: three prior "Schedule skipped" runs in a
  // row, each of which ran the OLD (un-gated) full flow to conclude there was
  // nothing to publish. `attempt` is set (matching the 41-129 message real
  // occurrences) so these read as GENUINE declines, not pre-flight blocks.
  const lucasNoOutputHistory = [
    { status: 'failure', passed: false, actualResponse: 'Schedule skipped', attempt: 6, createdAt: '2026-08-10T13:00:00Z' },
    { status: 'failure', passed: false, actualResponse: 'Schedule skipped', attempt: 3, createdAt: '2026-08-12T13:00:00Z' },
    { status: 'failure', passed: false, actualResponse: 'Nothing Published', attempt: 2, createdAt: '2026-08-13T13:00:00Z' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.createChatSession.mockResolvedValue(mockSession);
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(mockSession);
    mockAgentModeService.getDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Generated Title');
    mockAgentModeService.generateScheduledChatSummary.mockResolvedValue(null);
    mockAgentModeService.evaluateScheduledRunPreCheck.mockResolvedValue(null);
    mockWorker.runInWorker.mockResolvedValue(mockWorkerResponse);
    mockScheduleDb.addRunResult.mockResolvedValue(undefined);
    mockScheduleDb.getScheduleById.mockResolvedValue(lucasSchedule);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([]);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined);
    mockUserDb.getUserById.mockResolvedValue({ userId: mockUserId, email: 'owner@pmps.ai' } as any);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('no trigger signal — zero added cost on a healthy schedule (AC2)', () => {
    it('never calls the pre-check LLM on a schedule\'s first-ever run (no history)', async () => {
      await runScheduledChat({ ...lucasSchedule, runResults: [] }, mockUserId, false);

      expect(mockAgentModeService.evaluateScheduledRunPreCheck).not.toHaveBeenCalled();
      expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
    });

    it('never calls the pre-check LLM when the most recent run was productive', async () => {
      const healthyHistory = [
        { status: 'failure', passed: false, actualResponse: 'Schedule skipped', attempt: 4 },
        { status: 'success', passed: true, actualFunctionCalls: ['post_on_connected_account'], attempt: 1 },
      ];

      await runScheduledChat({ ...lucasSchedule, runResults: healthyHistory }, mockUserId, false);

      expect(mockAgentModeService.evaluateScheduledRunPreCheck).not.toHaveBeenCalled();
      expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
    });

    // Greptile P1 (initial review): a bare status:'failure' also covers pre-flight
    // blocks that never reached the model at all (entitlement checks, token-limit
    // caps, an orphaned schedule owner, a generic exception before any turn ran) —
    // every one of which this codebase records with attempt: 0. The schedule's
    // next fire is supposed to retry normally, not have this gate reason about it
    // as a content decision.
    it('never calls the pre-check LLM when the most recent run was a pre-flight operational failure (attempt: 0)', async () => {
      const operationalFailureHistory = [
        { status: 'failure', passed: false, actualResponse: 'Scheduled chat cannot run: Monthly cost limit reached', attempt: 0 },
      ];

      await runScheduledChat({ ...lucasSchedule, runResults: operationalFailureHistory }, mockUserId, false);

      expect(mockAgentModeService.evaluateScheduledRunPreCheck).not.toHaveBeenCalled();
      expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
    });
  });

  describe('skip-streak ceiling — the gate cannot suppress real work forever (Greptile P1, initial review)', () => {
    it('bypasses the classifier and forces the full flow after the consecutive-skip cap is reached', async () => {
      const skipStreakHistory = [
        ...lucasNoOutputHistory,
        { status: 'skipped_no_content', passed: false, actualResponse: 'Skipped before running the full flow', attempt: 0 },
        { status: 'skipped_no_content', passed: false, actualResponse: 'Skipped before running the full flow', attempt: 0 },
      ];
      // Even if the classifier WOULD confidently say skip again, the streak cap
      // must win — the classifier is never even asked.
      mockAgentModeService.evaluateScheduledRunPreCheck.mockResolvedValue({
        decision: 'skip',
        confidence: 'high',
        reason: 'would skip again',
      });

      const result = await runScheduledChat({ ...lucasSchedule, runResults: skipStreakHistory }, mockUserId, false);

      expect(mockAgentModeService.evaluateScheduledRunPreCheck).not.toHaveBeenCalled();
      expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
      expect(result.status).not.toBe('skipped_no_content');
    });

    it('still gates normally below the cap (single prior gate skip)', async () => {
      const oneSkipHistory = [
        ...lucasNoOutputHistory,
        { status: 'skipped_no_content', passed: false, actualResponse: 'Skipped before running the full flow', attempt: 0 },
      ];
      mockAgentModeService.evaluateScheduledRunPreCheck.mockResolvedValue({
        decision: 'skip',
        confidence: 'high',
        reason: 'still nothing new',
      });

      const result = await runScheduledChat({ ...lucasSchedule, runResults: oneSkipHistory }, mockUserId, false);

      expect(mockAgentModeService.evaluateScheduledRunPreCheck).toHaveBeenCalledTimes(1);
      expect(mockWorker.runInWorker).not.toHaveBeenCalled();
      expect(result.status).toBe('skipped_no_content');
    });
  });

  describe('skip path — no new actionable content (AC1, AC3, AC5)', () => {
    it('exits BEFORE invoking the primary generation model when the gate is confident there is nothing to do', async () => {
      mockAgentModeService.evaluateScheduledRunPreCheck.mockResolvedValue({
        decision: 'skip',
        confidence: 'high',
        reason: 'Three consecutive runs found nothing new; no sign anything changed.',
      });

      const result = await runScheduledChat({ ...lucasSchedule, runResults: lucasNoOutputHistory }, mockUserId, false);

      // The hard assertion: the expensive worker was NEVER called (call count, not
      // just the returned content).
      expect(mockWorker.runInWorker).not.toHaveBeenCalled();
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();

      // AC3: a distinct status from both "ran and failed" and "ran and succeeded".
      expect(result.status).toBe('skipped_no_content');
      expect(result.passed).toBe(false);
      expect(result.sessionId).toBe('');
    });

    it('persists the skip as a run result so cost/waste analysis can see it without a session', async () => {
      mockAgentModeService.evaluateScheduledRunPreCheck.mockResolvedValue({
        decision: 'skip',
        confidence: 'high',
        reason: 'no new content',
      });

      await runScheduledChat({ ...lucasSchedule, runResults: lucasNoOutputHistory }, mockUserId, false);

      expect(mockScheduleDb.addRunResult).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({ status: 'skipped_no_content', passed: false })
      );
    });

    it('does not send a result email for a pre-check skip (sessionId empty, same convention as the entitlement/token-limit gates)', async () => {
      mockAgentModeService.evaluateScheduledRunPreCheck.mockResolvedValue({
        decision: 'skip',
        confidence: 'high',
        reason: 'no new content',
      });

      const result = await runScheduledChat(
        { ...lucasSchedule, runResults: lucasNoOutputHistory, emailNotifications: ['owner@pmps.ai'] },
        mockUserId,
        false
      );

      expect(result.sessionId).toBe('');
    });

    it('replays the reconstructed LUCAS "nothing to publish" scenario at near-zero cost (AC5)', async () => {
      mockAgentModeService.evaluateScheduledRunPreCheck.mockResolvedValue({
        decision: 'skip',
        confidence: 'high',
        reason: 'Repeat of the last 3 runs; instructions give no reason today differs.',
      });

      const result = await runScheduledChat({ ...lucasSchedule, runResults: lucasNoOutputHistory }, mockUserId, false);

      // Same functional outcome as the historical evidence: nothing published.
      expect(result.actualFunctionCalls).toEqual([]);
      // At a fraction of the cost: the 41-129 message full agent loop never ran.
      expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    });
  });

  describe('proceed path — actionable content exists, full flow unchanged (AC2)', () => {
    it('runs the existing full flow exactly as today when the gate says proceed', async () => {
      mockAgentModeService.evaluateScheduledRunPreCheck.mockResolvedValue({
        decision: 'proceed',
        confidence: 'high',
        reason: 'New Q3 outlook content is available.',
      });

      const result = await runScheduledChat({ ...lucasSchedule, runResults: lucasNoOutputHistory }, mockUserId, false);

      expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
      expect(mockChatbotDb.createChatSession).toHaveBeenCalledTimes(1);
      expect(result.status).not.toBe('skipped_no_content');
      expect(result.sessionId).toBe(mockSession.sessionId);
    });
  });

  describe('fail TOWARD running on ambiguity (AC4)', () => {
    it('proceeds through the full flow when the pre-check is low-confidence', async () => {
      mockAgentModeService.evaluateScheduledRunPreCheck.mockResolvedValue({
        decision: 'skip',
        confidence: 'low',
        reason: 'Not fully sure whether anything changed.',
      });

      await runScheduledChat({ ...lucasSchedule, runResults: lucasNoOutputHistory }, mockUserId, false);

      expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
    });

    it('proceeds through the full flow when the pre-check LLM call itself failed (returned null)', async () => {
      mockAgentModeService.evaluateScheduledRunPreCheck.mockResolvedValue(null);

      await runScheduledChat({ ...lucasSchedule, runResults: lucasNoOutputHistory }, mockUserId, false);

      expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
    });

    it('proceeds through the full flow when evaluateScheduledRunPreCheck unexpectedly throws', async () => {
      mockAgentModeService.evaluateScheduledRunPreCheck.mockRejectedValue(new Error('unexpected'));

      const result = await runScheduledChat({ ...lucasSchedule, runResults: lucasNoOutputHistory }, mockUserId, false);

      expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
      expect(result.status).not.toBe('skipped_no_content');
    });
  });

  describe('never applies to a resumed run or an interactive test run', () => {
    it('does not gate a resumed run, even with a no-output history', async () => {
      const resumeSessionId = 'resume-sess-lucas';
      mockChatbotDb.getChatSession.mockResolvedValue({
        ...mockSession,
        sessionId: resumeSessionId,
        userId: mockUserId,
        messages: [
          { role: 'user', content: lucasSchedule.startingMessage },
          { role: 'assistant', content: 'Working on it.', tool_calls: [{ id: 'c1', function: { name: 'search_web' } }] },
          { role: 'tool', tool_call_id: 'c1', content: '{}' },
        ],
      } as any);

      await runScheduledChat(
        { ...lucasSchedule, runResults: lucasNoOutputHistory, pendingResumeSessionId: resumeSessionId },
        mockUserId,
        false
      );

      expect(mockAgentModeService.evaluateScheduledRunPreCheck).not.toHaveBeenCalled();
      expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
    });

    it('does not gate an interactive test run, even with a no-output history', async () => {
      await runScheduledChat({ ...lucasSchedule, runResults: lucasNoOutputHistory }, mockUserId, true);

      expect(mockAgentModeService.evaluateScheduledRunPreCheck).not.toHaveBeenCalled();
      expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
    });
  });
});
