import { validateAndRepairToolArgs } from '../services/agentToolGatewayService';

// ENG-2581: prod Dev-AW-LoopEvents 2026-10-18..19 — Google rejects
// "Unrecognized field in the query: 'ad_group_criterion.quality_info.ad_relevance'".
const schema = {
  type: 'object',
  properties: { customer_id: { type: 'string' }, query: { type: 'string' } },
  required: ['query'],
};

function run(args: Record<string, unknown>, toolName = 'call_google_ads_reporting_api', inputSchema: any = schema) {
  const result = validateAndRepairToolArgs({ toolName, args, inputSchema, effect: 'read' });
  return { ...result, args: result.args as Record<string, string> };
}

describe('GAQL quality_info.ad_relevance repair (ENG-2581)', () => {
  const prodQuery = 'SELECT ad_group_criterion.keyword.text, ad_group_criterion.quality_info.quality_score, ad_group_criterion.quality_info.search_predicted_ctr, ad_group_criterion.quality_info.ad_relevance, ad_group_criterion.quality_info.post_click_quality_score FROM keyword_view';

  it('rewrites ad_relevance to creative_quality_score', () => {
    const result = run({ customer_id: '1', query: prodQuery });
    expect(result.status).toBe('repaired');
    expect(result.args.query).toBe(prodQuery.replace('quality_info.ad_relevance', 'quality_info.creative_quality_score'));
    expect(result.repairs).toContain('query:gaql_ad_relevance');
  });

  it('drops ad_relevance when creative_quality_score is already selected', () => {
    const q = 'SELECT ad_group_criterion.quality_info.creative_quality_score, ad_group_criterion.quality_info.ad_relevance, metrics.clicks FROM keyword_view';
    const result = run({ query: q });
    expect(result.args.query).toBe('SELECT ad_group_criterion.quality_info.creative_quality_score, metrics.clicks FROM keyword_view');
  });

  it('drops a trailing ad_relevance select item without leaving a dangling comma', () => {
    const q = 'SELECT ad_group_criterion.quality_info.creative_quality_score, ad_group_criterion.quality_info.ad_relevance FROM keyword_view';
    expect(run({ query: q }).args.query).toBe('SELECT ad_group_criterion.quality_info.creative_quality_score FROM keyword_view');
  });

  it('also repairs when no input schema is resolved', () => {
    const result = run({ query: prodQuery }, 'call_google_ads_reporting_api', undefined);
    expect(result.status).toBe('repaired');
    expect(result.args.query).not.toContain('ad_relevance');
  });

  it('leaves other tools and clean queries untouched', () => {
    expect(run({ query: prodQuery }, 'call_hubspot_api').args.query).toBe(prodQuery);
    const clean = 'SELECT campaign.id FROM campaign';
    const result = run({ query: clean });
    expect(result.args.query).toBe(clean);
    expect(result.repairs).not.toContain('query:gaql_ad_relevance');
  });
});
