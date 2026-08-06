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

import { resolvePublishAuthorized, extractScheduleId } from '../utils/schedulePublishApproval';

describe('resolvePublishAuthorized (ENG-803)', () => {
  describe('absence means authorized — no existing schedule changes behaviour', () => {
    it('authorizes a legacy schedule that predates the field', () => {
      expect(resolvePublishAuthorized({})).toBe(true);
    });

    it('authorizes when the field is explicitly false', () => {
      expect(resolvePublishAuthorized({ requirePublishApproval: false })).toBe(true);
    });

    it('authorizes when the schedule could not be read at all', () => {
      // A prompt-enrichment lookup that fails must degrade to the status quo, not
      // silently halt publishing for a schedule that works today.
      expect(resolvePublishAuthorized(null)).toBe(true);
      expect(resolvePublishAuthorized(undefined)).toBe(true);
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

  it('handles a full uuid', () => {
    expect(extractScheduleId('x|scheduleId:1c20ada1-f1b8-4bd6-a47f-ca79c5c985ff')).toBe(
      '1c20ada1-f1b8-4bd6-a47f-ca79c5c985ff'
    );
  });

  it('returns null for anything that is not a scheduled identifier', () => {
    // Every null case resolves to authorized upstream, so these are status-quo paths.
    expect(extractScheduleId(undefined)).toBeNull();
    expect(extractScheduleId(null)).toBeNull();
    expect(extractScheduleId('')).toBeNull();
    expect(extractScheduleId('/dashboard')).toBeNull();
    expect(extractScheduleId('scheduleId:')).toBeNull();
    expect(extractScheduleId(12345 as any)).toBeNull();
  });
});
