/**
 * Unit tests for scheduledRunSignalsIncompleteWork() — the deterministic
 * completion-gate detector used by runVerifiedChat for scheduled runs.
 *
 * Background: PR #1941's prompt directive (PER-ENTITY COMPLETION LOOP) reduces
 * the chance a scheduled multi-entity run stops short, but it is probabilistic.
 * This detector adds a deterministic backstop: if the final turn of a scheduled
 * run *admits* it left work unfinished (e.g. "I did not complete Step 3 for
 * Events 2/3"), the gate triggers one more continuation turn so the run finishes
 * — instead of returning success with self-admitted gaps.
 *
 * Critical design constraint: the gate must fire ONLY on admissions of
 * UNFINISHED work the agent could have done, NOT on legitimate per-entity
 * blockers (e.g. "Bob's LinkedIn is not accessible"). Blockers are handled by
 * the BLOCKER ISOLATION directive and are a valid terminal state; firing the
 * gate on them would loop pointlessly.
 */

import {
  scheduledRunSignalsIncompleteWork,
  scheduledRunSignalsIncompleteResponse,
} from '../controllers/agentModeController';

describe('scheduledRunSignalsIncompleteWork — completion-gate detector', () => {
  // ── Fires on genuine "I stopped short / didn't finish" admissions ───────────
  const incompleteAdmissions = [
    'I did not complete Step 3 (LinkedIn profile + funding research) for Event 2/3 leads.',
    "I stopped row-by-row LinkedIn extraction before fully resolving each profile.",
    'I did not finish per-lead LinkedIn + funding verification.',
    'I have not yet processed the remaining events.',
    "I didn't finish researching Events 2 and 3.",
    'I will continue with the remaining leads later.',
    'The remaining events were not processed in this run.',
  ];

  it.each(incompleteAdmissions)('fires on incomplete-work admission: %s', (text) => {
    expect(scheduledRunSignalsIncompleteWork(text)).toBe(true);
  });

  // ── Step-budget truncation (ENG-244) is detected by STATE, not text ─────────
  // When a long data-gathering scheduled run exhausts its step budget
  // (maxIterations), it is truncated before emitting the deliverable. The model
  // usually complies with the "wrap up soon" nudge and writes its own partial
  // non-report text, so the truncation is NOT reliably visible in the response
  // text — the canned apology only appears when content is empty. Detection must
  // therefore key off the deterministic truncatedByStepBudget flag, which
  // scheduledRunSignalsIncompleteResponse consumes.
  const stepBudgetTexts = [
    // Canned apology (only emitted when content was empty at maxIterations).
    "I've reached the maximum number of processing steps for this request. Here's what was completed so far — please review and let me know if you'd like me to continue with any remaining items.",
    // The far more common case: the model wrote non-report partial text and the
    // apology never substituted. Text alone gives the gate nothing to match.
    'Here is a partial summary of the user activity gathered so far. Page 4 of the S3 export is still pending.',
  ];

  it.each(stepBudgetTexts)('scheduledRunSignalsIncompleteResponse fires when truncatedByStepBudget is set, whatever the text: %s', (text) => {
    expect(scheduledRunSignalsIncompleteResponse({ content: text, truncatedByStepBudget: true })).toBe(true);
  });

  it('scheduledRunSignalsIncompleteResponse fires on the flag even with empty content', () => {
    expect(scheduledRunSignalsIncompleteResponse({ content: '', truncatedByStepBudget: true })).toBe(true);
  });

  it('scheduledRunSignalsIncompleteWork does NOT rely on the apology text (flag-based detection only)', () => {
    // The non-report partial text a compliant model emits at truncation carries no
    // admission phrasing, so the text detector correctly returns false — the flag
    // is what makes the truncation detectable.
    expect(scheduledRunSignalsIncompleteWork(
      'Here is a partial summary of the user activity gathered so far. Page 4 of the S3 export is still pending.'
    )).toBe(false);
  });

  it('scheduledRunSignalsIncompleteResponse defers to the text detector when the flag is absent', () => {
    expect(scheduledRunSignalsIncompleteResponse({ content: 'I did not finish researching Events 2 and 3.' })).toBe(true);
    expect(scheduledRunSignalsIncompleteResponse({ content: 'All three events completed. Consolidated report below.' })).toBe(false);
  });

  it('fires when the admission is embedded in a larger report', () => {
    const report = `# Lead Report
Event 1 — done, full verdict.
Event 3 — I stopped row-by-row LinkedIn extraction before fully resolving each profile.
👉 Next Step: ...`;
    expect(scheduledRunSignalsIncompleteWork(report)).toBe(true);
  });

  // ── Does NOT fire on legitimate per-entity blockers or clean completions ────
  const cleanOrBlocked = [
    // a finished report where one entity is blocked (valid terminal state)
    "Event 2 — Bob Roe: LinkedIn not accessible, cannot view profile. All 3 events covered.",
    "Harsha's LinkedIn is not connected, so those actions are drafts. Report complete for all events.",
    'All three events completed. Here is the consolidated report.',
    'Research complete across every event. Actionable items listed below.',
    "I could not verify Bob's profile because it is not connected — flagged as an action item.",
    '',
  ];

  it.each(cleanOrBlocked)('does NOT fire on clean/blocked-but-complete report: %s', (text) => {
    expect(scheduledRunSignalsIncompleteWork(text)).toBe(false);
  });

  it('does NOT fire on a pure blocker phrase without an unfinished-work admission', () => {
    expect(scheduledRunSignalsIncompleteWork('Profile is inaccessible; flagged as actionable blocker.')).toBe(false);
  });

  // ── Robustness ───────────────────────────────────────────────────────────────
  it('handles undefined/null content without throwing', () => {
    expect(scheduledRunSignalsIncompleteWork(undefined as any)).toBe(false);
    expect(scheduledRunSignalsIncompleteWork(null as any)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(scheduledRunSignalsIncompleteWork('I DID NOT FINISH the remaining events.')).toBe(true);
  });
});
