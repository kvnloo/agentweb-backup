/**
 * ENG-803 — a deliberate publish-withhold must END the run, not restart it.
 *
 * This closes the second-order failure the fix would otherwise create. When a
 * schedule is set to require approval, the run correctly finishes by saying the
 * drafts are saved and nothing was posted — but that wording ("awaiting your
 * approval", "pending approval") is exactly what the scheduled-continuation
 * classifier reads as a run halting for a human answer. It would then be nudged to
 * continue, on a schedule whose owner asked it NOT to publish: the same nudge loop
 * this area of the code exists to prevent, now triggered by correct behaviour
 * (Greptile review #16 — "the continuation path remains authorization-unaware").
 *
 * The withheld branch of the directive therefore mandates a terminal marker, and
 * the classifier treats that marker as "complete", suppressing ONLY the
 * confirmation reason — a withheld run can still be genuinely truncated or leave
 * other work unfinished, and those must still continue.
 */

import {
  scheduledRunWithheldPublish,
  classifyScheduledContinuation,
} from '../controllers/agentModeController';

const MARKER = 'PUBLISH WITHHELD: this schedule requires approval before publishing.';

describe('scheduledRunWithheldPublish (ENG-803)', () => {
  it('recognises the marker the withheld branch mandates', () => {
    expect(scheduledRunWithheldPublish(`Drafts saved.\n\n${MARKER}`)).toBe(true);
  });

  it('is case-insensitive and tolerant of surrounding text', () => {
    expect(
      scheduledRunWithheldPublish('publish withheld: THIS SCHEDULE REQUIRES APPROVAL BEFORE PUBLISHING')
    ).toBe(true);
  });

  it('does not fire on ordinary reports, including ones that merely discuss publishing', () => {
    expect(scheduledRunWithheldPublish('Posted 5 replies.')).toBe(false);
    expect(scheduledRunWithheldPublish('The schedule requires approval for some things.')).toBe(false);
    expect(scheduledRunWithheldPublish('')).toBe(false);
    expect(scheduledRunWithheldPublish(undefined)).toBe(false);
    expect(scheduledRunWithheldPublish(null as any)).toBe(false);
  });
});

describe('classifyScheduledContinuation — publish-withheld exemption (ENG-803)', () => {
  // The verbatim shape of the problem: without the marker this text is a
  // 'confirmation' halt, which would drive a continuation ordering more work.
  const withheldReport =
    'I drafted 5 replies and saved them to the knowledge base. Nothing was posted — ' +
    'the drafts are awaiting your approval.';

  it('WOULD classify the withheld wording as a confirmation halt without the marker', () => {
    expect(classifyScheduledContinuation({ content: withheldReport })).toBe('confirmation');
  });

  it('returns null once the run emits the withheld marker — the run is complete', () => {
    expect(
      classifyScheduledContinuation({ content: `${withheldReport}\n\n${MARKER}` })
    ).toBeNull();
  });

  it('suppresses ONLY confirmation — a truncated withheld run still continues', () => {
    expect(
      classifyScheduledContinuation({
        content: `${withheldReport}\n\n${MARKER}`,
        truncatedByStepBudget: true,
      })
    ).toBe('budget');
  });

  it('suppresses ONLY confirmation — genuinely unfinished work still continues', () => {
    expect(
      classifyScheduledContinuation({
        content: `${MARKER}\n\nI did not finish the research for the remaining 2 accounts.`,
      })
    ).toBe('unfinished');
  });

  it('leaves an ordinary confirmation halt untouched', () => {
    expect(
      classifyScheduledContinuation({ content: 'Should I proceed with sending these?' })
    ).toBe('confirmation');
  });
});
