/**
 * ENG-2823 — the Google Ads tool module (mirrors ENG-2282's emma/metaTools.ts).
 *
 * Holds the two Google Ads tool handlers — call_google_ads_api and
 * call_google_ads_reporting_api — that emma/tools.ts registers into the Emma registry. These
 * are the exact objects Emma uses: the Zoma Google Ads toolkit (mcp/googleToolkitManifest.ts,
 * mcp/googleToolkitWrites.ts) dispatches through them, so every Emma guard (tracking
 * pre-flight, HMAC-bound override, creative-addition gate, PAUSED defaults, ENG-592 read-back,
 * ENG-2036 validate-before-credentials) stays in the path. googleAdsToolRegistry holds only
 * these two, so the toolkit never imports the full Emma registry.
 *
 * Implementation lives in emma/impl/adsCrmApis.ts (unchanged).
 */
import * as adsCrmApisImpl from './impl/adsCrmApis';
import { CLIENT_ID_SCHEMA_PROPERTY } from '../mcp/server/toolHelpers';
import { McpToolRegistry, type McpToolHandler } from '../mcp/server/registry';

export const callGoogleAdsApiTool: McpToolHandler = {
  name: 'call_google_ads_api',
  definition: {
    name: 'call_google_ads_api',
    description: `Manage Google Ads entities via the Google Ads API.

ACTION MATRIX:
  BUDGET      → LIST, CREATE (name, amount_micros, explicitly_shared?), UPDATE (budget_resource_name, amount_micros), REMOVE (budget_resource_name; must not be attached to any campaign)
  OFFLINE_CONVERSION → UPLOAD (gclid, conversion_action_resource_name, conversion_at; conversion_value?+currency_code?, order_id?, validate_only?)
    For a conversion that completes OFF the page — a booking that confirms later, a CRM qualification, a closed deal. Browser tracking cannot see those, so without this Google optimises toward form submits and bids toward the cheapest low-intent leads.
    conversion_at is when the conversion HAPPENED (ISO 8601), not when you noticed it. Google attributes it to that moment and rejects future dates.
    order_id should be the SAME eventId the browser sent as transaction_id — Google dedupes the pair, which is what stops one lead counting twice across the two channels.
    A conversion_value REQUIRES a currency_code; without one Google assumes the account currency and misstates revenue.
    validate_only=true asks Google to check the payload and write nothing. Use it to rehearse a batch before committing it.
  CAMPAIGN_CONVERSION_GOAL → LIST (campaign_id?), UPDATE (biddable + resource_name, or campaign_id + category + origin). CUSTOMER_CONVERSION_GOAL → LIST, UPDATE (biddable + resource_name, or category + origin) — the account default. Use these to stop a goal driving smart bidding when CONVERSION_ACTION UPDATE returns MUTATE_NOT_ALLOWED (codeless / Universal Analytics actions).
  CONVERSION_ACTION → LIST, CREATE (name, category, counting_type; status?, primary_for_goal?, click_through_lookback_window_days?), UPDATE (conversion_action_resource_name; any of name/status/category/counting_type/primary_for_goal/click_through_lookback_window_days), REMOVE (conversion_action_resource_name, confirm_conversion_action_removal, conversion_action_removal_token)
    A CONVERSION_ACTION has NO PAUSED status — that is a campaign status and is rejected. It is always created ENABLED (omit status and it defaults there); Google deny-lists every other value on create.
    HIDDEN cannot be set through the API at all — Google assigns it, and sending it is rejected on both create and update. Do not suggest it.
    To stop an action recording, use CONVERSION_ACTION REMOVE with confirm_conversion_action_removal=true. That is permanent and cannot be re-enabled, so it HALTS for a real user approval: the first call returns a disclosure plus conversion_action_removal_token, and only a replay carrying that token removes anything. You cannot approve this yourself by setting the flag. Conversions already recorded stay in reporting, so it is not data loss.
              counting_type is REQUIRED and never inferred: ONE_PER_CLICK counts one conversion per ad click (lead forms, sign-ups); MANY_PER_CLICK counts every conversion (purchases). Choosing wrong inflates reported conversions and silently misdirects smart bidding — nothing errors, so ASK the user rather than guessing.
              CREATE returns tag = {conversionId, conversionLabel, sendTo}, read back from the action's own tag snippets. That AW-<id>/<label> pair is what goes on the page — a resource name cannot be installed. If Google has not generated snippets yet, tag is null and tagUnavailable explains it; re-run LIST shortly to get it.
              CREATE and UPDATE both read the action back and return drift (fields Google stored differently from what was requested) plus driftWarning. Relay drift to the user — do not assume the write took.
              REMOVE (conversion_action_resource_name; requires confirm_conversion_action_removal=true AND a matching conversion_action_removal_token from the disclosure halt) stops the action recording permanently. The flag alone does nothing — a token minted for a DIFFERENT conversion action is refused too, so never reuse one.
  CAMPAIGN    → LIST, CREATE (name, type, budget_resource_name, bidding_strategy OR bidding_strategy_resource_name, location_target_ids?, brand_business_name?, brand_logo_asset_resource_name?, SEARCH only: target_google_search?, target_search_network?, target_content_network?), PAUSE, RESUME, UPDATE (campaign_resource_name, name?, status?, bidding_strategy? OR bidding_strategy_resource_name?, bidding_strategy_target?, budget_resource_name?, final_url_suffix?, target_google_search?, target_search_network?, target_content_network?, target_partner_search_network?), REMOVE (campaign_resource_name)
              For PERFORMANCE_MAX: pass brand_business_name and brand_logo_asset_resource_name — backend batches campaign creation + brand asset attachment atomically
              Bidding: pass bidding_strategy for a standard (embedded) strategy, OR bidding_strategy_resource_name to attach a portfolio/shared strategy (from BIDDING_STRATEGY LIST) — never both. Switching to a standard strategy detaches any portfolio strategy.
              LAUNCH GATE: RESUME (or UPDATE with status=ENABLED) enables a campaign — this runs a pre-flight tracking check on the campaign's final URLs. If any URL lacks a detectable GA4/GTM/Google Ads conversion snippet the launch is BLOCKED (result has blocked=true and names the unmeasured URLs). Relay that to the user and help them fix tracking; only pass override_tracking_check=true if they explicitly choose to launch anyway.
              ENG-1944: enabling the CAMPAIGN does NOT enable its ad groups, keywords, or ads — those default to PAUSED on creation and stay that way unless explicitly updated. A successful RESUME/UPDATE(ENABLED) response may include pausedChildEntitiesWarning naming ad groups/keywords/ads still PAUSED underneath — if present, the campaign will deliver ZERO traffic despite showing ENABLED. Do not report a launch as live until you've enabled those too (AD_GROUP/KEYWORD/AD UPDATE with status=ENABLED) and re-checked. Never rely on CAMPAIGN status alone to confirm something is live.
              ADD_PROXIMITY (campaign_resource_name, radius, and EITHER address{street_address?, city_name?, postal_code?, province_code?, province_name?, country_code?} OR latitude+longitude (decimal degrees); radius_units defaults MILES) — mile/km-radius targeting centered on a real address (Google geocodes it server-side). This is native API support for "within N miles of our store/showroom" requests — do NOT tell the user proximity/radius targeting requires the UI; it does not. Additive to any existing LOCATION (city) criteria — REMOVE_PROXIMITY the old one first if only the radius should apply.
              REMOVE_PROXIMITY (criterion_resource_name) — removes a campaign-level LOCATION or PROXIMITY criterion. Obtain resource names via a raw GAQL query on campaign_criterion (call_google_ads_reporting_api mode="raw").
              DISCLOSURE RULE (AGW-155): if any targeting step cannot be completed via this API (ADD_PROXIMITY errors, or the user asks for a targeting type this tool does not support), tell the user explicitly in the same reply what was NOT applied and why, give the exact manual UI steps, and list it as an outstanding manual action in the launch summary. Never silently substitute a UI workaround or report the campaign as fully configured while a targeting step is pending.
              TRANSPARENCY GUARDRAIL: if any Google Ads request cannot be fully satisfied via this API — including cases where you genuinely must fall back to a UI-only step (e.g. linking Google Business Profile) — you MUST say so explicitly to the user at deployment: name the gap, what you did instead, and the exact manual step left for them. Never silently substitute a workaround or imply a request is fully done when a manual step remains outstanding.
  CAMPAIGN_CRITERION → ADD (campaign_resource_name, placement_urls? and/or mobile_app_category_resource_names?), SET_DEVICE_BID_ADJUSTMENT (campaign_resource_name OR ad_group_resource_name, device_bid_adjustments[{device, bid_modifier_percent}])
              SET_DEVICE_BID_ADJUSTMENT: device is MOBILE|TABLET|DESKTOP|CONNECTED_TV; bid_modifier_percent -100..900 (-100 excludes the device, e.g. desktop-only B2B = MOBILE -100 + TABLET -100). Campaign level updates the campaign's device criteria; ad-group level overrides for that ad group. Google may reject some combinations (e.g. excluding every device) — relay its error verbatim.
              Adds campaign-scoped negative placement and mobile-app-category criteria atomically. placement_urls accepts domains or HTTP(S) URLs. mobile_app_category_resource_names must use canonical mobileAppCategoryConstants/<id> resource names. This is not a keyword/ad-group fallback.
  BIDDING_STRATEGY → LIST (portfolio/shared bidding strategies; returns resource_name for use as bidding_strategy_resource_name)
  AD_GROUP    → LIST (campaign_resource_name)
               CREATE (name, campaign_resource_name, type [SEARCH_STANDARD|DISPLAY_STANDARD], cpc_bid_micros?)
               UPDATE (ad_group_resource_name, name?, status?, cpc_bid_micros?, ad_rotation_mode?, target_cpa_micros?, target_roas?)
               REMOVE (ad_group_resource_name)
  KEYWORD     → LIST (ad_group_resource_name), ADD (ad_group_resource_name, keywords[]), ADD_NEGATIVE (keywords[], campaign_resource_name OR ad_group_resource_name), UPDATE (criterion_resource_name, status?, cpc_bid_micros?), REMOVE (criterion_resource_name)
  AD          → LIST (ad_group_resource_name), CREATE (ad_group_resource_name, type [RESPONSIVE_SEARCH_AD|RESPONSIVE_DISPLAY_AD], headlines[], descriptions[], final_url), UPDATE (ad_resource_name, status?), REMOVE (ad_resource_name), RETAG_UTM (ad_resource_name)
              NOTE: final_url, headlines, descriptions are ALL immutable after creation — to change any of these, REMOVE and recreate the ad
              RETAG_UTM (ENG-239 — retrofit UTMs onto an ad found untagged, e.g. via audit_ad_utm_coverage):
              Writes the UTM suffix to the ad's CAMPAIGN, not the ad — Google's API rejects a direct ad-level
              write on an existing ad. Merges with whatever the campaign already has (never overwrites existing
              tracking). This means the change affects EVERY ad in that campaign, not just the one you named —
              tell the user this explicitly before calling, the same way you would for any change with a wider
              blast radius than it sounds like. Never call in a loop over multiple ads — single-target only,
              one ad per call.
  ASSET       → UPLOAD (asset_type IMAGE|LOGO|VIDEO|TEXT, name, data: https URL / YouTube id / the text)
  CAMPAIGN_ASSET → ATTACH (campaign_resource_name, assets[{fieldType, assetResourceName?, text?}])
              fieldType values: BUSINESS_NAME (use text), LOGO, SQUARE_MARKETING_IMAGE, MARKETING_IMAGE (use assetResourceName)
              Note: brand guidelines are handled automatically in CAMPAIGN CREATE — use ATTACH only for adding additional campaign-level assets after campaign creation
  ASSET_GROUP → CREATE, UPDATE (asset_group_resource_name, status — created PAUSED; ENABLED runs the creative-addition tracking gate), RETAG_UTM (asset_group_resource_name)
              RETAG_UTM (ENG-239 — retrofit UTMs onto a PMax asset group found untagged, e.g. via
              audit_ad_utm_coverage): merges missing UTM keys directly into final_urls (asset groups have no
              final_url_suffix field). No utm_content — {creative} is unsupported on Performance Max, per
              Google's own docs. Also omits any key the CAMPAIGN's final_url_suffix already supplies, since an
              asset group inherits that at delivery — never duplicates. Never call in a loop — single-target
              only, one asset group per call.
  LOCATION    → SEARCH`,
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Google Ads customer ID (numeric, no dashes). Call list_connected_accounts(platform="google_ads") and use the "customer_id" field from the result (NOT the "id" field).' },
        entity_type: { type: 'string', enum: ['BUDGET', 'CAMPAIGN', 'CAMPAIGN_CRITERION', 'AD_GROUP', 'KEYWORD', 'AD', 'ASSET', 'CAMPAIGN_ASSET', 'ASSET_GROUP', 'LOCATION', 'BIDDING_STRATEGY', 'CONVERSION_ACTION', 'OFFLINE_CONVERSION', 'CAMPAIGN_CONVERSION_GOAL', 'CUSTOMER_CONVERSION_GOAL'] },
        action: { type: 'string', description: 'Action to perform. See ACTION MATRIX.' },
        name: { type: 'string' },
        type: { type: 'string', description: 'Campaign type (SEARCH|DISPLAY|PERFORMANCE_MAX), ad group type (SEARCH_STANDARD|DISPLAY_STANDARD), or ad type for AD CREATE (RESPONSIVE_SEARCH_AD|RESPONSIVE_DISPLAY_AD).' },
        budget_resource_name: { type: 'string', description: 'From BUDGET LIST or BUDGET CREATE. Required for CAMPAIGN CREATE, BUDGET UPDATE (with amount_micros), and BUDGET REMOVE.' },
        amount_micros: { type: 'number', description: 'Budget in micros. $10/day = 10000000.' },
        explicitly_shared: { type: 'boolean', description: 'Whether the budget is explicitly shared across campaigns. Optional for BUDGET CREATE.' },
        bidding_strategy: { type: 'string', enum: ['MAXIMIZE_CONVERSIONS', 'TARGET_CPA', 'TARGET_ROAS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_IMPRESSION_SHARE', 'TARGET_SPEND', 'MANUAL_CPC'], description: 'A standard (embedded) bidding strategy. TARGET_SPEND = Maximize Clicks (optionally capped by cpc_bid_ceiling_micros). Mutually exclusive with bidding_strategy_resource_name.' },
        bidding_strategy_resource_name: { type: 'string', description: 'Resource name of a portfolio/shared bidding strategy (from BIDDING_STRATEGY LIST) to attach on CAMPAIGN CREATE/UPDATE. Mutually exclusive with bidding_strategy.' },
        bidding_strategy_target: { type: 'number', description: 'The bid target, in the unit the chosen strategy uses: MAXIMIZE_CONVERSIONS / TARGET_CPA = target CPA in CURRENCY UNITS (not micros; 50 means 50 INR), MAXIMIZE_CONVERSION_VALUE / TARGET_ROAS = target ROAS as a ratio (4 = 400%), TARGET_IMPRESSION_SHARE = impression share as a fraction (0.65 = 65%). TARGET_SPEND and MANUAL_CPC have no bid target and REJECT this field. Requires bidding_strategy to be named in the same call — Google stores the target inside the strategy, so it cannot be applied on its own. On a portfolio strategy (bidding_strategy_resource_name) the target belongs to the shared strategy object, not the campaign, and is rejected here.' },
        cpc_bid_ceiling_micros: { type: 'number', description: 'Max CPC bid ceiling in micros. Accepted on TARGET_IMPRESSION_SHARE (default 100000000 ≈100 currency units) and TARGET_SPEND/Maximize Clicks, where it is part of the strategy. REJECTED on MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE, TARGET_CPA, TARGET_ROAS and MANUAL_CPC — on those the campaign row has no ceiling to write, so it would be silently ignored; set it on a portfolio bidding strategy instead, or cap cost with bidding_strategy_target.' },
        location_target_ids: { type: 'array', items: { type: 'number' }, description: 'From LOCATION SEARCH.' },
        category: { type: 'string', description: 'CONVERSION_ACTION CREATE/UPDATE: what the conversion represents, e.g. SUBMIT_LEAD_FORM, PURCHASE, SIGNUP, DOWNLOAD, BOOK_APPOINTMENT, CONTACT. Never inferred — it decides how Google reports and optimises the action.' },
        counting_type: { type: 'string', enum: ['ONE_PER_CLICK', 'MANY_PER_CLICK'], description: 'CONVERSION_ACTION CREATE (required) / UPDATE. ONE_PER_CLICK counts one conversion per ad click (lead forms, sign-ups); MANY_PER_CLICK counts every conversion (purchases). NEVER guess — choosing wrong inflates reported conversions and silently misdirects smart bidding. Ask the user.' },
        biddable: { type: 'boolean', description: 'CAMPAIGN_CONVERSION_GOAL / CUSTOMER_CONVERSION_GOAL UPDATE: whether this category~origin goal drives bidding. false demotes it.' },
        campaign_id: { type: 'string', description: 'CAMPAIGN_CONVERSION_GOAL LIST (filter) / UPDATE (with category + origin): numeric campaign id.' },
        resource_name: { type: 'string', description: 'CAMPAIGN_CONVERSION_GOAL / CUSTOMER_CONVERSION_GOAL UPDATE: goal resource name from LIST, e.g. customers/<cid>/campaignConversionGoals/<campaignId>~CONTACT~WEBSITE.' },
        origin: { type: 'string', description: 'CAMPAIGN_CONVERSION_GOAL / CUSTOMER_CONVERSION_GOAL UPDATE: goal origin, e.g. WEBSITE, CALL_FROM_ADS, APP, STORE.' },
        primary_for_goal: { type: 'boolean', description: 'CONVERSION_ACTION CREATE/UPDATE: whether this action is a primary goal (counts toward the Conversions column and drives smart bidding).' },
        click_through_lookback_window_days: { type: 'number', description: 'CONVERSION_ACTION CREATE/UPDATE: how many days after an ad click a conversion still attributes to it.' },
        confirm_conversion_action_removal: { type: 'boolean', description: 'Required true for CONVERSION_ACTION REMOVE. NOT sufficient on its own: setting it returns a disclosure and a conversion_action_removal_token, and the removal only happens when you replay the same call carrying that token. Removal is permanent and cannot be re-enabled. Conversions already recorded stay in reporting.' },
        conversion_action_removal_token: { type: 'string', description: 'CONVERSION_ACTION REMOVE only: replay the token returned by the disclosure halt, verbatim, after the USER has approved. Bound to that exact conversion action — a token for a different one is refused. Never mint, guess or reuse it.' },
        gclid: { type: 'string', description: 'OFFLINE_CONVERSION UPLOAD: the click id captured at first touch and stored on the lead. Without it there is no click to attribute the conversion to.' },
        conversion_at: { type: 'string', description: 'OFFLINE_CONVERSION UPLOAD: ISO 8601 timestamp of when the conversion HAPPENED, not when it was noticed. Future dates are rejected.' },
        conversion_value: { type: 'number', description: 'OFFLINE_CONVERSION UPLOAD: the conversion value. Requires currency_code.' },
        currency_code: { type: 'string', description: 'OFFLINE_CONVERSION UPLOAD: ISO currency for conversion_value, e.g. INR. Required whenever a value is given.' },
        order_id: { type: 'string', description: 'OFFLINE_CONVERSION UPLOAD: the same eventId the browser sent as transaction_id, so Google dedupes the browser conversion against this upload.' },
        time_zone: { type: 'string', description: 'OFFLINE_CONVERSION UPLOAD: override the account time zone (IANA). Normally omit — it is read from the account.' },
        validate_only: { type: 'boolean', description: 'OFFLINE_CONVERSION UPLOAD: ask Google to validate the payload and write NOTHING. Use to rehearse before committing.' },
        conversion_action_resource_name: { type: 'string', description: 'Required for CONVERSION_ACTION UPDATE: customers/<customer_id>/conversionActions/<id> (a bare numeric id is also accepted). From CONVERSION_ACTION LIST or CREATE.' },
        campaign_resource_name: { type: 'string', description: 'Required for CAMPAIGN PAUSE/RESUME/UPDATE/REMOVE/ADD_PROXIMITY, AD_GROUP LIST, and (as an alternative to ad_group_resource_name) KEYWORD ADD_NEGATIVE.' },
        radius: { type: 'number', description: 'Proximity radius for CAMPAIGN ADD_PROXIMITY, in radius_units (default MILES).' },
        radius_units: { type: 'string', enum: ['MILES', 'KILOMETERS'], description: 'Unit for radius on CAMPAIGN ADD_PROXIMITY. Defaults to MILES.' },
        latitude: { type: 'number', description: 'CAMPAIGN ADD_PROXIMITY: decimal-degree latitude of the radius center (use with longitude instead of address).' },
        longitude: { type: 'number', description: 'CAMPAIGN ADD_PROXIMITY: decimal-degree longitude of the radius center (use with latitude instead of address).' },
        address: {
          type: 'object',
          description: 'Address to center the radius on for CAMPAIGN ADD_PROXIMITY (Google geocodes it server-side). At least one field required.',
          properties: {
            street_address: { type: 'string' },
            city_name: { type: 'string' },
            postal_code: { type: 'string' },
            province_code: { type: 'string' },
            province_name: { type: 'string' },
            country_code: { type: 'string' },
          },
        },
        final_url_suffix: { type: 'string', description: 'Campaign-level Final URL suffix (query params appended to all final URLs, e.g. "utm_source=google&utm_medium=cpc"). For CAMPAIGN UPDATE only.' },
        target_google_search: { type: 'boolean', description: 'CAMPAIGN UPDATE, or SEARCH CAMPAIGN CREATE. Whether ads serve on Google Search. Maps to network_settings.target_google_search.' },
        target_search_network: { type: 'boolean', description: 'CAMPAIGN UPDATE, or SEARCH CAMPAIGN CREATE. Whether ads serve on Google search partners. Maps to network_settings.target_search_network.' },
        target_content_network: { type: 'boolean', description: 'CAMPAIGN UPDATE, or SEARCH CAMPAIGN CREATE. Whether Search campaigns use Display Network expansion. Set false to disable Display expansion. Maps to network_settings.target_content_network.' },
        target_partner_search_network: { type: 'boolean', description: 'CAMPAIGN UPDATE only. Controls a separate partner network available only to select eligible accounts. This does not control Google Search Partners; use target_search_network for that. Maps to network_settings.target_partner_search_network.' },
        ad_group_resource_name: { type: 'string', description: 'Required for KEYWORD LIST/ADD, AD LIST/CREATE, AD_GROUP UPDATE. For KEYWORD ADD_NEGATIVE, required only as an alternative to campaign_resource_name (either one works). Not used by KEYWORD REMOVE, which identifies the keyword via criterion_resource_name alone.' },
        ad_resource_name: { type: 'string', description: 'AdGroupAd resource name. Required for AD UPDATE/REMOVE/RETAG_UTM. Obtain from AD LIST.' },
        asset_group_resource_name: { type: 'string', description: 'Asset group resource name. Required for ASSET_GROUP UPDATE and RETAG_UTM. Obtain from audit_ad_utm_coverage or a GAQL read on asset_group.' },
        brand_business_name: { type: 'string', description: 'Business name for PMax brand guidelines. Required for PERFORMANCE_MAX CAMPAIGN CREATE when brand guidelines are enforced.' },
        brand_logo_asset_resource_name: { type: 'string', description: 'Logo image asset resource name for PMax brand guidelines. Upload via ASSET UPLOAD first.' },
        criterion_resource_name: { type: 'string', description: 'Criterion resource name. Required for KEYWORD UPDATE and KEYWORD REMOVE (ad group criterion, from KEYWORD LIST) and CAMPAIGN REMOVE_PROXIMITY (campaign criterion, from a raw GAQL query on campaign_criterion).' },
        placement_urls: { type: 'array', items: { type: 'string' }, description: 'Placement domains or HTTP(S) URLs to add as negative campaign criteria. For CAMPAIGN_CRITERION ADD.' },
        mobile_app_category_resource_names: { type: 'array', items: { type: 'string' }, description: 'Canonical mobileAppCategoryConstants/<id> resource names to add as negative campaign criteria. For CAMPAIGN_CRITERION ADD.' },
        device_bid_adjustments: { type: 'array', items: { type: 'object', properties: { device: { type: 'string', enum: ['MOBILE', 'TABLET', 'DESKTOP', 'CONNECTED_TV'] }, bid_modifier_percent: { type: 'number', description: '-100 (exclude device) to 900.' } }, required: ['device', 'bid_modifier_percent'] }, description: 'For CAMPAIGN_CRITERION SET_DEVICE_BID_ADJUSTMENT.' },
        assets: { type: 'array', items: { type: 'object', properties: { fieldType: { type: 'string', enum: ['BUSINESS_NAME', 'LOGO', 'SQUARE_MARKETING_IMAGE', 'MARKETING_IMAGE', 'HEADLINE', 'DESCRIPTION'] }, assetResourceName: { type: 'string' }, text: { type: 'string' } }, required: ['fieldType'] }, description: 'Assets to attach for CAMPAIGN_ASSET ATTACH. Use text for BUSINESS_NAME, assetResourceName for image/logo types.' },
        keywords: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, matchType: { type: 'string', enum: ['BROAD', 'PHRASE', 'EXACT'] } }, required: ['text', 'matchType'] }, description: 'Keywords for ADD or ADD_NEGATIVE action.' },
        query: { type: 'string', description: 'Location search query.' },
        status: { type: 'string', enum: ['ENABLED', 'PAUSED'], description: 'Entity status for CREATE or UPDATE. PAUSED is for campaigns/ad groups/ads/keywords — a CONVERSION_ACTION has no PAUSED status and is always created ENABLED. To retire a conversion action use CONVERSION_ACTION REMOVE with confirm_conversion_action_removal=true; HIDDEN cannot be set through the API at all (Google assigns it).' },
        override_tracking_check: { type: 'boolean', description: 'Enabling/launching a campaign (CAMPAIGN RESUME, or UPDATE with status=ENABLED) runs a deterministic pre-flight tracking check: each final URL must serve a detectable GA4/GTM/Google Ads conversion snippet, or the launch is BLOCKED (blocked=true, reason="tracking_preflight"). Setting this waives that check. You CANNOT grant it yourself: a call carrying it HALTS and returns a confirmation prompt plus a tracking_override_token, and the waiver only applies once the user has approved and you replay the SAME arguments with that token. Without the token the gate runs normally, whatever this flag says.' },
        tracking_override_token: { type: 'string', description: 'Echo back exactly as returned by the confirmation halt, alongside override_tracking_check, to apply a waiver the user has approved. It is an HMAC over that specific call — you cannot construct one, and it stops matching if any other argument changes, because the user approved THAT launch. Never invent or reuse a token from a different call.' },
        cpc_bid_micros: { type: 'number', description: 'CPC bid in micros for AD_GROUP CREATE or UPDATE.' },
        ad_rotation_mode: { type: 'string', enum: ['OPTIMIZE', 'ROTATE_FOREVER'], description: 'Ad rotation mode for AD_GROUP UPDATE.' },
        target_cpa_micros: { type: 'number', description: 'Ad-group-level target CPA in micros for AD_GROUP UPDATE. Overrides campaign-level target.' },
        target_roas: { type: 'number', description: 'Ad-group-level target ROAS for AD_GROUP UPDATE. Overrides campaign-level target.' },
        headlines: { type: 'array', items: { type: 'string' }, description: 'Ad headlines. Required for AD CREATE. Min 3 for RSA.' },
        descriptions: { type: 'array', items: { type: 'string' }, description: 'Ad descriptions. Required for AD CREATE. Min 2 for RSA.' },
        final_url: { type: 'string', description: 'Landing page URL. Required for AD CREATE and ASSET_GROUP CREATE.' },
        image_asset_resource_names: { type: 'array', items: { type: 'string' }, description: 'Image asset resource names. Optional, Display ads only.' },
        asset_type: { type: 'string', enum: ['IMAGE', 'LOGO', 'VIDEO', 'TEXT'], description: 'Asset type for ASSET UPLOAD. Use LOGO for square logo images (internally uploaded as IMAGE). Use IMAGE for marketing images. Use VIDEO for YouTube videos. Use TEXT for a text asset (data is the text).' },
        data: { type: 'string', description: 'Asset data. For IMAGE/LOGO: a public URL (https://...) — backend will fetch and upload. For VIDEO: YouTube video ID string. for VIDEO.' },
        long_headlines: { type: 'array', items: { type: 'string' }, description: 'Long headlines for ASSET_GROUP CREATE (PMax).' },
        square_image_assets: { type: 'array', items: { type: 'string' }, description: 'Square image asset resource names for ASSET_GROUP CREATE.' },
        landscape_image_assets: { type: 'array', items: { type: 'string' }, description: 'Landscape image asset resource names for ASSET_GROUP CREATE.' },
        logo_assets: { type: 'array', items: { type: 'string' }, description: 'Logo asset resource names for ASSET_GROUP CREATE.' },
        video_assets: { type: 'array', items: { type: 'string' }, description: 'Video asset resource names for ASSET_GROUP CREATE. Optional.' },
        client_id: { ...CLIENT_ID_SCHEMA_PROPERTY, description: `${CLIENT_ID_SCHEMA_PROPERTY.description} Read-only here: only honored for action=LIST or action=SEARCH — a client-scoped write is refused, since that would mutate a client's live campaign without their own authorization.` },
      },
      required: ['customer_id', 'entity_type', 'action'],
    },
  },
  execute: async (args: any, context: any) => {
    return await adsCrmApisImpl.handleCallGoogleAdsApi(context?.userId || context?.agentUserId, args, {
      sessionId: context?.sessionId,
      ...(args.client_id ? { clientScope: { clientId: args.client_id, toolName: 'call_google_ads_api' } } : {}),
    });
  },
};

export const callGoogleAdsReportingApiTool: McpToolHandler = {
  name: 'call_google_ads_reporting_api',
  definition: {
    name: 'call_google_ads_reporting_api',
    description: `Fetch Google Ads performance data.

THREE MODES:
- mode="serving_chain": Verify Search serving-chain readiness and today's delivery evidence; optional campaign_ids.
- mode="dashboard": Pre-formatted markdown table (spend, impressions, clicks, CTR, conversions, avg CPC). Use for "how are my campaigns doing?" questions.
- mode="raw": Custom GAQL query, returns structured results. Use for keyword-level data, custom breakdowns, or specific fields.

COST: cost_micros from API ÷ 1,000,000 = spend in account currency. Check the currency field in response.
NEVER fabricate metrics — only report what tools return.
Before any customer-facing Search launch/status assertion, call call_google_ads_reporting_api mode="serving_chain".
Never claim ads are live, serving, or spending from campaign or keyword status alone. READY is not evidence of delivery.
Only DELIVERING supports observed delivery in the returned window; spending additionally requires costMicros > 0 on that eligible path.
Cite campaign, budget, ad-group, ad creative, keyword eligibility, telemetry, account timezone, window, and checkedAt timestamp. Include every blocked sibling path.
UNVERIFIED or failed reads forbid readiness/delivery claims. Today's telemetry can lag and does not prove ads are serving at this instant. Performance Max and Display are unsupported by this verifier.

GAQL EXAMPLES:
  Campaign: SELECT campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_30_DAYS
  Keywords: SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, metrics.clicks, metrics.cost_micros, metrics.average_cpc FROM keyword_view WHERE segments.date DURING LAST_30_DAYS
  Quality Score: SELECT ad_group_criterion.keyword.text, ad_group_criterion.quality_info.quality_score, ad_group_criterion.quality_info.creative_quality_score, ad_group_criterion.quality_info.post_click_quality_score, ad_group_criterion.quality_info.search_predicted_ctr FROM keyword_view WHERE ad_group_criterion.status = 'ENABLED'
  (There is no quality_info.ad_relevance field; "ad relevance" is creative_quality_score. quality_info.* + segments.date is accepted FROM keyword_view but rejected FROM ad_group_criterion; for a per-day quality score history use metrics.historical_quality_score for date-segmented quality score. quality_info.* fields only support =, !=, IN, NOT IN in a WHERE clause; IS NULL / IS NOT NULL is invalid on them. Unpopulated scores (keywords below Google's auction-impression threshold) come back as absent/null fields on the row, not as rows you can filter out with a null check - don't attempt to filter on quality_info.* presence.)`,
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Google Ads customer ID (numeric, no dashes). Call list_connected_accounts(platform="google_ads") and use the "customer_id" field (NOT the "id" field).' },
        mode: { type: 'string', enum: ['raw', 'dashboard', 'serving_chain'], description: '"serving_chain" required for Search launch/status assertions. "dashboard" for formatted summary. "raw" for custom GAQL.' },
        query: { type: 'string', description: 'GAQL query. Required for mode="raw".' },
        campaign_ids: { type: 'array', items: { type: 'string' }, description: 'Filter to specific campaigns (dashboard or serving_chain mode). Omit for all.' },
        date_preset: { type: 'string', enum: ['TODAY', 'YESTERDAY', 'LAST_7_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS', 'THIS_MONTH', 'LAST_MONTH', 'THIS_YEAR'], description: 'Dashboard only; defaults to LAST_30_DAYS. serving_chain always uses TODAY in the account timezone.' },
        client_id: CLIENT_ID_SCHEMA_PROPERTY,
      },
      required: ['customer_id', 'mode'],
    },
  },
  execute: async (args: any, context: any) => {
    return await adsCrmApisImpl.handleCallGoogleAdsReportingApi(context?.userId || context?.agentUserId, args, {
      ...(args.client_id ? { clientScope: { clientId: args.client_id, toolName: 'call_google_ads_reporting_api' } } : {}),
    });
  },
  // ENG-1276 follow-up: only fetches metrics/GAQL results (getQuickMetrics,
  // queryReporting) — no write-capable action in this tool's schema at all,
  // unlike its sibling call_google_ads_api (CREATE/UPDATE/REMOVE), which stays
  // unflagged on purpose.
  readOnly: true,
};

export const GOOGLE_ADS_TOOL_NAMES = ['call_google_ads_api', 'call_google_ads_reporting_api'] as const;

/** Google-Ads-only registry: what the Zoma Google Ads toolkit is allowed to see. */
export const googleAdsToolRegistry = new McpToolRegistry();
googleAdsToolRegistry.register(callGoogleAdsApiTool);
googleAdsToolRegistry.register(callGoogleAdsReportingApiTool);
