/**
 * Scheduled-lane incident dedupe (ENG-147 remainder, ENG-145/146 class).
 *
 * Pins the two scheduled failure sites in runScheduledChat when the run
 * store is enabled:
 *  - both incident-filing sites (validation-fail + exception) pass the run's
 *    runId as fileAutoIssue dedupeKey → structurally one issue per run
 *  - both oncall-alert sites carry a (user, schedule, errorClass) dedupe key
 *    with a 1h window so one flapping schedule cannot flood oncall
 *  - flag off → today's exact behavior (no dedupeKey on either path)
 */
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => ['get_marketing_tips']),
  getAllowedSkills: jest.fn(async () => ['*']),
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
  claimIncident: jest.fn().mockResolvedValue(true),
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

describe('runScheduledChat — incident dedupe + alert keying (ENG-145/146 class)', () => {
  it('validation-fail site passes the runId as fileAutoIssue dedupeKey and keys the oncall alert per (user, schedule, errorClass) with a 1h window', async () => {
    const schedule = { ...baseSchedule, keywords: ['nevermatches'] };
    mockWorker.runInWorker.mockResolvedValue({ ...okResponse, content: 'nope' } as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([
      { role: 'assistant', content: 'nope' },
    ]);

    const result = await runScheduledChat(schedule, mockUserId, false, 'run-dedupe-1');
    await flushAsync();

    expect(result.passed).toBe(false);
    expect(fileAutoIssue).toHaveBeenCalledTimes(1);
    expect((fileAutoIssue as jest.Mock).mock.calls[0][0].dedupeKey).toBe('run-dedupe-1');

    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
    const alert = (sendAgentModeOncallAlert as jest.Mock).mock.calls[0][0];
    expect(alert.dedupeKey).toContain(mockUserId);
    expect(alert.dedupeKey).toContain(baseSchedule.scheduleId);
    expect(alert.dedupeKey).toContain('validation_failed');
    expect(alert.dedupeWindowMs).toBe(60 * 60 * 1000);
  }, 30000);

  it('exception site passes the SAME runId as dedupeKey → one issue per run, alert keyed per (user, schedule, errorClass)', async () => {
    mockWorker.runInWorker.mockRejectedValue(new Error('kaboom'));

    const result = await runScheduledChat({ ...baseSchedule }, mockUserId, false, 'run-dedupe-2');
    await flushAsync();

    expect(result.status).toBe('failure');
    expect(fileAutoIssue).toHaveBeenCalledTimes(1);
    expect((fileAutoIssue as jest.Mock).mock.calls[0][0].dedupeKey).toBe('run-dedupe-2');

    const alert = (sendAgentModeOncallAlert as jest.Mock).mock.calls[0][0];
    expect(alert.dedupeKey).toContain(mockUserId);
    expect(alert.dedupeKey).toContain(baseSchedule.scheduleId);
    expect(alert.dedupeWindowMs).toBe(60 * 60 * 1000);
  }, 30000);

  it('BEHAVIOR-PRESERVING: flag off → no dedupeKey on either the issue or the alert (today\'s exact behavior)', async () => {
    (mockRunStore.isRunStoreEnabled as jest.Mock).mockReturnValue(false);
    mockWorker.runInWorker.mockRejectedValue(new Error('kaboom'));

    await runScheduledChat({ ...baseSchedule }, mockUserId, false, 'run-dedupe-3');
    await flushAsync();

    expect(fileAutoIssue).toHaveBeenCalledTimes(1);
    expect((fileAutoIssue as jest.Mock).mock.calls[0][0].dedupeKey).toBeUndefined();

    expect(sendAgentModeOncallAlert).toHaveBeenCalled();
    const alert = (sendAgentModeOncallAlert as jest.Mock).mock.calls[0][0];
    expect(alert.dedupeKey).toBeUndefined();
  }, 30000);
});
