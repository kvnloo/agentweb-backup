/**
 * ENG-1684 — an autocomplete work plan whose turn ends with no tool calls while a step is
 * still pending used to just sit there: the model was told "never leave a step pending
 * waiting on the user", but nothing enforced it. Production evidence: session
 * 7a9772f6-34ea-4db7-b550-92b5b17178f2 (Smart Water Heater GTM audit) ended a turn with
 * "Please retry the research, scoring, and reporting step to complete your request." and
 * then sat idle for 3h16m until a human happened to say "go ahead".
 *
 * hasStalledAutocompleteWorkPlan is the pure decision function scheduleAutoWorkPlanContinuation
 * (the ENG-1684 fix, same shape as ENG-1239's scheduleAutoMediaContinuation) gates on to
 * decide whether to auto-fire a continuation. This tests that decision directly rather than
 * the full continuation plumbing, which reuses generateSessionResponse/withGenerationTimeout/
 * the session-generation lock exactly as the already-covered media case does.
 */
import { hasStalledAutocompleteWorkPlan, hasNonRetryableWorkPlanStatusBlock } from '../controllers/agentModeController';

// Same mock scaffolding agentModeController.autoMediaContinuation.test.ts uses — required
// just to import the module (its top-level code touches these services).
jest.mock('../services/durableLandingService', () => ({
  findInFlightJobForSession: jest.fn().mockResolvedValue(null),
  markAwaitingReconnect: jest.fn().mockResolvedValue(undefined),
  claimCompletion: jest.fn().mockResolvedValue(false),
}));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
  updateTaskExecutionStatus: jest.fn(),
}));
jest.mock('../services/emailService', () => ({
  emailService: { sendOncallAlert: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn(), cancelSession: jest.fn() },
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    generateSessionTitle: jest.fn().mockResolvedValue('Test Title'),
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('System prompt'),
    generateDiagnosticMessage: jest.fn().mockResolvedValue(null),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
  },
  AgentModeService: jest.fn(),
}));
jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null,
    bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-08',
  }),
}));
jest.mock('../utils/sseProgress', () => ({
  progressStore: { delete: jest.fn() },
  emitProgress: jest.fn(),
  hasActiveProgress: jest.fn().mockReturnValue(false),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false),
  registerProgressCallback: jest.fn().mockReturnValue(() => {}),
  getLatestProgress: jest.fn().mockReturnValue(null),
  markProgressComplete: jest.fn(),
}));
jest.mock('../services/workPlanService', () => ({
  workPlanService: { getWorkPlan: jest.fn().mockResolvedValue(null) },
}));
jest.mock('../services/skillService', () => ({
  skillService: { getInstalledSkills: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue([]),
}));
jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));

describe('hasStalledAutocompleteWorkPlan (ENG-1684)', () => {
  it('reproduces the reported stall: autocomplete plan, zero tool calls this turn, a pending step', () => {
    // Exact shape of session 7a9772f6's turn 15: the model summarized what it gathered and
    // asked the user to retry, without calling any tool this turn.
    const workPlan = {
      autocomplete: true,
      steps: [{ stepCount: 1, status: 'pending' }],
    };
    expect(hasStalledAutocompleteWorkPlan(workPlan, [])).toBe(true);
    expect(hasStalledAutocompleteWorkPlan(workPlan, undefined)).toBe(true);
  });

  it('does not fire once every step is completed or skipped', () => {
    const workPlan = {
      autocomplete: true,
      steps: [{ stepCount: 1, status: 'completed' }, { stepCount: 2, status: 'skipped' }],
    };
    expect(hasStalledAutocompleteWorkPlan(workPlan, [])).toBe(false);
  });

  it('does not fire when the turn actually made tool calls, even with a pending step', () => {
    // A turn mid-research (like turns 10-14 of the reported session) is normal progress,
    // not a stall — only an EMPTY turn with unfinished work is the bug.
    const workPlan = { autocomplete: true, steps: [{ stepCount: 1, status: 'pending' }] };
    expect(hasStalledAutocompleteWorkPlan(workPlan, [{ name: 'search_web' }])).toBe(false);
  });

  it('never fires on an interactive (non-autocomplete) plan', () => {
    // Interactive plans are allowed to pause on a real question — a human can answer it.
    // Only the autocomplete contract makes an unanswered pause a bug.
    const workPlan = { autocomplete: false, steps: [{ stepCount: 1, status: 'pending' }] };
    expect(hasStalledAutocompleteWorkPlan(workPlan, [])).toBe(false);
  });

  it('is false with no work plan on the session at all', () => {
    expect(hasStalledAutocompleteWorkPlan(undefined, [])).toBe(false);
    expect(hasStalledAutocompleteWorkPlan(null, [])).toBe(false);
  });

  it('handles a work plan with no steps array without throwing', () => {
    expect(hasStalledAutocompleteWorkPlan({ autocomplete: true } as any, [])).toBe(false);
  });
});

/**
 * ENG-1700 — the ENG-1684 fix above only covered a turn with ZERO tool calls. Live-reproduced
 * 2026-09-02: the Reddit Pain Point Research Report workplan hung ~10 minutes because
 * create_html_file failed three times in a row (TruncatedToolCallArgumentsError, the separately-
 * tracked ENG-1477 gateway bug) — the backstop never fired, since tool calls WERE attempted, they
 * just all failed. A human had to type "continue" manually. Fix: a stall is now "no tool calls" OR
 * "one or more tool calls, none of which succeeded" — reusing the existing toolCallSucceeded
 * ledger check (already used elsewhere in this file) rather than a new ad-hoc failure detector.
 */
describe('hasStalledAutocompleteWorkPlan (ENG-1700 — all tool calls failed)', () => {
  it('fires when every tool call this turn failed and a step is still pending', () => {
    const workPlan = { autocomplete: true, steps: [{ stepCount: 6, status: 'pending' }] };
    const failedCalls = [
      { name: 'create_html_file', error: 'TruncatedToolCallArgumentsError: cut off mid-object' },
    ];
    expect(hasStalledAutocompleteWorkPlan(workPlan, failedCalls)).toBe(true);
  });

  it('does not fire when at least one tool call this turn succeeded, even alongside failures', () => {
    const workPlan = { autocomplete: true, steps: [{ stepCount: 6, status: 'pending' }] };
    const mixedCalls = [
      { name: 'create_html_file', error: 'TruncatedToolCallArgumentsError: cut off mid-object' },
      { name: 'read_market_strategy' }, // no error/result.success===false -> counts as succeeded
    ];
    expect(hasStalledAutocompleteWorkPlan(workPlan, mixedCalls)).toBe(false);
  });

  it('does not fire for an all-failed turn on an interactive (non-autocomplete) plan', () => {
    const workPlan = { autocomplete: false, steps: [{ stepCount: 6, status: 'pending' }] };
    const failedCalls = [{ name: 'create_html_file', error: 'TruncatedToolCallArgumentsError' }];
    expect(hasStalledAutocompleteWorkPlan(workPlan, failedCalls)).toBe(false);
  });

  it('does not fire for an all-failed turn once every step is already completed or skipped', () => {
    const workPlan = {
      autocomplete: true,
      steps: [{ stepCount: 6, status: 'completed' }],
    };
    const failedCalls = [{ name: 'create_html_file', error: 'TruncatedToolCallArgumentsError' }];
    expect(hasStalledAutocompleteWorkPlan(workPlan, failedCalls)).toBe(false);
  });

  it('fires for an all-deferred turn that is not the media-budget deferral (e.g. a duplicate call)', () => {
    // toolCallNeverExecuted (backend/src/utils/toolCallOutcome.ts) also treats a de-duplicated
    // call as "never executed" -> not succeeded. That's still a stall: nothing progressed.
    const workPlan = { autocomplete: true, steps: [{ stepCount: 6, status: 'pending' }] };
    const dedupedCalls = [{ name: 'create_html_file', duplicateOf: 'call_abc123' }];
    expect(hasStalledAutocompleteWorkPlan(workPlan, dedupedCalls)).toBe(true);
  });

  it('does NOT fire for a media-budget-deferred call — scheduleAutoMediaContinuation owns resuming that turn', () => {
    // Exact shape hasDeferredMediaBudgetToolCall (backend/src/utils/timeoutContinuation.ts)
    // recognizes: result.deferred === true AND result.reason === 'media_generation_time_budget'.
    // Without this guard, a turn shaped like this would trigger BOTH auto-continuations at once,
    // racing for the same session-generation lock.
    const workPlan = { autocomplete: true, steps: [{ stepCount: 6, status: 'pending' }] };
    const mediaDeferredCalls = [
      { name: 'generate_image', result: { deferred: true, reason: 'media_generation_time_budget' } },
    ];
    expect(hasStalledAutocompleteWorkPlan(workPlan, mediaDeferredCalls)).toBe(false);
  });
});

/**
 * ENG-1813 — found during round-4 review of PR agentweb#2808 (the ENG-1811 debt-ledger fix).
 * An autocomplete plan's modify_work_plan call that deletes the LAST pending step while
 * creating genuine ENG-1811 debt (a removed step's required function call that never actually
 * succeeded) IS a successful tool call — the pre-fix ENG-1684/1700 short-circuit
 * (`calls.some(toolCallSucceeded) -> not stalled`) would call this turn "not stalled" even
 * though no real required work got done, so no further auto-continuation round would ever fire
 * to go satisfy the debt. Fixed by checking workPlan.pendingRequiredFunctionCalls (resolved
 * against real calledFunctions) BEFORE that short-circuit — outstanding debt always wins.
 */
describe('hasStalledAutocompleteWorkPlan (ENG-1813 — unresolved debt from a removed step)', () => {
  it('fires when a modify_work_plan call succeeded this turn but left genuine ENG-1811 debt unresolved', () => {
    const workPlan = {
      autocomplete: true,
      steps: [{ stepCount: 1, status: 'completed' }],
      pendingRequiredFunctionCalls: ['list_html_templates'],
    };
    const succeededCalls = [{ name: 'modify_work_plan' }]; // no error -> counts as succeeded
    expect(hasStalledAutocompleteWorkPlan(workPlan, succeededCalls, {})).toBe(true);
    // Without the debt fix, the pre-existing short-circuit would have returned false here
    // (a tool call succeeded) -- confirm the OLD behavior really would have missed it.
    expect(hasStalledAutocompleteWorkPlan({ ...workPlan, pendingRequiredFunctionCalls: undefined }, succeededCalls, {})).toBe(false);
  });

  it('does not fire once the debt function has genuinely succeeded, even if calledFunctions is stale/unchecked elsewhere', () => {
    const workPlan = {
      autocomplete: true,
      steps: [{ stepCount: 1, status: 'completed' }],
      pendingRequiredFunctionCalls: ['list_html_templates'],
    };
    const succeededCalls = [{ name: 'modify_work_plan' }];
    expect(hasStalledAutocompleteWorkPlan(workPlan, succeededCalls, { list_html_templates: 1 })).toBe(false);
  });

  it('never fires for debt on an interactive (non-autocomplete) plan', () => {
    const workPlan = {
      autocomplete: false,
      steps: [{ stepCount: 1, status: 'completed' }],
      pendingRequiredFunctionCalls: ['list_html_templates'],
    };
    expect(hasStalledAutocompleteWorkPlan(workPlan, [{ name: 'modify_work_plan' }], {})).toBe(false);
  });

  it('media-budget deferral still wins over unresolved debt — scheduleAutoMediaContinuation owns that turn', () => {
    const workPlan = {
      autocomplete: true,
      steps: [{ stepCount: 1, status: 'completed' }],
      pendingRequiredFunctionCalls: ['list_html_templates'],
    };
    const mediaDeferredCalls = [
      { name: 'generate_image', result: { deferred: true, reason: 'media_generation_time_budget' } },
    ];
    expect(hasStalledAutocompleteWorkPlan(workPlan, mediaDeferredCalls, {})).toBe(false);
  });

  it('an empty pendingRequiredFunctionCalls array behaves exactly like no debt at all', () => {
    const workPlan = {
      autocomplete: true,
      steps: [{ stepCount: 1, status: 'completed' }],
      pendingRequiredFunctionCalls: [],
    };
    expect(hasStalledAutocompleteWorkPlan(workPlan, [{ name: 'modify_work_plan' }], {})).toBe(false);
  });
});

describe('ENG-2019 non-retryable set_work_plan_status block', () => {
  const plan = {
    autocomplete: true,
    steps: [{ status: 'completed' }, { status: 'completed' }],
    pendingRequiredFunctionCalls: ['publish_landing_page'],
  };
  const blocked = {
    name: 'set_work_plan_status',
    result: {
      success: false, blocked: true, reason: 'workplan_unresolved_removed_requirements',
      message: 'Cannot finish this work plan. A required function call from a removed step was never made.',
    },
  };

  it('session 15b230eb shape: unresolved debt + blocked status call fires zero continuation rounds', () => {
    expect(hasNonRetryableWorkPlanStatusBlock([blocked])).toBe(true);
    expect(hasStalledAutocompleteWorkPlan(plan, [blocked], {})).toBe(false);
  });

  it('parses a JSON-string tool result', () => {
    expect(hasNonRetryableWorkPlanStatusBlock([{ ...blocked, result: JSON.stringify(blocked.result) }])).toBe(true);
  });

  it('only the LAST status call counts: a later success re-enables the debt stall', () => {
    const ok = { name: 'set_work_plan_status', result: { success: true } };
    expect(hasNonRetryableWorkPlanStatusBlock([blocked, ok])).toBe(false);
    expect(hasStalledAutocompleteWorkPlan(plan, [blocked, ok], {})).toBe(true);
  });

  it('other block reasons and other tools still stall-retry', () => {
    const other = { name: 'set_work_plan_status', result: { success: false, blocked: true, reason: 'out_of_order' } };
    expect(hasNonRetryableWorkPlanStatusBlock([other])).toBe(false);
    expect(hasNonRetryableWorkPlanStatusBlock([{ ...blocked, name: 'create_html_file' }])).toBe(false);
    expect(hasStalledAutocompleteWorkPlan(plan, [other], {})).toBe(true);
  });
});
