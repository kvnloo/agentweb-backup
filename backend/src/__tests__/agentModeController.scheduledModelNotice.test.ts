/**
 * ENG-669 PR-D: a schedule whose saved model is refused (outside the owner's plan, or no longer available) is recorded
 * as BLOCKED on its run result (runHealth.lastRunBlockedBy) and its owner is emailed once per change into that state,
 * never on every run. Behind the tier-allowlist switch: off => byte-identical to before. The mock preamble is
 * agentModeController.scheduledModelUnavailable.test.ts's.
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
    getModelDisplayName: jest.fn((id: string) => (id === 'gpt-5.5' ? 'GPT-5.5' : undefined)),
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
    sendScheduledRunFailedEmail: jest.fn().mockResolvedValue(undefined),
    sendScheduleSourcingBlockTransitionEmail: jest.fn().mockResolvedValue(undefined),
    sendOncallAlert: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(async () => ({
    allowed: true, warning: false, used: 0, allowance: 1000000,
    bonus: 0, effectiveAllowance: 1000000, percentUsed: 0, month: '2026-07',
  })),
  deriveBlockedByCost: jest.fn(() => ({ blockedByCost: false })),
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
import { computeScheduleRunHealth, didSourcingBlockStateChange, runScheduledChat } from '../controllers/agentModeController';
import { emailService } from '../services/emailService';
import { modelAccess } from '../services/agentMode/modelAccessInstance';
import { checkTokenUsage } from '../services/tokenUsageService';

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

const mockFailedEmail = emailService.sendScheduledRunFailedEmail as jest.Mock;
const mockSourcingEmail = emailService.sendScheduleSourcingBlockTransitionEmail as jest.Mock;

/** The schedule's stored run history: addRunResult appends to it and getScheduleById reads it back. */
let history: any[];
let stored: any;
const useStoredSchedule = (schedule: any) => {
  stored = { ...schedule };
  history = [];
  mockScheduleDb.addRunResult.mockImplementation(async (_id: string, result: any) => { history.push(result); return undefined as any; });
  (mockScheduleDb.getScheduleById as jest.Mock).mockImplementation(async () => ({ ...stored, runResults: [...history] }));
};
/** One cron fire of the stored schedule, with the run history as of now. */
const fire = async (runId: string, overrides: Record<string, unknown> = {}, isTest = false) => {
  Object.assign(stored, overrides);
  const result: any = await runScheduledChat({ ...stored, runResults: [...history] }, USER, isTest, runId);
  await flushAsync();
  return result;
};
const enableAllowlist = () => {
  mockSettings.model_tier_allowlist_enabled = 'true';
  mockSettings.subscription_types = JSON.stringify([{ name: 'Free', allowedModels: ['legacy-target'] }, { name: 'Pro' }]);
};

describe('switch on: the block is recorded and the owner is told once', () => {
  beforeEach(enableAllowlist);

  it("a pin outside the plan: blockedBy on the run, runHealth shows it, the owner gets the model notice, nobody is paged", async () => {
    useStoredSchedule({ ...baseSchedule, llmModel: 'gpt-5.5' });
    const result = await fire('run-1');

    expect(result).toMatchObject({
      status: 'failure', blockedBy: 'model_unavailable', blockedReason: 'not_in_plan', blockedModel: 'gpt-5.5',
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ blockedBy: 'model_unavailable', blockedReason: 'not_in_plan', blockedModel: 'gpt-5.5' });
    expect(computeScheduleRunHealth(history)).toMatchObject({
      lastRunStatus: 'failure', lastRunBlockedBy: 'model_unavailable', lastRunBlockedReason: 'not_in_plan',
      lastRunBlockedModel: 'gpt-5.5',
    });

    expect(mockFailedEmail).toHaveBeenCalledTimes(1);
    expect(mockFailedEmail).toHaveBeenCalledWith(['o@example.com'], 'FL Schedule', 'sched-fl', {
      failureClass: 'model_unavailable', modelLabel: 'GPT-5.5', reason: 'not_in_plan', upgradeRequired: ['Pro'],
    });
    expect(mockAlert).not.toHaveBeenCalled();
    expectNothingRan();
  });

  it('an hourly schedule blocked for a day sends ONE email, not one per run', async () => {
    useStoredSchedule({ ...baseSchedule, frequency: 'hourly', llmModel: 'gpt-5.5' });
    for (let i = 0; i < 24; i++) await fire(`run-h-${i}`);
    expect(history).toHaveLength(24);
    expect(history.every((r) => r.blockedBy === 'model_unavailable')).toBe(true);
    expect(mockFailedEmail).toHaveBeenCalledTimes(1);
  });

  it('a run that succeeds in between resets the state: the next block emails again', async () => {
    useStoredSchedule({ ...baseSchedule, llmModel: 'gpt-5.5' });
    await fire('run-r-1');
    await fire('run-r-2');
    expect(mockFailedEmail).toHaveBeenCalledTimes(1);

    // The owner unpins the schedule (it runs the scheduled default): the run goes ahead and is not blocked.
    const ok = await fire('run-r-3', { llmModel: '' });
    expect(ok.status).not.toBe('failure');
    expect(ok.blockedBy).toBeUndefined();
    expect(computeScheduleRunHealth(history).lastRunBlockedBy).toBeNull();

    // ...and later pins the out-of-plan model again: a new block, a new email.
    await fire('run-r-4', { llmModel: 'gpt-5.5' });
    expect(mockFailedEmail).toHaveBeenCalledTimes(2);
  });

  it('a pin change to another refused model is a new state: emailed again, then quiet again', async () => {
    useStoredSchedule({ ...baseSchedule, llmModel: 'gpt-5.5' });
    await fire('run-p-1');
    await fire('run-p-2', { llmModel: 'internal-judge-1' });
    await fire('run-p-3');
    expect(mockFailedEmail).toHaveBeenCalledTimes(2);
    expect(mockFailedEmail.mock.calls[1][3]).toEqual({ failureClass: 'model_unavailable', modelLabel: 'internal-judge-1', reason: 'not_selectable', upgradeRequired: [] });
    expect(history[1]).toMatchObject({ blockedReason: 'not_selectable', blockedModel: 'internal-judge-1' });
  });

  it('a model that is no longer served is the same owner-actionable block, and still pages on-call as before', async () => {
    useStoredSchedule({ ...baseSchedule, llmModel: 'retired-model-9' });
    const result = await fire('run-ns-1');
    expect(result).toMatchObject({ blockedBy: 'model_unavailable', blockedReason: 'not_served', blockedModel: 'retired-model-9' });
    expect(mockFailedEmail).toHaveBeenCalledWith(['o@example.com'], 'FL Schedule', 'sched-fl', {
      failureClass: 'model_unavailable', modelLabel: 'retired-model-9', reason: 'not_served', upgradeRequired: [],
    });
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockAlert.mock.calls[0][0].subject).toBe('AgentMode: unsupported model pinned on a scheduled chat');
  });

  it('a TEST run records the block but emails nobody (the owner is watching it)', async () => {
    useStoredSchedule({ ...baseSchedule, llmModel: 'gpt-5.5' });
    const result = await fire('run-t-1', {}, true);
    expect(result.blockedBy).toBe('model_unavailable');
    expect(mockFailedEmail).not.toHaveBeenCalled();
  });

  it('#3676 follow-up 3: a TEST run as the first blocked run does not silence the next cron run\'s email', async () => {
    useStoredSchedule({ ...baseSchedule, llmModel: 'gpt-5.5' });
    await fire('run-tc-1', {}, true);
    expect(history[0]).toMatchObject({ blockedBy: 'model_unavailable', testRun: true });
    expect(mockFailedEmail).not.toHaveBeenCalled();
    await fire('run-tc-2');
    expect(mockFailedEmail).toHaveBeenCalledTimes(1);
    // ...and only that once: the cron block is the episode now, a later Test click does not restart it.
    await fire('run-tc-3', {}, true);
    await fire('run-tc-4');
    expect(mockFailedEmail).toHaveBeenCalledTimes(1);
    expect(history[1]).not.toHaveProperty('testRun');
  });

  it('#3676 follow-up 1: blocked, then the usage limit, then blocked again is ONE email', async () => {
    useStoredSchedule({ ...baseSchedule, llmModel: 'gpt-5.5' });
    await fire('run-u-1');
    (checkTokenUsage as jest.Mock).mockResolvedValueOnce({
      allowed: false, warning: true, used: 100, allowance: 100, bonus: 0, effectiveAllowance: 100, percentUsed: 100, month: '2026-07',
    });
    const limited = await fire('run-u-2');
    expect(limited).toMatchObject({ status: 'failure', endedBeforeModelCheck: true });
    expect(limited.blockedBy).toBeUndefined();
    await fire('run-u-3');
    expect(history).toHaveLength(3);
    expect(mockFailedEmail).toHaveBeenCalledTimes(1);
  });

  it('#3676 follow-up 4: the email goes out only once the blocked run is saved, so a failing save never re-emails', async () => {
    useStoredSchedule({ ...baseSchedule, llmModel: 'gpt-5.5' });
    mockScheduleDb.addRunResult.mockRejectedValue(new Error('dynamo down'));
    for (let i = 0; i < 3; i++) await fire(`run-s-${i}`);
    expect(mockFailedEmail).not.toHaveBeenCalled();
    // The save recovers: this run is the first block on record, so it (and only it) emails.
    mockScheduleDb.addRunResult.mockImplementation(async (_id: string, result: any) => { history.push(result); return undefined as any; });
    await fire('run-s-3');
    await fire('run-s-4');
    expect(mockFailedEmail).toHaveBeenCalledTimes(1);
  });

  it('#3676 follow-up 5: no tier includes the model: upgradeRequired is empty and the run result does not suggest upgrading', async () => {
    mockSettings.subscription_types = JSON.stringify([{ name: 'Free', allowedModels: ['legacy-target'] }, { name: 'Pro', allowedModels: ['legacy-target'] }]);
    useStoredSchedule({ ...baseSchedule, llmModel: 'gpt-5.5' });
    const result = await fire('run-ur-1');
    expect(result.blockedReason).toBe('not_in_plan');
    expect(result.actualResponse).not.toMatch(/upgrade/i);
    expect(mockFailedEmail.mock.calls[0][3]).toMatchObject({ reason: 'not_in_plan', upgradeRequired: [] });
  });

  it("follows the schedule's recipients: its notification list, and nobody when the owner opted out", async () => {
    useStoredSchedule({ ...baseSchedule, llmModel: 'gpt-5.5', emailNotifications: ['team@example.com'] });
    await fire('run-e-1');
    expect(mockFailedEmail.mock.calls[0][0]).toEqual(['team@example.com']);

    mockFailedEmail.mockClear();
    useStoredSchedule({ ...baseSchedule, llmModel: 'gpt-5.5', emailOptOut: true });
    await fire('run-e-2');
    expect(mockFailedEmail).not.toHaveBeenCalled();
  });

  it('a failed history re-read falls back to the history the run started with', async () => {
    useStoredSchedule({ ...baseSchedule, llmModel: 'gpt-5.5' });
    await fire('run-f-1');
    (mockScheduleDb.getScheduleById as jest.Mock).mockRejectedValue(new Error('dynamo down'));
    await fire('run-f-2');
    expect(mockFailedEmail).toHaveBeenCalledTimes(1);
  });

  it('a model-blocked run never reached sourcing: it does not end or start a LinkedIn sourcing block', async () => {
    const sourcingBlocked = { status: 'success', blockedBy: 'linkedin_search_unavailable', createdAt: '2026-07-01T00:00:00.000Z' };
    const modelBlocked = { status: 'failure', blockedBy: 'model_unavailable', blockedReason: 'not_in_plan', blockedModel: 'gpt-5.5', createdAt: '2026-07-02T00:00:00.000Z' };
    // still blocked after the model block: no "blocked" email again
    expect(didSourcingBlockStateChange([sourcingBlocked, modelBlocked], 'linkedin_search_unavailable')).toBe(false);
    // recovered after the model block: the recovery is still reported
    expect(didSourcingBlockStateChange([sourcingBlocked, modelBlocked], null)).toBe(true);
    // a healthy run after only model blocks is not a "recovered" transition
    expect(didSourcingBlockStateChange([modelBlocked], null)).toBe(false);
    expect(mockSourcingEmail).not.toHaveBeenCalled();
  });
});

describe('switch off: byte-identical to before', () => {
  const MAIN_RESULT_KEYS = [
    'actualFunctionCalls', 'actualResponse', 'attempt', 'createdAt', 'executionTime', 'functionCallMatches', 'functionCallMisses',
    'keywordMatches', 'keywordMisses', 'passed', 'runId', 'scheduleId', 'sessionId', 'status',
  ];

  it('an unserved pin: the same run result keys as main, no block fields, no notice, no history re-read; on-call paged as before', async () => {
    useStoredSchedule({ ...baseSchedule, llmModel: 'retired-model-9' });
    for (let i = 0; i < 3; i++) await fire(`run-off-${i}`);
    expect(Object.keys(history[0]).sort()).toEqual(MAIN_RESULT_KEYS);
    expect(history.some((r) => 'blockedBy' in r || 'blockedReason' in r || 'blockedModel' in r)).toBe(false);
    expect(computeScheduleRunHealth(history)).toEqual({
      lastRunStatus: 'failure', lastRunAt: history[2].createdAt, consecutiveFailures: 3, lastRunBlockedBy: null,
    });
    expect(mockFailedEmail).not.toHaveBeenCalled();
    expect(mockScheduleDb.getScheduleById).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledTimes(3);
  });
});
