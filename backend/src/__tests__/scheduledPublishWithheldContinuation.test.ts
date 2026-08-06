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
 *
 * AND THE MARKER IS ONLY BELIEVED ON A RUN THAT ACTUALLY WITHHELD (review #20).
 * The marker is text the MODEL wrote. Honouring it unconditionally would let an
 * AUTHORIZED run that simply does not want to post emit the sentence, suppress its
 * own corrective continuation, and finish "successfully" having published nothing —
 * ENG-803's fabricated publishing constraint, handed a machine-readable escape
 * hatch by the very fix meant to close it. The exemption therefore requires an
 * explicit `publishAuthorized === false` resolved from the schedule record.
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

  it('returns null once a genuinely WITHHELD run emits the marker — the run is complete', () => {
    expect(
      classifyScheduledContinuation({ content: `${withheldReport}\n\n${MARKER}` }, false)
    ).toBeNull();
  });

  // Greptile review #20: the marker is model-authored, so it must not be a way for a
  // run that WAS allowed to publish to excuse itself from publishing.
  it('IGNORES the marker on an AUTHORIZED run, so it cannot fake its way out of publishing', () => {
    expect(
      classifyScheduledContinuation({ content: `${withheldReport}\n\n${MARKER}` }, true)
    ).toBe('confirmation');
  });

  it('IGNORES the marker when authorization is unknown — exemption needs an explicit false', () => {
    // Not symmetric: refusing the exemption costs a withheld run one bounded extra
    // continuation, while granting it on an unknown lets any run skip a mandated post.
    expect(
      classifyScheduledContinuation({ content: `${withheldReport}\n\n${MARKER}` })
    ).toBe('confirmation');
  });

  it('suppresses ONLY confirmation — a truncated withheld run still continues', () => {
    expect(
      classifyScheduledContinuation({
        content: `${withheldReport}\n\n${MARKER}`,
        truncatedByStepBudget: true,
      }, false)
    ).toBe('budget');
  });

  it('suppresses ONLY confirmation — genuinely unfinished work still continues', () => {
    expect(
      classifyScheduledContinuation({
        content: `${MARKER}\n\nI did not finish the research for the remaining 2 accounts.`,
      }, false)
    ).toBe('unfinished');
  });

  it('leaves an ordinary confirmation halt untouched', () => {
    expect(
      classifyScheduledContinuation({ content: 'Should I proceed with sending these?' })
    ).toBe('confirmation');
  });
});
