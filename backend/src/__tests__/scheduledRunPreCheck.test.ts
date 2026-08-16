/**
 * ENG-1259 — cheap pre-check gate for scheduled chat runs.
 *
 * PMPS's `LUCAS — LinkedIn Thought Leadership (Mon/Wed/Fri)` schedule ran the
 * FULL multi-step generative flow four separate times before concluding there
 * was nothing to do ("Schedule skipped" x3 at $21.61/$12.36/$12.32, "Nothing
 * Published" x1 at $11.35 — 41-129 messages each). This module is the
 * deterministic decision logic for a cheap gate that sits BEFORE the expensive
 * flow: it decides (a) whether a run's recent history even warrants spending a
 * cheap classification call, and (b) how to fold that classification into a
 * final proceed/skip decision that always fails TOWARD running.
 *
 * Pure — no I/O, no network, no LLM call. The LLM call itself lives on
 * agentModeService (see agentModeService.scheduledRunPreCheck.test.ts); this
 * module only decides whether to invoke it and how to interpret the result.
 */

import {
  wasNoActionableOutputRun,
  countTrailingNoActionableOutputRuns,
  shouldRunPreCheckGate,
  resolvePreCheckDecision,
} from '../utils/scheduledRunPreCheck';

describe('wasNoActionableOutputRun', () => {
  it('treats a conditional-cadence skip (ENG-844) as no actionable output even though it is status=success', () => {
    expect(wasNoActionableOutputRun({ status: 'success', passed: true, conditionalSkip: true })).toBe(true);
  });

  it('treats the new skipped_no_content status as no actionable output', () => {
    expect(wasNoActionableOutputRun({ status: 'skipped_no_content', passed: false })).toBe(true);
  });

  it('treats a plain validation failure as no actionable output (the LUCAS "Schedule skipped" shape)', () => {
    expect(wasNoActionableOutputRun({ status: 'failure', passed: false })).toBe(true);
  });

  it('does NOT treat a genuine success as no actionable output', () => {
    expect(wasNoActionableOutputRun({ status: 'success', passed: true })).toBe(false);
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
      { status: 'success', passed: true },
      { status: 'failure', passed: false },
      { status: 'failure', passed: false },
      { status: 'skipped_no_content', passed: false },
    ];
    expect(countTrailingNoActionableOutputRuns(runResults)).toBe(3);
  });

  it('stops counting at the first productive run walking backwards', () => {
    const runResults = [
      { status: 'failure', passed: false },
      { status: 'success', passed: true },
      { status: 'failure', passed: false },
    ];
    expect(countTrailingNoActionableOutputRuns(runResults)).toBe(1);
  });

  it('returns 0 for an empty or missing history', () => {
    expect(countTrailingNoActionableOutputRuns([])).toBe(0);
    expect(countTrailingNoActionableOutputRuns(undefined)).toBe(0);
    expect(countTrailingNoActionableOutputRuns(null)).toBe(0);
  });

  it('counts the whole array when every run was a no-op (the reconstructed LUCAS scenario)', () => {
    const lucasHistory = [
      { status: 'failure', passed: false, actualResponse: 'Schedule skipped' },
      { status: 'failure', passed: false, actualResponse: 'Schedule skipped' },
      { status: 'failure', passed: false, actualResponse: 'Schedule skipped' },
    ];
    expect(countTrailingNoActionableOutputRuns(lucasHistory)).toBe(3);
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
      { status: 'failure', passed: false },
      { status: 'success', passed: true },
    ];
    expect(shouldRunPreCheckGate(runResults)).toBe(false);
  });

  it('is true when the most recent run had no actionable output (the exact waste pattern from the evidence)', () => {
    const runResults = [
      { status: 'success', passed: true },
      { status: 'failure', passed: false, actualResponse: 'Nothing Published' },
    ];
    expect(shouldRunPreCheckGate(runResults)).toBe(true);
  });

  it('is true when the most recent run was a conditional-cadence skip', () => {
    expect(shouldRunPreCheckGate([{ status: 'success', passed: true, conditionalSkip: true }])).toBe(true);
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
