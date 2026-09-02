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

  it('leaves a non-publish WRITE requirement on the full retry budget', async () => {
    // save_memory is a write (it has an external side effect) but not publish-classified
    // and not read-only, so NEITHER the ENG-947 publish breaker NOR the ENG-1297
    // read-only breaker should touch it — this is the ENG-947 breaker's own scope
    // boundary. (get_marketing_tips used to sit here, but it's read-only and is now
    // deliberately capped early by the ENG-1297 breaker — see
    // readOnlyPressCircuitBreaker.test.ts and the scheduledChat.test.ts coverage for
    // that case.)
    const nonPublishWriteSchedule = {
      ...publishSchedule,
      requiredFunctionCalls: ['save_memory'],
    };
    mockScheduleDb.getScheduleById.mockResolvedValue(nonPublishWriteSchedule as any);
    mockWorker.runInWorker.mockResolvedValue(workerReply([], 'Here is a summary.') as any);

    const result = await runScheduledChat(nonPublishWriteSchedule, 'kevin', true);

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

  it('does not let a FAILED publish satisfy the requirement', async () => {
    // Live preview repro (2026-08-11): the model called post_on_connected_account,
    // the tool errored with "Multiple twitter accounts connected", NOTHING was
    // posted — and the run was stored as success with the requirement matched,
    // because the ledger counted the attempt. The owner is told their post went
    // out when it did not.
    mockWorker.runInWorker.mockResolvedValue(workerReply([
      { name: 'post_on_connected_account', arguments: {}, error: 'Multiple twitter accounts connected' } as any,
    ], 'I attempted the post.') as any);

    const result = await runScheduledChat(publishSchedule, 'kevin', true);

    expect(result.status).toBe('failure');
    expect(result.passed).toBe(false);
    expect(result.functionCallMatches).toEqual([]);
    expect(result.functionCallMisses).toEqual(['post_on_connected_account']);
    // And the run is still capped rather than pressed to 20 — the two fixes compose.
    expect(result.attempt).toBe(MAX_PUBLISH_PRESS_ATTEMPTS);
    // The model DID reach for the tool and it errored every time, so this is a
    // broken integration, NOT content waiting on the owner. Reporting it as
    // held-for-approval (as this originally did) sends them to an empty approval
    // queue instead of to Settings → Connected Accounts. Re-confirmed live on
    // preview session 42004fa0 (2026-08-13), where all three presses came back
    // "No twitter account connected".
    expect((result as any).publishToolFailing).toBe(true);
    expect((result as any).publishHeldForApproval).toBeUndefined();
  });

  it('leaves a failed NON-publish required call counting as met, exactly as before', async () => {
    // The blast-radius guard. Only irreversible publishes are tightened; every
    // other scheduled run keeps the historical attempted-counts-as-met rule, so
    // this change cannot start failing runs that pass today.
    const readOnlySchedule = { ...publishSchedule, requiredFunctionCalls: ['get_marketing_tips'] };
    mockScheduleDb.getScheduleById.mockResolvedValue(readOnlySchedule as any);
    mockWorker.runInWorker.mockResolvedValue(workerReply([
      { name: 'get_marketing_tips', arguments: {}, error: 'upstream 500' } as any,
    ], 'Here is a summary.') as any);

    const result = await runScheduledChat(readOnlySchedule, 'kevin', true);

    expect(result.status).toBe('success');
    expect(result.functionCallMisses).toEqual([]);
    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
  });

  /**
   * ENG-1599 review (CodeRabbit) correction: this used to mock
   * `arguments: { action: 'post' }` — not a real API value; the actual tool only
   * ever sends `post_thread`/`reply`/`quote_tweet`/`retweet`. That placeholder
   * accidentally dodged completion crediting and forced the run down the
   * mismatch path. With the REAL action, `callSatisfiesRequirement` already
   * credits `twitter_manage_post`/`post_thread` toward a `post_on_connected_
   * account` requirement (the ENG-1045 forward equivalence route, which
   * predates this PR and was never in question) — so a genuine post_thread
   * publish for THIS schedule (single required tool, no double-requirement
   * suppression) correctly reports `success`, not a mismatch. That is the
   * right outcome: the schedule's mandated content really did go out.
   */
  it('credits a THREAD published via twitter_manage_post as completing post_on_connected_account', async () => {
    mockWorker.runInWorker.mockResolvedValue(workerReply([
      { name: 'twitter_manage_post', arguments: { action: 'post_thread' } },
    ], 'Thread published.') as any);

    const result = await runScheduledChat(publishSchedule, 'kevin', true);

    expect(result.attempt).toBe(1);
    expect(result.status).toBe('success');
    expect((result as any).publishHeldForApproval).toBeUndefined();
    expect((result as any).publishRequirementMismatch).toBeUndefined();
  });

  it('persists success, with neither the mismatch nor the held marker, on the stored result', async () => {
    mockWorker.runInWorker.mockResolvedValue(workerReply([
      { name: 'twitter_manage_post', arguments: { action: 'post_thread' } },
    ], 'Thread published.') as any);

    await runScheduledChat(publishSchedule, 'kevin', false);

    const stored = mockScheduleDb.addRunResult.mock.calls[0][1] as any;
    expect(stored.status).toBe('success');
    expect(stored.publishRequirementMismatch).toBeUndefined();
    expect(stored.publishHeldForApproval).toBeUndefined();
  });

  /**
   * The genuine mismatch case (kept, corrected): a `twitter_manage_post` REPLY
   * is neither a match for `post_on_connected_account`'s route (scoped to
   * `post_thread` only — a reply to someone else's tweet is not "the
   * schedule's own content going out") nor evidence the required tool was
   * ever reached. Nothing was withheld and nothing was published toward THIS
   * requirement, so it is a genuine, ordinary withhold — not a mismatch.
   */
  it('does not credit or misreport an unrelated twitter_manage_post action (a reply)', async () => {
    mockWorker.runInWorker.mockResolvedValue(workerReply([
      { name: 'twitter_manage_post', arguments: { action: 'reply' } },
    ], 'Replied to a mention.') as any);

    const result = await runScheduledChat(publishSchedule, 'kevin', true);

    expect(result.status).toBe('failure');
    expect((result as any).publishRequirementMismatch).toBeUndefined();
  });

  it('a FAILED thread publish is still held for approval — nothing went out', async () => {
    // The evidence must be a SUCCEEDED write. If twitter_manage_post errored, the
    // thread is not live and the owner really is the blocker, so the approval
    // signal must survive.
    mockWorker.runInWorker.mockResolvedValue(workerReply([
      { name: 'twitter_manage_post', arguments: { action: 'post_thread' }, error: 'rate limited' } as any,
    ], 'I could not publish.') as any);

    const result = await runScheduledChat(publishSchedule, 'kevin', true);

    expect((result as any).publishHeldForApproval).toBe(true);
    expect((result as any).publishRequirementMismatch).toBeUndefined();
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

/**
 * ENG-930 — the ticket's own reported production X-posting schedules both
 * require `['post_on_connected_account', 'generate_image']`. A run that holds the
 * publish never generates an image for content that will not post either, so
 * `generate_image` stays unmet forever too and `isPublishOnlyUnmet` never
 * fires — see "leaves a MIXED requirement set on the full retry budget" above,
 * which pins that as the (correct, for a CHEAP/reversible co-requirement)
 * existing behavior.
 *
 * Once a schedule is explicitly unauthorized (owner turned ON "Require
 * approval before publishing", or revoked a prior grant),
 * `filterRequiredFunctionsToAuthorizedScope` (ENG-827) removes the publish
 * tool from `requiredFunctions` ENTIRELY before the retry loop even starts —
 * so `functionCallMisses` never contains a publish-shaped name at all in this
 * configuration, and only `generate_image` is left, alone, forever unmet.
 * That is the second, narrower door `publishExcludedFromScope` opens: this
 * suite exercises it directly, the one actually reachable through
 * `runScheduledChat` today (the sibling `explicitlyWithheld` +
 * `hasUnmetPublishRequirement` path is covered at the unit level in
 * publishPressCircuitBreaker.test.ts, for callers that verify authorization
 * without this scoping filter).
 */
describe('runScheduledChat — publish tool excluded from scope entirely, mixed with a co-required prep call (ENG-930)', () => {
  const mixedExcludedSchedule = {
    ...publishSchedule,
    scheduleId: 'schedule-930-excluded',
    // Deterministic UNAUTHORIZED resolution, independent of the legacy
    // grandfather default — the owner explicitly requires approval.
    requirePublishApproval: true,
    requiredFunctionCalls: ['post_on_connected_account', 'generate_image'],
  };

  const GENUINE_WITHHOLD = [
    'Morning X post — drafted, held at the publish gate.',
    'PUBLISH WITHHELD: this schedule requires approval before publishing.',
  ].join(' ');

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
    mockScheduleDb.getScheduleById.mockResolvedValue(mixedExcludedSchedule as any);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([] as any);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined as any);
  });

  it('PRE-FIX REPRODUCTION: without a genuine marker, still presses the excluded-publish-plus-prep mix to the full 20', async () => {
    mockWorker.runInWorker.mockResolvedValue(workerReply([], REFUSAL) as any);

    const result = await runScheduledChat(mixedExcludedSchedule, 'kevin', true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(20);
    expect(result.functionCallMisses).toEqual(['generate_image']);
    expect((result as any).publishHeldForApproval).toBeUndefined();
  });

  it('FIX: a genuine PUBLISH WITHHELD marker stops the run immediately instead of pressing generate_image to 20', async () => {
    mockWorker.runInWorker.mockResolvedValue(workerReply([], GENUINE_WITHHOLD) as any);

    const result = await runScheduledChat(mixedExcludedSchedule, 'kevin', true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
    expect(result.attempt).toBe(1);
    expect(result.functionCallMisses).toEqual(['generate_image']);
    expect((result as any).publishHeldForApproval).toBe(true);
    expect(result.status).toBe('failure');
  });

  it('persists the held-for-approval marker on the stored run result', async () => {
    mockWorker.runInWorker.mockResolvedValue(workerReply([], GENUINE_WITHHOLD) as any);

    await runScheduledChat(mixedExcludedSchedule, 'kevin', false);

    expect(mockScheduleDb.addRunResult).toHaveBeenCalledWith(
      'schedule-930-excluded',
      expect.objectContaining({ publishHeldForApproval: true, status: 'failure' })
    );
  });

  it('a NON-genuine marker (schedule actually resolves authorized) does not exempt the run', async () => {
    // Same marker text, but this schedule is NOT unauthorized — the marker is
    // model-authored text and must not be trusted on its own (Greptile review #20).
    const authorizedSchedule = {
      ...mixedExcludedSchedule,
      scheduleId: 'schedule-930-authorized',
      requirePublishApproval: false,
      autopublishAuthorized: true,
      autopublishAuthorizedTools: ['post_on_connected_account'],
    };
    mockScheduleDb.getScheduleById.mockResolvedValue(authorizedSchedule as any);
    mockWorker.runInWorker.mockResolvedValue(workerReply([], GENUINE_WITHHOLD) as any);

    const result = await runScheduledChat(authorizedSchedule, 'kevin', true);

    // Authorized, so post_on_connected_account is NOT excluded from scope and
    // stays genuinely unmet alongside generate_image — a mixed, non-publish-only
    // set that the (correctly unexempted) marker must not short-circuit.
    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(20);
    expect((result as any).publishHeldForApproval).toBeUndefined();
  });
});

/**
 * ENG-947 — the real 2026-08-11 run of schedule 34154af9 "Kevin — X Evening
 * Post". requiredFunctionCalls names post_on_connected_account, but the prompt
 * asks for a 2-3 tweet THREAD, so the model published via twitter_manage_post.
 *
 * ENG-1599 review (CodeRabbit) correction: as originally written, this suite's
 * mock used a placeholder `action: 'post'` — not a real API value — which
 * accidentally dodged the pre-existing ENG-1045 forward equivalence route and
 * forced every test here down the mismatch path. With the real `post_thread`
 * action, `callSatisfiesRequirement` already credits a twitter_manage_post
 * thread toward this schedule's single `post_on_connected_account` requirement
 * (no double-requirement suppression applies here), so the run correctly
 * reports success — the schedule's mandated content genuinely went out. The
 * mismatch path this describe block was written to guard remains real and
 * covered (see publishPressCircuitBreaker.test.ts's qualifier tests, and the
 * "reply" case below), it just isn't reachable through THIS specific
 * single-required-tool, matching-action shape — that shape is completion,
 * not mismatch.
 */
describe('runScheduledChat — published through a different tool (ENG-947)', () => {
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
    (mockAgentModeService as any).generateScheduledChatSummary.mockResolvedValue('Thread Published');
    mockScheduleDb.addRunResult.mockResolvedValue(undefined as any);
    mockScheduleDb.getScheduleById.mockResolvedValue(publishSchedule as any);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([] as any);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined as any);
  });

  /**
   * ENG-1599 review (CodeRabbit) correction: this used to mock a placeholder
   * `action: 'post'`, not a real API value, which accidentally dodged the
   * pre-existing ENG-1045 forward equivalence credit and forced the mismatch
   * path. With the real `post_thread` action, `callSatisfiesRequirement`
   * already credits this toward `post_on_connected_account` (single required
   * tool here, so no double-requirement suppression applies) — so the run
   * correctly reports success. See the identical correction and full
   * explanation in the sibling describe block above.
   */
  it('credits a THREAD published via twitter_manage_post, does not report a mismatch', async () => {
    mockWorker.runInWorker.mockResolvedValue(
      workerReply([{ name: 'twitter_manage_post', arguments: { action: 'post_thread' } }], 'Thread published.') as any,
    );

    const result = await runScheduledChat(publishSchedule, 'kevin', true);

    expect(result.attempt).toBe(1);
    expect(result.functionCallMisses).toEqual([]);
    expect((result as any).publishRequirementMismatch).toBeUndefined();
    expect((result as any).publishHeldForApproval).toBeUndefined();
    expect(result.status).toBe('success');
  });

  it('persists success on the stored run result, with neither marker set', async () => {
    mockWorker.runInWorker.mockResolvedValue(
      workerReply([{ name: 'twitter_manage_post', arguments: { action: 'post_thread' } }], 'Thread published.') as any,
    );

    await runScheduledChat(publishSchedule, 'kevin', true);

    expect(mockScheduleDb.addRunResult).toHaveBeenCalledWith(
      'schedule-947',
      expect.objectContaining({ status: 'success' }),
    );
    const stored = (mockScheduleDb.addRunResult as jest.Mock).mock.calls[0][1] as any;
    expect(stored.publishRequirementMismatch).toBeUndefined();
    expect(stored.publishHeldForApproval).toBeUndefined();
  });

  it('a FAILED write through the other tool is still a genuine withhold', async () => {
    // Nothing reached X, so the content really is waiting on the owner.
    mockWorker.runInWorker.mockResolvedValue(
      workerReply([{ name: 'twitter_manage_post', arguments: {}, error: 'rate limited' } as any]) as any,
    );

    const result = await runScheduledChat(publishSchedule, 'kevin', true);

    expect((result as any).publishHeldForApproval).toBe(true);
    expect((result as any).publishRequirementMismatch).toBeUndefined();
  });
});
