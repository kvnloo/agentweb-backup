/**
 * FAIL-LOUD selected model, scheduled path (WP-G). A schedule that pins a model which
 * is not served must NOT run on another model: runScheduledChat RETURNS a failed result
 * (no throw, so no zero-output requeue with a false "will be retried" message) BEFORE
 * the resume claim, the pre-check gate and session creation. The mock preamble is
 * lifted from agentModeController.capacityGate.test.ts.
 */

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsWithOwnerIncludingOrgShared: jest.fn(async () => []),
  getAccountsByUserId: jest.fn(async () => []),
}));

jest.mock('../services/unipileSentInvitationsDb', () => ({
  countSentInvitationsByAccount: jest.fn(async () => 0),
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => ['get_marketing_tips', 'linkedin_outreach']),
  getAllowedSkills: jest.fn(async () => ['*']),
  isSubscriptionFeatureEnabled: jest.fn(async () => true),
  // ENG-669: the owner's tier for the model allowlist (Free lists only the default here).
  getUserSubscriptionResolution: jest.fn(async () => ({ subscriptionType: 'Free', resolved: true })),
  // 'legacy-target' only: 'gpt-5-chat-2' is a real legacy alias of 'gpt-5.5', so listing it would allow gpt-5.5.
  readTierAllowedModels: jest.fn(async () => ({ configured: true, allowedModels: ['legacy-target'] })),
}));
// ENG-669: AW-Settings rows by name; the tier-allowlist switch is off unless a test sets it.
const mockSettings: Record<string, string | undefined> = {};
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(async (name: string) => (mockSettings[name] === undefined ? null : { settingName: name, settingValue: mockSettings[name] })),
  },
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
  updateTaskExecutionStatus: jest.fn(),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getScheduledChatsDefaultModel: jest.fn(),
    getSupportedModels: jest.fn(async () => ['gpt-5-chat-2', 'gpt-5.5']),
    resolveGenerationModel: jest.fn((model: string) => {
      const registry = new Set(['gpt-5-chat-2', 'gpt-5.5', 'internal-judge-1', 'legacy-target']);
      const normalized = model === 'legacy-alias' ? 'legacy-target' : model;
      return registry.has(normalized)
        ? { model: normalized, fellBack: false, requestedModel: model }
        : { model: 'gpt-5-chat-2', fellBack: true, requestedModel: model };
    }),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    generateScheduledChatSummary: jest.fn(),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set([])),
    getAdminToolNames: jest.fn().mockReturnValue([]),
  },
}));

jest.mock('../services/llmUsagePolicyResolverService', () => ({
  getEffectiveLlmUsagePolicy: jest.fn(),
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
    updateSchedule: jest.fn(),
    claimPendingResume: jest.fn(),
    setRunInFlight: jest.fn().mockResolvedValue('acquired'),
    attachSessionToRunInFlight: jest.fn().mockResolvedValue(true),
    heartbeatRunInFlight: jest.fn().mockResolvedValue(undefined),
    clearRunInFlight: jest.fn().mockResolvedValue(true),
  },
  userDb: { getUserById: jest.fn() },
  taskDb: {},
  scheduleTemplateDb: {},
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendScheduledChatResultEmail: jest.fn(),
    sendScheduledChatErrorEmail: jest.fn(),
    sendScheduledChatTokenLimitEmail: jest.fn(),
    sendScheduledChatVariableRequestEmail: jest.fn(),
    sendOncallAlert: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(async () => ({
    allowed: true, warning: false, used: 0, allowance: 1000000,
    bonus: 0, effectiveAllowance: 1000000, percentUsed: 0, month: '2026-07',
  })),
}));

jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/intakeService', () => ({
  fileAutoIssue: jest.fn().mockResolvedValue({ pageId: 'ENG-1', deduped: false, tracker: 'Linear' }),
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getInstalledSkills: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../services/workPlanService', () => ({
  workPlanService: { getWorkPlan: jest.fn().mockResolvedValue(null) },
}));

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

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb, userDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import { getEffectiveLlmUsagePolicy } from '../services/llmUsagePolicyResolverService';
import { runScheduledChat } from '../controllers/agentModeController';
import { modelAccess } from '../services/agentMode/modelAccessInstance';
import { agentWebModelRouter } from '../services/agentMode/agentWebModelRouterInstance';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockAlert = sendAgentModeOncallAlert as jest.Mock;
const mockPolicy = getEffectiveLlmUsagePolicy as jest.Mock;

const USER = 'user-fl';
const fireTime = '2026-07-15T10:00:00.000Z';
const baseSchedule = {
  scheduleId: 'sched-fl',
  scheduleName: 'FL Schedule',
  startingMessage: 'Do the thing',
  keywords: [] as string[],
  requiredFunctionCalls: [] as string[],
  userId: USER,
  frequency: 'daily',
  nextRunTime: fireTime,
};
const mockSession = { sessionId: 'session-fl', userId: USER, title: 'S', messages: [], createdAt: fireTime, updatedAt: fireTime };
const okResponse = { content: 'Done.', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] };
const FULL_CHOICE = { usageMode: 'full_choice', admissionAllowed: true, reason: 'policy_not_enforced' };
const flushAsync = async (rounds = 20) => { for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockSettings)) delete mockSettings[key];
  modelAccess.reset();
  mockPolicy.mockResolvedValue({ billingUserId: USER, policy: null, costUsedMicroUsd: 0, tokenUsed: 0, mode: FULL_CHOICE });
  mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
  (mockAgentModeService as any).getScheduledChatsDefaultModel.mockResolvedValue('gpt-5-chat-2');
  mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
  mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');
  (mockAgentModeService as any).generateScheduledChatSummary.mockResolvedValue(null);
  mockChatbotDb.createChatSession.mockResolvedValue(mockSession as any);
  mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
  (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([{ role: 'assistant', content: 'Done.' }]);
  mockChatbotDb.addMessageToSession.mockResolvedValue(mockSession as any);
  mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
  mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
  mockChatbotDb.updateSessionLlmModel.mockResolvedValue(mockSession as any);
  (mockChatbotDb as any).updateSessionError.mockResolvedValue(undefined);
  mockWorker.runInWorker.mockResolvedValue(okResponse as any);
  mockScheduleDb.addRunResult.mockResolvedValue(undefined as any);
  mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined as any);
  mockScheduleDb.updateSchedule.mockResolvedValue(undefined as any);
  mockUserDb.getUserById.mockResolvedValue({ userId: USER, email: 'o@example.com' } as any);
});

const expectNothingRan = () => {
  expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
  expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
  expect(mockWorker.runInWorker).not.toHaveBeenCalled();
  expect(mockScheduleDb.claimPendingResume).not.toHaveBeenCalled();
  // No requeue: nothing pushed nextRunTime / retry counters.
  for (const call of mockScheduleDb.updateSchedule.mock.calls) {
    expect(call[1]).not.toHaveProperty('nextRunTime');
    expect(call[1]).not.toHaveProperty('zeroAssistantRetryCount');
  }
  expect(mockScheduleDb.clearRunInFlight).toHaveBeenCalled();
};

describe('runScheduledChat: pinned unserved model fails loud (WP-G)', () => {
  it('returns a stored failure, creates no session, does not requeue, releases the lease, alerts once', async () => {
    const result: any = await runScheduledChat({ ...baseSchedule, llmModel: 'retired-model-9' }, USER, false, 'run-fl-1');
    await flushAsync();

    expect(result).toMatchObject({ status: 'failure', passed: false, sessionId: '', runId: 'run-fl-1' });
    expect(result.actualResponse).toBe(
      'model_unavailable: pinned model "retired-model-9" is not served — choose a served model for this schedule',
    );
    // The text is stored in full (the catch path would delete actualResponse).
    expect(mockScheduleDb.addRunResult).toHaveBeenCalledTimes(1);
    expect(mockScheduleDb.addRunResult).toHaveBeenCalledWith(
      baseSchedule.scheduleId,
      expect.objectContaining({ actualResponse: result.actualResponse, status: 'failure' }),
    );
    expectNothingRan();

    expect(mockAlert).toHaveBeenCalledTimes(1);
    const alert = mockAlert.mock.calls[0][0];
    expect(alert.subject).toBe('AgentMode: unsupported model pinned on a scheduled chat');
    expect(alert.dedupeKey).toBe('schedule_model_invalid:sched-fl:retired-model-9');
    expect(alert.message).toContain('FAILED');
    expect(alert.message).toContain('nothing ran');
    expect(JSON.stringify(alert)).not.toContain('Actually Used');
  });

  it('a registry id outside the supported set (internalOnly) fails the same way', async () => {
    const result: any = await runScheduledChat({ ...baseSchedule, llmModel: 'internal-judge-1' }, USER, false, 'run-fl-2');
    await flushAsync();
    expect(result.status).toBe('failure');
    expect(result.actualResponse).toBe(
      'model_unavailable: pinned model "internal-judge-1" is not selectable — choose a served model for this schedule',
    );
    expectNothingRan();
  });

  it('a TEST run behaves identically', async () => {
    const result: any = await runScheduledChat({ ...baseSchedule, llmModel: 'retired-model-9' }, USER, true, 'run-fl-test');
    await flushAsync();
    expect(result).toMatchObject({ status: 'failure', sessionId: '', runId: 'run-fl-test' });
    expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    expect(mockScheduleDb.addRunResult).toHaveBeenCalledTimes(1);
  });

  it('does NOT consume a pending resume marker', async () => {
    const result: any = await runScheduledChat(
      { ...baseSchedule, llmModel: 'retired-model-9', pendingResumeSessionId: 'abandoned-1' }, USER, false, 'run-fl-resume',
    );
    await flushAsync();
    expect(result.status).toBe('failure');
    expect(mockScheduleDb.claimPendingResume).not.toHaveBeenCalled();
    expect(mockChatbotDb.getChatSession).not.toHaveBeenCalledWith('abandoned-1');
    expectNothingRan();
  });

  it('sanitizes the pinned id in the stored text', async () => {
    const result: any = await runScheduledChat({ ...baseSchedule, llmModel: 'bad\u0000\nmodel' }, USER, false, 'run-fl-3');
    await flushAsync();
    expect(result.actualResponse).toBe(
      'model_unavailable: pinned model "badmodel" is not served — choose a served model for this schedule',
    );
  });
});

describe('runScheduledChat: unchanged cases (WP-G)', () => {
  it('a served pin runs on exactly that model', async () => {
    const result: any = await runScheduledChat({ ...baseSchedule, llmModel: 'gpt-5.5' }, USER, false, 'run-ok-1');
    await flushAsync();
    expect(result.status).not.toBe('failure');
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: 'gpt-5.5' }), expect.anything());
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith('session-fl', 'gpt-5.5', expect.anything(), 'user');
    expect(mockAlert).not.toHaveBeenCalledWith(expect.objectContaining({ subject: 'AgentMode: unsupported model pinned on a scheduled chat' }));
  });

  it('a valid legacy alias pin still runs (forward-renamed, no failure)', async () => {
    (mockAgentModeService.getSupportedModels as jest.Mock).mockResolvedValue(['gpt-5-chat-2', 'legacy-target']);
    const result: any = await runScheduledChat({ ...baseSchedule, llmModel: 'legacy-alias' }, USER, false, 'run-alias');
    await flushAsync();
    expect(result.status).not.toBe('failure');
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: 'legacy-target' }), expect.anything());
    (mockAgentModeService.getSupportedModels as jest.Mock).mockResolvedValue(['gpt-5-chat-2', 'gpt-5.5']);
  });

  it('an UNPINNED schedule uses the scheduled default, even if the default is unserved (alert-only swap)', async () => {
    (mockAgentModeService as any).getScheduledChatsDefaultModel.mockResolvedValue('retired-default-1');
    const result: any = await runScheduledChat({ ...baseSchedule }, USER, false, 'run-unpinned');
    await flushAsync();
    expect(result.status).not.toBe('failure');
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: 'gpt-5-chat-2' }), expect.anything());
    expect(mockAlert).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'schedule_model_invalid:sched-fl:retired-default-1',
    }));
  });

  it('a whitespace-only pin behaves like NO pin (runs on the default, no model_unavailable failure)', async () => {
    const result: any = await runScheduledChat({ ...baseSchedule, llmModel: '   ' }, USER, false, 'run-blank-pin');
    await flushAsync();
    expect(result.status).not.toBe('failure');
    expect(String(result.actualResponse || '')).not.toContain('model_unavailable');
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: 'gpt-5-chat-2' }), expect.anything());
  });

  it('a paused account still ends via the usage_paused path (not a model_unavailable failure)', async () => {
    mockPolicy.mockResolvedValue({
      billingUserId: USER, policy: null, costUsedMicroUsd: 0, tokenUsed: 0,
      mode: { usageMode: 'paused', admissionAllowed: false, reason: 'hard_threshold_reached' },
    });
    const result: any = await runScheduledChat({ ...baseSchedule, llmModel: 'retired-model-9' }, USER, false, 'run-paused');
    await flushAsync();
    expect(result.actualResponse ?? '').not.toContain('model_unavailable');
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalledWith(expect.objectContaining({ subject: 'AgentMode: unsupported model pinned on a scheduled chat' }));
  });
});

/**
 * ENG-669 (review MAJOR 2): with the tier allowlist on, the owner's own pin must be in the owner's plan (a visible
 * failed run, no page), while a pin inherited from an admin-authored schedule template (llmModelSource 'system') is
 * AgentWeb's choice and runs.
 */
describe('runScheduledChat: tier model allowlist (ENG-669)', () => {
  beforeEach(() => {
    mockSettings.model_tier_allowlist_enabled = 'true';
    mockSettings.subscription_types = JSON.stringify([{ name: 'Free', allowedModels: ['legacy-target'] }, { name: 'Pro' }]);
  });

  it("the owner's pin outside the plan fails the run visibly, runs nothing, and does not page on-call", async () => {
    const result: any = await runScheduledChat({ ...baseSchedule, llmModel: 'gpt-5.5' }, USER, false, 'run-tier-1');
    await flushAsync();
    expect(result).toMatchObject({ status: 'failure', passed: false });
    expect(result.actualResponse).toBe(
      'model_unavailable: pinned model "gpt-5.5" is not included in the account\'s plan — choose a model your plan includes for this schedule, or upgrade the plan',
    );
    expectNothingRan();
    expect(mockAlert).not.toHaveBeenCalledWith(expect.objectContaining({ subject: 'AgentMode: unsupported model pinned on a scheduled chat' }));
  });

  it('a pin inherited from an admin-authored template (llmModelSource system) runs, stamped as a system model', async () => {
    const result: any = await runScheduledChat({ ...baseSchedule, llmModel: 'gpt-5.5', llmModelSource: 'system' } as any, USER, false, 'run-tier-2');
    await flushAsync();
    expect(result.status).not.toBe('failure');
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: 'gpt-5.5' }), expect.anything());
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith('session-fl', 'gpt-5.5', expect.anything(), 'system');
  });
});

/**
 * ENG-669 PR-C: a schedule pinned to the AgentWeb Model routes as a SCHEDULED task, runs the routed model, and the
 * run's session keeps the selection (with the routed decision). Switch off: the pin is an unknown model, as before.
 */
describe('runScheduledChat: AgentWeb Model pin (ENG-669 PR-C)', () => {
  beforeEach(() => agentWebModelRouter.reset());

  it('switch on: runs the scheduled route and stores the selection, not the routed model', async () => {
    mockSettings.agentweb_model_router_enabled = 'true';
    mockSettings.agentweb_model_routing_table = JSON.stringify({ version: 't1', default: 'gpt-5.5', routes: { scheduled: 'gpt-5.5' } });
    const result: any = await runScheduledChat({ ...baseSchedule, llmModel: 'agentweb-model' }, USER, false, 'run-aw-1');
    await flushAsync();
    expect(result.status).not.toBe('failure');
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: 'gpt-5.5' }), expect.anything());
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith('session-fl', 'agentweb-model', expect.objectContaining({
      requestedModel: 'agentweb-model', effectiveModel: 'gpt-5.5', routedVia: 'agentweb-model', routingReason: 'scheduled task: table route', tableVersion: 't1',
    }), 'user');
    expect(mockChatbotDb.updateSessionLlmModel.mock.calls.map((c) => c[1])).not.toContain('gpt-5.5');
  });

  it('switch off: the pin fails the run visibly, naming the AgentWeb Model; nothing runs, nobody is paged', async () => {
    const result: any = await runScheduledChat({ ...baseSchedule, llmModel: 'agentweb-model' }, USER, false, 'run-aw-2');
    await flushAsync();
    expect(result).toMatchObject({ status: 'failure', passed: false });
    expect(result.actualResponse).toBe(
      'model_unavailable: AgentWeb Model is unavailable right now — choose another model for this schedule, or try again later',
    );
    expectNothingRan();
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('one broken routing table and three pinned schedules: exactly ONE on-call alert (the router\'s), no per-schedule pages', async () => {
    mockSettings.agentweb_model_router_enabled = 'true';
    mockSettings.agentweb_model_routing_table = '{not json';
    for (const id of ['s1', 's2', 's3']) {
      const result: any = await runScheduledChat({ ...baseSchedule, scheduleId: id, llmModel: 'agentweb-model' }, USER, false, `run-${id}`);
      expect(result.status).toBe('failure');
      expect(result.actualResponse).toContain('AgentWeb Model is unavailable right now');
    }
    await flushAsync();
    expect(mockAlert.mock.calls.map(([a]) => a.dedupeKey)).toEqual(['agentweb_model_router:unavailable']);
  });
});
