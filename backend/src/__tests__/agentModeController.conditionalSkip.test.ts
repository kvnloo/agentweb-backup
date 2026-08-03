// ENG-844: A scheduled run that legitimately short-circuits on a conditional
// guard (e.g. a "publish only Mon/Wed/Fri" schedule running on a non-publishing
// day) must exit cleanly as a SUCCESSFUL skip — not be retried against unmet
// write-call minimums (post_on_connected_account / generate_image), which pressures
// irreversible publishing and eventually trips the anti-loop override.

// Mock all dependencies before importing the controller (mirrors the
// minFunctionCalls test harness so runScheduledChat can run fully mocked).
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => [
    'generate_image',
    'post_on_connected_account',
    'read_brand_guidelines',
    'read_market_strategy',
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
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getScheduledChatsDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    generateMarketingResponse: jest.fn(),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set([
      'install_skills', 'search_web', 'read_file_content', 'read_page_source',
      'search_knowledge_base', 'list_knowledge_base_files', 'read_knowledge_base_files',
      'create_work_plan', 'modify_work_plan', 'set_work_plan_status',
      'save_file', 'describe_image',
    ])),
    getAdminToolNames: jest.fn().mockReturnValue([
      'list_predefined_work_plans', 'manage_predefined_work_plan',
      'list_skills', 'manage_skill', 'get_chat_history',
    ]),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
  },
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
    getUserById: jest.fn().mockResolvedValue({ userId: 'test-user-1', email: 'test@example.com', isAdmin: false }),
  },
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-run-id-123'),
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendScheduledChatResultEmail: jest.fn(),
    sendDailyDigestEmail: jest.fn(),
    sendScheduledChatVariableRequestEmail: jest.fn(),
    sendScheduledChatErrorEmail: jest.fn(),
    sendScheduledChatTokenLimitEmail: jest.fn(),
  },
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(async () => ({
    allowed: true,
    warning: false,
    used: 100000,
    allowance: 1000000,
    bonus: 0,
    effectiveAllowance: 1000000,
    percentUsed: 10,
    month: '2026-04',
  })),
}));

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import {
  runScheduledChat,
  scheduledRunSignalsConditionalSkip,
} from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

describe('scheduledRunSignalsConditionalSkip', () => {
  // A fixed Sunday (2026-08-02) so weekday-naming assertions cross-check cleanly.
  const SUNDAY = new Date('2026-08-02T12:00:00Z');

  it('detects a CADENCE-anchored whole-run skip with no failure/tool-error signal', () => {
    const positives = [
      'Today is Sunday, a non-publishing day. Skipping — no post created.',
      'This is not a publishing day, so I am skipping today.',
      'Nothing to publish today per the Mon/Wed/Fri cadence.',
      'No post today; the schedule only publishes Monday, Wednesday, and Friday.',
      'Per the guardrail I am creating and publishing nothing this run.',
      'Today is a rest day for this schedule.',
    ];
    // now pinned to Sunday so the "Today is Sunday" assertion agrees with the server.
    positives.forEach((c) => expect(scheduledRunSignalsConditionalSkip(c, { now: SUNDAY })).toBe(true));
  });

  it('does NOT fire on a normal publishing turn or a partial-progress admission', () => {
    const negatives = [
      'I published today\'s LinkedIn post and generated the accompanying image.',
      'Here is the drafted post for review before publishing.',
      'I skipped the remaining three leads and will continue next run.', // partial, not whole-run skip
      'I could not access LinkedIn, so the post was not published.',
      '',
      undefined as unknown as string,
    ];
    negatives.forEach((c) => expect(scheduledRunSignalsConditionalSkip(c, { now: SUNDAY })).toBe(false));
  });

  it('does NOT fire on a bare "skip today" with no cadence rationale', () => {
    // Ambiguous skip prose that could equally describe a failure — must NOT be
    // waived without a cadence/weekday rationale.
    expect(scheduledRunSignalsConditionalSkip('Skipping today for now.', { now: SUNDAY })).toBe(false);
    expect(scheduledRunSignalsConditionalSkip('No post today.', { now: SUNDAY })).toBe(false);
  });

  it('does NOT fire when a failure is worded as a skip (genuine failure must still alert)', () => {
    const failureSkips = [
      "Skipping today's post — I could not access LinkedIn.",
      'No post today; LinkedIn auth failed.',
      'Non-publishing day handling aside, the post errored and was not published.',
      "It's a non-publishing day, but I also couldn't reach the API.",
    ];
    failureSkips.forEach((c) => expect(scheduledRunSignalsConditionalSkip(c, { now: SUNDAY })).toBe(false));
  });

  it('does NOT fire when a tool call in the run actually errored', () => {
    const cleanSkip = 'Today is a non-publishing day per the Mon/Wed/Fri cadence. Skipping this run.';
    // Same prose, but the ledger shows a real tool error → this was a failure, not a skip.
    expect(
      scheduledRunSignalsConditionalSkip(cleanSkip, {
        now: SUNDAY,
        toolCalls: [{ name: 'post_on_connected_account', error: 'HTTP 500 from LinkedIn' }],
      })
    ).toBe(false);
    // No tool errors → the same prose is a legitimate skip.
    expect(
      scheduledRunSignalsConditionalSkip(cleanSkip, { now: SUNDAY, toolCalls: [{ name: 'read_brand_guidelines' }] })
    ).toBe(true);
  });

  it('rejects a skip whose asserted weekday contradicts the server weekday', () => {
    const MONDAY = new Date('2026-08-03T12:00:00Z');
    const c = 'Today is Sunday, a non-publishing day. Skipping — no post created.';
    expect(scheduledRunSignalsConditionalSkip(c, { now: SUNDAY })).toBe(true);
    expect(scheduledRunSignalsConditionalSkip(c, { now: MONDAY })).toBe(false);
  });

  it('fires on the REAL production skip wording (session 442e7880… msg[2])', () => {
    // Faithful excerpt of the actual attempt-1 skip Emma emitted on Sunday
    // 2026-08-02. Two things here previously defeated the detector and let the
    // bug reproduce: (a) the weekday is wrapped in <strong> so the "today is
    // Sunday" assertion was hidden, and (b) the completion ledger renders a
    // literal "<td>Failed</td><td>0</td>" — a SUCCESS signal (zero failures) that
    // the failure-veto regex matched as the word "Failed". The detector must
    // strip HTML and ignore a zero-valued failure ledger, and then fire.
    const realSkip = [
      'LUCAS: non-publishing day, skipped.',
      '',
      '<strong>Weekday check:</strong> Today is <strong>Sunday, 2 August 2026</strong> — outside the Mon/Wed/Fri publishing window, so nothing was created, generated, or published this run.',
      '',
      '<ul>',
      '<li><strong>Actions taken:</strong> none. No brand/strategy reads, no research, no image generation, no posts to the company page, Hannah\'s profile, Instagram, or X.</li>',
      '<li><strong>Cost avoided:</strong> one image generation + four publish calls.</li>',
      '</ul>',
      '',
      '<strong>Completion ledger</strong>',
      '<table>',
      '<tr><td>Attempted</td><td>0</td></tr>',
      '<tr><td>Succeeded</td><td>0</td></tr>',
      '<tr><td>Failed</td><td>0</td></tr>',
      '</table>',
    ].join('\n');
    // Pinned to the run's actual weekday (Sunday) — the UTC anchor must agree.
    expect(scheduledRunSignalsConditionalSkip(realSkip, { now: SUNDAY, toolCalls: [] })).toBe(true);
    // And a real failure ledger ("Failed 1") in the same shape must STILL veto.
    const realFailureLedger = realSkip.replace('<td>Failed</td><td>0</td>', '<td>Failed</td><td>1</td>');
    expect(scheduledRunSignalsConditionalSkip(realFailureLedger, { now: SUNDAY, toolCalls: [] })).toBe(false);
  });

  it('anchors the weekday cross-check to UTC, matching the model\'s UTC "Current date"', () => {
    // The model is handed its "Current date" as a UTC calendar date
    // (new Date().toISOString()), so its weekday reasoning is UTC-based. The
    // cross-check must use the SAME reference (getUTCDay), not a server-local
    // weekday — otherwise a non-UTC host would desync and mis-judge the skip.
    // 2026-08-03T02:00Z is Sunday evening in the US but already MONDAY in UTC, so
    // the model (seeing the UTC date) would assert Monday, not Sunday.
    const utcMonday = new Date('2026-08-03T02:00:00Z');
    expect(utcMonday.getUTCDay()).toBe(1); // sanity: Monday in UTC

    // A Monday claim at this instant agrees with the model's UTC date → accepted.
    expect(
      scheduledRunSignalsConditionalSkip('Today is Monday, a non-publishing day. Skipping — no post created.', { now: utcMonday })
    ).toBe(true);
    // A Sunday claim contradicts the UTC date the model was given → rejected.
    expect(
      scheduledRunSignalsConditionalSkip('Today is Sunday, a non-publishing day. Skipping — no post created.', { now: utcMonday })
    ).toBe(false);
  });
});

describe('runScheduledChat — conditional skip day', () => {
  const mockUserId = 'test-user-123';
  const mockScheduleId = 'test-schedule-lucas';

  // A daily schedule that publishes only Mon/Wed/Fri and requires write calls.
  const publishSchedule = {
    scheduleId: mockScheduleId,
    scheduleName: 'LUCAS — LinkedIn Thought Leadership (Mon/Wed/Fri)',
    startingMessage: 'Publish today\'s thought-leadership post only on Mon/Wed/Fri.',
    keywords: [],
    requiredFunctionCalls: ['generate_image', 'post_on_connected_account'],
    functionCallMinCalls: {
      generate_image: 1,
      post_on_connected_account: 1,
    },
    userId: mockUserId,
  };

  const mockSession = {
    sessionId: 'test-session-lucas',
    userId: mockUserId,
    title: 'Scheduled: LUCAS',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.createChatSession.mockResolvedValue(mockSession);
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(mockSession);
    mockAgentModeService.getDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Generated Title');
    mockScheduleDb.addRunResult.mockResolvedValue(undefined);
    mockScheduleDb.getScheduleById.mockResolvedValue(publishSchedule);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([]);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('records a SUCCESSFUL skip (marked conditionalSkip) without retrying for the unmet write calls', async () => {
    // The agent correctly identifies a non-publishing day and produces zero write
    // calls and zero tool errors. Cadence-anchored, no failure wording, no weekday
    // assertion to cross-check — so the carve-out fires.
    mockWorker.runInWorker.mockResolvedValue({
      content: 'Today is a non-publishing day per the Mon/Wed/Fri cadence. Skipping this run — no image generated and nothing published.',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });

    const result = await runScheduledChat(publishSchedule, mockUserId, true);

    // The run must NOT be retried 20 times pressing for post_on_connected_account /
    // generate_image — it should exit on the first attempt as a clean skip, and the
    // stored result must be DISTINGUISHABLE from a real publish (conditionalSkip).
    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        scheduleId: mockScheduleId,
        status: 'success',
        passed: true,
        attempt: 1,
        functionCallMisses: [],
        conditionalSkip: true,
      })
    );
  });

  it('does NOT waive the write calls when the "skip" is actually a tool failure', async () => {
    // Cadence wording is present, but a required write tool ERRORED — this is a
    // genuine failure that must still retry + be recorded as a failure (so the
    // fileAutoIssue/oncall path can fire), never silently waived.
    mockWorker.runInWorker.mockResolvedValue({
      content: 'It is a non-publishing day, but post_on_connected_account failed anyway.',
      toolCalls: [{ name: 'post_on_connected_account', error: 'HTTP 500 from LinkedIn' }],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });

    const result = await runScheduledChat(publishSchedule, mockUserId, true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(20);
    expect(result).toEqual(
      expect.objectContaining({
        scheduleId: mockScheduleId,
        status: 'failure',
        passed: false,
        attempt: 20,
      })
    );
    expect((result as any).conditionalSkip).toBeUndefined();
  });

  it('still retries when the run does NOT signal a skip (write calls genuinely missing)', async () => {
    // No skip language: the run just failed to make its required write calls. This
    // must retain the existing retry-until-maxAttempts behavior (failure), proving
    // the skip carve-out does not swallow genuinely-incomplete runs.
    mockWorker.runInWorker.mockResolvedValue({
      content: 'Here is a draft of the LinkedIn post for today.',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });

    const result = await runScheduledChat(publishSchedule, mockUserId, true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(20);
    expect(result).toEqual(
      expect.objectContaining({
        scheduleId: mockScheduleId,
        status: 'failure',
        passed: false,
        attempt: 20,
      })
    );
  });
});
