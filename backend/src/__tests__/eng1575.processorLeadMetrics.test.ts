import { agentModeService } from '../services/agentModeService';

/**
 * ENG-1575 — processor-level guard.
 *
 * The util suite proves `leadTotals` in isolation. That is NOT the same as proving the four
 * processors behave identically to the shipped code, and no pre-existing test exercised any of
 * them with an `actions` payload at all. These do.
 *
 * Values are SYNTHETIC. What the regression guard actually pins is the alias SHAPE and the
 * invariant — one conversion reported under several names must be counted once, and the number
 * must not move. Real production figures were verified out-of-band and are deliberately not
 * committed; the property holds for any N.
 */

const act = (action_type: string, value: number) => ({ action_type, value: String(value) });

const runCampaigns = (insights: any[]) =>
  (agentModeService as any).processCampaignData(
    [{ id: 'c1', name: 'Campaign', status: 'ACTIVE', objective: 'OUTCOME_LEADS' }],
    insights,
    []
  )[0];

describe('ENG-1575 processCampaignData — live accounts must report exactly as before', () => {
  const cases = [
    {
      name: 'case A: rollup + pixel alias',
      spend: 1000,
      actions: [act('lead', 100), act('offsite_conversion.fb_pixel_lead', 100)],
      expectedTotal: 100,
    },
    {
      name: 'case B: rollup + pixel alias',
      spend: 2000,
      actions: [act('lead', 200), act('offsite_conversion.fb_pixel_lead', 200)],
      expectedTotal: 200,
    },
    {
      // 700 custom pixel conversions alongside 300 real leads. The old code accumulated them
      // into formLeads (1582 raw) and then discarded the bucket wholesale; the new code never
      // counts a custom conversion as a lead in the first place. Same answer, different reason.
      name: 'case C: rollup + pixel alias + custom conversions',
      spend: 3000,
      actions: [
        act('lead', 300),
        act('offsite_conversion.fb_pixel_lead', 300),
        act('offsite_conversion.fb_pixel_custom', 700),
      ],
      expectedTotal: 300,
    },
    {
      name: 'case D: rollup + pixel alias + one custom',
      spend: 4000,
      actions: [
        act('lead', 400),
        act('offsite_conversion.fb_pixel_lead', 400),
        act('offsite_conversion.fb_pixel_custom', 2),
      ],
      expectedTotal: 400,
    },
  ];

  it.each(cases)('$name reports $expectedTotal leads, all attributed to website', ({ spend, actions, expectedTotal }) => {
    const c = runCampaigns([{ campaign_id: 'c1', impressions: 100000, clicks: 5000, spend: String(spend), reach: 50000, actions }]);

    expect(c.totalLeads).toBe(expectedTotal);
    expect(c.websiteLeads).toBe(expectedTotal);
    // These cases carry no Instant Form spellings, so the Instant Form surface must stay zero.
    expect(c.formLeads).toBe(0);
    expect(c.costPerFormLead).toBe(0);
    expect(c.costPerLead).toBeCloseTo(spend / expectedTotal, 6);
  });

  it('falls back to spend / leads when Meta reports no cost_per_action_type', () => {
    const c = runCampaigns([
      { campaign_id: 'c1', impressions: 1000, clicks: 100, spend: '5000', reach: 900, actions: [act('lead', 330)] },
    ]);
    expect(c.totalLeads).toBe(330);
    expect(c.costPerLead).toBeCloseTo(5000 / 330, 6);
    expect(c.costPerWebsiteLead).toBeCloseTo(5000 / 330, 6);
  });
});

describe('ENG-1575 processCampaignData — the defect this fixes', () => {
  it('no longer reports an Instant Form lead as a website lead', () => {
    // OLD behaviour: websiteLeads 150 / formLeads 0 — the `formLeads = 0` suppression fired
    // because website leads existed, so the Instant Form channel read as producing nothing.
    const c = runCampaigns([
      {
        campaign_id: 'c1', impressions: 10000, clicks: 500, spend: '3000', reach: 8000,
        actions: [
          act('lead', 150),                                // omni rollup, spans both surfaces
          act('offsite_conversion.fb_pixel_lead', 100),    // website
          act('onsite_conversion.lead_form', 50),          // Instant Form
        ],
      },
    ]);

    expect(c.totalLeads).toBe(150);
    expect(c.websiteLeads).toBe(100);
    expect(c.formLeads).toBe(50);
    expect(c.websiteLeads + c.formLeads).toBe(c.totalLeads);
  });

  it('counts an Instant-Form-only campaign once instead of three times', () => {
    // OLD behaviour with no bare rollup: websiteLeads 0, so the suppression never fired and
    // formLeads summed all three aliases -> 150 reported for 50 real leads.
    const c = runCampaigns([
      {
        campaign_id: 'c1', impressions: 5000, clicks: 200, spend: '1000', reach: 4000,
        actions: [act('leadgen', 50), act('on_facebook_lead', 50), act('onsite_conversion.lead_form', 50)],
      },
    ]);

    expect(c.totalLeads).toBe(50);
    expect(c.formLeads).toBe(50);
    expect(c.websiteLeads).toBe(0);
    expect(c.costPerLead).toBeCloseTo(1000 / 50, 6);
  });

  it('picks lead cost deterministically, not by array order', () => {
    const forward = runCampaigns([
      {
        campaign_id: 'c1', impressions: 1000, clicks: 50, spend: '500', reach: 900,
        actions: [act('lead', 10), act('offsite_conversion.fb_pixel_lead', 10)],
        cost_per_action_type: [act('lead', 46), act('offsite_conversion.fb_pixel_lead', 50)],
      },
    ]);
    const reversed = runCampaigns([
      {
        campaign_id: 'c1', impressions: 1000, clicks: 50, spend: '500', reach: 900,
        actions: [act('lead', 10), act('offsite_conversion.fb_pixel_lead', 10)],
        cost_per_action_type: [act('offsite_conversion.fb_pixel_lead', 50), act('lead', 46)],
      },
    ]);

    // Old code assigned on every match, so the surviving value was whichever came LAST:
    // 50 forward, 46 reversed. Same data, two answers.
    expect(forward.costPerWebsiteLead).toBe(reversed.costPerWebsiteLead);
    expect(forward.costPerWebsiteLead).toBe(50); // most specific spelling wins
  });

  it('never counts a custom pixel conversion as a lead even with no other lead events', () => {
    // The reachable trap: with no `lead` event the old suppression never fired, so 700 custom
    // conversions would have been reported as 700 leads.
    const c = runCampaigns([
      {
        campaign_id: 'c1', impressions: 10000, clicks: 500, spend: '5000', reach: 9000,
        actions: [act('offsite_conversion.fb_pixel_custom', 700)],
      },
    ]);
    expect(c.totalLeads).toBe(0);
    expect(c.websiteLeads).toBe(0);
    expect(c.formLeads).toBe(0);
  });
});

describe('ENG-1575 processBreakdownData', () => {
  it('applies the same collapsing to demographic breakdown rows', () => {
    const rows = (agentModeService as any).processBreakdownData([
      {
        age: '25-34', gender: 'female', impressions: '1000', clicks: '50', spend: '250',
        actions: [act('lead', 20), act('offsite_conversion.fb_pixel_lead', 20)],
      },
    ]);
    expect(rows[0].totalLeads).toBe(20);
    expect(rows[0].websiteLeads).toBe(20);
    expect(rows[0].formLeads).toBe(0);
  });
});
