import {
  decideWorkPlanTurnDisposition,
  priorTurnNeedsWorkPlanDispositionRetry,
  snapshotWorkPlanTurn,
} from '../workPlanTurnDisposition';

const pendingPlan = {
  title: 'Launch campaign',
  steps: [
    { stepCount: 1, title: 'Direction', status: 'completed' },
    { stepCount: 2, title: 'Objective', status: 'pending' },
  ],
};

describe('workplan turn disposition', () => {
  it('reports needs_input only from persisted structured state', () => {
    const before = snapshotWorkPlanTurn({ workPlan: pendingPlan });
    const after = snapshotWorkPlanTurn({
      workPlan: pendingPlan,
      pendingUserQuestion: { questionId: 'q-1', status: 'awaiting' },
    });

    expect(decideWorkPlanTurnDisposition({ before, after })).toEqual({
      kind: 'needs_input',
      actionId: 'question:q-1',
    });
  });

  it('reports step_complete when the original pending step advances', () => {
    const before = snapshotWorkPlanTurn({ workPlan: pendingPlan });
    const after = snapshotWorkPlanTurn({
      workPlan: {
        ...pendingPlan,
        steps: pendingPlan.steps.map((step) => (
          step.stepCount === 2 ? { ...step, status: 'completed' } : step
        )),
      },
    });

    expect(decideWorkPlanTurnDisposition({ before, after })).toEqual({
      kind: 'step_complete',
      stepCount: 2,
    });
  });

  it('rejects prose-only termination while the same step is pending', () => {
    const snapshot = snapshotWorkPlanTurn({ workPlan: pendingPlan });
    expect(decideWorkPlanTurnDisposition({ before: snapshot, after: snapshot })).toEqual({
      kind: 'invalid',
      code: 'WORKPLAN_TURN_MISSING_DISPOSITION',
      retryable: true,
    });
  });

  it('distinguishes an active continuation and a failed turn', () => {
    const snapshot = snapshotWorkPlanTurn({ workPlan: pendingPlan });
    expect(decideWorkPlanTurnDisposition({ before: snapshot, after: snapshot, stillRunning: true })).toEqual({
      kind: 'continuing',
    });
    expect(decideWorkPlanTurnDisposition({ before: snapshot, after: snapshot, failed: true })).toEqual({
      kind: 'failed',
      retryable: true,
    });
  });

  it('is not applicable to ordinary chats without a workplan', () => {
    const snapshot = snapshotWorkPlanTurn({});
    expect(decideWorkPlanTurnDisposition({ before: snapshot, after: snapshot })).toEqual({ kind: 'not_applicable' });
  });

  it('is not applicable when the workplan was already complete before the turn', () => {
    const snapshot = snapshotWorkPlanTurn({
      workPlan: { steps: [{ stepCount: 1, title: 'Done', status: 'completed' }] },
    });
    expect(decideWorkPlanTurnDisposition({ before: snapshot, after: snapshot })).toEqual({ kind: 'not_applicable' });
  });

  it('ignores malformed persisted array elements instead of trusting the outer array', () => {
    expect(snapshotWorkPlanTurn({
      workPlan: { steps: [null, 'bad', { status: 'pending', stepCount: '2' }, { status: 'pending', stepCount: 3 }] },
    })).toEqual({ hasWorkPlan: true, pendingStepCount: 3 });
  });

  it('ignores wrong-type pending action records', () => {
    expect(snapshotWorkPlanTurn({
      workPlan: pendingPlan,
      pendingWorkPlanInput: { requestId: 42, status: 'awaiting' },
      pendingUserQuestion: { questionId: ['q-1'], status: 'awaiting' },
    })).toEqual({ hasWorkPlan: true, pendingStepCount: 2 });
  });
});

// ENG-1626: a decision-card creation that fails twice (the in-turn retry above
// already exhausted) leaves the customer with a canned "please retry" message
// and no automatic way forward. The controller uses this predicate to
// re-enforce the disposition check on the customer's NEXT turn, no matter what
// they type, instead of requiring the literal phrase "retry creating the card".
describe('priorTurnNeedsWorkPlanDispositionRetry', () => {
  it('is true for an assistant message flagged retryable after disposition recovery failed', () => {
    expect(priorTurnNeedsWorkPlanDispositionRetry({
      role: 'assistant',
      content: 'I couldn’t create the decision card needed to continue this step. Please retry.',
      metadata: { workPlanDispositionFailure: { code: 'WORKPLAN_TURN_MISSING_DISPOSITION', retryable: true } },
    })).toBe(true);
  });

  it('is false for a normal assistant message with no disposition failure', () => {
    expect(priorTurnNeedsWorkPlanDispositionRetry({
      role: 'assistant',
      content: 'Step 3 is complete.',
      metadata: { timestamp: '2026-08-27T17:18:00.000Z' },
    })).toBe(false);
  });

  it('is false for a user message even if it happens to carry the same metadata shape', () => {
    expect(priorTurnNeedsWorkPlanDispositionRetry({
      role: 'user',
      content: 'retry',
      metadata: { workPlanDispositionFailure: { code: 'WORKPLAN_TURN_MISSING_DISPOSITION', retryable: true } },
    })).toBe(false);
  });

  it('is false when retryable is explicitly false', () => {
    expect(priorTurnNeedsWorkPlanDispositionRetry({
      role: 'assistant',
      metadata: { workPlanDispositionFailure: { code: 'WORKPLAN_TURN_MISSING_DISPOSITION', retryable: false } },
    })).toBe(false);
  });

  it('is false for undefined/null/malformed input', () => {
    expect(priorTurnNeedsWorkPlanDispositionRetry(undefined)).toBe(false);
    expect(priorTurnNeedsWorkPlanDispositionRetry(null)).toBe(false);
    expect(priorTurnNeedsWorkPlanDispositionRetry('not an object')).toBe(false);
    expect(priorTurnNeedsWorkPlanDispositionRetry({ role: 'assistant' })).toBe(false);
  });
});
