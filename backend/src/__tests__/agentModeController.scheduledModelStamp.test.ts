/**
 * runScheduledChat — the session records the model that will actually run (ENG-892).
 *
 * The scheduled path stamps `session.llmModel` from `schedule.llmModel`, which is
 * written straight from an admin request body with no allow-list check
 * (adminScheduleTemplateRoutes.ts:89/:130, admin.ts:5118). That write is an
 * internal db call, so it bypasses the validation on the picker endpoints.
 *
 * An unserved id therefore got stamped on every run while generation quietly fell
 * back to a different model — reproducing the ENG-892 mismatch on exactly the
 * sessions the daily reports analyse. Resolve before stamping so the stored field
 * agrees with what generation resolves to (agentModeService.ts:2913).
 */
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => []),
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
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

const REGISTRY = ['gpt-5-chat-2', 'anthropic.claude-opus-4-8', 'anthropic.claude-opus-5'];
const ALIASES: Record<string, string> = { 'claude-opus-4-8': 'anthropic.claude-opus-4-8' };
const FALLBACK = 'gpt-5-chat-2';

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getScheduledChatsDefaultModel: jest.fn(),
    getSupportedModels: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    generateScheduledChatSummary: jest.fn(),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set(['install_skills', 'search_web'])),
    getAdminToolNames: jest.fn().mockReturnValue([]),
    // Mirrors the real resolver, including its fallback for unserved ids.
    resolveGenerationModel: jest.fn((model: string) => {
      const normalized = ALIASES[model] ?? model;
      if (normalized && REGISTRY.includes(normalized)) {
        return { model: normalized, fellBack: false, requestedModel: model };
      }
      return { model: FALLBACK, fellBack: true, requestedModel: model };
    }),
  },
}));

const mockGetSetting = jest.fn();
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: (...a: unknown[]) => mockGetSetting(...a) },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn(), releaseSessionClients: jest.fn() },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
    addRunResult: jest.fn(),
    getScheduleById: jest.fn(),
    getSchedulesReadyToRun: jest.fn(),
    updateScheduleAfterRun: jest.fn(),
    setRunInFlight: jest.fn().mockResolvedValue('acquired'),
    heartbeatRunInFlight: jest.fn().mockResolvedValue(undefined),
    clearRunInFlight: jest.fn().mockResolvedValue(true),
    getInFlightSchedules: jest.fn().mockResolvedValue([]),
    claimAbandonedRun: jest.fn().mockResolvedValue(true),
    updateSchedule: jest.fn(),
    attachSessionToRunInFlight: jest.fn().mockResolvedValue(undefined),
  },
  taskDb: {
    getTaskExecutionById: jest.fn(),
    createTaskExecution: jest.fn(),
    updateTaskExecution: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn().mockResolvedValue({ userId: 'test-user-123', email: 'owner@example.com', isAdmin: false }),
  },
}));

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-run-id-123') }));

jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendScheduledChatResultEmail: jest.fn(),
    sendDailyDigestEmail: jest.fn(),
    sendScheduledChatVariableRequestEmail: jest.fn(),
    sendScheduledChatErrorEmail: jest.fn(),
    sendScheduledChatTokenLimitEmail: jest.fn(),
    sendScheduledChatPausedForInputEmail: jest.fn(),
  },
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(async () => ({
    allowed: true, warning: false, used: 1, allowance: 1000000,
    bonus: 0, effectiveAllowance: 1000000, percentUsed: 0, month: '2026-07',
  })),
  deriveBlockedByCost: jest.fn((status: any) => ({ blockedByCost: status.usageMode === 'paused' })),
}));

jest.mock('../services/llmUsagePolicyResolverService', () => ({
  getEffectiveLlmUsagePolicy: jest.fn(),
}));

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { agentModeController, runScheduledChat } from '../controllers/agentModeController';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import { checkTokenUsage } from '../services/tokenUsageService';
import { getEffectiveLlmUsagePolicy } from '../services/llmUsagePolicyResolverService';
import { LEGACY_MODEL_ALIASES, LLM_MODEL_REGISTRY } from '../services/agentMode/llmModelRegistry';

const mockAlert = sendAgentModeOncallAlert as jest.MockedFunction<typeof sendAgentModeOncallAlert>;

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockCheckTokenUsage = checkTokenUsage as jest.MockedFunction<typeof checkTokenUsage>;
const mockGetEffectiveLlmUsagePolicy = getEffectiveLlmUsagePolicy as jest.MockedFunction<typeof getEffectiveLlmUsagePolicy>;

const SESSION_ID = 'test-session-123';

const session = {
  sessionId: SESSION_ID,
  userId: 'test-user-123',
  title: 'Scheduled: Daily report',
  sessionType: 'scheduled' as const,
  pageIdentifier: 'Scheduled: Daily report|scheduleId:sched-1',
  messages: [],
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
};

const baseSchedule = {
  scheduleId: 'sched-1',
  scheduleName: 'Daily report',
  startingMessage: 'Generate the daily report.',
  keywords: [],
  requiredFunctionCalls: [],
  userId: 'test-user-123',
  emailNotifications: [],
};

const stampedModel = () => {
  const call = mockChatbotDb.updateSessionLlmModel.mock.calls.find(([id]) => id === SESSION_ID);
  return call?.[1];
};

const stampedPolicyDecision = () => {
  const call = mockChatbotDb.updateSessionLlmModel.mock.calls.find(([id]) => id === SESSION_ID);
  return call?.[2];
};

describe('runScheduledChat — stamps the model that will actually run (ENG-892)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.createChatSession.mockResolvedValue(session as any);
    mockChatbotDb.getChatSession.mockResolvedValue(session as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(session as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(session as any);
    mockChatbotDb.addMessageToSession.mockResolvedValue(session as any);
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2' as any);
    mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue('anthropic.claude-opus-5' as any);
    mockAgentModeService.getSupportedModels.mockResolvedValue(REGISTRY as any);
    mockCheckTokenUsage.mockResolvedValue({
      allowed: true, warning: false, used: 1, allowance: 1000000,
      bonus: 0, effectiveAllowance: 1000000, percentUsed: 0, month: '2026-07',
    } as any);
    mockGetEffectiveLlmUsagePolicy.mockResolvedValue({
      billingUserId: 'test-user-123',
      policy: null,
      costUsedMicroUsd: 0,
      creditsApplied: false,
      mode: { usageMode: 'full_choice', admissionAllowed: true, reason: 'policy_not_enforced' },
    });
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt' as any);
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title' as any);
    (mockAgentModeService as any).generateScheduledChatSummary.mockResolvedValue('Summary');
    mockScheduleDb.addRunResult.mockResolvedValue(undefined as any);
    mockWorker.runInWorker.mockResolvedValue({
      content: 'Report generated.',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    } as any);
  });

  // FAIL-LOUD (WP-G): this used to assert the silent swap to the fallback. An explicit
  // pin that is not served now ends the run failed, before any session exists, so
  // nothing is stamped and nothing runs on a different model.
  it('does not run an unserved schedule model on the fallback — fails the run, nothing stamped', async () => {
    const result: any = await runScheduledChat({ ...baseSchedule, llmModel: 'claude-sonnet-4-5' } as any, 'test-user-123', false);

    expect(result.status).toBe('failure');
    expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
  });

  it('stamps the canonical id for a legacy alias, not the alias', async () => {
    await runScheduledChat({ ...baseSchedule, llmModel: 'claude-opus-4-8' } as any, 'test-user-123', false);

    expect(stampedModel()).toBe('anthropic.claude-opus-4-8');
  });

  it('leaves a valid schedule model untouched', async () => {
    await runScheduledChat({ ...baseSchedule, llmModel: 'anthropic.claude-opus-5' } as any, 'test-user-123', false);

    expect(stampedModel()).toBe('anthropic.claude-opus-5');
  });

  it('falls back to the scheduled-chats default when the schedule pins no model', async () => {
    await runScheduledChat({ ...baseSchedule } as any, 'test-user-123', false);

    expect(stampedModel()).toBe('anthropic.claude-opus-5');
  });

  // A dead pin is silent otherwise: the run succeeds on the fallback and the admin
  // UI keeps showing the model they chose. Same failure mode as ENG-806, where an
  // alias-valued AW-Settings row sat inert for two months. The settings path alerts
  // on an unserved value; the schedule path only console.warn'd.
  it('alerts when a schedule pins a model that is not served', async () => {
    await runScheduledChat({ ...baseSchedule, llmModel: 'claude-sonnet-4-5' } as any, 'test-user-123', false);

    expect(mockAlert).toHaveBeenCalledTimes(1);
    const alert = mockAlert.mock.calls[0][0];
    expect(alert.subject).toContain('unsupported');
    expect(alert.message).toContain('claude-sonnet-4-5');
    // FAIL-LOUD (WP-G): the run no longer continues on a fallback model.
    expect(alert.message).toContain('FAILED');
    expect(alert.message).not.toContain(FALLBACK);
    // Deduped per (schedule, bad value) so a daily schedule cannot flood oncall.
    expect(alert.dedupeKey).toBe('schedule_model_invalid:sched-1:claude-sonnet-4-5');
  });

  it('does not alert when the pinned model is served', async () => {
    await runScheduledChat({ ...baseSchedule, llmModel: 'anthropic.claude-opus-5' } as any, 'test-user-123', false);

    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('honors the schedule model past the former optimization threshold (ENG-1211)', async () => {
    mockGetEffectiveLlmUsagePolicy.mockResolvedValue({
      billingUserId: 'test-user-123',
      policy: {
        version: 'pro-v1',
        enforcementState: 'enforce',
        optimizationCostThresholdMicroUsd: 80_000_000,
        hardCostThresholdMicroUsd: 150_000_000,
        optimizedModelIds: ['gpt-5-chat-2'],
        optimizedDefaultModel: 'gpt-5-chat-2',
      },
      costUsedMicroUsd: 80_000_000,
      creditsApplied: false,
      mode: { usageMode: 'optimized', admissionAllowed: true, reason: 'optimization_threshold_reached' },
    });

    await runScheduledChat({
      ...baseSchedule,
      llmModel: 'anthropic.claude-opus-5',
      llmBackupModel: 'gpt-5-chat-2',
      llmBackupSource: 'user',
    } as any, 'test-user-123', false);

    // ENG-1211: the schedule's own model now runs. A user backup is no longer
    // substituted below the hard cap — that substitution is the deleted behavior.
    expect(stampedModel()).toBe('anthropic.claude-opus-5');
    expect(stampedPolicyDecision()).toEqual(expect.objectContaining({
      requestedModel: 'anthropic.claude-opus-5',
      effectiveModel: 'anthropic.claude-opus-5',
      backupModel: 'gpt-5-chat-2',
      backupSource: 'user',
      modelSelection: 'honored',
      modelSelectionReason: 'requested_model_allowed',
      usageMode: 'optimized',
      usagePolicyVersion: 'pro-v1',
      recordedAt: expect.any(String),
    }));
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(
      expect.objectContaining({ llmModel: 'anthropic.claude-opus-5' }),
      expect.any(Function),
    );
  });

  it('performs zero model dispatch when the hard cost cap is reached', async () => {
    mockCheckTokenUsage.mockResolvedValue({
      allowed: false, warning: true, used: 1, allowance: 1,
      bonus: 0, effectiveAllowance: 1, percentUsed: 100, month: '2026-07',
      usageMode: 'paused', usagePolicyVersion: 'pro-v1',
    } as any);

    const result = await runScheduledChat({ ...baseSchedule, llmModel: 'anthropic.claude-opus-5' } as any, 'test-user-123', false);

    expect(result.status).toBe('failure');
    expect(result.actualResponse).toContain('AI usage is paused');
    expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
  });
});

describe('getModelOptions — authoritative model discovery', () => {
  it('keeps entitled models selectable and replaces superseded backup recommendations', async () => {
    mockAgentModeService.getSupportedModels.mockResolvedValue([
      'anthropic.claude-opus-5', 'openrouter/x-ai/grok-4.6', 'openrouter/x-ai/grok-4.7',
    ] as any);
    mockGetEffectiveLlmUsagePolicy.mockResolvedValue({
      billingUserId: 'test-user-123',
      policy: {
        version: 'pro-v1', enforcementState: 'enforce',
        optimizationCostThresholdMicroUsd: 80_000_000,
        hardCostThresholdMicroUsd: 150_000_000,
        optimizedModelIds: ['openrouter/x-ai/grok-4.6'],
        optimizedDefaultModel: 'openrouter/x-ai/grok-4.6',
      },
      costUsedMicroUsd: 80_000_000,
      creditsApplied: false,
      mode: { usageMode: 'optimized', admissionAllowed: true, reason: 'optimization_threshold_reached' },
    });
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));

    await agentModeController.getModelOptions(
      { user: { userId: 'test-user-123', isAdmin: false } } as any,
      { json, status } as any,
    );

    // ENG-1211 AC1: nothing below the hard cap hides a model, so the picker
    // offers the full entitled set even on a legacy `optimized` usage state.
    // Backup recommendations advance to Grok 4.7; stored choices remain selectable.
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      usageMode: 'optimized',
      canGenerate: true,
      selectableModels: ['anthropic.claude-opus-5', 'openrouter/x-ai/grok-4.6', 'openrouter/x-ai/grok-4.7'],
      allModels: ['anthropic.claude-opus-5', 'openrouter/x-ai/grok-4.6', 'openrouter/x-ai/grok-4.7'],
      scheduleBackupModels: ['openrouter/x-ai/grok-4.7'],
    }));
  });

  // ENG-112: additive capability hint for "Branch from here". Default OFF; only the exact value "true" turns it on.
  describe('chatBranchingEnabled hint (ENG-112)', () => {
    const optionsBody = async () => {
      mockAgentModeService.getSupportedModels.mockResolvedValue(['gpt-a'] as any);
      mockGetEffectiveLlmUsagePolicy.mockResolvedValue({
        billingUserId: 'test-user-123', policy: null, costUsedMicroUsd: 0, creditsApplied: false,
        mode: { usageMode: 'full_choice', admissionAllowed: true, reason: 'policy_not_enforced' },
      });
      const json = jest.fn();
      await agentModeController.getModelOptions(
        { user: { userId: 'test-user-123', isAdmin: false } } as any,
        { json, status: jest.fn(() => ({ json })) } as any,
      );
      return json.mock.calls[0][0];
    };

    it.each([[null], [{ settingValue: 'false' }], [{ settingValue: '' }], [{ settingValue: 'yes' }]])('is false when the setting is %j', async (row) => {
      mockGetSetting.mockResolvedValue(row);
      expect((await optionsBody()).chatBranchingEnabled).toBe(false);
    });

    it('is true only for "true"', async () => {
      mockGetSetting.mockResolvedValue({ settingValue: 'true' });
      expect((await optionsBody()).chatBranchingEnabled).toBe(true);
      expect(mockGetSetting).toHaveBeenCalledWith('chat_branching_enabled');
    });

    it('fails closed (false) when the settings read throws, without failing the model options', async () => {
      mockGetSetting.mockRejectedValue(new Error('ddb down'));
      const body = await optionsBody();
      expect(body.chatBranchingEnabled).toBe(false);
      expect(body.allModels).toEqual(['gpt-a']);
    });
  });

  // ENG-2379: the legacy id -> current id map the server resolves pins with, served so clients stop hand-copying it.
  describe('legacyModelAliases (ENG-2379)', () => {
    const optionsBody = async () => {
      mockAgentModeService.getSupportedModels.mockResolvedValue(['gpt-a'] as any);
      mockGetEffectiveLlmUsagePolicy.mockResolvedValue({
        billingUserId: 'test-user-123', policy: null, costUsedMicroUsd: 0, creditsApplied: false,
        mode: { usageMode: 'full_choice', admissionAllowed: true, reason: 'policy_not_enforced' },
      });
      const json = jest.fn();
      await agentModeController.getModelOptions(
        { user: { userId: 'test-user-123', isAdmin: false } } as any,
        { json, status: jest.fn(() => ({ json })) } as any,
      );
      return json.mock.calls[0][0];
    };

    it('serves exactly the registry map the server resolves legacy ids with, including the Qwen rename', async () => {
      const body = await optionsBody();
      expect(body.legacyModelAliases).toEqual(LEGACY_MODEL_ALIASES);
      expect(body.legacyModelAliases['openrouter/qwen/qwen3.8-max']).toBe('openrouter/qwen/qwen3.8-max-0902');
    });

    it('is a copy: mutating the response cannot change the server-side map', async () => {
      const body = await optionsBody();
      body.legacyModelAliases['gpt-4o-mini'] = 'tampered';
      expect(LEGACY_MODEL_ALIASES['gpt-4o-mini']).toBe('openrouter/openai/gpt-4o-mini');
    });

    it('is additive: the existing fields are all still present', async () => {
      const body = await optionsBody();
      expect(Object.keys(body)).toEqual(expect.arrayContaining([
        'usageMode', 'canGenerate', 'allModels', 'selectableModels', 'scheduleBackupModels',
        'optimizedDefaultModel', 'usagePolicyVersion', 'chatBranchingEnabled', 'compareSaveAlternatives',
      ]));
    });

    it('every served alias points at a live registry model and no alias is itself registered (no dead or looping entries)', () => {
      for (const [legacy, current] of Object.entries(LEGACY_MODEL_ALIASES)) {
        expect(LLM_MODEL_REGISTRY[current]).toBeDefined();
        expect(LLM_MODEL_REGISTRY[legacy]).toBeUndefined();
      }
    });
  });

  // ENG-113: additive capability hint for saving the unchosen Compare answers. Default OFF; only the exact value "true" turns it on.
  describe('compareSaveAlternatives hint (ENG-113)', () => {
    let clock = Date.now() + 1_000 * 60_000;
    beforeEach(() => {
      clock += 10 * 60_000; // the reader caches for ~60s at module level
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
    });
    afterEach(() => jest.restoreAllMocks());
    const optionsBody = async () => {
      mockAgentModeService.getSupportedModels.mockResolvedValue(['gpt-a'] as any);
      mockGetEffectiveLlmUsagePolicy.mockResolvedValue({
        billingUserId: 'test-user-123', policy: null, costUsedMicroUsd: 0, creditsApplied: false,
        mode: { usageMode: 'full_choice', admissionAllowed: true, reason: 'policy_not_enforced' },
      });
      const json = jest.fn();
      await agentModeController.getModelOptions(
        { user: { userId: 'test-user-123', isAdmin: false } } as any,
        { json, status: jest.fn(() => ({ json })) } as any,
      );
      return json.mock.calls[0][0];
    };
    const row = (value: unknown) =>
      mockGetSetting.mockImplementation(async (name: string) => (name === 'compare_save_alternatives' && value !== null ? { settingValue: value } : null));

    it.each([[null], ['false'], [''], ['yes'], ['TRUE']])('is false when the setting is %j', async (value) => {
      row(value);
      expect((await optionsBody()).compareSaveAlternatives).toBe(false);
    });
    it('is true only for exactly "true"', async () => {
      row('true');
      expect((await optionsBody()).compareSaveAlternatives).toBe(true);
    });
    it('a settings outage keeps the last-known value and never fails the model options (cold start => off is unit-tested)', async () => {
      row('true');
      expect((await optionsBody()).compareSaveAlternatives).toBe(true);
      clock += 10 * 60_000;
      mockGetSetting.mockRejectedValue(new Error('ddb down'));
      const body = await optionsBody();
      expect(body.compareSaveAlternatives).toBe(true);
      expect(body.allModels).toEqual(['gpt-a']);
    });
  });

  // ENG-2378: additive capability hint for the per-step work-plan model. Default OFF; only the exact value "true" turns it on.
  describe('workPlanStepModelsEnabled hint (ENG-2378)', () => {
    let clock = Date.now() + 5_000 * 60_000;
    beforeEach(() => {
      clock += 10 * 60_000; // the reader caches for ~60s at module level
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
    });
    afterEach(() => jest.restoreAllMocks());
    const optionsBody = async () => {
      mockAgentModeService.getSupportedModels.mockResolvedValue(['gpt-a'] as any);
      mockGetEffectiveLlmUsagePolicy.mockResolvedValue({
        billingUserId: 'test-user-123', policy: null, costUsedMicroUsd: 0, creditsApplied: false,
        mode: { usageMode: 'full_choice', admissionAllowed: true, reason: 'policy_not_enforced' },
      });
      const json = jest.fn();
      await agentModeController.getModelOptions(
        { user: { userId: 'test-user-123', isAdmin: false } } as any,
        { json, status: jest.fn(() => ({ json })) } as any,
      );
      return json.mock.calls[0][0];
    };
    const row = (value: unknown) =>
      mockGetSetting.mockImplementation(async (name: string) => (name === 'work_plan_step_models_enabled' && value !== null ? { settingValue: value } : null));

    it.each([[null], ['false'], [''], ['yes'], ['TRUE'], [' true']])('is false when the setting is %j', async (value) => {
      row(value);
      expect((await optionsBody()).workPlanStepModelsEnabled).toBe(false);
    });
    it('is true only for exactly "true", and sits next to the other hints', async () => {
      row('true');
      const body = await optionsBody();
      expect(body.workPlanStepModelsEnabled).toBe(true);
      expect(body).toHaveProperty('chatBranchingEnabled');
      expect(body).toHaveProperty('compareSaveAlternatives');
    });
    it('a settings outage keeps the last-known value and never fails the model options', async () => {
      row('true');
      expect((await optionsBody()).workPlanStepModelsEnabled).toBe(true);
      clock += 10 * 60_000;
      mockGetSetting.mockRejectedValue(new Error('ddb down'));
      const body = await optionsBody();
      expect(body.workPlanStepModelsEnabled).toBe(true);
      expect(body.allModels).toEqual(['gpt-a']);
    });
  });

  it('never offers a live-voice model: every consumer is a text-chat picker and an explicit live pick now 422s', async () => {
    mockAgentModeService.getSupportedModels.mockResolvedValue(['gpt-a', 'live-voice-1', 'gpt-b'] as any);
    (mockAgentModeService as any).isLiveModel = jest.fn((id: string) => id === 'live-voice-1');
    mockGetEffectiveLlmUsagePolicy.mockResolvedValue({
      billingUserId: 'test-user-123', policy: null, costUsedMicroUsd: 0, creditsApplied: false,
      mode: { usageMode: 'full_choice', admissionAllowed: true, reason: 'policy_not_enforced' },
    });
    const json = jest.fn();
    try {
      await agentModeController.getModelOptions(
        { user: { userId: 'test-user-123', isAdmin: false } } as any,
        { json, status: jest.fn(() => ({ json })) } as any,
      );
    } finally {
      delete (mockAgentModeService as any).isLiveModel;
    }
    const body = json.mock.calls[0][0];
    expect(body.allModels).toEqual(['gpt-a', 'gpt-b']);
    expect(body.selectableModels).toEqual(['gpt-a', 'gpt-b']);
    expect(body.scheduleBackupModels).not.toContain('live-voice-1');
  });
});

/**
 * ENG-1211 — schedule backup resolution stops manufacturing dead artifacts.
 *
 * `resolveScheduleBackup` used to invent a system backup whenever the caller
 * supplied none, stamping the optimized default plus
 * `llmBackupNeedsConfirmation: true`. That is what put an unconfirmed
 * `gemini-3.1-flash-lite` onto 177 production rows. With the optimized branch
 * deleted nothing ever reads a backup, so continuing to invent one would keep
 * generating dead data and polluting ENG-1209's inventory with rows nobody chose.
 *
 * It also used to REJECT a requested backup that was not in the optimized
 * catalog. Restricting which models a user may choose below the hard cap is
 * precisely the class of behavior AC1 removes.
 */
describe('resolveScheduleBackup via updateScheduledChat (ENG-1211)', () => {
  const existing = {
    scheduleId: 'sched-1',
    userId: 'test-user-123',
    taskId: 'global',
    type: 'scheduled_chat',
    status: 'active',
    frequency: 'daily',
    scheduleName: 'Daily digest',
    startingMessage: 'go',
    llmModel: 'anthropic.claude-opus-5',
    emailNotifications: ['owner@example.com'],
  };

  const runUpdate = async (llmBackupModel: string | undefined) => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    await agentModeController.updateScheduledChat(
      {
        user: { userId: 'test-user-123', isAdmin: false },
        params: { scheduleId: 'sched-1' },
        body: { llmBackupModel, emailNotifications: ['owner@example.com'] },
      } as any,
      { json, status } as any,
    );
    return { json, status };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (scheduleDb.getScheduleById as jest.Mock).mockResolvedValue(existing);
    (scheduleDb.updateSchedule as jest.Mock).mockResolvedValue(undefined);
    (agentModeService.getSupportedModels as jest.Mock).mockResolvedValue([
      'anthropic.claude-opus-5',
      'gemini-3.1-flash-lite',
    ]);
    (agentModeService.getScheduledChatsDefaultModel as jest.Mock)?.mockResolvedValue?.('anthropic.claude-opus-5');
    mockGetEffectiveLlmUsagePolicy.mockResolvedValue({
      billingUserId: 'test-user-123',
      policy: {
        version: 'pro-v1',
        enforcementState: 'enforce',
        optimizationCostThresholdMicroUsd: 80_000_000,
        hardCostThresholdMicroUsd: 150_000_000,
        optimizedModelIds: ['gemini-3.1-flash-lite'],
        optimizedDefaultModel: 'gemini-3.1-flash-lite',
      },
      costUsedMicroUsd: 0,
      creditsApplied: false,
      mode: { usageMode: 'full_choice', admissionAllowed: true, reason: 'hard_cap_only' },
    } as any);
  });

  it('does not invent a system backup when none was requested', async () => {
    const { json } = await runUpdate('');
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      llmBackupModel: '',
      llmBackupSource: null,
      llmBackupNeedsConfirmation: false,
    }));
  });

  it('accepts a premium backup that the old optimized catalog would have rejected', async () => {
    const { json, status } = await runUpdate('anthropic.claude-opus-5');
    expect(status).not.toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      llmBackupModel: 'anthropic.claude-opus-5',
      llmBackupSource: 'user',
      llmBackupNeedsConfirmation: false,
    }));
  });

  it('still rejects a model that is not in the supported registry', async () => {
    const { status } = await runUpdate('not-a-real-model');
    expect(status).toHaveBeenCalledWith(400);
  });
});
