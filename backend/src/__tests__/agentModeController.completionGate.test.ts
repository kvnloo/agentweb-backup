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

import { scheduledRunSignalsIncompleteWork } from '../controllers/agentModeController';

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

  // ── Fires on the step-budget truncation apology (ENG-244) ───────────────────
  // When a long data-gathering scheduled run exhausts its step budget
  // (maxIterations), generateSessionResponse emits this apology as the final
  // content instead of the deliverable. The gate must recognize it so a
  // continuation turn runs the final synthesis/output step (the report) rather
  // than finishing with no deliverable and a misleading "— Report Generated" title.
  const stepBudgetTruncations = [
    // Exact message emitted by agentModeService when iteration >= maxIterations.
    "I've reached the maximum number of processing steps for this request. Here's what was completed so far — please review and let me know if you'd like me to continue with any remaining items.",
    'I have reached the maximum number of steps for this request.',
    'Reached the maximum number of processing steps.',
  ];

  it.each(stepBudgetTruncations)('fires on step-budget truncation apology: %s', (text) => {
    expect(scheduledRunSignalsIncompleteWork(text)).toBe(true);
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
