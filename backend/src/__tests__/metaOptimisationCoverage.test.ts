/**
 * ENG-926 §G Tier 1 — bidding toward an event the pixel never receives.
 *
 * Every fixture here is a real shape observed on a production ad account on 2026-08-16.
 * The Haven case is the one that cost money: `COMPLETE_REGISTRATION` went dark when a
 * deprecated tracking wrapper was removed, nothing errored, and two live ad sets spent 8+
 * days bidding toward an event that no longer arrived.
 */

import {
  evaluateOptimisationCoverage,
  evaluateAccountOptimisationCoverage,
  countTrailingAbsentSpendingDays,
  META_EVENT_BY_OPTIMISATION,
  INSIGHTS_FAMILY_BY_OPTIMISATION,
  IGNORED_OPTIMISATIONS,
  OPTIMISATION_ABSENCE_DAYS,
  ATTRIBUTION_SETTLE_DAYS,
  OPTIMISATION_RECENCY_DAYS,
  newestSpendingDay,
} from '../services/metaOptimisationCoverage';

const adSet = (o: Partial<any> = {}) => ({
  id: 'as_1',
  name: 'Test Ad Set',
  effective_status: 'ACTIVE',
  optimization_goal: 'OFFSITE_CONVERSIONS',
  promoted_object: { custom_event_type: 'LEAD', pixel_id: 'px1' },
  ...o,
});

describe('META_EVENT_BY_OPTIMISATION', () => {
  it('translates between Meta\'s TWO vocabularies, which do not match', () => {
    // The whole point: promoted_object says COMPLETE_REGISTRATION, the pixel reports
    // CompleteRegistration. Comparing them untranslated gives a wrong answer either way.
    expect(META_EVENT_BY_OPTIMISATION.COMPLETE_REGISTRATION).toBe('CompleteRegistration');
    expect(META_EVENT_BY_OPTIMISATION.LEAD).toBe('Lead');
    expect(META_EVENT_BY_OPTIMISATION.START_TRIAL).toBe('StartTrial');
    expect(META_EVENT_BY_OPTIMISATION.INITIATED_CHECKOUT).toBe('InitiateCheckout');
    expect(META_EVENT_BY_OPTIMISATION.CONTENT_VIEW).toBe('ViewContent');
  });
});

describe('evaluateOptimisationCoverage', () => {
  it('flags the Haven case — live ad sets bidding on an event that stopped arriving', () => {
    const v = evaluateOptimisationCoverage(
      [
        adSet({ id: 'as_cr', name: 'Haven — Registrations', promoted_object: { custom_event_type: 'COMPLETE_REGISTRATION', pixel_id: '646256265203090' } }),
        adSet({ id: 'as_lead', promoted_object: { custom_event_type: 'LEAD', pixel_id: '646256265203090' } }),
      ],
      ['PageView', 'Lead'], // exactly what Haven's pixel reported after the wrapper was removed
    );

    expect(v.mismatches).toHaveLength(1);
    expect(v.mismatches[0]).toMatchObject({
      adSetId: 'as_cr',
      optimisationEvent: 'COMPLETE_REGISTRATION',
      expectedEventName: 'CompleteRegistration',
      pixelId: '646256265203090',
    });
    expect(v.inconclusive).toBe(false);
  });

  it('stays silent when every optimised event is arriving', () => {
    const v = evaluateOptimisationCoverage([adSet()], ['PageView', 'Lead', 'scroll']);
    expect(v.mismatches).toEqual([]);
    expect(v.dormantMismatches).toEqual([]);
  });

  it('separates a PAUSED mismatch as latent — it costs nothing until someone resumes it', () => {
    // AgentWeb's own account, observed 2026-08-16: a START_TRIAL ad set whose pixel has
    // never reported StartTrial. Harmless while paused; burns money the moment it is not.
    const v = evaluateOptimisationCoverage(
      [adSet({ id: 'as_st', name: 'Marketing Leaders', effective_status: 'PAUSED', promoted_object: { custom_event_type: 'START_TRIAL', pixel_id: '1430870751246428' } })],
      ['PageView', 'scroll', 'Lead', 'form_start', 'click'],
    );

    expect(v.mismatches).toEqual([]);
    expect(v.dormantMismatches).toHaveLength(1);
    expect(v.dormantMismatches[0].expectedEventName).toBe('StartTrial');
  });

  it('treats CAMPAIGN_PAUSED as not delivering', () => {
    const v = evaluateOptimisationCoverage(
      [adSet({ effective_status: 'CAMPAIGN_PAUSED', promoted_object: { custom_event_type: 'PURCHASE' } })],
      ['PageView'],
    );
    expect(v.mismatches).toEqual([]);
    expect(v.dormantMismatches).toHaveLength(1);
  });

  it('is INCONCLUSIVE when the pixel reported nothing at all', () => {
    // A dormant pixel cannot testify about what it is missing. Treating "no data" as
    // "nothing arrives" would manufacture a mismatch for every ad set on the account —
    // the §F objective-filter mistake, in a different signal.
    const v = evaluateOptimisationCoverage([adSet({ promoted_object: { custom_event_type: 'PURCHASE' } })], []);
    expect(v.inconclusive).toBe(true);
    expect(v.mismatches).toEqual([]);
  });

  it('reports an untranslatable optimisation type instead of asserting a mismatch', () => {
    // Meta adds optimisation types over time. Claiming a pixel is missing an event we
    // cannot even name is the confidently-wrong diagnosis §F's review rounds warned about.
    const v = evaluateOptimisationCoverage(
      [adSet({ promoted_object: { custom_event_type: 'SOME_NEW_2027_EVENT' } })],
      ['PageView', 'Lead'],
    );
    expect(v.mismatches).toEqual([]);
    expect(v.unrecognisedOptimisations).toEqual(['SOME_NEW_2027_EVENT']);
  });

  it('ignores ad sets with no promoted event at all', () => {
    // Reach / traffic / engagement goals promote nothing — there is no claim to make.
    const v = evaluateOptimisationCoverage(
      [
        adSet({ optimization_goal: 'LANDING_PAGE_VIEWS', promoted_object: null }),
        adSet({ optimization_goal: 'POST_ENGAGEMENT', promoted_object: {} }),
      ],
      ['PageView'],
    );
    expect(v.mismatches).toEqual([]);
    expect(v.unrecognisedOptimisations).toEqual([]);
  });

  it('is case and whitespace insensitive on both sides', () => {
    const v = evaluateOptimisationCoverage(
      [adSet({ promoted_object: { custom_event_type: '  complete_registration ' } })],
      ['  CompleteRegistration  '],
    );
    expect(v.mismatches).toEqual([]);
  });

  it('de-duplicates the unrecognised names it reports', () => {
    const v = evaluateOptimisationCoverage(
      [adSet({ promoted_object: { custom_event_type: 'MYSTERY' } }), adSet({ promoted_object: { custom_event_type: 'MYSTERY' } })],
      ['PageView'],
    );
    expect(v.unrecognisedOptimisations).toEqual(['MYSTERY']);
  });

  it('survives malformed rows without poisoning the verdict', () => {
    const v = evaluateOptimisationCoverage(
      [null as any, undefined as any, {} as any, adSet({ promoted_object: { custom_event_type: 'COMPLETE_REGISTRATION' } })],
      ['PageView', 'Lead'],
    );
    expect(v.mismatches).toHaveLength(1);
  });

  it('returns an empty verdict for an account with no ad sets, NOT inconclusive', () => {
    // Nothing to judge is a different state from cannot judge.
    const v = evaluateOptimisationCoverage([], []);
    expect(v).toEqual({ mismatches: [], dormantMismatches: [], unrecognisedOptimisations: [], inconclusive: false });
  });

  it('ignores blank and non-string entries in the received set', () => {
    const v = evaluateOptimisationCoverage(
      [adSet()],
      ['Lead', '', '   ', null as any, 42 as any],
    );
    expect(v.mismatches).toEqual([]);
    expect(v.inconclusive).toBe(false);
  });
});

/**
 * ENG-926 §G Tier 1, second half — the ALERT gate.
 *
 * Everything below was designed against production reads taken 2026-08-17, after the
 * first half was written. Two of those reads invalidated the original design:
 *
 *   1. `/stats?aggregation=event` serves ~24 HOURS and nothing more. Verified on three
 *      pixels with two tokens: `limit=200` still returns 23 buckets, and following
 *      `paging.next` returns zero rows. There is no history to ask for.
 *   2. Haven's `CompleteRegistration` — the event this whole check exists for — arrived in
 *      exactly ONE of 23 hourly buckets. On a once-a-day conversion, a 24h window is a coin
 *      flip, and a detector that alerts on one toss would have cried wolf on a pixel that
 *      was working.
 *
 * So the pixel read cannot be the trigger. It is the corroborating signal, and the trigger
 * is a streak of spending days with no attributed conversion of that family — the same
 * evidence rule `evaluateAdAccountDays` already uses for blackouts.
 */

/** Haven's REAL pixel-attributed complete_registration by day, act_1842363582956923,
 *  read 2026-08-17. The wrapper was removed on 08-05 and PR #12 restored it on 08-16.
 *  Note 08-11 and 08-12: the outage was a RATE COLLAPSE, not a clean zero, which is why a
 *  streak measured from the most recent day is the only rule that survives contact. */
const HAVEN_DAYS = [
  { date: '2026-08-05', spend: 205.16, families: ['lead', 'complete_registration'] },
  { date: '2026-08-06', spend: 223.93, families: ['lead'] },
  { date: '2026-08-07', spend: 229.62, families: ['lead'] },
  { date: '2026-08-08', spend: 214.85, families: ['lead'] },
  { date: '2026-08-09', spend: 250.85, families: ['lead'] },
  { date: '2026-08-10', spend: 190.40, families: ['lead'] },
  { date: '2026-08-11', spend: 247.95, families: ['lead', 'complete_registration'] },
  { date: '2026-08-12', spend: 159.20, families: ['lead', 'complete_registration'] },
  { date: '2026-08-13', spend: 82.25, families: [] },
  { date: '2026-08-14', spend: 86.85, families: [] },
  { date: '2026-08-15', spend: 96.32, families: ['lead'] },
];

const havenAdSet = (status = 'ACTIVE') => ({
  id: 'as_haven_cr',
  name: 'Maintenance Triage – Cold Prospecting',
  effective_status: status,
  optimization_goal: 'OFFSITE_CONVERSIONS',
  promoted_object: { custom_event_type: 'COMPLETE_REGISTRATION', pixel_id: '646256265203090' },
});

describe('INSIGHTS_FAMILY_BY_OPTIMISATION', () => {
  it('maps to the THIRD vocabulary — insights action families, not pixel event names', () => {
    // promoted_object says COMPLETE_REGISTRATION, the pixel reports CompleteRegistration,
    // and insights reports complete_registration. Three spellings of one conversion.
    expect(INSIGHTS_FAMILY_BY_OPTIMISATION.COMPLETE_REGISTRATION).toBe('complete_registration');
    expect(INSIGHTS_FAMILY_BY_OPTIMISATION.INITIATED_CHECKOUT).toBe('initiate_checkout');
    expect(INSIGHTS_FAMILY_BY_OPTIMISATION.START_TRIAL).toBe('start_trial');
  });

  it('omits optimisations §F cannot count, so they can never be alerted on', () => {
    // countAttributedConversions has no family for these. Without a countable family there
    // is no streak, so there is no evidence — and no evidence must mean no alert, not a
    // silently missing gate.
    expect(INSIGHTS_FAMILY_BY_OPTIMISATION.CONTENT_VIEW).toBeUndefined();
    expect(INSIGHTS_FAMILY_BY_OPTIMISATION.SEARCH).toBeUndefined();
  });
});

describe('IGNORED_OPTIMISATIONS', () => {
  it('skips OTHER — it is a real production value meaning "custom conversion"', () => {
    // Haven runs several. Reporting it as unrecognised would put the same name in every
    // sweep's output forever, which is how a diagnostic becomes something people filter out.
    expect(IGNORED_OPTIMISATIONS.has('OTHER')).toBe(true);
  });
});

describe('countTrailingAbsentSpendingDays', () => {
  it('counts back from the most recent day, not the worst run in the window', () => {
    // Haven on 08-15: 13th, 14th and 15th all spent with no complete_registration.
    expect(countTrailingAbsentSpendingDays(HAVEN_DAYS, 'complete_registration')).toBe(3);
  });

  it('returns 0 when the most recent spending day carries the family', () => {
    expect(countTrailingAbsentSpendingDays(HAVEN_DAYS, 'lead')).toBe(0); // 08-15 carried lead
    expect(countTrailingAbsentSpendingDays(HAVEN_DAYS.slice(0, 8), 'complete_registration')).toBe(0);
  });

  it('excludes zero-spend days from the evidence AND lets them not break a streak', () => {
    // Same rule evaluateAdAccountDays uses: a paused weekend is not proof of anything, and
    // an outage that spans one is still one outage.
    const days = [
      { date: '1', spend: 100, families: [] as string[] },
      { date: '2', spend: 0, families: [] as string[] },
      { date: '3', spend: 100, families: [] as string[] },
    ];
    expect(countTrailingAbsentSpendingDays(days, 'lead')).toBe(2);
  });

  it('is 0 for an account that never spent — absence during no delivery proves nothing', () => {
    expect(countTrailingAbsentSpendingDays(
      [{ date: '1', spend: 0, families: [] }], 'lead',
    )).toBe(0);
  });

  it('survives malformed rows', () => {
    expect(countTrailingAbsentSpendingDays(null as any, 'lead')).toBe(0);
    expect(countTrailingAbsentSpendingDays([null as any, undefined as any], 'lead')).toBe(0);
  });
});

describe('evaluateAccountOptimisationCoverage', () => {
  it('WOULD HAVE CAUGHT HAVEN on 2026-08-08 — five days before a human did', () => {
    const v = evaluateAccountOptimisationCoverage(
      [havenAdSet()],
      { '646256265203090': ['PageView', 'Lead'] },   // what the pixel reported while dark
      { as_haven_cr: HAVEN_DAYS.slice(0, 5) },       // through 08-09; newest is dropped as unsettled
    );

    expect(v.alerting).toHaveLength(1);
    expect(v.alerting[0]).toMatchObject({
      optimisationEvent: 'COMPLETE_REGISTRATION',
      expectedEventName: 'CompleteRegistration',
      insightsFamily: 'complete_registration',
      pixelId: '646256265203090',
      consecutiveAbsentSpendingDays: 3,
    });
  });

  it('STAYS SILENT TODAY — the pixel receives CompleteRegistration again since PR #12', () => {
    const v = evaluateAccountOptimisationCoverage(
      [havenAdSet()],
      { '646256265203090': ['PageView', 'Lead', 'CompleteRegistration'] },
      { as_haven_cr: HAVEN_DAYS },
    );
    expect(v.alerting).toEqual([]);
    expect(v.unconfirmed).toEqual([]);
  });

  it('does NOT alert on the two live days mid-outage — the streak resets, as it must', () => {
    // 08-11 and 08-12 both carried a complete_registration. A detector that ignored them
    // would be asserting an outage the account's own data contradicts on those days.
    const v = evaluateAccountOptimisationCoverage(
      [havenAdSet()],
      { '646256265203090': ['PageView', 'Lead'] },
      { as_haven_cr: HAVEN_DAYS.slice(0, 8) }, // through 08-12
    );
    expect(v.alerting).toEqual([]);
    expect(v.unconfirmed).toHaveLength(1); // pixel silent, but insights contradict — log it
  });

  it('SUPPRESSES the low-volume false positive — quiet 24h, but it converted this week', () => {
    // The form_start class, observed directly: present in one read, absent in the next, with
    // nothing broken. This is the case that killed the pixel-only design.
    const v = evaluateAccountOptimisationCoverage(
      [havenAdSet()],
      { '646256265203090': ['PageView'] },     // no Lead, no CompleteRegistration in 24h
      { as_haven_cr: [{ date: '2026-08-15', spend: 96.32, families: ['complete_registration'] }] },
    );
    expect(v.alerting).toEqual([]);
    expect(v.unconfirmed).toHaveLength(1);
  });

  it('judges each pixel SEPARATELY — Haven really does run three', () => {
    // A conversion arriving on pixel A says nothing about pixel B. Unioning the event sets
    // would let a busy pixel vouch for a dead one on the same account.
    const v = evaluateAccountOptimisationCoverage(
      [
        { ...havenAdSet(), id: 'as_a', promoted_object: { custom_event_type: 'LEAD', pixel_id: 'pix_a' } },
        { ...havenAdSet(), id: 'as_b', promoted_object: { custom_event_type: 'LEAD', pixel_id: 'pix_b' } },
      ],
      { pix_a: ['PageView', 'Lead'], pix_b: ['PageView'] },
      {
        as_a: [{ date: '1', spend: 50, families: ['lead'] }],
        as_b: [
          { date: '1', spend: 50, families: [] },
          { date: '2', spend: 50, families: [] },
          { date: '3', spend: 50, families: [] },
          { date: '4', spend: 50, families: [] },
        ],
      },
    );
    expect(v.alerting).toHaveLength(1);
    expect(v.alerting[0].adSetId).toBe('as_b');
  });

  it('reports a PAUSED mismatch as dormant and never alerts on it', () => {
    // AgentWeb's START_TRIAL ad set, still paused as of 2026-08-17. Costs nothing today.
    const v = evaluateAccountOptimisationCoverage(
      [{
        id: 'as_st', name: 'Marketing Leaders', effective_status: 'PAUSED',
        promoted_object: { custom_event_type: 'START_TRIAL', pixel_id: '1430870751246428' },
      }],
      { '1430870751246428': ['PageView', 'Lead', 'scroll', 'click'] },
      { as_st: [{ date: '1', spend: 50, families: [] }, { date: '2', spend: 50, families: [] },
                { date: '3', spend: 50, families: [] }] },
    );
    expect(v.alerting).toEqual([]);
    expect(v.dormant).toHaveLength(1);
    expect(v.dormant[0].expectedEventName).toBe('StartTrial');
  });

  it('never alerts on an optimisation §F cannot count — no family, no evidence', () => {
    const v = evaluateAccountOptimisationCoverage(
      [{
        id: 'as_vc', effective_status: 'ACTIVE',
        promoted_object: { custom_event_type: 'CONTENT_VIEW', pixel_id: 'pix_a' },
      }],
      { pix_a: ['PageView'] },
      { as_vc: [{ date: '1', spend: 50, families: [] }, { date: '2', spend: 50, families: [] },
                { date: '3', spend: 50, families: [] }] },
    );
    expect(v.alerting).toEqual([]);
    expect(v.unconfirmable).toHaveLength(1);
  });

  it('skips OTHER entirely rather than reporting it as unrecognised', () => {
    const v = evaluateAccountOptimisationCoverage(
      [{ id: 'as_o', effective_status: 'ACTIVE', promoted_object: { custom_event_type: 'OTHER', pixel_id: 'pix_a' } }],
      { pix_a: ['PageView'] },
      { as_o: [{ date: '1', spend: 50, families: [] }] },
    );
    expect(v.unrecognisedOptimisations).toEqual([]);
    expect(v.alerting).toEqual([]);
    expect(v.unconfirmable).toEqual([]);
  });

  it('marks a pixel INCONCLUSIVE when it reported nothing, and never alerts on it', () => {
    const v = evaluateAccountOptimisationCoverage(
      [havenAdSet()],
      { '646256265203090': [] },
      { as_haven_cr: HAVEN_DAYS.slice(0, 5) },
    );
    expect(v.alerting).toEqual([]);
    expect(v.inconclusivePixels).toEqual(['646256265203090']);
  });

  it('treats an ad set with no resolvable pixel as unjudgeable, not as a mismatch', () => {
    const v = evaluateAccountOptimisationCoverage(
      [{ id: 'as_np', effective_status: 'ACTIVE', promoted_object: { custom_event_type: 'LEAD' } }],
      {},
      { as_np: [{ date: '1', spend: 50, families: [] }] },
    );
    expect(v.alerting).toEqual([]);
    expect(v.unconfirmable).toHaveLength(1);
  });

  it('requires the FULL streak — two absent spending days is not enough', () => {
    expect(OPTIMISATION_ABSENCE_DAYS).toBe(3);
    const v = evaluateAccountOptimisationCoverage(
      [havenAdSet()],
      { '646256265203090': ['PageView', 'Lead'] },
      { as_haven_cr: HAVEN_DAYS.slice(0, 3) }, // 08-05..08-07 → only 2 absent days trailing
    );
    expect(v.alerting).toEqual([]);
    expect(v.unconfirmed).toHaveLength(1);
  });

  it('returns an empty verdict for an account with no ad sets', () => {
    const v = evaluateAccountOptimisationCoverage([], {}, {});
    expect(v.alerting).toEqual([]);
    expect(v.dormant).toEqual([]);
    expect(v.unconfirmed).toEqual([]);
    expect(v.unconfirmable).toEqual([]);
    expect(v.inconclusivePixels).toEqual([]);
  });

  it('survives malformed input without throwing', () => {
    expect(() => evaluateAccountOptimisationCoverage(null as any, null as any, null as any)).not.toThrow();
    const v = evaluateAccountOptimisationCoverage([null as any, {} as any], {}, {});
    expect(v.alerting).toEqual([]);
  });
});

describe('evaluateAccountOptimisationCoverage — the defensive paths', () => {
  const spend1 = [{ date: '1', spend: 50, families: [] as string[] }];
  const days = { a: spend1, b: spend1, c: spend1, d: spend1, as_o: spend1 };

  it('reports an untranslatable optimisation on a DELIVERING ad set', () => {
    const v = evaluateAccountOptimisationCoverage(
      [{ id: 'a', effective_status: 'ACTIVE', promoted_object: { custom_event_type: 'SOME_2027_EVENT', pixel_id: 'p' } }],
      { p: ['PageView'] }, days,
    );
    expect(v.unrecognisedOptimisations).toEqual(['SOME_2027_EVENT']);
    expect(v.alerting).toEqual([]);
  });

  it('stays quiet about an untranslatable optimisation on a PAUSED ad set', () => {
    // Nobody is spending on it, so naming it is noise rather than a lead to follow.
    const v = evaluateAccountOptimisationCoverage(
      [{ id: 'a', effective_status: 'PAUSED', promoted_object: { custom_event_type: 'SOME_2027_EVENT', pixel_id: 'p' } }],
      { p: ['PageView'] }, days,
    );
    expect(v.unrecognisedOptimisations).toEqual([]);
  });

  it('ignores ad sets that promote nothing, in every shape', () => {
    const v = evaluateAccountOptimisationCoverage(
      [
        { id: 'a', effective_status: 'ACTIVE', promoted_object: null },
        { id: 'b', effective_status: 'ACTIVE', promoted_object: {} },
        { id: 'c', effective_status: 'ACTIVE', promoted_object: { custom_event_type: '   ' } },
        { id: 'd', effective_status: 'ACTIVE', promoted_object: { custom_event_type: 42 as any } },
      ],
      { p: ['PageView'] }, days,
    );
    expect(v).toMatchObject({ alerting: [], dormant: [], unconfirmable: [], unrecognisedOptimisations: [] });
  });

  it('treats a blank or non-string pixel id as no pixel at all', () => {
    const v = evaluateAccountOptimisationCoverage(
      [
        { id: 'a', effective_status: 'ACTIVE', promoted_object: { custom_event_type: 'LEAD', pixel_id: '  ' } },
        { id: 'b', effective_status: 'ACTIVE', promoted_object: { custom_event_type: 'LEAD', pixel_id: 7 as any } },
      ],
      {}, days,
    );
    expect(v.unconfirmable).toHaveLength(2);
    expect(v.alerting).toEqual([]);
  });

  it('treats a missing effective_status as not delivering', () => {
    // Absent status must never be read as ACTIVE: that would alert on an ad set we cannot
    // show is spending anything.
    const v = evaluateAccountOptimisationCoverage(
      [{ id: 'a', promoted_object: { custom_event_type: 'LEAD', pixel_id: 'p' } }],
      { p: ['PageView'] },
      { a: [{ date: '1', spend: 50, families: [] }, { date: '2', spend: 50, families: [] },
            { date: '3', spend: 50, families: [] }] },
    );
    expect(v.alerting).toEqual([]);
    expect(v.dormant).toHaveLength(1);
  });

  it('is case and whitespace insensitive on the optimisation and the event set', () => {
    const v = evaluateAccountOptimisationCoverage(
      [{ id: 'a', effective_status: 'active', promoted_object: { custom_event_type: ' complete_registration ', pixel_id: 'p' } }],
      { p: ['  CompleteRegistration  '] }, days,
    );
    expect(v.alerting).toEqual([]);
    expect(v.unconfirmed).toEqual([]);
  });

  it('ignores blank and non-string entries in a pixel event list', () => {
    const v = evaluateAccountOptimisationCoverage(
      [{ id: 'a', effective_status: 'ACTIVE', promoted_object: { custom_event_type: 'LEAD', pixel_id: 'p' } }],
      { p: ['', '   ', null as any, 42 as any] },
      days,
    );
    // Every entry was junk, so the pixel said nothing usable — inconclusive, not a mismatch.
    expect(v.inconclusivePixels).toEqual(['p']);
    expect(v.alerting).toEqual([]);
  });

  it('reads each pixel once even when many ad sets share it', () => {
    const v = evaluateAccountOptimisationCoverage(
      [
        { id: 'a', effective_status: 'ACTIVE', promoted_object: { custom_event_type: 'LEAD', pixel_id: 'p' } },
        { id: 'b', effective_status: 'ACTIVE', promoted_object: { custom_event_type: 'PURCHASE', pixel_id: 'p' } },
      ],
      { p: [] },
      days,
    );
    expect(v.inconclusivePixels).toEqual(['p']); // deduplicated, not ['p','p']
  });

  it('matches family NAMES case-insensitively, ignoring unusable entries', () => {
    // This function reads names only — it never inspects a count. The "present with a
    // positive value" rule lives upstream in countAttributedConversions, which drops
    // zero-valued action rows before a family reaches this array. Naming that rule here
    // would describe a filter this code does not contain.
    expect(countTrailingAbsentSpendingDays(
      [{ date: '1', spend: 10, families: ['LEAD'] }], 'lead',
    )).toBe(0);
    expect(countTrailingAbsentSpendingDays(
      [{ date: '1', spend: 10, families: [null as any, 7 as any] }], 'lead',
    )).toBe(1);
    expect(countTrailingAbsentSpendingDays(
      [{ date: '1', spend: 10, families: null as any }], 'lead',
    )).toBe(1);
  });

  it('treats a negative or non-numeric spend as no delivery', () => {
    expect(countTrailingAbsentSpendingDays(
      [{ date: '1', spend: -5, families: [] }, { date: '2', spend: 'x' as any, families: [] }], 'lead',
    )).toBe(0);
  });
});

/**
 * The two P1s Greptile found on the first version of this check. Both came from the same
 * mistake: the evidence was scoped to the ACCOUNT while the claim was about one ad set.
 * They fail in opposite directions, which is why both need a test.
 */
describe('evaluateAccountOptimisationCoverage — evidence must belong to the ad set it accuses', () => {
  it('a HEALTHY SIBLING PIXEL must not suppress a dead pixel on the same account', () => {
    // Haven really does run three pixels. With account-wide families, pixel B's `lead`
    // conversions landed in the same daily record as pixel A's and broke A's absence
    // streak — silently hiding the exact outage this check exists to find.
    const v = evaluateAccountOptimisationCoverage(
      [
        { id: 'as_dead', name: 'On the dead pixel', effective_status: 'ACTIVE',
          promoted_object: { custom_event_type: 'LEAD', pixel_id: 'pix_dead' } },
        { id: 'as_live', name: 'On the healthy pixel', effective_status: 'ACTIVE',
          promoted_object: { custom_event_type: 'LEAD', pixel_id: 'pix_live' } },
      ],
      { pix_dead: ['PageView'], pix_live: ['PageView', 'Lead'] },
      {
        // The dead pixel's ad set: spending, converting nothing.
        as_dead: [
          { date: '1', spend: 100, families: [] },
          { date: '2', spend: 100, families: [] },
          { date: '3', spend: 100, families: [] },
          { date: '4', spend: 100, families: [] },
        ],
        // The healthy one, converting throughout. Must not vouch for the other.
        as_live: [
          { date: '1', spend: 100, families: ['lead'] },
          { date: '2', spend: 100, families: ['lead'] },
          { date: '3', spend: 100, families: ['lead'] },
          { date: '4', spend: 100, families: ['lead'] },
        ],
      },
    );

    expect(v.alerting).toHaveLength(1);
    expect(v.alerting[0].adSetId).toBe('as_dead');
    expect(v.alerting[0].pixelId).toBe('pix_dead');
  });

  it('an ACTIVE ad set that DID NOT DELIVER must never be accused of paying', () => {
    // ACTIVE is a configuration, not evidence of spend. With account-wide spend, an ad set
    // with no delivery inherited its siblings' three spending days and produced a
    // high-priority alert saying it was paying for an event it was not buying.
    const v = evaluateAccountOptimisationCoverage(
      [
        { id: 'as_idle', name: 'Active but not delivering', effective_status: 'ACTIVE',
          promoted_object: { custom_event_type: 'LEAD', pixel_id: 'pix_a' } },
        { id: 'as_spending', name: 'The one actually spending', effective_status: 'ACTIVE',
          promoted_object: { custom_event_type: 'PURCHASE', pixel_id: 'pix_a' } },
      ],
      { pix_a: ['PageView'] },
      {
        // as_idle is absent entirely — Meta returned no rows, so it did not deliver.
        as_spending: [
          { date: '1', spend: 80, families: [] },
          { date: '2', spend: 80, families: [] },
          { date: '3', spend: 80, families: [] },
          { date: '4', spend: 80, families: [] },
        ],
      },
    );

    expect(v.alerting.map((m) => m.adSetId)).toEqual(['as_spending']);
    expect(v.unconfirmed.map((m) => m.adSetId)).toEqual(['as_idle']);
  });

  it('does not alert on two absent spending days, whatever follows them', () => {
    // Two absent days is short of the threshold. The trailing zero-spend rows are
    // incidental here — see the next case for what they actually do.
    const v = evaluateAccountOptimisationCoverage(
      [{ id: 'as_x', effective_status: 'ACTIVE', promoted_object: { custom_event_type: 'LEAD', pixel_id: 'p' } }],
      { p: ['PageView'] },
      { as_x: [
        { date: '1', spend: 100, families: [] },
        { date: '2', spend: 100, families: [] },
        { date: '3', spend: 0, families: [] },
        { date: '4', spend: 0, families: [] },
      ] },
    );
    expect(v.alerting).toEqual([]);
    expect(v.unconfirmed).toHaveLength(1);
  });

  it('reports a full streak behind a zero-spend tail as stale rather than paging on it', () => {
    // Zero-spend rows neither break nor extend a streak, inherited from
    // evaluateAdAccountDays so an outage spanning a weekend pause stays one outage. The
    // waste was real and stays reported — but with delivery stopped there is no spend left
    // to stop, so it goes to staleDelivery rather than paging someone.
    const v = evaluateAccountOptimisationCoverage(
      [{ id: 'as_x', effective_status: 'ACTIVE', promoted_object: { custom_event_type: 'LEAD', pixel_id: 'p' } }],
      { p: ['PageView'] },
      { as_x: [
        { date: '2026-08-01', spend: 100, families: [] },
        { date: '2026-08-02', spend: 100, families: [] },
        { date: '2026-08-03', spend: 100, families: [] },
        { date: '2026-08-04', spend: 100, families: [] },
        { date: '2026-08-05', spend: 100, families: [] },
        { date: '2026-08-06', spend: 0, families: [] },
      ] },
      '2026-08-12',   // twelve days on, delivery long since stopped
    );
    expect(v.alerting).toEqual([]);
    expect(v.staleDelivery).toHaveLength(1);
    // Five spending days, all absent; the trailing zero-spend row is dropped by the settle
    // window and would not have broken the run anyway.
    expect(v.staleDelivery[0].consecutiveAbsentSpendingDays).toBe(5);
  });
});

/**
 * CodeRabbit findings on #2435. Both are about evidence that looks settled and is not.
 */
describe('countTrailingAbsentSpendingDays — unsettled and unordered input', () => {
  it('excludes the most recent rows when asked, so a partial day cannot inflate the streak', () => {
    // Meta keeps attributing conversions after the day ends, so the newest row
    // under-reports. Counting it reaches the threshold a day early.
    const days = [
      { date: '2026-08-06', spend: 100, families: ['lead'] },
      { date: '2026-08-07', spend: 100, families: [] as string[] },
      { date: '2026-08-08', spend: 100, families: [] as string[] },
    ];
    expect(countTrailingAbsentSpendingDays(days, 'lead')).toBe(2);      // counts the unsettled day
    expect(countTrailingAbsentSpendingDays(days, 'lead', 1)).toBe(1);   // drops it
  });

  it('does not go negative or throw when every row is excluded', () => {
    const days = [{ date: '1', spend: 10, families: [] as string[] }];
    expect(countTrailingAbsentSpendingDays(days, 'lead', 1)).toBe(0);
    expect(countTrailingAbsentSpendingDays(days, 'lead', 5)).toBe(0);
  });

  it('sorts defensively — "most recent" is meaningless on an unordered array', () => {
    // Same rows, shuffled. Counting from the end of an unsorted array yields a plausible
    // number computed from the wrong end of the window, which fails silently.
    const shuffled = [
      { date: '2026-08-08', spend: 100, families: [] as string[] },
      { date: '2026-08-06', spend: 100, families: ['lead'] },
      { date: '2026-08-07', spend: 100, families: [] as string[] },
    ];
    expect(countTrailingAbsentSpendingDays(shuffled, 'lead')).toBe(2);
  });
});

describe('evaluateAccountOptimisationCoverage — the settle window is applied', () => {
  it('will not alert on a streak that only reaches the threshold via the unsettled day', () => {
    expect(ATTRIBUTION_SETTLE_DAYS).toBe(1);
    const v = evaluateAccountOptimisationCoverage(
      [{ id: 'as_x', effective_status: 'ACTIVE', promoted_object: { custom_event_type: 'LEAD', pixel_id: 'p' } }],
      { p: ['PageView'] },
      { as_x: [
        { date: '1', spend: 50, families: [] },
        { date: '2', spend: 50, families: [] },
        { date: '3', spend: 50, families: [] },   // dropped as unsettled -> only 2 count
      ] },
    );
    expect(v.alerting).toEqual([]);
    expect(v.unconfirmed).toHaveLength(1);
  });

  it('alerts once a fourth day makes three SETTLED absent days', () => {
    const v = evaluateAccountOptimisationCoverage(
      [{ id: 'as_x', effective_status: 'ACTIVE', promoted_object: { custom_event_type: 'LEAD', pixel_id: 'p' } }],
      { p: ['PageView'] },
      { as_x: [
        { date: '1', spend: 50, families: [] },
        { date: '2', spend: 50, families: [] },
        { date: '3', spend: 50, families: [] },
        { date: '4', spend: 50, families: [] },
      ] },
    );
    expect(v.alerting).toHaveLength(1);
    expect(v.alerting[0].consecutiveAbsentSpendingDays).toBe(3);
  });
});

describe('the recency gate — ACTIVE is a configuration, not a statement about spend', () => {
  const adSet = { id: 'as_x', effective_status: 'ACTIVE', promoted_object: { custom_event_type: 'LEAD', pixel_id: 'p' } };
  const fourAbsentDays = [
    { date: '2026-08-01', spend: 100, families: [] as string[] },
    { date: '2026-08-02', spend: 100, families: [] as string[] },
    { date: '2026-08-03', spend: 100, families: [] as string[] },
    { date: '2026-08-04', spend: 100, families: [] as string[] },
  ];

  it('alerts while the ad set is still delivering', () => {
    const v = evaluateAccountOptimisationCoverage(
      [adSet], { p: ['PageView'] }, { as_x: fourAbsentDays }, '2026-08-05',
    );
    expect(v.alerting).toHaveLength(1);
    expect(v.staleDelivery).toEqual([]);
  });

  it('still alerts at exactly the recency boundary', () => {
    expect(OPTIMISATION_RECENCY_DAYS).toBe(2);
    const v = evaluateAccountOptimisationCoverage(
      [adSet], { p: ['PageView'] }, { as_x: fourAbsentDays }, '2026-08-06', // 2 days on
    );
    expect(v.alerting).toHaveLength(1);
  });

  it('stops paging one day past the boundary — nothing is being spent to stop', () => {
    const v = evaluateAccountOptimisationCoverage(
      [adSet], { p: ['PageView'] }, { as_x: fourAbsentDays }, '2026-08-07', // 3 days on
    );
    expect(v.alerting).toEqual([]);
    expect(v.staleDelivery).toHaveLength(1);
    // The finding keeps its evidence — this is a demotion, not a deletion.
    expect(v.staleDelivery[0].consecutiveAbsentSpendingDays).toBe(3);
    expect(v.staleDelivery[0].insightsFamily).toBe('lead');
  });

  it('alerts as before when no asOf is supplied, so the gate cannot fail closed by omission', () => {
    const v = evaluateAccountOptimisationCoverage([adSet], { p: ['PageView'] }, { as_x: fourAbsentDays });
    expect(v.alerting).toHaveLength(1);
  });

  it('alerts rather than silently demoting when a date is unparseable', () => {
    // A malformed date must never read as "recent" OR as "stale" by accident. Falling back
    // to alerting keeps a real finding visible instead of hiding it behind a parse bug.
    const v = evaluateAccountOptimisationCoverage(
      [adSet], { p: ['PageView'] },
      { as_x: [...fourAbsentDays.slice(0, 3), { date: 'not-a-date', spend: 100, families: [] }] },
      '2026-08-20',
    );
    expect(v.alerting.length + v.staleDelivery.length).toBe(1);
  });
});

describe('newestSpendingDay', () => {
  it('ignores zero-spend rows and returns the latest by date, unsorted input included', () => {
    expect(newestSpendingDay([
      { date: '2026-08-03', spend: 0, families: [] },
      { date: '2026-08-01', spend: 50, families: [] },
      { date: '2026-08-02', spend: 50, families: [] },
    ])).toBe('2026-08-02');
  });

  it('is undefined when nothing ever spent', () => {
    expect(newestSpendingDay([{ date: '2026-08-01', spend: 0, families: [] }])).toBeUndefined();
    expect(newestSpendingDay([])).toBeUndefined();
    expect(newestSpendingDay(null)).toBeUndefined();
  });
});
