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
  META_EVENT_BY_OPTIMISATION,
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
