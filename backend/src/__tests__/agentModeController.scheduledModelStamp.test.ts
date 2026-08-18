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
      tokenUsed: 1,
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

  it('does not stamp an unserved schedule model — records the fallback generation resolves to', async () => {
    await runScheduledChat({ ...baseSchedule, llmModel: 'claude-sonnet-4-5' } as any, 'test-user-123', false);

    expect(stampedModel()).toBe(FALLBACK);
    expect(stampedModel()).not.toBe('claude-sonnet-4-5');
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
    expect(alert.message).toContain(FALLBACK);
    // Deduped per (schedule, bad value) so a daily schedule cannot flood oncall.
    expect(alert.dedupeKey).toBe('schedule_model_invalid:sched-1:claude-sonnet-4-5');
  });

  it('does not alert when the pinned model is served', async () => {
    await runScheduledChat({ ...baseSchedule, llmModel: 'anthropic.claude-opus-5' } as any, 'test-user-123', false);

    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('uses the user-selected eligible backup after the optimization threshold', async () => {
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
      tokenUsed: 300_000_000,
      mode: { usageMode: 'optimized', admissionAllowed: true, reason: 'optimization_threshold_reached' },
    });

    await runScheduledChat({
      ...baseSchedule,
      llmModel: 'anthropic.claude-opus-5',
      llmBackupModel: 'gpt-5-chat-2',
      llmBackupSource: 'user',
    } as any, 'test-user-123', false);

    expect(stampedModel()).toBe('gpt-5-chat-2');
    expect(stampedPolicyDecision()).toEqual(expect.objectContaining({
      requestedModel: 'anthropic.claude-opus-5',
      effectiveModel: 'gpt-5-chat-2',
      backupModel: 'gpt-5-chat-2',
      backupSource: 'user',
      modelSelection: 'corrected',
      modelSelectionReason: 'requested_model_blocked_using_user_backup',
      usageMode: 'optimized',
      usagePolicyVersion: 'pro-v1',
      recordedAt: expect.any(String),
    }));
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(
      expect.objectContaining({ llmModel: 'gpt-5-chat-2' }),
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
  it('returns only optimized models as selectable after the optimization threshold', async () => {
    mockAgentModeService.getSupportedModels.mockResolvedValue([
      'anthropic.claude-opus-5', 'gpt-5-chat-2',
    ] as any);
    mockGetEffectiveLlmUsagePolicy.mockResolvedValue({
      billingUserId: 'test-user-123',
      policy: {
        version: 'pro-v1', enforcementState: 'enforce',
        optimizationCostThresholdMicroUsd: 80_000_000,
        hardCostThresholdMicroUsd: 150_000_000,
        optimizedModelIds: ['gpt-5-chat-2'],
        optimizedDefaultModel: 'gpt-5-chat-2',
      },
      costUsedMicroUsd: 80_000_000,
      tokenUsed: 1,
      mode: { usageMode: 'optimized', admissionAllowed: true, reason: 'optimization_threshold_reached' },
    });
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));

    await agentModeController.getModelOptions(
      { user: { userId: 'test-user-123', isAdmin: false } } as any,
      { json, status } as any,
    );

    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      usageMode: 'optimized',
      canGenerate: true,
      selectableModels: ['gpt-5-chat-2'],
      allModels: ['anthropic.claude-opus-5', 'gpt-5-chat-2'],
      scheduleBackupModels: ['gpt-5-chat-2'],
    }));
  });
});
