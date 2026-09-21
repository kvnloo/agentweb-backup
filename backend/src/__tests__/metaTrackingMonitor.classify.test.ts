/**
 * ENG-926 §F — classifying a day of Meta ad activity.
 *
 * Every expectation here was derived from REAL production insights rows (Haven
 * `act_1842363582956923`, Every.io `act_1358071355944019`, 25 days each, read 2026-08-15),
 * not from the docs and not from a fixture someone invented. Two facts came out of that
 * read and both are load-bearing:
 *
 *   1. `actions` on a live account is never empty. A spending day carries ~20 action types,
 *      almost all engagement (`link_click`, `post_reaction`, `landing_page_view`,
 *      `video_view`). A check that asks "did anything happen" is therefore permanently
 *      green and can never fire — which is precisely the shape of failure this card exists
 *      to prevent.
 *
 *   2. Meta reports one conversion under several names. Haven 2026-06-08 carried
 *      `lead: 17`, `offsite_conversion.fb_pixel_lead: 17`, `onsite_web_lead: 17` and
 *      `offsite_lead_add_20_s_calls: 17` — one set of 17 leads, four names. Across all 50
 *      production days checked, the bare `lead` equalled the max of its aliases in every
 *      single row. `lead` is Meta's deduplicated rollup; summing the aliases reports 34
 *      leads for 17 (the latent defect in businessFunnelService's action-type list).
 */

import {
  countAttributedConversions,
  UNRECOGNIZED_SAMPLE_LIMIT,
} from '../services/metaTrackingMonitor';

const action = (action_type: string, value: number | string) => ({ action_type, value: String(value) });

/** A real Haven day, trimmed but with every action type preserved verbatim. */
const HAVEN_2026_06_08 = [
  action('offsite_complete_registration_add_meta_leads', 5),
  action('link_click', 152),
  action('omni_complete_registration', 5),
  action('offsite_conversion.fb_pixel_complete_registration', 5),
  action('post_reaction', 1),
  action('landing_page_view', 124),
  action('onsite_web_lead', 17),
  action('omni_landing_page_view', 124),
  action('post_engagement', 154),
  action('page_engagement', 154),
  action('complete_registration', 5),
  action('lead', 17),
  action('offsite_conversion.fb_pixel_lead', 17),
  action('offsite_lead_add_20_s_calls', 17),
];

/** A real Every.io day: $351 spent, engagement everywhere, not one conversion. */
const EVERYIO_2026_05_17 = [
  action('link_click', 1117),
  action('post_reaction', 35),
  action('landing_page_view', 825),
  action('omni_landing_page_view', 825),
  action('post_engagement', 1164),
  action('page_engagement', 1164),
  action('video_view', 4),
  action('comment', 1),
  action('onsite_conversion.post_save', 6),
];

describe('countAttributedConversions — the deduplicated count', () => {
  it('counts an alias family ONCE, using the bare rollup', () => {
    // 17 leads reported four ways. Summing gives 34+ and would make a broken account look
    // twice as healthy as a working one.
    const result = countAttributedConversions(HAVEN_2026_06_08);
    expect(result.conversions).toBe(22); // lead 17 + complete_registration 5
  });

  it('counts a second conversion family independently of the first', () => {
    // `complete_registration` is a genuinely different event from `lead`, so it adds;
    // its own three aliases must not.
    const result = countAttributedConversions([
      action('complete_registration', 4),
      action('omni_complete_registration', 4),
      action('offsite_conversion.fb_pixel_complete_registration', 4),
    ]);
    expect(result.conversions).toBe(4);
  });

  it('returns zero for a day of pure engagement — the Every.io blackout', () => {
    // The single most important case in this file. This is a REAL day on which a real
    // customer spent $351 and received nothing, during the window whose root cause
    // ENG-993 later fixed. If this returns anything but 0, AC4 never fires.
    const result = countAttributedConversions(EVERYIO_2026_05_17);
    expect(result.conversions).toBe(0);
  });

  it('treats a missing actions array as zero, not as an error', () => {
    expect(countAttributedConversions(undefined).conversions).toBe(0);
    expect(countAttributedConversions([]).conversions).toBe(0);
  });

  it('ignores an alias arriving WITHOUT its rollup rather than double-counting later', () => {
    // Defensive: if Meta ever emits the pixel alias with no bare `lead`, the alias is the
    // only evidence the conversion happened and must still count — silently dropping it
    // would manufacture a blackout that is not real, and AC4 alerts on blackouts.
    const result = countAttributedConversions([action('offsite_conversion.fb_pixel_lead', 9)]);
    expect(result.conversions).toBe(9);
  });
});

describe('countAttributedConversions — the third state', () => {
  it('reports action types it does not recognise, without inflating the count', () => {
    // We cannot tell "no conversions" from "conversions under a name we never taught it".
    // So the count stays honest and the unknown names are surfaced for a human to add.
    const result = countAttributedConversions([
      action('link_click', 10),
      action('offsite_conversion.fb_pixel_custom.some_new_thing', 3),
      action('a_meta_action_type_invented_next_year', 1),
    ]);
    expect(result.conversions).toBe(0);
    expect(result.unrecognized).toEqual(
      expect.arrayContaining([
        'offsite_conversion.fb_pixel_custom.some_new_thing',
        'a_meta_action_type_invented_next_year',
      ]),
    );
  });

  it('does NOT flag known engagement as unrecognised', () => {
    // Every spending day carries ~20 engagement types. If those counted as unknown, the
    // signal would be pure noise on every account every day and get ignored within a week.
    const result = countAttributedConversions(EVERYIO_2026_05_17);
    expect(result.unrecognized).toEqual([]);
  });

  it('does NOT flag a known conversion alias as unrecognised', () => {
    const result = countAttributedConversions(HAVEN_2026_06_08);
    expect(result.unrecognized).toEqual([]);
  });

  it('caps the reported sample so one odd account cannot flood the log', () => {
    const many = Array.from({ length: UNRECOGNIZED_SAMPLE_LIMIT + 15 }, (_, i) =>
      action(`unknown_type_${i}`, 1),
    );
    expect(countAttributedConversions(many).unrecognized).toHaveLength(UNRECOGNIZED_SAMPLE_LIMIT);
  });
});

describe('countAttributedConversions — malformed input', () => {
  it('survives rows with a non-numeric or missing value', () => {
    const result = countAttributedConversions([
      action('lead', 'not-a-number'),
      { action_type: 'complete_registration' } as any,
      null as any,
      { value: '5' } as any,
    ]);
    expect(result.conversions).toBe(0);
    expect(result.unrecognized).toEqual([]);
  });
});
