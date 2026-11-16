/**
 * ENG-2950 (child of ENG-2912) — Meta Ads MCP parity coverage matrix.
 *
 * One row per Meta Ads MCP tool, mapped to the Zoma tool (and action, for multiplexed
 * tools) that covers it, or marked `gap` with the owning ENG child, or `not_applicable`.
 * `eng2950.zomaMetaParityMatrix.test.ts` checks every mapping against the advertised
 * Zoma manifest, so a row cannot point at a tool or action that does not exist.
 *
 * Official names are pinned in the seven-category documentation snapshot
 * `__tests__/__fixtures__/officialMetaAdsMcpTools.json`. The exact-set test
 * rejects missing names and abbreviated catalog aliases.
 *
 * Pure data. No provider calls, no persistence, no change to tool behavior or scopes.
 */

export type ParityStatus = 'covered' | 'gap' | 'not_applicable';

export interface ZomaOperation {
  tool: string;
  /** For multiplexed tools (call_meta_marketing_api, zoma_custom_audiences). */
  action?: string;
  entityType?: string;
}

export interface ParityRow {
  metaTool: string;
  category: string;
  /** ENG child whose "Meta parity:" list names this tool. */
  source: string;
  status: ParityStatus;
  zoma?: ZomaOperation;
  /** Required for gap rows: the ENG issue that owns closing it. */
  owner?: string;
  /** Required for not_applicable rows. */
  reason?: string;
}

const MMA = 'call_meta_marketing_api';
const AUD = 'zoma_custom_audiences';

const covered = (category: string, source: string, metaTool: string, zoma: ZomaOperation): ParityRow =>
  ({ metaTool, category, source, status: 'covered', zoma });
const gap = (category: string, source: string, metaTool: string, owner = source): ParityRow =>
  ({ metaTool, category, source, status: 'gap', owner });
const same = (category: string, source: string, name: string): ParityRow => covered(category, source, name, { tool: name });
const notApplicable = (category: string, source: string, metaTool: string, reason: string): ParityRow =>
  ({ metaTool, category, source, status: 'not_applicable', reason });

/** ENG-3031: what was checked before a Reporting row was marked not_applicable. */
const NO_PUBLIC_INSIGHTS_ENDPOINT =
  'No public Graph endpoint or field: not in the Ad Account reference (fields and edges) or the Ad Account / Campaign / Ad Set Insights references, checked 2026-11-15.';

/** ENG-3056: what was checked before the six pixel rule write rows were marked not_applicable. */
const NO_PUBLIC_PIXEL_RULE_WRITE =
  'No public Graph write: the Ads Pixel event_rules and extractors edge references each state that creating, updating and deleting cannot be performed on the endpoint, the Ad Pixel reference lists no other rule edge, and the rule nodes (CalibratorExistingRule, SignalsIWLExtractor) have no reference page, checked 2026-11-16.';

const EDITS = 'Campaign management';
const AUDS = 'Audiences';
const CRE = 'Creatives';
const REP = 'Reporting & insights';
const SIG = 'Signals';
const CAT = 'Catalogs';
const EXP = 'Experiments';
const PG = 'Pages, Instagram & Ad Library';
const DIA = 'Diagnostics & help';

export const ZOMA_META_PARITY_MATRIX: readonly ParityRow[] = [
  // ENG-2913 — base discovery/lifecycle names are part of the official inventory.
  // ENG-3034: create and activate are the guarded call_meta_marketing_api writes
  // (always created PAUSED; status=ACTIVE is its own preview and approval), proven
  // per entity in eng3034.campaignManagementParity.test.ts. The two read rows are
  // still gaps, owned by ENG-3040.
  gap(EDITS, 'ENG-2913', 'ads_get_ad_accounts', 'ENG-3040'),
  covered(EDITS, 'ENG-2913', 'ads_create_campaign', { tool: MMA, action: 'CREATE', entityType: 'CAMPAIGN' }),
  covered(EDITS, 'ENG-2913', 'ads_create_ad_set', { tool: MMA, action: 'CREATE', entityType: 'AD_SET' }),
  covered(EDITS, 'ENG-2913', 'ads_create_ad', { tool: MMA, action: 'CREATE', entityType: 'AD' }),
  covered(EDITS, 'ENG-2913', 'ads_activate_entity', { tool: MMA, action: 'UPDATE' }),
  covered(EDITS, 'ENG-2913', 'ads_update_entity', { tool: MMA, action: 'UPDATE' }),
  gap(EDITS, 'ENG-2913', 'ads_get_field_context', 'ENG-3040'),
  covered(EDITS, 'ENG-2913', 'ads_get_ad_preview', { tool: MMA, action: 'PREVIEW', entityType: 'AD' }),

  // ENG-2914
  covered(AUDS, 'ENG-2914', 'ads_get_ad_account_custom_audiences', { tool: AUD, action: 'LIST' }),
  covered(AUDS, 'ENG-2914', 'ads_get_custom_audience', { tool: AUD, action: 'GET' }),
  covered(AUDS, 'ENG-2914', 'ads_get_custom_audience_adsets', { tool: AUD, action: 'LIST_AD_SETS' }),
  covered(AUDS, 'ENG-2914', 'ads_create_custom_audience', { tool: AUD, action: 'CREATE' }),
  covered(AUDS, 'ENG-2914', 'ads_update_custom_audience', { tool: AUD, action: 'UPDATE' }),
  covered(AUDS, 'ENG-2914', 'ads_update_custom_audience_users', { tool: AUD, action: 'ADD_USERS' }),
  covered(AUDS, 'ENG-2914', 'ads_delete_custom_audience', { tool: AUD, action: 'DELETE' }),

  // ENG-2915
  covered(CRE, 'ENG-2915', 'ads_create_creative', { tool: MMA, action: 'CREATE', entityType: 'AD_CREATIVE' }),
  covered(CRE, 'ENG-2915', 'ads_get_creatives', { tool: MMA, action: 'LIST', entityType: 'AD_CREATIVE' }),
  covered(CRE, 'ENG-2915', 'ads_get_creative_ads', { tool: MMA, action: 'LIST', entityType: 'AD' }),
  gap(CRE, 'ENG-2915', 'ads_get_ad_images'),
  gap(CRE, 'ENG-2915', 'ads_get_ad_videos'),

  // ENG-2916
  gap(REP, 'ENG-2916', 'ads_get_opportunity_score'),
  // ENG-3031: these three are computed inside Meta's own MCP server. No public Marketing API
  // endpoint or field was found for them, and a substitute score of our own is out of scope.
  notApplicable(REP, 'ENG-3031', 'ads_insights_advertiser_context', NO_PUBLIC_INSIGHTS_ENDPOINT),
  notApplicable(REP, 'ENG-3031', 'ads_insights_anomaly_signal', NO_PUBLIC_INSIGHTS_ENDPOINT),
  // ENG-3031: Meta's public auction comparison is the three ad relevance diagnostics, which
  // call_meta_ads_insights_api already accepts as fields (quality_ranking,
  // engagement_rate_ranking, conversion_rate_ranking). eng3031 test pins that.
  covered(REP, 'ENG-3031', 'ads_insights_auction_ranking_benchmarks', { tool: 'call_meta_ads_insights_api' }),
  notApplicable(REP, 'ENG-3031', 'ads_insights_industry_benchmark', NO_PUBLIC_INSIGHTS_ENDPOINT),
  covered(REP, 'ENG-2916', 'ads_insights_performance_trend', { tool: 'call_meta_ads_insights_api' }),
  gap(REP, 'ENG-2916', 'ads_get_ad_entities'),

  // ENG-2917
  same(SIG, 'ENG-2917', 'ads_get_datasets'),
  same(SIG, 'ENG-2917', 'ads_get_dataset_details'),
  same(SIG, 'ENG-2917', 'ads_get_dataset_stats'),
  covered(SIG, 'ENG-2917', 'ads_get_dataset_quality', { tool: MMA, action: 'GET_MATCH_QUALITY', entityType: 'DATASET' }),
  same(SIG, 'ENG-2917', 'ads_pixel_event_read'),
  notApplicable(SIG, 'ENG-3056', 'ads_pixel_event_create', NO_PUBLIC_PIXEL_RULE_WRITE),
  notApplicable(SIG, 'ENG-3056', 'ads_pixel_event_update', NO_PUBLIC_PIXEL_RULE_WRITE),
  notApplicable(SIG, 'ENG-3056', 'ads_pixel_event_delete', NO_PUBLIC_PIXEL_RULE_WRITE),
  same(SIG, 'ENG-3055', 'ads_pixel_parameter_read'),
  notApplicable(SIG, 'ENG-3056', 'ads_pixel_parameter_create', NO_PUBLIC_PIXEL_RULE_WRITE),
  notApplicable(SIG, 'ENG-3056', 'ads_pixel_parameter_update', NO_PUBLIC_PIXEL_RULE_WRITE),
  notApplicable(SIG, 'ENG-3056', 'ads_pixel_parameter_delete', NO_PUBLIC_PIXEL_RULE_WRITE),
  same(SIG, 'ENG-2917', 'ads_get_customconversions'),

  // ENG-2918 (canonical official Meta tool names)
  covered(CAT, 'ENG-2918', 'ads_catalog_create', { tool: 'meta_catalog_create' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_update_catalog', { tool: 'meta_catalog_update' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_list_catalogs', { tool: 'meta_list_catalogs' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_list_dpa_eligible_catalogs', { tool: 'meta_list_dpa_eligible_catalogs' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_get_diagnostics', { tool: 'meta_get_catalog_diagnostics' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_get_dynamic_ads_health', { tool: 'meta_get_dynamic_ads_health' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_get_data_sources', { tool: 'meta_get_catalog_data_sources' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_list_products', { tool: 'meta_list_products' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_product_create', { tool: 'meta_product_create' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_update_product', { tool: 'meta_update_product' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_delete_product', { tool: 'meta_delete_product' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_get_suggested_filter', { tool: 'meta_get_suggested_filter' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_create_product_set', { tool: 'meta_product_set_create' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_update_product_set', { tool: 'meta_product_set_update' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_list_product_sets', { tool: 'meta_list_product_sets' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_product_set_delete', { tool: 'meta_product_set_delete' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_create_product_feed', { tool: 'meta_product_feed_create' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_update_product_feed', { tool: 'meta_product_feed_update' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_list_product_feeds', { tool: 'meta_list_product_feeds' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_product_feed_delete', { tool: 'meta_product_feed_delete' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_create_product_feed_upload_session', { tool: 'meta_feed_upload_create' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_get_product_feed_upload_sessions', { tool: 'meta_feed_upload_get' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_create_feed_rule', { tool: 'meta_feed_rule_create' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_get_feed_rules', { tool: 'meta_feed_rule_get' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_product_feed_delete_rule', { tool: 'meta_feed_rule_delete' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_event_source_get', { tool: 'meta_event_source_get' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_event_source_get_catalogs', { tool: 'meta_event_source_get_catalogs' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_event_source_get_health', { tool: 'meta_event_source_get_health' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_event_source_get_recommendations', { tool: 'meta_event_source_get_recommendations' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_event_source_connect', { tool: 'meta_event_source_connect' }),
  covered(CAT, 'ENG-2918', 'ads_catalog_event_source_disconnect', { tool: 'meta_event_source_disconnect' }),

  // ENG-2919
  same(EXP, 'ENG-2919', 'ads_experiment_list_tests'),
  same(EXP, 'ENG-2980', 'ads_experiment_check_eligibility'),
  same(EXP, 'ENG-2980', 'ads_experiment_abtest_create_test'),
  same(EXP, 'ENG-2919', 'ads_experiment_abtest_get_test'),
  same(EXP, 'ENG-2980', 'ads_experiment_abtest_update_test'),
  same(EXP, 'ENG-2980', 'ads_experiment_lift_create_test'),
  same(EXP, 'ENG-2919', 'ads_experiment_lift_get_test'),

  // ENG-2920
  same(PG, 'ENG-2920', 'ads_get_ad_account_pages'),
  same(PG, 'ENG-2920', 'ads_get_pages_for_business'),
  same(PG, 'ENG-2920', 'ads_get_user_pages'),
  same(PG, 'ENG-2920', 'ads_get_ig_accounts'),
  same(PG, 'ENG-2920', 'ads_get_ig_media'),
  gap(PG, 'ENG-2920', 'ads_boost_ig_post'),
  same(PG, 'ENG-2920', 'ads_library_search'),

  // ENG-2921
  same(DIA, 'ENG-2921', 'ads_account_get_activity_logs'),
  same(DIA, 'ENG-2921', 'ads_get_errors'),
  same(DIA, 'ENG-2921', 'ads_get_help_article'),
];

export interface ParitySummaryRow { category: string; covered: number; gap: number; not_applicable: number; total: number }

export function summarizeParity(rows: readonly ParityRow[] = ZOMA_META_PARITY_MATRIX): ParitySummaryRow[] {
  const by = new Map<string, ParitySummaryRow>();
  for (const r of rows) {
    const s = by.get(r.category) ?? { category: r.category, covered: 0, gap: 0, not_applicable: 0, total: 0 };
    s[r.status] += 1;
    s.total += 1;
    by.set(r.category, s);
  }
  return [...by.values()];
}

export function formatParitySummary(rows: readonly ParityRow[] = ZOMA_META_PARITY_MATRIX): string {
  const sums = summarizeParity(rows);
  const all = sums.reduce((a, s) => ({ covered: a.covered + s.covered, gap: a.gap + s.gap, na: a.na + s.not_applicable, total: a.total + s.total }), { covered: 0, gap: 0, na: 0, total: 0 });
  const lines = sums.map((s) => `${s.category}: covered ${s.covered} / gap ${s.gap} / n/a ${s.not_applicable} (of ${s.total})`);
  lines.push(`TOTAL: covered ${all.covered} / gap ${all.gap} / n/a ${all.na} (of ${all.total})`);
  return lines.join('\n');
}
