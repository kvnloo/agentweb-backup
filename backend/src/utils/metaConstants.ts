export const ALLOWED_NODE_TYPES = [
  'account',
  'campaign',
  'adset',
  'ad'
] as const;

export type AllowedNodeType = typeof ALLOWED_NODE_TYPES[number];

export const ALLOWED_INSIGHTS_FIELDS = [
  // DELIVERY METRICS
  'account_id',
  'account_name',
  'campaign_id',
  'campaign_name',
  'adset_id',
  'adset_name',
  'ad_id',
  'ad_name',
  'date_start',
  'date_stop',

  // CORE PERFORMANCE
  'impressions',
  'reach',
  'frequency',
  'clicks',
  'unique_clicks',
  'inline_link_clicks',
  'unique_inline_link_clicks',
  'ctr',
  'unique_ctr',
  'inline_link_click_ctr',
  'unique_inline_link_click_ctr',
  'spend',
  'cpc',
  'cpm',
  'cpp',
  // COST-PER-CLICK DERIVED METRICS
  // Genuinely valid Meta Insights fields that were missing from the whitelist.
  // Their absence caused scheduled campaign check-ins to be hard-rejected and
  // retried until the loop guard blocked the whole insights channel (ENG-511).
  'cost_per_inline_link_click',
  'cost_per_unique_inline_link_click',
  'cost_per_unique_click',

  // VIDEO METRICS
  'video_views',
  'video_plays',
  'video_avg_time_watched_actions',
  'video_p25_watched_actions',
  'video_p50_watched_actions',
  'video_p75_watched_actions',
  'video_p95_watched_actions',
  'video_p100_watched_actions',
  'video_play_actions',
  'cost_per_thruplay',
  'video_thruplay_watched_actions',

  // ENGAGEMENT
  'actions',
  'unique_actions',
  'action_values',
  'cost_per_action_type',
  'cost_per_unique_action_type',
  'cost_per_inline_post_engagement',
  'engagement_rate_ranking',
  'quality_ranking',
  'conversion_rate_ranking',

  // CONVERSIONS
  'conversions',
  'conversion_values',
  'cost_per_conversion',
  'website_purchase_roas',
  'purchase_roas',
  'mobile_app_purchase_roas',
  'catalog_segment_value',
  'store_visit_actions',
  'cost_per_store_visit_action',

  // ATTRIBUTION & SALES
  'attribution_setting',
  'website_ctr',
  'website_purchase_conversion_rate',
  'omni_purchase_roas',
  'outbound_clicks',
  'unique_outbound_clicks',
  'outbound_clicks_ctr',
  'unique_outbound_clicks_ctr',
  'cost_per_outbound_click',

  // APP EVENTS
  'app_installs',
  'cost_per_app_install',
  'mobile_app_install_rate',

  // LEAD GENERATION
  'leads',
  'cost_per_lead',
  'onsite_conversion_lead_grouped',
  'cost_per_onsite_conversion',

  // MESSAGING
  'messaging_conversations_started',
  'cost_per_messaging_conversation_started',

  // SHOPPING & CATALOG
  'catalog_segment_actions',
  'catalog_segment_value',
  'cost_per_catalog_segment_action',

  // DIAGNOSTICS
  'estimated_ad_recall_rate',
  'estimated_ad_recallers',
  'full_view_impressions',
  'cost_per_full_view'
];

/** Levenshtein edit distance — small helper for typo/near-miss field suggestions. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * ENG-511: Suggest the closest valid insights field for a dropped/unknown one, so
 * the model can correct a typo or loose phrasing (e.g. `impression` -> `impressions`,
 * `link_clicks` -> `inline_link_clicks`) instead of just seeing the field vanish.
 * Returns null when nothing is plausibly the same intent (e.g. a made-up metric) —
 * a wrong suggestion would be worse than none. This only produces a hint; it never
 * substitutes the field, so the tool never returns a metric the caller did not ask for.
 */
export function suggestInsightsField(name: string): string | null {
  const n = (name || '').toLowerCase().trim();
  if (!n) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const f of ALLOWED_INSIGHTS_FIELDS) {
    let dist = editDistance(n, f);
    // Reward containment (common when the model uses a looser phrasing like
    // `link_clicks` for `inline_link_clicks`). Guard against tiny fragments so
    // short field names don't match everything. Prefer a field that contains the
    // whole query (a more specific field) over the reverse, so `link_clicks`
    // resolves to `inline_link_clicks`, not the broader `clicks`.
    if (n.length >= 4 && f.includes(n)) {
      dist = Math.min(dist, 0.5);
    } else if (n.length >= 4 && n.includes(f) && f.length >= 4) {
      dist = Math.min(dist, 1);
    }
    if (dist < bestDist) {
      bestDist = dist;
      best = f;
    }
  }
  // Only suggest when the closest field is plausibly the same intent.
  const threshold = Math.max(2, Math.floor(n.length / 3));
  return best && bestDist <= threshold ? best : null;
}

/** Build a { droppedField: suggestion } map, omitting drops with no plausible match. */
export function suggestInsightsFields(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const s = suggestInsightsField(name);
    if (s) out[name] = s;
  }
  return out;
}

export const ALLOWED_INSIGHTS_BREAKDOWNS = [
  'age',
  'gender',
  'country',
  'region',
  'publisher_platform',
  'platform_position',
  'device_platform'
];

export const ALLOWED_ACTION_BREAKDOWNS = [
  'action_type',
  'action_target_id',
  'action_destination',
  'action_device',
  'action_reaction',
  'action_video_sound',
  'action_video_type',
  'action_carousel_card_id',
  'action_carousel_card_name'
];

export const ALLOWED_DATE_PRESETS = [
  'today',
  'yesterday',
  'this_month',
  'last_month',
  'this_quarter',
  'maximum',
  'last_3d',
  'last_7d',
  'last_14d',
  'last_28d',
  'last_30d',
  'last_90d',
  'this_year',
  'last_year'
];

/**
 * Meta v24 Objective to Optimization Goal Compatibility Matrix
 */
export const META_OBJ_GOAL_MAP: Record<string, string[]> = {
  OUTCOME_TRAFFIC: ['LINK_CLICKS', 'LANDING_PAGE_VIEWS'],
  OUTCOME_AWARENESS: ['REACH', 'IMPRESSIONS', 'THRUPLAY'],
  OUTCOME_ENGAGEMENT: ['POST_ENGAGEMENT', 'THRUPLAY', 'LINK_CLICKS'],
  OUTCOME_SALES: ['OFFSITE_CONVERSIONS', 'VALUE'],
  OUTCOME_LEADS: ['OFFSITE_CONVERSIONS'],
  OUTCOME_APP_PROMOTION: ['APP_INSTALLS']
};

/**
 * Optimization goals whose ad sets drive traffic to a website (a destination URL),
 * so the ad set's conversion location is "Website" (`destination_type=WEBSITE`).
 *
 * Used to default `destination_type` when the caller omits it (ENG-415): without it
 * Meta stores `UNDEFINED` and the ad-level Destination reads as "not selected" in Ads
 * Manager. Non-website goals (reach/engagement/app installs, or instant-form lead
 * goals) are intentionally excluded — their destination is not a website.
 */
export const META_WEBSITE_OPTIMIZATION_GOALS: string[] = [
  'LINK_CLICKS',
  'LANDING_PAGE_VIEWS',
  'OFFSITE_CONVERSIONS',
  'VALUE'
];

/**
 * Meta v24 Optimization Goal to Billing Event Compatibility Matrix
 */
export const META_GOAL_BILLING_MAP: Record<string, string[]> = {
  LINK_CLICKS: ['LINK_CLICKS', 'IMPRESSIONS'],
  REACH: ['IMPRESSIONS'],
  LANDING_PAGE_VIEWS: ['IMPRESSIONS'],
  POST_ENGAGEMENT: ['IMPRESSIONS'],
  APP_INSTALLS: ['IMPRESSIONS'],
  THRUPLAY: ['IMPRESSIONS'],
  OFFSITE_CONVERSIONS: ['IMPRESSIONS'],
  VALUE: ['IMPRESSIONS']
};

/**
 * Meta v24 Optimization Goal to Bid Strategy Compatibility Matrix
 *
 * REACH/IMPRESSIONS require LOWEST_COST_WITH_BID_CAP (bid cap controls frequency/cost).
 * LOWEST_COST_WITHOUT_CAP is only valid for click/conversion-based goals.
 */
export const META_GOAL_BID_STRATEGY_MAP: Record<string, string[]> = {
  LINK_CLICKS: ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP'],
  LANDING_PAGE_VIEWS: ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP'],
  REACH: ['LOWEST_COST_WITH_BID_CAP', 'COST_CAP'],
  IMPRESSIONS: ['LOWEST_COST_WITH_BID_CAP', 'COST_CAP'],
  POST_ENGAGEMENT: ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP'],
  APP_INSTALLS: ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP'],
  THRUPLAY: ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP'],
  OFFSITE_CONVERSIONS: ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP'],
  VALUE: ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP']
};
