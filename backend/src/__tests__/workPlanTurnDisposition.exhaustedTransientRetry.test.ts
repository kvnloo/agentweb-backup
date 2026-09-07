import {
  decideWorkPlanTurnDisposition,
  findWorkPlanStepByCount,
  hadExhaustedTransientStepFailure,
} from '../services/agentMode/core/workPlanTurnDisposition';

// ENG-828: reproduced live against the real preview backend — a work-plan step
// whose required tool (coding_agent) was retried once per the "Retrying a
// Transient Failure" carve-out and failed BOTH times left the step correctly
// `pending`, but decideWorkPlanTurnDisposition classified the turn as
// `invalid` (WORKPLAN_TURN_MISSING_DISPOSITION) because pendingStepCount didn't
// change and there was no awaitingAction — indistinguishable from a genuinely
// malformed turn. That overwrote the model's own honest explanation with the
// generic "I couldn't create the decision card... Please retry" fallback.
describe('hadExhaustedTransientStepFailure', () => {
  it('is true when the pending step tool failed twice with a retryable coding_agent timeout', () => {
    const toolCalls = [
      { name: 'coding_agent', error: 'Coding agent timed out after 20 minutes.', result: { retryable: true } },
      { name: 'coding_agent', error: 'Coding agent timed out after 20 minutes.', result: { retryable: true } },
    ];
    expect(hadExhaustedTransientStepFailure(toolCalls, ['coding_agent'])).toBe(true);
  });

  it('is true for a transient error message on the second attempt even without an explicit retryable flag (v0 timeout shape)', () => {
    const toolCalls = [
      { name: 'generate_landing_page', error: 'v0 chat creation timed out after 300s' },
      { name: 'generate_landing_page', error: 'v0 chat creation timed out after 300s' },
    ];
    expect(hadExhaustedTransientStepFailure(toolCalls, ['generate_landing_page'])).toBe(true);
  });

  it('is false for a single failed attempt — the carve-out allows exactly one retry, so one failure is not "exhausted"', () => {
    // Reviewer-caught: a lone failure must not count, or a model that failed to
    // retry at all (a genuine prompt-compliance regression) would be silently
    // reclassified as a valid outcome instead of `invalid`, which is what nudges
    // the model to actually retry.
    const toolCalls = [
      { name: 'coding_agent', error: 'Coding agent timed out after 20 minutes.', result: { retryable: true } },
    ];
    expect(hadExhaustedTransientStepFailure(toolCalls, ['coding_agent'])).toBe(false);
  });

  it('is true when the error is a structured object (message/code) rather than a plain string', () => {
    // Reviewer-caught: the generic minimizer can leave a gateway error as {}
    // or as a structured object; the retryable check must not be skipped just
    // because `.error` isn't already a string.
    const toolCalls = [
      { name: 'coding_agent', error: { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' } },
      { name: 'coding_agent', error: { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' } },
    ];
    expect(hadExhaustedTransientStepFailure(toolCalls, ['coding_agent'])).toBe(true);
  });

  it('is true on the second attempt via retryable alone, even with no error text at all', () => {
    const toolCalls = [
      { name: 'coding_agent', error: 'Coding agent timed out after 20 minutes.', result: { retryable: true } },
      { name: 'coding_agent', result: { retryable: true } },
    ];
    expect(hadExhaustedTransientStepFailure(toolCalls, ['coding_agent'])).toBe(true);
  });

  it('is false when the last call for the step tool succeeded (retry recovered)', () => {
    const toolCalls = [
      { name: 'coding_agent', error: 'Coding agent timed out after 20 minutes.', result: { retryable: true } },
      { name: 'coding_agent', result: { success: true, state: 'succeeded' } },
    ];
    expect(hadExhaustedTransientStepFailure(toolCalls, ['coding_agent'])).toBe(false);
  });

  it('is false for a non-transient, non-retryable failure (a real bug, not an infra hiccup)', () => {
    const toolCalls = [
      { name: 'coding_agent', error: 'Invalid page_id: page not found', result: { retryable: false } },
      { name: 'coding_agent', error: 'Invalid page_id: page not found', result: { retryable: false } },
    ];
    expect(hadExhaustedTransientStepFailure(toolCalls, ['coding_agent'])).toBe(false);
  });

  it('is false when no call was made for the step\'s required tool', () => {
    const toolCalls = [{ name: 'playwright_browser_navigate', result: { success: true } }];
    expect(hadExhaustedTransientStepFailure(toolCalls, ['coding_agent'])).toBe(false);
  });

  it('handles missing/malformed inputs without throwing', () => {
    expect(hadExhaustedTransientStepFailure(undefined, ['coding_agent'])).toBe(false);
    expect(hadExhaustedTransientStepFailure([], undefined)).toBe(false);
    expect(hadExhaustedTransientStepFailure([{ name: 'coding_agent', error: 'timed out' }], 'not-an-array' as any)).toBe(false);
  });
});

describe('findWorkPlanStepByCount', () => {
  it('returns the matching step by stepCount', () => {
    const session = { workPlan: { steps: [{ stepCount: 1, status: 'completed' }, { stepCount: 6, status: 'pending' }] } };
    expect(findWorkPlanStepByCount(session, 6)).toEqual({ stepCount: 6, status: 'pending' });
  });

  it('returns undefined for a missing stepCount, no workPlan, or no match', () => {
    expect(findWorkPlanStepByCount({ workPlan: { steps: [{ stepCount: 1 }] } }, undefined)).toBeUndefined();
    expect(findWorkPlanStepByCount({}, 6)).toBeUndefined();
    expect(findWorkPlanStepByCount({ workPlan: { steps: [{ stepCount: 1 }] } }, 6)).toBeUndefined();
  });
});

describe('decideWorkPlanTurnDisposition — exhausted transient retry reclassification', () => {
  it('classifies as `failed` (not `invalid`) when the pending step tool exhausted its one retry on a transient error', () => {
    const before = { hasWorkPlan: true, pendingStepCount: 6 };
    const after = { hasWorkPlan: true, pendingStepCount: 6 }; // unchanged — step correctly stayed pending
    const toolCalls = [
      { name: 'coding_agent', error: 'Coding agent timed out after 20 minutes.', result: { retryable: true } },
      { name: 'coding_agent', error: 'Coding agent timed out after 20 minutes.', result: { retryable: true } },
    ];
    const disposition = decideWorkPlanTurnDisposition({
      before,
      after,
      failed: hadExhaustedTransientStepFailure(toolCalls, ['coding_agent']),
    });
    expect(disposition).toEqual({ kind: 'failed', retryable: true });
  });

  it('still classifies as `invalid` for a genuinely prose-only turn with no failure signal', () => {
    const before = { hasWorkPlan: true, pendingStepCount: 6 };
    const after = { hasWorkPlan: true, pendingStepCount: 6 };
    const disposition = decideWorkPlanTurnDisposition({ before, after, failed: false });
    expect(disposition).toEqual({
      kind: 'invalid',
      code: 'WORKPLAN_TURN_MISSING_DISPOSITION',
      retryable: true,
    });
  });

  it('still classifies as `invalid` when the model only made a single un-retried attempt (compliance regression, not exhausted retry)', () => {
    const before = { hasWorkPlan: true, pendingStepCount: 6 };
    const after = { hasWorkPlan: true, pendingStepCount: 6 };
    const toolCalls = [
      { name: 'coding_agent', error: 'Coding agent timed out after 20 minutes.', result: { retryable: true } },
    ];
    const disposition = decideWorkPlanTurnDisposition({
      before,
      after,
      failed: hadExhaustedTransientStepFailure(toolCalls, ['coding_agent']),
    });
    expect(disposition).toEqual({
      kind: 'invalid',
      code: 'WORKPLAN_TURN_MISSING_DISPOSITION',
      retryable: true,
    });
  });
});
