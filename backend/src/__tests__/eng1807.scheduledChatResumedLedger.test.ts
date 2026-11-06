/**
 * ENG-1807 — a scheduled-chat run interrupted mid-flight (e.g. a worker-drain hit during a
 * deploy) used to persist a permanently wrong `test-history` record: hardcoded
 * `actualFunctionCalls: []` / `passed: false`, even when the run had already completed
 * everything required and persisted it to the session before the later exception hit.
 *
 * `runScheduledChat` now reconstructs what actually happened from the session's own
 * persisted messages (`reconstructPriorToolCalls`, the same helper the ENG-657 resume path
 * already relies on) before writing the error result, rather than assuming nothing happened.
 *
 * A related fix in the same pass: a RESUMED run's persisted `actualFunctionCalls` audit list
 * used to under-report the abandoned portion's calls (unlike the pass/fail verdict, which
 * already counted them) — now prepended the same way.
 */

jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => ['get_marketing_tips', 'analyze_competitors']),
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
    generateScheduledChatSummary: jest.fn(),
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
    cancelSession: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
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
  },
  userDb: {
    getUserById: jest.fn().mockResolvedValue({ userId: 'test-user-123', email: 'owner@example.com' }),
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
    sendScheduleSourcingBlockTransitionEmail: jest.fn(),
  },
}));

jest.mock('../services/tokenUsageService', () => ({
  ...jest.requireActual('../services/tokenUsageService'),
  checkTokenUsage: jest.fn(async () => ({
    allowed: true, warning: false, used: 100000, allowance: 1000000, bonus: 0,
    effectiveAllowance: 1000000, percentUsed: 10, month: '2026-04',
  })),
}));

jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/intakeService', () => ({
  fileAutoIssue: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/skillService', () => ({
  skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]) },
}));

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { getAllowedFunctionCalls } from '../services/subscriptionService';
import { runScheduledChat } from '../controllers/agentModeController';

const mockedGetAllowedFunctionCalls = getAllowedFunctionCalls as jest.MockedFunction<typeof getAllowedFunctionCalls>;

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

describe('ENG-1807 — scheduled-chat run interrupted mid-flight reconstructs the real ledger', () => {
  const mockUserId = 'test-user-123';
  const mockScheduleId = 'test-schedule-123';
  const mockSessionId = 'test-session-123';

  const baseSchedule = {
    scheduleId: mockScheduleId,
    scheduleName: 'Test Schedule',
    startingMessage: 'Hello, please help me with marketing',
    keywords: [],
    requiredFunctionCalls: ['get_marketing_tips'],
    userId: mockUserId,
  };

  const mockSession = {
    sessionId: mockSessionId,
    userId: mockUserId,
    title: 'Test Session',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // A "final assistant answer" transcript keeps isZeroAssistantOutputError's fallback check
  // (transcriptHasFinalAssistantAnswer, via getMessagesFromMessagesTable) out of the picture,
  // so these tests isolate the ledger-reconstruction fix without also exercising the
  // separate zero-output-requeue subsystem.
  const finalAnswerMessages = [
    { role: 'assistant', content: 'Report generated successfully.' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentModeService.getDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Generated Title');
    mockAgentModeService.generateScheduledChatSummary.mockResolvedValue(null);

    mockChatbotDb.createChatSession.mockResolvedValue(mockSession);
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession);
    (mockChatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(finalAnswerMessages);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(mockSession);
    (mockChatbotDb.updateSessionError as jest.Mock).mockResolvedValue(undefined);

    mockScheduleDb.addRunResult.mockResolvedValue(undefined);
    mockScheduleDb.getScheduleById.mockResolvedValue(baseSchedule);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([]);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined);
  });

  it('recovers passed:true and the real actualFunctionCalls when the required call already ran and persisted before the exception', async () => {
    // The turn that made the required call already landed in the session (incremental
    // persistence) before a LATER step (e.g. title generation) hit the worker-drain error.
    mockChatbotDb.getChatSession.mockResolvedValue({
      ...mockSession,
      messages: [
        { role: 'user', content: 'Please run the report.' },
        {
          role: 'assistant',
          content: 'Fetching marketing tips.',
          metadata: { toolCalls: [{ id: 'c1', name: 'get_marketing_tips', arguments: {} }] },
        },
      ],
    } as any);
    mockWorker.runInWorker.mockRejectedValue(new Error('Worker is draining — no new requests accepted'));

    const result = await runScheduledChat(baseSchedule as any, mockUserId, true);

    expect(result.passed).toBe(true);
    expect(result.actualFunctionCalls).toEqual(['get_marketing_tips']);
    expect(result.functionCallMatches).toEqual(['get_marketing_tips']);
    expect(result.functionCallMisses).toEqual([]);

    // And the PERSISTED record (not just the returned value) carries the same recovery.
    const stored = (mockScheduleDb.addRunResult as jest.Mock).mock.calls[0][1];
    expect(stored.passed).toBe(true);
    expect(stored.actualFunctionCalls).toEqual(['get_marketing_tips']);
    expect(stored.functionCallMisses).toEqual([]);
  });

  it('still reports passed:false with an empty ledger when genuinely nothing happened before the exception (no false positive)', async () => {
    // No tool-call messages at all in the session — a real, total failure. The fix must not
    // flip this to passed:true just because there is nothing to miss.
    mockChatbotDb.getChatSession.mockResolvedValue({
      ...mockSession,
      messages: [{ role: 'user', content: 'Please run the report.' }],
    } as any);
    mockWorker.runInWorker.mockRejectedValue(new Error('LLM provider error'));

    const result = await runScheduledChat(baseSchedule as any, mockUserId, true);

    expect(result.passed).toBe(false);
    expect(result.actualFunctionCalls).toEqual([]);
    expect(result.functionCallMisses).toEqual(['get_marketing_tips']);
  });

  it('gives correct partial credit when only SOME of the required calls ran before the exception', async () => {
    const twoRequirementSchedule = { ...baseSchedule, requiredFunctionCalls: ['get_marketing_tips', 'analyze_competitors'] };
    mockScheduleDb.getScheduleById.mockResolvedValue(twoRequirementSchedule);
    mockChatbotDb.getChatSession.mockResolvedValue({
      ...mockSession,
      messages: [
        { role: 'user', content: 'Please run the report.' },
        {
          role: 'assistant',
          content: 'Fetching marketing tips.',
          metadata: { toolCalls: [{ id: 'c1', name: 'get_marketing_tips', arguments: {} }] },
        },
      ],
    } as any);
    mockWorker.runInWorker.mockRejectedValue(new Error('Worker is draining — no new requests accepted'));

    const result = await runScheduledChat(twoRequirementSchedule as any, mockUserId, true);

    // Not fully passed — one requirement is genuinely still missing.
    expect(result.passed).toBe(false);
    expect(result.actualFunctionCalls).toEqual(['get_marketing_tips']);
    expect(result.functionCallMatches).toEqual(['get_marketing_tips']);
    expect(result.functionCallMisses).toEqual(['analyze_competitors']);
  });

  it('does not call getChatSession (and stays passed:false/empty) when the run failed before a session even existed', async () => {
    mockChatbotDb.createChatSession.mockRejectedValue(new Error('DynamoDB throttled'));

    const result = await runScheduledChat(baseSchedule as any, mockUserId, true);

    expect(mockChatbotDb.getChatSession).not.toHaveBeenCalled();
    expect(result.passed).toBe(false);
    expect(result.actualFunctionCalls).toEqual([]);
    expect(result.functionCallMisses).toEqual(['get_marketing_tips']);
  });

  it('recovers passed:true on a schedule with ZERO required function calls, guarded on genuine recovered activity (not vacuously true)', async () => {
    const noRequirementsSchedule = { ...baseSchedule, requiredFunctionCalls: [], keywords: [] };
    mockScheduleDb.getScheduleById.mockResolvedValue(noRequirementsSchedule);
    mockChatbotDb.getChatSession.mockResolvedValue({
      ...mockSession,
      messages: [
        { role: 'user', content: 'Please run the report.' },
        {
          role: 'assistant',
          content: 'Fetching marketing tips.',
          metadata: { toolCalls: [{ id: 'c1', name: 'get_marketing_tips', arguments: {} }] },
        },
      ],
    } as any);
    mockWorker.runInWorker.mockRejectedValue(new Error('Worker is draining — no new requests accepted'));

    const result = await runScheduledChat(noRequirementsSchedule as any, mockUserId, true);

    // Nothing was REQUIRED, but real activity WAS recovered — the guard's intended pass.
    expect(result.passed).toBe(true);
    expect(result.actualFunctionCalls).toEqual(['get_marketing_tips']);
  });

  it('does not flip passed:true on a bare schedule (nothing required, nothing recovered) — the vacuous case the guard exists to reject', async () => {
    const noRequirementsSchedule = { ...baseSchedule, requiredFunctionCalls: [], keywords: [] };
    mockScheduleDb.getScheduleById.mockResolvedValue(noRequirementsSchedule);
    mockChatbotDb.getChatSession.mockResolvedValue({
      ...mockSession,
      messages: [{ role: 'user', content: 'Please run the report.' }],
    } as any);
    mockWorker.runInWorker.mockRejectedValue(new Error('LLM provider error'));

    const result = await runScheduledChat(noRequirementsSchedule as any, mockUserId, true);

    expect(result.passed).toBe(false);
  });

  it('recovers keywordMatches/keywordMisses from the real recovered content instead of leaving keywordMisses hardcoded to every configured keyword', async () => {
    const keywordSchedule = { ...baseSchedule, keywords: ['tips', 'strategy'] };
    mockScheduleDb.getScheduleById.mockResolvedValue(keywordSchedule);
    mockChatbotDb.getChatSession.mockResolvedValue({
      ...mockSession,
      messages: [
        { role: 'user', content: 'Please run the report.' },
        {
          role: 'assistant',
          content: 'Here are some great marketing tips for your business.',
          metadata: { toolCalls: [{ id: 'c1', name: 'get_marketing_tips', arguments: {} }] },
        },
      ],
    } as any);
    mockWorker.runInWorker.mockRejectedValue(new Error('Worker is draining — no new requests accepted'));

    const result = await runScheduledChat(keywordSchedule as any, mockUserId, true);

    // "tips" appears in the recovered content, "strategy" does not — must NOT be
    // reported as a self-contradicting passed:true next to keywordMisses:[all].
    expect(result.keywordMatches).toEqual(['tips']);
    expect(result.keywordMisses).toEqual(['strategy']);
    expect(result.passed).toBe(false);
  });

  it('recovers passed:true only once BOTH the function-call and keyword requirements are satisfied by recovered evidence', async () => {
    const keywordSchedule = { ...baseSchedule, keywords: ['tips'] };
    mockScheduleDb.getScheduleById.mockResolvedValue(keywordSchedule);
    mockChatbotDb.getChatSession.mockResolvedValue({
      ...mockSession,
      messages: [
        { role: 'user', content: 'Please run the report.' },
        {
          role: 'assistant',
          content: 'Here are some great marketing tips for your business.',
          metadata: { toolCalls: [{ id: 'c1', name: 'get_marketing_tips', arguments: {} }] },
        },
      ],
    } as any);
    mockWorker.runInWorker.mockRejectedValue(new Error('Worker is draining — no new requests accepted'));

    const result = await runScheduledChat(keywordSchedule as any, mockUserId, true);

    expect(result.keywordMatches).toEqual(['tips']);
    expect(result.keywordMisses).toEqual([]);
    expect(result.functionCallMisses).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('does not crash and falls back to the safe pre-fix result when the recovered session has a malformed (non-array) messages field', async () => {
    // A real-world corrupted/legacy record — messages present but not an array. The
    // recovery block must degrade to the old safe behavior, not throw a NEW error out
    // of the one place (an error handler) that must never itself crash.
    mockChatbotDb.getChatSession.mockResolvedValue({
      ...mockSession,
      messages: { notAnArray: true } as any,
    } as any);
    mockWorker.runInWorker.mockRejectedValue(new Error('Worker is draining — no new requests accepted'));

    const result = await runScheduledChat(baseSchedule as any, mockUserId, true);

    expect(result.passed).toBe(false);
    expect(result.actualFunctionCalls).toEqual([]);
    expect(result.functionCallMisses).toEqual(['get_marketing_tips']);
  });

  it('does not crash and falls back to the safe pre-fix result when getChatSession throws SYNCHRONOUSLY (not a rejected promise)', async () => {
    // The `.catch(() => null)` on getChatSession only catches a REJECTED promise — a
    // synchronous throw (e.g. a broken client that throws before ever returning a
    // promise to call .catch() on) is a genuinely different failure mode that only the
    // OUTER try/catch protects against. Review flagged that the malformed-messages test
    // above is fully absorbed by the Array.isArray guard alone and never actually drives
    // execution into the outer catch branch — this test specifically forces that branch.
    mockChatbotDb.getChatSession.mockImplementation(() => {
      throw new Error('Synchronous client failure — no promise ever returned');
    });
    mockWorker.runInWorker.mockRejectedValue(new Error('Worker is draining — no new requests accepted'));

    const result = await runScheduledChat(baseSchedule as any, mockUserId, true);

    expect(result.passed).toBe(false);
    expect(result.actualFunctionCalls).toEqual([]);
    expect(result.functionCallMisses).toEqual(['get_marketing_tips']);
  });

  it('excludes a publish-capable requirement the schedule was never authorized for from the recovered functionCallMisses, matching the success path\'s own authorization scoping', async () => {
    // requirePublishApproval:true outranks everything else in resolveSchedulePublishAuthorization
    // — an explicit, unambiguous UNAUTHORIZED, unlike the legacy opt-out default (which
    // would otherwise auto-authorize post_on_connected_account simply for being listed
    // in requiredFunctionCalls). So post_on_connected_account must be excluded from what
    // this run is even held to, the same way heldToFunctionNames excludes it on the
    // success path. Reporting it as a genuine "miss" here would falsely imply the run
    // failed to do something it was never allowed to attempt.
    const publishSchedule = {
      ...baseSchedule,
      requiredFunctionCalls: ['get_marketing_tips', 'post_on_connected_account'],
      requirePublishApproval: true,
    };
    // Otherwise the subscription-allowlist gate rejects post_on_connected_account before
    // ever reaching runInWorker or this fix's recovery code — a real, earlier, unrelated
    // short-circuit this test must get past to exercise the authorization-scoping fix.
    mockedGetAllowedFunctionCalls.mockResolvedValue(['get_marketing_tips', 'analyze_competitors', 'post_on_connected_account']);
    mockScheduleDb.getScheduleById.mockResolvedValue(publishSchedule);
    mockChatbotDb.getChatSession.mockResolvedValue({
      ...mockSession,
      messages: [
        { role: 'user', content: 'Please run the report.' },
        {
          role: 'assistant',
          content: 'Fetching marketing tips.',
          metadata: { toolCalls: [{ id: 'c1', name: 'get_marketing_tips', arguments: {} }] },
        },
      ],
    } as any);
    mockWorker.runInWorker.mockRejectedValue(new Error('Worker is draining — no new requests accepted'));

    const result = await runScheduledChat(publishSchedule as any, mockUserId, true);

    // The unauthorized publish requirement is excluded entirely — not present as a miss.
    expect(result.functionCallMisses).toEqual([]);
    expect(result.functionCallMatches).toEqual(['get_marketing_tips']);
    expect(result.passed).toBe(true);
  });
});

describe('ENG-1807 follow-up — a resumed run\'s persisted actualFunctionCalls includes the abandoned portion\'s calls', () => {
  const mockUserId = 'test-user-123';
  const mockScheduleId = 'test-schedule-123';
  const resumeSessionId = 'resume-sess-1';

  const resumeSchedule = {
    scheduleId: mockScheduleId,
    scheduleName: 'Test Schedule',
    startingMessage: 'Hello, please help me with marketing',
    keywords: [],
    requiredFunctionCalls: ['get_marketing_tips'],
    userId: mockUserId,
    pendingResumeSessionId: resumeSessionId,
  };

  const resumableMessages = [
    { role: 'system', content: 'automated run' },
    { role: 'user', content: 'Get marketing tips and summarize.' },
    { role: 'assistant', content: 'Fetching tips.', tool_calls: [{ id: 'c1', function: { name: 'get_marketing_tips' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"tips":["tip1","tip2"]}' },
  ];

  const resumeSession = {
    sessionId: resumeSessionId,
    userId: mockUserId,
    title: 'Test Session',
    messages: resumableMessages,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any;

  // The CURRENT attempt (post-resume) makes no tool calls of its own — everything required
  // already happened in the abandoned portion being resumed.
  const currentAttemptResponse = {
    content: 'Here is the summary of the marketing tips already fetched.',
    toolCalls: [],
    knowledgeBaseQueries: [],
    sources: [],
    responseMessages: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentModeService.getDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Generated Title');
    mockAgentModeService.generateScheduledChatSummary.mockResolvedValue(null);

    mockChatbotDb.createChatSession.mockResolvedValue(resumeSession);
    mockChatbotDb.getChatSession.mockResolvedValue(resumeSession);
    (mockChatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(resumableMessages);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(resumeSession);

    mockWorker.runInWorker.mockResolvedValue(currentAttemptResponse);
    mockScheduleDb.addRunResult.mockResolvedValue(undefined);
    mockScheduleDb.getScheduleById.mockResolvedValue(resumeSchedule);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([]);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined);
  });

  it('persists actualFunctionCalls including the resumed abandoned-portion call, not just the current attempt\'s (empty) calls', async () => {
    // isTest: false — the resume-claim path is gated !isTest, so this must run as a real
    // (non-test) scheduled dispatch to exercise it at all.
    const result = await runScheduledChat(resumeSchedule as any, mockUserId, false);

    expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    expect(mockScheduleDb.claimPendingResume).toHaveBeenCalledWith(mockScheduleId, resumeSessionId);
    // The verdict already correctly credited the resumed call (this was never the bug) —
    // what's under test is that the STORED raw list matches it, not just the verdict.
    expect(result.functionCallMisses).toEqual([]);
    expect(result.actualFunctionCalls).toContain('get_marketing_tips');

    const stored = (mockScheduleDb.addRunResult as jest.Mock).mock.calls[0][1];
    expect(stored.actualFunctionCalls).toContain('get_marketing_tips');
  });
});
