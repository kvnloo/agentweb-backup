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
  classifyScheduledContinuationAsync,
} from '../controllers/agentModeController';

const MARKER = 'PUBLISH WITHHELD: this schedule requires approval before publishing.';
// ENG-1245: the never-granted branch's own terminal marker — same infra role as
// MARKER (ends the run, suppresses the confirmation-halt classifier), but it must
// never assert the "Require approval before publishing" toggle is why the run was
// withheld when that specific setting isn't actually what happened.
const MARKER_NOT_GRANTED = 'PUBLISH WITHHELD: this schedule has not been granted standing publish authorization.';
// ENG-1245: the revoked branch's own marker — a real owner decision, distinct from
// both the genuine-hold toggle and "never asked".
const MARKER_REVOKED = "PUBLISH WITHHELD: this schedule's publish authorization has been revoked.";

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

  // ENG-1245: the never-granted branch's report must not be forced to say "requires
  // approval before publishing" when the owner never touched that setting — so its
  // own marker sentence has to be recognised too, not just the genuine-hold one.
  it('also recognises the never-granted branch\'s own accurate marker', () => {
    expect(scheduledRunWithheldPublish(`Drafts saved.\n\n${MARKER_NOT_GRANTED}`)).toBe(true);
  });

  it('also recognises the revoked branch\'s own accurate marker', () => {
    expect(scheduledRunWithheldPublish(`Drafts saved.\n\n${MARKER_REVOKED}`)).toBe(true);
  });

  it('does not cross-match any marker\'s wording as another\'s, or vice versa', () => {
    // Each marker is its own complete sentence — none is a substring of another,
    // so this is really pinning that all three are matched independently, not confused.
    expect(scheduledRunWithheldPublish(MARKER)).toBe(true);
    expect(scheduledRunWithheldPublish(MARKER_NOT_GRANTED)).toBe(true);
    expect(scheduledRunWithheldPublish(MARKER_REVOKED)).toBe(true);
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

  it('returns null on the never-granted branch\'s own marker too (ENG-1245) — same exemption, different accurate wording', () => {
    expect(
      classifyScheduledContinuation({ content: `${withheldReport}\n\n${MARKER_NOT_GRANTED}` }, false)
    ).toBeNull();
  });

  it('returns null on the revoked branch\'s own marker too (ENG-1245) — same exemption, different accurate wording', () => {
    expect(
      classifyScheduledContinuation({ content: `${withheldReport}\n\n${MARKER_REVOKED}` }, false)
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

/**
 * ENG-803 — the authorization must be the one that is true NOW (Greptile review #30).
 *
 * A scheduled run lives for minutes and the owner can flip "Require approval before
 * publishing" while it is in flight. The prompt builder and the dispatch guard both
 * re-read the record when they act, so a boolean snapshotted at worker start is a
 * third, disagreeing opinion. The dangerous direction is a stale `false`: the owner
 * has just AUTHORIZED publishing, but the run still believes its own model-authored
 * marker and suppresses the corrective continuation — ENG-803's "finished without
 * posting" failure rebuilt out of a cache.
 *
 * These tests drive the resolver directly, which is the only way to express "the
 * value CHANGED mid-run" — a plain boolean parameter cannot represent it, and that
 * un-representability was the bug.
 *
 * The withheld report matches the confirmation regex, so scheduledTurnDefersToUser
 * short-circuits on its fast path and no LLM judge call is made.
 */
describe('classifyScheduledContinuationAsync — live publish authorization (ENG-803)', () => {
  const withheldReport = 'Drafts saved. Nothing was posted; these are awaiting your approval.';
  const withheldContent = `${withheldReport}\n\n${MARKER}`;

  it('refuses the exemption once the owner AUTHORIZES publishing mid-run', async () => {
    // The regression: snapshot said "withheld", the owner has since said "publish".
    // The marker must stop being believed the moment the record says authorized.
    expect(
      await classifyScheduledContinuationAsync({ content: withheldContent }, async () => true)
    ).toBe('confirmation');
  });

  it('honours the exemption while the record still withholds', async () => {
    expect(
      await classifyScheduledContinuationAsync({ content: withheldContent }, async () => false)
    ).toBeNull();
  });

  it('re-reads on EVERY classification rather than caching the first answer', async () => {
    // The staleness proof: one resolver, two calls, the record changed in between.
    let authorized = false;
    const resolver = jest.fn(async () => authorized);

    expect(await classifyScheduledContinuationAsync({ content: withheldContent }, resolver)).toBeNull();
    authorized = true;
    expect(
      await classifyScheduledContinuationAsync({ content: withheldContent }, resolver)
    ).toBe('confirmation');
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('refuses the exemption when the record cannot be read', async () => {
    // A DynamoDB blip must not manufacture the one value that makes model-authored
    // text believable. Costs one bounded continuation; the dispatch guard still
    // independently refuses any unauthorized publish the continuation attempts.
    expect(
      await classifyScheduledContinuationAsync({ content: withheldContent }, async () => undefined)
    ).toBe('confirmation');
  });

  it('never honours the marker for a caller with no schedule to read', async () => {
    expect(await classifyScheduledContinuationAsync({ content: withheldContent })).toBe('confirmation');
  });

  it('does not read the schedule on a turn that emitted no marker', async () => {
    // Lazy by design: the exemption is the only consumer, so a turn without the
    // marker must not pay a schedule read on every completion-gate evaluation.
    const resolver = jest.fn(async () => false);
    expect(
      await classifyScheduledContinuationAsync({ content: 'Posted 5 replies.' }, resolver)
    ).toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('still continues a withheld run that was truncated, whatever the live value', async () => {
    expect(
      await classifyScheduledContinuationAsync(
        { content: withheldContent, truncatedByStepBudget: true },
        async () => false
      )
    ).toBe('budget');
  });
});
