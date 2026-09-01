/**
 * ENG-397 acceptance criteria, proven end-to-end against a mocked Meta API:
 *  1. A workflow definition executes its steps in order; each mutating step
 *     persists the created entity IDs and its verified end-state.
 *  2. Killing the session mid-workflow and re-running resumes from the last
 *     verified checkpoint — no duplicate entities created.
 *  3. A step whose required parameter is unresolved (e.g. objective) blocks
 *     before any mutation, surfacing the missing input.
 *  4. Step verification failure marks the workflow failed-at-step-N with the
 *     API discrepancy attached; subsequent steps do not run.
 *
 * Mocking follows the established pattern (see adSetReadBack.test.ts /
 * metaObjectiveGate.test.ts): metaService and chatbotService are mocked;
 * the engine itself (core/workflow.ts, workflowRunner.ts,
 * createCampaignStep.ts) runs for real.
 */

jest.mock('../services/metaService', () => {
  const actual = jest.requireActual('../services/metaService');
  return { ...actual, metaService: { createCampaign: jest.fn(), getCampaign: jest.fn() } };
});

jest.mock('../services/chatbotService', () => ({
  chatbotDb: { getChatSession: jest.fn(), updateSessionWorkflowRun: jest.fn() },
}));

import { metaService } from '../services/metaService';
import { chatbotDb } from '../services/chatbotService';
import { advanceWorkflow, startWorkflow } from '../services/agentMode/workflowRunner';
import { buildCreateCampaignStep } from '../services/agentMode/createCampaignStep';
import { buildWorkflowRunState, type WorkflowDefinition, type WorkflowStepDefinition, type WorkflowRunState } from '../services/agentMode/core/workflow';
import { buildPendingUserQuestion, applyAnswer, type PendingUserQuestion } from '../services/agentMode/core/askUserQuestion';

const mockCreateCampaign = metaService.createCampaign as jest.Mock;
const mockGetCampaign = metaService.getCampaign as jest.Mock;
const mockGetChatSession = chatbotDb.getChatSession as jest.Mock;
const mockUpdateSessionWorkflowRun = chatbotDb.updateSessionWorkflowRun as jest.Mock;

const SESSION_ID = 'session_1';

/** A trivial fixture-only second step so AC1/AC2 exercise a real multi-step
 *  sequence, not a degenerate one-step case. Not a shipped step type.
 *  Declares `campaign_id` as an input to prove the engine actually threads a
 *  prior step's checkpointed output forward — it throws if that never
 *  arrives, rather than silently ignoring it. */
function makeTagCampaignStep(): WorkflowStepDefinition {
  return {
    id: 'tag_campaign',
    inputs: ['campaign_id'],
    outputs: ['tag_id'],
    requiredParameters: [],
    execute: jest.fn(async (params: Record<string, unknown>) => {
      if (!params.campaign_id) throw new Error('tag_campaign did not receive campaign_id from the prior step');
      return { tag_id: 'tag_1' };
    }),
    verify: jest.fn(async (): Promise<import('../services/agentMode/core/workflow').WorkflowStepVerification> => ({ verified: true, verifiedFields: {} })),
  };
}

/** Ordinary (non-gated) values a real caller would already know at workflow
 *  start — proves buildWorkflowRunState's initialParameters seeding path. */
const INITIAL_PARAMS = { name: 'Test Campaign', budget_amount: 50, special_ad_categories: ['NONE'] };

function answeredQuestion(kind: string, payload: Record<string, unknown>, questionId: string): PendingUserQuestion {
  const pending = buildPendingUserQuestion({
    questionId,
    question: 'Pick one',
    kind,
    createdAt: '2026-01-01T00:00:00.000Z',
    options: [
      { id: 'opt_a', label: 'A', consequence: 'consequence', recommended: true, why: 'because', payload },
      { id: 'opt_b', label: 'B', consequence: 'consequence' },
    ],
  });
  return applyAnswer(pending, { optionId: 'opt_a', delegated: false, answeredBy: 'user', at: '2026-01-01T00:01:00.000Z' });
}

function answeredQuestionArchive(): Record<string, PendingUserQuestion> {
  const objective = answeredQuestion('workflow_meta_objective', { objective: 'OUTCOME_LEADS' }, 'q_objective');
  const budgetMode = answeredQuestion('workflow_meta_budget_mode', { budget_mode: 'campaign_budget_optimization' }, 'q_budget_mode');
  return { [objective.questionId]: objective, [budgetMode.questionId]: budgetMode };
}

function makeDefinition(): WorkflowDefinition {
  return {
    workflowId: 'launch_meta_campaign',
    steps: [buildCreateCampaignStep({ accessToken: 'token', adAccountId: 'act_1' }), makeTagCampaignStep()],
  };
}

/** In-memory session store the mocked chatbotDb reads/writes against, so
 *  `updateSessionWorkflowRun`'s writes are visible to the next `getChatSession`
 *  call within a test — mirrors the real optimistic-lock contract without a
 *  real DynamoDB. */
function wireSessionStore(initial: { workflowRun?: WorkflowRunState; answeredQuestions?: Record<string, PendingUserQuestion> }) {
  let session: any = { sessionId: SESSION_ID, ...initial };
  mockGetChatSession.mockImplementation(async () => ({ ...session }));
  mockUpdateSessionWorkflowRun.mockImplementation(async (_sessionId: string, run: WorkflowRunState | null, opts?: { failIfActiveExists?: boolean; requireVersion?: number }) => {
    if (opts?.requireVersion !== undefined && session.workflowRun?.version !== opts.requireVersion) return null;
    session = { ...session, workflowRun: run ?? undefined };
    return { ...session };
  });
  return () => session;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ENG-397 AC1 — in-order execution + persisted checkpoints', () => {
  it('executes steps in order, checkpointing entity IDs and verified state as each step completes', async () => {
    mockCreateCampaign.mockResolvedValue({ id: 'camp_1' });
    mockGetCampaign.mockResolvedValue({ id: 'camp_1', objective: 'OUTCOME_LEADS', daily_budget: 5000 });

    const definition = makeDefinition();
    const getSession = wireSessionStore({
      workflowRun: buildWorkflowRunState({ runId: 'run_1', workflowId: definition.workflowId, createdAt: '2026-01-01T00:00:00.000Z', initialParameters: INITIAL_PARAMS }),
      answeredQuestions: answeredQuestionArchive(),
    });

    const first = await advanceWorkflow(SESSION_ID, definition);
    expect(first.kind).toBe('step_verified');
    if (first.kind !== 'step_verified') throw new Error('unreachable');
    expect(first.run.checkpoints).toEqual([
      expect.objectContaining({ stepId: 'create_campaign', status: 'verified', entityIds: { campaign_id: 'camp_1' } }),
    ]);
    // Ordinary caller-supplied inputs (seeded via initialParameters) actually
    // reached the step's execute() call.
    expect(mockCreateCampaign).toHaveBeenCalledWith('act_1', 'token', expect.objectContaining({ name: 'Test Campaign' }));
    expect((definition.steps[1].execute as jest.Mock)).not.toHaveBeenCalled();

    const second = await advanceWorkflow(SESSION_ID, definition);
    expect(second.kind).toBe('completed');
    expect(getSession().workflowRun.status).toBe('completed');
    // "campaign_id feeds the next step": tag_campaign's execute() would throw
    // if it never received campaign_id (see makeTagCampaignStep) — asserting
    // it resolved successfully proves the threading actually happened.
    expect((definition.steps[1].execute as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((definition.steps[1].execute as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({ campaign_id: 'camp_1' }));

    const createOrder = mockCreateCampaign.mock.invocationCallOrder[0];
    const tagOrder = (definition.steps[1].execute as jest.Mock).mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(tagOrder);
  });
});

describe('ENG-397 AC2 — resume from last verified checkpoint, no duplicate entity', () => {
  it('does not re-create the campaign when the run already has a verified checkpoint for it', async () => {
    mockCreateCampaign.mockResolvedValue({ id: 'SHOULD_NOT_BE_CALLED' });
    const definition = makeDefinition();

    const alreadyRunning: WorkflowRunState = {
      ...buildWorkflowRunState({ runId: 'run_1', workflowId: definition.workflowId, createdAt: '2026-01-01T00:00:00.000Z', initialParameters: INITIAL_PARAMS }),
      status: 'in_progress',
      version: 2,
      checkpoints: [
        { stepId: 'create_campaign', status: 'verified', entityIds: { campaign_id: 'camp_1' }, verifiedFields: { objective: 'OUTCOME_LEADS' }, verifiedAt: '2026-01-01T00:05:00.000Z' },
      ],
    };
    wireSessionStore({ workflowRun: alreadyRunning, answeredQuestions: answeredQuestionArchive() });

    const outcome = await advanceWorkflow(SESSION_ID, definition);

    expect(mockCreateCampaign).not.toHaveBeenCalled();
    expect((definition.steps[1].execute as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('completed');
  });
});

describe('ENG-397 AC3 — blocks before mutation when a required parameter is unresolved', () => {
  it('blocks on the missing objective and never calls createCampaign', async () => {
    const definition = makeDefinition();
    wireSessionStore({ workflowRun: buildWorkflowRunState({ runId: 'run_1', workflowId: definition.workflowId, createdAt: '2026-01-01T00:00:00.000Z', initialParameters: INITIAL_PARAMS }) });

    const outcome = await advanceWorkflow(SESSION_ID, definition);

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') {
      expect(outcome.run.blockedOn?.missingParameter).toBe('objective');
      expect(outcome.run.blockedOn?.questionKind).toBe('workflow_meta_objective');
    }
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });
});

describe('ENG-397 AC4 — verification failure halts the run', () => {
  it('marks the run failed-at-step-1 with the discrepancy attached, and never runs the next step or retries', async () => {
    mockCreateCampaign.mockResolvedValue({ id: 'camp_1' });
    mockGetCampaign.mockResolvedValue({ id: 'camp_1', objective: 'OUTCOME_TRAFFIC', daily_budget: 5000 }); // objective drift from requested OUTCOME_LEADS; budget matches so only objective mismatches

    const definition = makeDefinition();
    wireSessionStore({ workflowRun: buildWorkflowRunState({ runId: 'run_1', workflowId: definition.workflowId, createdAt: '2026-01-01T00:00:00.000Z', initialParameters: INITIAL_PARAMS }), answeredQuestions: answeredQuestionArchive() });

    const first = await advanceWorkflow(SESSION_ID, definition);
    expect(first.kind).toBe('step_failed');
    if (first.kind !== 'step_failed') throw new Error('unreachable');
    expect(first.run.status).toBe('failed');
    expect(first.run.failedStepId).toBe('create_campaign');
    expect(first.run.checkpoints[0].discrepancy).toEqual([
      { parameter: 'objective', requested: 'OUTCOME_LEADS', applied: 'OUTCOME_TRAFFIC' },
    ]);
    expect((definition.steps[1].execute as jest.Mock)).not.toHaveBeenCalled();

    const second = await advanceWorkflow(SESSION_ID, definition);
    expect(second.kind).toBe('step_failed');
    expect(mockCreateCampaign).toHaveBeenCalledTimes(1);
    expect((definition.steps[1].execute as jest.Mock)).not.toHaveBeenCalled();
  });
});

describe('ENG-397 hardening — a missing declared output fails the step instead of checkpointing "undefined"', () => {
  it('fails the step when execute() omits a declared output, rather than writing the literal string "undefined" as an entity id', async () => {
    const brokenStep: WorkflowStepDefinition = {
      id: 'broken_step',
      inputs: [],
      outputs: ['thing_id'],
      requiredParameters: [],
      execute: jest.fn(async () => ({})), // forgets to return `thing_id`
      verify: jest.fn(async (): Promise<import('../services/agentMode/core/workflow').WorkflowStepVerification> => ({ verified: true, verifiedFields: {} })),
    };
    const definition: WorkflowDefinition = { workflowId: 'broken_workflow', steps: [brokenStep] };
    wireSessionStore({ workflowRun: buildWorkflowRunState({ runId: 'run_1', workflowId: definition.workflowId, createdAt: '2026-01-01T00:00:00.000Z' }) });

    const outcome = await advanceWorkflow(SESSION_ID, definition);

    expect(outcome.kind).toBe('step_failed');
    if (outcome.kind !== 'step_failed') throw new Error('unreachable');
    expect(outcome.run.status).toBe('failed');
    expect(outcome.run.checkpoints[0].discrepancy).toEqual({ error: expect.stringContaining('thing_id') });
    expect(outcome.run.checkpoints[0].entityIds).toBeUndefined();
    // verify() never even runs — a missing output is a contract violation,
    // not something worth reading back and comparing.
    expect(brokenStep.verify as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('ENG-397 hardening — budget_mode is verified, not just gated', () => {
  it('fails verification when campaign_budget_optimization was requested but Meta applied no daily_budget', async () => {
    mockCreateCampaign.mockResolvedValue({ id: 'camp_1' });
    mockGetCampaign.mockResolvedValue({ id: 'camp_1', objective: 'OUTCOME_LEADS' }); // no daily_budget in the read-back

    const definition = makeDefinition();
    wireSessionStore({
      workflowRun: buildWorkflowRunState({ runId: 'run_1', workflowId: definition.workflowId, createdAt: '2026-01-01T00:00:00.000Z', initialParameters: INITIAL_PARAMS }),
      answeredQuestions: answeredQuestionArchive(),
    });

    const outcome = await advanceWorkflow(SESSION_ID, definition);

    expect(outcome.kind).toBe('step_failed');
    if (outcome.kind !== 'step_failed') throw new Error('unreachable');
    expect(outcome.run.checkpoints[0].discrepancy).toEqual([
      { parameter: 'budget_mode', requested: 'campaign_budget_optimization', applied: null },
    ]);
  });
});

describe('ENG-397 hardening — initialParameters cannot bypass the AskUserQuestion gate', () => {
  it('startWorkflow rejects initialParameters that supply a gated key directly, before any persistence write', async () => {
    wireSessionStore({});
    const definition = makeDefinition();

    // Without this rejection, resolveStepParameters would see `objective`
    // already present in resolvedParameters and skip checkQuestionGate
    // entirely — the caller could inject the immutable objective value
    // without any human ever answering the question.
    await expect(
      startWorkflow(SESSION_ID, definition, { objective: 'OUTCOME_LEADS', name: 'Test Campaign' }),
    ).rejects.toThrow(/gated parameter/i);

    expect(mockUpdateSessionWorkflowRun).not.toHaveBeenCalled();
  });

  it('startWorkflow accepts initialParameters that only supply ordinary (non-gated) values', async () => {
    wireSessionStore({});
    const definition = makeDefinition();

    const run = await startWorkflow(SESSION_ID, definition, INITIAL_PARAMS);

    expect(run.resolvedParameters).toEqual(INITIAL_PARAMS);
    expect(run.status).toBe('in_progress');
  });
});

describe('ENG-397 hardening — startWorkflow refuses to operate on a nonexistent session', () => {
  it('rejects a sessionId with no existing session, before writing anything', async () => {
    // DynamoDB's conditional UpdateItem creates the item if it's missing —
    // attribute_not_exists(workflowRun) is satisfied just as readily by "the
    // whole session row doesn't exist" as by "it exists with no active run."
    // Without an explicit existence check, a bad/stale sessionId would
    // silently create a near-empty ChatSession row instead of failing loud.
    mockGetChatSession.mockResolvedValue(null);
    const definition = makeDefinition();

    await expect(startWorkflow('session_does_not_exist', definition, INITIAL_PARAMS)).rejects.toThrow(
      /no session found/i,
    );

    expect(mockUpdateSessionWorkflowRun).not.toHaveBeenCalled();
  });
});

describe('ENG-397 hardening — a throwing verify() fails the step instead of leaving it unresolved', () => {
  it('catches a verify() exception and fails the step, rather than leaving the run in_progress and letting a retry re-execute (duplicate creation)', async () => {
    const throwingStep: WorkflowStepDefinition = {
      id: 'throwing_step',
      inputs: [],
      outputs: ['thing_id'],
      requiredParameters: [],
      execute: jest.fn(async () => ({ thing_id: 'x1' })),
      verify: jest.fn(async () => {
        throw new Error('read-back network timeout');
      }),
    };
    const definition: WorkflowDefinition = { workflowId: 'throwing_workflow', steps: [throwingStep] };
    wireSessionStore({ workflowRun: buildWorkflowRunState({ runId: 'run_1', workflowId: definition.workflowId, createdAt: '2026-01-01T00:00:00.000Z' }) });

    const first = await advanceWorkflow(SESSION_ID, definition);
    expect(first.kind).toBe('step_failed');
    if (first.kind !== 'step_failed') throw new Error('unreachable');
    expect(first.run.status).toBe('failed');
    expect(first.run.checkpoints[0].discrepancy).toEqual({ error: 'read-back network timeout' });

    // A retry must NOT re-execute (which would create a second real entity) —
    // findNextStep returns null once the run is 'failed'.
    const second = await advanceWorkflow(SESSION_ID, definition);
    expect(second.kind).toBe('step_failed');
    expect(throwingStep.execute as jest.Mock).toHaveBeenCalledTimes(1);
  });
});

describe('ENG-397 hardening — an optimistic-lock conflict is surfaced, not silently trusted', () => {
  it('returns a conflict outcome (not the transition result) when the persistence write loses the version race', async () => {
    mockCreateCampaign.mockResolvedValue({ id: 'camp_1' });
    mockGetCampaign.mockResolvedValue({ id: 'camp_1', objective: 'OUTCOME_LEADS', daily_budget: 5000 });

    const definition = makeDefinition();
    const preTransitionRun = buildWorkflowRunState({
      runId: 'run_1',
      workflowId: definition.workflowId,
      createdAt: '2026-01-01T00:00:00.000Z',
      initialParameters: INITIAL_PARAMS,
    });
    mockGetChatSession.mockResolvedValue({ sessionId: SESSION_ID, workflowRun: preTransitionRun, answeredQuestions: answeredQuestionArchive() });
    // Simulate a concurrent writer already having moved the version — every
    // guarded write in this codebase's convention returns null on a lost race.
    mockUpdateSessionWorkflowRun.mockResolvedValue(null);

    const outcome = await advanceWorkflow(SESSION_ID, definition);

    expect(outcome.kind).toBe('conflict');
    if (outcome.kind !== 'conflict') throw new Error('unreachable');
    // Must be the PRE-transition object, never the (unpersisted) local one a
    // caller might mistake for having actually landed.
    expect(outcome.run).toBe(preTransitionRun);
  });
});
