/**
 * ENG-2950 (child of ENG-2912) — Meta Ads MCP parity coverage matrix.
 *
 * One row per Meta Ads MCP tool, mapped to the Zoma tool (and action, for multiplexed
 * tools) that covers it, or marked `gap` with the owning ENG child, or `not_applicable`.
 * `eng2950.zomaMetaParityMatrix.test.ts` checks every mapping against the advertised
 * Zoma manifest, so a row cannot point at a tool or action that does not exist.
 *
 * Source of Meta tool names: the "Meta parity:" lists in ENG-2912's category children
 * (ENG-2913..2921). ENG-2918 abbreviates its 31 catalog tools; those rows use the labels
 * exactly as written there, expanded only where the issue writes "create/update/list/delete".
 * The epic cites 88 Meta tools; the research file it references was not on disk, so rows
 * beyond the child lists must be added when that list is recovered (see ENG-2950).
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
  // ENG-2913
  covered(EDITS, 'ENG-2913', 'ads_update_entity', { tool: MMA, action: 'UPDATE' }),
  gap(EDITS, 'ENG-2913', 'ads_get_field_context'),
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
  gap(REP, 'ENG-2916', 'ads_insights_advertiser_context'),
  gap(REP, 'ENG-2916', 'ads_insights_anomaly_signal'),
  gap(REP, 'ENG-2916', 'ads_insights_auction_ranking_benchmarks'),
  gap(REP, 'ENG-2916', 'ads_insights_industry_benchmark'),
  covered(REP, 'ENG-2916', 'ads_insights_performance_trend', { tool: 'call_meta_ads_insights_api' }),
  gap(REP, 'ENG-2916', 'ads_get_ad_entities'),

  // ENG-2917
  same(SIG, 'ENG-2917', 'ads_get_datasets'),
  same(SIG, 'ENG-2917', 'ads_get_dataset_details'),
  same(SIG, 'ENG-2917', 'ads_get_dataset_stats'),
  covered(SIG, 'ENG-2917', 'ads_get_dataset_quality', { tool: MMA, action: 'GET_MATCH_QUALITY', entityType: 'DATASET' }),
  same(SIG, 'ENG-2917', 'ads_pixel_event_read'),
  gap(SIG, 'ENG-2917', 'ads_pixel_event_create'),
  gap(SIG, 'ENG-2917', 'ads_pixel_event_update'),
  gap(SIG, 'ENG-2917', 'ads_pixel_event_delete'),
  gap(SIG, 'ENG-2917', 'ads_pixel_parameter_read'),
  gap(SIG, 'ENG-2917', 'ads_pixel_parameter_create'),
  gap(SIG, 'ENG-2917', 'ads_pixel_parameter_update'),
  gap(SIG, 'ENG-2917', 'ads_pixel_parameter_delete'),
  same(SIG, 'ENG-2917', 'ads_get_customconversions'),

  // ENG-2918 (labels as written in the issue)
  covered(CAT, 'ENG-2918', 'ads_catalog_create', { tool: 'meta_catalog_create' }),
  covered(CAT, 'ENG-2918', 'update_catalog', { tool: 'meta_catalog_update' }),
  covered(CAT, 'ENG-2918', 'list_catalogs', { tool: 'meta_list_catalogs' }),
  covered(CAT, 'ENG-2918', 'list_dpa_eligible_catalogs', { tool: 'meta_list_dpa_eligible_catalogs' }),
  covered(CAT, 'ENG-2918', 'get_diagnostics', { tool: 'meta_get_catalog_diagnostics' }),
  covered(CAT, 'ENG-2918', 'get_dynamic_ads_health', { tool: 'meta_get_dynamic_ads_health' }),
  covered(CAT, 'ENG-2918', 'get_data_sources', { tool: 'meta_get_catalog_data_sources' }),
  covered(CAT, 'ENG-2918', 'list_products', { tool: 'meta_list_products' }),
  covered(CAT, 'ENG-2918', 'product_create', { tool: 'meta_product_create' }),
  covered(CAT, 'ENG-2918', 'update_product', { tool: 'meta_update_product' }),
  covered(CAT, 'ENG-2918', 'delete_product', { tool: 'meta_delete_product' }),
  covered(CAT, 'ENG-2918', 'get_suggested_filter', { tool: 'meta_get_suggested_filter' }),
  covered(CAT, 'ENG-2918', 'product_set_create', { tool: 'meta_product_set_create' }),
  covered(CAT, 'ENG-2918', 'product_set_update', { tool: 'meta_product_set_update' }),
  covered(CAT, 'ENG-2918', 'product_set_list', { tool: 'meta_list_product_sets' }),
  covered(CAT, 'ENG-2918', 'product_set_delete', { tool: 'meta_product_set_delete' }),
  covered(CAT, 'ENG-2918', 'product_feed_create', { tool: 'meta_product_feed_create' }),
  covered(CAT, 'ENG-2918', 'product_feed_update', { tool: 'meta_product_feed_update' }),
  covered(CAT, 'ENG-2918', 'product_feed_list', { tool: 'meta_list_product_feeds' }),
  covered(CAT, 'ENG-2918', 'product_feed_delete', { tool: 'meta_product_feed_delete' }),
  covered(CAT, 'ENG-2918', 'feed_upload_session_create', { tool: 'meta_feed_upload_create' }),
  covered(CAT, 'ENG-2918', 'feed_upload_session_get', { tool: 'meta_feed_upload_get' }),
  covered(CAT, 'ENG-2918', 'feed_rule_create', { tool: 'meta_feed_rule_create' }),
  covered(CAT, 'ENG-2918', 'feed_rule_get', { tool: 'meta_feed_rule_get' }),
  covered(CAT, 'ENG-2918', 'feed_rule_delete', { tool: 'meta_feed_rule_delete' }),
  covered(CAT, 'ENG-2918', 'event_source_get', { tool: 'meta_event_source_get' }),
  covered(CAT, 'ENG-2918', 'event_source_get_catalogs', { tool: 'meta_event_source_get_catalogs' }),
  covered(CAT, 'ENG-2918', 'event_source_get_health', { tool: 'meta_event_source_get_health' }),
  covered(CAT, 'ENG-2918', 'event_source_get_recommendations', { tool: 'meta_event_source_get_recommendations' }),
  covered(CAT, 'ENG-2918', 'event_source_connect', { tool: 'meta_event_source_connect' }),
  covered(CAT, 'ENG-2918', 'event_source_disconnect', { tool: 'meta_event_source_disconnect' }),

  // ENG-2919
  same(EXP, 'ENG-2919', 'ads_experiment_list_tests'),
  gap(EXP, 'ENG-2919', 'ads_experiment_check_eligibility'),
  gap(EXP, 'ENG-2919', 'ads_experiment_abtest_create_test'),
  same(EXP, 'ENG-2919', 'ads_experiment_abtest_get_test'),
  gap(EXP, 'ENG-2919', 'ads_experiment_abtest_update_test'),
  gap(EXP, 'ENG-2919', 'ads_experiment_lift_create_test'),
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
