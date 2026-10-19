/**
 * ENG-1205 — `resolveEffectiveModelForUser` must resolve the supported-model set
 * for the SESSION OWNER's entitlement, not for a hardcoded non-admin.
 *
 * It passed a literal `false` to `getSupportedModels`, while `getModelOptions`
 * (the picker) passes the real flag. So the picker offered an admin an
 * admin-only model, the admin chose it, and at dispatch the resolver could not
 * find it in the non-admin catalog and silently rewrote it to the system default
 * with `modelSelection: 'corrected'`. No error, and — until portal #1030 made the
 * badge truthful — no visible sign either. That is the same silent-correction
 * class ENG-1205 exists to close, arriving through configuration rather than
 * through chat.
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

const DEFAULT_MODEL = 'gpt-5-chat-2';
const SCHEDULED_DEFAULT = 'anthropic.claude-opus-5';
/** Mirrors the real registry: `adminOnly: true`, so absent from getSupportedModels(false). */
const ADMIN_ONLY_MODEL = 'anthropic.claude-opus-4-6-v1';
const NON_ADMIN_MODELS = [DEFAULT_MODEL, SCHEDULED_DEFAULT];
const ADMIN_MODELS = [...NON_ADMIN_MODELS, ADMIN_ONLY_MODEL];

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getScheduledChatsDefaultModel: jest.fn(),
    // The real asymmetry: the admin catalog is a superset of the non-admin one.
    getSupportedModels: jest.fn(async (isAdmin: boolean) => (isAdmin ? ADMIN_MODELS : NON_ADMIN_MODELS)),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    generateScheduledChatSummary: jest.fn(),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set(['install_skills', 'search_web'])),
    getAdminToolNames: jest.fn().mockReturnValue([]),
    // Every id here is genuinely served — this test is about ENTITLEMENT, not
    // about an unserved id, which agentModeController.scheduledModelStamp covers.
    resolveGenerationModel: jest.fn((model: string) => ({
      model, fellBack: false, requestedModel: model,
    })),
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
  userDb: { getUserById: jest.fn() },
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
import { scheduleDb, userDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { runScheduledChat } from '../controllers/agentModeController';
import { getEffectiveLlmUsagePolicy } from '../services/llmUsagePolicyResolverService';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockGetEffectiveLlmUsagePolicy = getEffectiveLlmUsagePolicy as jest.MockedFunction<typeof getEffectiveLlmUsagePolicy>;

const SESSION_ID = 'test-session-123';
const OWNER_ID = 'test-user-123';

const session = {
  sessionId: SESSION_ID,
  userId: OWNER_ID,
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
  userId: OWNER_ID,
  emailNotifications: [],
};

const stampedModel = () =>
  mockChatbotDb.updateSessionLlmModel.mock.calls.find(([id]) => id === SESSION_ID)?.[1];
const stampedDecision = () =>
  mockChatbotDb.updateSessionLlmModel.mock.calls.find(([id]) => id === SESSION_ID)?.[2] as any;

function setOwner({ isAdmin }: { isAdmin: boolean }) {
  mockUserDb.getUserById.mockResolvedValue({ userId: OWNER_ID, email: 'owner@example.com', isAdmin } as any);
}

describe('resolveEffectiveModelForUser — admin-only model entitlement (ENG-1205)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.createChatSession.mockResolvedValue(session as any);
    mockChatbotDb.getChatSession.mockResolvedValue(session as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(session as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(session as any);
    mockChatbotDb.addMessageToSession.mockResolvedValue(session as any);
    mockAgentModeService.getDefaultModel.mockResolvedValue(DEFAULT_MODEL as any);
    (mockAgentModeService as any).getScheduledChatsDefaultModel.mockResolvedValue(SCHEDULED_DEFAULT);
    (mockAgentModeService.getSupportedModels as jest.Mock).mockImplementation(
      async (isAdmin: boolean) => (isAdmin ? ADMIN_MODELS : NON_ADMIN_MODELS),
    );
    mockGetEffectiveLlmUsagePolicy.mockResolvedValue({
      billingUserId: OWNER_ID,
      policy: null,
      costUsedMicroUsd: 0,
      creditsApplied: false,
      mode: { usageMode: 'full_choice', admissionAllowed: true, reason: 'policy_not_enforced' },
    });
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt' as any);
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title' as any);
    (mockAgentModeService as any).generateScheduledChatSummary.mockResolvedValue('Summary');
    (scheduleDb as jest.Mocked<typeof scheduleDb>).addRunResult.mockResolvedValue(undefined as any);
    mockWorker.runInWorker.mockResolvedValue({
      content: 'Report generated.',
      toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [],
    } as any);
    setOwner({ isAdmin: false });
  });

  it('honors an admin-only model for an admin owner instead of silently rewriting it', async () => {
    setOwner({ isAdmin: true });

    await runScheduledChat({ ...baseSchedule, llmModel: ADMIN_ONLY_MODEL } as any, OWNER_ID, false);

    expect(stampedModel()).toBe(ADMIN_ONLY_MODEL);
    expect(stampedDecision()).toMatchObject({
      requestedModel: ADMIN_ONLY_MODEL,
      effectiveModel: ADMIN_ONLY_MODEL,
      modelSelection: 'honored',
    });
  });

  it('still corrects an admin-only model for a non-admin owner', async () => {
    setOwner({ isAdmin: false });

    const result: any = await runScheduledChat({ ...baseSchedule, llmModel: ADMIN_ONLY_MODEL } as any, OWNER_ID, false);

    // FAIL-LOUD (WP-G): this used to assert the silent 'corrected' swap to the default.
    // The pinned model is not selectable for this owner, so the run fails and nothing
    // is stamped or run on another model.
    expect(result.status).toBe('failure');
    expect(result.actualResponse).toContain('model_unavailable');
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
  });

  it('does not consult the admin catalog for a model everyone can already use', async () => {
    // The widening branch must cost nothing on the ordinary path — no second
    // catalog build, no owner read for entitlement.
    setOwner({ isAdmin: true });

    await runScheduledChat({ ...baseSchedule, llmModel: SCHEDULED_DEFAULT } as any, OWNER_ID, false);

    expect(stampedModel()).toBe(SCHEDULED_DEFAULT);
    expect(mockAgentModeService.getSupportedModels).not.toHaveBeenCalledWith(true);
  });

  it('treats an owner record with no isAdmin field as non-admin', async () => {
    // Legacy user rows predate the flag. Widening entitlement on a missing
    // value would hand every such account the admin-only catalog, so the check
    // is strict-equality against `true`, not truthiness.
    mockUserDb.getUserById.mockResolvedValue({ userId: OWNER_ID, email: 'owner@example.com' } as any);

    const result: any = await runScheduledChat({ ...baseSchedule, llmModel: ADMIN_ONLY_MODEL } as any, OWNER_ID, false);

    // FAIL-LOUD (WP-G): was the silent 'corrected' swap; now the run fails (see above).
    expect(result.status).toBe('failure');
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
  });
});
