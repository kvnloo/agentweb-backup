/**
 * Unit tests for scheduledRunAwaitsConfirmation() — the deterministic detector
 * that catches a scheduled/unattended run which halted to ask a human to
 * confirm/approve before proceeding (ENG-369).
 *
 * Background: in a scheduled run no human is present. When the agent hits a
 * limitation (e.g. the requested maximum-granularity approach is infeasible)
 * and ends its turn by asking the user to confirm a fallback ("Reply 'go' to
 * proceed", "Should I proceed with the best-effort approach?"), the task
 * dead-ends because nobody answers. This detector lets the completion gate fire
 * one more continuation turn instructing the agent to proceed best-effort.
 *
 * Critical design constraint: it must fire ONLY on requests for human
 * confirmation/approval-to-proceed, NOT on legitimate actionable next-steps a
 * finished report surfaces (e.g. "Connect Bob's LinkedIn next run"), which are a
 * valid terminal state.
 */

import {
  scheduledRunAwaitsConfirmation,
  scheduledRunSignalsIncompleteResponse,
} from '../controllers/agentModeController';

describe('scheduledRunAwaitsConfirmation — unattended confirmation-halt detector', () => {
  // ── Fires on requests for human confirmation before proceeding ──────────────
  const confirmationHalts = [
    // The exact ENG-369 phrasing.
    "The maximum-granularity approach is not feasible. Reply 'go' to proceed with the best-effort recommended approach.",
    'Reply go to continue with the fallback plan.',
    'Should I proceed with the best-effort approach instead?',
    'Shall I proceed with the recommended approach?',
    'Would you like me to proceed with the aggregate report instead?',
    'Do you want me to continue with the simplified approach?',
    "Let me know if you'd like me to proceed with the alternate method.",
    'Let me know how you would like to proceed.',
    'Please confirm before I proceed with the best-effort report.',
    'Awaiting your confirmation to proceed.',
    'I will wait for your approval before proceeding.',
    'Confirm to continue and I will generate the report.',
  ];

  it.each(confirmationHalts)('fires on confirmation halt: %s', (text) => {
    expect(scheduledRunAwaitsConfirmation(text)).toBe(true);
  });

  // ── Does NOT fire on finished reports or actionable next-steps ──────────────
  const cleanOrActionable = [
    'All three events completed. Consolidated report below.',
    'Report complete. Next steps: connect Bob on LinkedIn before the next run.',
    "Harsha's LinkedIn is not connected, so those actions are drafts. Report complete.",
    'Research complete across every event. Actionable items listed below.',
    "Event 2 — Bob: LinkedIn not accessible, flagged as actionable. All events covered.",
    'I generated the daily activity report using the best-effort aggregate approach.',
    '',
  ];

  it.each(cleanOrActionable)('does NOT fire on clean/actionable report: %s', (text) => {
    expect(scheduledRunAwaitsConfirmation(text)).toBe(false);
  });

  // ── Robustness ──────────────────────────────────────────────────────────────
  it('handles undefined/null content without throwing', () => {
    expect(scheduledRunAwaitsConfirmation(undefined as any)).toBe(false);
    expect(scheduledRunAwaitsConfirmation(null as any)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(scheduledRunAwaitsConfirmation("REPLY 'GO' TO PROCEED WITH THE FALLBACK.")).toBe(true);
  });

  it('fires when the confirmation request is embedded in a larger message', () => {
    const msg = `# Daily User Activity Report — blocked
I could not build the per-session breakdown because no per-session transcript tool exists.
The best-effort approach is an aggregate summary. Should I proceed with that instead?`;
    expect(scheduledRunAwaitsConfirmation(msg)).toBe(true);
  });

  // ── Feeds the shared completion-gate signal ─────────────────────────────────
  it('scheduledRunSignalsIncompleteResponse also fires on a confirmation halt', () => {
    expect(
      scheduledRunSignalsIncompleteResponse({
        content: "Reply 'go' to proceed with the best-effort approach.",
      })
    ).toBe(true);
  });
});
