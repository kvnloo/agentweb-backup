/**
 * ENG-1715 — every `SEND_TOOLS` entry falls between the two existing press
 * breakers: not `isPublishName` (ENG-947), not `isReadOnlyToolName` (ENG-1297).
 * A scheduled run that cannot satisfy a send requirement therefore took the full
 * 20-attempt press with no breaker at all, re-sending "Make sure to
 * linkedin_outreach (N more times needed)" against the tool's own "DO NOT keep
 * trying other recipients — every send-invite will fail the same way until the
 * cooldown lifts."
 *
 * WHAT ACTUALLY TRIGGERS THE PRESS, and why AC #5 as filed cannot be reproduced
 * literally: `countCallsSatisfyingRequirement` credits an exact NAME match for a
 * non-publish tool even when the call FAILED, so ONE refused `send-invite`
 * already satisfies `min: 1` and no press ever starts. The press fires when the
 * run UNDER-CALLS the tool — which is what a schedule mandating several invites
 * hits when an account-level cooldown stops it at the first refusal. Every
 * scenario below is built on that real trigger.
 */
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => [
    'linkedin_outreach',
    'send_email',
    'post_on_connected_account',
    'get_marketing_tips',
    'save_memory',
    'create_work_plan',
    'modify_work_plan',
    'set_work_plan_status',
    // ENG-930: both real reported schedules also require generate_image
    // alongside post_on_connected_account.
    'generate_image',
  ]),
  // runScheduledChat gates on the 'scheduled_chats' subscription feature before
  // it runs a turn. Without this the module mock returns undefined, the gate
  // throws, and every assertion below fails against a run that never started.
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
    // ENG-827 stamps the run's publish admission before the first turn. A missing mock
    // throws, and the controller treats an unrecordable admission as draft-only — which
    // strips the publish tool out of requiredFunctionCalls, so the requirement is never
    // unmet and this suite's breaker never gets to fire.
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

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-run-id-1715') }));

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
import { MAX_SEND_PRESS_ATTEMPTS } from '../utils/sendPressCircuitBreaker';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

// What a cooldown-blocked outreach run actually says: it sent what it could, then
// stopped on the tool's own instruction. Deliberately NOT a cadence-skip phrasing.
const COOLDOWN_STOP = [
  'I sent the first connection request, then LinkedIn refused the next one with an',
  'account-level invitation cooldown. Per the tool guidance I stopped rather than',
  'trying the remaining recipients — every send-invite will fail the same way until it lifts.',
].join(' ');

const outreachSchedule = {
  scheduleId: 'schedule-1715',
  scheduleName: 'Daily LinkedIn invites',
  startingMessage: 'Send connection requests to five prospects.',
  keywords: [],
  requiredFunctionCalls: ['linkedin_outreach'],
  // Under-calling is the real trigger — see the file header.
  functionCallMinCalls: { linkedin_outreach: 5 },
  userId: 'kevin',
};

const session = {
  sessionId: 'session-1715',
  userId: 'kevin',
  title: 'Scheduled: Daily LinkedIn invites',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const workerReply = (toolCalls: Array<{ name: string; arguments: any }>, content = COOLDOWN_STOP) => ({
  content,
  toolCalls,
  knowledgeBaseQueries: [],
  sources: [],
  responseMessages: [],
});


const blockedInvite = {
  name: 'linkedin_outreach',
  arguments: { action: 'send-invite' },
  result: { success: false, error: 'Cannot resend yet — account-level invitation cooldown.' },
};
const sentInvite = {
  name: 'linkedin_outreach',
  arguments: { action: 'send-invite' },
  result: { success: true },
};

describe('runScheduledChat — send-press circuit breaker (ENG-1715)', () => {
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
    (mockAgentModeService as any).generateScheduledChatSummary.mockResolvedValue('Invites Blocked');
    mockScheduleDb.addRunResult.mockResolvedValue(undefined as any);
    mockScheduleDb.getScheduleById.mockResolvedValue(outreachSchedule as any);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([] as any);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined as any);
  });

  it('AC #1/#5: stops a cooldown-blocked outreach run at the send-press budget instead of 20 attempts', async () => {
    mockWorker.runInWorker.mockResolvedValue(workerReply([sentInvite, blockedInvite]) as any);

    const result = await runScheduledChat(outreachSchedule, 'kevin', true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(MAX_SEND_PRESS_ATTEMPTS);
    expect(result.attempt).toBe(MAX_SEND_PRESS_ATTEMPTS);
    expect(result.functionCallMisses).toEqual(['linkedin_outreach']);
  });

  it('AC #2: the verdict is unchanged — still a failure naming the unmet requirement', async () => {
    mockWorker.runInWorker.mockResolvedValue(workerReply([sentInvite, blockedInvite]) as any);

    const result = await runScheduledChat(outreachSchedule, 'kevin', true);

    expect(result.status).toBe('failure');
    expect(result.passed).toBe(false);
    expect((result as any).sendPressExhausted).toBe(true);
    // Not waived: unlike the read-only breaker, a send that did not happen is real
    // work left undone.
    expect((result as any).readOnlyRequirementWaived).toBeUndefined();
  });

  it('persists the marker on the stored run result so the early exit is observable', async () => {
    mockWorker.runInWorker.mockResolvedValue(workerReply([sentInvite, blockedInvite]) as any);

    await runScheduledChat(outreachSchedule, 'kevin', false);

    expect(mockScheduleDb.addRunResult).toHaveBeenCalledWith(
      'schedule-1715',
      expect.objectContaining({ sendPressExhausted: true, status: 'failure' })
    );
  });

  it('fires for a run that never calls the send tool at all, not just a blocked one', async () => {
    // The account is disconnected, or the model found nobody to contact. Pressing
    // it toward an external send it has declined is the ENG-1297 harm with an
    // irreversible action at the end of it.
    mockWorker.runInWorker.mockResolvedValue(workerReply([]) as any);

    const result = await runScheduledChat(
      { ...outreachSchedule, functionCallMinCalls: {} },
      'kevin',
      true,
    );

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(MAX_SEND_PRESS_ATTEMPTS);
    expect((result as any).sendPressExhausted).toBe(true);
  });

  it('does not rob a run that complies on the one allowed press', async () => {
    let calls = 0;
    mockWorker.runInWorker.mockImplementation(() => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? workerReply([sentInvite])
          : workerReply([sentInvite, sentInvite, sentInvite, sentInvite], 'Sent the remaining invitations.')
      ) as any;
    });

    const result = await runScheduledChat(outreachSchedule, 'kevin', true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('success');
    expect((result as any).sendPressExhausted).toBeUndefined();
  });

  it('AC #3: a MIXED unmet set keeps the full retry budget — the breaker fires only when the send is all that is left', async () => {
    // save_memory, not a read-only tool: it is a write, but neither publish- nor
    // send-classified, so NO breaker claims the set and the full budget applies.
    // Pairing with a read-only tool instead (get_marketing_tips) does not test this
    // — the requirement counter credits a FAILED linkedin_outreach call by name, so
    // the send requirement clears after a couple of attempts and the ENG-1297
    // read-only breaker correctly takes the turn from there.
    //
    // The minimum is set out of reach so the set stays genuinely mixed for the
    // whole run rather than collapsing to one unmet name partway through.
    const mixedSchedule = {
      ...outreachSchedule,
      requiredFunctionCalls: ['linkedin_outreach', 'save_memory'],
      functionCallMinCalls: { linkedin_outreach: 100 },
    };
    mockScheduleDb.getScheduleById.mockResolvedValue(mixedSchedule as any);
    mockWorker.runInWorker.mockResolvedValue(workerReply([sentInvite, blockedInvite]) as any);

    const result = await runScheduledChat(mixedSchedule, 'kevin', true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(20);
    expect(result.attempt).toBe(20);
    expect((result as any).sendPressExhausted).toBeUndefined();
  });

  it('covers the whole send class, not just LinkedIn — send_email behaves identically', async () => {
    const emailSchedule = {
      ...outreachSchedule,
      scheduleId: 'schedule-1715-email',
      requiredFunctionCalls: ['send_email'],
      functionCallMinCalls: {},
    };
    mockScheduleDb.getScheduleById.mockResolvedValue(emailSchedule as any);
    mockWorker.runInWorker.mockResolvedValue(workerReply([]) as any);

    const result = await runScheduledChat(emailSchedule, 'kevin', true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(MAX_SEND_PRESS_ATTEMPTS);
    expect((result as any).sendPressExhausted).toBe(true);
  });

  it('AC #4: an unmet PUBLISH requirement still gets the publish breaker, not this one', async () => {
    const publishSchedule = {
      ...outreachSchedule,
      scheduleId: 'schedule-1715-publish',
      requiredFunctionCalls: ['post_on_connected_account'],
      functionCallMinCalls: {},
    };
    mockScheduleDb.getScheduleById.mockResolvedValue(publishSchedule as any);
    mockWorker.runInWorker.mockResolvedValue(workerReply([]) as any);

    const result = await runScheduledChat(publishSchedule, 'kevin', true);

    // 3, the publish budget — not this breaker's 2.
    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(3);
    expect((result as any).sendPressExhausted).toBeUndefined();
    expect((result as any).publishHeldForApproval).toBe(true);
  });
});
