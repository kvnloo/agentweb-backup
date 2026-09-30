/**
 * ENG-2204 follow-up — prod incident, 2026-09-29.
 *
 * A schedule with BOTH `slack_send_message` in `requiredFunctionCalls` AND
 * `requireSlackApproval: true` produced a live contradiction in production:
 * turn 1 correctly withheld the send (drafted to the knowledge base, exactly
 * as the withhold directive instructs) — then the deterministic
 * required-function checker, blind to the withhold state, pressed "Please try
 * again. Make sure to slack_send_message (1 more time needed)." The model
 * complied with the press over the withhold instruction on turn 2, and the
 * message actually posted to a real Slack channel, defeating the opt-out
 * entirely. See `filterSlackSendFromRequiredIfWithheld` in
 * schedulePublishApproval.ts for the fix: strip `slack_send_message` out of
 * the requirement list up front on a withheld schedule, so the checker never
 * has anything to press for in the first place.
 */
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => [
    'slack_send_message',
    'list_knowledge_base_files',
    'create_knowledge_base',
    'get_marketing_tips',
    'save_memory',
    'create_work_plan',
    'modify_work_plan',
    'set_work_plan_status',
  ]),
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
    updateSessionPublishAdmission: jest.fn(),
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

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-run-id-2204-followup') }));

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

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

// What a correctly-withheld run actually says on turn 1 in production — drafts
// and persists instead of sending, exactly per the withhold directive.
const WITHHELD_REPLY = [
  'Action Status: Nothing was sent to Slack. The message has been drafted and',
  'saved, but delivery was withheld because Require approval before Slack',
  'sends is turned ON for this schedule.',
].join(' ');

const slackSchedule = {
  scheduleId: 'schedule-2204-followup',
  scheduleName: 'ENG-2204 withheld + required regression',
  startingMessage: 'Post a status update to Slack.',
  keywords: [],
  requiredFunctionCalls: ['slack_send_message'],
  functionCallMinCalls: {},
  requireSlackApproval: true,
  userId: 'kevin',
};

const session = {
  sessionId: 'session-2204-followup',
  userId: 'kevin',
  title: 'Scheduled: ENG-2204 withheld + required regression',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const workerReply = (toolCalls: Array<{ name: string; arguments: any }>, content = WITHHELD_REPLY) => ({
  content,
  toolCalls,
  knowledgeBaseQueries: [],
  sources: [],
  responseMessages: [],
});

describe('runScheduledChat — withheld slack_send_message must never be pressed (ENG-2204 follow-up)', () => {
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
    (mockAgentModeService as any).generateScheduledChatSummary.mockResolvedValue('Withheld — draft saved');
    mockScheduleDb.addRunResult.mockResolvedValue(undefined as any);
    mockScheduleDb.getScheduleById.mockResolvedValue(slackSchedule as any);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([] as any);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined as any);
  });

  it('PRE-FIX REPRODUCTION shape: a compliant turn-1 withhold must not leave slack_send_message unmet and press for a retry', async () => {
    // The model does exactly what the withhold directive asks: it never calls
    // slack_send_message. Before the fix this schedule's OWN
    // requiredFunctionCalls still named the tool, so the checker saw it unmet
    // and pressed "Please try again... (1 more time needed)" on turn 2 — the
    // exact prompt-versus-checker contradiction that let a second, real send
    // through in production. After the fix, the schedule being withheld means
    // slack_send_message was never a real requirement for this run at all.
    mockWorker.runInWorker.mockResolvedValue(workerReply([]) as any);

    const result = await runScheduledChat(slackSchedule, 'kevin', true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
    expect(result.attempt).toBe(1);
    expect(result.functionCallMisses).toEqual([]);
    expect(result.status).toBe('success');
  });

  it('the persisted record does not report slack_send_message as a requirement on a withheld run', async () => {
    mockWorker.runInWorker.mockResolvedValue(workerReply([]) as any);

    await runScheduledChat(slackSchedule, 'kevin', false);

    const persisted = (mockScheduleDb.addRunResult as jest.Mock).mock.calls[0][1];
    expect(persisted.functionCallDetails?.slack_send_message).toBeUndefined();
    expect(persisted.functionCallMisses).toEqual([]);
  });

  it('control: the SAME schedule with approval OFF still genuinely requires and presses for slack_send_message', async () => {
    const authorizedSchedule = { ...slackSchedule, scheduleId: 'schedule-2204-authorized', requireSlackApproval: false };
    mockScheduleDb.getScheduleById.mockResolvedValue(authorizedSchedule as any);
    // Model never calls it even though authorized — this is the ENG-1715
    // send-press breaker's job, capped at 2, not this fix's job. Confirms the
    // withhold-stripping above is scoped to withheld schedules only.
    mockWorker.runInWorker.mockResolvedValue(workerReply([], 'Nothing to report.') as any);

    const result = await runScheduledChat(authorizedSchedule, 'kevin', true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(2);
    expect(result.functionCallMisses).toEqual(['slack_send_message']);
    expect((result as any).sendPressExhausted).toBe(true);
  });

  it('a mixed requirement set still holds the non-Slack tool to its full budget while excluding only slack_send_message', async () => {
    const mixedSchedule = {
      ...slackSchedule,
      scheduleId: 'schedule-2204-mixed',
      requiredFunctionCalls: ['slack_send_message', 'save_memory'],
    };
    mockScheduleDb.getScheduleById.mockResolvedValue(mixedSchedule as any);
    // save_memory is never called either — a genuinely unmet, non-Slack
    // requirement that must still be pressed to the full 20-attempt budget,
    // proving the fix narrows ONLY slack_send_message and does not
    // accidentally waive the rest of the schedule's requirements.
    mockWorker.runInWorker.mockResolvedValue(workerReply([]) as any);

    const result = await runScheduledChat(mixedSchedule, 'kevin', true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(20);
    expect(result.functionCallMisses).toEqual(['save_memory']);
  });
});
