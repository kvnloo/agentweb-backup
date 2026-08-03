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

  it('honors the skip ONLY when the schedule OWNER\'s instruction authorizes it (Greptile P1)', () => {
    // Identical, well-formed cadence-skip prose from the model. Whether it is
    // waived must depend on the schedule's OWN instruction: the authorization to
    // skip comes from the human who configured the schedule, not from the model's
    // post-hoc explanation. Without an authorizing instruction, a model that
    // spontaneously claims a skip on a run carrying write-call minimums would
    // silently waive them (unauthorized skip).
    const skipProse = 'Today is Sunday, a non-publishing day. Skipping — no post created.';

    // Owner defined a conditional publishing cadence → authorized.
    const authorizing = [
      'Publish today\'s thought-leadership post only on Mon/Wed/Fri.',
      'Post only on Tuesday, Thursday, and Saturday.',
      'If today is Saturday or Sunday, publish nothing and report a non-publishing day.',
    ];
    authorizing.forEach((instruction) =>
      expect(scheduledRunSignalsConditionalSkip(skipProse, { now: SUNDAY, instruction })).toBe(true)
    );

    // Owner never built a skip into the schedule → a model-authored skip is NOT waived.
    const unauthorized = [
      'Publish today\'s thought-leadership post.',
      'Draft and publish a LinkedIn update about payroll automation every day.',
    ];
    unauthorized.forEach((instruction) =>
      expect(scheduledRunSignalsConditionalSkip(skipProse, { now: SUNDAY, instruction })).toBe(false)
    );

    // Undefined instruction (pure text-classifier callers) leaves the gate inert.
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: SUNDAY })).toBe(true);
  });

  it('cross-checks the RUN DATE against the schedule cadence, not just the prose (Greptile P1)', () => {
    const sunday = new Date('2026-08-02T12:00:00Z'); // getUTCDay() === 0 (non-publishing)
    const monday = new Date('2026-08-03T12:00:00Z'); // getUTCDay() === 1 (publishing)
    const skipProse = 'This is a non-publishing day per the Mon/Wed/Fri cadence. Skipping this run.';
    const publishOnlyMWF = 'Publish only on Mon/Wed/Fri.';

    // Positive cadence: a skip is legitimate on Sunday (outside the publish window)
    // but WRONG on Monday (in it) — even though the prose is identical and names no day.
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: sunday, instruction: publishOnlyMWF })).toBe(true);
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: monday, instruction: publishOnlyMWF })).toBe(false);

    // Naming the weekday correctly does NOT rescue a skip on a publishing day — the
    // cadence cross-check is authoritative over the model's "non-publishing" claim.
    const namedMonday = 'Today is Monday, a non-publishing day for this cadence. Skipping.';
    expect(scheduledRunSignalsConditionalSkip(namedMonday, { now: monday, instruction: publishOnlyMWF })).toBe(false);

    // Skip-day list only: today must be one of the named skip days.
    const skipList = 'If today is Saturday or Sunday, publish nothing.';
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: sunday, instruction: skipList })).toBe(true);
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: monday, instruction: skipList })).toBe(false);

    // Authorized but the cadence is not weekday-based (no day-sets) → fail closed:
    // we cannot confirm today is genuinely a non-publishing day, so we do not waive.
    const vagueAuth = 'Skip on any non-publishing day for this schedule.';
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: sunday, instruction: vagueAuth })).toBe(false);
    // …and the model NAMING today's weekday does NOT rescue it: naming the day only
    // proves the model knows the date, not that today is excluded by the cadence.
    // The weekday check is veto-only; authorization must come from the owner's
    // parsed weekday cadence (Greptile, ENG-844).
    const namedSunday = 'Today is Sunday, a non-publishing day. Skipping.';
    expect(scheduledRunSignalsConditionalSkip(namedSunday, { now: sunday, instruction: vagueAuth })).toBe(false);

    // Greptile's exact example: "publish only when approved" passes the
    // authorization regex but defines no weekday cadence. A correctly-named weekday
    // must NOT waive the required calls on any day.
    const approvalGate = 'Publish only when approved by the brand team.';
    expect(scheduledRunSignalsConditionalSkip(namedSunday, { now: sunday, instruction: approvalGate })).toBe(false);
    expect(scheduledRunSignalsConditionalSkip('Today is Monday, a non-publishing day. Skipping.', { now: monday, instruction: approvalGate })).toBe(false);
  });

  it('rejects a skip that made a NON-required write call, but allows read/context calls (Greptile P1)', () => {
    const sunday = new Date('2026-08-02T12:00:00Z');
    const instr = 'Publish only on Mon/Wed/Fri.';
    const skipProse = 'Today is Sunday, a non-publishing day. Skipping — no post created.';

    // Read/context tool calls do not make it a non-skip.
    for (const readTool of ['read_brand_guidelines', 'read_market_strategy', 'you_search_web',
      'get_leads', 'describe_image', 'analyze_crm_data', 'ask_crm', 'audit_ad_utm_coverage', 'account_summary']) {
      expect(scheduledRunSignalsConditionalSkip(skipProse, {
        now: sunday, instruction: instr, toolCalls: [{ name: readTool }],
      })).toBe(true);
    }

    // Any NON-read tool is treated as a side effect → not a clean skip. Includes
    // the verbs an allowlist would leak (email, add_, assign_, manage_, launch_,
    // freeze_, set_, save_, configure_, call_*_api, and even unknown tools).
    for (const writeTool of ['send_email_from_sender', 'post_on_connected_account', 'generate_image',
      'update_lead', 'create_lead', 'email', 'add_leads_to_list', 'assign_lead', 'launch_campaign',
      'manage_campaign', 'freeze_budget', 'set_lead_status', 'save_draft', 'configure_lead_statuses',
      'call_google_ads_api', 'coding_agent', 'some_brand_new_tool']) {
      expect(scheduledRunSignalsConditionalSkip(skipProse, {
        now: sunday, instruction: instr, toolCalls: [{ name: writeTool }],
      })).toBe(false);
    }
  });

  it('does not let a weekday PREFIX in an unrelated word invent a cadence (Greptile P1)', () => {
    const sunday = new Date('2026-08-02T12:00:00Z');
    const skipProse = 'This is a non-publishing day per the cadence. Skipping this run.';
    // "monetary"/"wedding"/"satisfaction"/"future" merely START with mon/wed/sat/… —
    // none is a weekday, so the instruction yields NO cadence day-sets and the skip
    // fails closed (no run-date corroboration) on every day.
    for (const instr of [
      'Publish only on monetary approval.',
      'Publish only when the wedding campaign is satisfied.',
      'Post only on satisfactory review of the friendly draft.',
    ]) {
      expect(scheduledRunSignalsConditionalSkip(skipProse, { now: sunday, instruction: instr })).toBe(false);
      expect(scheduledRunSignalsConditionalSkip(
        'Today is Sunday, a non-publishing day. Skipping.', { now: sunday, instruction: instr })).toBe(false);
    }
  });

  it('expands weekday RANGES so a mid-range day is a publishing day (Greptile P1)', () => {
    const skipProse = 'This is a non-publishing day per the cadence. Skipping this run.';
    const wednesday = new Date('2026-08-05T12:00:00Z'); // getUTCDay() === 3
    const saturday = new Date('2026-08-08T12:00:00Z'); // getUTCDay() === 6
    for (const instr of ['Publish only on Mon-Fri.', 'Publish only on Monday through Friday.', 'Post only on Mon to Fri.']) {
      // Wednesday is inside Mon–Fri → a publishing day → a skip must NOT be waived.
      expect(scheduledRunSignalsConditionalSkip(skipProse, { now: wednesday, instruction: instr })).toBe(false);
      // Saturday is outside Mon–Fri → a genuine non-publishing day → waived.
      expect(scheduledRunSignalsConditionalSkip(skipProse, { now: saturday, instruction: instr })).toBe(true);
    }
  });

  it('evaluates the owner cadence in the schedule timezone, not UTC (Greptile P1)', () => {
    const publishOnlyMWF = 'Publish only on Mon/Wed/Fri.';
    const skipProse = 'This is a non-publishing day per the Mon/Wed/Fri cadence. Skipping this run.';

    // 2026-08-03T02:00Z is MONDAY in UTC but still SUNDAY in US/Pacific (7pm Sun).
    const utcMonPacificSun = new Date('2026-08-03T02:00:00Z');
    // UTC → Monday (a publish day) → rejected.
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: utcMonPacificSun, instruction: publishOnlyMWF })).toBe(false);
    // Schedule timezone US/Pacific → Sunday (non-publishing) → waived.
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: utcMonPacificSun, instruction: publishOnlyMWF, timezone: 'America/Los_Angeles' })).toBe(true);

    // Inverse: 2026-08-02T16:00Z is SUNDAY in UTC but already MONDAY in Asia/Tokyo (+9).
    const utcSunTokyoMon = new Date('2026-08-02T16:00:00Z');
    // No timezone (UTC) → Sunday → waived.
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: utcSunTokyoMon, instruction: publishOnlyMWF })).toBe(true);
    // Schedule timezone Asia/Tokyo → Monday (a publish day) → rejected.
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: utcSunTokyoMon, instruction: publishOnlyMWF, timezone: 'Asia/Tokyo' })).toBe(false);
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

  // A Sunday and a Monday for the Mon/Wed/Fri schedule: Sunday is a genuine
  // non-publishing day (skip is legitimate), Monday is a publishing day (a skip is
  // WRONG and must not be waived). Pinned so the run-date cross-check is
  // deterministic regardless of the day CI runs.
  const SUNDAY_NON_PUBLISH = new Date('2026-08-02T12:00:00Z'); // getUTCDay() === 0
  const MONDAY_PUBLISH = new Date('2026-08-03T12:00:00Z'); // getUTCDay() === 1

  it('records a SUCCESSFUL skip (marked conditionalSkip) without retrying for the unmet write calls', async () => {
    // The agent correctly identifies a non-publishing day and produces zero write
    // calls and zero tool errors. Cadence-anchored, no failure wording, and the run
    // date (Sunday) is outside the Mon/Wed/Fri publish window — so the carve-out fires.
    mockWorker.runInWorker.mockResolvedValue({
      content: 'Today is a non-publishing day per the Mon/Wed/Fri cadence. Skipping this run — no image generated and nothing published.',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });

    const result = await runScheduledChat(publishSchedule, mockUserId, true, undefined, SUNDAY_NON_PUBLISH);

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

  it('does NOT waive a skip claimed on a real PUBLISHING day, even without a named weekday (Greptile P1)', async () => {
    // The Mon/Wed/Fri schedule runs on MONDAY — a publishing day. The model emits
    // cadence-skip prose but never names Monday, so the weekday cross-check cannot
    // fire. The run-date-vs-cadence check must still reject it: Monday IS in the
    // publish window, so a skip is wrong and must retry + alert, not be waived.
    mockWorker.runInWorker.mockResolvedValue({
      content: 'This is a non-publishing day per the Mon/Wed/Fri cadence — skipping this run, nothing published.',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });

    const result = await runScheduledChat(publishSchedule, mockUserId, true, undefined, MONDAY_PUBLISH);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(20);
    expect(result).toEqual(
      expect.objectContaining({ scheduleId: mockScheduleId, status: 'failure', passed: false, attempt: 20 })
    );
    expect((result as any).conditionalSkip).toBeUndefined();
  });

  it('does NOT waive a skip that names the day correctly but the day is a PUBLISHING day (Greptile P1)', async () => {
    // The trickier case: the model NAMES Monday (so the weekday cross-check passes —
    // the weekday is stated correctly) but wrongly frames it as non-publishing. The
    // cadence cross-check is authoritative: Monday is in the Mon/Wed/Fri publish
    // window, so this is not a legitimate skip.
    mockWorker.runInWorker.mockResolvedValue({
      content: 'Today is Monday, a non-publishing day for this cadence. Skipping — nothing published.',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });

    const result = await runScheduledChat(publishSchedule, mockUserId, true, undefined, MONDAY_PUBLISH);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(20);
    expect(result).toEqual(
      expect.objectContaining({ scheduleId: mockScheduleId, status: 'failure', passed: false, attempt: 20 })
    );
    expect((result as any).conditionalSkip).toBeUndefined();
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

  it('does NOT waive a PARTIALLY-executed run (one write already made, another unmet)', async () => {
    // The agent already published to one destination (post_on_connected_account
    // succeeded) but did not generate_image, then wrapped up with cadence-skip
    // wording. A true cadence skip makes ZERO write calls; a partial execution has
    // real external state and must NOT be laundered into a clean "skip" — it must
    // still retry + record a failure (Greptile P1, ENG-844).
    mockWorker.runInWorker.mockResolvedValue({
      content: 'Today is a non-publishing day per the Mon/Wed/Fri cadence — skipping the rest of this run.',
      toolCalls: [{ name: 'post_on_connected_account' }],
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

  it('does NOT waive a skip that performed a NON-required write (send_email_from_sender)', async () => {
    // The run emitted a legitimate cadence-skip on a real non-publishing day, but it
    // also fired a write tool that is NOT in requiredFunctions. That external side
    // effect means it was not a clean no-op — it must not be recorded as a skip
    // (Greptile P1, ENG-844).
    mockWorker.runInWorker.mockResolvedValue({
      content: 'Today is a non-publishing day per the Mon/Wed/Fri cadence. Skipping the post.',
      toolCalls: [{ name: 'send_email_from_sender' }],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });

    const result = await runScheduledChat(publishSchedule, mockUserId, true, undefined, SUNDAY_NON_PUBLISH);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(20);
    expect(result).toEqual(
      expect.objectContaining({ scheduleId: mockScheduleId, status: 'failure', passed: false, attempt: 20 })
    );
    expect((result as any).conditionalSkip).toBeUndefined();
  });

  it('does NOT waive a skip the schedule instruction never authorized (unauthorized skip)', async () => {
    // Same well-formed cadence-skip prose, but this schedule's instruction has NO
    // conditional-skip rule — the model spontaneously claimed a non-publishing day.
    // The waiver must be tied to the OWNER's configured cadence, so this run is not
    // waived: it retries and is recorded as a failure (Greptile P1, ENG-844).
    mockScheduleDb.getScheduleById.mockResolvedValue({
      ...publishSchedule,
      startingMessage: 'Publish today\'s thought-leadership post every day.',
    });
    mockWorker.runInWorker.mockResolvedValue({
      content: 'Today is a non-publishing day per the Mon/Wed/Fri cadence. Skipping this run — nothing published.',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });

    const result = await runScheduledChat(
      { ...publishSchedule, startingMessage: 'Publish today\'s thought-leadership post every day.' },
      mockUserId,
      true
    );

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
