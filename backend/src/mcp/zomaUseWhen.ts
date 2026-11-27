/**
 * "Use when…" lead-ins for the tools the Zoma MCP server advertises.
 *
 * Claude and ChatGPT pick a tool by matching the user's own words against its description, and our
 * technical descriptions ("Meta Marketing API for external agents…") rarely contain them. Each tool
 * gets one sentence in plain user language, put in FRONT of its existing description; the existing
 * text (including every PREVIEW / confirm / preview_token / read-only rule) follows verbatim.
 *
 * Applied only by the Zoma manifest getters, so Emma's own registry descriptions are unchanged.
 * Every advertised tool must have an entry (zomaUseWhen.test.ts).
 */
export const ZOMA_USE_WHEN: Readonly<Record<string, string>> = {
  // Meta (Facebook / Instagram) ads — campaigns, reporting, changes
  list_meta_ads_campaigns: 'asks what Facebook or Instagram ad campaigns they have, or which ones are running or paused',
  get_meta_ads_metrics: 'asks how their Facebook or Instagram campaigns are doing, with age, placement or device breakdowns',
  call_meta_ads_insights_api: 'wants custom Facebook or Instagram ad numbers (specific metrics, dates or breakdowns such as by day, age or placement)',
  call_meta_marketing_api:
    'wants to pause, turn on, edit, duplicate, delete or create Facebook or Instagram campaigns, ad sets or ads, change a budget, targeting or schedule, or upload ad images and videos',
  ads_get_datasets: 'asks which Meta pixels or datasets are on their ad account',
  ads_get_dataset_details: 'asks about the details of one Meta pixel or dataset',
  ads_get_dataset_stats: 'asks whether their Meta pixel is firing or which events it is receiving',
  ads_pixel_event_read: 'asks how their Meta pixel event rules are set up',
  ads_get_customconversions: 'asks which custom conversions are set up on their Meta ad account',
  ads_experiment_list_tests: 'asks what A/B tests or lift studies are on their Facebook or Instagram ad account',
  ads_experiment_abtest_get_test: 'asks about the setup or status of one Facebook or Instagram A/B test',
  ads_experiment_lift_get_test: 'asks about the setup or status of one Meta conversion lift study',
  ads_experiment_check_eligibility: 'asks whether their Facebook or Instagram campaigns can be put into an A/B test or lift study',
  ads_experiment_abtest_create_test: 'wants to A/B test two or more Facebook or Instagram campaigns against each other',
  ads_experiment_abtest_update_test: 'wants to rename or change the dates of a Facebook or Instagram A/B test',
  ads_experiment_lift_create_test: 'wants to measure whether their Facebook or Instagram ads actually cause extra conversions (a lift study with a holdout group)',
  ads_get_help_article: 'asks how something works in Meta ads or wants Meta\'s official help for an error',
  ads_account_get_activity_logs: 'asks who changed their Facebook ad account, or what changed and when',
  ads_get_errors: 'asks what a Meta ads error code or error message means and how to fix it',
  meta_account_health: 'asks why their Facebook or Instagram ads aren\'t spending or delivering, whether the ad account is disabled, or about the account spending limit',
  meta_learning_phase: 'asks whether their Facebook ad sets are still in the learning phase or "learning limited", or before editing a live ad set',
  // Catalogs, products and Advantage+ catalog (dynamic product) ads
  meta_list_catalogs: 'asks which product catalogs (shop or inventory feeds) their Meta ad account can use',
  meta_list_products: 'asks which products are in their Meta catalog, or why products are rejected',
  meta_list_product_sets: 'asks which product sets are in their Meta catalog',
  meta_list_product_feeds: 'asks why products are missing or out of date in their Meta catalog, or about their product feeds',
  meta_list_dpa_eligible_catalogs: 'asks which catalogs are ready for dynamic product ads (Advantage+ catalog ads)',
  meta_get_catalog_diagnostics: 'asks why products in their Meta catalog are rejected or not showing in ads',
  meta_get_dynamic_ads_health: 'asks whether a catalog is ready for dynamic product or retargeting ads, or what is blocking them',
  meta_get_catalog_data_sources: 'asks where a Meta catalog gets its products from, or which pixel feeds its retargeting',
  meta_product_create: 'wants to add a product to their Meta catalog',
  meta_update_product: 'wants to change a product\'s name, price, availability, link or image in their Meta catalog',
  meta_delete_product: 'wants to remove a product from their Meta catalog',
  meta_get_suggested_filter: 'wants to build a group of products (by brand, price, type or availability) for a product set',
  meta_product_set_create: 'wants to create a product set for catalog ads (e.g. "only show my sale items")',
  meta_product_set_update: 'wants to rename a product set or change which products it includes',
  meta_product_set_delete: 'wants to delete a product set from their Meta catalog',
  meta_event_source_get: 'asks which pixels are connected to a Meta catalog',
  meta_event_source_get_catalogs: 'asks which catalogs a Meta pixel is connected to',
  meta_event_source_get_health: 'asks whether a Meta pixel is working, when it last fired, or which catalogs it feeds',
  meta_event_source_get_recommendations: 'asks what to fix in a catalog\'s pixel setup (missing connection, pixel not firing)',
  meta_event_source_connect: 'wants to connect their Meta pixel to a catalog for dynamic product or retargeting ads',
  meta_event_source_disconnect: 'wants to disconnect a Meta pixel from a catalog',
  meta_catalog_create: 'wants to create a new product catalog in Meta',
  meta_catalog_update: 'wants to rename a Meta product catalog',
  meta_product_feed_create: 'wants to add a product feed to a Meta catalog, such as a spreadsheet or feed URL that updates on a schedule',
  meta_product_feed_update: 'wants to rename a Meta product feed or change how often it updates',
  meta_product_feed_delete: 'wants to delete a product feed from a Meta catalog',
  meta_feed_upload_create: 'wants to re-upload or refresh a Meta product feed now',
  meta_feed_upload_get: 'asks whether a Meta product feed upload worked or what errors it had',
  meta_feed_rule_create: 'wants to fix or map a column in their Meta product feed automatically',
  meta_feed_rule_get: 'asks what rules are set on a Meta product feed',
  meta_feed_rule_delete: 'wants to remove a rule from a Meta product feed',
  // Pages, Instagram, Ad Library, boosting
  ads_get_ad_account_pages: 'asks which Facebook Pages they can run ads as',
  ads_get_pages_for_business: 'asks which Facebook Pages their Meta business owns or has access to',
  ads_get_user_pages: 'asks which Facebook Pages they manage',
  ads_get_ig_accounts: 'asks which Instagram accounts they can run ads as',
  ads_get_ig_media: 'wants to see their recent Instagram posts, e.g. to pick one to boost',
  ads_library_search: 'wants to see competitor ads or what ads a brand is running on Facebook and Instagram (Meta Ad Library)',
  ads_boost_ig_post: 'wants to boost or promote an Instagram post',
  // Zoma account, uploads, audiences, reports
  zoma_status: 'is getting started, wants to connect their ad account, or asks why Zoma can\'t make changes yet',
  zoma_usage: 'asks how much Zoma they have used this month or about their plan, overage or bill',
  zoma_prepare_upload: 'wants to use an image or video file on their computer in an ad',
  zoma_custom_audiences:
    'wants to create or edit a Facebook or Instagram audience (retargeting website visitors, a customer email list, a lookalike) or exclude existing customers from ads',
  zoma_industry_benchmark: 'asks whether their cost per lead or purchase is good, or how their Facebook ads compare with their industry',
  zoma_ads_report: 'asks how their Facebook or Instagram ads are doing, what they spent, or which campaign performs best',
  zoma_measurement_report: 'wants a full, shareable performance report of their Facebook and Instagram ads',
  zoma_report_schedule: 'wants to change, pause or stop the regular ad report emails, or set their industry for comparisons',
  // Google Ads
  call_google_ads_api:
    'wants to create, pause, turn on or edit Google search ads, campaigns, ad groups, keywords, negative keywords, budgets or Performance Max campaigns',
  call_google_ads_reporting_api: 'asks how their Google Ads are doing, what they spent, which keywords work, or whether their Google search ads are actually running',
  // X (Twitter) Ads
  x_ads_read: 'asks about their X (Twitter) ad campaigns or how they are performing',
  x_ads_write: 'wants to create, pause or turn on X (Twitter) ad campaigns, change their budget or bid, or promote existing posts',
  // LinkedIn Ads
  linkedin_ads_read: 'asks about their LinkedIn ad campaigns, how they are performing, or how big a LinkedIn audience would be',
  linkedin_ads_write: 'wants to create, pause or turn on LinkedIn ad campaigns or ads, or change a LinkedIn campaign budget or bid',
};

/** Prefix each known tool's description with its "Use when the user …." lead-in; other tools pass through unchanged. */
export function withUseWhen<T extends { name?: string; description?: string }>(tools: T[]): T[] {
  return tools.map((tool) => {
    const lead = tool.name ? ZOMA_USE_WHEN[tool.name] : undefined;
    if (!lead || typeof tool.description !== 'string') return tool;
    return { ...tool, description: `Use when the user ${lead}. ${tool.description}` };
  });
}
