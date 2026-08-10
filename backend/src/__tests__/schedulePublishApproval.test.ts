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

describe('resolvePublishAuthorized (ENG-803)', () => {
  describe('absence means authorized — no existing schedule changes behaviour', () => {
    it('authorizes a legacy schedule that predates the field', () => {
      expect(resolvePublishAuthorized({})).toBe(true);
    });

    it('authorizes when the field is explicitly false', () => {
      expect(resolvePublishAuthorized({ requirePublishApproval: false })).toBe(true);
    });

  });

  describe('a missing RECORD is a different absence from a missing FIELD', () => {
    // Greptile review #16: conflating the two let a failed schedule read publish
    // straight past an owner who had explicitly opted out. The errors are not
    // symmetric — a public post cannot be withdrawn, while a withhold saves the
    // drafts and tells the owner — so an unverifiable state takes the recoverable
    // side. This does NOT re-introduce the opt-in regression: the 897 existing rows
    // are all "record present, field absent", which stays authorized above.
    it('withholds when there is no schedule record at all', () => {
      expect(resolvePublishAuthorized(null)).toBe(false);
      expect(resolvePublishAuthorized(undefined)).toBe(false);
    });

    it('still authorizes the read-but-unset case, so no existing schedule regresses', () => {
      expect(resolvePublishAuthorized({})).toBe(true);
    });
  });

  describe('only an explicit opt-out withholds', () => {
    it('withholds when the owner set requirePublishApproval', () => {
      expect(resolvePublishAuthorized({ requirePublishApproval: true })).toBe(false);
    });

    it('ignores truthy non-boolean values — strict === true only', () => {
      // A loosely-typed caller (or a stringly-typed DynamoDB round-trip) must not be
      // able to silence a schedule's publishing by accident.
      for (const value of ['true', 1, {}, [], 'yes']) {
        expect(resolvePublishAuthorized({ requirePublishApproval: value as any })).toBe(true);
      }
    });
  });

  describe('signals that must NEVER grant or withhold publishing', () => {
    // Each of these was tried and rejected on review. They are asserted here so a
    // future edit that starts honouring one fails loudly rather than silently
    // handing the model a way to authorize (or mute) its own publishing.
    it('ignores fullAutonomy — consent to decide unaided is not consent to post', () => {
      expect(resolvePublishAuthorized({ fullAutonomy: true } as any)).toBe(true);
      expect(resolvePublishAuthorized({ fullAutonomy: false } as any)).toBe(true);
    });

    it('ignores requiredFunctionCalls — it is MODEL-WRITABLE via manage_scheduled_chat', () => {
      expect(
        resolvePublishAuthorized({ requiredFunctionCalls: ['post_on_connected_account'] } as any)
      ).toBe(true);
      // and, critically, it cannot WITHHOLD either — the opt-out is the only lever
      expect(
        resolvePublishAuthorized({
          requiredFunctionCalls: [],
          requirePublishApproval: true,
        } as any)
      ).toBe(false);
    });

    it('ignores the schedule prompt text — authorization is never model-read', () => {
      expect(
        resolvePublishAuthorized({
          startingMessage: 'Do NOT post anything without asking me first.',
        } as any)
      ).toBe(true);
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
