/**
 * ENG-803 — the agent invented an "active X publishing gate" that no tool ever
 * returned, skipped twitter_manage_post entirely, and still titled the run
 * "Scheduled: Harsha X Reply Guy — Mentions (auto) — Replies queued" having
 * posted nothing (session 0fe2e743-6324-4720-af62-a8867464ecbb; also reported by
 * ruiw@ on session f0a09def).
 *
 * Two halves are pinned here, and they have to move together:
 *
 *  - the REPORTING rules, which are unconditional — inventing a gate is a
 *    reporting violation whichever way authorization resolved; and
 *  - the PUBLISH AUTHORIZATION decision, which must ALWAYS be stated. Two earlier
 *    revisions failed on opposite sides of this: an unqualified mandate whose
 *    "you are not authorized" escape hatch could never occur (Greptile review #11),
 *    then a carve-out that deferred to a block which did not exist, leaving the
 *    skipped-tool failure reachable (review #15). Both are one bug — a decision
 *    nobody makes. So every unattended scheduled run now carries exactly one of the
 *    two branches, and the tests assert that both exist and that they are mutually
 *    exclusive.
 *
 * A third state matters too: an ATTENDED turn on a schedule-created session (the
 * customer-portal sidebar) must carry NEITHER branch — see review #18 below.
 */

import { getScheduledSessionOverride } from '../docs/agentModeSystemPrompt';

describe('getScheduledSessionOverride — truthful execution reporting (ENG-803)', () => {
  // The publish argument is TRI-STATE: true/false is an UNATTENDED run whose
  // decision the caller resolved from the schedule record, and omitting it is an
  // ATTENDED turn (the sidebar) that must carry no publish rules at all.
  const scheduled = getScheduledSessionOverride('scheduled', true);
  const approvalRequired = getScheduledSessionOverride('scheduled', false);
  // Attended sidebar turn on a schedule-created session — no resolved decision.
  const attended = getScheduledSessionOverride('scheduled');

  it('emits nothing at all for non-scheduled sessions, on either branch', () => {
    // The rules are unattended-run rules; an interactive session has a human who
    // can be asked, so injecting a "you MUST call the tool" mandate there would
    // override the ordinary approval flow.
    expect(getScheduledSessionOverride('regular')).toBe('');
    expect(getScheduledSessionOverride(undefined)).toBe('');
    expect(getScheduledSessionOverride('slack')).toBe('');
    expect(getScheduledSessionOverride('regular', false)).toBe('');
    expect(getScheduledSessionOverride('regular', true)).toBe('');
  });

  it('keeps the pre-existing "do not suggest creating a schedule" override intact', () => {
    expect(scheduled).toContain('This IS a scheduled automated session');
    expect(scheduled).toContain('NEVER suggest creating a schedule');
  });

  describe('no fabricated platform or publish gate', () => {
    it('bans asserting a gate that no tool call actually returned', () => {
      expect(scheduled).toContain('NO FABRICATED PLATFORM OR PUBLISH GATE');
      expect(scheduled).toContain('unattended publish');
      expect(scheduled).toContain('unless an actual tool call in THIS session returned that gate/permission error');
      expect(scheduled).toContain('you may NOT claim a gate exists');
    });

    it('requires a REAL gate to be named by tool and verbatim error, then handled the way session 975e0fae did', () => {
      // 975e0fae hit a genuine gate, explained it, saved the draft and filed a
      // product issue — and scored 4/5/5. That is the correct fallback, so the
      // directive has to point at it rather than leaving "blocked" as a dead end.
      expect(scheduled).toContain('name the SPECIFIC tool and the verbatim error');
      expect(scheduled).toContain('report_product_issues');
      expect(scheduled).toContain('persist the drafts to the knowledge base');
    });

    it('forbids restating the owner-set authorization block as a platform gate', () => {
      // The failure mode outlives the authorization fix: given a REAL block the
      // model can still describe it as an "X publishing gate", which is the same
      // lie about the same run. Accuracy is required about the block itself, on
      // both branches.
      for (const variant of [scheduled, approvalRequired]) {
        expect(variant).toContain('PUBLISH AUTHORIZATION');
        expect(variant).toContain('an account-level setting the owner chose on this schedule');
        expect(variant).toContain('never as a platform, X/Twitter, API, or credential gate');
      }
    });

    it('ties the title and summary to real tool outcomes, banning the reported "queued" title', () => {
      expect(scheduled).toContain('Derive your title and summary from actual tool-call outcomes');
      expect(scheduled).toContain('"queued"');
    });
  });

  describe('never substitute a draft for a mandated action', () => {
    it('names the posting tool the reported run silently skipped', () => {
      expect(scheduled).toContain('NEVER SUBSTITUTE A DRAFT FOR A MANDATED ACTION');
      expect(scheduled).toContain('twitter_manage_post');
      expect(scheduled).toContain('post_on_connected_account');
      expect(scheduled).toContain('you MUST actually call that tool');
    });

    it('allows exactly two outs — the authorization block, or a real tool error', () => {
      for (const variant of [scheduled, approvalRequired]) {
        expect(variant).toContain('exactly TWO acceptable reasons');
        expect(variant).toContain('the PUBLISH AUTHORIZATION block below states this run is not authorized to publish');
        expect(variant).toContain('a tool call you ACTUALLY made returned an error');
        expect(variant).toContain('Nothing else qualifies');
      }
    });

    // Greptile review #11 and review #15 are the two halves of one requirement:
    // the mandate must actually require the tool (#15), AND its "not authorized"
    // escape hatch must be genuinely reachable (#11). Emitting a branch in every
    // case is what satisfies both — a gated rule whose escape branch cannot occur
    // is not gated at all.
    it('ALWAYS states a publish decision — never leaves it to model judgment', () => {
      expect(scheduled).toContain('PUBLISH AUTHORIZATION');
      expect(approvalRequired).toContain('PUBLISH AUTHORIZATION');
      // the two branches are mutually exclusive
      expect(scheduled).toContain('publishes without approval');
      expect(scheduled).not.toContain('requires approval before publishing');
      expect(approvalRequired).toContain('requires approval before publishing');
      expect(approvalRequired).not.toContain('publishes without approval');
      // and neither ever defers the decision back to the model
      expect(scheduled).not.toContain('apply your normal judgment');
      expect(approvalRequired).not.toContain('apply your normal judgment');
    });

    it('AUTHORIZED branch requires the tool the reported run skipped (review #15)', () => {
      expect(scheduled).toContain('publishing IS authorized for this run');
      expect(scheduled).toContain('CALL THE TOOL');
      expect(scheduled).toContain('twitter_manage_post to reply on X');
      expect(scheduled).toContain('post_on_connected_account');
      // the exact rationalisations session 0fe2e743 used, closed explicitly
      expect(scheduled).toContain('ALREADY SATISFIED');
      expect(scheduled).toContain('Neither is the run being scheduled or unattended');
      expect(scheduled).toContain('neither is the absence of a human to ask');
      // and reason (1) must be explicitly unavailable, so it cannot be misquoted
      expect(scheduled).toContain('Reason (1) above does NOT apply to this run');
    });

    it('APPROVAL-REQUIRED branch ends on the marker that stops the nudge loop', () => {
      // Without a terminal marker the withheld run's own honest wording reads as a
      // confirmation halt to the continuation classifier, which would nudge it to
      // keep going on a schedule whose owner asked it not to publish. The exact
      // string is load-bearing — scheduledRunWithheldPublish matches it.
      expect(approvalRequired).toContain('PUBLISH WITHHELD: this schedule requires approval before publishing.');
      expect(approvalRequired).toContain('Do NOT ask the owner a question');
      expect(approvalRequired).toContain('do NOT phrase the ending as waiting on their confirmation');
      // and the authorized branch must NOT carry it — it would end healthy runs early
      expect(scheduled).not.toContain('PUBLISH WITHHELD');
    });

    it('APPROVAL-REQUIRED branch is the reachable escape hatch (review #11)', () => {
      expect(approvalRequired).toContain('THIS BLOCK IS reason (1) above');
      expect(approvalRequired).toContain('Do NOT call any tool that publishes externally');
      expect(approvalRequired).toContain('twitter_manage_post');
      // draft-and-notify is a COMPLETE terminal state, not a failure to retry
      expect(approvalRequired).toContain('COMPLETE terminal state');
      expect(approvalRequired).toContain('It is not unfinished work');
      expect(approvalRequired).toContain('State it ONCE and stop');
    });

    it('APPROVAL-REQUIRED branch must not become the next fabricated gate', () => {
      // A legitimate block described as a platform gate just relaunches ENG-803's
      // fabrication in sanctioned clothing, so the accurate description is mandated.
      expect(approvalRequired).toContain('an account-level setting the owner chose, NOT a platform, X/Twitter, API, or credential gate');
      expect(approvalRequired).toContain('exactly the fabrication banned above');
    });

    it('names the setting exactly, and steers away from the wrong one', () => {
      // An unblocking instruction that points at a control which does not govern
      // publishing leaves the next run stuck in the same place — an earlier P1.
      expect(approvalRequired).toContain('turn OFF "Require approval before publishing"');
      expect(approvalRequired).toContain('Do NOT point them at "Full autonomy"');
      expect(approvalRequired).toContain('does NOT affect publishing');
    });

    it('AUTHORIZED is what an unresolved-but-readable schedule gets, so none stops publishing', () => {
      // The population fact behind this: 25 of 96 active schedules are
      // publishing-shaped. A default-deny would convert all of them to drafting-only,
      // trading a 1-in-62-session fabrication for 25 broken schedules. The resolver
      // (not this function) supplies `true` for every schedule without the opt-out.
      expect(getScheduledSessionOverride('scheduled', true)).toContain('publishes without approval');
    });

    // Greptile review #18 (security). `sessionType === 'scheduled'` says how the
    // session was CREATED, not that it is running unattended now: a user can open a
    // schedule-created session in the customer-portal sidebar and chat, and that
    // ATTENDED turn rebuilds this prompt through getEmmaSystemContext with no
    // resolved decision. Emitting the authorized branch there would order a live
    // publish past the owner's opt-out; emitting the withheld branch would assert a
    // gate the session may not be under. It must emit NEITHER.
    describe('attended turn (no resolved decision) carries no publish rules', () => {
      it('emits no PUBLISH AUTHORIZATION block of either polarity', () => {
        expect(attended).not.toContain('PUBLISH AUTHORIZATION');
        expect(attended).not.toContain('publishes without approval');
        expect(attended).not.toContain('requires approval before publishing');
        expect(attended).not.toContain('PUBLISH WITHHELD');
      });

      it('emits no unattended publish mandate — a human is present to ask', () => {
        expect(attended).not.toContain('NEVER SUBSTITUTE A DRAFT FOR A MANDATED ACTION');
        expect(attended).not.toContain('CALL THE TOOL');
        expect(attended).not.toContain('exactly TWO acceptable reasons');
      });

      it('still keeps the base override and the truthful-reporting rules', () => {
        // Inventing a gate is a lie in an attended session too, and the pre-existing
        // "do not suggest creating a schedule" override must survive untouched.
        expect(attended).toContain('This IS a scheduled automated session');
        expect(attended).toContain('NEVER suggest creating a schedule');
        expect(attended).toContain('NO FABRICATED PLATFORM OR PUBLISH GATE');
        expect(attended).toContain('you may NOT claim a gate exists');
        expect(attended).toContain('Derive your title and summary from actual tool-call outcomes');
      });

      it('drops the bullet that points at a block it does not emit', () => {
        // A dangling reference to a non-existent block is itself a small fabrication.
        expect(attended).not.toContain('The PUBLISH AUTHORIZATION block below');
      });
    });

    it('closes the three excuses the reported run actually used', () => {
      expect(scheduled).toContain('Your own caution is NOT a reason');
      expect(scheduled).toContain('"This run is scheduled/unattended" is NOT by itself a reason');
      expect(scheduled).toContain('A generic preference for human approval is NOT a reason');
    });

    it('requires an honest "nothing was posted" report WHENEVER an action is skipped', () => {
      for (const variant of [scheduled, approvalRequired]) {
        expect(variant).toContain('Whenever a mandated action is not performed');
        expect(variant).toContain('say plainly that nothing was posted/sent');
        expect(variant).toContain('give that specific real reason');
        expect(variant).toContain('surface the concrete unblocking action for the owner');
      }
    });
  });

  describe('the reporting rules bind on BOTH branches', () => {
    it('bans the fabricated gate regardless of how authorization resolved', () => {
      for (const variant of [scheduled, approvalRequired]) {
        expect(variant).toContain('NO FABRICATED PLATFORM OR PUBLISH GATE');
        expect(variant).toContain('you may NOT claim a gate exists');
        expect(variant).toContain('Derive your title and summary from actual tool-call outcomes');
        expect(variant).toContain('"queued"');
      }
    });
  });
});

/**
 * ENG-1245 — the withheld branch above unconditionally claimed "the owner has
 * turned ON Require approval before publishing" and told the run to instruct
 * the owner to turn it OFF. That is only true when `requirePublishApproval`
 * really is `true`. Schedule 1d001fba-0fb7-4bcd-80f6-6041b244a442 ("Harsha
 * Daily X Post (Autonomous)") has `requirePublishApproval: false` and has
 * posted nothing since 2026-08-13 (the day after PR #2263/ENG-827 deployed)
 * because it was simply never granted standing publish authorization — a
 * different condition the old text actively misdescribed, sending the owner
 * to toggle a switch that was already off and would change nothing.
 *
 * The third, optional `withholdReason` argument lets the caller (which reads
 * the schedule and can tell the two apart via
 * describePublishAuthorizationWithholdReason) select the accurate text. Every
 * call site that omits it — every test above — must keep behaving exactly as
 * before: that is the regression guard for the ENG-803 marker infra pinned in
 * this same file.
 */
describe('getScheduledSessionOverride — accurate withhold reason (ENG-1245)', () => {
  const genuineHold = getScheduledSessionOverride('scheduled', false, 'require_publish_approval');
  const neverGranted = getScheduledSessionOverride('scheduled', false, 'not_granted');
  const omittedReason = getScheduledSessionOverride('scheduled', false);

  it('omitting the reason behaves identically to the explicit genuine-hold branch (backward compatible default)', () => {
    expect(omittedReason).toBe(genuineHold);
  });

  it('the genuine-hold branch is unchanged: still names and blames "Require approval before publishing"', () => {
    expect(genuineHold).toContain('The owner has turned ON "Require approval before publishing"');
    expect(genuineHold).toContain('turn OFF "Require approval before publishing"');
  });

  it('the never-granted branch does NOT claim the owner turned on "Require approval before publishing", nor instruct turning it off as the fix', () => {
    expect(neverGranted).not.toContain('The owner has turned ON "Require approval before publishing"');
    // The genuine-hold branch's actual instruction to fix it this way — the never-granted
    // branch must not repeat this AFFIRMATIVE instruction (it may still mention the setting
    // by name to explicitly rule it out, the same way it already rules out "Full autonomy").
    expect(neverGranted).not.toContain('turn OFF "Require approval before publishing" in this schedule\'s settings, and the next run will post');
  });

  it('the never-granted branch tells the truth: that setting is not the blocker, and toggling it will not help', () => {
    expect(neverGranted).toContain('not been granted standing');
    expect(neverGranted).toContain('publish authorization');
    // Explicitly steers away from the wrong fix, the same way the genuine-hold
    // branch already steers away from "Full autonomy".
    expect(neverGranted).toMatch(/Require approval before publishing.*(is already off|not what|will not change|does not (govern|change))/i);
  });

  it('the never-granted branch ends on its OWN accurate terminal marker, not the genuine-hold one', () => {
    // ENG-1245: originally these had to stay byte-identical because
    // PUBLISH_WITHHELD_MARKER in agentModeController.ts only matched one string.
    // That regex now matches both variants (see scheduledPublishWithheldContinuation
    // .test.ts), so the marker can finally say the true reason instead of always
    // blaming "requires approval before publishing" on a schedule where that
    // specific setting was never touched.
    expect(neverGranted).toContain('PUBLISH WITHHELD: this schedule has not been granted standing publish authorization.');
    expect(neverGranted).not.toContain('PUBLISH WITHHELD: this schedule requires approval before publishing.');
    expect(genuineHold).toContain('PUBLISH WITHHELD: this schedule requires approval before publishing.');
  });

  it('the never-granted branch keeps every unconditional rule the genuine-hold branch has', () => {
    for (const text of ['THIS BLOCK IS reason (1) above', 'Do NOT call any tool that publishes externally',
      'twitter_manage_post', 'COMPLETE terminal state', 'It is not unfinished work', 'State it ONCE and stop',
      'Do NOT ask the owner a question', 'do NOT phrase the ending as waiting on their confirmation']) {
      expect(neverGranted).toContain(text);
    }
  });

  it('the AUTHORIZED branch ignores withholdReason entirely — it is only consulted on the withheld branch', () => {
    expect(getScheduledSessionOverride('scheduled', true, 'not_granted')).toBe(
      getScheduledSessionOverride('scheduled', true)
    );
  });
});
