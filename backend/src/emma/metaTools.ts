/**
 * ENG-2282 — the Meta Ads tool module.
 *
 * Holds the four Meta tool handlers that the Meta Toolkit v1 exposes (list_meta_ads_campaigns,
 * get_meta_ads_metrics, call_meta_ads_insights_api, call_meta_marketing_api). emma/tools.ts
 * registers these exact objects into the Emma registry. metaToolRegistry holds only these four,
 * so the external Meta Toolkit manifest and dispatcher never import the full Emma registry.
 * Handlers delegate to agentModeService, so every ENG-2046 write guard stays in the path.
 */
import { agentModeService } from '../services/agentModeService';
import { normalizeMetaCampaignIds } from '../utils/metaCampaignIds';
import { CLIENT_ID_SCHEMA_PROPERTY } from '../mcp/server/toolHelpers';
import { McpToolRegistry, type McpToolHandler } from '../mcp/server/registry';

export const listMetaAdsCampaignsTool: McpToolHandler = {
  name: 'list_meta_ads_campaigns',
  definition: {
    name: 'list_meta_ads_campaigns',
    description: 'List all Meta ad campaigns for the current user. Returns campaign names, IDs, statuses, and objectives. Works even without a Meta connected account (falls back to legacy adAccount config). Use this first to get campaign IDs, then call get_meta_ads_metrics. Admin-only: pass client_id to run against a specific client\'s account instead of the caller\'s own.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: {
          type: 'string',
          description: 'Optional Meta ad account ID from list_connected_accounts. Required only when multiple Meta ad accounts are available. REQUIRED when client_id is also provided — a client-scoped call never auto-selects an account.'
        },
        client_id: CLIENT_ID_SCHEMA_PROPERTY,
      },
      required: []
    }
  },
  execute: async (args, context) => {
    if (args.client_id) {
      return await agentModeService.listMetaAdsCampaignsNew(
        context?.userId,
        args.account_id,
        {},
        { clientId: args.client_id, toolName: 'list_meta_ads_campaigns' }
      );
    }
    return args.account_id
      ? await agentModeService.listMetaAdsCampaignsNew(context?.userId, args.account_id)
      : await agentModeService.listMetaAdsCampaignsNew(context?.userId);
  }
};

export const getMetaAdsMetricsTool: McpToolHandler = {
  name: 'get_meta_ads_metrics',
  definition: {
    name: 'get_meta_ads_metrics',
    description: 'Quick pre-built dashboard: returns a formatted summary of campaign, ad set, and ad performance with demographics, placement, and device breakdowns for specific campaigns. Best for "how are my campaigns doing?" questions. For custom field selection, custom date ranges, or raw data export, use call_meta_ads_insights_api instead.',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: {
          type: 'string',
          description: 'Time period for metrics (7d, 14d, 30d, 90d)',
          enum: ['7d', '14d', '30d', '90d'],
          default: '7d'
        },
        campaign_ids: {
          // Union type so the static schema accepts exactly the shapes execute()
          // normalizes (array preferred; legacy single string also accepted).
          // minItems only fires for arrays, so a string id is not rejected.
          type: ['array', 'string'],
          items: { type: 'string' },
          minItems: 1,
          description: 'List of campaign IDs to filter metrics by (array preferred; a single campaign id string is also accepted). Use list_meta_ads_campaigns to get available campaign IDs (works even without a connected Meta account).'
        },
        campaign_id: {
          // Legacy single-id alias. execute() normalizes this into campaign_ids.
          type: 'string',
          description: 'Legacy alias for a single campaign id. Prefer campaign_ids. Provide at least one of campaign_ids or campaign_id.'
        },
        account_id: {
          type: 'string',
          description: 'Optional Meta ad account ID from list_connected_accounts. Required only when multiple Meta ad accounts are available. REQUIRED when client_id is also provided — a client-scoped call never auto-selects an account.'
        },
        client_id: CLIENT_ID_SCHEMA_PROPERTY,
      }
    }
  },
  execute: async (args, context) => {
    // Backward-compatible normalization: accept legacy campaign_id or string campaign_ids.
    const normalizedCampaignIds = normalizeMetaCampaignIds(
      args.campaign_ids,
      args.campaign_id,
    );

    if (args.client_id) {
      return await agentModeService.getMetaAdsMetrics(
        args.timeframe || '7d',
        context?.userId,
        normalizedCampaignIds,
        args.account_id,
        { clientId: args.client_id, toolName: 'get_meta_ads_metrics' },
      );
    }

    return await agentModeService.getMetaAdsMetrics(
      args.timeframe || '7d',
      context?.userId,
      normalizedCampaignIds,
      args.account_id,
    );
  }
};

export const callMetaAdsInsightsApiTool: McpToolHandler = {
  name: "call_meta_ads_insights_api",
  definition: {
    name: "call_meta_ads_insights_api",
    description:
      "Fetch performance reporting data from Meta Ads (impressions, clicks, spend, conversions, ROAS, etc.). Use this for custom queries with specific fields, date ranges, breakdowns, or filtering. Handles Meta's async reporting internally and returns the insights rows inline as { totalRows, metadata, data }. (If the result set is very large it may be offloaded to an S3 key readable with read_tool_response/search_tool_response.) You MUST provide either date_preset or time_range (defaults to all-time if omitted, which can be very large). For a quick pre-built dashboard summary of specific campaigns, use get_meta_ads_metrics instead.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: {
          type: "string",
          description:
            "The ad account ID (numeric, without 'act_' prefix). Use list_connected_accounts to retrieve this. DO NOT guess.",
        },
        object_type: {
          type: "string",
          enum: ["account", "campaign", "adset", "ad"],
          description:
            "Entity level to fetch insights for. Use 'account' for the whole account.",
        },
        object_id: {
          type: "string",
          description:
            "The entity ID. REQUIRED when object_type is campaign, adset, or ad. Omit for account-level.",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description:
            "Metrics to retrieve. Common: impressions, reach, clicks, spend, ctr, cpc, cpm, actions, action_values, purchase_roas, conversions, video_views, cost_per_action_type.",
        },
        date_preset: {
          type: "string",
          enum: [
            "today",
            "yesterday",
            "this_month",
            "last_month",
            "this_quarter",
            "maximum",
            "last_3d",
            "last_7d",
            "last_14d",
            "last_28d",
            "last_30d",
            "last_90d",
            "this_year",
            "last_year"
          ],
          description:
            "Predefined date range. Recommended default: 'last_30d'. Use 'maximum' for lifetime. Mutually exclusive with time_range.",
        },
        time_range: {
          type: "object",
          properties: {
            since: {
              type: "string",
              description: "Start date (YYYY-MM-DD). Must be <= until.",
            },
            until: {
              type: "string",
              description: "End date (YYYY-MM-DD). Must be >= since.",
            },
          },
          required: ["since", "until"],
          description:
            "Custom date range. Both since and until are required. Mutually exclusive with date_preset.",
        },
        level: {
          type: "string",
          enum: ["account", "campaign", "adset", "ad"],
          description:
            "Row aggregation level. Example: object_type='account' + level='campaign' returns one row per campaign.",
        },
        breakdowns: {
          type: "array",
          items: {
            type: "string",
            enum: ["age", "gender", "country", "region", "publisher_platform", "platform_position", "device_platform"],
          },
          description:
            "Segment results by dimension. E.g., ['age', 'gender'] splits each row by age+gender.",
        },
        action_breakdowns: {
          type: "array",
          items: {
            type: "string",
            enum: ["action_type", "action_target_id", "action_destination", "action_device", "action_reaction", "action_video_sound", "action_video_type", "action_carousel_card_id", "action_carousel_card_name"],
          },
          description:
            "Segment action/conversion metrics. Use 'action_type' to break down the 'actions' and 'action_values' fields by event type (e.g., purchase, link_click).",
        },
        filtering: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string", description: "Field to filter on (e.g., 'campaign.name', 'adset.name', 'campaign.objective')." },
              operator: { type: "string", enum: ["EQUAL", "NOT_EQUAL", "GREATER_THAN", "LESS_THAN", "IN", "NOT_IN", "CONTAIN", "NOT_CONTAIN"] },
              value: { description: "Filter value. String for EQUAL/CONTAIN, array for IN/NOT_IN." },
            },
            required: ["field", "operator", "value"],
          },
          description:
            "Server-side filters to narrow results before aggregation.",
        },
        client_id: CLIENT_ID_SCHEMA_PROPERTY,
      },
      required: ["account_id", "object_type", "fields"],
    },
  },
  execute: async (args, context) => {
    return await agentModeService.callMetaAdsInsightsApiWrapper(
      context?.userId,
      args as any,
    );
  },
};

export const callMetaMarketingApiTool: McpToolHandler = {
  name: "call_meta_marketing_api",
  definition: {
    name: "call_meta_marketing_api",
    description:
      `Manage Meta Ads entities via the Marketing API. Requires account_id from list_connected_accounts(platform='meta').

LAUNCH GATE: setting a CAMPAIGN, AD_SET or AD to status=ACTIVE starts paid delivery, so it runs a pre-flight
  tracking check on the campaign's destination URLs first. A destination is measurable only if its served HTML
  carries a Meta pixel AND that pixel is one this ad account can use — a pixel belonging to some other account
  will never receive these conversions, so it does not count. If any destination fails, the launch is BLOCKED
  (result has blocked=true, reason='tracking_preflight') and the message names each destination and what was
  checked. Relay that to the user and help them fix tracking. If the message notes the account's pixel is
  receiving events server-side, the page may be measured through the Conversions API, which this check cannot
  see. Only pass params.override_tracking_check=true if the user explicitly chooses to launch anyway — never set
  it on your own initiative, and never to work around a block you cannot explain. A failure to VERIFY (Meta API
  or fetch error) also blocks: unverified is treated as unmeasured, never as measured.
  The override only takes effect once the user has SEEN it: put params.override_tracking_check=true on the
  unconfirmed preview call and show the user the WARNING line that comes back in the summary. NOTE: the
  override-waiver replay described elsewhere in this codebase (a second call carrying
  params.tracking_override_token) is not currently supported for a write routed through the approval-deck
  flow below — if the user explicitly wants to waive the tracking check, say so plainly rather than promising
  a mechanism that isn't wired through yet, and flag it for a human rather than guessing a workaround.

⚠️ MANDATORY TARGET CONFIRMATION (publish/change/delete actions):
  CAMPAIGN/AD_SET/AD with CREATE, UPDATE, DELETE, or COPY_AD are write actions that publish, change, or
  destroy live entities. For these, the API halts before ever writing — it does NOT execute on the first call:
    1. Call normally (without params.confirm — this flag does nothing on its own; see its own parameter
       description below). The API returns awaitingUserConfirmation:true with a "target" object naming the
       exact campaign + ad set + asset that will be affected, and adds the write to an approval deck the user
       answers directly in the UI with real approve/reject controls — not a typed reply you relay for them.
    2. Do NOT re-call this tool for the SAME write after this halt, with or without params.confirm=true.
       There is no flag or retry on your end that makes this execute — the only thing that authorizes it is
       the user's own answer, submitted through the deck UI, which the backend then executes automatically.
       Treat the halt as the end of your turn for that write. A later turn will tell you the outcome (applied,
       failed, or rejected) once the user has answered — do not assume success and do not ask the user to
       confirm again via chat text.
    3. When one user directive covers multiple gated writes with no data dependency between them (for example,
       status changes across AD, AD_SET, and CAMPAIGN), emit ALL of those calls in ONE message — every halted
       write from that one message is front-loaded into ONE deck the user answers once, instead of one prompt
       per write. Split only on a real data dependency, such as creating a creative before an ad can reference
       its creative_id.
  If the user's request could map to MORE THAN ONE campaign, ad set, or asset, do NOT guess — list the
  candidates and ask the user to disambiguate BEFORE calling. Never publish an ad into a campaign/ad set the
  user did not explicitly name, and never regenerate/edit an asset set without confirming which assets.
  (LIST/SEARCH/UPLOAD_IMAGE/UPLOAD_VIDEO are read/upload-only and need no confirmation.)

⚠️ CAMPAIGN OBJECTIVE IS IMMUTABLE — cannot be changed after creation. There is NO "start with Traffic/LPV
  and switch to conversions later" on Meta; that is not a valid plan. Because of this, a CAMPAIGN CREATE
  with no objective the user explicitly chose is BLOCKED SERVER-SIDE before it reaches Meta: if you omit
  objective_quote (see below) and the objective hasn't already been confirmed by the user in this session,
  the call returns a blocking question instead of creating the campaign — do not try to work around this
  by guessing an objective or retrying.

  If the user asks you to confirm the objective (or any other setting) via a structured card BEFORE you
  build anything: do NOT use ask_user_question or present_question_deck to ask about the objective
  yourself — both tools explicitly exclude it for this exact reason, and doing so anyway produces a
  SECOND, uncorrelated question on top of this gate's own, meaning the user answers the same question
  twice. You also have no way to render an interactive card any other way — do not fabricate one out of
  HTML, markdown tables, or styled text in your reply; a hand-written "card" you write is not real and
  answering it does nothing. Just attempt the CAMPAIGN CREATE call directly (with your real name/budget/
  targeting params, omitting objective if it isn't explicitly confirmed) — if the objective truly isn't
  settled, the call itself returns the real blocking question, which the platform renders as an actual
  clickable card. Do not stall in prose waiting to "ask first"; attempting the call is how the real card
  appears.

ACTION MATRIX (entity_type → supported actions):
  CAMPAIGN      → LIST, CREATE, CREATE_PAUSED_BUNDLE, UPDATE, DELETE
  AD_SET        → LIST, CREATE, UPDATE, DELETE
  AD_CREATIVE   → LIST, GET, PREVIEW, CREATE, UPLOAD_IMAGE, UPLOAD_VIDEO
  AD            → LIST, PREVIEW, CREATE, UPDATE, DELETE, COPY_AD, RETAG_UTM
  CUSTOM_AUDIENCE → LIST, CREATE, UPLOAD_USERS
  TARGETING     → SEARCH
  PAGE          → LIST
  DATASET       → LIST, GET_MATCH_QUALITY

AD_CREATIVE GET — read ONE creative back by id (params.creative_id), including asset_feed_spec.
  LIST omits asset_feed_spec, so it cannot tell you what a specific creative actually contains.
  Use GET to verify a creative you just built or swapped onto an ad, and to read a
  placement-customized creative (1:1 Feed + 9:16 Story/Reels) faithfully before cloning it.

AD / AD_CREATIVE PREVIEW — render an existing ad or creative for one Meta placement.
  AD requires ad_id; AD_CREATIVE requires params.creative_id. Pass params.ad_format (for example
  DESKTOP_FEED_STANDARD, INSTAGRAM_STANDARD, or INSTAGRAM_STORY). The response contains Meta's
  iframe HTML, not a permanent public URL; Meta preview iframes expire after 24 hours and are only
  visible to people who can access the selected ad account.

SCOPING AND COMPLETENESS ON EVERY LIST — read this before reporting that something is absent.
  ALWAYS pass campaign_id (or ad_set_id) when you care about one campaign or ad set. AD LIST
  accepts both and scopes the read to that node. AD_CREATIVE LIST accepts ad_set_id only —
  Meta has no campaign→creatives edge, so for campaign-scoped creatives use AD LIST with
  campaign_id, which returns creative{...} inline on every ad.

  Every LIST result carries "complete" and "hasMore" fields. A list is only the whole set when
  complete is true, and the message says "(complete list)". When hasMore is true the read
  stopped at a page bound and the set is PARTIAL.

  ⚠ NEVER conclude that an ad, creative, campaign or ad set does not exist from a list where
  complete is not true. An unscoped account-wide list is the weakest possible evidence of
  absence. To check whether one specific thing exists, scope the list to its parent
  (campaign_id / ad_set_id) or read the object directly by id — do not search a broad list and
  report a miss. Reporting "not found" off a partial list has already told a customer that an
  ad they were protecting did not exist, when it existed and we had paused it ourselves.

READING CONFIG (LIST) — read what a campaign/ad set is actually set to optimize for (use to verify after a CREATE/UPDATE):
  AD_SET LIST returns optimization_goal, billing_event, destination_type, promoted_object (pixel_id + custom_event_type), bid_strategy, and budgets per ad set. Pass ad_set_id to read a single ad set; pass campaign_id to scope to one campaign's ad sets.
  CAMPAIGN LIST returns objective plus daily_budget / lifetime_budget / budget_remaining / spend_cap / bid_strategy. Pass campaign_id to read a single campaign. budget_remaining is only populated by Meta when the campaign itself carries the budget (CBO); for ad-set-budgeted campaigns it is absent — read the ad sets' budgets instead, do not infer 0.
  Optional params.fields (comma-separated) narrows the read to specific supported fields. Requesting an unsupported field returns a loud error — it is never silently dropped.

SPEND CAP (campaign hard money stop):
  params.spend_cap sets the campaign's lifetime hard stop, in MAJOR units of the ad account currency (e.g. 3000 = $3,000 USD, 300 = NT$300 TWD); the server converts to Meta's minor units and echoes both. Unknown account currencies are rejected. Writable on CAMPAIGN CREATE and CAMPAIGN UPDATE.
  Every spend_cap write is verified server-side by re-reading the campaign, and the result says which happened:
    spend_cap_verified:true  → the cap is really on the campaign (the value is echoed back as spend_cap). ONLY then may you tell the user a cap is in place.
    spend_cap_verified:false with error SPEND_CAP_UNCONFIRMED → the cap could not be confirmed. This does NOT mean it failed: Meta sometimes reports a campaign without the field for a few seconds after a write that did land. Never claim the cap is set, and never announce it as missing either — re-read with CAMPAIGN LIST (campaign_id + params.fields="id,name,spend_cap"). If it is still absent, apply it with CAMPAIGN UPDATE (on CREATE the campaign already exists — use the returned campaign id, do NOT create it again). The message says what was actually read.
  Never report a spend cap as set based on the write response alone.

BUDGET READ-BACK (CAMPAIGN/AD_SET UPDATE with daily_budget, lifetime_budget, or budget_amount):
  The result carries budget_verification: CONFIRMED (read back as requested — only then say the budget is set), MISMATCH (error BUDGET_MISMATCH — tell the user the requested vs applied values from budget_requested/budget_applied, in cents), or UNCONFIRMED (error BUDGET_UNCONFIRMED — the write was accepted but could not be read back; not a failure, do not re-send blindly, do not claim it is set; re-read with LIST first).

DATASET USAGE:
  LIST              → Returns every pixel on the ad account with its id, name and last_fired_time. Meta unified pixels and datasets, so each pixel id IS its dataset id (returned as dataset_id).
  GET_MATCH_QUALITY → Asks Meta for Event Match Quality (EMQ) scores per event type. Requires params.dataset_id.
  WORKFLOW: First LIST to discover pixel/dataset IDs, then GET_MATCH_QUALITY with the dataset_id.
  ⚠ META USUALLY RETURNS NOTHING HERE. Its event_stats field comes back empty on live pixels, and no other EMQ API exists.
     When that happens the response sets meta_event_match_quality_available: false and includes send_side_identity_coverage
     instead — the share of conversions WE sent that carried each identity parameter (em, ph, fn, ln, fbc, fbp, IP, user agent).
     That is OUR send-side measurement, NOT Meta's match-quality score. Never report it as Meta's EMQ, and never state or imply
     an EMQ score when meta_event_match_quality_available is false — say Meta does not expose the number and give the coverage.

REQUIRED IDs PER ACTION:
  CAMPAIGN UPDATE/DELETE  → campaign_id required
  AD_SET CREATE           → campaign_id required
  AD_SET UPDATE/DELETE    → ad_set_id required
  AD CREATE               → ad_set_id required
  AD UPDATE/DELETE        → ad_id required
  AD COPY_AD              → ad_id (source ad to copy) required
  AD RETAG_UTM            → ad_id required
  TARGETING SEARCH        → params.q and params.type required

AD RETAG_UTM (ENG-239 — retrofit UTMs onto ONE existing ad that's missing them):
  Only for ads that already exist and were found untagged, e.g. via audit_ad_utm_coverage. Never call this
  in a loop over multiple ads — it is a single-target action, one ad per call, always. Retagging swaps in a
  NEW creative for the ad, which RESETS THE AD'S LEARNING PHASE and can hurt performance on a live client
  campaign. You MUST tell the user this cost explicitly before calling — do not call it as a quiet "fix" in
  the middle of another task. The normal confirmation flow (see above) will also surface this same warning,
  but say it yourself first regardless.

REQUIRED PARAMS PER ENTITY + ACTION:
  CAMPAIGN CREATE:      name, objective, special_ad_categories (e.g. ["NONE"])
                        Optional: status, spend_cap (major currency units, e.g. dollars), advantage_campaign_budget + budget_amount (major units of the ad account currency).
                        Any OTHER param is REJECTED before the campaign is created, naming the field — nothing is ever accepted and silently dropped. Campaign-level budget goes through advantage_campaign_budget + budget_amount (never a bare daily_budget/lifetime_budget); scheduling (start_time/stop_time) comes from the AD SETS, because Meta accepts those on a campaign create and then ignores them; ad-set fields (bid_strategy, targeting, optimization_goal, billing_event) belong on AD_SET CREATE.
  AD_SET CREATE:        name, optimization_goal, billing_event, targeting (with geo_locations), daily_budget OR lifetime_budget (not both; lifetime_budget requires end_time)
                        Optional but WRITABLE on create: bid_strategy (LOWEST_COST_WITHOUT_CAP | LOWEST_COST_WITH_BID_CAP | COST_CAP) and bid_amount.
                        Omitting bid_strategy silently defaults to LOWEST_COST_WITHOUT_CAP — set it deliberately when the user expressed any cost target (ENG-838).
                        bid_amount is REQUIRED for LOWEST_COST_WITH_BID_CAP and COST_CAP, and must be OMITTED for LOWEST_COST_WITHOUT_CAP.
                        Dayparting/ad scheduling (adset_schedule, pacing_type) IS supported but requires lifetime_budget (never daily_budget) plus end_time — Meta silently ignores the schedule and delivers 24/7 on a daily-budget ad set, so that combination is REJECTED, naming the requirement. pacing_type defaults to ['day_parting'] automatically whenever adset_schedule is present and pacing_type is omitted. start_time/end_time are the flight window, not dayparting, and remain independent (ENG-842).
                        After a successful create the ad set is READ BACK from Meta: the result carries readBack (the settings Meta actually stored), readBackVerified, and readBackMismatches. If a mismatch is reported the call returns success:false even though the ad set exists — tell the user which parameter Meta overrode, and report the ad set status from the result (a PAUSED ad set is not delivering) (ENG-838).
  AD_CREATIVE CREATE:   name, page_id, body, title, link_url + exactly one creative type (see below)
  AD CREATE:            name, creative_id (plus ad_set_id top-level param)
  AD COPY_AD:           ad_id = source ad ID. Optional params: name (new ad name), adset_id (target ad set; defaults to source ad's set), link_url (override destination URL), body, title, status (default PAUSED). Automatically copies images — no manual upload needed.
  CUSTOM_AUDIENCE CREATE: name, subtype (CUSTOM or LOOKALIKE)
  TARGETING SEARCH:     q (search query), type (adinterest | adbehavior | addemographics | adgeolocation). For type=adgeolocation, results include a location key/region_id for use in ad set geo_locations; optionally pass location_types (e.g. ['city']).

COPY_AD WORKFLOW (clone an existing ad with optional overrides):
  1. Use AD LIST to find the source ad and get its ad_id
  2. Call AD COPY_AD with the source ad_id and any overrides (e.g. link_url for new landing page)
  3. The system automatically: reads source creative → copies images (re-uploading from CDN if needed) → creates new creative → creates new ad
  4. Returns new_ad_id and new_creative_id
  NOTE: AD LIST now includes creative.object_story_spec so you can inspect image/video/URL details before copying.

CHANGING AN AD'S CREATIVE/IMAGE (AD UPDATE):
  Meta ads cannot mutate a creative in place — you must point the ad at a different creative.
  - To swap to a creative you already built: AD UPDATE with params.creative_id (the system nests it correctly; a top-level creative_id is silently dropped by Meta and the old image keeps showing).
  - To change copy/destination/image content: AD UPDATE with link_url / body / title / image_hash / image_url — the system auto-builds a new creative from the old one (preserving existing UTM/url_tags unless you override them) and swaps it in.
  Either way the change is reflected on the SAME ad_id; deleting and recreating the ad is NOT required.
  VERIFICATION: after ANY creative swap the system re-fetches the ad to confirm the new creative actually attached, and for link_url/destination changes that the live URL matches what you requested. Behavior depends on which path:
    - params.creative_id (direct swap): a single read-back. If it returns error SWAP_NOT_REFLECTED the change did NOT take effect (usually transient Meta propagation) — retry the AD UPDATE with the same params.creative_id (the creative already exists, don't rebuild it).
    - auto-built swap (link_url / body / title / image_hash / image_url): the system re-attaches and re-verifies up to 3 times before giving up. Outcomes:
        - verified:true → confirmed live; the user will see the new URL in Ads Manager. (May also include effective_status / review_feedback, e.g. PENDING_REVIEW, as informational — Meta's ad review can take up to ~24h but the destination is already set.)
        - pending:true with error SWAP_PENDING or DESTINATION_PENDING → after 3 checks Meta had not yet reflected the change. This is almost always transient propagation, NOT a failure: tell the user the update is applied on Meta's side and will reflect within a few minutes; do NOT keep retrying in a tight loop. Re-check after a short wait if confirmation is needed.
    - success with verified:false (either path) → the swap was sent but the confirmation read-back itself failed; re-check the ad before telling the user it's done.

CAMPAIGN OBJECTIVES (valid values for 'objective'):
  OUTCOME_TRAFFIC, OUTCOME_AWARENESS, OUTCOME_ENGAGEMENT, OUTCOME_SALES, OUTCOME_LEADS, OUTCOME_APP_PROMOTION

BUDGET RULES (Campaign & Ad Set):
  - Provide daily_budget OR lifetime_budget, NEVER both
  - lifetime_budget requires end_time (ISO 8601)
  - advantage_campaign_budget=true enables campaign-level budget; use budget_amount instead of ad-set-level budget

CREATIVE SUB-TYPES (mutually exclusive — pick exactly one):
  IMAGE creative:    provide image_hash (from UPLOAD_IMAGE) OR image_url
  VIDEO creative:    provide video_id (from UPLOAD_VIDEO) + REQUIRED thumbnail: image_hash or image_url
                     (Meta API error 1443226 if thumbnail is missing — always upload thumbnail first)
  CAROUSEL creative: provide carousel_cards array with 2–10 items; each card needs at least one of image_hash, image_url, or video_id; plus title, link_url per card
  PLACEMENT-CUSTOMIZED creative: provide placement_assets — different image per placement in ONE creative (e.g. square for Feed, 9:16 for Stories/Reels). See below.
  RULE: video_id, carousel_cards, and placement_assets are mutually exclusive — pick one.

PLACEMENT ASSET CUSTOMIZATION (placement_assets) — fixes "invalid format / lacking 9:16 for story and reel":
  When an ad set uses manual placements that include Stories/Reels, a creative with only a square/4:5
  Feed image is rejected (missing 9:16) and the ad is auto-paused. Attach a vertical 9:16 asset for
  Stories/Reels while keeping the square image for Feed — in the SAME creative — via placement_assets.
  Shape: placement_assets = [
    { image_hash OR image_url, is_default: true },                 // fallback (square/Feed image) — exactly one
    { image_hash OR image_url, placements: ["story", "reels"] }     // 9:16 vertical asset for Stories/Reels
  ]
  Rules: at least 2 assets; EXACTLY ONE default (is_default:true or omit placements); body/title/link_url
  apply to all placements. image_url is auto-uploaded to a hash. Placement tokens: feed, facebook_feed,
  instagram_feed, story/stories, facebook_story, instagram_story, reels, facebook_reels, instagram_reels, explore.
  TO FIX AN EXISTING AD: AD UPDATE with ad_id + params.placement_assets — the system builds the new
  multi-placement creative and points the SAME ad at it (no Ads Manager UI, same ad_id).
  NOTES:
  - Instagram placements (story/reels/etc.) need an Instagram actor; the system auto-resolves it from the
    Page, or pass params.instagram_user_id explicitly. (Meta error 1772103 = "Instagram Account Is Missing".)
  - CTA must be allowed for the campaign objective on asset-feed creatives. e.g. BOOK_NOW is rejected under
    OUTCOME_SALES (Meta error 1885396) — use a supported CTA like LEARN_MORE / SIGN_UP / SHOP_NOW.

VIDEO CREATIVE WORKFLOW (3 steps, all required):
  Step 1: UPLOAD_VIDEO → returns video_id
  Step 2: UPLOAD_IMAGE → returns image_hash  (thumbnail — MANDATORY for video creatives)
  Step 3: AD_CREATIVE CREATE with video_id + image_hash (or image_url)

OBJECTIVE → OPTIMIZATION GOAL COMPATIBILITY (common mappings):
  OUTCOME_TRAFFIC   → LINK_CLICKS, LANDING_PAGE_VIEWS
  OUTCOME_AWARENESS → REACH, IMPRESSIONS
  OUTCOME_ENGAGEMENT → POST_ENGAGEMENT, PAGE_LIKES
  OUTCOME_SALES     → OFFSITE_CONVERSIONS, VALUE
  OUTCOME_LEADS     → LEAD_GENERATION, OFFSITE_CONVERSIONS
  OUTCOME_APP_PROMOTION → APP_INSTALLS

PAUSED CAMPAIGN BRIEF:
  For a new campaign with one ad set and multiple ads, use CAMPAIGN CREATE_PAUSED_BUNDLE.
  Supply params={requested_ad_count, campaign:{...}, ad_set:{...}, ads:[{name,creative_id,status:"PAUSED"}, ...]}.
  Include the exact objective, budget, targeting and every requested ad in the brief. Use existing creative IDs.
  This presents ONE explicit approval card for the entire stored scope, including the objective.
  Do not ask for the objective again or send separate creates after approval: the server executes the approved bundle.
  All entities remain PAUSED. Activating delivery/spending always needs a separate UPDATE approval.
  Changes to the account, settings, creatives or count require a new brief approval.
  Report completion only when the execution result verifies every requested ad; partial/unconfirmed builds are incomplete.

AD LIST COMPLETENESS:
  AD LIST returns ALL non-deleted ads including those paused at the campaign or adset level.
  Each ad includes effective_status which shows the true running state:
    ACTIVE           → ad is running
    PAUSED           → ad itself is paused
    CAMPAIGN_PAUSED  → ad's campaign is paused (ad would run if campaign is unpaused)
    ADSET_PAUSED     → ad's adset is paused (ad would run if adset is unpaused)
  To fully pause all spend, you must pause ads/adsets/campaigns in ALL effective statuses, not just ACTIVE.
  When asked to "pause all ads", always LIST first then UPDATE every ad regardless of effective_status.

GETTING DESTINATION URLS / CREATIVE DETAILS:
  AD LIST now returns creative sub-fields directly (name, body, title, image_url, thumbnail_url, object_story_spec).
  Extract link from: image creative → creative.object_story_spec.link_data.link
                     video creative → creative.object_story_spec.video_data.call_to_action.value.link
                     carousel       → creative.object_story_spec.link_data.child_attachments[].link
  If you need creatives for ALL ads in the account without filtering: use AD_CREATIVE LIST.`,
    inputSchema: {
      type: "object",
      properties: {
        entity_type: {
          type: "string",
          enum: ["CAMPAIGN", "AD_SET", "AD_CREATIVE", "AD", "CUSTOM_AUDIENCE", "TARGETING", "PAGE", "DATASET"],
          description: "The Meta Ads entity to operate on."
        },
        action: {
          type: "string",
          enum: ["LIST", "GET", "PREVIEW", "CREATE", "CREATE_PAUSED_BUNDLE", "UPDATE", "DELETE", "COPY_AD", "RETAG_UTM", "UPLOAD_IMAGE", "UPLOAD_VIDEO", "UPLOAD_USERS", "SEARCH", "GET_MATCH_QUALITY"],
          description: "The operation to perform. Must be valid for the chosen entity_type."
        },
        account_id: {
          type: "string",
          description: "Ad Account ID (without 'act_' prefix). Must be obtained from list_connected_accounts(platform='meta')."
        },
        campaign_id: {
          type: "string",
          description: "Campaign ID. Required for: CAMPAIGN UPDATE/DELETE, AD_SET CREATE, AD_SET LIST (optional filter), AD LIST (optional filter — scopes the read to that campaign; strongly preferred over listing the whole account)."
        },
        ad_set_id: {
          type: "string",
          description: "Ad Set ID. Required for: AD_SET UPDATE/DELETE, AD CREATE, AD LIST (optional filter), AD_CREATIVE LIST (optional filter). Scopes the read to that ad set; takes precedence over campaign_id when both are given."
        },
        ad_id: {
          type: "string",
          description: "Ad ID. Required for: AD UPDATE/DELETE/COPY_AD/RETAG_UTM."
        },
        params: {
          type: "object",
          description: "Action-specific parameters. Required fields depend on entity_type + action (see tool description for the full matrix).",
          properties: {
            requested_ad_count: { type: 'integer', minimum: 1, maximum: 50, description: 'CREATE_PAUSED_BUNDLE: exact number of requested ads; must equal ads.length.' },
            campaign: { type: 'object', description: 'CREATE_PAUSED_BUNDLE: exact CAMPAIGN CREATE fields, including name and objective. Status must be PAUSED. Campaign budget uses advantage_campaign_budget=true plus budget_amount.' },
            ad_set: { type: 'object', description: 'CREATE_PAUSED_BUNDLE: exact ad set name, targeting, optimization_goal, billing_event, budget (unless campaign-budgeted), optional bidding/schedule/destination settings. Parent is the new campaign; no parent ID. Status must be PAUSED.' },
            ads: { type: 'array', description: 'CREATE_PAUSED_BUNDLE: every requested ad, attached only to the new ad set.', items: { type: 'object', required: ['name', 'creative_id'], additionalProperties: false, properties: {
              name: { type: 'string' }, creative_id: { type: 'string' }, status: { type: 'string', enum: ['PAUSED'] },
            } } },
            // --- Confirmation gate (write actions) ---
            confirm: { type: "boolean", description: "Does nothing on its own — kept only so existing calls that still set it don't error. A CAMPAIGN/AD_SET/AD CREATE/UPDATE/DELETE/COPY_AD write only ever executes once the user has approved it through the approval-deck UI; this flag cannot authorize a write by itself, and re-calling with it set to true after a halt will NOT make the write execute. See MANDATORY TARGET CONFIRMATION above." },

            // --- Common ---
            name: { type: "string", description: "Entity name." },
            status: { type: "string", enum: ["ACTIVE", "PAUSED", "ARCHIVED"], description: "Entity status." },

            // --- Campaign ---
            objective: { type: "string", description: "Campaign objective (e.g., OUTCOME_TRAFFIC, OUTCOME_SALES)." },
            objective_quote: {
              type: "string",
              description:
                "CAMPAIGN CREATE ONLY: the exact, literal substring from the user's own message that names this objective (e.g. the user typed \"set up a leads campaign\" → objective_quote: \"leads campaign\"). Provide this ONLY when the user explicitly named the objective themselves — it is checked against their actual message, and a quote that doesn't genuinely appear there is rejected. Do NOT invent or paraphrase a quote, and do NOT provide this if the user did not actually name an objective — just omit it and the objective will be confirmed automatically before the campaign is created.",
            },
            special_ad_categories: { type: "array", items: { type: "string" }, description: 'Special ad categories. Use ["NONE"] if not applicable.' },
            advantage_campaign_budget: { type: "boolean", description: "Enable Advantage Campaign Budget." },
            spend_cap: { type: "number", minimum: 0.01, description: "CAMPAIGN CREATE/UPDATE: lifetime hard-stop spend cap for the campaign, as a positive amount of MAJOR account-currency units (e.g. 3000 = $3,000; 100.50 = $100.50; 300 = NT$300) — never cents/minor units; the server converts and echoes raw + major values. The write is verified by an independent read-back — see SPEND CAP in the tool description; only claim the cap is set when spend_cap_verified is true. Read it back any time via CAMPAIGN LIST with params.fields including spend_cap." },
            budget_amount: { type: "number", description: "Campaign-level daily budget in major units of the ad account currency (when advantage_campaign_budget is true)." },

            // --- Ad Set ---
            optimization_goal: { type: "string", description: "Optimization goal (must be compatible with campaign objective)." },
            billing_event: { type: "string", description: "Billing event (must be compatible with optimization_goal)." },
            daily_budget: { type: "number", description: "Daily budget in major units of the ad account currency. Minimum 1, maximum 5,000." },
            lifetime_budget: { type: "number", description: "Lifetime budget in major units of the ad account currency. Minimum 1, maximum 50,000. Requires end_time." },
            bid_strategy: { type: "string", enum: ["LOWEST_COST_WITHOUT_CAP", "LOWEST_COST_WITH_BID_CAP", "COST_CAP"], description: "Bid strategy." },
            bid_amount: { type: "number", description: "Bid amount in major units of the ad account currency. Required for BID_CAP and COST_CAP strategies." },
            targeting: {
              type: "object",
              description: "Targeting specification. geo_locations is required. targeting_automation.advantage_audience (0 or 1) is auto-injected as 0 if omitted — pass explicitly to override. Example: { geo_locations: { countries: ['US'] }, targeting_automation: { advantage_audience: 0 } }"
            },
            start_time: { type: "string", description: "ISO 8601 start datetime." },
            end_time: { type: "string", description: "ISO 8601 end datetime. Required with lifetime_budget." },
            promoted_object: { type: "object", description: "Promoted object (e.g., { page_id: 'ID' } or { pixel_id: 'ID', custom_event_type: 'PURCHASE' })." },
            destination_type: { type: "string", description: "Conversion location for the ad set. Defaults to 'WEBSITE' for website traffic/conversion goals (LINK_CLICKS, LANDING_PAGE_VIEWS, OFFSITE_CONVERSIONS, VALUE) so the ad-level Destination is explicitly set. Pass explicitly for other destinations: 'ON_AD' (instant lead forms), 'MESSENGER', 'APP'." },

            // --- Creative ---
            page_id: { type: "string", description: "Facebook Page ID (from list_meta_pages or PAGE LIST)." },
            instagram_user_id: { type: "string", description: "Instagram actor ID for the creative. Required when serving Instagram placements (e.g. placement_assets targeting story/reels); auto-resolved from the Page if omitted." },
            image_hash: { type: "string", description: "Image hash from UPLOAD_IMAGE." },
            image_url: { type: "string", description: "Image URL (for UPLOAD_IMAGE action or direct creative use)." },
            video_id: { type: "string", description: "Video ID from UPLOAD_VIDEO." },
            video_url: { type: "string", description: "Video URL (for UPLOAD_VIDEO action)." },
            carousel_cards: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  image_hash: { type: "string" }, video_id: { type: "string" },
                  title: { type: "string" }, description: { type: "string" }, link_url: { type: "string" }
                }
              },
              description: "Carousel card array for multi-card creatives."
            },
            placement_assets: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  image_hash: { type: "string", description: "Image hash from UPLOAD_IMAGE." },
                  image_url: { type: "string", description: "Image URL (auto-uploaded to a hash)." },
                  placements: {
                    type: "array",
                    items: { type: "string" },
                    description: "Placement tokens this image serves (e.g. ['story','reels']). Omit for the default/fallback asset."
                  },
                  is_default: { type: "boolean", description: "Marks the fallback image that serves every unmatched placement (e.g. the square Feed image). Exactly one asset must be the default." }
                }
              },
              description: "Placement-level image customization (asset_feed_spec). Map different images to different placements in ONE creative (square→Feed, 9:16→Stories/Reels). Requires ≥2 assets and exactly one default. Mutually exclusive with video_id and carousel_cards."
            },
            body: { type: "string", description: "Ad body / primary text." },
            title: { type: "string", description: "Ad headline." },
            link_url: { type: "string", description: "Destination URL." },
            lander_id: { type: "string", description: "Generated landing page ID. When provided, its UTM override is resolved over the customer default for Meta url_tags." },
            url_tags: { type: "string", description: "Meta creative URL parameters as a query string. Validated as a string at the tool boundary; configured lander UTMs are resolved around it without overwriting gclid/fbclid." },
            call_to_action_type: { type: "string", description: "CTA button (e.g., LEARN_MORE, SHOP_NOW, SIGN_UP)." },
            creative_id: { type: "string", description: "Creative ID. For AD CREATE: the creative to attach. For AD UPDATE: swap the ad onto this existing creative (nested as { creative: { creative_id } } — a top-level creative_id is silently ignored by Meta)." },
            ad_format: { type: "string", description: "AD/AD_CREATIVE PREVIEW: Meta placement format to render, e.g. DESKTOP_FEED_STANDARD, INSTAGRAM_STANDARD, or INSTAGRAM_STORY." },

            // --- Custom Audience ---
            subtype: { type: "string", enum: ["CUSTOM", "LOOKALIKE"], description: "Audience subtype." },
            description: { type: "string", description: "CUSTOM_AUDIENCE CREATE: audience description. AD_CREATIVE CREATE: link description (the line under the headline) — written to link_data.description (video_data.link_description; asset_feed_spec.descriptions for placement_assets)." },
            customer_file_source: { type: "string", description: "Source type for CUSTOM audiences (e.g., USER_PROVIDED_ONLY)." },
            lookalike_spec: { type: "object", description: "Lookalike config: { origin: [{ id, type }], ratio: 0.01, country: 'US' }." },
            id: { type: "string", description: "Audience ID for UPLOAD_USERS." },
            schema: { type: "array", items: { type: "string" }, description: "PII field types for UPLOAD_USERS (e.g., ['EMAIL', 'FN', 'LN'])." },
            payload: { type: "string", description: "User data as JSON array-of-arrays for UPLOAD_USERS." },

            // --- Targeting Search ---
            q: { type: "string", description: "Search query for targeting search." },
            type: { type: "string", enum: ["adinterest", "adbehavior", "addemographics", "adgeolocation"], description: "Targeting category to search. Use 'adgeolocation' to resolve geo-targeting locations (cities/regions/zips) into keys usable in ad set geo_locations." },
            location_types: { type: "array", items: { type: "string" }, description: "For type='adgeolocation' only: restrict results to specific location kinds, e.g. ['city'], ['region'], ['zip'], ['country']." },

            // --- Dataset ---
            dataset_id: { type: "string", description: "Dataset ID. Required for DATASET GET_MATCH_QUALITY." }
          }
        }
      },
      required: ["entity_type", "action", "account_id"]
    }
  },
  execute: async (args, context) => {
    return await agentModeService.callMetaMarketingApi(
      context?.userId,
      args.entity_type,
      args.action,
      args.account_id,
      args.campaign_id,
      args.ad_set_id,
      args.ad_id,
      args.params,
      context?.sessionId,
    );
  }
};

/** Meta-only registry: the default source for the Meta Toolkit manifest and dispatcher. */
export const metaToolRegistry = new McpToolRegistry();
for (const tool of [listMetaAdsCampaignsTool, getMetaAdsMetricsTool, callMetaAdsInsightsApiTool, callMetaMarketingApiTool]) {
  metaToolRegistry.register(tool);
}
