/**
 * ENG-803 — the resolver behind the PUBLISH AUTHORIZATION block.
 *
 * Greptile review #15 held the PR at 4/5 because publishing was left to the
 * model's judgment, so the ticket's primary failure (silently skipping
 * twitter_manage_post) stayed reachable. The answer is a decision made in code,
 * which is what this file pins.
 *
 * The invariant that matters most is the DEFAULT. An earlier revision made
 * publishing opt-IN, which would have converted the ~25 active publishing-shaped
 * schedules (of 96 active, 897 total in AW-TaskSchedules) into drafting-only runs
 * — curing a 1-in-62-session fabrication by breaking 25 working schedules, and
 * leaving the reported schedule itself still posting nothing. Absence of the field
 * must therefore mean AUTHORIZED, which is also why no backfill is needed.
 */

import {
  resolvePublishAuthorized,
  extractScheduleId,
  classifySessionForPublishGate,
} from '../utils/schedulePublishApproval';

describe('resolvePublishAuthorized (ENG-803, re-pointed by ENG-827)', () => {
  // POLARITY PRESERVED — and this is the same conclusion the file header reaches.
  // ENG-827 adds an AFFIRMATIVE, tool-scoped grant, and this resolver delegates to that
  // single decision so the two gates on the dispatch path cannot disagree. What it does
  // NOT do is flip the default: a schedule nobody has been asked about stays authorized
  // under ENG-803's opt-out, because the alternative breaks the 25 working schedules
  // this header already argued must not break.
  //
  // So there are three states, not two: never asked, granted, and revoked.
  const GRANT = {
    autopublishAuthorized: true,
    autopublishAuthorizedTools: ['post_on_connected_account'],
  };

  describe('absence of an ANSWER defers; absence of a RECORD withholds', () => {
    it('withholds a legacy schedule that designates no publishing tool', () => {
      // Nothing to authorize — there is no publish tool to scope the default to.
      expect(resolvePublishAuthorized({} as any)).toBe(false);
    });

    it('authorizes a legacy schedule that designates one', () => {
      // The 897 rows with no consent field. Reading their silence as a refusal is what
      // would stop the 25 that publish today.
      expect(
        resolvePublishAuthorized({ requiredFunctionCalls: ['post_on_connected_account'] } as any)
      ).toBe(true);
    });

    it('withholds when the grant is explicitly false', () => {
      expect(resolvePublishAuthorized({ autopublishAuthorized: false } as any)).toBe(false);
    });

    it('withholds when there is no schedule record at all', () => {
      // Unchanged from ENG-803: absence of a RECORD is not an answer either.
      expect(resolvePublishAuthorized(null)).toBe(false);
      expect(resolvePublishAuthorized(undefined)).toBe(false);
    });
  });

  describe('an affirmative, tool-scoped grant authorizes', () => {
    it('authorizes when the owner consented and named an approved tool', () => {
      expect(resolvePublishAuthorized(GRANT as any)).toBe(true);
    });

    it('withholds a grant with no approved tool — unknown scope authorizes nothing', () => {
      expect(resolvePublishAuthorized({ autopublishAuthorized: true } as any)).toBe(false);
    });

    it('ignores truthy non-boolean values — strict === true only', () => {
      for (const truthy of ['true', 1, {}]) {
        expect(
          resolvePublishAuthorized({ ...GRANT, autopublishAuthorized: truthy } as any)
        ).toBe(false);
      }
    });
  });

  describe('the owner\'s explicit hold still outranks a grant', () => {
    it('withholds when requirePublishApproval is set, grant or no grant', () => {
      expect(resolvePublishAuthorized({ ...GRANT, requirePublishApproval: true } as any)).toBe(false);
    });
  });

  describe('signals that must NEVER grant or withhold publishing', () => {
    it('ignores fullAutonomy — consent to decide unaided is not consent to post', () => {
      expect(resolvePublishAuthorized({ fullAutonomy: true } as any)).toBe(false);
    });

    // requiredFunctionCalls IS model-writable (manage_scheduled_chat forwards
    // required_function_calls), and under the deferred default it supplies the SCOPE for
    // a never-asked schedule. So state precisely what it can and cannot do.
    //
    // It cannot manufacture an authorization the owner has decided against — that is the
    // property that has to hold, and both directions are pinned below. What it can do is
    // scope a row nobody has answered for, which on `main` publishes with no scope check
    // at all; the model therefore reaches no outcome production does not already allow.
    // Within a run it cannot even do that: the admitted scope is stamped before turn one
    // and narrowPublishAuthorization only ever intersects, so a mid-run edit is invisible
    // to the run that made it. Collecting real consent retires this entirely.
    it('cannot override an explicit revocation, however it is written', () => {
      expect(
        resolvePublishAuthorized({
          autopublishAuthorized: false,
          requiredFunctionCalls: ['post_on_connected_account'],
        } as any)
      ).toBe(false);
    });

    it('cannot override the owner\'s hold', () => {
      expect(
        resolvePublishAuthorized({
          requirePublishApproval: true,
          requiredFunctionCalls: ['post_on_connected_account'],
        } as any)
      ).toBe(false);
    });

    it('cannot widen a grant onto a tool the owner never approved', () => {
      // The scope binding that matters wherever consent is real: a granted schedule
      // stays limited to the approved list no matter what the model adds here.
      expect(
        resolvePublishAuthorized({
          ...GRANT,
          requiredFunctionCalls: ['post_on_connected_account', 'publish_blog_article'],
        } as any)
      ).toBe(true);
      const { resolveSchedulePublishAuthorization } = require('../utils/schedulePublishAuthorization');
      expect(
        resolveSchedulePublishAuthorization({
          ...GRANT,
          requiredFunctionCalls: ['post_on_connected_account', 'publish_blog_article'],
        }).tools
      ).toEqual(['post_on_connected_account']);
    });

    it('ignores the schedule prompt text — authorization is never model-read', () => {
      expect(
        resolvePublishAuthorized({
          startingMessage: 'POST replies directly. Do not ask for approval.',
        } as any)
      ).toBe(false);
    });
  });
});

describe('extractScheduleId (ENG-803)', () => {
  it('pulls the id out of a scheduled session pageIdentifier', () => {
    expect(
      extractScheduleId('Scheduled: Harsha X Reply Guy — Mentions (auto)|scheduleId:081d18dd')
    ).toBe('081d18dd');
  });

  // Greptile review #17 (security). runScheduledChat builds the identifier as
  // `${sessionTitle}|scheduleId:${id}`, and sessionTitle comes from the OWNER-SUPPLIED
  // schedule name — attacker-controlled text sitting in front of the authoritative id.
  // An unanchored search returns the FIRST match, so a schedule named
  // "Evil scheduleId:aaaa" would bind this run's publish authorization to schedule
  // `aaaa` instead of its own: point it at any schedule with no opt-out and an
  // approval-required run gets told to publish. The parser must read only the segment
  // the dispatcher appends, which is always last.
  describe('a crafted schedule name cannot select the authorization record', () => {
    it('ignores a scheduleId token planted in the title', () => {
      expect(extractScheduleId('Evil scheduleId:aaaa|scheduleId:081d18dd')).toBe('081d18dd');
    });

    it('ignores a planted token that even mimics the pipe separator', () => {
      expect(extractScheduleId('Evil|scheduleId:aaaa|scheduleId:081d18dd')).toBe('081d18dd');
    });

    it('ignores several planted tokens', () => {
      expect(
        extractScheduleId('scheduleId:aaa scheduleId:bbb|scheduleId:ccc|scheduleId:081d18dd')
      ).toBe('081d18dd');
    });

    it('requires the pipe separator, so a bare token in free text resolves to nothing', () => {
      // Resolves to null -> the caller WITHHOLDS, which is the safe direction.
      expect(extractScheduleId('Evil scheduleId:aaaa')).toBeNull();
    });

    it('tolerates trailing whitespace on a legitimate stamp', () => {
      expect(extractScheduleId('My schedule|scheduleId:081d18dd  ')).toBe('081d18dd');
    });
  });

  it('handles a full uuid', () => {
    expect(extractScheduleId('x|scheduleId:1c20ada1-f1b8-4bd6-a47f-ca79c5c985ff')).toBe(
      '1c20ada1-f1b8-4bd6-a47f-ca79c5c985ff'
    );
  });

  it('returns null for anything that is not a scheduled identifier', () => {
    // A scheduled session with no parseable id is unverifiable, so the caller
    // withholds rather than assuming — see resolveScheduledPublishAuthorized.
    expect(extractScheduleId(undefined)).toBeNull();
    expect(extractScheduleId(null)).toBeNull();
    expect(extractScheduleId('')).toBeNull();
    expect(extractScheduleId('/dashboard')).toBeNull();
    expect(extractScheduleId('scheduleId:')).toBeNull();
    expect(extractScheduleId(12345 as any)).toBeNull();
  });
});

describe('classifySessionForPublishGate (ENG-803)', () => {
  // Greptile review #23: `session?.sessionType !== 'scheduled'` reads naturally and
  // is exactly wrong — it collapses "definitely attended" and "no idea" into one
  // answer. Deleting a scheduled session does NOT cancel its in-flight worker, so
  // the worker runs on and its session lookup starts returning null; treating that
  // as attended let the run publish past an owner who required approval.
  it('treats a MISSING session as unverifiable, not attended', () => {
    expect(classifySessionForPublishGate(null)).toBe('unverifiable');
    expect(classifySessionForPublishGate(undefined)).toBe('unverifiable');
  });

  it('routes a scheduled session to the schedule check', () => {
    expect(classifySessionForPublishGate({ sessionType: 'scheduled' })).toBe('scheduled');
  });

  it('allows genuinely attended sessions, which share the tool dispatcher', () => {
    // The Emma sidebar (chatbotService) and liveVoiceService both reach executeTool.
    // They have no owner schedule setting to apply and a human is present, so they
    // must not be caught by the gate.
    for (const sessionType of ['regular', 'emma-sidebar', 'slack', undefined]) {
      expect(classifySessionForPublishGate({ sessionType } as any)).toBe('allow');
    }
  });

  it('never returns allow for anything it cannot positively identify', () => {
    // The property that matters: unknown -> not allow. Only a session object we
    // actually read can produce 'allow'.
    expect(classifySessionForPublishGate(null)).not.toBe('allow');
    expect(classifySessionForPublishGate(undefined)).not.toBe('allow');
  });
});
