import { agentModeService } from '../services/agentModeService';

/**
 * ENG-1575 — processor-level guard.
 *
 * The util suite proves `leadTotals` in isolation. That is NOT the same as proving the four
 * processors behave identically to the shipped code, and no pre-existing test exercised any of
 * them with an `actions` payload at all. These do, using the real action payloads returned by
 * live production ad accounts on 2026-08-25 (180-day windows) and the numbers the OLD code
 * reported for them.
 *
 * If any of these move, a paying customer's lead count moves.
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
      name: 'account A (pixel-only, high volume)',
      spend: 29334,
      actions: [act('lead', 790), act('offsite_conversion.fb_pixel_lead', 790)],
      expectedTotal: 790,
    },
    {
      name: 'account B (pixel-only)',
      spend: 57527,
      actions: [act('lead', 419), act('offsite_conversion.fb_pixel_lead', 419)],
      expectedTotal: 419,
    },
    {
      // 952 custom pixel conversions alongside 630 real leads. The old code accumulated them
      // into formLeads (1582 raw) and then discarded the bucket wholesale; the new code never
      // counts a custom conversion as a lead in the first place. Same answer, different reason.
      name: 'account C (pixel-only + many custom conversions)',
      spend: 119938,
      actions: [
        act('lead', 630),
        act('offsite_conversion.fb_pixel_lead', 630),
        act('offsite_conversion.fb_pixel_custom', 952),
      ],
      expectedTotal: 630,
    },
    {
      name: 'account D (pixel-only + few custom)',
      spend: 5202,
      actions: [
        act('lead', 255),
        act('offsite_conversion.fb_pixel_lead', 255),
        act('offsite_conversion.fb_pixel_custom', 2),
      ],
      expectedTotal: 255,
    },
  ];

  it.each(cases)('$name reports $expectedTotal leads, all attributed to website', ({ spend, actions, expectedTotal }) => {
    const c = runCampaigns([{ campaign_id: 'c1', impressions: 100000, clicks: 5000, spend: String(spend), reach: 50000, actions }]);

    expect(c.totalLeads).toBe(expectedTotal);
    expect(c.websiteLeads).toBe(expectedTotal);
    // No Instant Form activity existed anywhere in production when this was measured.
    expect(c.formLeads).toBe(0);
    expect(c.costPerFormLead).toBe(0);
    expect(c.costPerLead).toBeCloseTo(spend / expectedTotal, 6);
  });

  it('falls back to spend / leads when Meta reports no cost_per_action_type', () => {
    const c = runCampaigns([
      { campaign_id: 'c1', impressions: 1000, clicks: 100, spend: '19910.48', reach: 900, actions: [act('lead', 330)] },
    ]);
    expect(c.totalLeads).toBe(330);
    expect(c.costPerLead).toBeCloseTo(19910.48 / 330, 6);
    expect(c.costPerWebsiteLead).toBeCloseTo(19910.48 / 330, 6);
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
    // The reachable trap: with no `lead` event the old suppression never fired, so 952 custom
    // conversions would have been reported as 952 leads.
    const c = runCampaigns([
      {
        campaign_id: 'c1', impressions: 10000, clicks: 500, spend: '5000', reach: 9000,
        actions: [act('offsite_conversion.fb_pixel_custom', 952)],
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
