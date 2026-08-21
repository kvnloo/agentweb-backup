import {
  decideWorkPlanTurnDisposition,
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
