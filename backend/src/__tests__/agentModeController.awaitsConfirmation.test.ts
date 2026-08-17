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
    "I'll pause here for your input before continuing.",
    'Pausing until you confirm the fallback plan.',
    'Holding off before proceeding with the aggregate report.',
    'Standing by for your reply before generating the report.',
    // Exact phrasings a claude-opus-4-8 scheduled run emitted in the live ENG-369
    // repro (these previously slipped past the detector — numbered-option menu,
    // "please confirm one of these", "get your confirmation", "pick an option").
    'Before I generate the report, please confirm one of these:',
    'Before I build a maximum-granularity report, I need to flag a limitation and get your confirmation on scope.',
    "Reply 1 (metadata-only report now) or 2 (report + file the feature request) and I'll build the full per-session table.",
    'I can render all of them once you pick an option.',
    'Please confirm before I generate the report.',
    'I need you to decide which approach to use.',
    // Second live Opus repro — a DIFFERENT phrasing, with markdown-bolded option
    // numbers (which previously split "Reply **1**" so the digit never matched).
    'How do you want to proceed?',
    'Reply **1**, **2**, or **3** — I recommend option 3.',
    'How would you like me to proceed with the report?',
    'Which option would you prefer: the metadata table or the full export?',
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
    // "paused" mentioned as report content, NOT as a halt awaiting the user.
    'The Meta ad campaign is currently paused; spend has stopped. Report complete.',
    'Two leads paused their subscriptions this week. Full breakdown below.',
    // The exact delivered-report ending from the passing (Gemini) live run — a
    // finished report surfacing optional follow-ups must NOT fire the detector.
    "👉 Next Step: Let me know if you need to filter this data by a specific user ID or if you'd like to analyze the token usage and costs for any particular session.",
    // Benign mentions of "options", "choose", "reply", "confirmed" in finished reports.
    'The report evaluates 3 pricing options the team is considering. Analysis complete.',
    'The customer chose the annual plan; renewal is confirmed. Summary below.',
    'Sent 12 replies across the 2 campaigns. Full log attached.',
    '',
    // ENG-1256: live production repro. The mandated trailing "👉 Next Step:" line
    // is a recommendation, not a question to the user, but its wording can still
    // trip a keyword-shaped pattern — here "confirm ... which" from the pattern
    // meant to catch "please confirm one of these" style human-directed asks.
    // The deliverable above this line was already fully delivered; the run is
    // NOT paused awaiting anyone's reply.
    "The digest above is complete and accurate — every number, author, and quoted finding comes directly from the `get_pr_digest` result. " +
      "👉 Next Step: Worth having someone verify click-ID capture on Every.io's lander and confirm which of the two pixels the ads are actually configured against.",
    // Same shape, different Next Step wording — a recommendation ADDRESSED TO A
    // THIRD PARTY ("Harsha"), not the user, that happens to contain "confirm ...
    // before ... creat[es]" — the exact live production repro (ENG-1256 second
    // recurrence), where "creates AW-LlmChargeEvents" a few clauses later
    // completed the "confirm … before … creat" pattern meant for genuine
    // confirm-before-you-build halts.
    "Filed as #2323 and #2414 — merged and deployed. " +
      "👉 Next Step: Ask Harsha to confirm whether #2323 and #2414 actually had his data-plane approval before merge — " +
      "#2414 creates AW-LlmChargeEvents and ships a guarded production reset command, so an unapproved merge there has real billing blast radius.",
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

  // ── ENG-1256: trailer-stripping must only remove the LAST occurrence ────────
  describe('Next Step trailer stripping only removes the LAST occurrence', () => {
    it('does NOT delete a genuine halt that follows a quoted/echoed earlier trailer', () => {
      const msg =
        "Last run's 👉 Next Step: was to confirm the sender domain. " +
        'That is done. Should I proceed with sending the campaign now? ' +
        '👉 Next Step: Reply to confirm and I will send it.';
      expect(scheduledRunAwaitsConfirmation(msg)).toBe(true);
    });

    it('still excludes a single mandated trailer at the end (no regression)', () => {
      const msg =
        'The digest is complete and delivered above. ' +
        '👉 Next Step: Ask Harsha to confirm whether this shipped with approval.';
      expect(scheduledRunAwaitsConfirmation(msg)).toBe(false);
    });

    it('strips the trailer even when it lacks the 👉 emoji (surrogate-pair-safe optional match)', () => {
      // Without the /u flag, `👉?` treats the emoji's mandatory high-surrogate
      // code unit as a required literal, so a trailer missing the emoji entirely
      // fails to match — stripping is inert, and the trailer's own "confirm ...
      // before ... creat[es]" wording (mirroring the live ENG-1256 repro) then
      // falls straight into the confirmation-halt pattern below.
      const msg =
        'The digest is complete and delivered above. ' +
        'Next Step: Ask Harsha to confirm whether this shipped with approval before merge — ' +
        'it creates AW-LlmChargeEvents and ships a guarded reset command.';
      expect(scheduledRunAwaitsConfirmation(msg)).toBe(false);
    });
  });
});
