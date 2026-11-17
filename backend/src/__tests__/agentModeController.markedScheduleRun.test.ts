/**
 * ENG-2816 (step 3): a run of a schedule a share-link visitor wrote content into is refused some tools (executeTool, live). The
 * deterministic required-function checker must not demand those tools, or it nags the run through every retry and the owner pays
 * for up to twenty refused attempts. So for a MARKED schedule:
 *  - the refused names are dropped from `requiredFunctionCalls` and `functionCallMinCalls`, in the run, in its record, and in the
 *    abandoned-run recovery record;
 *  - the retry cap is small, not 20.
 * An UNMARKED schedule (every schedule that predates the change) is held to exactly what it stores and keeps its 20 attempts.
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
    updateSessionPublishAdmission: jest.fn().mockResolvedValue(undefined),
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
    generateScheduledChatSummary: jest.fn(),
    installSkills: jest.fn().mockResolvedValue({ success: true, installedSkills: [] }),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set()),
    getAdminToolNames: jest.fn().mockReturnValue([]),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn(), releaseSessionClients: jest.fn(), cancelSession: jest.fn() },
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
    updateSchedule: jest.fn(),
    getSchedulesByUserId: jest.fn(),
    appendDeliveryLogEntry: jest.fn().mockResolvedValue(undefined),
    getRunResults: jest.fn(),
  },
  userDb: { getUserById: jest.fn(), getUserByEmail: jest.fn() },
  taskDb: { getTaskExecutionById: jest.fn(), createTaskExecution: jest.fn(), updateTaskExecution: jest.fn() },
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
    sendScheduleSourcingBlockTransitionEmail: jest.fn(),
    notifyScheduledReportWithheld: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/tokenUsageService', () => ({
  ...jest.requireActual('../services/tokenUsageService'),
  checkTokenUsage: jest.fn(async () => ({
    allowed: true, warning: false, used: 100000, allowance: 1000000, bonus: 0, effectiveAllowance: 1000000, percentUsed: 10, month: '2026-04',
  })),
}));

jest.mock('../utils/agentModeAlerts', () => ({ sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/intakeService', () => ({ fileAutoIssue: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/skillService', () => ({ skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]) } }));

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb, userDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { runScheduledChat, recoverAbandonedScheduledRun } from '../controllers/agentModeController';
import { MARKED_RUN_MAX_ATTEMPTS } from '../utils/scheduleProvenance';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

const USER = 'owner-user';
const schedule = (over: Record<string, unknown> = {}) => ({
  scheduleId: 'sched-1',
  scheduleName: 'Weekly report',
  startingMessage: 'Write the weekly report',
  keywords: ['marketing'],
  requiredFunctionCalls: ['get_marketing_tips', 'save_memory', 'luma_get_guests'],
  functionCallMinCalls: { save_memory: 2, get_marketing_tips: 1 },
  userId: USER,
  nextRunTime: new Date().toISOString(),
  ...over,
});
const session = { sessionId: 'run-session', userId: USER, title: 'Run', messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
// A run that satisfied only what a marked run may be asked for.
const partial = { content: 'A marketing summary.', toolCalls: [{ name: 'get_marketing_tips', arguments: {} }], knowledgeBaseQueries: [], sources: [], responseMessages: [] };
const nothing = { ...partial, content: 'General tips only.', toolCalls: [] };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  mockChatbotDb.createChatSession.mockResolvedValue(session as any);
  mockChatbotDb.getChatSession.mockResolvedValue(session as any);
  mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
  mockChatbotDb.updateSessionLlmModel.mockResolvedValue(session as any);
  (mockChatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([]);
  mockService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
  mockService.getScheduledChatsDefaultModel.mockResolvedValue('gpt-5-chat-2');
  mockService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
  mockService.generateSessionTitle.mockResolvedValue('Title');
  mockService.generateScheduledChatSummary.mockResolvedValue(null);
  (mockScheduleDb.updateSchedule as jest.Mock).mockResolvedValue(undefined);
  mockScheduleDb.addRunResult.mockResolvedValue(undefined);
  mockScheduleDb.getScheduleById.mockResolvedValue(schedule() as any);
  mockUserDb.getUserById.mockResolvedValue({ userId: USER, email: 'owner@example.com' } as any);
});
afterEach(() => jest.restoreAllMocks());

describe('a MARKED schedule\'s run (ENG-2816 step 3)', () => {
  const markedSchedule = () => schedule({ provenance: ['requiredFunctionCalls', 'startingMessage'] });

  it('is not required to call a tool its run is refused: it passes on what it could do, with no refused tool listed as missed', async () => {
    mockWorker.runInWorker.mockResolvedValue(partial as any);

    const result = await runScheduledChat(markedSchedule(), USER, true);

    expect(result).toMatchObject({
      status: 'success',
      passed: true,
      attempt: 1,
      functionCallMatches: ['get_marketing_tips'],
      functionCallMisses: [],
    });
    expect(result.functionCallDetails).toEqual({ get_marketing_tips: { actual: 1, required: 1 } });
    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('control: the SAME schedule without provenance is still held to every tool it stores', async () => {
    mockWorker.runInWorker.mockResolvedValue(partial as any);

    const result = await runScheduledChat(schedule(), USER, true);

    expect(result.passed).toBe(false);
    expect(result.functionCallMisses).toEqual(expect.arrayContaining(['save_memory', 'luma_get_guests']));
    expect(result.functionCallDetails).toMatchObject({ save_memory: { required: 2 } });
  });

  it('gets a small retry cap, where an unmarked run keeps its 20', async () => {
    mockWorker.runInWorker.mockResolvedValue(nothing as any);

    const markedResult = await runScheduledChat(markedSchedule(), USER, true);
    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(MARKED_RUN_MAX_ATTEMPTS);
    expect(markedResult.attempt).toBe(MARKED_RUN_MAX_ATTEMPTS);

    mockWorker.runInWorker.mockClear();
    await runScheduledChat(schedule(), USER, true);
    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(20);
  });

  it('reads an unreadable provenance value as marked (small cap, refused tools dropped)', async () => {
    mockWorker.runInWorker.mockResolvedValue(nothing as any);
    await runScheduledChat(schedule({ provenance: 17 }), USER, true);
    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(MARKED_RUN_MAX_ATTEMPTS);
  });

  it('the abandoned-run failure record does not list a refused tool as missed', async () => {
    const stale = markedSchedule();
    const lease = { runId: 'run-1', sessionId: '', startedAt: new Date().toISOString(), instanceId: 'dead', heartbeatAt: new Date().toISOString() };

    await recoverAbandonedScheduledRun({ ...stale, status: 'paused' }, lease);

    const recorded = mockScheduleDb.addRunResult.mock.calls.map((call) => call[1] as any).find((r) => r.abandoned);
    expect(recorded.functionCallMisses).toEqual(['get_marketing_tips']);
  });

  it('control: an unmarked abandoned run still lists every stored requirement', async () => {
    const lease = { runId: 'run-1', sessionId: '', startedAt: new Date().toISOString(), instanceId: 'dead', heartbeatAt: new Date().toISOString() };

    await recoverAbandonedScheduledRun({ ...schedule(), status: 'paused' }, lease);

    const recorded = mockScheduleDb.addRunResult.mock.calls.map((call) => call[1] as any).find((r) => r.abandoned);
    expect(recorded.functionCallMisses).toEqual(['get_marketing_tips', 'save_memory', 'luma_get_guests']);
  });
});

// The executeTool gate judges "could not be verified" by attendance: an unverifiable answer refuses a caller that says it is
// UNATTENDED (isUnattendedRun === true) and leaves anyone else alone. So every entry that runs a schedule's turns must say so. They
// all end in the worker, which receives the flag per turn and hands it to every tool call (executePreparedAgentTool).
describe('every entry that runs a schedule\'s turns says it is unattended (ENG-2816 step 3)', () => {
  const workerFlags = () => mockWorker.runInWorker.mock.calls.map((call) => (call[0] as any).isUnattendedRun);

  it('a real run: the first attempt AND every retry', async () => {
    mockWorker.runInWorker.mockResolvedValue(nothing as any);
    await runScheduledChat(schedule({ provenance: ['startingMessage'] }), USER, false);
    expect(workerFlags()).toHaveLength(MARKED_RUN_MAX_ATTEMPTS);
    expect(workerFlags().every((flag) => flag === true)).toBe(true);
  });

  it('a test run (test_scheduled_chat) shares the same path', async () => {
    mockWorker.runInWorker.mockResolvedValue(nothing as any);
    await runScheduledChat(schedule({ provenance: ['startingMessage'] }), USER, true);
    expect(workerFlags().length).toBeGreaterThan(0);
    expect(workerFlags().every((flag) => flag === true)).toBe(true);
  });

  it('the self-improvement reflection turn is unattended too (it is a second worker turn after the run)', async () => {
    mockWorker.runInWorker.mockResolvedValue(partial as any);
    await runScheduledChat(schedule({ provenance: ['startingMessage'], selfImprove: true, requiredFunctionCalls: ['get_marketing_tips'], functionCallMinCalls: {} }), USER, false);
    expect(workerFlags().length).toBeGreaterThanOrEqual(2);
    expect(workerFlags().every((flag) => flag === true)).toBe(true);
  });
});

// ENG-2816 (step 3): the other "unattended default = authorized" gate, Slack sends (ENG-2204), treats a marked schedule as WITHHELD
// the way `requireSlackApproval: true` does: the checker stops demanding the send, and the mid-run notice stops granting the bypass.
describe('Slack sends of a MARKED schedule are withheld (ENG-2816 step 3)', () => {
  const slackSchedule = (over: Record<string, unknown> = {}) =>
    schedule({ requiredFunctionCalls: ['get_marketing_tips', 'slack_send_message'], functionCallMinCalls: {}, ...over });

  it('is not required to call slack_send_message, so it passes on what it did; an unmarked run still must', async () => {
    mockWorker.runInWorker.mockResolvedValue(partial as any);

    const marked = await runScheduledChat(slackSchedule({ provenance: ['startingMessage'] }), USER, true);
    expect(marked).toMatchObject({ passed: true, functionCallMatches: ['get_marketing_tips'], functionCallMisses: [] });

    const unmarked = await runScheduledChat(slackSchedule(), USER, true);
    expect(unmarked.passed).toBe(false);
    expect(unmarked.functionCallMisses).toEqual(['slack_send_message']);
  });

  describe('the mid-run notice (re-injected when consent is withdrawn while the run is in flight)', () => {
    const grantedPublisher = (over: Record<string, unknown> = {}) => slackSchedule({
      requiredFunctionCalls: ['post_on_connected_account'], keywords: [],
      autopublishAuthorized: true, autopublishAuthorizedTools: ['post_on_connected_account'], ...over,
    });
    const firstMessage = () => (mockWorker.runInWorker.mock.calls[0][0] as any).messageContent as string;
    beforeEach(() => mockWorker.runInWorker.mockResolvedValue({ ...nothing, content: 'Drafted.' } as any));

    it('says Slack is withheld because a visitor wrote the schedule, when it is marked MID-RUN', async () => {
      // Admitted unmarked and authorized; by the first re-read a visitor has marked it.
      mockScheduleDb.getScheduleById.mockResolvedValue(grantedPublisher({ provenance: ['startingMessage'] }) as any);
      await runScheduledChat(grantedPublisher(), USER, true);
      const message = firstMessage();
      expect(message).toContain('[PUBLISH AUTHORIZATION WITHDRAWN]');
      expect(message).toContain('SLACK NOTIFICATIONS IN UNATTENDED RUNS — WITHHELD');
      expect(message).toContain('set up or edited through a share link and has not been adopted by its owner');
    });

    it('a run ADMITTED marked was admitted unauthorized, so there is nothing to withdraw and no notice (no bypass is injected)', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(grantedPublisher({ provenance: ['keywords'] }) as any);
      await runScheduledChat(grantedPublisher({ provenance: ['keywords'] }), USER, true);
      expect(firstMessage()).not.toContain('[PUBLISH AUTHORIZATION WITHDRAWN]');
      expect(firstMessage()).not.toContain('SLACK NOTIFICATIONS IN UNATTENDED RUNS (CRITICAL');
    });

    it('honours the owner\'s own Slack opt-out too (this notice used to ignore it)', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(grantedPublisher({ requireSlackApproval: true, autopublishAuthorized: false, autopublishAuthorizedTools: [] }) as any);
      await runScheduledChat(grantedPublisher({ requireSlackApproval: true }), USER, true);
      const message = firstMessage();
      expect(message).toContain('[PUBLISH AUTHORIZATION WITHDRAWN]');
      expect(message).toContain('SLACK NOTIFICATIONS IN UNATTENDED RUNS — WITHHELD');
      expect(message).toContain('The owner has turned ON "Require approval before Slack sends"');
    });

    it('an ordinary schedule keeps today\'s notice: Slack authorized', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(grantedPublisher({ autopublishAuthorized: false, autopublishAuthorizedTools: [] }) as any);
      await runScheduledChat(grantedPublisher(), USER, true);
      const message = firstMessage();
      expect(message).toContain('[PUBLISH AUTHORIZATION WITHDRAWN]');
      expect(message).toContain('SLACK NOTIFICATIONS IN UNATTENDED RUNS (CRITICAL');
      expect(message).not.toContain('WITHHELD (CRITICAL — ENG-2204)');
    });
  });
});
