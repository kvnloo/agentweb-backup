/**
 * ENG-1259 — cheap pre-check gate for scheduled chat runs.
 *
 * PMPS's `LUCAS — LinkedIn Thought Leadership (Mon/Wed/Fri)` schedule ran the
 * FULL multi-step generative flow four separate times before concluding there
 * was nothing to do ("Schedule skipped" x3 at $21.61/$12.36/$12.32, "Nothing
 * Published" x1 at $11.35 — 41-129 messages each). This module is the
 * deterministic decision logic for a cheap gate that sits BEFORE the expensive
 * flow: it decides (a) whether a run's recent history even warrants spending a
 * cheap classification call, (b) how to fold that classification into a final
 * proceed/skip decision that always fails TOWARD running, and (c) when the
 * gate itself must stand down and force a real run rather than asking the
 * classifier again (Greptile P1s from the initial review: a pre-flight block
 * must not be mistaken for a genuine decline, and a skip streak must not be
 * able to repeat forever unchecked).
 *
 * Pure — no I/O, no network, no LLM call. The LLM call itself lives on
 * agentModeService (see agentModeService.scheduledRunPreCheck.test.ts); this
 * module only decides whether to invoke it and how to interpret the result.
 */

import {
  wasNoActionableOutputRun,
  countTrailingNoActionableOutputRuns,
  shouldRunPreCheckGate,
  countTrailingGateSkips,
  shouldForceProceedAfterSkipStreak,
  resolvePreCheckDecision,
} from '../utils/scheduledRunPreCheck';

describe('wasNoActionableOutputRun', () => {
  it('treats a conditional-cadence skip (ENG-844) as no actionable output even though it is status=success', () => {
    expect(wasNoActionableOutputRun({ status: 'success', passed: true, conditionalSkip: true, attempt: 1 })).toBe(true);
  });

  it('treats the new skipped_no_content status as no actionable output regardless of attempt (it is always 0)', () => {
    expect(wasNoActionableOutputRun({ status: 'skipped_no_content', passed: false, attempt: 0 })).toBe(true);
  });

  it('treats a validation failure that GENUINELY RAN (attempt >= 1) as no actionable output (the LUCAS "Schedule skipped" shape)', () => {
    expect(wasNoActionableOutputRun({ status: 'failure', passed: false, attempt: 3 })).toBe(true);
  });

  // Greptile P1 (initial review): a bare status:'failure' also covers pre-flight
  // blocks that never reached the model at all — entitlement checks, token-limit
  // caps, an orphaned schedule owner, a disallowed-function check, a generic
  // exception before any turn ran. Every one of those hardcodes attempt: 0 in
  // this codebase. Treating them as "no actionable output" would suppress the
  // RETRY those failures are supposed to get on the schedule's next fire.
  it('does NOT treat a pre-flight operational failure (attempt: 0) as no actionable output', () => {
    expect(wasNoActionableOutputRun({ status: 'failure', passed: false, attempt: 0 })).toBe(false);
  });

  it('does NOT treat a failure with a missing attempt field as no actionable output (defensive — same risk as attempt: 0)', () => {
    expect(wasNoActionableOutputRun({ status: 'failure', passed: false })).toBe(false);
  });

  it('does NOT treat a genuine success as no actionable output', () => {
    expect(wasNoActionableOutputRun({ status: 'success', passed: true, attempt: 1 })).toBe(false);
  });

  it('does NOT treat a parked pending_user_input run as no actionable output', () => {
    expect(wasNoActionableOutputRun({ status: 'pending_user_input', passed: false })).toBe(false);
  });

  it('is defensive against malformed/missing entries', () => {
    expect(wasNoActionableOutputRun(null)).toBe(false);
    expect(wasNoActionableOutputRun(undefined)).toBe(false);
    expect(wasNoActionableOutputRun('not-an-object' as any)).toBe(false);
    expect(wasNoActionableOutputRun({})).toBe(false);
  });
});

describe('countTrailingNoActionableOutputRuns', () => {
  it('counts consecutive no-output runs from the END of the array', () => {
    const runResults = [
      { status: 'success', passed: true, attempt: 1 },
      { status: 'failure', passed: false, attempt: 2 },
      { status: 'failure', passed: false, attempt: 4 },
      { status: 'skipped_no_content', passed: false, attempt: 0 },
    ];
    expect(countTrailingNoActionableOutputRuns(runResults)).toBe(3);
  });

  it('stops counting at the first productive run walking backwards', () => {
    const runResults = [
      { status: 'failure', passed: false, attempt: 1 },
      { status: 'success', passed: true, attempt: 1 },
      { status: 'failure', passed: false, attempt: 1 },
    ];
    expect(countTrailingNoActionableOutputRuns(runResults)).toBe(1);
  });

  it('returns 0 for an empty or missing history', () => {
    expect(countTrailingNoActionableOutputRuns([])).toBe(0);
    expect(countTrailingNoActionableOutputRuns(undefined)).toBe(0);
    expect(countTrailingNoActionableOutputRuns(null)).toBe(0);
  });

  it('counts the whole array when every run was a genuine no-op (the reconstructed LUCAS scenario)', () => {
    const lucasHistory = [
      { status: 'failure', passed: false, actualResponse: 'Schedule skipped', attempt: 1 },
      { status: 'failure', passed: false, actualResponse: 'Schedule skipped', attempt: 1 },
      { status: 'failure', passed: false, actualResponse: 'Schedule skipped', attempt: 2 },
    ];
    expect(countTrailingNoActionableOutputRuns(lucasHistory)).toBe(3);
  });

  it('does NOT count a trailing streak of pre-flight operational failures (Greptile P1)', () => {
    const runResults = [
      { status: 'success', passed: true, attempt: 1 },
      { status: 'failure', passed: false, attempt: 0 }, // e.g. token-limit block
      { status: 'failure', passed: false, attempt: 0 }, // e.g. entitlement block
    ];
    expect(countTrailingNoActionableOutputRuns(runResults)).toBe(0);
  });
});

describe('shouldRunPreCheckGate', () => {
  it('is false with no run history at all (first-ever run costs nothing extra)', () => {
    expect(shouldRunPreCheckGate([])).toBe(false);
    expect(shouldRunPreCheckGate(undefined)).toBe(false);
    expect(shouldRunPreCheckGate(null)).toBe(false);
  });

  it('is false when the most recent run was productive — zero overhead on a healthy schedule', () => {
    const runResults = [
      { status: 'failure', passed: false, attempt: 1 },
      { status: 'success', passed: true, attempt: 1 },
    ];
    expect(shouldRunPreCheckGate(runResults)).toBe(false);
  });

  it('is true when the most recent run genuinely ran and had no actionable output (the exact waste pattern from the evidence)', () => {
    const runResults = [
      { status: 'success', passed: true, attempt: 1 },
      { status: 'failure', passed: false, actualResponse: 'Nothing Published', attempt: 4 },
    ];
    expect(shouldRunPreCheckGate(runResults)).toBe(true);
  });

  it('is true when the most recent run was a conditional-cadence skip', () => {
    expect(shouldRunPreCheckGate([{ status: 'success', passed: true, conditionalSkip: true, attempt: 1 }])).toBe(true);
  });

  // Greptile P1 (initial review): the exact scenario the fix targets — a schedule
  // whose last fire was blocked pre-flight (e.g. a transient entitlement lookup)
  // must retry normally next time, not have this gate reason about it as a
  // content decision.
  it('is false when the most recent run was a pre-flight operational failure (attempt: 0)', () => {
    expect(shouldRunPreCheckGate([{ status: 'failure', passed: false, attempt: 0 }])).toBe(false);
  });
});

describe('countTrailingGateSkips', () => {
  it('counts only this gate\'s own consecutive skips, not genuine full-flow declines', () => {
    const runResults = [
      { status: 'failure', passed: false, attempt: 3 }, // a genuine decline — the gate did NOT cause this
      { status: 'skipped_no_content', passed: false, attempt: 0 },
      { status: 'skipped_no_content', passed: false, attempt: 0 },
    ];
    expect(countTrailingGateSkips(runResults)).toBe(2);
  });

  it('stops at the first non-gate-skip entry walking backwards', () => {
    const runResults = [
      { status: 'skipped_no_content', passed: false, attempt: 0 },
      { status: 'success', passed: true, attempt: 1 },
      { status: 'skipped_no_content', passed: false, attempt: 0 },
    ];
    expect(countTrailingGateSkips(runResults)).toBe(1);
  });

  it('returns 0 for empty/missing history', () => {
    expect(countTrailingGateSkips([])).toBe(0);
    expect(countTrailingGateSkips(undefined)).toBe(0);
  });
});

describe('shouldForceProceedAfterSkipStreak — bounds the gate\'s own risk (Greptile P1, initial review)', () => {
  it('is false below the cap', () => {
    const runResults = [{ status: 'skipped_no_content', passed: false, attempt: 0 }];
    expect(shouldForceProceedAfterSkipStreak(runResults)).toBe(false);
  });

  it('is true once the trailing skip streak reaches the cap', () => {
    const runResults = [
      { status: 'skipped_no_content', passed: false, attempt: 0 },
      { status: 'skipped_no_content', passed: false, attempt: 0 },
    ];
    expect(shouldForceProceedAfterSkipStreak(runResults)).toBe(true);
  });

  it('respects a custom cap', () => {
    const runResults = [
      { status: 'skipped_no_content', passed: false, attempt: 0 },
      { status: 'skipped_no_content', passed: false, attempt: 0 },
      { status: 'skipped_no_content', passed: false, attempt: 0 },
    ];
    expect(shouldForceProceedAfterSkipStreak(runResults, 5)).toBe(false);
    expect(shouldForceProceedAfterSkipStreak(runResults, 3)).toBe(true);
  });

  it('a genuine full-flow decline (not a gate skip) does not count toward the cap', () => {
    // Two gate skips, but the run BEFORE them was a genuine decline (the full
    // flow ran) — the streak the cap cares about is only the trailing gate
    // skips, so this is still below a cap of 2... then a third gate skip after
    // it should trip the cap.
    const runResults = [
      { status: 'failure', passed: false, attempt: 5 },
      { status: 'skipped_no_content', passed: false, attempt: 0 },
    ];
    expect(shouldForceProceedAfterSkipStreak(runResults)).toBe(false);
  });
});

describe('resolvePreCheckDecision — fail TOWARD running (ENG-1259 AC4)', () => {
  it('skips only on an explicit high-confidence "skip" from the model', () => {
    const outcome = resolvePreCheckDecision({
      decision: 'skip',
      confidence: 'high',
      reason: 'Three consecutive runs found nothing new; instructions give no reason today differs.',
    });
    expect(outcome.decision).toBe('skip');
    expect(outcome.reason).toContain('consecutive runs');
  });

  it('proceeds on an explicit "proceed" decision', () => {
    const outcome = resolvePreCheckDecision({ decision: 'proceed', confidence: 'high', reason: 'New content likely.' });
    expect(outcome.decision).toBe('proceed');
  });

  it('proceeds on a "skip" decision with only LOW confidence — ambiguity folds to proceed', () => {
    const outcome = resolvePreCheckDecision({ decision: 'skip', confidence: 'low', reason: 'Not fully sure.' });
    expect(outcome.decision).toBe('proceed');
  });

  it('proceeds on a genuinely ambiguous decision value from the model', () => {
    const outcome = resolvePreCheckDecision({ decision: 'ambiguous', confidence: 'low', reason: 'Unclear.' });
    expect(outcome.decision).toBe('proceed');
  });

  it('proceeds on a malformed/unexpected decision string (defensive fail-open)', () => {
    const outcome = resolvePreCheckDecision({ decision: 'yes please skip it', confidence: 'high', reason: 'garbled' } as any);
    expect(outcome.decision).toBe('proceed');
  });

  it('proceeds when the LLM call itself failed (null result — timeout/error/unparseable)', () => {
    const outcome = resolvePreCheckDecision(null);
    expect(outcome.decision).toBe('proceed');
    expect(outcome.reason).toBe('precheck_unavailable_fail_open');
  });
});
