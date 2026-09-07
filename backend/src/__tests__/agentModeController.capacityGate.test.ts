/**
 * ENG-1717 — the pre-send capacity gate, proven at the runScheduledChat level.
 *
 * scheduledRunCapacityGate.test.ts pins the DECISION in isolation. This file pins
 * the WIRING: that an exhausted account actually withholds the run, that the model
 * is never invoked (which is what "attempts no sends" means in practice), and that
 * the cases which must still run, still run.
 *
 * The mock preamble is lifted from agentModeController.scheduledAlertKeying.test.ts
 * so both suites drive the same code path.
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
    // ENG-892: model resolution is orthogonal to what this suite asserts —
    // pass the requested id through unchanged.
    resolveGenerationModel: jest.fn((model: string) => ({ model, fellBack: false, requestedModel: model })),
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
import { fileAutoIssue } from '../services/intakeService';
import * as runStore from '../services/agentMode/runStore';
import { runScheduledChat } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockRunStore = runStore as jest.Mocked<typeof runStore>;

const mockUserId = 'user-sid';
const fireTime = '2026-07-15T10:00:00.000Z';
const baseSchedule = {
  scheduleId: 'sched-sid',
  scheduleName: 'SID Schedule',
  startingMessage: 'Do the thing',
  keywords: [] as string[],
  requiredFunctionCalls: [] as string[],
  userId: mockUserId,
  frequency: 'daily',
  nextRunTime: fireTime,
};

const mockSession = {
  sessionId: 'session-sid',
  userId: mockUserId,
  title: 'SID Session',
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

const flushAsync = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
};

beforeEach(() => {
  jest.clearAllMocks();
  (mockRunStore.isRunStoreEnabled as jest.Mock).mockReturnValue(true);
  mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
  (mockAgentModeService as any).getScheduledChatsDefaultModel.mockResolvedValue('gpt-5-chat-2');
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
  mockUserDb.getUserById.mockResolvedValue({ userId: mockUserId, email: 'o@example.com' } as any);
});


import { getAccountsWithOwnerIncludingOrgShared } from '../services/connectedAccountsDb';
import { countSentInvitationsByAccount } from '../services/unipileSentInvitationsDb';
import { SEND_CAPACITY_EXHAUSTED_STATUS } from '../utils/scheduledRunCapacityGate';

const mockAccounts = getAccountsWithOwnerIncludingOrgShared as jest.Mock;
const mockPendingCount = countSentInvitationsByAccount as jest.Mock;

const HOUR = 60 * 60 * 1000;
const ACCOUNT = 'dBO0td4tS1yPXMec4n_bYg';

/** A unipile account row as connectedAccountsDb returns it. */
const unipileAccount = (over: { cap?: number; used?: number; startedAgoMs?: number } = {}) => ({
  platform: 'unipile',
  account_id: ACCOUNT,
  account_name: 'Sweta — iTrials',
  config: {
    daily_invite_cap: over.cap ?? 10,
    daily_volume: {
      invite: {
        count: over.used ?? 10,
        windowStartedAt: Date.now() - (over.startedAgoMs ?? 2 * HOUR),
      },
    },
  },
});

const outreachSchedule = {
  ...baseSchedule,
  scheduleName: 'Daily LinkedIn Outreach - Agentic AI',
  requiredFunctionCalls: ['linkedin_outreach'],
};

describe('runScheduledChat — pre-send capacity gate (ENG-1717 / ENG-1609 AC #9)', () => {
  beforeEach(() => {
    // The absolute max is 0 under Jest, which resolveDailyInviteCap reads as
    // "operator disabled -> Infinity". Without this every account looks unlimited
    // and the gate could never fire, so these assertions would measure nothing.
    process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = '30';
    mockAccounts.mockResolvedValue([]);
    mockPendingCount.mockResolvedValue(0);
  });
  afterEach(() => { delete process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX; });

  it('withholds the run and never invokes the model when the account is out of budget', async () => {
    mockAccounts.mockResolvedValue([unipileAccount({ cap: 10, used: 10 })]);
    mockPendingCount.mockResolvedValue(393);

    const result: any = await runScheduledChat(outreachSchedule, mockUserId, false, 'run-capacity-1');
    await flushAsync();

    expect(result.status).toBe(SEND_CAPACITY_EXHAUSTED_STATUS);
    expect(result.passed).toBe(false);
    // The entire point: no model spend, therefore no per-recipient send attempts.
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    expect(mockScheduleDb.addRunResult).toHaveBeenCalledWith(
      outreachSchedule.scheduleId,
      expect.objectContaining({ status: SEND_CAPACITY_EXHAUSTED_STATUS }),
    );
  }, 30000);

  it('names the account, the cap and the pending backlog in the recorded reason', async () => {
    mockAccounts.mockResolvedValue([unipileAccount({ cap: 30, used: 30 })]);
    mockPendingCount.mockResolvedValue(393);

    const result: any = await runScheduledChat(outreachSchedule, mockUserId, false, 'run-capacity-2');
    await flushAsync();

    expect(result.actualResponse).toContain('Sweta — iTrials');
    expect(result.actualResponse).toContain('30 of its 30');
    expect(result.actualResponse).toContain('393 invitations still pending');
  }, 30000);

  it('still withholds a TEST run — the run that opened ENG-1132 was a test run', async () => {
    mockAccounts.mockResolvedValue([unipileAccount({ cap: 10, used: 10 })]);

    const result: any = await runScheduledChat(outreachSchedule, mockUserId, true, 'run-capacity-test');
    await flushAsync();

    expect(result.status).toBe(SEND_CAPACITY_EXHAUSTED_STATUS);
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
  }, 30000);

  it('runs normally when the account still has budget', async () => {
    mockAccounts.mockResolvedValue([unipileAccount({ cap: 10, used: 4 })]);

    const result: any = await runScheduledChat(outreachSchedule, mockUserId, false, 'run-capacity-ok');
    await flushAsync();

    expect(result.status).not.toBe(SEND_CAPACITY_EXHAUSTED_STATUS);
    expect(mockWorker.runInWorker).toHaveBeenCalled();
  }, 30000);

  it('runs normally when a second account still has budget', async () => {
    mockAccounts.mockResolvedValue([
      { ...unipileAccount({ cap: 10, used: 10 }) },
      { ...unipileAccount({ cap: 10, used: 1 }), account_id: 'other-acct', account_name: 'Kanchan' },
    ]);

    const result: any = await runScheduledChat(outreachSchedule, mockUserId, false, 'run-capacity-multi');
    await flushAsync();

    expect(result.status).not.toBe(SEND_CAPACITY_EXHAUSTED_STATUS);
    expect(mockWorker.runInWorker).toHaveBeenCalled();
  }, 30000);

  it('does not touch a schedule that does not send invites, even on an exhausted account', async () => {
    mockAccounts.mockResolvedValue([unipileAccount({ cap: 10, used: 10 })]);
    // Prompt talks about LinkedIn; the schedule does not declare the outreach tool
    // and pins no account id. Prose alone must never arm this gate — a production
    // scan found 82 LinkedIn-mentioning schedules against 8 that declare the tool.
    // (`get_marketing_tips` is used simply because the mocked subscription entitles
    // it; the point is only that it is not `linkedin_outreach`.)
    const reportingSchedule = {
      ...baseSchedule,
      scheduleName: 'Monthly LinkedIn Ads report',
      startingMessage: 'Summarise last month LinkedIn Ads performance and email the report.',
      requiredFunctionCalls: ['get_marketing_tips'],
    };

    const result: any = await runScheduledChat(reportingSchedule, mockUserId, false, 'run-capacity-unrelated');
    await flushAsync();

    expect(result.status).not.toBe(SEND_CAPACITY_EXHAUSTED_STATUS);
    expect(mockWorker.runInWorker).toHaveBeenCalled();
  }, 30000);

  it('runs rather than withholding when the daily window is about to renew', async () => {
    // 23h55m into the window: it renews in 5 minutes, inside the margin.
    mockAccounts.mockResolvedValue([
      unipileAccount({ cap: 10, used: 10, startedAgoMs: 24 * HOUR - 5 * 60 * 1000 }),
    ]);

    const result: any = await runScheduledChat(outreachSchedule, mockUserId, false, 'run-capacity-renewing');
    await flushAsync();

    expect(result.status).not.toBe(SEND_CAPACITY_EXHAUSTED_STATUS);
    expect(mockWorker.runInWorker).toHaveBeenCalled();
  }, 30000);

  it('still withholds when the pending count is unavailable, omitting the backlog sentence', async () => {
    mockAccounts.mockResolvedValue([unipileAccount({ cap: 10, used: 10 })]);
    mockPendingCount.mockRejectedValue(new Error('dynamo down'));

    const result: any = await runScheduledChat(outreachSchedule, mockUserId, false, 'run-capacity-nocount');
    await flushAsync();

    expect(result.status).toBe(SEND_CAPACITY_EXHAUSTED_STATUS);
    expect(result.actualResponse).not.toContain('still pending');
  }, 30000);

  it('runs when the account lookup fails outright — the gate fails open', async () => {
    mockAccounts.mockRejectedValue(new Error('dynamo down'));

    const result: any = await runScheduledChat(outreachSchedule, mockUserId, false, 'run-capacity-failopen');
    await flushAsync();

    expect(result.status).not.toBe(SEND_CAPACITY_EXHAUSTED_STATUS);
    expect(mockWorker.runInWorker).toHaveBeenCalled();
  }, 30000);
});
