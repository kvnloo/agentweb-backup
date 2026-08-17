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
  },
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
    releaseSessionClients: jest.fn(),
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
  runVerifiedChat,
  scheduledRunSignalsConditionalSkip,
  reconstructPriorToolCalls,
} from '../controllers/agentModeController';
import { callSatisfiesRequirement, countCallsSatisfyingRequirement } from '../utils/requiredCallSatisfaction';

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

  it('fires on the REAL 2026-08-06 prod regression: an inline COUNT-FIRST zero ledger (session 25ec4670)', () => {
    // Verbatim wording from the prod run that regressed AFTER the original fix
    // shipped (LUCAS, Thursday 2026-08-06). The skip was perfect — zero tool calls,
    // correct weekday — but the agent wrote its ledger count-FIRST:
    //   "Ledger: 0 attempted / 0 succeeded / 0 failed / 0 queued."
    // The zero-ledger neutralizer only handled label-then-count ("Failed: 0"), so the
    // bare word "failed" survived, the failure-veto fired, and the run was pressed
    // for generate_image / post_on_connected_account across all 20 attempts.
    const THURSDAY = new Date('2026-08-06T13:00:26Z');
    expect(THURSDAY.getUTCDay()).toBe(4);
    const instruction =
      'You are LUCAS, the LinkedIn thought-leadership agent for IncentivPay. This schedule runs DAILY but only publishes on Monday, Wednesday, and Friday.\n\n' +
      'FIRST: check today\'s actual weekday. If today is Tuesday, Thursday, Saturday, or Sunday, DO NOT create or publish anything — simply stop and report "LUCAS: non-publishing day, skipped."';
    const realSkip =
      'LUCAS: non-publishing day, skipped.\n\n' +
      '<p><strong>Date check:</strong> Today is <strong>Thursday, 6 August 2026</strong>. This schedule only publishes Monday / Wednesday / Friday, so no post, no image, and no publishing calls were made this run.</p>\n\n' +
      '<p><strong>Nothing published:</strong> no LinkedIn company page post, no Hannah K profile post, no Instagram post, no X post, no image generated, no comments seeded. Ledger: 0 attempted / 0 succeeded / 0 failed / 0 queued.</p>';
    expect(scheduledRunSignalsConditionalSkip(realSkip, { now: THURSDAY, toolCalls: [], instruction })).toBe(true);

    // A NONZERO count in the same inline format is a real failure and must still veto.
    const realFailureInline = realSkip.replace('0 failed', '1 failed');
    expect(scheduledRunSignalsConditionalSkip(realFailureInline, { now: THURSDAY, toolCalls: [], instruction })).toBe(false);

    // The count-first rule must NOT swallow a stripped HTML TABLE ledger, where the
    // "0" belongs to the PREVIOUS row: "Succeeded 0 Failed 1" is a real failure.
    const tableFailure =
      'Today is a non-publishing day per the Mon/Wed/Fri cadence. Skipping.' +
      '<table><tr><td>Succeeded</td><td>0</td><td>Failed</td><td>1</td></tr></table>';
    expect(scheduledRunSignalsConditionalSkip(tableFailure, { now: THURSDAY, toolCalls: [], instruction })).toBe(false);
    const tableClean = tableFailure.replace('<td>Failed</td><td>1</td>', '<td>Failed</td><td>0</td>');
    expect(scheduledRunSignalsConditionalSkip(tableClean, { now: THURSDAY, toolCalls: [], instruction })).toBe(true);

    // ...and PUNCTUATION between the label and its own count must not smuggle the
    // failure past the lookahead (Greptile P1): "Succeeded 0 Failed, 1" binds the 1
    // to "Failed" exactly as the whitespace form does.
    [',', ';', ' |', ' -', ':', ' —'].forEach((sep) => {
      const punctuated = `Today is a non-publishing day per the Mon/Wed/Fri cadence. Skipping. Succeeded 0 Failed${sep} 1`;
      expect([sep, scheduledRunSignalsConditionalSkip(punctuated, { now: THURSDAY, toolCalls: [], instruction })]).toEqual([sep, false]);
      // The same shape with a ZERO count stays a clean skip — the widened separator
      // class must not turn every punctuated ledger into a veto.
      const clean = punctuated.replace(/1$/, '0');
      expect([sep, scheduledRunSignalsConditionalSkip(clean, { now: THURSDAY, toolCalls: [], instruction })]).toEqual([sep, true]);
    });

    // Asserted failures worded as skips are still rejected regardless of ledger shape.
    ['The post failed to publish.', 'auth failed.', 'I could not access LinkedIn.'].forEach((tail) =>
      expect(scheduledRunSignalsConditionalSkip(`Non-publishing day, skipped. ${tail}`, { now: THURSDAY, toolCalls: [], instruction })).toBe(false)
    );
  });

  it('PHRASING AUDIT: benign skip wordings are waived; real failures still veto', () => {
    // The 2026-08-06 regression was phrasing-fragility, so this pins the whole
    // phrasing surface rather than the single wording that happened to break.
    // Derived from an audit of the production LUCAS transcripts (ENG-844).
    const INST =
      'This schedule runs DAILY but only publishes on Monday, Wednesday, and Friday. ' +
      'If today is Tuesday, Thursday, Saturday, or Sunday, DO NOT create or publish anything — ' +
      'simply stop and report "non-publishing day, skipped."';
    const THU = new Date('2026-08-06T13:00:00Z');
    const verdict = (t: string) =>
      scheduledRunSignalsConditionalSkip(t, { toolCalls: [], now: THU, instruction: INST });

    // Legitimate skips — including every contraction form, which the original
    // blanket /\w+n't/ veto silently rejected, and the alternative skip wordings
    // a model reaches for.
    [
      "Today isn't a publishing day for this schedule, so I'm skipping.",
      "Non-publishing day, skipped. I won't publish anything today.",
      "Non-publishing day, skipped. Re-running doesn't change the weekday.",
      "Non-publishing day, skipped. I didn't create or publish anything.",
      'Non-publishing day, skipped. I cannot post today because the cadence forbids it.',
      'Non-publishing day, skipped. No access to the calendar was needed.',
      'Non-publishing day, skipped. No errors, nothing published.',
      'Today is outside the publishing window for this schedule, so nothing was created.',
      'Per the Mon/Wed/Fri cadence, no content was produced this run.',
      'Standing down for today; the schedule only publishes on Mon/Wed/Fri.',
      'No action taken: today falls outside the Mon/Wed/Fri publishing cadence.',
      "I won't force the calls: today isn't a publishing day under the Mon/Wed/Fri cadence.",
    ].forEach((t) => expect([t, verdict(t)]).toEqual([t, true]));

    // Genuine failures — including ones sharing a sentence with a cadence rationale,
    // which must NOT be laundered by the cadence-justification exemption.
    [
      'Skipping today — I could not access LinkedIn.',
      'No post today; auth failed.',
      'Non-publishing day, skipped. The LinkedIn API timed out.',
      'Non-publishing day, skipped. Ledger: 0 attempted / 1 failed.',
      'Non-publishing day, skipped. Publishing was forbidden (403).',
      "Non-publishing day, skipped. I couldn't reach the Instagram API.",
      'Non-publishing day per the cadence, and the LinkedIn API timed out.',
      "Non-publishing day per the cadence; LinkedIn wouldn't accept the post.",
      'Skipping — the schedule only publishes Mon/Wed/Fri, and I could not access LinkedIn.',
      'Non-publishing day, skipped. Token expired.',
      'Non-publishing day, skipped. Succeeded 0 Failed 1.',
      'Non-publishing day, skipped. Rate limit hit.',
      "Non-publishing day, skipped. It didn't work.",
    ].forEach((t) => expect([t, verdict(t)]).toEqual([t, false]));
  });

  it('INSTRUCTION AUDIT: common cadence wordings are parsed into real day-sets', () => {
    // The live preview run exposed this: `only\s+(?:publish|post)\b` never matched
    // "only publishes", so publishDays came out EMPTY and the skip failed closed into
    // the retry press. The production LUCAS schedule only ever corroborated because
    // its skip clause happened to quote the words "non-publishing day" (ENG-844).
    const SKIP = 'Non-publishing day, skipped per the cadence. Nothing was published.';
    const SUN = new Date('2026-08-09T12:00:00Z'); // getUTCDay() === 0
    const MON = new Date('2026-08-03T12:00:00Z'); // getUTCDay() === 1
    const SAT = new Date('2026-08-08T12:00:00Z'); // getUTCDay() === 6
    const v = (instruction: string, now: Date) =>
      scheduledRunSignalsConditionalSkip(SKIP, { toolCalls: [], now, instruction });

    // Each of these authorizes AND yields a usable weekday cadence.
    [
      'This schedule runs DAILY but only publishes on Monday, Wednesday, and Friday.',
      'Publish only on Mon/Wed/Fri.',
      'Post only on Monday, Wednesday and Friday.',
      'We only post on Mon, Wed and Fri.',
      'Publishes only on Monday, Wednesday, Friday.',
      'Only on Monday, Wednesday and Friday.',
      'If today is Tuesday, Thursday, Saturday, or Sunday, DO NOT create or publish anything.',
      "Doesn't publish on weekends.",
      'Publish only on weekdays.',
    ].forEach((i) => expect([i, v(i, SUN)]).toEqual([i, true]));

    // …and the same wordings must still REJECT a skip on a real publishing day.
    [
      'This schedule runs DAILY but only publishes on Monday, Wednesday, and Friday.',
      'Publish only on Mon/Wed/Fri.',
      'We only post on Mon, Wed and Fri.',
    ].forEach((i) => expect([i, v(i, MON)]).toEqual([i, false]));

    // A bare "only on" inside a SKIP clause must not be read as a publish cadence —
    // otherwise "skip only on Saturday" would make Saturday a publishing day.
    expect(v('Skip only on Saturday.', SAT)).toBe(true);
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

  it('does not invent a cadence from a weekday bound to a noun/possessive (Greptile P1)', () => {
    const sunday = new Date('2026-08-02T12:00:00Z');
    const monday = new Date('2026-08-03T12:00:00Z');
    const skipProse = 'This is a non-publishing day per the cadence. Skipping this run.';

    // A weekday used possessively or as an adjective on a noun ("Monday's approval",
    // "Monday team", "Wednesday review") is an approval/condition gate, NOT a
    // weekday cadence — no cadence day-sets, so the skip fails closed on every day.
    for (const instr of [
      "Publish only on Monday's approval.",
      'Publish only on approval from the Monday team.',
      'Publish only on the Wednesday review outcome.',
    ]) {
      expect(scheduledRunSignalsConditionalSkip(skipProse, { now: sunday, instruction: instr })).toBe(false);
      expect(scheduledRunSignalsConditionalSkip(skipProse, { now: monday, instruction: instr })).toBe(false);
    }

    // Sanity: a genuine day-LIST of the same shape still parses and waives correctly.
    const realCadence = 'Publish only on Monday, Wednesday and Friday.';
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: sunday, instruction: realCadence })).toBe(true);
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: monday, instruction: realCadence })).toBe(false);
  });

  it('applies the cadence-context guard to RANGES and shorthands too, not just singletons (Greptile P1)', () => {
    const saturday = new Date('2026-08-08T12:00:00Z'); // getUTCDay() === 6
    const skipProse = 'This is a non-publishing day per the cadence. Skipping this run.';

    // A range or weekend/weekday shorthand bound to a noun/possessive is an approval
    // gate, NOT a cadence — it must not invent one (a Saturday run would otherwise be
    // wrongly waived). Greptile's exact example is the first.
    for (const instr of [
      'Publish only when the Monday to Friday team approves.',
      "Publish only on Mon-Fri's sign-off.",
      'Publish only on weekend approvals.',
      'Publish only on weekday escalations.',
    ]) {
      expect(scheduledRunSignalsConditionalSkip(skipProse, { now: saturday, instruction: instr })).toBe(false);
    }

    // Sanity: genuine range / shorthand cadences still parse (Saturday is outside Mon–Fri).
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: saturday, instruction: 'Publish only on Monday to Friday.' })).toBe(true);
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: saturday, instruction: 'Publish only on weekdays.' })).toBe(true);
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

describe('reconstructPriorToolCalls (ENG-844)', () => {
  it('prefers the executed ledger so a failed prior call keeps its error', () => {
    // Message carries BOTH the request-only tool_calls (no error) and the persisted
    // execution ledger (with error). The executed ledger must win.
    const messages = [{
      tool_calls: [{ function: { name: 'send_email_from_sender' } }],
      metadata: { toolCalls: [{ name: 'send_email_from_sender', error: 'SMTP 550' }] },
    }];
    expect(reconstructPriorToolCalls(messages)).toEqual([{ name: 'send_email_from_sender', error: 'SMTP 550' }]);
  });

  it('preserves a structured error from the executed ledger', () => {
    const messages = [{ metadata: { toolCalls: [{ name: 'post_on_connected_account', error: { code: 500 } }] } }];
    expect(reconstructPriorToolCalls(messages)).toEqual([{ name: 'post_on_connected_account', error: { code: 500 } }]);
  });

  it('falls back to request tool_calls when a message has no executed ledger', () => {
    const messages = [{ tool_calls: [{ function: { name: 'get_leads' } }] }];
    expect(reconstructPriorToolCalls(messages)).toEqual([{ name: 'get_leads' }]);
  });

  it('drops nameless calls and tolerates non-array input', () => {
    expect(reconstructPriorToolCalls(undefined as any)).toEqual([]);
    expect(reconstructPriorToolCalls([{ metadata: { toolCalls: [{}, { name: 'get_leads' }] } }])).toEqual([{ name: 'get_leads' }]);
  });

  // ENG-1045: the publish-outcome check reads arguments.action, so the reconstruction
  // must carry the arguments through — otherwise a resumed run that already published
  // a thread falls back into the "post_on_connected_account (1 more time needed)" loop.
  it('carries the action argument from the executed ledger', () => {
    const messages = [{
      metadata: { toolCalls: [{ name: 'twitter_manage_post', arguments: { action: 'post_thread', tweets: ['a', 'b'] } }] },
    }];
    expect(reconstructPriorToolCalls(messages)).toEqual([
      { name: 'twitter_manage_post', arguments: { action: 'post_thread', tweets: ['a', 'b'] } },
    ]);
  });

  it('parses the JSON-string arguments of a request-list fallback', () => {
    const messages = [{ tool_calls: [{ function: { name: 'twitter_manage_post', arguments: '{"action":"post_thread"}' } }] }];
    expect(reconstructPriorToolCalls(messages)).toEqual([
      { name: 'twitter_manage_post', arguments: { action: 'post_thread' } },
    ]);
  });

  it('omits unparseable arguments but keeps the entry and its error', () => {
    const messages = [{
      metadata: { toolCalls: [{ name: 'twitter_manage_post', arguments: '{not json', error: 'boom' }] },
    }];
    expect(reconstructPriorToolCalls(messages)).toEqual([{ name: 'twitter_manage_post', error: 'boom' }]);
  });

  it('lets a resumed post_thread entry satisfy a post_on_connected_account requirement', () => {
    const [entry] = reconstructPriorToolCalls([{
      metadata: { toolCalls: [{ name: 'twitter_manage_post', arguments: { action: 'post_thread' }, result: { success: true } }] },
    }]);
    expect(callSatisfiesRequirement('post_on_connected_account', entry)).toBe(true);

    // A resumed thread that FAILED still leaves the publish owed.
    const [failed] = reconstructPriorToolCalls([{
      metadata: { toolCalls: [{ name: 'twitter_manage_post', arguments: { action: 'post_thread' }, error: 'rate limited' }] },
    }]);
    expect(callSatisfiesRequirement('post_on_connected_account', failed)).toBe(false);
  });

  // ENG-1045: the real persisted shape — the executed ledger is CUMULATIVE and lands
  // on the message that CLOSES the turn, while each intermediate assistant message
  // keeps its own request-only tool_calls. Verified against prod session 555bb0a4,
  // where 26 real calls reconstructed as 52 entries. Because these entries seed the
  // required-call counts, the doubling let ONE real publish satisfy a minCount of 2.
  it('counts a call once when the request list and the closing turn ledger both carry it', () => {
    const messages = [
      { tool_calls: [{ id: 'call_1', function: { name: 'you_search_web', arguments: '{"q":"x"}' } }] },
      { tool_calls: [{ id: 'call_2', function: { name: 'twitter_manage_post', arguments: '{"action":"post_thread"}' } }] },
      {
        metadata: {
          toolCalls: [
            { id: 'call_1', name: 'you_search_web', arguments: { q: 'x' }, result: {} },
            { id: 'call_2', name: 'twitter_manage_post', arguments: { action: 'post_thread' }, result: {} },
          ],
        },
      },
    ];

    const entries = reconstructPriorToolCalls(messages);
    expect(entries).toHaveLength(2);
    expect(countCallsSatisfyingRequirement('post_on_connected_account', entries)).toBe(1);
  });

  it('upgrades a request-list entry to the ledger entry so a later-recorded failure still vetoes', () => {
    const messages = [
      { tool_calls: [{ id: 'call_1', function: { name: 'twitter_manage_post', arguments: '{"action":"post_thread"}' } }] },
      { metadata: { toolCalls: [{ id: 'call_1', name: 'twitter_manage_post', arguments: { action: 'post_thread' }, error: 'X API 401' }] } },
    ];

    // One entry, and it is the one carrying the error — so the publish stays owed.
    expect(reconstructPriorToolCalls(messages)).toEqual([
      { name: 'twitter_manage_post', arguments: { action: 'post_thread' }, error: 'X API 401' },
    ]);
    expect(countCallsSatisfyingRequirement('post_on_connected_account', reconstructPriorToolCalls(messages))).toBe(0);
  });

  it('never collapses distinct calls, and keeps un-identified entries separate', () => {
    // Two genuine publishes with distinct ids must both count.
    const distinct = reconstructPriorToolCalls([{
      metadata: {
        toolCalls: [
          { id: 'call_1', name: 'twitter_manage_post', arguments: { action: 'post_thread' }, result: {} },
          { id: 'call_2', name: 'twitter_manage_post', arguments: { action: 'post_thread' }, result: {} },
        ],
      },
    }]);
    expect(countCallsSatisfyingRequirement('post_on_connected_account', distinct)).toBe(2);

    // No id means unknown identity, which is not evidence of sameness — keep both.
    const noIds = reconstructPriorToolCalls([{
      metadata: {
        toolCalls: [
          { name: 'twitter_manage_post', arguments: { action: 'post_thread' }, result: {} },
          { name: 'twitter_manage_post', arguments: { action: 'post_thread' }, result: {} },
        ],
      },
    }]);
    expect(noIds).toHaveLength(2);
  });

  // ENG-947/ENG-1045: a preflight rejection commonly comes back as
  // `result.success: false` with NO top-level `error` at all (e.g. publish_blog_article's
  // result extraction only sets `error` when the tool itself supplied one). callSatisfiesRequirement's
  // exact-name-match branch now calls toolCallSucceeded for every publish requirement, which reads
  // `result.success`, so dropping `result` on reconstruction would silently credit an abandoned
  // portion's failed publish as a success on resume.
  it('carries the result through so a resumed publish that failed WITHOUT a top-level error still vetoes', () => {
    const [entry] = reconstructPriorToolCalls([{
      metadata: { toolCalls: [{ name: 'post_on_connected_account', result: { success: false, message: 'Multiple twitter accounts connected' } }] },
    }]);
    expect(entry).toEqual({
      name: 'post_on_connected_account',
      result: { success: false, message: 'Multiple twitter accounts connected' },
    });
    expect(callSatisfiesRequirement('post_on_connected_account', entry)).toBe(false);

    // Control: the same shape but result.success: true — must be credited.
    const [succeeded] = reconstructPriorToolCalls([{
      metadata: { toolCalls: [{ name: 'post_on_connected_account', result: { success: true, tweetId: '1' } }] },
    }]);
    expect(callSatisfiesRequirement('post_on_connected_account', succeeded)).toBe(true);
  });

  it('carries duplicateOf through so a resumed suppressed same-turn duplicate is not credited', () => {
    const [entry] = reconstructPriorToolCalls([{
      metadata: { toolCalls: [{ name: 'post_on_connected_account', duplicateOf: 'call_1' }] },
    }]);
    expect(entry).toEqual({ name: 'post_on_connected_account', duplicateOf: 'call_1' });
    expect(callSatisfiesRequirement('post_on_connected_account', entry)).toBe(false);
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

  it('END-TO-END prod regression (session 25ec4670, Thu 2026-08-06): count-first ledger still exits as a clean skip', async () => {
    // Mirrors the PROD schedule exactly as stored: no `timezone` (UTC fallback) and
    // an EMPTY functionCallMinCalls map, with both write tools required. Before the
    // fix this run burned all 20 attempts and was recorded as a failure.
    const prodSchedule = {
      scheduleId: mockScheduleId,
      scheduleName: 'LUCAS — LinkedIn Thought Leadership (Mon/Wed/Fri)',
      startingMessage:
        'You are LUCAS, the LinkedIn thought-leadership agent for IncentivPay. This schedule runs DAILY but only publishes on Monday, Wednesday, and Friday.\n\n' +
        'FIRST: check today\'s actual weekday. If today is Tuesday, Thursday, Saturday, or Sunday, DO NOT create or publish anything — simply stop and report "LUCAS: non-publishing day, skipped."',
      keywords: [],
      requiredFunctionCalls: ['generate_image', 'post_on_connected_account'],
      functionCallMinCalls: {},
      userId: mockUserId,
    };
    mockScheduleDb.getScheduleById.mockResolvedValue(prodSchedule);
    mockWorker.runInWorker.mockResolvedValue({
      content:
        'LUCAS: non-publishing day, skipped.\n\n' +
        '<p><strong>Date check:</strong> Today is <strong>Thursday, 6 August 2026</strong>. This schedule only publishes Monday / Wednesday / Friday, so no post, no image, and no publishing calls were made this run.</p>\n\n' +
        '<p><strong>Nothing published:</strong> no image generated, no comments seeded. Ledger: 0 attempted / 0 succeeded / 0 failed / 0 queued.</p>',
      toolCalls: [],
      knowledgeBaseQueries: [], sources: [], responseMessages: [],
    });

    const THURSDAY = new Date('2026-08-06T13:00:26Z');
    const result = await runScheduledChat(prodSchedule, mockUserId, true, undefined, THURSDAY);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        status: 'success',
        passed: true,
        attempt: 1,
        functionCallMisses: [],
        conditionalSkip: true,
      })
    );
  });

  it('does NOT waive a resumed run whose abandoned portion made a non-required write (Greptile P1)', async () => {
    // The current turn reports a legitimate cadence skip with zero writes, but the
    // abandoned portion this run RESUMED already sent an email — carried in
    // priorToolCalls. That external side effect must be visible to the no-writes
    // skip ledger, so the run is NOT waived as a clean skip.
    mockWorker.runInWorker.mockResolvedValue({
      content: 'Today is a non-publishing day per the Mon/Wed/Fri cadence. Skipping this run.',
      toolCalls: [],
      knowledgeBaseQueries: [], sources: [], responseMessages: [],
    });

    const baseParams = {
      sessionId: 'test-session-lucas',
      userId: mockUserId,
      startingMessage: 'Publish today\'s thought-leadership post only on Mon/Wed/Fri.',
      keywords: [] as string[],
      requiredFunctions: [{ functionName: 'post_on_connected_account', minCount: 1 }],
      completionGate: true,
      maxAttempts: 2,
      now: SUNDAY_NON_PUBLISH,
    };

    const resumed = await runVerifiedChat({ ...baseParams, priorToolCalls: [{ name: 'send_email_from_sender' }] });
    expect(resumed.success).toBe(false);
    expect((resumed as any).conditionalSkip).toBeUndefined();

    // A prior tool ERROR also blocks the skip — even on a READ tool that would not
    // veto on its own. Proves the preserved error property (not just writes) rejects
    // a resumed run whose abandoned portion failed.
    const priorError = await runVerifiedChat({ ...baseParams, priorToolCalls: [{ name: 'get_leads', error: 'HTTP 500 from CRM' }] });
    expect(priorError.success).toBe(false);
    expect((priorError as any).conditionalSkip).toBeUndefined();

    // Control: the identical run with NO prior write/error is legitimately waived —
    // proving the prior write/error is what blocks it, not the cadence/date.
    const clean = await runVerifiedChat({ ...baseParams, priorToolCalls: [{ name: 'get_leads' }] });
    expect(clean.success).toBe(true);
    expect((clean as any).conditionalSkip).toBe(true);
  });

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
