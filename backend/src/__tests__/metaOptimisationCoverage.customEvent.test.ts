/**
 * ENG-926 §G Tier 1 — custom conversions are judgeable, and used not to be.
 *
 * `promoted_object.custom_event_type: 'OTHER'` means "a custom conversion", not an unknown
 * event, and Meta returns the conversion's own name in `custom_event_str` in the SAME object.
 * Tier 1 never requested that field, so every such ad set was dropped as unjudgeable.
 *
 * Measured against production on 2026-08-18: of the 13 delivering conversion-optimised ad sets
 * across all 15 connected accounts, Tier 1 could judge 5. The 8 it could not see all belonged
 * to the single biggest-spending account, and they were healthy — but that was measured by
 * hand, not detected.
 *
 * Identifiers and event names below are synthetic except where a real production SHAPE is
 * being pinned (the percent-encoding case, and Lead/lead coexisting on one pixel).
 */

import {
  resolveOptimisationEvent,
  pixelReceivedEvent,
  evaluateOptimisationCoverage,
} from '../services/metaOptimisationCoverage';

const adSet = (over: any = {}) => ({
  id: 'as-1',
  name: 'Ad set',
  effective_status: 'ACTIVE',
  promoted_object: { pixel_id: 'px-1', custom_event_type: 'LEAD' },
  ...over,
});

describe('resolveOptimisationEvent', () => {
  it('resolves a standard optimisation through the taxonomy map', () => {
    const r = resolveOptimisationEvent({ custom_event_type: 'COMPLETE_REGISTRATION', pixel_id: 'p' });
    expect(r).toEqual({
      kind: 'resolved',
      key: 'COMPLETE_REGISTRATION',
      expectedEventName: 'CompleteRegistration',
      custom: false,
    });
  });

  it('resolves OTHER through custom_event_str, using the name verbatim', () => {
    // A custom conversion is reported by the pixel under its own name — there is no
    // SCREAMING_CASE to PascalCase translation as there is for the standard taxonomy.
    const r = resolveOptimisationEvent({
      custom_event_type: 'OTHER',
      custom_event_str: 'marketingqualifiedlead',
      pixel_id: 'p',
    });
    expect(r).toEqual({
      kind: 'resolved',
      key: 'marketingqualifiedlead',
      expectedEventName: 'marketingqualifiedlead',
      custom: true,
    });
  });

  it('does NOT upper-case a custom event name', () => {
    const r = resolveOptimisationEvent({
      custom_event_type: 'other',
      custom_event_str: 'TypeformSubmit',
      pixel_id: 'p',
    });
    expect(r).toMatchObject({ kind: 'resolved', expectedEventName: 'TypeformSubmit' });
  });

  it('ignores OTHER with no name attached, rather than reporting it unrecognised', () => {
    // Reporting it would print the same word in every sweep's output forever (§40).
    expect(resolveOptimisationEvent({ custom_event_type: 'OTHER', pixel_id: 'p' }))
      .toEqual({ kind: 'ignored', key: 'OTHER' });
    expect(resolveOptimisationEvent({ custom_event_type: 'OTHER', custom_event_str: '   ', pixel_id: 'p' }))
      .toEqual({ kind: 'ignored', key: 'OTHER' });
  });

  it('reports a genuinely unknown optimisation as unrecognised, never as a mismatch', () => {
    expect(resolveOptimisationEvent({ custom_event_type: 'SOME_NEW_META_GOAL', pixel_id: 'p' }))
      .toEqual({ kind: 'unrecognised', key: 'SOME_NEW_META_GOAL' });
  });

  it('returns none when nothing is promoted', () => {
    expect(resolveOptimisationEvent(null)).toEqual({ kind: 'none' });
    expect(resolveOptimisationEvent({} as any)).toEqual({ kind: 'none' });
    expect(resolveOptimisationEvent({ custom_event_type: '  ' } as any)).toEqual({ kind: 'none' });
  });
});

describe('pixelReceivedEvent', () => {
  it('matches exactly', () => {
    expect(pixelReceivedEvent(new Set(['Lead']), 'Lead')).toBe(true);
    expect(pixelReceivedEvent(new Set(['Lead']), 'CompleteRegistration')).toBe(false);
  });

  it('is CASE-SENSITIVE, because Lead and lead are different events on one real pixel', () => {
    // A production pixel reports both `Lead` (12) and `lead` (8). Folding case would let a
    // healthy event vouch for a dead one — Tier 1's first P1 in a different costume.
    expect(pixelReceivedEvent(new Set(['lead']), 'Lead')).toBe(false);
    expect(pixelReceivedEvent(new Set(['Lead']), 'lead')).toBe(false);
  });

  it('matches a percent-encoded name, which /stats returns alongside the decoded one', () => {
    // Real shape: a pixel reports `Hubspot Form Completed $25k+` AND
    // `Hubspot%20Form%20Completed%20%2425k%2B` in the same response.
    const received = new Set(['Hubspot%20Form%20Completed%20%2425k%2B']);
    expect(pixelReceivedEvent(received, 'Hubspot Form Completed $25k+')).toBe(true);
  });

  it('survives a malformed percent sequence without throwing', () => {
    expect(pixelReceivedEvent(new Set(['%E0%A4%A']), 'anything')).toBe(false);
  });
});

describe('evaluateOptimisationCoverage with custom conversions', () => {
  const received = ['PageView', 'marketingqualifiedlead', 'Lead'];

  it('stays silent when the pixel receives the custom event', () => {
    const v = evaluateOptimisationCoverage(
      [adSet({ promoted_object: { pixel_id: 'px-1', custom_event_type: 'OTHER', custom_event_str: 'marketingqualifiedlead' } })],
      received,
    );
    expect(v.mismatches).toHaveLength(0);
    expect(v.dormantMismatches).toHaveLength(0);
  });

  it('flags a DELIVERING ad set whose custom event never arrives', () => {
    const v = evaluateOptimisationCoverage(
      [adSet({ promoted_object: { pixel_id: 'px-1', custom_event_type: 'OTHER', custom_event_str: 'opportunity' } })],
      received,
    );
    expect(v.mismatches).toHaveLength(1);
    expect(v.mismatches[0]).toMatchObject({
      optimisationEvent: 'opportunity',
      expectedEventName: 'opportunity',
    });
  });

  it('files a PAUSED one as dormant, never as an alerting mismatch', () => {
    // This is the Phoenix case: the ad sets cost nothing until someone resumes them.
    const v = evaluateOptimisationCoverage(
      [adSet({
        effective_status: 'PAUSED',
        promoted_object: { pixel_id: 'px-1', custom_event_type: 'OTHER', custom_event_str: 'TypeformSubmit' },
      })],
      received,
    );
    expect(v.mismatches).toHaveLength(0);
    expect(v.dormantMismatches).toHaveLength(1);
    expect(v.dormantMismatches[0]).toMatchObject({ expectedEventName: 'TypeformSubmit' });
  });

  it('does not report a custom conversion as an unrecognised optimisation', () => {
    const v = evaluateOptimisationCoverage(
      [adSet({ promoted_object: { pixel_id: 'px-1', custom_event_type: 'OTHER', custom_event_str: 'opportunity' } })],
      received,
    );
    expect(v.unrecognisedOptimisations).toEqual([]);
  });
});
