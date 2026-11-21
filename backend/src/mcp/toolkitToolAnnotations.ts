/**
 * ENG-2747 — MCP tool annotations (readOnlyHint / destructiveHint / idempotentHint / openWorldHint)
 * for every tool the Zoma toolkit advertises (Meta tools, Zoma onboarding tools, Google Ads tools).
 *
 * Why: marketplaces and MCP gateways (Databricks Unity Gateway, ChatGPT apps, the Claude directory)
 * use these hints to decide which calls need human approval. Before this, `tools/list` and
 * `GET /api/meta-toolkit/tools` returned only name, description and schema.
 *
 * Rule: a hint must never understate what a call can do. So the table is deny-by-default:
 *
 *   - A tool is read-only ONLY if its name is in READ_ONLY_TOOLKIT_TOOLS below.
 *   - Every other tool, including any tool added later that nobody has classified, is labelled
 *     a destructive write (readOnlyHint false, destructiveHint true). Nothing throws and nothing
 *     is dropped: forgetting to classify a new tool makes clients prompt more, never less.
 *   - A few non-read tools that are not destructive are listed in EXPLICIT_ANNOTATIONS.
 *
 * TO MARK A NEW READ TOOL read-only: add its name to READ_ONLY_TOOLKIT_TOOLS, after checking its
 * handler issues no write to Meta/Google or to our own state beyond usage metering.
 *
 * Tools that carry both reads and writes behind one name (call_meta_marketing_api,
 * zoma_custom_audiences, call_google_ads_api) stay on the conservative default, so a client that
 * honours the hint gates every call to them, reads included. Splitting them into read and write
 * tools is separate work.
 *
 * Inline `annotations` on a tool definition are ignored on purpose: this table is the one place
 * that decides, so a new tool cannot declare itself read-only by accident.
 */

export interface ToolkitToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const READ_ONLY: ToolkitToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const CONSERVATIVE_DEFAULT: ToolkitToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * Tools verified read-only on 2026-11-12 (origin/main 5436fc962): the handler only issues reads.
 * Judgment calls:
 *  - call_meta_ads_insights_api creates Meta's transient async report run to fetch rows; it
 *    changes no ad, budget or status.
 *  - call_google_ads_reporting_api is documented read-only in googleToolkitManifest.ts.
 */
export const READ_ONLY_TOOLKIT_TOOLS: ReadonlySet<string> = new Set([
  // Meta: campaigns and reporting
  'list_meta_ads_campaigns',
  'get_meta_ads_metrics',
  'call_meta_ads_insights_api',
  // Meta: datasets, pixels, conversions
  'ads_get_datasets',
  'ads_get_dataset_details',
  'ads_get_dataset_stats',
  'ads_pixel_event_read',
  'ads_get_customconversions',
  // Meta: experiments, activity, diagnostics
  'ads_experiment_list_tests',
  'ads_experiment_abtest_get_test',
  'ads_experiment_lift_get_test',
  'ads_experiment_check_eligibility',
  'ads_account_get_activity_logs',
  'meta_account_health',
  'meta_learning_phase',
  // Meta: catalogs, feeds, event sources (read tools only)
  'meta_list_catalogs',
  'meta_list_products',
  'meta_list_product_sets',
  'meta_list_product_feeds',
  'meta_list_dpa_eligible_catalogs',
  'meta_get_catalog_diagnostics',
  'meta_get_dynamic_ads_health',
  'meta_get_catalog_data_sources',
  'meta_get_suggested_filter',
  'meta_event_source_get',
  'meta_event_source_get_catalogs',
  'meta_event_source_get_health',
  'meta_event_source_get_recommendations',
  'meta_feed_upload_get',
  'meta_feed_rule_get',
  // Meta: pages, Instagram, Ad Library
  'ads_get_ad_account_pages',
  'ads_get_pages_for_business',
  'ads_get_user_pages',
  'ads_get_ig_accounts',
  'ads_get_ig_media',
  'ads_library_search',
  // ENG-3040: one GET of each connected account's own act_<id> node
  'ads_get_ad_accounts',
  // Zoma reporting (ENG-3134): one Meta insights read
  'zoma_ads_report',
  // Zoma industry benchmark (ENG-3156): insights + ad creatives reads, static benchmark table
  'zoma_industry_benchmark',
  // Google Ads
  'call_google_ads_reporting_api',
  // X Ads (ENG-3142): x_ads_read only issues GETs (lists + synchronous stats). x_ads_write stays on the default.
  'x_ads_read',
]);

/** Tools that are not read-only but whose effect is narrower than the conservative default. */
const EXPLICIT_ANNOTATIONS: Readonly<Record<string, ToolkitToolAnnotations>> = Object.freeze({
  // Explains an error code from a static table; makes no Meta call.
  ads_get_help_article: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ads_get_errors: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // Reads this user's own usage record; talks to no outside service.
  zoma_usage: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // Mints a Stripe setup link when payment is missing (can create a Stripe customer and Checkout session).
  zoma_status: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  // Mints a one-time presigned upload URL under the caller's own prefix.
  zoma_prepare_upload: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  // ENG-3155: reads Meta insights and CRM data; its only write is the hosted copy of the report itself.
  zoma_measurement_report: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  // ENG-3155: changes only Zoma's own report-email schedule, never the ads.
  zoma_report_schedule: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});

/** Annotations for one tool name. Always returns a fresh object; never throws. */
export function getToolkitToolAnnotations(name: string): ToolkitToolAnnotations {
  if (Object.prototype.hasOwnProperty.call(EXPLICIT_ANNOTATIONS, name)) return { ...EXPLICIT_ANNOTATIONS[name] };
  if (READ_ONLY_TOOLKIT_TOOLS.has(name)) return { ...READ_ONLY };
  return { ...CONSERVATIVE_DEFAULT };
}

/** Attach annotations to every advertised tool definition (returns new objects). */
export function annotateToolkitTools<T extends { name: string }>(defs: T[]): Array<T & { annotations: ToolkitToolAnnotations }> {
  return defs.map((def) => ({ ...def, annotations: getToolkitToolAnnotations(def.name) }));
}
