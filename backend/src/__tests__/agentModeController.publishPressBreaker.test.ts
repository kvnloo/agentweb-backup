/**
 * ENG-947 — a scheduled publishing run whose model will not call the publish tool
 * must stop being re-pressed after a small, bounded number of attempts.
 *
 * Production shape (schedule 34154af9…, "Kevin — X Evening Post"): the schedule
 * requires `post_on_connected_account`; since 2026-07-31 every run ends at
 * attempt 20 having never posted, because each unmet-requirement retry re-sends
 * "Please try again. Make sure to post_on_connected_account (1 more time
 * needed)." and re-writes the whole prompt prefix. 55-69 messages, ~$6/run.
 */
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => [
    'post_on_connected_account',
    'get_marketing_tips',
    'create_work_plan',
    'modify_work_plan',
    'set_work_plan_status',
  ]),
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

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    resolveGenerationModel: jest.fn((model: string) => ({ model, fellBack: false, requestedModel: model })),
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getScheduledChatsDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    generateScheduledChatSummary: jest.fn(),
    generateMarketingResponse: jest.fn(),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set(['read_file_content'])),
    getAdminToolNames: jest.fn().mockReturnValue([]),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn() },
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
    createSchedule: jest.fn(),
    updateSchedule: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn().mockResolvedValue({ userId: 'kevin', email: 'owner@example.com', isAdmin: false }),
  },
}));

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-run-id-947') }));

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
    allowed: true, warning: false, used: 1, allowance: 100, bonus: 0,
    effectiveAllowance: 100, percentUsed: 1, month: '2026-08',
  })),
}));

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { runScheduledChat } from '../controllers/agentModeController';
import { MAX_PUBLISH_PRESS_ATTEMPTS } from '../utils/publishPressCircuitBreaker';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

// What the real runs produce: a complete, on-brand draft plus a stated refusal to
// push it live without a human. Deliberately NOT a cadence-skip phrasing.
const REFUSAL = [
  'I drafted the post and saved it to the knowledge base.',
  'I am holding it rather than calling post_on_connected_account: this is an unattended',
  'scheduled run and publishing to the live account needs a human to approve the final text.',
].join(' ');

const publishSchedule = {
  scheduleId: 'schedule-947',
  scheduleName: 'Kevin — X Evening Post',
  startingMessage: 'Draft the evening X post and publish it.',
  keywords: [],
  requiredFunctionCalls: ['post_on_connected_account'],
  functionCallMinCalls: {},
  userId: 'kevin',
};

const session = {
  sessionId: 'session-947',
  userId: 'kevin',
  title: 'Scheduled: Kevin — X Evening Post',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const workerReply = (toolCalls: Array<{ name: string; arguments: any }>, content = REFUSAL) => ({
  content,
  toolCalls,
  knowledgeBaseQueries: [],
  sources: [],
  responseMessages: [],
});

describe('runScheduledChat — publish-press circuit breaker (ENG-947)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.createChatSession.mockResolvedValue(session as any);
    mockChatbotDb.getChatSession.mockResolvedValue(session as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([{ role: 'assistant', content: 'x' }]);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(session as any);
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');
    (mockAgentModeService as any).generateScheduledChatSummary.mockResolvedValue('Post Drafted');
    mockScheduleDb.addRunResult.mockResolvedValue(undefined as any);
    mockScheduleDb.getScheduleById.mockResolvedValue(publishSchedule as any);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([] as any);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined as any);
  });

  it('stops re-pressing a run that will not call the publish tool, instead of burning all 20 attempts', async () => {
    mockWorker.runInWorker.mockResolvedValue(workerReply([{ name: 'update_knowledge_base_file', arguments: {} }]) as any);

    const result = await runScheduledChat(publishSchedule, 'kevin', true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(MAX_PUBLISH_PRESS_ATTEMPTS);
    expect(result.attempt).toBe(MAX_PUBLISH_PRESS_ATTEMPTS);
    expect(result.functionCallMisses).toEqual(['post_on_connected_account']);
    expect((result as any).publishHeldForApproval).toBe(true);
    // Still a failure: nothing was published, so escalation must keep working.
    expect(result.status).toBe('failure');
    expect(result.passed).toBe(false);
  });

  it('persists the held-for-approval marker on the stored run result', async () => {
    mockWorker.runInWorker.mockResolvedValue(workerReply([]) as any);

    await runScheduledChat(publishSchedule, 'kevin', false);

    expect(mockScheduleDb.addRunResult).toHaveBeenCalledWith(
      'schedule-947',
      expect.objectContaining({ publishHeldForApproval: true, status: 'failure' })
    );
  });

  it('does not rob a run that complies on a later press — the pre-regression behaviour', async () => {
    let calls = 0;
    mockWorker.runInWorker.mockImplementation(() => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? workerReply([{ name: 'update_knowledge_base_file', arguments: {} }])
          : workerReply([{ name: 'post_on_connected_account', arguments: {} }], 'Posted to X.')
      ) as any;
    });

    const result = await runScheduledChat(publishSchedule, 'kevin', true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('success');
    expect(result.attempt).toBe(2);
    expect((result as any).publishHeldForApproval).toBeUndefined();
  });

  it('leaves NON-publish requirements on the full retry budget', async () => {
    const readOnlySchedule = {
      ...publishSchedule,
      requiredFunctionCalls: ['get_marketing_tips'],
    };
    mockScheduleDb.getScheduleById.mockResolvedValue(readOnlySchedule as any);
    mockWorker.runInWorker.mockResolvedValue(workerReply([], 'Here is a summary.') as any);

    const result = await runScheduledChat(readOnlySchedule, 'kevin', true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(20);
    expect(result.attempt).toBe(20);
    expect((result as any).publishHeldForApproval).toBeUndefined();
  });

  it('still gives a WORK-PLAN run its two dedicated presses — plan reminders must not spend the publish budget', async () => {
    // The model opens by creating a work plan, so the first retry is the generic
    // "Please perform the work on pending steps." reminder, which never names the
    // publish tool. Counting that against the publish budget would cut the run off
    // having never asked it to publish at all.
    let workerCalls = 0;
    mockChatbotDb.getChatSession.mockImplementation(async () => ({
      ...session,
      // Completed from the moment the second turn lands; before that the run is
      // still working the plan.
      workPlan: { steps: [{ status: workerCalls >= 2 ? 'completed' : 'pending' }] },
    }) as any);
    mockWorker.runInWorker.mockImplementation(() => {
      workerCalls++;
      return Promise.resolve(workerReply([{ name: 'update_knowledge_base_file', arguments: {} }])) as any;
    });

    const result = await runScheduledChat(publishSchedule, 'kevin', true);

    // One turn spent on the plan, then the publish-only state is reached and the
    // budget (initial + two presses) is spent from there: 1 + 3 turns.
    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(MAX_PUBLISH_PRESS_ATTEMPTS + 1);
    const pressMessages = mockWorker.runInWorker.mock.calls.map((call: any[]) => call[0].messageContent);
    expect(pressMessages[1]).toContain('pending steps');
    expect(pressMessages[1]).not.toContain('post_on_connected_account');
    // Two presses that actually ask for the publish, exactly as documented.
    expect(pressMessages.filter((m: string) => m.includes('post_on_connected_account'))).toHaveLength(2);
    expect((result as any).publishHeldForApproval).toBe(true);
    expect(result.status).toBe('failure');
  });

  it('leaves a MIXED requirement set on the full retry budget', async () => {
    const mixedSchedule = {
      ...publishSchedule,
      requiredFunctionCalls: ['post_on_connected_account', 'get_marketing_tips'],
    };
    mockScheduleDb.getScheduleById.mockResolvedValue(mixedSchedule as any);
    mockWorker.runInWorker.mockResolvedValue(workerReply([]) as any);

    const result = await runScheduledChat(mixedSchedule, 'kevin', true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(20);
    expect((result as any).publishHeldForApproval).toBeUndefined();
  });
});
