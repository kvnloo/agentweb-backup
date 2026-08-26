import {
  familyOf,
  surfaceOf,
  collapseActions,
  leadTotals,
  CONVERSION_FAMILIES,
} from '../utils/metaActionFamilies';

const a = (action_type: string, value: number) => ({ action_type, value: String(value) });

describe('ENG-1575 familyOf', () => {
  it('maps every alias spelling observed in production onto one family', () => {
    // All four carried the SAME value in production — one set of leads, four names.
    for (const t of [
      'lead',
      'onsite_web_lead',
      'offsite_conversion.fb_pixel_lead',
      'offsite_lead_add_20_s_calls',
      'omni_lead',
    ]) {
      expect(familyOf(t)).toBe('lead');
    }
  });

  it('recognises the Instant Form spellings metaTrackingMonitor does not', () => {
    // The reference implementation checks `onsite_conversion.lead`, never `onsite_conversion.lead_form`,
    // so these three would fall through as unrecognised. Here that would silently drop the lead.
    expect(familyOf('leadgen')).toBe('lead');
    expect(familyOf('on_facebook_lead')).toBe('lead');
    expect(familyOf('onsite_conversion.lead_form')).toBe('lead');
  });

  it('classifies website_lead as a lead (CodeRabbit: it was dropped entirely)', () => {
    // familyOf returned null for this, so leadTotals reported ZERO for an account that only
    // emits `website_lead` — while surfaceOf and WEBSITE_COST_PRECEDENCE both recognised it and
    // the action-type sets this replaces counted it. A regression, not a pre-existing gap.
    expect(familyOf('website_lead')).toBe('lead');
    expect(surfaceOf('website_lead')).toBe('website');
    const totals = leadTotals([a('website_lead', 50)]);
    expect(totals.total).toBe(50);
    expect(totals.website).toBe(50);
  });

  it('does not double count website_lead against its own aliases', () => {
    const totals = leadTotals([a('lead', 50), a('website_lead', 50), a('offsite_conversion.fb_pixel_lead', 50)]);
    expect(totals.total).toBe(50);
    expect(totals.website).toBe(50);
  });

  it('does NOT treat a custom pixel conversion as a lead', () => {
    // One production account carried ~1.5x as many of these as real leads. Counting them overstates it.
    expect(familyOf('offsite_conversion.fb_pixel_custom')).toBeNull();
  });

  it('ignores engagement action types', () => {
    for (const t of ['link_click', 'post_engagement', 'landing_page_view', 'video_view', 'page_engagement']) {
      expect(familyOf(t)).toBeNull();
    }
  });

  it('covers families beyond lead', () => {
    expect(familyOf('offsite_conversion.fb_pixel_complete_registration')).toBe('complete_registration');
    expect(familyOf('offsite_complete_registration_add_meta_leads')).toBe('complete_registration');
    expect(familyOf('purchase')).toBe('purchase');
    expect(CONVERSION_FAMILIES).toContain('schedule');
  });
});

describe('ENG-1575 surfaceOf', () => {
  it('classifies pixel events as website, not Instant Form', () => {
    // This is the original defect: offsite_conversion.fb_pixel_lead sat in a set named FORM_ACTIONS.
    expect(surfaceOf('offsite_conversion.fb_pixel_lead')).toBe('website');
    expect(surfaceOf('onsite_web_lead')).toBe('website');
    expect(surfaceOf('website_lead')).toBe('website');
  });

  it('classifies the native lead form as instant_form', () => {
    expect(surfaceOf('leadgen')).toBe('instant_form');
    expect(surfaceOf('on_facebook_lead')).toBe('instant_form');
    expect(surfaceOf('onsite_conversion.lead_form')).toBe('instant_form');
  });

  it('leaves the bare rollup unattributed — it names no surface', () => {
    expect(surfaceOf('lead')).toBe('unknown');
    expect(surfaceOf('omni_lead')).toBe('unknown');
  });
});

describe('ENG-1575 collapseActions — counts each family once, by its maximum', () => {
  it('does not sum aliases of the same conversion', () => {
    const totals = leadTotals([
      a('lead', 330),
      a('onsite_web_lead', 330),
      a('offsite_conversion.fb_pixel_lead', 330),
      a('offsite_lead_add_20_s_calls', 330),
    ]);
    expect(totals.total).toBe(330); // summing would give 1320
  });

  it('keeps website + instantForm equal to total', () => {
    const totals = leadTotals([
      a('lead', 150),
      a('offsite_conversion.fb_pixel_lead', 100),
      a('onsite_conversion.lead_form', 50),
    ]);
    expect(totals.total).toBe(150);
    expect(totals.website + totals.instantForm).toBe(totals.total);
  });

  it('attributes Instant Form leads to Instant Form, not to website', () => {
    // The old code reported this as 150 website / 0 instant form, because it zeroed form leads
    // whenever any website lead existed. A skill asked "which channel works?" saw nothing.
    const totals = leadTotals([
      a('lead', 150),
      a('offsite_conversion.fb_pixel_lead', 100),
      a('onsite_conversion.lead_form', 50),
    ]);
    expect(totals.website).toBe(100);
    expect(totals.instantForm).toBe(50);
  });

  it('counts an Instant-Form-only account once WITH a bare rollup present', () => {
    const totals = leadTotals([
      a('lead', 50),
      a('leadgen', 50),
      a('on_facebook_lead', 50),
      a('onsite_conversion.lead_form', 50),
    ]);
    expect(totals.total).toBe(50); // summing the three form aliases would give 150
    expect(totals.instantForm).toBe(50);
    expect(totals.website).toBe(0);
  });

  it('counts an Instant-Form-only account once WITHOUT a bare rollup', () => {
    // Whether Meta emits the bare rollup for Instant Forms has never been observable to us —
    // no such account exists in production. `max` is correct either way, which is what lets
    // this ship without first finding a lead-ads customer.
    const totals = leadTotals([
      a('leadgen', 50),
      a('on_facebook_lead', 50),
      a('onsite_conversion.lead_form', 50),
    ]);
    expect(totals.total).toBe(50);
    expect(totals.instantForm).toBe(50);
    expect(totals.website).toBe(0);
  });

  it('does not undercount a mixed account when Meta emits no rollup', () => {
    // Two genuinely distinct conversions; max alone would report only the larger surface.
    const totals = leadTotals([
      a('offsite_conversion.fb_pixel_lead', 100),
      a('onsite_conversion.lead_form', 50),
    ]);
    expect(totals.total).toBe(150);
    expect(totals.website).toBe(100);
    expect(totals.instantForm).toBe(50);
  });

  it('excludes custom pixel conversions from the lead total', () => {
    const totals = leadTotals([
      a('lead', 630),
      a('offsite_conversion.fb_pixel_lead', 630),
      a('offsite_conversion.fb_pixel_custom', 952),
    ]);
    expect(totals.total).toBe(630);
  });

  it('separates families rather than merging them', () => {
    const byFamily = collapseActions([
      a('lead', 330),
      a('offsite_conversion.fb_pixel_lead', 330),
      a('complete_registration', 186),
      a('offsite_conversion.fb_pixel_complete_registration', 186),
      a('link_click', 3338),
    ]);
    expect(byFamily.get('lead')?.total).toBe(330);
    expect(byFamily.get('complete_registration')?.total).toBe(186);
    expect(byFamily.size).toBe(2);
  });

  it('tolerates missing, empty and malformed actions', () => {
    expect(leadTotals(undefined).total).toBe(0);
    expect(leadTotals(null).total).toBe(0);
    expect(leadTotals([]).total).toBe(0);
    expect(leadTotals([{ action_type: 'lead', value: 'not-a-number' }]).total).toBe(0);
    expect(leadTotals([{ action_type: 'lead', value: -5 }]).total).toBe(0);
    expect(leadTotals([undefined as any, a('lead', 7)]).total).toBe(7);
  });
});

/**
 * REGRESSION GUARD.
 *
 * These action shapes and values are taken from real production insights payloads (180-day
 * windows) and are the numbers the shipped code reported for them. The fix MUST leave every one
 * unchanged — that is what makes this deployable without any customer seeing their lead count
 * move.
 *
 * Account identities, ad-account IDs and spend are deliberately omitted: the ALIAS SHAPE and the
 * resulting count are what the code has to get right, and committing customer performance data
 * would leak it through the repo and every review surface. The mapping from case to account is
 * held outside the repo.
 */
describe('ENG-1575 regression guard — live production accounts must not move', () => {
  const cases: Array<{ account: string; actions: ReturnType<typeof a>[]; expected: number }> = [
    {
      account: 'account A (pixel-only, high volume)',
      actions: [a('lead', 790), a('offsite_conversion.fb_pixel_lead', 790)],
      expected: 790,
    },
    {
      account: 'account B (pixel-only)',
      actions: [a('lead', 419), a('offsite_conversion.fb_pixel_lead', 419)],
      expected: 419,
    },
    {
      account: 'account C (pixel-only + many custom conversions)',
      actions: [
        a('lead', 630),
        a('offsite_conversion.fb_pixel_lead', 630),
        a('offsite_conversion.fb_pixel_custom', 952),
      ],
      expected: 630,
    },
    {
      account: 'account D (pixel-only + few custom)',
      actions: [
        a('lead', 255),
        a('offsite_conversion.fb_pixel_lead', 255),
        a('offsite_conversion.fb_pixel_custom', 2),
      ],
      expected: 255,
    },
  ];

  it.each(cases)('$account reports exactly $expected leads', ({ actions, expected }) => {
    const totals = leadTotals(actions);
    expect(totals.total).toBe(expected);
    // Every one is pixel-only: no Instant Form activity existed anywhere in production when
    // this was measured, across every account with a connected Meta ad account.
    expect(totals.instantForm).toBe(0);
    expect(totals.website).toBe(expected);
  });
});
