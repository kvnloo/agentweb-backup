import {
  suggestInsightsField,
  suggestInsightsFields,
  ALLOWED_INSIGHTS_FIELDS,
} from '../utils/metaConstants';

describe('metaConstants - suggestInsightsField (ENG-511)', () => {
  it('suggests the correct field for a single-char typo', () => {
    expect(suggestInsightsField('impression')).toBe('impressions');
    expect(suggestInsightsField('spendd')).toBe('spend');
  });

  it('suggests the whitelisted field for a looser phrasing via containment', () => {
    expect(suggestInsightsField('link_clicks')).toBe('inline_link_clicks');
  });

  it('returns null for a genuinely made-up metric (no wrong suggestion)', () => {
    expect(suggestInsightsField('made_up_bogus_field_xyz')).toBeNull();
    expect(suggestInsightsField('totally_unrelated_nonsense')).toBeNull();
  });

  it('never suggests the field itself, even when it is on the whitelist', () => {
    // onsite_conversion_lead_grouped is whitelisted but Meta can reject it at
    // runtime; the drop path must not echo it back as its own "suggestion".
    expect(ALLOWED_INSIGHTS_FIELDS).toContain('onsite_conversion_lead_grouped');
    expect(suggestInsightsField('onsite_conversion_lead_grouped')).toBeNull();
    const map = suggestInsightsFields([
      'spend',
      'onsite_conversion_lead_grouped',
    ]);
    expect(map).not.toHaveProperty('onsite_conversion_lead_grouped');
    expect(map).not.toHaveProperty('spend');
  });

  it('returns null for empty / whitespace input', () => {
    expect(suggestInsightsField('')).toBeNull();
    expect(suggestInsightsField('   ')).toBeNull();
  });

  it('never suggests a field that is not on the whitelist', () => {
    const s = suggestInsightsField('impresssions');
    expect(s === null || ALLOWED_INSIGHTS_FIELDS.includes(s)).toBe(true);
  });

  it('builds a map that omits drops with no plausible match', () => {
    const map = suggestInsightsFields(['impression', 'made_up_bogus_field_xyz']);
    expect(map).toEqual({ impression: 'impressions' });
  });
});
