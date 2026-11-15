/**
 * ENG-3031 acceptance (ENG-2916 slice 3): the four ads_insights_* parity rows leave `gap`.
 *  - advertiser_context, anomaly_signal, industry_benchmark: no public Graph endpoint was found,
 *    so they are not_applicable with a reason naming what was checked. No tool, no derived score.
 *  - auction_ranking_benchmarks: served by call_meta_ads_insights_api, which accepts Meta's three
 *    ad relevance diagnostics as fields and sends them to Graph.
 * Mocked Graph only: no live Meta call.
 */
jest.mock('axios');
// The insights report is polled every 10 s; the wait is not what is under test.
jest.mock('../services/agentMode/sandboxPolling', () => ({ sandboxAwarePollDelayMs: () => 0 }));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    listMetaAdsCampaignsNew: jest.fn(),
    getMetaAdsMetrics: jest.fn(),
    callMetaAdsInsightsApiWrapper: jest.fn(),
    callMetaMarketingApi: jest.fn(),
    launchTargetedAudienceCampaign: jest.fn(),
    launchRetargetingCampaign: jest.fn(),
  },
}));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));

import axios from 'axios';
import { getMetaToolkitManifest, assertMetaToolkitV1Call } from '../mcp/metaToolkitManifest';
import { ZOMA_META_PARITY_MATRIX } from '../mcp/zomaMetaParityMatrix';
import { ALLOWED_INSIGHTS_FIELDS } from '../utils/metaConstants';
import { callMetaAdsInsightsApiWrapper } from '../emma/impl/adsApis';

const RANKING_FIELDS = ['quality_ranking', 'engagement_rate_ranking', 'conversion_rate_ranking'];
const NOT_APPLICABLE = ['ads_insights_advertiser_context', 'ads_insights_anomaly_signal', 'ads_insights_industry_benchmark'];
const row = (name: string) => ZOMA_META_PARITY_MATRIX.find((r) => r.metaTool === name)!;

describe('ENG-3031 ads_insights_* parity rows', () => {
  it('no row in the group is left as gap', () => {
    for (const name of [...NOT_APPLICABLE, 'ads_insights_auction_ranking_benchmarks', 'ads_insights_performance_trend']) {
      expect({ name, status: row(name).status }).not.toEqual({ name, status: 'gap' });
    }
  });

  it.each(NOT_APPLICABLE)('%s is not_applicable, maps to no tool, and says what was checked', (name) => {
    const r = row(name);
    expect(r.status).toBe('not_applicable');
    expect(r.zoma).toBeUndefined();
    expect(r.reason).toMatch(/No public Graph endpoint or field/);
    expect(r.reason).toMatch(/Ad Account reference/);
    expect(r.reason).toMatch(/Insights references/);
    expect(r.reason).toMatch(/checked \d{4}-\d{2}-\d{2}/);
  });

  it('no Zoma tool was added for the three not_applicable names', () => {
    const names = getMetaToolkitManifest().map((d: any) => d.name);
    for (const name of NOT_APPLICABLE) expect(names).not.toContain(name);
  });
});

describe('ENG-3031 ads_insights_auction_ranking_benchmarks → call_meta_ads_insights_api', () => {
  it('the row maps to the advertised insights tool, which reads at ad level', () => {
    expect(row('ads_insights_auction_ranking_benchmarks')).toMatchObject({ status: 'covered', zoma: { tool: 'call_meta_ads_insights_api' } });
    const def: any = getMetaToolkitManifest().find((d: any) => d.name === 'call_meta_ads_insights_api');
    expect(def).toBeDefined();
    expect(def.inputSchema.properties.level.enum).toContain('ad');
    expect(def.inputSchema.properties.fields.type).toBe('array');
    expect(() => assertMetaToolkitV1Call('call_meta_ads_insights_api', { object_type: 'account', level: 'ad', fields: RANKING_FIELDS })).not.toThrow();
  });

  it('the three ranking fields are on the insights allow-list', () => {
    for (const f of RANKING_FIELDS) expect(ALLOWED_INSIGHTS_FIELDS).toContain(f);
  });

  it('the insights call sends the three ranking fields to Graph at ad level and returns what Meta answers for them', async () => {
    const post = axios.post as jest.Mock;
    const get = axios.get as jest.Mock;
    post.mockReset();
    get.mockReset();
    post.mockResolvedValue({ data: { report_run_id: 'run-1' } });
    const metaRow = { ad_id: '555', quality_ranking: 'ABOVE_AVERAGE', engagement_rate_ranking: 'AVERAGE', conversion_rate_ranking: 'BELOW_AVERAGE_35' };
    get
      .mockResolvedValueOnce({ data: { async_status: 'Job Completed' } })
      .mockResolvedValueOnce({ data: { data: [metaRow] } });
    const getMetaCredentials = jest.fn().mockResolvedValue({ accountId: '111', accessToken: 'tok' });

    const result: any = await callMetaAdsInsightsApiWrapper(
      'user-1',
      { object_type: 'account', level: 'ad', date_preset: 'last_7d', fields: ['ad_id', ...RANKING_FIELDS] } as any,
      { getMetaCredentials },
    );

    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0];
    expect(url).toMatch(/\/act_111\/insights$/);
    expect(body.level).toBe('ad');
    expect(String(body.fields).split(',')).toEqual(['ad_id', ...RANKING_FIELDS]);
    expect(result.success).toBe(true);
    expect(result.data).toEqual([metaRow]);
  });
});
