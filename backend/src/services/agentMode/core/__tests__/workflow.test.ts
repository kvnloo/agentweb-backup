/**
 * Tests for the Workflow engine core (ENG-397). Pure, no mocks — exercises
 * the engine's decision logic directly, reusing the real ENG-396
 * AskUserQuestion primitives (buildPendingUserQuestion/applyAnswer) to
 * construct parameter-gate fixtures rather than faking their shape.
 *
 * Contract under test (see workflow.ts):
 *  - findNextStep skips 'verified' steps (the resumability primitive, AC2)
 *    and returns null on a terminal ('completed'/'failed') run;
 *  - resolveStepParameters only allows a step to proceed once every required
 *    parameter has a human-answered AskUserQuestion behind it (AC3), checking
 *    the live slot AND the archive;
 *  - recordStepSuccess marks the run 'completed' only once every step is
 *    verified, else 'in_progress';
 *  - recordStepFailure marks the run 'failed' with the discrepancy attached
 *    verbatim, and findNextStep on a 'failed' run always returns null (AC4);
 *  - every transition bumps `version` by exactly 1.
 */

import {
  buildWorkflowRunState,
  findNextStep,
  resolveStepParameters,
  recordStepSuccess,
  recordStepFailure,
  markBlockedOnParameter,
  describeFailedAtStep,
  collectEntityIdsFromCheckpoints,
  findGatedParameterKeys,
  type WorkflowDefinition,
  type WorkflowStepDefinition,
  type WorkflowRunState,
} from '../workflow';
import { buildPendingUserQuestion, applyAnswer, type PendingUserQuestion } from '../askUserQuestion';

function makeStep(overrides: Partial<WorkflowStepDefinition> = {}): WorkflowStepDefinition {
  return {
    id: 'step_a',
    inputs: [],
    outputs: ['entity_id'],
    requiredParameters: [],
    execute: jest.fn(async () => ({ entity_id: 'x' })),
    verify: jest.fn(async (): Promise<import('../workflow').WorkflowStepVerification> => ({ verified: true, verifiedFields: {} })),
    ...overrides,
  };
}

function makeDefinition(steps: WorkflowStepDefinition[]): WorkflowDefinition {
  return { workflowId: 'test_workflow', steps };
}

function makeRun(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return { ...buildWorkflowRunState({ runId: 'run_1', workflowId: 'test_workflow', createdAt: '2026-01-01T00:00:00.000Z' }), ...overrides };
}

function answeredQuestion(kind: string, payload: Record<string, unknown>): PendingUserQuestion {
  const pending = buildPendingUserQuestion({
    questionId: `q_${kind}`,
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

describe('findNextStep', () => {
  it('returns the first step in order when nothing is checkpointed', () => {
    const stepA = makeStep({ id: 'a' });
    const stepB = makeStep({ id: 'b' });
    const definition = makeDefinition([stepA, stepB]);
    expect(findNextStep(definition, makeRun())?.id).toBe('a');
  });

  it('skips a step already checkpointed verified', () => {
    const stepA = makeStep({ id: 'a' });
    const stepB = makeStep({ id: 'b' });
    const definition = makeDefinition([stepA, stepB]);
    const run = makeRun({ checkpoints: [{ stepId: 'a', status: 'verified' }] });
    expect(findNextStep(definition, run)?.id).toBe('b');
  });

  it('returns null once every step is verified', () => {
    const stepA = makeStep({ id: 'a' });
    const definition = makeDefinition([stepA]);
    const run = makeRun({ status: 'completed', checkpoints: [{ stepId: 'a', status: 'verified' }] });
    expect(findNextStep(definition, run)).toBeNull();
  });

  it('returns null on a failed run, even if a later step has no checkpoint (AC4)', () => {
    const stepA = makeStep({ id: 'a' });
    const stepB = makeStep({ id: 'b' });
    const definition = makeDefinition([stepA, stepB]);
    const run = makeRun({ status: 'failed', failedStepId: 'a', checkpoints: [{ stepId: 'a', status: 'failed' }] });
    expect(findNextStep(definition, run)).toBeNull();
  });

  it('does not treat a failed checkpoint as verified — a step whose only checkpoint is failed is returned again while the run is still in_progress', () => {
    const stepA = makeStep({ id: 'a' });
    const definition = makeDefinition([stepA]);
    const run = makeRun({ status: 'in_progress', checkpoints: [{ stepId: 'a', status: 'failed' }] });
    expect(findNextStep(definition, run)?.id).toBe('a');
  });
});

describe('resolveStepParameters', () => {
  it('resolves from the live pendingUserQuestion slot when answered', () => {
    const step = makeStep({
      requiredParameters: [{ key: 'objective', questionKind: 'workflow_meta_objective', payloadField: 'objective' }],
    });
    const pending = answeredQuestion('workflow_meta_objective', { objective: 'OUTCOME_LEADS' });
    const result = resolveStepParameters(step, makeRun(), pending, undefined);
    expect(result).toEqual({ blocked: false, resolvedParameters: { objective: 'OUTCOME_LEADS' } });
  });

  it('resolves from the archive when the live slot has moved on to a different question', () => {
    const step = makeStep({
      requiredParameters: [{ key: 'objective', questionKind: 'workflow_meta_objective', payloadField: 'objective' }],
    });
    const archived = answeredQuestion('workflow_meta_objective', { objective: 'OUTCOME_LEADS' });
    const laterPending = buildPendingUserQuestion({
      questionId: 'q_other',
      question: 'Something else',
      kind: 'workflow_meta_budget_mode',
      createdAt: '2026-01-01T00:02:00.000Z',
      options: [
        { id: 'x', label: 'X', consequence: 'c', recommended: true, why: 'w' },
        { id: 'y', label: 'Y', consequence: 'c' },
      ],
    });
    const result = resolveStepParameters(step, makeRun(), laterPending, { [archived.questionId]: archived });
    expect(result).toEqual({ blocked: false, resolvedParameters: { objective: 'OUTCOME_LEADS' } });
  });

  it('blocks before mutation when no question of the required kind has been asked (AC3)', () => {
    const step = makeStep({
      requiredParameters: [{ key: 'objective', questionKind: 'workflow_meta_objective', payloadField: 'objective' }],
    });
    const result = resolveStepParameters(step, makeRun(), undefined, undefined);
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.block.missingParameter).toBe('objective');
      expect(result.block.questionKind).toBe('workflow_meta_objective');
    }
  });

  it('does not let an unrelated ANSWERED question (a different kind) satisfy the gate, even when its payload happens to carry a same-named field', () => {
    const step = makeStep({
      requiredParameters: [{ key: 'objective', questionKind: 'workflow_meta_objective', payloadField: 'objective' }],
    });
    // Answered, but of a DIFFERENT kind — and its payload coincidentally has
    // an `objective` field too. Before the fix, findQuestionByKind would
    // return undefined (no match for 'workflow_meta_objective'), and
    // checkQuestionGate(pending, undefined, archive) would fall through to
    // accepting whatever question IS live regardless of kind — silently
    // resolving `objective` from the wrong decision entirely.
    const unrelatedAnswered = answeredQuestion('some_other_kind', { objective: 'WRONG_VALUE_FROM_UNRELATED_QUESTION' });
    const result = resolveStepParameters(step, makeRun(), unrelatedAnswered, undefined);
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.block.missingParameter).toBe('objective');
      expect(result.block.questionKind).toBe('workflow_meta_objective');
    }
  });

  it('blocks while the matching question is still awaiting an answer', () => {
    const step = makeStep({
      requiredParameters: [{ key: 'objective', questionKind: 'workflow_meta_objective', payloadField: 'objective' }],
    });
    const awaiting = buildPendingUserQuestion({
      questionId: 'q_1',
      question: 'Pick one',
      kind: 'workflow_meta_objective',
      createdAt: '2026-01-01T00:00:00.000Z',
      options: [
        { id: 'opt_a', label: 'A', consequence: 'c', recommended: true, why: 'w', payload: { objective: 'OUTCOME_LEADS' } },
        { id: 'opt_b', label: 'B', consequence: 'c' },
      ],
    });
    const result = resolveStepParameters(step, makeRun(), awaiting, undefined);
    expect(result.blocked).toBe(true);
  });

  it('blocks when the answered option carried no payload for the required field', () => {
    const step = makeStep({
      requiredParameters: [{ key: 'objective', questionKind: 'workflow_meta_objective', payloadField: 'objective' }],
    });
    const pending = answeredQuestion('workflow_meta_objective', { some_other_field: 'x' });
    const result = resolveStepParameters(step, makeRun(), pending, undefined);
    expect(result.blocked).toBe(true);
  });

  it('skips a requirement already present in run.resolvedParameters from a prior step', () => {
    const step = makeStep({
      requiredParameters: [{ key: 'objective', questionKind: 'workflow_meta_objective', payloadField: 'objective' }],
    });
    const run = makeRun({ resolvedParameters: { objective: 'OUTCOME_LEADS' } });
    const result = resolveStepParameters(step, run, undefined, undefined);
    expect(result).toEqual({ blocked: false, resolvedParameters: { objective: 'OUTCOME_LEADS' } });
  });
});

describe('recordStepSuccess / recordStepFailure', () => {
  it('marks the run in_progress after a non-final step succeeds, and bumps version by 1', () => {
    const stepA = makeStep({ id: 'a' });
    const stepB = makeStep({ id: 'b' });
    const definition = makeDefinition([stepA, stepB]);
    const run = makeRun();
    const next = recordStepSuccess(definition, run, stepA, {}, { entity_id: 'e1' }, { field: 'v' }, '2026-01-01T00:05:00.000Z');
    expect(next.status).toBe('in_progress');
    expect(next.version).toBe(run.version + 1);
    expect(next.checkpoints).toEqual([
      { stepId: 'a', status: 'verified', entityIds: { entity_id: 'e1' }, verifiedFields: { field: 'v' }, verifiedAt: '2026-01-01T00:05:00.000Z' },
    ]);
  });

  it('marks the run completed only once the LAST step is verified', () => {
    const stepA = makeStep({ id: 'a' });
    const stepB = makeStep({ id: 'b' });
    const definition = makeDefinition([stepA, stepB]);
    const afterA = recordStepSuccess(definition, makeRun(), stepA, {}, { entity_id: 'e1' }, {}, '2026-01-01T00:05:00.000Z');
    expect(afterA.status).toBe('in_progress');
    const afterB = recordStepSuccess(definition, afterA, stepB, {}, { entity_id: 'e2' }, {}, '2026-01-01T00:06:00.000Z');
    expect(afterB.status).toBe('completed');
  });

  it('records a failure with the discrepancy attached verbatim and sets failedStepId', () => {
    const stepA = makeStep({ id: 'a' });
    const definition = makeDefinition([stepA]);
    const run = makeRun();
    const discrepancy = [{ parameter: 'objective', requested: 'OUTCOME_LEADS', applied: 'OUTCOME_TRAFFIC' }];
    const next = recordStepFailure(run, stepA, discrepancy, '2026-01-01T00:05:00.000Z');
    expect(next.status).toBe('failed');
    expect(next.failedStepId).toBe('a');
    expect(next.version).toBe(run.version + 1);
    expect(next.checkpoints).toEqual([
      { stepId: 'a', status: 'failed', discrepancy, failedAt: '2026-01-01T00:05:00.000Z' },
    ]);
    expect(findNextStep(definition, next)).toBeNull();
  });

  it('markBlockedOnParameter sets status and bumps version', () => {
    const run = makeRun();
    const block = { stepId: 'a', missingParameter: 'objective', questionKind: 'workflow_meta_objective', reason: 'not answered' };
    const next = markBlockedOnParameter(run, block, '2026-01-01T00:05:00.000Z');
    expect(next.status).toBe('blocked_on_parameter');
    expect(next.blockedOn).toEqual(block);
    expect(next.version).toBe(run.version + 1);
  });
});

describe('buildWorkflowRunState initialParameters', () => {
  it('seeds resolvedParameters with caller-supplied ordinary values', () => {
    const run = buildWorkflowRunState({
      runId: 'run_1',
      workflowId: 'wf',
      createdAt: '2026-01-01T00:00:00.000Z',
      initialParameters: { name: 'Test Campaign', budget_amount: 50 },
    });
    expect(run.resolvedParameters).toEqual({ name: 'Test Campaign', budget_amount: 50 });
  });

  it('defaults resolvedParameters to empty when no initialParameters are given', () => {
    const run = buildWorkflowRunState({ runId: 'run_1', workflowId: 'wf', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(run.resolvedParameters).toEqual({});
  });
});

describe('collectEntityIdsFromCheckpoints — the "output feeds the next step" mechanism', () => {
  it('returns an empty bag when there are no checkpoints', () => {
    expect(collectEntityIdsFromCheckpoints(makeRun())).toEqual({});
  });

  it('collects entityIds only from VERIFIED checkpoints, ignoring failed ones', () => {
    const run = makeRun({
      checkpoints: [
        { stepId: 'a', status: 'verified', entityIds: { campaign_id: 'camp_1' } },
        { stepId: 'b', status: 'failed', discrepancy: { error: 'boom' } },
      ],
    });
    expect(collectEntityIdsFromCheckpoints(run)).toEqual({ campaign_id: 'camp_1' });
  });

  it('merges entityIds across multiple verified checkpoints', () => {
    const run = makeRun({
      checkpoints: [
        { stepId: 'a', status: 'verified', entityIds: { campaign_id: 'camp_1' } },
        { stepId: 'b', status: 'verified', entityIds: { ad_set_id: 'adset_1' } },
      ],
    });
    expect(collectEntityIdsFromCheckpoints(run)).toEqual({ campaign_id: 'camp_1', ad_set_id: 'adset_1' });
  });
});

describe('findGatedParameterKeys', () => {
  it('collects every requiredParameters key across every step', () => {
    const stepA = makeStep({
      id: 'a',
      requiredParameters: [{ key: 'objective', questionKind: 'workflow_meta_objective', payloadField: 'objective' }],
    });
    const stepB = makeStep({
      id: 'b',
      requiredParameters: [{ key: 'budget_mode', questionKind: 'workflow_meta_budget_mode', payloadField: 'budget_mode' }],
    });
    expect(findGatedParameterKeys(makeDefinition([stepA, stepB]))).toEqual(new Set(['objective', 'budget_mode']));
  });

  it('returns an empty set when no step gates anything', () => {
    expect(findGatedParameterKeys(makeDefinition([makeStep()]))).toEqual(new Set());
  });
});

describe('describeFailedAtStep', () => {
  it('returns null when the run has not failed', () => {
    expect(describeFailedAtStep(makeDefinition([makeStep()]), makeRun())).toBeNull();
  });

  it('renders the 1-based position and stable step id', () => {
    const stepA = makeStep({ id: 'a' });
    const stepB = makeStep({ id: 'b' });
    const definition = makeDefinition([stepA, stepB]);
    const run = makeRun({ status: 'failed', failedStepId: 'b' });
    expect(describeFailedAtStep(definition, run)).toBe('failed-at-step-2 (b)');
  });
});
