/**
 * ENG-1209 AC4 — a system-selected soft-cap backup can never become effective.
 *
 * 71 production schedules still carry an unconfirmed system-selected
 * `gemini-3.1-flash-lite` backup (`llmBackupSource: 'system'`,
 * `llmBackupNeedsConfirmation: true`), written while forced optimized mode was
 * active. AC4 says those must be "removed or PROVEN INERT". They are inert, and
 * this file is the proof — so that the state can be left in place rather than
 * mutated in production, which is the safer of the two remedies.
 *
 * Inertness rests on two independent facts, and each layer already has its own
 * tests:
 *
 *   - `selectPolicyModel` has no optimized branch left, so a supported requested
 *     model is always honored and the backup is carried as DATA only
 *     (llmUsagePolicyLegacyStateInert.test.ts);
 *   - `getBackupModel(primary, undefined)` consults the admin-managed global
 *     setting `agent_mode_backup_model` (agentModeService.backupModel.test.ts).
 *
 * What neither covers is the SEAM between them, which is where the guarantee
 * actually lives: `runScheduledChat` must dispatch with `transientFallbackModel`
 * UNDEFINED, so the schedule's own stored backup never reaches the retry path.
 * That is a single hardcoded value in `resolveEffectiveModelForUser`. Someone
 * threading the schedule's backup through it would silently re-arm all 71 rows —
 * a model swap mid-run, on a model the customer never confirmed — and every
 * existing test would still pass.
 *
 * The equivalent assertion exists for the interactive-share path
 * (agentModeController.ishareModel.test.ts). The scheduled path is where the
 * affected rows actually live, and it had none.
 */

jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => ['get_marketing_tips']),
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
  updateTaskExecutionStatus: jest.fn(),
}));

const SYSTEM_BACKUP = 'gemini-3.1-flash-lite';
const EXPLICIT_MODEL = 'claude-opus-4-8';
const PLATFORM_DEFAULT = 'gpt-5-chat-2';

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    resolveGenerationModel: jest.fn((model: string) => ({ model, fellBack: false, requestedModel: model })),
    getSupportedModels: jest.fn(async () => ['gpt-5-chat-2', 'claude-opus-4-8', 'gemini-3.1-flash-lite']),
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getScheduledChatsDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    generateScheduledChatSummary: jest.fn(),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set([])),
    getAdminToolNames: jest.fn().mockReturnValue([]),
  },
}));

jest.mock('../services/llmUsagePolicyResolverService', () => ({
  getEffectiveLlmUsagePolicy: jest.fn(async () => ({
    billingUserId: 'user-inert',
    mode: { usageMode: 'normal', admissionAllowed: true },
    // A policy that still carries its optimized catalog, exactly as a
    // pre-cutover account's stored policy does. It must not re-acquire teeth.
    policy: {
      version: 'v-legacy',
      optimizedModelIds: [SYSTEM_BACKUP],
      optimizedDefaultModel: SYSTEM_BACKUP,
    },
  })),
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
    bonus: 0, effectiveAllowance: 1000000, percentUsed: 0, month: '2026-08',
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
  isRunStoreEnabled: jest.fn().mockReturnValue(false),
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
import { runScheduledChat } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

const userId = 'user-inert';
const fireTime = '2026-08-18T10:00:00.000Z';

/** A schedule as the ENG-1209 backfill left it: a cheap backup nobody confirmed. */
const scheduleWithSystemBackup = (over: Record<string, unknown> = {}) => ({
  scheduleId: 'sched-inert',
  scheduleName: 'Legacy backfilled schedule',
  startingMessage: 'Do the thing',
  keywords: [] as string[],
  requiredFunctionCalls: [] as string[],
  userId,
  frequency: 'daily',
  nextRunTime: fireTime,
  llmBackupModel: SYSTEM_BACKUP,
  llmBackupSource: 'system',
  llmBackupNeedsConfirmation: true,
  ...over,
});

const mockSession = {
  sessionId: 'session-inert',
  userId,
  title: 'Session',
  messages: [],
  createdAt: fireTime,
  updatedAt: fireTime,
};

const okResponse = {
  content: 'Done.',
  toolCalls: [],
  knowledgeBaseQueries: [],
  sources: [],
  responseMessages: [],
};

/** What the worker was actually asked to run. */
const dispatched = () => (mockWorker.runInWorker as jest.Mock).mock.calls[0][0] as {
  llmModel?: string;
  transientFallbackModel?: string | null;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAgentModeService.getDefaultModel.mockResolvedValue(PLATFORM_DEFAULT);
  (mockAgentModeService as any).getScheduledChatsDefaultModel.mockResolvedValue(PLATFORM_DEFAULT);
  (mockAgentModeService as any).getSupportedModels.mockResolvedValue([
    PLATFORM_DEFAULT, EXPLICIT_MODEL, SYSTEM_BACKUP,
  ]);
  mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
  mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');
  (mockAgentModeService as any).generateScheduledChatSummary.mockResolvedValue(null);
  mockChatbotDb.createChatSession.mockResolvedValue(mockSession as any);
  mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
  (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([
    { role: 'assistant', content: 'Done.' },
  ]);
  mockChatbotDb.addMessageToSession.mockResolvedValue(mockSession as any);
  mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
  mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
  mockChatbotDb.updateSessionLlmModel.mockResolvedValue(mockSession as any);
  (mockChatbotDb as any).updateSessionError.mockResolvedValue(undefined);
  mockWorker.runInWorker.mockResolvedValue(okResponse as any);
  mockScheduleDb.addRunResult.mockResolvedValue(undefined as any);
  mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined as any);
  mockScheduleDb.updateSchedule.mockResolvedValue(undefined as any);
  mockUserDb.getUserById.mockResolvedValue({ userId, email: 'o@example.com' } as any);
});

describe('ENG-1209 AC4 — a scheduled run cannot be coerced by a legacy backup', () => {
  it('runs the schedule\'s EXPLICIT model and arms no fallback from its stored backup', async () => {
    await runScheduledChat(scheduleWithSystemBackup({ llmModel: EXPLICIT_MODEL }) as any, userId, false, 'run-1');

    const call = dispatched();
    expect(call.llmModel).toBe(EXPLICIT_MODEL);
    // The load-bearing assertion. `undefined` means "preserve the admin-managed
    // global backup", so the retry path consults a setting rather than this
    // schedule's row. Any string here would be the schedule's own backup
    // becoming effective without the confirmation AC4 requires.
    expect(call.transientFallbackModel).toBeUndefined();
  }, 30000);

  it('never dispatches the unconfirmed backup as the model itself', async () => {
    await runScheduledChat(scheduleWithSystemBackup({ llmModel: EXPLICIT_MODEL }) as any, userId, false, 'run-2');

    const call = dispatched();
    expect(call.llmModel).not.toBe(SYSTEM_BACKUP);
    expect(call.transientFallbackModel).not.toBe(SYSTEM_BACKUP);
  }, 30000);

  it('an INHERITING schedule falls to the platform default, not the cheap backup', async () => {
    // The dangerous shape: no explicit model to protect it, and a cheap backup
    // already attached. 81 of 96 active schedules resolve through the default.
    await runScheduledChat(scheduleWithSystemBackup() as any, userId, false, 'run-3');

    const call = dispatched();
    expect(call.llmModel).toBe(PLATFORM_DEFAULT);
    expect(call.transientFallbackModel).toBeUndefined();
  }, 30000);

  it('treats a USER-confirmed backup the same way — data, never a dispatch', async () => {
    // AC3 preserves a user's confirmed backup, and preserving is not the same as
    // acting on it. The transient retry is owned by the admin setting for every
    // provenance, so confirmation changes what is STORED, not what runs.
    await runScheduledChat(
      scheduleWithSystemBackup({
        llmModel: EXPLICIT_MODEL,
        llmBackupSource: 'user',
        llmBackupNeedsConfirmation: false,
      }) as any,
      userId,
      false,
      'run-4',
    );

    const call = dispatched();
    expect(call.llmModel).toBe(EXPLICIT_MODEL);
    expect(call.transientFallbackModel).toBeUndefined();
  }, 30000);

  it('a schedule with NO backup at all dispatches identically', async () => {
    // The control. If the legacy rows were doing anything, this would differ from
    // the cases above — and it must not, because that equality IS inertness.
    await runScheduledChat(
      {
        scheduleId: 'sched-clean',
        scheduleName: 'Never backfilled',
        startingMessage: 'Do the thing',
        keywords: [],
        requiredFunctionCalls: [],
        userId,
        frequency: 'daily',
        nextRunTime: fireTime,
        llmModel: EXPLICIT_MODEL,
      } as any,
      userId,
      false,
      'run-5',
    );

    const call = dispatched();
    expect(call.llmModel).toBe(EXPLICIT_MODEL);
    expect(call.transientFallbackModel).toBeUndefined();
  }, 30000);
});
