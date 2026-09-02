import {
  decideWorkPlanTurnDisposition,
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

  it('is true for a transient error message even without an explicit retryable flag (v0 timeout shape)', () => {
    const toolCalls = [
      { name: 'generate_landing_page', error: 'v0 chat creation timed out after 300s' },
    ];
    expect(hadExhaustedTransientStepFailure(toolCalls, ['generate_landing_page'])).toBe(true);
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
});
