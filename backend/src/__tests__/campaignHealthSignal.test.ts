import { collectCampaignHealthSignals, evaluateCampaignHealth, type CampaignHealthConfig, type CampaignWindowStats } from '../services/campaignHealthSignal';

const config: CampaignHealthConfig = {
  enabled: true,
  thresholds: { discrepancyRatio: 0.3, maxCostPerLead: 100, badLeadRate: 0.5, winMaxCostPerLead: 20, winMaxBadLeadRate: 0.2 },
};

const healthy: CampaignWindowStats = {
  campaignId: 'c1', campaignName: 'Aerie — Sub A', windowKey: 'w1',
  reportedLeads: 10, landedLeads: 9, spend: 500, qualityEvaluatedLeads: 9, badLeads: 2,
};

describe('evaluateCampaignHealth (ENG-87)', () => {
  it('AC1: reported vs landed divergence fires struggling naming campaign, metric and values', () => {
    const s = evaluateCampaignHealth({ ...healthy, reportedLeads: 20, landedLeads: 9 }, config);
    expect(s?.kind).toBe('struggling');
    expect(s?.campaignName).toBe('Aerie — Sub A');
    expect(s?.reasons).toEqual([expect.objectContaining({ metric: 'lead_discrepancy', threshold: 0.3 })]);
    expect(s?.values).toMatchObject({ reportedLeads: 20, landedLeads: 9 });
  });

  it('AC1: cost per lead above threshold fires, including spend with zero landed leads', () => {
    expect(evaluateCampaignHealth({ ...healthy, spend: 1500 }, config)?.reasons[0].metric).toBe('cost_per_lead');
    const zero = evaluateCampaignHealth({ ...healthy, reportedLeads: 0, landedLeads: 0, qualityEvaluatedLeads: 0, badLeads: 0, spend: 300 }, config);
    expect(zero?.reasons[0]).toMatchObject({ metric: 'cost_per_lead', value: Infinity });
  });

  it('AC2: bad-lead rate above threshold fires struggling', () => {
    const s = evaluateCampaignHealth({ ...healthy, badLeads: 6 }, config);
    expect(s?.kind).toBe('struggling');
    expect(s?.reasons.map((r) => r.metric)).toEqual(['bad_lead_rate']);
  });

  it('AC3: cheap, clean leads fire a win', () => {
    const s = evaluateCampaignHealth({ ...healthy, spend: 90, badLeads: 1 }, config);
    expect(s?.kind).toBe('win');
  });

  it('AC3: cheap leads with unjudged quality are not a win when a quality bar is set', () => {
    expect(evaluateCampaignHealth({ ...healthy, spend: 90, qualityEvaluatedLeads: undefined, badLeads: undefined }, config)).toBeNull();
  });

  it('AC4: a healthy in-range campaign fires nothing', () => {
    expect(evaluateCampaignHealth(healthy, config)).toBeNull();
  });

  it('AC4: unread signals never fire (unread is not zero)', () => {
    expect(evaluateCampaignHealth({ campaignId: 'c2', campaignName: 'x', windowKey: 'w1' }, config)).toBeNull();
  });

  it('AC4: signals dedupe per campaign/window', () => {
    const bad = { ...healthy, badLeads: 8 };
    const out = collectCampaignHealthSignals([bad, bad, { ...bad, windowKey: 'w2' }], config);
    expect(out.map((s) => s.windowKey)).toEqual(['w1', 'w2']);
    const prior = new Set([out[0].dedupeKey]);
    expect(collectCampaignHealthSignals([bad], config, prior)).toEqual([]);
  });

  it('AC5: disabled config or unset thresholds emit nothing (no invented defaults)', () => {
    const bad = { ...healthy, reportedLeads: 100, landedLeads: 1, spend: 10_000, badLeads: 9 };
    expect(evaluateCampaignHealth(bad, { ...config, enabled: false })).toBeNull();
    expect(evaluateCampaignHealth(bad, { enabled: true, thresholds: {} })).toBeNull();
  });

  it('AC5: raising a threshold turns its signal down', () => {
    const s = { ...healthy, badLeads: 6 };
    expect(evaluateCampaignHealth(s, { ...config, thresholds: { ...config.thresholds, badLeadRate: 0.9 } })).toBeNull();
  });
});
