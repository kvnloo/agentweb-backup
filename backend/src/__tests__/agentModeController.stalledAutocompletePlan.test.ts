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
import { hasStalledAutocompleteWorkPlan } from '../controllers/agentModeController';

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
