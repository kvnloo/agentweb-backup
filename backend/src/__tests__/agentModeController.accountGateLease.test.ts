/**
 * ENG-1197 — where the disconnected-account gate sits in `runScheduledChat`.
 *
 * `scheduledRunAccountGate.test.ts` covers the DECISION (`evaluateAccountGate`).
 * This file covers the WIRING, which is a separate question and the one that was
 * wrong: the gate originally ran before `setRunInFlight`.
 *
 * Both prod instances dispatch the same schedule, and `addRunResult` is a blind
 * `list_append` with no runId dedupe, so a pre-lease gate had BOTH dispatchers
 * writing a skip row and both computing the same streak — doubling every skip in
 * `runResults`, bringing MAX_CONSECUTIVE_ACCOUNT_SKIPS forward from five fires to
 * about three, and sending two identical pause emails. A single-instance test
 * environment cannot reproduce that, which is why it survived live testing.
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
    evaluateScheduledRunPreCheck: jest.fn().mockResolvedValue(null),
    installSkills: jest.fn().mockResolvedValue({ success: true, installedSkills: [] }),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set(['search_web'])),
    getAdminToolNames: jest.fn().mockReturnValue([]),
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
    getSchedulesByUserId: jest.fn().mockResolvedValue([]),
  },
  userDb: { getUserById: jest.fn() },
  taskDb: {
    getTaskExecutionById: jest.fn(),
    createTaskExecution: jest.fn(),
    updateTaskExecution: jest.fn(),
  },
}));

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-run-id-123') }));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendScheduledChatResultEmail: jest.fn(),
    sendDailyDigestEmail: jest.fn(),
    sendScheduledChatVariableRequestEmail: jest.fn(),
    sendScheduledChatErrorEmail: jest.fn(),
    sendScheduledChatTokenLimitEmail: jest.fn(),
    sendScheduledRunFailedEmail: jest.fn(),
    sendLinkedInAccountDisconnectedEmail: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/tokenUsageService', () => ({
  ...jest.requireActual('../services/tokenUsageService'),
  checkTokenUsage: jest.fn(async () => ({
    allowed: true, warning: false, used: 0, allowance: 1000000,
    bonus: 0, effectiveAllowance: 1000000, percentUsed: 0, month: '2026-08',
  })),
}));

jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/notionService', () => ({
  createOncallItem: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/skillService', () => ({
  skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]) },
}));

// The gate's two injected dependencies, both reached by dynamic import.
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
}));

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: { probeAccountSession: jest.fn() },
}));

jest.mock('../services/linkedInConnectionHealth', () => ({
  getUnipileHealth: jest.fn(),
}));

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb, userDb } from '../services/db';
import { emailService } from '../services/emailService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { getAccountsByUserId } from '../services/connectedAccountsDb';
import { linkedInOutreachService } from '../services/linkedInOutreachService';
import { getUnipileHealth } from '../services/linkedInConnectionHealth';
import { runScheduledChat } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockProbe = linkedInOutreachService.probeAccountSession as jest.Mock;
const mockListAccounts = getAccountsByUserId as jest.Mock;
const mockGetHealth = getUnipileHealth as jest.Mock;
const mockEmail = emailService.sendLinkedInAccountDisconnectedEmail as jest.Mock;

const USER_ID = '3da53332-0d6b-421d-97a0-3101459aa606';
const DEAD_ACCOUNT = 'tMgX8uZJTZWTG_mFY1aI2A';

// Jennifer's real schedule shape: pins the dead account by id in its prompt.
const dream100 = {
  scheduleId: '96549b8d-43d1-4e10-abb1-6a42fdca169d',
  scheduleName: 'Daily Dream 100 — Wealth Management Outreach',
  startingMessage: `Run outreach using LinkedIn account ${DEAD_ACCOUNT} against the Dream 100 list.`,
  keywords: [],
  requiredFunctionCalls: [],
  functionCallMinCalls: {},
  userId: USER_ID,
  emailNotifications: ['jennifer.sun@tfaconnect.com'],
};

const accountSkip = (createdAt: string) => ({
  status: 'skipped_account_disconnected',
  passed: false,
  actualResponse: 'Skipped before running',
  attempt: 0,
  createdAt,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockChatbotDb.createChatSession.mockResolvedValue({ sessionId: 's1', userId: USER_ID, messages: [] } as any);
  mockChatbotDb.getChatSession.mockResolvedValue({ sessionId: 's1', userId: USER_ID, messages: [] } as any);
  (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
  mockChatbotDb.updateSessionLlmModel.mockResolvedValue({} as any);
  mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
  mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue('gpt-5-chat-2');
  mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
  mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');
  mockWorker.runInWorker.mockResolvedValue({
    content: 'done', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [],
  } as any);
  mockScheduleDb.addRunResult.mockResolvedValue(undefined as any);
  mockScheduleDb.setRunInFlight.mockResolvedValue('acquired' as any);
  mockUserDb.getUserById.mockResolvedValue({ userId: USER_ID, email: 'jennifer.sun@tfaconnect.com' } as any);

  // `needs_reconnect` must be set: the gate short-circuits to "not blocked" on the
  // stored flag and only then confirms with a live probe, so an account that has
  // never been flagged is never probed.
  mockListAccounts.mockResolvedValue([
    {
      platform: 'unipile',
      account_id: DEAD_ACCOUNT,
      account_name: 'Jennifer Sun',
      config: { unipile_account_id: DEAD_ACCOUNT, needs_reconnect: true },
    },
  ]);
  mockProbe.mockResolvedValue('disconnected');
  mockGetHealth.mockResolvedValue(null);
});

describe('the gate runs behind the in-flight lease', () => {
  it('skips the run for the dispatcher that HOLDS the lease', async () => {
    // Positive control: without this, the test below would also pass if the gate
    // had simply stopped working.
    const result: any = await runScheduledChat({ ...dream100, runResults: [] }, USER_ID, false);

    expect(result.status).toBe('skipped_account_disconnected');
    expect(result.sessionId).toBe('');
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    expect(mockScheduleDb.addRunResult).toHaveBeenCalledWith(
      dream100.scheduleId,
      expect.objectContaining({ status: 'skipped_account_disconnected' }),
    );
  });

  it('writes NOTHING for the dispatcher that loses the lease', async () => {
    // The regression. With the gate ahead of the lease, this second dispatcher
    // evaluated it, appended its own skip row, and counted the same streak — so a
    // two-instance fleet recorded two skips per fire.
    mockScheduleDb.setRunInFlight.mockResolvedValue('already_in_flight' as any);

    await runScheduledChat({ ...dream100, runResults: [] }, USER_ID, false);

    expect(mockScheduleDb.addRunResult).not.toHaveBeenCalled();
    // It must not even probe Unipile: the run is not ours to evaluate.
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it('still runs ahead of the model, so the wasted spend is still avoided', async () => {
    await runScheduledChat({ ...dream100, runResults: [] }, USER_ID, false);

    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
  });

  it('reports the real elapsed time rather than a hard-coded zero', async () => {
    // The gate probes Unipile over the network; reporting 0 hides that cost from run
    // history, where the sibling ENG-1259 skip records it. Asserting `>= 0` would
    // pass ON the defect, so give the probe measurable duration and require it back.
    mockProbe.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return 'disconnected';
    });

    const result: any = await runScheduledChat({ ...dream100, runResults: [] }, USER_ID, false);

    expect(result.executionTime).toBeGreaterThanOrEqual(25);
  });
});

describe('runs that must never be gated', () => {
  it('lets a test run through', async () => {
    await runScheduledChat({ ...dream100, runResults: [] }, USER_ID, true);

    expect(mockProbe).not.toHaveBeenCalled();
  });

  it('lets a run parked on the customer through', async () => {
    await runScheduledChat(
      { ...dream100, runResults: [{ status: 'pending_user_input', passed: false, createdAt: '2026-08-16T17:00:00Z' }] },
      USER_ID,
      false,
    );

    expect(mockProbe).not.toHaveBeenCalled();
  });

  it('lets a reconciler-marked resume through even though its last result is a failure', async () => {
    // ENG-657/971: `claimAbandonedRun` sets `pendingResumeSessionId` on requeue and
    // writes no `pending_user_input` result — the last one recorded is typically a
    // failure. Keying the exclusion on the run result alone let that run reach the
    // gate and be skipped, stranding the very mid-flight session the exclusion
    // exists to protect.
    await runScheduledChat(
      {
        ...dream100,
        pendingResumeSessionId: 'abandoned-session-1',
        runResults: [{ status: 'failure', passed: false, createdAt: '2026-08-16T17:00:00Z' }],
      },
      USER_ID,
      false,
    );

    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockScheduleDb.addRunResult).not.toHaveBeenCalledWith(
      dream100.scheduleId,
      expect.objectContaining({ status: 'skipped_account_disconnected' }),
    );
  });
});

describe('the pause email says what it means', () => {
  it('counts skipped RUNS as runs, and elapsed days from the real disconnect time', async () => {
    // These were the same field. A schedule firing every 3 days reported "5 days"
    // for what was 5 runs across 15 days; one firing twice a day overstated it.
    const disconnectedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    mockGetHealth.mockResolvedValue({ needs_reconnect: true, disconnected_at: disconnectedAt });

    await runScheduledChat(
      {
        ...dream100,
        runResults: [
          accountSkip('2026-08-01T17:00:00Z'),
          accountSkip('2026-08-04T17:00:00Z'),
          accountSkip('2026-08-07T17:00:00Z'),
          accountSkip('2026-08-10T17:00:00Z'),
        ],
      },
      USER_ID,
      false,
    );

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      dream100.scheduleId,
      expect.objectContaining({ status: 'paused', pausedReason: 'linkedin_disconnected' }),
    );
    expect(mockEmail).toHaveBeenCalledWith(
      ['jennifer.sun@tfaconnect.com'],
      expect.objectContaining({
        skippedRunCount: 5,
        daysDisconnected: 15,
        disconnectedAt,
        pausedScheduleName: dream100.scheduleName,
      }),
    );
  });

  it('does not pause below the cap', async () => {
    await runScheduledChat(
      { ...dream100, runResults: [accountSkip('2026-08-10T17:00:00Z')] },
      USER_ID,
      false,
    );

    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalledWith(
      dream100.scheduleId,
      expect.objectContaining({ status: 'paused' }),
    );
    expect(mockEmail).not.toHaveBeenCalled();
  });
});
