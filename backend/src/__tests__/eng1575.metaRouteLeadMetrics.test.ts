import { applyLeadMetrics } from '../utils/metaActionFamilies';

/**
 * ENG-1575 — /api/meta/ad-performance guard.
 *
 * Exercises the shared helper that `routes/meta.ts` now calls (CodeRabbit: one implementation,
 * not one per caller). Kept separate from the util suite because these assertions are about the
 * ROUTE's contract — specifically that the field the portal renders does not move.
 *
 * This route had its OWN copy of the action-type sets and, unlike agentModeService, NO
 * suppression — so `totalLeads` came back at 2x. Verified against a live account using the
 * route's own query params: it reported exactly double the real lead count at both 7d and 30d,
 * with costPerLead correspondingly halved.
 *
 * No customer saw it: the portal renders `websiteLeads`, never `totalLeads`. These tests
 * pin BOTH — the field that was wrong is now right, and the field the portal actually
 * displays does not move.
 */

const act = (action_type: string, value: number) => ({ action_type, value: String(value) });
const blank = () => ({ websiteLeads: 0, formLeads: 0, costPerWebsiteLead: 0, costPerFormLead: 0 });
const totalOf = (t: any) => (t.websiteLeads || 0) + (t.formLeads || 0); // the route's own formula

describe('ENG-1575 routes/meta applyLeadMetrics', () => {
  it('stops double counting the pixel alias — 7d reported 22 for 11 real leads', () => {
    const t = blank();
    applyLeadMetrics(t, { actions: [act('lead', 11), act('offsite_conversion.fb_pixel_lead', 11)] });
    expect(totalOf(t)).toBe(11);
    // The number the portal actually renders must NOT move.
    expect(t.websiteLeads).toBe(11);
    expect(t.formLeads).toBe(0);
  });

  it('stops double counting at 30d — was 150 for 75', () => {
    const t = blank();
    applyLeadMetrics(t, { actions: [act('lead', 75), act('offsite_conversion.fb_pixel_lead', 75)] });
    expect(totalOf(t)).toBe(75);
    expect(t.websiteLeads).toBe(75);
  });

  it('never counts a custom pixel conversion as a lead', () => {
    const t = blank();
    applyLeadMetrics(t, {
      actions: [act('lead', 630), act('offsite_conversion.fb_pixel_lead', 630), act('offsite_conversion.fb_pixel_custom', 952)],
    });
    expect(totalOf(t)).toBe(630);
    expect(t.websiteLeads).toBe(630);
  });

  it('keeps the portal-rendered websiteLeads unchanged for every measured account', () => {
    for (const [n, leads] of [['A', 790], ['B', 419], ['C', 630], ['D', 255]] as const) {
      const t = blank();
      applyLeadMetrics(t, { actions: [act('lead', leads), act('offsite_conversion.fb_pixel_lead', leads)] });
      expect({ account: n, websiteLeads: t.websiteLeads }).toEqual({ account: n, websiteLeads: leads });
    }
  });

  it('reports Instant Form leads separately instead of as website leads', () => {
    const t = blank();
    applyLeadMetrics(t, {
      actions: [act('lead', 150), act('offsite_conversion.fb_pixel_lead', 100), act('onsite_conversion.lead_form', 50)],
    });
    expect(t.websiteLeads).toBe(100);
    expect(t.formLeads).toBe(50);
    expect(totalOf(t)).toBe(150);
  });

  it('picks lead cost by precedence, not by Meta array order', () => {
    const fwd = blank(); const rev = blank();
    const actions = [act('lead', 10), act('offsite_conversion.fb_pixel_lead', 10)];
    applyLeadMetrics(fwd, { actions, cost_per_action_type: [act('lead', 46), act('offsite_conversion.fb_pixel_lead', 50)] });
    applyLeadMetrics(rev, { actions, cost_per_action_type: [act('offsite_conversion.fb_pixel_lead', 50), act('lead', 46)] });
    expect(fwd.costPerWebsiteLead).toBe(rev.costPerWebsiteLead);
  });

  it('accumulates across insight rows without re-inflating', () => {
    const t = blank();
    applyLeadMetrics(t, { actions: [act('lead', 5), act('offsite_conversion.fb_pixel_lead', 5)] });
    applyLeadMetrics(t, { actions: [act('lead', 7), act('offsite_conversion.fb_pixel_lead', 7)] });
    expect(totalOf(t)).toBe(12);
  });

  it('keeps cost deterministic across multiple rows regardless of order', () => {
    // CodeRabbit: cost was last-wins, so a multi-row result made the reported figure depend on
    // the order Meta returned rows in. Now first-wins. (Measured: action_breakdowns=action_type
    // never returns >1 row per entity — campaign 2/2, adset 4/4, ad 10/10 — but time_increment
    // and breakdowns do, and this must not depend on ordering there either.)
    const rowA = { actions: [act('lead', 5)], cost_per_action_type: [act('lead', 40)] };
    const rowB = { actions: [act('lead', 7)], cost_per_action_type: [act('lead', 90)] };
    const fwd = blank(); applyLeadMetrics(fwd, rowA); applyLeadMetrics(fwd, rowB);
    const rev = blank(); applyLeadMetrics(rev, rowB); applyLeadMetrics(rev, rowA);
    // Counts ADD across rows — correct for daily/segment rows, which is what multi-row means.
    expect(totalOf(fwd)).toBe(12);
    expect(totalOf(rev)).toBe(12);
    // Cost must not swing on row order. The rows disagree (40 vs 90), so neither is adopted —
    // cleared to 0 so the caller's `cost || spend / leads` fallback derives the aggregate.
    expect(fwd.costPerWebsiteLead).toBe(rev.costPerWebsiteLead);
    expect(fwd.costPerWebsiteLead).toBe(0);
  });

  it('locks a disputed cost across EVERY ordering of three disagreeing rows', () => {
    // CodeRabbit: writing 0 on conflict made the cleared value read as "unset" on the next row,
    // so 40/90/60 ended at 60 while 60/90/40 ended at 0 — the order dependence this removes.
    const rows = [40, 90, 60].map((c, i) => ({
      actions: [act('lead', i + 1)],
      cost_per_action_type: [act('lead', c)],
    }));
    const perms = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ];
    const results = perms.map((order) => {
      const t = blank();
      for (const i of order) applyLeadMetrics(t, rows[i]);
      return { cost: t.costPerWebsiteLead, total: totalOf(t) };
    });
    for (const r of results) {
      expect(r.cost).toBe(0);   // disputed -> caller derives from spend / leads
      expect(r.total).toBe(6);  // 1 + 2 + 3, order-independent
    }
    expect(new Set(results.map((r) => r.cost)).size).toBe(1);
  });

  it('keeps a unanimous cost across rows', () => {
    const t = blank();
    applyLeadMetrics(t, { actions: [act('lead', 5)], cost_per_action_type: [act('lead', 40)] });
    applyLeadMetrics(t, { actions: [act('lead', 7)], cost_per_action_type: [act('lead', 40)] });
    expect(totalOf(t)).toBe(12);
    expect(t.costPerWebsiteLead).toBe(40);
  });

  it('tolerates rows with no actions', () => {
    const t = blank();
    applyLeadMetrics(t, {});
    applyLeadMetrics(t, { actions: null });
    expect(totalOf(t)).toBe(0);
  });
});
