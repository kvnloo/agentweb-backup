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
import { emmaToolRegistry } from '../emma/registry';
import '../emma/tools';

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

  it('fires on the REAL 2026-08-16 prod regression: perform_data_analysis used to check the weekday (ENG-1276, session 17834849…)', () => {
    // The LUCAS prompt's FIRST instruction is "check today's actual weekday" — the
    // agent complied by calling perform_data_analysis to compute the weekday via
    // Python, THEN reported the clean skip with zero write calls. perform_data_analysis
    // is a pure compute/read tool (runs code on caller-supplied data, no external
    // side effects) but its name doesn't lead with any READ_ONLY_TOOL verb
    // (get/read/list/fetch/search/describe/analyze/…), so the fail-safe allowlist
    // misclassified it as a WRITE call, tripped the non-required-write veto (step 3),
    // and the run was pressed with "Make sure to generate_image (1 more time needed),
    // post_on_connected_account (1 more time needed)" despite a correct, documented
    // skip.
    const SUNDAY_1616 = new Date('2026-08-16T13:26:36Z');
    expect(SUNDAY_1616.getUTCDay()).toBe(0);
    const instruction =
      'You are LUCAS, the LinkedIn thought-leadership agent for IncentivPay. This schedule runs DAILY but only publishes on Monday, Wednesday, and Friday.\n\n' +
      'FIRST: check today\'s actual weekday. If today is Tuesday, Thursday, Saturday, or Sunday, DO NOT create or publish anything — simply stop and report "LUCAS: non-publishing day, skipped." Only proceed on Monday, Wednesday, or Friday.';
    const realSkip =
      '<strong>LUCAS: non-publishing day, skipped.</strong>\n\n' +
      '<p>Weekday check ran first, as instructed:</p>\n' +
      '<ul>\n' +
      '<li><strong>Date:</strong> 2026-08-16</li>\n' +
      '<li><strong>Weekday:</strong> Sunday (verified via date computation this session, not assumed)</li>\n' +
      '<li><strong>Publishing days:</strong> Monday / Wednesday / Friday only</li>\n' +
      '</ul>\n\n' +
      '<p><strong>Actions taken this run: none.</strong> No post drafted, no image generated, nothing published to any of the four destinations.</p>';
    expect(scheduledRunSignalsConditionalSkip(realSkip, {
      now: SUNDAY_1616,
      instruction,
      toolCalls: [{ name: 'perform_data_analysis' }],
    })).toBe(true);
  });

  describe('registry-declared readOnly tools (ENG-1276 follow-up)', () => {
    const SUNDAY = new Date('2026-08-02T12:00:00Z');
    const skipContent = 'Today is Sunday, a non-publishing day. Skipping — no post created.';

    // emmaToolRegistry is a process-wide singleton — a fake tool registered by
    // one test leaks into every test that runs after it in this file (no public
    // unregister API), which would otherwise break the drift guard's exact-set
    // assertion below the moment test order changes it runs after these.
    afterEach(() => {
      (emmaToolRegistry as any).tools?.delete('fake_registry_readonly_tool');
      (emmaToolRegistry as any).tools?.delete('fake_registry_write_tool');
    });

    it('treats a tool the registry declares readOnly:true as read, not write', () => {
      emmaToolRegistry.register({
        name: 'fake_registry_readonly_tool',
        definition: { name: 'fake_registry_readonly_tool', description: 'test', inputSchema: { type: 'object', properties: {} } },
        execute: async () => ({}),
        readOnly: true,
      });
      expect(scheduledRunSignalsConditionalSkip(skipContent, {
        now: SUNDAY,
        toolCalls: [{ name: 'fake_registry_readonly_tool' }],
      })).toBe(true);
    });

    it('still treats a registered tool with readOnly unset (or false) as a write', () => {
      emmaToolRegistry.register({
        name: 'fake_registry_write_tool',
        definition: { name: 'fake_registry_write_tool', description: 'test', inputSchema: { type: 'object', properties: {} } },
        execute: async () => ({}),
      });
      expect(scheduledRunSignalsConditionalSkip(skipContent, {
        now: SUNDAY,
        toolCalls: [{ name: 'fake_registry_write_tool' }],
      })).toBe(false);
    });

    it('still treats an UNREGISTERED tool name as a write (fail-safe default unchanged)', () => {
      expect(scheduledRunSignalsConditionalSkip(skipContent, {
        now: SUNDAY,
        toolCalls: [{ name: 'totally_unknown_tool_xyz' }],
      })).toBe(false);
    });

    // Pins the PRODUCTION configuration itself — verified read-only by reading
    // each tool's actual execute() implementation (not just its name/description,
    // since ENG-1276 is precisely about those lying): perform_deep_research only
    // calls Gemini Deep Research + uploads to internal S3 (no external publish);
    // call_google_ads_reporting_api and call_linkedin_ads_insights_api only fetch
    // analytics, with no write-capable action in their schemas at all — unlike
    // their write-bundling siblings call_google_ads_api/call_linkedin_marketing_api,
    // which correctly stay unflagged.
    it('the real tool registry flags the confirmed side-effect-free analogs of perform_data_analysis', () => {
      const readOnlyNames = ['perform_deep_research', 'call_google_ads_reporting_api', 'call_linkedin_ads_insights_api'];
      for (const name of readOnlyNames) {
        expect([name, emmaToolRegistry.getTool(name)?.readOnly]).toEqual([name, true]);
        expect([name, scheduledRunSignalsConditionalSkip(skipContent, { now: SUNDAY, toolCalls: [{ name }] })]).toEqual([name, true]);
      }
    });

    it('does NOT flag the write-bundling siblings of the read-only analytics tools', () => {
      const writeNames = ['call_google_ads_api', 'call_linkedin_marketing_api', 'call_hubspot_api'];
      for (const name of writeNames) {
        expect([name, emmaToolRegistry.getTool(name)?.readOnly]).toEqual([name, undefined]);
        expect([name, scheduledRunSignalsConditionalSkip(skipContent, { now: SUNDAY, toolCalls: [{ name }] })]).toEqual([name, false]);
      }
    });

    // DRIFT GUARD — readOnly:true is a manual, point-in-time judgment call, made
    // by reading each tool's actual execute() implementation (see the comments
    // beside each registration in emma/tools.ts). Nothing else re-checks that
    // judgment as the tool evolves: if a future edit adds a write-capable action
    // to one of these three tools, the flag goes stale SILENTLY and creates a
    // new false-skip bug — the exact same category that caused ENG-1276 in the
    // first place, just relocated from a tool NAME to a tool FLAG. This walks
    // every enum in each readOnly tool's inputSchema (that's how every write
    // action in this codebase's tools is expressed — CREATE/UPDATE/DELETE/POST/
    // etc., see call_google_ads_api, call_hubspot_api, twitter_manage_post) and
    // fails loudly if one ever appears. It also pins the exact readOnly SET, so
    // adding or removing a flag is a deliberate, reviewed edit to this test —
    // not an incidental side effect of an unrelated change.
    it('drift guard: no readOnly-flagged tool schema exposes a write-shaped action value', () => {
      // \w* trails EVERY verb, not just the ones with a known compound today
      // (SEND_TEST, ADD_ASSET, CREATE_INLINE, ...) — a bare trailing \b would
      // miss a FUTURE compound like PUBLISH_RESULTS, since \w includes the
      // underscore and there is no boundary between PUBLISH and _RESULTS.
      // Widened on independent review (ENG-1276 follow-up): the original list
      // was drawn from verbs already observed in THIS registry's write tools,
      // which is exactly the reactive-allowlist trap this whole drift guard
      // exists to avoid for the readOnly flag itself. Added plausible future
      // write verbs that hadn't appeared yet — CANCEL/APPROVE/REJECT/SCHEDULE/
      // SUBSCRIBE/FOLLOW/BLOCK/ARCHIVE/ASSIGN/TAG/SHARE/GRANT/REVOKE/TRANSFER/
      // MERGE — none of which collide with any current readOnly tool's actual
      // enum values (verified by running this test after widening).
      const WRITE_SHAPED_VALUE = /\b(?:CREATE|UPDATE|DELETE|REMOVE|POST|PUBLISH|SEND|UPLOAD|ADD|ATTACH|REPOST|COMMENT|REACT|LIKE|UNLIKE|RETWEET|UNRETWEET|PAUSE|RESUME|ENABLE|DISABLE|WRITE|SET|MODIFY|EDIT|RETAG_UTM|CANCEL|APPROVE|REJECT|SCHEDULE|SUBSCRIBE|FOLLOW|UNFOLLOW|BLOCK|UNBLOCK|ARCHIVE|UNARCHIVE|ASSIGN|UNASSIGN|TAG|UNTAG|SHARE|GRANT|REVOKE|TRANSFER|MERGE)\w*/i;

      function collectEnumValues(schema: any, out: string[] = []): string[] {
        if (!schema || typeof schema !== 'object') return out;
        if (Array.isArray(schema.enum)) out.push(...schema.enum);
        for (const value of Object.values(schema)) {
          if (value && typeof value === 'object') collectEnumValues(value, out);
        }
        return out;
      }

      const readOnlyTools = emmaToolRegistry.getAllTools().filter((t) => t.readOnly === true);
      expect(readOnlyTools.map((t) => t.name).sort()).toEqual([
        'call_google_ads_reporting_api',
        'call_linkedin_ads_insights_api',
        'perform_deep_research',
      ]);
      for (const tool of readOnlyTools) {
        const enumValues = collectEnumValues(tool.definition?.inputSchema);
        const suspicious = enumValues.filter((v) => typeof v === 'string' && WRITE_SHAPED_VALUE.test(v));
        expect([tool.name, suspicious]).toEqual([tool.name, []]);
      }
    });
  });

  // ENG-1276 follow-up #3 — a full audit of the tool-substitution class of bug,
  // not just the one instance (twitter_manage_post/post_on_connected_account)
  // that had already broken production. Every tool whose description tells the
  // model to use, or prefer, a DIFFERENT registered tool is a candidate for the
  // same bug: a schedule's requiredFunctionCalls names one, the model
  // legitimately uses the other, and the requirement never gets credited.
  //
  // This is a PINNED, REVIEWED catalog, not a live "is this safe" classifier —
  // classifying "is tool B really a substitute for tool A" requires reading
  // each pair's actual execute() implementation (name/description text lies,
  // that is the whole premise of ENG-1276), which is a human judgment call each
  // time. What this test buys: the judgment only has to happen ONCE per pair,
  // and it happens LOUDLY — a NEW pair appearing (a new tool registered, or an
  // existing description edited to add a redirect) fails this test and forces
  // the same review before it can ship silently.
  //
  // Disposition of every pair found as of this audit:
  //   - twitter_manage_post -> post_on_connected_account: REAL bug (three
  //     production schedules, 10+ Linear duplicates 2026-08-03..08-12). FIXED
  //     — aliased (post_thread action only).
  //   - email -> send_email_from_sender, send_email_from_sender -> email: same
  //     shape, verified via both execute() paths (email's send action is a real
  //     write through resolveEmailAccount(..., 'send'); send_email_from_sender
  //     has no action param, every call sends). No production incident yet, but
  //     the mechanism is identical and verified, so FIXED proactively —
  //     aliased bidirectionally.
  //   - create_work_plan -> modify_work_plan: INVESTIGATED, NOT a valid alias.
  //     modifyWorkPlan requires a PRE-EXISTING work plan and returns
  //     `{success: false}` with no plan — it can never substitute for
  //     create_work_plan, so aliasing it would credit a call that (if it ever
  //     happens with no plan) represents a FAILURE to do what was needed.
  //   - call_meta_ads_insights_api <-> get_meta_ads_metrics: both READ-ONLY
  //     reporting tools that redirect to each other by query shape (custom GAQL
  //     vs quick dashboard). Real analog in SHAPE, but not in STAKES — even a
  //     false negative here nudges toward a redundant read, not an off-cadence
  //     publish. Not aliased; logged here so it isn't silently missed.
  //   - delete_leads_by_filter -> delete_leads (+ -> search_leads): a real
  //     destructive action, but delete_leads_by_filter carries its OWN
  //     confirm-gated two-phase workflow (preview, then confirm=true) — a
  //     different shape than a simple action-flag alias, and unlike email/
  //     twitter there is no evidence any schedule requires delete_leads.
  //     Deprioritized, not aliased; logged so it isn't silently missed either.
  //   - ask_crm <-> get_leads/search_leads: ask_crm is a free-form NL query tool
  //     that redirects to get_leads/search_leads "for single-list browsing" —
  //     different QUERY SHAPES over the same data, not an account-state-driven
  //     substitute. All three already classify as read-only by name (ask_/get_/
  //     search_ all match READ_ONLY_TOOL), so even a miss here can only nudge
  //     toward a redundant read, never a false-skip or a missed publish.
  //   - describe_image/describe_video <-> read_file_content, get_deployment_status
  //     -> coding_agent, remove_image_background -> generate_image/
  //     update_html_file, and every other pair (compose_video<->generate_video,
  //     create_blog_article<->create_html_file, create_html_file<->
  //     create_html_template, create_html_file->generate_landing_page,
  //     create_image_task_from_prompt->generate_image, create_revision->
  //     generate_image/update_html_file, perform_deep_research->
  //     create_blog_article, remove_c2pa_from_image->remove_image_background,
  //     update_book_content->generate_book_content): routes between DIFFERENT
  //     deliverable types/content types/scopes, not a same-outcome substitute
  //     for the SAME requirement — aliasing any of these would credit a call
  //     that did not produce what was required. create_image_task_from_prompt
  //     and create_revision are also [DEPRECATED], further lowering their
  //     real-world likelihood.
  it('redirect audit: pins every "use/prefer tool X instead" cross-reference between two registered tools (ENG-1276 follow-up #3)', () => {
    const allTools = emmaToolRegistry.getAllTools();
    const allNames = allTools.map((t) => t.name);
    const pairs = new Set<string>();
    for (const tool of allTools) {
      const desc = tool.definition?.description ?? '';
      for (const otherName of allNames) {
        if (otherName === tool.name) continue;
        const mentionsRedirect = new RegExp(
          `\\b${otherName}\\b[^.]{0,40}\\b(?:instead|prefer)\\b|\\b(?:instead|prefer)\\b[^.]{0,40}\\b${otherName}\\b`,
          'i'
        );
        if (mentionsRedirect.test(desc)) pairs.add(`${tool.name} -> ${otherName}`);
      }
    }
    expect([...pairs].sort()).toEqual(
      [
        'ask_crm -> get_leads',
        'ask_crm -> search_leads',
        'call_meta_ads_insights_api -> get_meta_ads_metrics',
        'compose_video -> generate_video',
        'create_blog_article -> create_html_file',
        'create_html_file -> create_blog_article',
        'create_html_file -> create_html_template',
        'create_html_file -> generate_landing_page',
        'create_html_template -> create_html_file',
        'create_image_task_from_prompt -> generate_image',
        'create_revision -> generate_image',
        'create_revision -> update_html_file',
        'create_work_plan -> modify_work_plan',
        'delete_leads_by_filter -> delete_leads',
        'delete_leads_by_filter -> search_leads',
        'describe_image -> read_file_content',
        'describe_video -> read_file_content',
        'email -> send_email_from_sender',
        'generate_video -> compose_video',
        'get_deployment_status -> coding_agent',
        'get_meta_ads_metrics -> call_meta_ads_insights_api',
        'perform_deep_research -> create_blog_article',
        'read_file_content -> describe_image',
        'read_file_content -> describe_video',
        'remove_c2pa_from_image -> remove_image_background',
        'remove_image_background -> generate_image',
        'remove_image_background -> update_html_file',
        'search_leads -> ask_crm',
        'send_email_from_sender -> email',
        'twitter_manage_post -> post_on_connected_account',
        'update_book_content -> generate_book_content',
      ].sort()
    );
  });

  it('fires on the REAL 2026-08-15 prod regression: a NEGATED "failure" mention read as hard failure evidence (ENG-1276 follow-up, session 7f95530d…)', () => {
    // The day BEFORE the perform_data_analysis regression above, the SAME schedule
    // hit the SAME 20-attempt nudge trap through a completely different mechanism:
    // this run made ZERO tool calls at all (the model reasoned the weekday in
    // prose, never touching perform_data_analysis or anything else), so the
    // write-call veto (step 3) was never in play. The skip explanation instead
    // said "Posts published: 0 (by design, not by failure)" — HARD_FAILURE_PATTERNS
    // (step 2a) matches the bare word "failure" ANYWHERE in the turn with no
    // negation awareness, so this benign sentence EXPLICITLY DENYING a failure
    // tripped the veto exactly like a real one would.
    const SATURDAY_0815 = new Date('2026-08-15T13:26:57.527Z');
    expect(SATURDAY_0815.getUTCDay()).toBe(6);
    const instruction =
      'You are LUCAS, the LinkedIn thought-leadership agent for IncentivPay. This schedule runs DAILY but only publishes on Monday, Wednesday, and Friday.\n\n' +
      'FIRST: check today\'s actual weekday. If today is Tuesday, Thursday, Saturday, or Sunday, DO NOT create or publish anything — simply stop and report "LUCAS: non-publishing day, skipped." Only proceed on Monday, Wednesday, or Friday.';
    const realSkip =
      'LUCAS: non-publishing day, skipped.\n\n' +
      '<p><strong>Weekday check:</strong> Today is <strong>Saturday, 15 August 2026</strong>. This schedule only publishes Monday, Wednesday, and Friday — so nothing was created and nothing was published.</p>\n\n' +
      '<ul>\n' +
      '<li>Posts published: <strong>0</strong> (by design, not by failure)</li>\n' +
      '<li>Images generated: <strong>0</strong></li>\n' +
      '<li>Tool calls made: <strong>none</strong> — no brand/market reads, no research, no publish attempts</li>\n' +
      '</ul>';
    expect(scheduledRunSignalsConditionalSkip(realSkip, {
      now: SATURDAY_0815,
      instruction,
      toolCalls: [],
    })).toBe(true);
  });

  it('NEGATION AUDIT: a denied failure/error is waived; a genuine one nearby still vetoes', () => {
    const INST =
      'This schedule runs DAILY but only publishes on Monday, Wednesday, and Friday. ' +
      'If today is Tuesday, Thursday, Saturday, or Sunday, DO NOT create or publish anything — ' +
      'simply stop and report "non-publishing day, skipped."';
    const THU = new Date('2026-08-06T13:00:00Z');
    const verdict = (t: string) =>
      scheduledRunSignalsConditionalSkip(t, { toolCalls: [], now: THU, instruction: INST });

    // A denied failure/error is the OPPOSITE of hard failure evidence.
    [
      'Non-publishing day, skipped. Posts published: 0 (by design, not by failure).',
      'Non-publishing day, skipped. This was not a failure — the cadence simply excludes today.',
      'Non-publishing day, skipped. No failure occurred; nothing was attempted.',
      'Non-publishing day, skipped. Nothing was published, without any failure on our end.',
    ].forEach((t) => expect([t, verdict(t)]).toEqual([t, true]));

    // A genuine failure elsewhere in the SAME turn must still veto — neutralizing
    // one denied mention must not blind the check to a real one nearby.
    [
      'Non-publishing day, skipped. Not a failure of the schedule, but image generation failed.',
      'Non-publishing day, skipped. No failure here, though the LinkedIn API timed out.',
    ].forEach((t) => expect([t, verdict(t)]).toEqual([t, false]));
  });

  it('NEGATION AUDIT #2: the negation-to-failure span tolerates intervening words, but stays clause-bounded (ENG-1276 follow-up)', () => {
    // The original NEGATED_FAILURE_MENTION only caught the negation word landing
    // DIRECTLY on the failure noun (an optional article/"by" in between, nothing
    // more) — "not by failure" but not "not a SINGLE failure" or "no REAL error".
    // Real English negation isn't that rigid, so this generalizes to a tempered
    // greedy token: the negation cue, then ANY text that doesn't cross a clause
    // boundary (a contrastive conjunction, or a sentence/semicolon break), then
    // the failure word. The bug class this closes is the SAME one that broke
    // "not by failure" (session 7f95530d) — just a different specific wording
    // that hadn't happened to occur yet.
    const INST =
      'This schedule runs DAILY but only publishes on Monday, Wednesday, and Friday. ' +
      'If today is Tuesday, Thursday, Saturday, or Sunday, DO NOT create or publish anything — ' +
      'simply stop and report "non-publishing day, skipped."';
    const THU = new Date('2026-08-06T13:00:00Z');
    const verdict = (t: string) =>
      scheduledRunSignalsConditionalSkip(t, { toolCalls: [], now: THU, instruction: INST });

    // Phrasings the OLD adjacency-only regex missed — negation and failure word
    // share a clause, just with more words between them than a bare article/"by".
    [
      'Non-publishing day, skipped. Not a single failure occurred today.',
      'Non-publishing day, skipped. There was never any failure to report.',
      'Non-publishing day, skipped. No real error happened on our end.',
    ].forEach((t) => expect([t, verdict(t)]).toEqual([t, true]));

    // Widening the span must stay fail-CLOSED: a negation cue must NOT reach
    // across a real clause break (a semicolon, or a contrastive conjunction like
    // "but"/"though") to neutralize an UNRELATED, genuine failure that follows it.
    [
      'Non-publishing day, skipped. No post today; auth failed.',
      'Non-publishing day, skipped. This was not a great day, but the LinkedIn post failed to publish.',
      'Non-publishing day, skipped. Not without effort, but the post failed to publish.',
    ].forEach((t) => expect([t, verdict(t)]).toEqual([t, false]));
  });

  it('NEGATION AUDIT #3: an interjection "No," must not bridge a comma-joined run-on to a genuine failure (ENG-1276 follow-up)', () => {
    // Found on a fresh adversarial re-audit of #2's own widening, NOT from a
    // production incident: "No," introducing an independent clause is
    // grammatically an INTERJECTION ("the answer is no"), not a negator of
    // whatever follows it — but the unbounded tempered-greedy-token from #2 had
    // no way to tell that apart from "No" used as a direct negator, so a
    // comma-joined run-on with no "but"/semicolon/period in between could bridge
    // all the way to a genuinely UNRELATED failure and wrongly neutralize it.
    // None of the LEGITIMATE cases in #1/#2 have a comma directly after the cue,
    // so rejecting that shape costs nothing real. Also bounds the maximum span
    // as a second, independent backstop against an unforeseen long bridge.
    const INST =
      'This schedule runs DAILY but only publishes on Monday, Wednesday, and Friday. ' +
      'If today is Tuesday, Thursday, Saturday, or Sunday, DO NOT create or publish anything — ' +
      'simply stop and report "non-publishing day, skipped."';
    const THU = new Date('2026-08-06T13:00:00Z');
    const verdict = (t: string) =>
      scheduledRunSignalsConditionalSkip(t, { toolCalls: [], now: THU, instruction: INST });

    [
      'Non-publishing day, skipped. No, unfortunately, today\'s run failed for unknown reasons.',
      'Non-publishing day, skipped. No, the deployment failed, we should investigate.',
      'Non-publishing day, skipped. No, it did not work — the post failed.',
    ].forEach((t) => expect([t, verdict(t)]).toEqual([t, false]));

    // The fix must not regress any of the genuine "No <word> failure/error"
    // negators from #1/#2 — none of them have a comma right after the cue.
    [
      'Non-publishing day, skipped. No real error happened on our end.',
      'Non-publishing day, skipped. No failure occurred; nothing was attempted.',
    ].forEach((t) => expect([t, verdict(t)]).toEqual([t, true]));
  });

  it('NEGATION AUDIT #4: the comma exclusion from #3 must be scoped to "no" only, not "not"/"never"/"without" (independent review finding)', () => {
    // An independent fresh-eyes review (not a production incident) reproduced a
    // real gap in #3's fix: `(?!\s*,)` was applied to ALL FOUR cue words, but
    // the interjection problem it fixes is specific to a bare "No," opening an
    // INDEPENDENT clause ("the answer is no; separately, X happened"). "Not,"/
    // "Never,"/"Without," followed by a comma are still fronted negations with
    // a parenthetical aside in between — the negation continues to apply across
    // the comma to whatever follows ("Without, admittedly, any failure
    // occurring..." still means "there was no failure"). Scoping the exclusion
    // to "no" alone fixes this without reopening #3's original gap (verified:
    // "No, unfortunately, ... failed" still isn't neutralized).
    //
    // NOT fixed here, and deliberately so: the review also found that a LONG
    // parenthetical after "never"/"not" ("Never, in this case, did we see a
    // failure" — 28 characters to the failure word) still doesn't get
    // neutralized, because it exceeds the 20-char span cap from #3. That cap is
    // independently load-bearing for a MORE realistic and MORE dangerous case —
    // "Not entirely sure why the deployment failed today" is a genuine failure
    // report (the hedge is about the CAUSE, not a denial that it happened), and
    // widening the cap to accommodate an elaborate courtroom-style parenthetical
    // would reopen that gap in the direction that matters more (a real failure
    // silently waived, not an unusual phrasing still causing a retry). See the
    // cap's own test coverage below.
    const INST =
      'This schedule runs DAILY but only publishes on Monday, Wednesday, and Friday. ' +
      'If today is Tuesday, Thursday, Saturday, or Sunday, DO NOT create or publish anything — ' +
      'simply stop and report "non-publishing day, skipped."';
    const THU = new Date('2026-08-06T13:00:00Z');
    const verdict = (t: string) =>
      scheduledRunSignalsConditionalSkip(t, { toolCalls: [], now: THU, instruction: INST });

    // Short parentheticals after not/never/without now correctly waive.
    [
      'Non-publishing day, skipped. Without, admittedly, any failure occurring, the run completed cleanly.',
    ].forEach((t) => expect([t, verdict(t)]).toEqual([t, true]));

    // "No," stays excluded — #3's original fix must not regress.
    [
      'Non-publishing day, skipped. No, unfortunately, today\'s run failed for unknown reasons.',
    ].forEach((t) => expect([t, verdict(t)]).toEqual([t, false]));

    // The length cap is a DELIBERATE trade-off, not an oversight: it still
    // blocks a long parenthetical after not/never (the elaborate cases the
    // review constructed), AND — the case that actually justifies keeping the
    // cap — a genuine failure hedged with "not entirely sure why" is NOT
    // wrongly waived.
    [
      'Non-publishing day, skipped. Never, in this case, did we see a failure.',
      'Non-publishing day, skipped. Not entirely sure why the deployment failed today.',
    ].forEach((t) => expect([t, verdict(t)]).toEqual([t, false]));
  });

  it('NEGATION AUDIT #5: a double negation ("not true that there was no failure") must not silently waive a real failure', () => {
    // The independent review that found audit #4 also found this: "It is not
    // true that there was no failure today" re-asserts a REAL failure, but
    // NEGATED_FAILURE_MENTION only sees the INNER "no failure" — it has no
    // concept of the OUTER "not true that" flipping the meaning back. This is
    // the dangerous direction (a genuine failure silently waived as a clean
    // skip), so unlike audit #4's elaborate-but-safe cases, this one is worth
    // closing even though the phrasing is unnatural for a scheduled-run status
    // line — there's no evidence it has happened, but the failure mode if it
    // did would be worse than an extra retry.
    //
    // Properly PARSING the double negation would need real negation-depth
    // tracking — a much bigger, riskier change bolted onto an already-layered
    // regex. Instead this FAILS CLOSED: a sentence that itself negates a TRUTH
    // CLAIM ("it is not true that...", "that's false...", "it is false
    // that...") is INELIGIBLE for the neutralization entirely — skip it, so
    // any failure word inside that sentence stays intact and still vetoes via
    // the normal HARD_FAILURE_PATTERNS check. Safe because it doesn't need to
    // understand the sentence, only recognize the shape and decline to be
    // clever about it.
    const INST =
      'This schedule runs DAILY but only publishes on Monday, Wednesday, and Friday. ' +
      'If today is Tuesday, Thursday, Saturday, or Sunday, DO NOT create or publish anything — ' +
      'simply stop and report "non-publishing day, skipped."';
    const THU = new Date('2026-08-06T13:00:00Z');
    const verdict = (t: string) =>
      scheduledRunSignalsConditionalSkip(t, { toolCalls: [], now: THU, instruction: INST });

    [
      'Non-publishing day, skipped. It is not true that there was no failure today.',
      "Non-publishing day, skipped. That's false — there was no failure today.",
      'Non-publishing day, skipped. It is false that no failure occurred.',
    ].forEach((t) => expect([t, verdict(t)]).toEqual([t, false]));

    // Must not regress any legitimate single-negation case from audits #1-#4 —
    // none of them contain a truth-negating construction, so the guard never
    // engages for them.
    [
      'Non-publishing day, skipped. Not by failure.',
      'Non-publishing day, skipped. No failure occurred; nothing was attempted.',
      'Non-publishing day, skipped. Without, admittedly, any failure occurring, the run completed cleanly.',
    ].forEach((t) => expect([t, verdict(t)]).toEqual([t, true]));

    // The guard's own "not" must be REQUIRED, not optional — self-caught on a
    // fresh re-audit before shipping. An earlier version of the pattern used
    // (?:not\s+)? (optional), so a plain, non-negated "it is true that there
    // was no failure" ALSO matched the meta-negation shape and wrongly
    // suppressed neutralization for a legitimate, single-negation denial —
    // over-cautious (still vetoes when it could safely waive), the safe
    // direction, but still a real behavior change from what audits #1-#4 in
    // the same file establish as correct.
    [
      'Non-publishing day, skipped. It is true that there was no failure today.',
    ].forEach((t) => expect([t, verdict(t)]).toEqual([t, true]));
  });

  it('NEGATION AUDIT #6: an uncertainty hedge ("not sure it failed") must not be read as a denial of failure', () => {
    // Independent CodeRabbit review finding (ENG-1276): "not sure it failed" or
    // "not certain there was an error" express UNCERTAINTY about whether a
    // failure happened — fundamentally different from "not by failure" (a
    // confident DENIAL). The tempered-greedy-token had no way to tell them
    // apart: "not" immediately followed by "sure"/"certain" still reached the
    // failure word within the 20-char span and got wrongly neutralized, which
    // could accept a cadence response with NO tool calls as a clean skip even
    // though the actual outcome is unresolved — the dangerous direction (an
    // unknown/possibly-failed run reported as a successful skip). The one
    // adversarial case already covered ("Not entirely sure why the deployment
    // failed today") only happened to be blocked by the 20-char span cap
    // (coincidence of word count, not an actual understanding of uncertainty
    // vs. denial) — a shorter phrasing like "not sure it failed" slips through
    // the cap and needs its own guard.
    const INST =
      'This schedule runs DAILY but only publishes on Monday, Wednesday, and Friday. ' +
      'If today is Tuesday, Thursday, Saturday, or Sunday, DO NOT create or publish anything — ' +
      'simply stop and report "non-publishing day, skipped."';
    const THU = new Date('2026-08-06T13:00:00Z');
    const verdict = (t: string) =>
      scheduledRunSignalsConditionalSkip(t, { toolCalls: [], now: THU, instruction: INST });

    [
      'Non-publishing day, skipped. Not sure it failed or not, will check next run.',
      'Non-publishing day, skipped. Not certain there was an error, but flagging it.',
      'Non-publishing day, skipped. Never sure if it failed given the ambiguous response.',
    ].forEach((t) => expect([t, verdict(t)]).toEqual([t, false]));

    // Must not regress any legitimate single-negation case from audits #1-#5 —
    // none of them have "sure"/"certain"/"confident"/"convinced"/"clear"
    // immediately after the cue.
    [
      'Non-publishing day, skipped. Not by failure.',
      'Non-publishing day, skipped. No failure occurred; nothing was attempted.',
      'Non-publishing day, skipped. Not a single failure occurred today.',
    ].forEach((t) => expect([t, verdict(t)]).toEqual([t, true]));
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
      'get_leads', 'describe_image', 'analyze_crm_data', 'ask_crm', 'audit_ad_utm_coverage', 'account_summary',
      'perform_data_analysis']) {
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

  it('recognizes PLURAL weekday names in the cadence, not just singular (live-verification follow-up, ENG-1276)', () => {
    // A production live-verification run for ENG-1276 used "This schedule only
    // publishes on Wednesdays" — the WEEKDAY_TOKEN regex only matched singular day
    // names, so the cadence clause parsed to zero days, publishDays stayed empty,
    // and the run fell through to the (unrelated) negated-conditional skip clause,
    // which named Wednesday for the WRONG reason and rejected the skip on Tuesday.
    // Net effect: the run hit the full 20-attempt retry press this ticket exists to
    // prevent, on live phrasing an owner would naturally write.
    const sunday = new Date('2026-08-02T12:00:00Z'); // getUTCDay() === 0
    const monday = new Date('2026-08-03T12:00:00Z'); // getUTCDay() === 1
    const tuesday = new Date('2026-08-04T12:00:00Z'); // getUTCDay() === 2
    const wednesday = new Date('2026-08-05T12:00:00Z'); // getUTCDay() === 3
    // Weekday-agnostic content (names no day itself) so it stays valid across every
    // `now` used below without tripping the separate model-asserted-weekday cross-
    // check in step (4), which is orthogonal to what this test targets.
    const skipProse = 'This is a non-publishing day per the cadence. Skipping this run.';

    // Positive cadence, multi-day, written with plural day names.
    const publishOnlyPluralMWF = 'This schedule only publishes on Mondays, Wednesdays, and Fridays.';
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: sunday, instruction: publishOnlyPluralMWF })).toBe(true);
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: monday, instruction: publishOnlyPluralMWF })).toBe(false);

    // Skip-day list written with plural day names.
    const skipListPlural = 'If today is a Saturday or a Sunday, publish nothing.';
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: sunday, instruction: skipListPlural })).toBe(true);
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: monday, instruction: skipListPlural })).toBe(false);

    // The exact live-verification shape: a single plural publish day, plus a
    // negated-conditional skip clause that ALSO names that same weekday (for the
    // opposite reason). The positive publish-day cadence must win.
    const singlePluralPublishDay =
      'This test schedule only publishes on Wednesdays. If today is NOT Wednesday: create and publish nothing.';
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: tuesday, instruction: singlePluralPublishDay })).toBe(true);
    expect(scheduledRunSignalsConditionalSkip(skipProse, { now: wednesday, instruction: singlePluralPublishDay })).toBe(false);
  });

  it('recognizes a plural weekday RANGE ("Mondays through Fridays") in the cadence', () => {
    const wednesday = new Date('2026-08-05T12:00:00Z'); // getUTCDay() === 3, inside the range
    const saturday = new Date('2026-08-08T12:00:00Z'); // getUTCDay() === 6, outside the range
    const skipProse = 'This is a non-publishing day per the cadence. Skipping this run.';
    for (const instr of ['Publish only on Mondays through Fridays.', 'Publish only on Mondays to Fridays.']) {
      expect(scheduledRunSignalsConditionalSkip(skipProse, { now: wednesday, instruction: instr })).toBe(false);
      expect(scheduledRunSignalsConditionalSkip(skipProse, { now: saturday, instruction: instr })).toBe(true);
    }
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
