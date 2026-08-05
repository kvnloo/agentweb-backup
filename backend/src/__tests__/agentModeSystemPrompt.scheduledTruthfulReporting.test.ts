/**
 * ENG-803 — the agent invented an "active X publishing gate" that no tool ever
 * returned, skipped twitter_manage_post entirely, and still titled the run
 * "Scheduled: Harsha X Reply Guy — Mentions (auto) — Replies queued" having
 * posted nothing (session 0fe2e743-6324-4720-af62-a8867464ecbb; also reported by
 * ruiw@ on session f0a09def).
 *
 * The two rules under test are REPORTING rules and carry no authorization of
 * their own — ENG-827 (PR #2263) owns whether a schedule may publish and emits
 * its own PUBLISH AUTHORIZATION block from getUnattendedExecutionDirective.
 * These assertions therefore pin the composition boundary as much as the text:
 * the block must ban the fabrication unconditionally, must defer to an
 * authorization block if one is present, and must never itself grant or withhold
 * permission to publish. A second publish flag here would contradict ENG-827.
 */

import { getScheduledSessionOverride } from '../docs/agentModeSystemPrompt';

describe('getScheduledSessionOverride — truthful execution reporting (ENG-803)', () => {
  const scheduled = getScheduledSessionOverride('scheduled');

  it('emits nothing at all for non-scheduled sessions', () => {
    // The rules are unattended-run rules; an interactive session has a human who
    // can be asked, so injecting a "you MUST call the tool" mandate there would
    // override the ordinary approval flow.
    expect(getScheduledSessionOverride('regular')).toBe('');
    expect(getScheduledSessionOverride(undefined)).toBe('');
    expect(getScheduledSessionOverride('slack')).toBe('');
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

    it('forbids restating an owner-set authorization block as a platform gate', () => {
      // The failure mode survives ENG-827: given a real PUBLISH AUTHORIZATION
      // block the model can still describe it as an "X publishing gate", which is
      // the same lie about the same run. Accuracy is required about that block too.
      expect(scheduled).toContain('PUBLISH AUTHORIZATION');
      expect(scheduled).toContain('a setting the owner chose on this schedule');
      expect(scheduled).toContain('never as a platform, X/Twitter, API, or credential gate');
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

    it('allows exactly two outs — an authorization block, or a real tool error', () => {
      expect(scheduled).toContain('exactly TWO acceptable reasons');
      expect(scheduled).toContain('an explicit authorization block in THIS system prompt');
      expect(scheduled).toContain('a tool call you ACTUALLY made returned an error');
      expect(scheduled).toContain('Nothing else qualifies');
    });

    // Greptile review #11 (P1, and an earlier P1 here in the opposite direction):
    // the two-outs rule's escape hatch is "quote the authorization block". On main
    // today NO such block exists — ENG-827 has not merged — so applying the mandate
    // to publishing would leave the escape hatch unreachable and resolve to
    // "publish anyway" on every scheduled run, with no owner control able to say
    // no. A gated rule whose escape branch cannot occur is not gated at all.
    it('carves external publishing OUT of the mandate and delegates it to the authorization block', () => {
      expect(scheduled).toContain('PUBLISHING EXTERNALLY');
      expect(scheduled).toContain('governed SOLELY by the PUBLISH AUTHORIZATION block');
      expect(scheduled).toContain('publish when it authorizes publishing, and draft-and-notify when it withholds');
      // the two-outs rule is explicitly scoped to everything else
      expect(scheduled).toContain('For every OTHER mandated action');
    });

    it('is an explicit NO-OP on publishing when no authorization block is present', () => {
      // Neither direction: it must not order publishing (that was Greptile #11), and
      // it must not withhold it either — a default-deny would silently convert the
      // ~25 active publishing-shaped schedules into drafting-only runs, which is the
      // regression an earlier revision of this fix shipped and had to reverse.
      expect(scheduled).toContain('neither grants you permission to publish nor removes any you already have');
      expect(scheduled).toContain('apply your normal judgment');
      // but truthfulness is NOT optional in that case — it is the whole ticket
      expect(scheduled).toContain('the reporting rules above still bind in full');
      expect(scheduled).toContain('never dress it up as a platform gate');
    });

    it('closes the three excuses the reported run actually used', () => {
      expect(scheduled).toContain('Your own caution is NOT a reason');
      expect(scheduled).toContain('"This run is scheduled/unattended" is NOT by itself a reason');
      expect(scheduled).toContain('A generic preference for human approval is NOT a reason');
    });

    it('requires an honest "nothing was posted" report WHENEVER an action is skipped', () => {
      // Deliberately unconditional — it binds on the carved-out publishing path too,
      // where the model keeps its judgment but not its licence to misdescribe.
      expect(scheduled).toContain('Whenever a mandated action is not performed');
      expect(scheduled).toContain('say plainly that nothing was posted/sent');
      expect(scheduled).toContain('give that specific real reason');
      expect(scheduled).toContain('surface the concrete unblocking action for the owner');
    });
  });

  describe('composition with ENG-827 (PR #2263) — no competing publish flag', () => {
    // ENG-827 resolves publish authorization deterministically from the schedule's
    // `autopublishAuthorized` consent flag and emits the PUBLISH AUTHORIZATION
    // block. If ENG-803 also asserted a permission state, the two would contradict
    // each other in whichever order they merge. This block must only ever DEFER.
    it('asserts no authorization state of its own', () => {
      expect(scheduled).not.toContain('PRE-AUTHORIZED to publish');
      expect(scheduled).not.toContain('NOT pre-authorized to publish');
      expect(scheduled).not.toContain('requirePublishApproval');
      expect(scheduled).not.toContain('Require approval before publishing');
    });

    it('does not order publishing, so a withheld ENG-827 run is never pushed to post', () => {
      // The delegation is what makes this safe in BOTH merge orders: with ENG-827's
      // withheld block present the model must draft-and-notify, with its authorized
      // block present the model must post, and with neither present this PR changes
      // nothing about publishing at all.
      expect(scheduled).not.toContain('CALL THE TOOL');
      expect(scheduled).not.toContain('publishing is authorized for this run');
      expect(scheduled).not.toContain('you MUST call');
    });
  });
});
