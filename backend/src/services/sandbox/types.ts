/**
 * Shared contracts for the sandbox Meta simulation (ENG-1906 phases 2–4).
 *
 * Everything the simulator emits is Meta Graph-shaped on the wire: numeric-string ids,
 * `{data, paging}` envelopes, metrics as strings, budgets in minor units as strings,
 * spend as a decimal string. The DATASET stores numbers (spend in minor units) and the
 * emit layer formats. Dates in the dataset are the frozen originals; the read-time date
 * shift (see meta.dateShift) makes the last delivery day read as "yesterday UTC".
 */

export type GraphMethod = 'GET' | 'POST' | 'DELETE';

/** A Graph API request the interceptor decided to simulate, already parsed. */
export interface SimRequest {
  /** The eval_ principal recovered from the sentinel token. */
  userId: string;
  token: string;
  method: GraphMethod;
  /** e.g. "v25.0" — the SDK pins v24.0, raw callers use META_API_VERSION. */
  version: string;
  /** Path after the version, no leading slash, no query: "act_1207…/campaigns", "me/adaccounts", "oauth/access_token". */
  path: string;
  /** Query parameters, decoded. */
  query: Record<string, string>;
  /** application/x-www-form-urlencoded body, decoded (Meta writes; token exchange). */
  form?: Record<string, string>;
  /** multipart/form-data body (adimages upload). */
  multipart?: {
    fields: Record<string, string>;
    files: Array<{ field: string; filename?: string; contentType?: string; bytes: Buffer }>;
  };
  /** JSON body, when a caller sends one. */
  json?: unknown;
}

export interface SimResponse {
  status: number;
  headers: Record<string, string>;
  /** UTF-8 body (JSON for every Graph endpoint). */
  body: string;
}

export type ObjectStatus = 'ACTIVE' | 'PAUSED' | 'DELETED' | 'ARCHIVED';

export interface SandboxDatasetMeta {
  datasetId: string;
  version: number;
  schemaVersion: 1;
  caseId: string;
  /** Original (unshifted) delivery window, inclusive, YYYY-MM-DD. */
  frozenWindow: { since: string; until: string };
  dateShift: 'anchor_until_to_yesterday_utc';
  /** Human-readable notes on what was synthesised (reach, breakdowns, names). */
  approximations: string[];
  createdAt: string;
  /** Optional case-specific simulated ad review duration. */
  reviewWindowSeconds?: number;
}

export interface SandboxAccount {
  id: string;            // "act_<digits>"
  account_id: string;    // "<digits>"
  name: string;
  currency: string;
  timezone_name: string;
  account_status: number;
  business?: { id: string; name: string };
}

export interface SandboxPage {
  id: string;
  name: string;
  category: string;
  tasks: string[];
  instagram_business_account?: { id: string } | null;
}

export interface SandboxPixel {
  id: string;
  name: string;
  last_fired_time: string;
  is_created_by_business: boolean;
  /** Daily event counts keyed by Meta event name (Lead, PageView, ...). */
  statsByDay: Array<{ date: string; events: Record<string, number> }>;
}

export interface SandboxCustomAudience {
  id: string;
  name: string;
  description?: string;
  subtype: string;
  delivery_status: { code: number; description: string };
  customer_file_source?: string;
  lookalike_spec?: Record<string, unknown> | null;
  approximate_count_lower_bound?: number;
  time_created: string;
  time_updated: string;
}

export interface SandboxCampaign {
  id: string;
  account_id: string;
  name: string;
  status: ObjectStatus;
  effective_status: string;
  objective: string;            // OUTCOME_LEADS, OUTCOME_TRAFFIC, ...
  daily_budget?: number;        // minor units
  lifetime_budget?: number;     // minor units
  budget_remaining?: number;    // minor units
  spend_cap?: number;           // minor units
  bid_strategy?: string;
  start_time: string;
  stop_time?: string;
  special_ad_categories: string[];
  created_time: string;
  updated_time: string;
}

export interface SandboxAdSet {
  id: string;
  account_id: string;
  campaign_id: string;
  name: string;
  status: ObjectStatus;
  effective_status: string;
  optimization_goal: string;
  billing_event: string;
  destination_type?: string;
  promoted_object?: Record<string, unknown>;
  bid_strategy?: string;
  bid_amount?: number;
  daily_budget?: number;
  lifetime_budget?: number;
  start_time: string;
  end_time?: string;
  targeting: Record<string, unknown>;
  pacing_type?: string[];
}

export interface SandboxCreative {
  id: string;
  account_id: string;
  name: string;
  status: string;
  body?: string;
  title?: string;
  image_url?: string;
  thumbnail_url?: string;
  image_hash?: string;
  object_type?: string;
  link_url?: string;
  url_tags?: string;
  object_story_id?: string;
  object_story_spec?: Record<string, unknown>;
  asset_feed_spec?: Record<string, unknown>;
  created_time?: string;
}

export interface SandboxAdImage {
  hash: string;
  url: string;
  name: string;
  width: number;
  height: number;
  status: 'ACTIVE';
  /** Key into the dataset assets manifest (compiler output) when the bytes were seeded. */
  assetKey?: string;
}

export interface SandboxAd {
  id: string;
  account_id: string;
  adset_id: string;
  campaign_id: string;
  name: string;
  status: ObjectStatus;
  effective_status: string;
  creative: { id: string };
  ad_review_feedback?: null | Record<string, unknown>;
  created_time: string;
  updated_time: string;
}

export interface SandboxAction { action_type: string; value: number }

export interface SandboxInsightsDaily {
  date: string;          // YYYY-MM-DD, frozen original
  ad_id: string;
  adset_id: string;
  campaign_id: string;
  impressions: number;
  reach: number;
  clicks: number;
  unique_clicks?: number;
  inline_link_clicks: number;
  outbound_clicks?: number;
  spend: number;         // minor units
  video_views?: number;
  actions: SandboxAction[];
  action_values?: SandboxAction[];
}

export type SandboxBreakdown =
  | 'age,gender'
  | 'publisher_platform,platform_position'
  | 'impression_device'
  | 'device_platform'
  | 'country'
  | 'region';

export interface SandboxInsightsBreakdownDaily {
  date: string;
  ad_id: string;
  adset_id: string;
  campaign_id: string;
  breakdown: SandboxBreakdown;
  dims: Record<string, string>;
  impressions: number;
  reach: number;
  clicks: number;
  spend: number;         // minor units
  actions: SandboxAction[];
}

/** A destination the launch gate treats as measured by the given pixels (decision 5). */
export interface SandboxLander { url: string; pixelIds: string[] }

export interface SandboxDataset {
  meta: SandboxDatasetMeta;
  account: SandboxAccount;
  pages: SandboxPage[];
  pixels: SandboxPixel[];
  customAudiences: SandboxCustomAudience[];
  campaigns: SandboxCampaign[];
  adsets: SandboxAdSet[];
  adcreatives: SandboxCreative[];
  adimages: SandboxAdImage[];
  ads: SandboxAd[];
  insightsDaily: SandboxInsightsDaily[];
  insightsBreakdownDaily: SandboxInsightsBreakdownDaily[];
  landers: SandboxLander[];
  /** Packet asset references; bytes are staged separately, never fetched from Meta. */
  assetsManifest?: Array<{ assetKey: string; sourcePath: string; sha256: string; bytes: number; width: number; height: number }>;
  /** Integer metric totals verified against both packet exports and manifest. Spend is cents. */
  reconciliation?: { packetManifestSha256: string; dailyRows: number; periodRows: number; totals: Record<string, number> };
  targetingCatalog?: { interests: Array<Record<string, unknown>>; geo: Array<Record<string, unknown>> };
}

/**
 * Per-account mutable state (phase 3). Declared here so phase 2 readers can already merge
 * an (empty) overlay: created/updated objects shadow the dataset by id; deleted ids are hidden.
 */
export interface SandboxOverlay {
  revision: number;
  nextId: number;
  campaigns: Record<string, SandboxCampaign>;
  adsets: Record<string, SandboxAdSet>;
  ads: Record<string, SandboxAd>;
  adcreatives: Record<string, SandboxCreative>;
  adimages: Record<string, SandboxAdImage>;
  deletedIds: string[];
  /** Simulated review windows: ad id → ISO time the ad leaves PENDING_REVIEW. */
  reviewUntil: Record<string, string>;
  capiEvents: Array<{ pixelId: string; receivedAt: string; count: number }>;
}

export const EMPTY_OVERLAY: SandboxOverlay = Object.freeze({
  revision: 0, nextId: 1, campaigns: {}, adsets: {}, ads: {}, adcreatives: {}, adimages: {}, deletedIds: [], reviewUntil: {}, capiEvents: [],
}) as SandboxOverlay;
