import { parseBusinessUseCaseUsage, type CapiUsage } from '../utils/metaBusinessUsage';
export { parseBusinessUseCaseUsage, type CapiUsage } from '../utils/metaBusinessUsage';
import {
  normaliseUserDataField,
  NormalisableUserDataField,
} from './metaUserDataNormalisation';
import { FacebookAdsApi, User, AdAccount, Campaign, AdSet, AdCreative, Ad, CustomAudience } from 'facebook-nodejs-business-sdk';
import axios from 'axios';
import * as crypto from 'crypto';
import { MetaAdAccount, MetaPage } from '../types/meta';
import { INTEGRATION_CONFIG } from '../config/integrations';
import { getMetaCredentials } from '../utils/secretsManager';
import { buildUtmSpec, readUtmKeys, utmQueryString, mergeUtmIntoQueryString, utmKeysInQueryString } from '../utils/adUtm';

// Meta offsets differ from ISO defaults (notably TWD, HUF and IDR).
// https://developers.facebook.com/docs/marketing-api/currencies/
// Keep an explicit allow-list: a new/unknown currency must never imply offset 100.
const META_CURRENCY_OFFSETS = new Map<string, number>([
  ...'TWD JPY KRW CLP COP CRC HUF ISK IDR PYG VND'.split(' ').map(code => [code, 1] as [string, number]),
  ...('AED ARS AUD BDT BGN BHD BOB BRL CAD CHF CNY CZK DKK DZD EGP EUR FBZ GBP GTQ HKD HNL HRK ' +
    'ILS INR JOD KES LKR LTL LVL MOP MXN MYR NGN NIO NOK NZD PEN PHP PKR PLN QAR RON RSD RUB SAR SEK SGD SKK THB TRY UAH USD UYU VEF VES ZAR')
    .split(' ').map(code => [code, 100] as [string, number]),
]);

/** One conversion for agent major-unit inputs and Meta minor-unit read-backs. */
export function normalizeMetaMoney(value: unknown, currency: unknown, unit: 'major' | 'minor' = 'major') {
  const offset = typeof currency === 'string' ? META_CURRENCY_OFFSETS.get(currency) : undefined;
  if (offset === undefined) {
    throw new Error(`Unsupported or missing Meta ad account currency ${JSON.stringify(currency)}; money write rejected.`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Meta money amounts must be finite, non-negative numbers in the ad account currency.');
  }
  const scaled = unit === 'major' ? value * offset : value;
  const minorUnits = Math.round(scaled);
  if (!Number.isSafeInteger(minorUnits) || (scaled > 0 && minorUnits === 0) || Math.abs(scaled - minorUnits) > 1e-7) {
    throw new Error(`Meta money amount ${value} cannot be represented in ${currency} minor units.`);
  }
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: currency as string, minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(minorUnits / offset);
  return { minorUnits, description: `${minorUnits} (= ${formatted})` };
}

export interface MetaAdsCampaignParams {
  name: string;
  objective: string;
  status?: string;
  special_ad_categories?: string[];
  // SDK-layer money fields are already normalized to Meta minor units by the agent.
  daily_budget?: number;
  spend_cap?: number;
}

export interface MetaAdsAdSetParams {
  name: string;
  campaign_id: string;
  daily_budget?: number; // Budget in Meta minor units. Caller must normalize by account currency.
  lifetime_budget?: number; // Budget in Meta minor units. Caller must normalize by account currency.
  start_time?: string;
  end_time?: string;
  billing_event: string;
  optimization_goal: string;
  bid_strategy?: string;
  bid_amount?: number; // Bid in Meta minor units. Caller must normalize by account currency.
  targeting: any;
  status?: string;
  promoted_object?: any;
  // Conversion location for the ad set (e.g. 'WEBSITE', 'ON_AD' for instant forms, 'MESSENGER',
  // 'APP'). When omitted Meta stores UNDEFINED and the ad-level Destination reads as "not selected"
  // in Ads Manager (ENG-415). agentModeService.createMetaAdsAdSet defaults this to 'WEBSITE' for
  // website optimization goals.
  destination_type?: string;
  // Dayparting (ENG-842). Meta requires a lifetime_budget (and therefore end_time) for this to take
  // effect — agentModeService.createMetaAdsAdSet enforces that rule and defaults pacing_type to
  // ['day_parting'] whenever adset_schedule is present and pacing_type was not explicitly set,
  // because Meta silently ignores adset_schedule without it.
  adset_schedule?: Array<{ start_minute: number; end_minute: number; days: number[]; timezone_type?: string }>;
  pacing_type?: string[];
}

export interface MetaPlacementAsset {
  image_hash?: string;
  image_url?: string;
  // Friendly placement group tokens (e.g. ["story", "reels"]) that this image should serve to.
  // Omit (or set is_default) on exactly one asset to designate the fallback image (typically the
  // square/4:5 Feed image) that serves every placement not matched by another rule.
  placements?: string[];
  is_default?: boolean;
  // Power-user escape hatch: a raw Meta customization_spec to use verbatim instead of `placements`.
  customization_spec?: any;
}

export interface MetaAdsAdCreativeParams {
  name: string;
  page_id: string;
  // Instagram actor for the creative. Required by Meta when the creative serves Instagram
  // placements (e.g. placement_assets targeting story/reels) — without it, attaching the creative
  // to an ad fails with error_subcode 1772103 "Instagram Account Is Missing". For placement_assets
  // creatives the agentMode layer auto-resolves this from the Page when omitted.
  instagram_user_id?: string;
  image_hash?: string;
  image_url?: string;
  video_id?: string;
  carousel_cards?: Array<{
    image_hash?: string;
    image_url?: string;
    title?: string;
    description?: string;
    link_url?: string;
    video_id?: string;
  }>;
  // Placement-level asset customization: map different images to different placements within a
  // single creative (e.g. square → Feed, 9:16 → Stories/Reels) via Meta's asset_feed_spec /
  // asset_customization_rules. Mutually exclusive with video_id and carousel_cards.
  placement_assets?: MetaPlacementAsset[];
  body: string;
  title: string;
  // Link description: the small line under the headline (link_data.description; video_data.link_description;
  // asset_feed_spec.descriptions for placement_assets creatives).
  description?: string;
  link_url: string;
  call_to_action_type?: string;
  // URL append rules (UTM parameters). Stored on the creative as `url_tags` and applied by Meta to
  // the destination link at delivery time. Must be carried over on a creative swap, otherwise a
  // link_url update silently strips the ad's tracking parameters.
  url_tags?: string;
  // ENG-2915 multi-variant (Advantage+ / dynamic) creative: several text and media options in ONE
  // creative via asset_feed_spec; Meta picks the combination per placement/person. Present ⇒ the
  // singular body/title/description/image_hash/video_id are not used (see validateMultiVariantCreative).
  headlines?: string[];
  bodies?: string[];
  descriptions?: string[];
  image_hashes?: string[];
  video_ids?: string[];
  // video_id → thumbnail URL. asset_feed_spec.videos needs a thumbnail per video.
  video_thumbnails?: Record<string, string>;
}

/** ENG-2915: Meta's asset_feed_spec ceilings for a multi-variant creative. */
export const MULTI_VARIANT_LIMITS = {
  texts: 5,
  media: 10,
  headlineChars: 255,
  descriptionChars: 255,
  bodyChars: 2200,
} as const;
export const MULTI_VARIANT_KEYS = ['headlines', 'bodies', 'descriptions', 'image_hashes', 'video_ids'] as const;

export interface MetaAdsAdParams {
  name: string;
  adset_id: string;
  creative_id: string;
  status?: string;
}

/**
 * Meta's default page on the list edges is 25 records. Asking for a larger page fetches the
 * same data in fewer round trips — it does not fetch more data, and it is not what bounds the
 * read; `META_LIST_MAX_PAGES` is.
 */
export const META_LIST_PAGE_SIZE = 100;

/**
 * Hard bound on how far a single list call will walk (100 x 25 = 2,500 records). Every real
 * ad account we serve is far inside this. Crossing it returns `truncated: true` rather than a
 * silently short list — see `MetaService.drainCursor`.
 */
export const META_LIST_MAX_PAGES = 25;

/**
 * Wall-clock ceiling for one paginated list walk.
 *
 * Page count alone bounds the WORK but not the TIME: `drainCursor` awaits each page
 * sequentially, so 25 slow pages compound into a request that is technically bounded and
 * practically hung. This PR is what made that compounding possible — the previous code issued a
 * single request — so the tail it introduced is bounded here.
 *
 * Deliberately NOT a per-call transport timeout: that would have to be configured on the SDK's
 * shared HTTP layer and would silently change every other Meta call in this service. A single
 * hung request was already possible before this change and is not what this guards.
 *
 * Crossing it returns `truncated: true`, reusing the same "incomplete, do not conclude absence"
 * contract as the page bound rather than inventing a second failure mode.
 */
export const META_LIST_MAX_MS = 45_000;


/**
 * Ceiling on how long ONE Graph read may block this request.
 *
 * The page bound limits how MANY calls happen; `META_LIST_MAX_MS` limits the loop; neither
 * limits a SINGLE call that never answers. A hung request parks execution inside `await`, so
 * the loop's own clock check never runs again.
 *
 * ⚠ Applied ONLY to the read paths in this file (ownership lookup, initial list, each page).
 * It is deliberately NOT installed on the SDK's shared HTTP layer, because that layer is a
 * process-wide singleton (`FacebookAdsApi.init` -> `setDefaultApi`) whose `Http.request` is a
 * static with no per-call options — patching it would put a client-side deadline on every WRITE
 * too. A timed-out write is the dangerous case: pausing an ad or creating a campaign may have
 * SUCCEEDED on Meta's side while we report failure, so a retry double-creates, or we tell a
 * customer an ad is still running when we just paused it. Abandoning a READ has no such
 * ambiguity — nothing changed.
 *
 * Deliberately generous. A 100-record ad list with nested `creative{...}` expansion is a genuinely
 * heavy Graph call, and the costly mistake here is the opposite of the obvious one: too short a
 * deadline breaks reads that work today, which is a REGRESSION, while too long merely extends a
 * wait that was previously unbounded anyway. So this is a backstop against a hang, not a latency
 * target. One slow page fits inside META_LIST_MAX_MS; a second cannot, so the loop then stops and
 * reports `truncated` rather than grinding on.
 *
 * ⚠ That last sentence holds for the 45s default and NOT for the launch path, which passes
 * `maxMs: META_LAUNCH_READ_MAX_MS` (240s) — there roughly eight slow pages fit. Deliberate: a
 * truncated read refuses a launch rather than degrading an answer, so stopping early is the
 * expensive outcome. Worst case is the 240s loop plus one in-flight 30s page, ~270s, against
 * nginx `proxy_read_timeout` and the ALB `IdleTimeout` of 600s — checked, with headroom.
 */
export const META_READ_CALL_TIMEOUT_MS = 30_000;

/** Which node a list read was actually scoped to. Empty object means account-wide. */
export interface MetaAdListScope {
  campaignId?: string;
  adSetId?: string;
}

/**
 * Statuses that must never appear in a list of an account's ads.
 *
 * `effective_status` is sent as a request param, but Meta's documented habit with a param it
 * does not support on a given edge is to IGNORE it — that is precisely the bug this file is
 * fixing, where `adset_id` was accepted and discarded. `effective_status` is proven on the
 * account edge; on the campaign/ad-set node edges we do not get to assume it, and a silently
 * ignored status filter would start reporting deleted and archived ads as real ones.
 *
 * So the same intent is enforced client-side as a net. Deliberately a DENY list, not an allow
 * list: an allow list would silently drop any status Meta adds later, which is the same
 * class of silent omission this whole change exists to remove.
 */
const NON_LIVE_AD_STATUSES = new Set(['DELETED', 'ARCHIVED']);

/**
 * A list read plus the truth about its completeness.
 *
 * ENG-1476 / ENG-1584 both came from returning a bare array: page 1 of 25 is indistinguishable
 * from a whole account once it is just `any[]`, so every caller downstream reported a partial
 * read as a complete one. `truncated` exists so that is no longer expressible.
 */
export interface MetaAdListResult {
  ads: any[];
  truncated: boolean;
  pagesFetched: number;
  scope: MetaAdListScope;
}

/** Same contract as `MetaAdListResult`, for the ad-creative edge. */
export interface MetaAdCreativeListResult {
  creatives: any[];
  truncated: boolean;
  pagesFetched: number;
  scope: MetaAdListScope;
}

/**
 * Same contract, for the campaign edge. No `scope` field: a campaign list is not scoped to a
 * parent the way ad sets/ads are (`options.campaignId` selects ONE campaign directly rather
 * than filtering a list), so there is nothing to name here.
 */
export interface MetaCampaignListResult {
  campaigns: any[];
  truncated: boolean;
  pagesFetched: number;
}

/** Same contract as `MetaAdListResult`, for the ad-set edge (scoped by campaign). */
export interface MetaAdSetListResult {
  adSets: any[];
  truncated: boolean;
  pagesFetched: number;
  scope: MetaAdListScope;
}

/** Same contract, for the custom-audience edge. Not scopable by campaign/ad set. */
export interface MetaCustomAudienceListResult {
  audiences: any[];
  truncated: boolean;
  pagesFetched: number;
}

/** Same contract, for the pixels (adspixels) edge. Not scopable by campaign/ad set. */
export interface MetaPixelListResult {
  pixels: any[];
  truncated: boolean;
  pagesFetched: number;
}

export interface MetaOAuthConnectionHealth {
  pageCount: number;
  pageIds: string[];
  pagesError?: string;
  grantedPermissions: string[];
  declinedRequiredPermissions: string[];
  permissionsError?: string;
}

/**
 * The one sentence every ad-account ownership refusal carries (`assertOwnedByAccount`).
 *
 * A constant, not a literal repeated at the read site, because the pairing is load-bearing: a
 * caller that has to tell "this node belongs to another ad account" apart from "Meta blipped"
 * gets it wrong silently if the wording drifts, and gets it wrong in the permissive direction.
 */
export const META_ACCOUNT_SCOPE_REFUSAL_MARKER = 'is not available in the selected ad account';

/**
 * True only for a refusal thrown by the ad-account ownership guard — never for a transient
 * Graph failure.
 *
 * Both arrive at a caller's `catch` as an Error, and they mean opposite things. A timeout, a
 * 5xx or a rate limit says "we could not look"; this says "we looked, and the node is out of
 * scope". A caller that treats the second as the first degrades to a best-effort path and
 * carries on with a node it has been told not to touch.
 *
 * Deliberately does NOT match `assertNodeInAccount`'s unverifiable-lookup message ("Could not
 * verify the requested … please retry"), which is a genuine transient and must keep the
 * best-effort behaviour.
 */
export function isMetaAccountScopeRefusal(error: unknown): boolean {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message.includes(META_ACCOUNT_SCOPE_REFUSAL_MARKER);
}

export class MetaService {
  private static instance: MetaService;

  private constructor() {
    // SDK is initialized per request with access token
  }

  public static getInstance(): MetaService {
    if (!MetaService.instance) {
      MetaService.instance = new MetaService();
    }
    return MetaService.instance;
  }

  private appId: string | null = null;
  private appSecret: string | null = null;

  /**
   * Initialize the Facebook Ads API with the provided access token
   */
  private initApi(accessToken: string): InstanceType<typeof FacebookAdsApi> {
    const api = FacebookAdsApi.init(accessToken);
    return api;
  }

  private log(message: string, data?: any) {
    console.log(`[MetaService] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  }

  /**
   * Config fields readable on a Campaign / Ad Set via the Graph API GET. These are the
   * allow-lists the marketing wrapper honors for CAMPAIGN / AD_SET LIST + GET `fields`.
   * They include the fields that actually define what an ad set optimizes for
   * (optimization_goal, billing_event, destination_type, promoted_object, bid_strategy)
   * and the campaign budget/bid fields — none of which the wrapper could read before
   * (ENG-398). A field outside the allow-list is rejected LOUDLY (see resolveReadFields),
   * never silently dropped, so a caller learns its request was wrong instead of getting a
   * quietly-incomplete payload (feedback-avoid-fallbacks).
   */
  private static readonly CAMPAIGN_READ_FIELDS = [
    'id', 'name', 'status', 'objective',
    'daily_budget', 'lifetime_budget', 'budget_remaining', 'spend_cap',
    'bid_strategy', 'start_time', 'stop_time',
    // ENG-1625: both are real, documented Campaign GET fields (effective_status already
    // used for ads at listAds) that a post-deploy read-back legitimately wants — status
    // alone doesn't reflect ad-set/ad-level pausing, and special_ad_categories is a
    // CREATE-time param worth verifying stuck. Missing from the allow-list, a request for
    // either threw loudly (by design, ENG-398) rather than silently dropping — but that
    // meant a routine verification read failed instead of just answering the question.
    'effective_status', 'special_ad_categories',
  ] as const;

  private static readonly AD_SET_READ_FIELDS = [
    'id', 'name', 'status', 'campaign_id',
    'optimization_goal', 'billing_event', 'destination_type', 'promoted_object', 'bid_strategy', 'bid_amount',
    'daily_budget', 'lifetime_budget', 'start_time', 'end_time', 'targeting',
    // ENG-2303: documented AdSet field; the toolkit write read-back reports it.
    'effective_status',
  ] as const;

  /**
   * Resolve a caller-supplied `fields` selection against the readable allow-list.
   * - undefined / empty  -> returns null, signalling "use the default field list".
   * - a comma string or a string[] -> trimmed, validated, and returned as string[].
   * Throws LOUDLY if any requested field is not in `allowed` — never silently reduces
   * the selection to the supported subset (that silent reduction is the ENG-398 bug).
   */
  private resolveReadFields(
    requested: string | string[] | undefined | null,
    allowed: readonly string[],
    entityLabel: string
  ): string[] | null {
    if (requested === undefined || requested === null) return null;
    const list = Array.isArray(requested) ? requested : String(requested).split(',');
    const cleaned = list.map(f => f.trim()).filter(Boolean);
    if (cleaned.length === 0) return null;
    const unsupported = cleaned.filter(f => !allowed.includes(f));
    if (unsupported.length > 0) {
      throw new Error(
        `Unsupported ${entityLabel} field(s): ${unsupported.join(', ')}. ` +
        `Supported fields: ${allowed.join(', ')}.`
      );
    }
    return cleaned;
  }

  /**
   * Handle SDK errors
   */
  private handleError(error: any, context?: string): void {
    if (context) {
      console.error(`[MetaAdsError] --- START ERROR LOG ---`);
      console.error(`[MetaAdsError] Context: ${context}`);
      
      const fbError = error.response || error.error || error;
      const responseData = error.response?.data || error.response || {};
      
      const structuredError: any = {
        message: responseData.message || fbError.message || error.message,
        code: responseData.code || fbError.code || error.code,
        error_subcode: responseData.error_subcode || fbError.error_subcode || error.error_subcode,
        error_user_title: responseData.error_user_title || fbError.error_user_title || error.error_user_title,
        error_user_msg: responseData.error_user_msg || fbError.error_user_msg || error.error_user_msg,
        fbtrace_id: responseData.fbtrace_id || fbError.fbtrace_id || error.fbtrace_id,
        classification: 'UNKNOWN_ERROR'
      };

      // Deterministic Error Classification
      const code = Number(structuredError.code);
      if (code === 100) {
        structuredError.classification = 'VALIDATION_ERROR';
      } else if ([1, 2, 4, 17].includes(code)) {
        structuredError.classification = 'RETRYABLE_ERROR';
      } else if (code === 368) {
        structuredError.classification = 'RETRYABLE_WITH_BACKOFF';
      } else if (code === 10 || (code >= 200 && code <= 299)) {
        structuredError.classification = 'PERMISSION_ERROR';
      }

      console.error(`[MetaAdsError] Structured Data:`, JSON.stringify(structuredError, null, 2));
      console.error(`[MetaAdsError] --- END ERROR LOG ---`);
      
      // Attach structured error to the original error object before throwing
      const enhancedError = error instanceof Error ? error : new Error(structuredError.message);
      (enhancedError as any).structuredError = structuredError;
      throw enhancedError;
    }

    console.error('Meta SDK Error:', error);

    // The SDK error structure might vary, but typically it has a response object
    const responseBy = error.response;

    if (responseBy) {
      const status = responseBy.status;
      // Try to extract error message safely
      const data = responseBy.data || {};
      const message = data.error?.message || error.message;

      if (status === 401 || status === 190) {
        throw new Error('Meta access token expired or invalid');
      }
      if (status === 403) {
        throw new Error(`Meta Permission Denied: ${message}`);
      }
      if (status === 429) {
        throw new Error('Meta rate limit exceeded');
      }
      throw new Error(`Meta API Error: ${message}`);
    }

    throw error;
  }

  public setAppCredentials(appId: string, appSecret: string) {
    this.appId = appId;
    this.appSecret = appSecret;
  }

  /**
   * Greptile P1 ("Invalid requests now require session storage"): validates ONLY
   * the objective-INDEPENDENT campaign fields (name, special_ad_categories
   * shape) — no DB access. Called BEFORE the ENG-400 objective gate so a
   * request missing basic required fields is rejected deterministically,
   * without ever touching session storage, exactly as it was before the gate
   * was reordered to run first. Objective itself is validated separately, by
   * construction, via the gate (which only ever returns a value from the
   * fixed valid-objective set).
   */
  public static validateCampaignParamsExceptObjective(action: string, params: Partial<MetaAdsCampaignParams>): void {
    if (action !== 'CREATE') return;

    if (!params.name) {
      throw new Error('Campaign CREATE requires "name".');
    }
    if (params.special_ad_categories !== undefined && !Array.isArray(params.special_ad_categories)) {
      throw new Error('Campaign "special_ad_categories" must be an array (e.g. ["NONE"]).');
    }
    MetaService.assertValidSpendCap(params.spend_cap);
    MetaService.assertNoUnappliedCampaignCreateParams(params);
  }

  /** Validate the agent's major-unit spend cap before account-aware normalization. */
  public static assertValidSpendCap(value: unknown): void {
    if (value === undefined || value === null) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(
        `Campaign "spend_cap" must be a positive amount in the ad account currency (e.g. 3000 = $3,000 USD) — got ${JSON.stringify(value)}. ` +
        `Supply major units; the server converts using the ad account currency. ` +
        `To remove an existing cap, do not send 0 — Meta rejects that.`
      );
    }
  }

  /**
   * Params `createCampaign` actually forwards to Meta, plus the ones this layer legitimately
   * consumes before the call (the objective gate's `objective_quote`, the write-confirmation
   * gate's `confirm`, and the wrapper-injected `account_id`). Anything else a caller sends on
   * CAMPAIGN CREATE is dropped by createCampaign's literal-key allow-list.
   */
  private static readonly CAMPAIGN_CREATE_APPLIED_PARAMS = [
    'name', 'objective', 'status', 'special_ad_categories', 'spend_cap',
    'advantage_campaign_budget', 'budget_amount',
  ] as const;

  private static readonly CAMPAIGN_CREATE_CONSUMED_PARAMS = [
    'account_id', 'objective_quote', 'confirm', 'fields',
  ] as const;

  /**
   * Reject a CAMPAIGN CREATE param that would not be applied, BEFORE anything is created.
   * A silently-dropped param plus a success message is how a campaign was created with no
   * spend cap while the operator was told the cap was in place (ENG-1018) — money-affecting
   * fields must fail loudly. Rejecting pre-flight means nothing is created, so the caller
   * fixes the params and retries with no orphaned campaign to clean up.
   *
   * This deliberately refuses ANY param outside the mapped set, including genuine Meta
   * campaign fields. Forwarding those was tried and reverted: a live create with
   * `start_time` on the test ad account was accepted by Meta with no error and then
   * IGNORED (the campaign read back the 1969 epoch placeholder — campaign scheduling comes
   * from the ad sets), while `buying_type` in the same call applied. Passing a field through
   * therefore does not mean it takes effect, and we cannot tell which is which without
   * per-field knowledge — so forwarding would have rebuilt this very bug one layer up:
   * accepted, reported successful, never applied. A loud refusal that names the field is
   * worse UX and better behaviour.
   */
  private static assertNoUnappliedCampaignCreateParams(params: Partial<MetaAdsCampaignParams>): void {
    const handled = new Set<string>([
      ...MetaService.CAMPAIGN_CREATE_APPLIED_PARAMS,
      ...MetaService.CAMPAIGN_CREATE_CONSUMED_PARAMS,
    ]);
    const unapplied = Object.keys(params || {}).filter(
      key => !handled.has(key) && (params as any)[key] !== undefined
    );
    if (unapplied.length === 0) return;

    throw new Error(
      `Campaign CREATE does not support param(s): ${unapplied.join(', ')} — they would NOT be applied ` +
      `to the campaign, so this create was rejected instead of silently ignoring them. ` +
      `Supported CAMPAIGN CREATE params: ${MetaService.CAMPAIGN_CREATE_APPLIED_PARAMS.join(', ')}. ` +
      `Campaign-level budget: set advantage_campaign_budget=true plus budget_amount (in account currency major units) — ` +
      `do NOT pass daily_budget/lifetime_budget here. ` +
      `Hard spend cap: spend_cap (in account currency major units, e.g. 3000 = $3,000 USD). ` +
      `Scheduling (start_time/stop_time) comes from the campaign's AD SETS — Meta accepts those ` +
      `on a campaign create and then ignores them, so set them on AD_SET CREATE. ` +
      `Ad-set fields (bid_strategy, bid_amount, targeting, ` +
      `optimization_goal, billing_event, end_time) belong on AD_SET CREATE too.`
    );
  }

  /**
   * Validate campaign params before hitting the Meta API.
   * Throws a descriptive Error if validation fails.
   */
  public static validateCampaignParams(action: string, params: Partial<MetaAdsCampaignParams>): void {
    if (action !== 'CREATE') return;

    if (!params.name) {
      throw new Error('Campaign CREATE requires "name".');
    }

    const validObjectives = [
      'OUTCOME_TRAFFIC',
      'OUTCOME_AWARENESS',
      'OUTCOME_ENGAGEMENT',
      'OUTCOME_SALES',
      'OUTCOME_LEADS',
      'OUTCOME_APP_PROMOTION'
    ];
    if (!params.objective) {
      throw new Error(`Campaign CREATE requires "objective". Valid values: ${validObjectives.join(', ')}.`);
    }
    if (!validObjectives.includes(params.objective)) {
      throw new Error(`Invalid objective "${params.objective}". Must be one of: ${validObjectives.join(', ')}.`);
    }

    if (params.special_ad_categories !== undefined && !Array.isArray(params.special_ad_categories)) {
      throw new Error('Campaign "special_ad_categories" must be an array (e.g. ["NONE"]).');
    }

    MetaService.assertValidSpendCap(params.spend_cap);
    MetaService.assertNoUnappliedCampaignCreateParams(params);
  }

  /**
   * Validate ad creative params before hitting the Meta API.
   * Throws a descriptive Error if validation fails.
   */
  public static validateCreativeParams(action: string, params: Partial<MetaAdsAdCreativeParams>): void {
    if (action !== 'CREATE') return;
    if (MetaService.isMultiVariantCreative(params)) {
      MetaService.validateMultiVariantCreative(params);
      return;
    }

    // name, page_id, body are required for all creative types
    for (const field of ['name', 'page_id', 'body'] as Array<keyof MetaAdsAdCreativeParams>) {
      if (!params[field]) {
        throw new Error(`Ad Creative CREATE requires "${field}".`);
      }
    }

    const hasVideo = !!params.video_id;
    const hasCarousel = !!params.carousel_cards;
    const hasPlacementAssets = !!params.placement_assets;
    const hasImage = !!(params.image_hash || params.image_url);

    // title and link_url are only required for non-carousel creatives (for carousel they live per-card)
    if (!hasCarousel) {
      for (const field of ['title', 'link_url'] as Array<keyof MetaAdsAdCreativeParams>) {
        if (!params[field]) {
          throw new Error(`Ad Creative CREATE requires "${field}".`);
        }
      }
    }

    // The four creative types are mutually exclusive — exactly one shape per creative.
    const typeCount = [hasVideo, hasCarousel, hasPlacementAssets].filter(Boolean).length;
    if (typeCount > 1) {
      throw new Error(
        'Ad Creative CREATE: "video_id", "carousel_cards", and "placement_assets" are mutually exclusive. ' +
        'For a video creative provide video_id; for carousel provide carousel_cards (2–10 items); ' +
        'for placement-customized images provide placement_assets; for a single image provide image_hash or image_url.'
      );
    }

    if (hasPlacementAssets) {
      MetaService.validatePlacementAssets(params.placement_assets!);
      return; // placement assets validated
    }

    if (hasCarousel) {
      if (!Array.isArray(params.carousel_cards) || params.carousel_cards.length < 2 || params.carousel_cards.length > 10) {
        throw new Error('Ad Creative CREATE: "carousel_cards" must be an array of 2–10 items.');
      }
      for (let i = 0; i < params.carousel_cards.length; i++) {
        const card = params.carousel_cards[i];
        if (!card.image_hash && !card.image_url && !card.video_id) {
          throw new Error(`Ad Creative CREATE: carousel_cards[${i}] must have at least one of image_hash, image_url, or video_id.`);
        }
      }
      return; // carousel validated
    }

    if (hasVideo) {
      // Meta requires a thumbnail for video creatives (image_hash or image_url)
      if (!hasImage) {
        throw new Error(
          'Ad Creative CREATE: video creatives require a thumbnail. ' +
          'Provide image_hash (from UPLOAD_IMAGE) or image_url alongside video_id. ' +
          'Upload a thumbnail image first using AD_CREATIVE UPLOAD_IMAGE, then pass the returned image_hash.'
        );
      }
      return; // video + thumbnail validated
    }

    if (!hasImage) {
      throw new Error(
        'Ad Creative CREATE: must specify a creative type. ' +
        'For a video creative provide video_id + image_hash/image_url (thumbnail); ' +
        'for carousel provide carousel_cards (2–10 items); ' +
        'for placement-customized images provide placement_assets; ' +
        'for image provide image_hash or image_url.'
      );
    }
  }

  /** ENG-2915: any multi-variant list present ⇒ the creative is built from asset_feed_spec. */
  public static isMultiVariantCreative(params: Partial<MetaAdsAdCreativeParams> | undefined | null): boolean {
    return !!params && MULTI_VARIANT_KEYS.some((k) => (params as any)[k] !== undefined && (params as any)[k] !== null);
  }

  /**
   * ENG-2915: validate a multi-variant creative and fold any singular field into its list, so the
   * builder sees one shape. Throws a descriptive Error naming the offending field.
   */
  public static normalizeMultiVariantCreative(
    params: Partial<MetaAdsAdCreativeParams>,
    opts: { requireThumbnails?: boolean } = {},
  ): {
    headlines: string[]; bodies: string[]; descriptions: string[]; image_hashes: string[]; video_ids: string[];
  } {
    const p: any = params;
    for (const field of ['name', 'page_id', 'link_url'] as const) {
      if (!p[field]) throw new Error(`Multi-variant ad creative CREATE requires "${field}".`);
    }
    for (const field of ['carousel_cards', 'placement_assets', 'image_url'] as const) {
      if (p[field] !== undefined && p[field] !== null && p[field] !== '') {
        throw new Error(
          `Multi-variant ad creative CREATE cannot use "${field}". ` +
          'Upload each image with AD_CREATIVE UPLOAD_IMAGE and pass the hashes in image_hashes; carousel and placement creatives are separate creatives.',
        );
      }
    }
    const pairs: Array<[string, string]> = [
      ['headlines', 'title'], ['bodies', 'body'], ['descriptions', 'description'], ['image_hashes', 'image_hash'], ['video_ids', 'video_id'],
    ];
    const out: any = {};
    for (const [list, single] of pairs) {
      const hasList = p[list] !== undefined && p[list] !== null;
      const hasSingle = p[single] !== undefined && p[single] !== null && p[single] !== '';
      if (hasList && hasSingle) {
        throw new Error(`Multi-variant ad creative CREATE: pass either "${list}" or "${single}", not both (put every option in "${list}").`);
      }
      const raw = hasList ? p[list] : hasSingle ? [p[single]] : [];
      if (!Array.isArray(raw)) throw new Error(`Multi-variant ad creative CREATE: "${list}" must be an array.`);
      const values = raw.map((v: unknown, i: number) => {
        if (typeof v !== 'string' || !v.trim()) throw new Error(`Multi-variant ad creative CREATE: ${list}[${i}] must be a non-empty string.`);
        return v.trim();
      });
      if (new Set(values).size !== values.length) throw new Error(`Multi-variant ad creative CREATE: "${list}" has duplicate entries.`);
      out[list] = values;
    }
    const L = MULTI_VARIANT_LIMITS;
    const textRules: Array<[string, number, boolean]> = [
      ['headlines', L.headlineChars, true], ['bodies', L.bodyChars, true], ['descriptions', L.descriptionChars, false],
    ];
    for (const [list, maxChars, required] of textRules) {
      const values: string[] = out[list];
      if (required && values.length === 0) throw new Error(`Multi-variant ad creative CREATE requires at least one entry in "${list}".`);
      if (values.length > L.texts) throw new Error(`Multi-variant ad creative CREATE: "${list}" has ${values.length} entries; the maximum is ${L.texts}.`);
      values.forEach((v, i) => {
        if (v.length > maxChars) throw new Error(`Multi-variant ad creative CREATE: ${list}[${i}] is ${v.length} characters; the maximum is ${maxChars}.`);
      });
    }
    for (const list of ['image_hashes', 'video_ids'] as const) {
      if (out[list].length > L.media) throw new Error(`Multi-variant ad creative CREATE: "${list}" has ${out[list].length} entries; the maximum is ${L.media}.`);
    }
    if (out.image_hashes.length + out.video_ids.length === 0) {
      throw new Error('Multi-variant ad creative CREATE needs media: at least one entry in "image_hashes" or "video_ids".');
    }
    out.video_ids.forEach((id: string, i: number) => {
      if (!/^\d+$/.test(id)) throw new Error(`Multi-variant ad creative CREATE: video_ids[${i}] must be a Meta video id.`);
      if (opts.requireThumbnails !== false && !p.video_thumbnails?.[id]) {
        throw new Error(`Multi-variant ad creative CREATE: video ${id} has no thumbnail (video_thumbnails["${id}"]). Wait until the video is processed.`);
      }
    });
    if (p.call_to_action_type !== undefined && !/^[A-Z_]+$/.test(String(p.call_to_action_type))) {
      throw new Error('Multi-variant ad creative CREATE: "call_to_action_type" must be a Meta CTA type such as LEARN_MORE or SHOP_NOW.');
    }
    return out;
  }

  public static validateMultiVariantCreative(params: Partial<MetaAdsAdCreativeParams>): void {
    MetaService.normalizeMultiVariantCreative(params);
  }

  /**
   * ENG-2915: the asset_feed_spec for a multi-variant creative. Text-only variation keeps a
   * single format; images AND videos together use Meta's flexible AUTOMATIC_FORMAT.
   */
  public static buildMultiVariantAssetFeedSpec(params: MetaAdsAdCreativeParams): any {
    const v = MetaService.normalizeMultiVariantCreative(params);
    const spec: any = {
      bodies: v.bodies.map((text) => ({ text })),
      titles: v.headlines.map((text) => ({ text })),
      link_urls: [{ website_url: params.link_url }],
      ad_formats: [v.image_hashes.length && v.video_ids.length ? 'AUTOMATIC_FORMAT' : v.video_ids.length ? 'SINGLE_VIDEO' : 'SINGLE_IMAGE'],
      optimization_type: 'DEGREES_OF_FREEDOM',
    };
    if (v.descriptions.length) spec.descriptions = v.descriptions.map((text) => ({ text }));
    if (v.image_hashes.length) spec.images = v.image_hashes.map((hash) => ({ hash }));
    if (v.video_ids.length) spec.videos = v.video_ids.map((video_id) => ({ video_id, thumbnail_url: params.video_thumbnails![video_id] }));
    if (params.call_to_action_type) spec.call_to_action_types = [params.call_to_action_type];
    return spec;
  }

  /**
   * Friendly placement-group tokens → the Meta customization_spec they expand to.
   * Each spec scopes a rule to specific publisher platforms + positions so a given image
   * only serves the placements it was designed for (e.g. a 9:16 asset for Stories/Reels).
   */
  private static readonly PLACEMENT_SPEC_MAP: Record<string, any> = {
    feed: {
      publisher_platforms: ['facebook', 'instagram'],
      facebook_positions: ['feed'],
      instagram_positions: ['stream'],
    },
    facebook_feed: {
      publisher_platforms: ['facebook'],
      facebook_positions: ['feed'],
    },
    instagram_feed: {
      publisher_platforms: ['instagram'],
      instagram_positions: ['stream'],
    },
    story: {
      publisher_platforms: ['facebook', 'instagram'],
      facebook_positions: ['story'],
      instagram_positions: ['story'],
    },
    stories: {
      publisher_platforms: ['facebook', 'instagram'],
      facebook_positions: ['story'],
      instagram_positions: ['story'],
    },
    facebook_story: {
      publisher_platforms: ['facebook'],
      facebook_positions: ['story'],
    },
    instagram_story: {
      publisher_platforms: ['instagram'],
      instagram_positions: ['story'],
    },
    reels: {
      publisher_platforms: ['facebook', 'instagram'],
      facebook_positions: ['facebook_reels'],
      instagram_positions: ['reels'],
    },
    facebook_reels: {
      publisher_platforms: ['facebook'],
      facebook_positions: ['facebook_reels'],
    },
    instagram_reels: {
      publisher_platforms: ['instagram'],
      instagram_positions: ['reels'],
    },
    explore: {
      publisher_platforms: ['instagram'],
      instagram_positions: ['explore'],
    },
  };

  /** Placement tokens accepted in placement_assets[].placements. */
  public static get supportedPlacementTokens(): string[] {
    return Object.keys(MetaService.PLACEMENT_SPEC_MAP);
  }

  /** True if the given placement token serves an Instagram placement. */
  public static placementTokenTargetsInstagram(token: string): boolean {
    const spec = MetaService.PLACEMENT_SPEC_MAP[String(token).toLowerCase()];
    return !!spec?.publisher_platforms?.includes('instagram');
  }

  /**
   * Validate the placement_assets array used for placement-level image customization.
   * Throws a descriptive Error if validation fails.
   */
  public static validatePlacementAssets(assets: MetaPlacementAsset[]): void {
    if (!Array.isArray(assets) || assets.length < 2) {
      throw new Error(
        'Ad Creative CREATE: "placement_assets" must be an array of at least 2 items ' +
        '(e.g. a square image for Feed and a 9:16 image for Stories/Reels). ' +
        'For a single image use image_hash/image_url instead.'
      );
    }

    let defaultCount = 0;
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      if (!asset.image_hash && !asset.image_url) {
        throw new Error(`Ad Creative CREATE: placement_assets[${i}] must have image_hash or image_url.`);
      }

      const isDefault = asset.is_default || !asset.placements || asset.placements.length === 0;
      if (isDefault) {
        defaultCount++;
      } else {
        for (const token of asset.placements!) {
          if (!asset.customization_spec && !MetaService.PLACEMENT_SPEC_MAP[String(token).toLowerCase()]) {
            throw new Error(
              `Ad Creative CREATE: placement_assets[${i}] has unknown placement "${token}". ` +
              `Supported: ${MetaService.supportedPlacementTokens.join(', ')}.`
            );
          }
        }
      }
    }

    if (defaultCount !== 1) {
      throw new Error(
        `Ad Creative CREATE: placement_assets must designate exactly one default/fallback image ` +
        `(via is_default: true or by omitting placements), found ${defaultCount}. ` +
        `The default serves every placement not matched by another asset.`
      );
    }
  }

  /**
   * Expand a list of friendly placement tokens into a single Meta customization_spec by
   * unioning their publisher_platforms / *_positions. Returns null if no tokens map.
   */
  private static buildCustomizationSpec(placements: string[]): any | null {
    const spec: Record<string, Set<string>> = {};
    for (const token of placements) {
      const mapped = MetaService.PLACEMENT_SPEC_MAP[String(token).toLowerCase()];
      if (!mapped) continue;
      for (const key of Object.keys(mapped)) {
        if (!spec[key]) spec[key] = new Set();
        for (const val of mapped[key]) spec[key].add(val);
      }
    }
    const keys = Object.keys(spec);
    if (keys.length === 0) return null;
    const out: Record<string, string[]> = {};
    for (const key of keys) out[key] = Array.from(spec[key]);
    return out;
  }

  /**
   * Validate ad params before hitting the Meta API.
   * Throws a descriptive Error if validation fails.
   */
  public static validateAdParams(action: string, params: Partial<MetaAdsAdParams> & { adset_id?: string }): void {
    if (action !== 'CREATE') return;

    if (!params.name) {
      throw new Error('Ad CREATE requires "name".');
    }
    if (!params.creative_id) {
      throw new Error('Ad CREATE requires "creative_id". Create an ad creative first using AD_CREATIVE CREATE.');
    }
    if (!params.adset_id) {
      throw new Error('Ad CREATE requires "ad_set_id" (top-level parameter). Specify which ad set this ad belongs to.');
    }
  }

  /** Read and validate the selected account currency before converting money. */
  public async getAdAccountCurrency(adAccountId: string, accessToken: string): Promise<string> {
    this.initApi(accessToken);
    const account = new AdAccount(`act_${adAccountId.replace(/^act_/, '')}`);
    const result = await MetaService.withReadDeadline<any>(() => account.get(['currency']), 'ad account currency');
    const currency: unknown = (result?._data ?? result)?.currency;
    // Validate network data before any write; no cached/default currency guesses.
    normalizeMetaMoney(0, currency);
    return currency as string;
  }

  /**
   * Get ad accounts accessible by the user using Facebook SDK
   * @param accessToken - Meta OAuth access token
   * @returns Array of ad account objects
   */
  async getAdAccounts(accessToken: string): Promise<MetaAdAccount[]> {
    try {
      this.initApi(accessToken);
      const user = new User('me');
      // Do NOT request 'owner' here: since ~June 2026 Meta silently omits every ad
      // account the user does not personally own (business/shared accounts) from the
      // response when 'owner' is in the field list, leaving most customers with an
      // empty list. 'business' is unused downstream, so it is not requested either.
      const fields = ['id', 'name', 'account_id', 'currency', 'account_status'];

      const adAccountsPath = await user.getAdAccounts(fields);

      return adAccountsPath
        .filter((account: any) => account.account_id)
        .map((account: any) => ({
          id: account.id,
          name: account.name,
          account_id: account.account_id,
          currency: account.currency,
          account_status: account.account_status
        }));

    } catch (error: any) {
      this.handleError(error);
      return []; // Unreachable due to throw in handleError
    }
  }

  /**
   * Re-exchange a still-valid long-lived Meta user access token for a fresh
   * 60-day long-lived token.
   *
   * Meta/Facebook do NOT issue refresh tokens for ad-account (Marketing API)
   * access. Instead, a long-lived token that is not yet expired can be swapped
   * for a new one via grant_type=fb_exchange_token. This MUST be done while the
   * current token is still valid — once expired, the only recovery is a full
   * manual reconnect. This is why refreshes need to happen proactively.
   *
   * @param currentToken - The current (still-valid) long-lived access token.
   * @returns The new access token and its lifetime in seconds. `expires_in`
   *          may be absent if Meta returns a non-expiring token, in which case
   *          callers should fall back to the 60-day convention.
   * @throws if the exchange fails (e.g. token already expired/revoked).
   */
  async extendAccessToken(currentToken: string): Promise<{ access_token: string; expires_in?: number }> {
    const { clientId, clientSecret } = await getMetaCredentials();
    const url = `${INTEGRATION_CONFIG.meta.tokenUrl}`;
    const response = await axios.get<any>(url, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: clientId,
        client_secret: clientSecret,
        fb_exchange_token: currentToken,
      },
      timeout: 15000,
    });

    const accessToken = response.data?.access_token;
    if (!accessToken) {
      throw new Error('Meta token exchange returned no access_token');
    }
    return {
      access_token: accessToken,
      expires_in: response.data?.expires_in,
    };
  }

  /**
   * Get pages managed by the user using Facebook SDK
   * IMPORTANT: Each page has its own page_access_token
   * @param accessToken - Meta OAuth user access token
   * @returns Array of page objects with page-specific tokens
   */
  async getPages(accessToken: string): Promise<MetaPage[]> {
    try {
      this.initApi(accessToken);
      const user = new User('me');
      const fields = ['id', 'name', 'access_token', 'category', 'tasks'];
      const params: Record<string, any> = { limit: META_LIST_PAGE_SIZE };

      // Fetch pages (accounts edge on User). Drains pagination (ENG-2232 code
      // review follow-up) — this result no longer only feeds an informational
      // count, it backs the AD_CREATIVE CREATE page_id gate and the wrong-Page
      // cross-check (ENG-2232), both exact-membership checks against the
      // returned set. Before those existed, only taking the first batch was
      // harmless — has_meta_pages is a presence check, unaffected by
      // truncation. Now, an account with more accessible Pages than fit in one
      // batch would have a REAL Page silently missing from this list, and the
      // gate would wrongly block a legitimate creative, or the cross-check
      // would wrongly flag a healthy account as broken.
      const cursor = await MetaService.withReadDeadline<any>(
        () => user.getAccounts(fields, params) as Promise<any>,
        'page list',
      );
      const { items, truncated } = await this.drainCursor(cursor, META_LIST_MAX_PAGES);
      if (truncated) {
        // ENG-2232 code review follow-up: draining pagination closed the
        // "page 1 only" gap, but `drainCursor` can ALSO report truncated:true
        // for a transient page-N fetch failure mid-walk (by design — see its
        // own "a page-N failure must not throw away pages 1..N-1" comment) or
        // for hitting the META_LIST_MAX_PAGES bound. Either way, this result
        // backs exact-membership, absence-sensitive checks (the AD_CREATIVE
        // CREATE page_id gate, the wrong-Page cross-check) where an
        // incomplete list read as complete reproduces the exact bug class
        // this fix exists for, just one layer deeper. Throwing — rather than
        // returning the partial list — means every real caller's EXISTING
        // best-effort try/catch (all five already treat a getPages() failure
        // as "could not determine", never as a confirmed negative) handles
        // this correctly for free, with no caller-side changes needed.
        const message = `Page list pagination stopped early after ${items.length} item(s); treating as undetermined rather than risking an incomplete list being read as complete`;
        this.log(`getPages: ${message}`, { itemsSoFar: items.length });
        throw new Error(message);
      }

      const pages = items.map((page: any) => ({
        id: page.id || page._data?.id,
        name: page.name || page._data?.name,
        access_token: page.access_token || page._data?.access_token,
        category: page.category || page._data?.category,
        tasks: page.tasks || page._data?.tasks
      }));

      if (pages.length > 0) return pages;

      // Meta quirk: tokens whose page access comes via Business Manager task
      // assignment (Facebook Login for Business) return [] from /me/accounts even
      // though the user opted those pages in during consent. The opted-in page IDs
      // ARE present in debug_token granular_scopes, and direct per-page reads work.
      return await this.getPagesFromGranularScopes(accessToken);

    } catch (error: any) {
      this.handleError(error);
      return []; // Unreachable
    }
  }

  /**
   * OAuth-time health check for the two Meta grants that most often look
   * "connected" while being unusable:
   *   - /me/accounts: Pages selected in the consent dialog.
   *   - /me/permissions: required permissions the user explicitly declined.
   *
   * Unlike getPages(), this keeps pagination/read errors distinct from a true
   * zero-Page result so a transient Graph problem never gets persisted as
   * "confirmed no Pages".
   */
  public async checkOAuthConnectionHealth(
    accessToken: string,
    requiredPermissions: readonly string[],
  ): Promise<MetaOAuthConnectionHealth> {
    const apiVersion = process.env.META_API_VERSION || 'v25.0';
    const required = new Set(requiredPermissions.map(p => String(p).trim()).filter(Boolean));
    const result: MetaOAuthConnectionHealth = {
      pageCount: 0,
      pageIds: [],
      grantedPermissions: [],
      declinedRequiredPermissions: [],
    };

    try {
      let after: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < META_LIST_MAX_PAGES; page++) {
        const qs = new URLSearchParams({
          fields: 'id,name,access_token,category,tasks',
          limit: String(META_LIST_PAGE_SIZE),
          access_token: accessToken,
          ...(after ? { after } : {}),
        });
        const res = await fetch(`https://graph.facebook.com/${apiVersion}/me/accounts?${qs.toString()}`);
        const body: any = await res.json();
        if (body?.error) throw new Error(body.error.message || 'Meta returned an error reading Pages');
        if (!Array.isArray(body?.data)) throw new Error('Meta returned an unexpected Page list shape');
        for (const raw of body.data) {
          const id = raw?.id;
          if (typeof id === 'string' && id.trim()) seen.add(id.trim());
        }
        const next = body?.paging?.cursors?.after;
        if (!body?.paging?.next || typeof next !== 'string' || !next.trim()) break;
        after = next.trim();
        if (page === META_LIST_MAX_PAGES - 1) {
          throw new Error(`Page list exceeded ${META_LIST_MAX_PAGES} pages; treating health as unknown`);
        }
      }
      result.pageIds = [...seen];
      result.pageCount = result.pageIds.length;
    } catch (error: any) {
      result.pagesError = error?.message || String(error);
    }

    try {
      const res = await fetch(
        `https://graph.facebook.com/${apiVersion}/me/permissions?access_token=${encodeURIComponent(accessToken)}`
      );
      const body: any = await res.json();
      if (body?.error) throw new Error(body.error.message || 'Meta returned an error reading permissions');
      if (!Array.isArray(body?.data)) throw new Error('Meta returned an unexpected permissions shape');
      const granted = new Set<string>();
      const declined = new Set<string>();
      for (const item of body.data) {
        const permission = typeof item?.permission === 'string' ? item.permission.trim() : '';
        if (!permission) continue;
        if (item?.status === 'granted') granted.add(permission);
        if (item?.status === 'declined' && required.has(permission)) declined.add(permission);
      }
      result.grantedPermissions = [...granted];
      result.declinedRequiredPermissions = [...declined];
    } catch (error: any) {
      result.permissionsError = error?.message || String(error);
    }

    return result;
  }

  /**
   * The scopes Meta ACTUALLY granted for this token, per debug_token.
   *
   * The OAuth finalize path can only ever know what it *requested* — the user is
   * free to untick individual permissions at the consent dialog, and Meta returns
   * the token regardless. Persisting the requested set therefore records a claim
   * we never verified, which is precisely how a connection with no ads permission
   * came to be reported as ads-capable (ENG-629 / OPS-79).
   *
   * Merges the flat `scopes` list with `granular_scopes[].scope`, since object-
   * scoped grants (a specific ad account) appear only in the latter.
   *
   * Returns `undefined` — never `[]` — when the grant could not be determined, so
   * callers can distinguish "we could not ask" from "nothing was granted". Storing
   * an empty array in the former case would later read as an authoritative refusal.
   */
  /**
   * Can this token actually read ads data for this ad account, right now?
   *
   * WHY A REAL READ AND NOT A SCOPE LOOKUP (ENG-1158)
   * -------------------------------------------------
   * Two independent grants have to line up before an ads read works, and only
   * one of them is visible in a token's scopes:
   *
   *   1. the USER granting our app `ads_read` at the OAuth dialog, and
   *   2. the AD ACCOUNT's owner granting that user access to that ad account.
   *
   * Production account 922903076601160 has (1) and not (2). Verified live:
   * `/me/permissions` reports `ads_read` and `ads_management` as granted with
   * nothing declined, while the very same token gets
   * "(#200) Ad account owner has NOT grant ads_management or ads_read permission"
   * from that ad account. Any capability answer derived from scopes alone
   * therefore reports "capable" for exactly the account that cannot read — the
   * trap `utils/metaAdsScope.ts` was written to avoid, one level further down.
   *
   * So we ask the only question that has an authoritative answer: we try. The
   * cheapest read on the ad account node is enough; verified live to succeed on
   * a working account and to return the (#200) refusal on the broken one.
   *
   * Returns 'unknown' for anything that is not a clear yes or a clear ads-scope
   * refusal — a rate limit or an outage must never be read as incapability.
   */
  public async probeAdsAccountAccess(
    accessToken: string,
    adAccountId: string
  ): Promise<'accessible' | 'denied' | 'unknown'> {
    try {
      const apiVersion = process.env.META_API_VERSION || 'v25.0';
      const id = `act_${String(adAccountId).replace('act_', '')}`;
      const res = await fetch(
        `https://graph.facebook.com/${apiVersion}/${id}` +
          `?fields=id&access_token=${encodeURIComponent(accessToken)}`
      );
      const body: any = await res.json();

      if (body?.id) return 'accessible';
      if (!body?.error) return 'unknown';

      // Reuse the deliberately strict predicate rather than re-deciding here:
      // Meta stamps a whole family of unrelated failures as permission errors,
      // and only one of them means "no ads access".
      const { isMetaAdsScopeRefusal } = await import('../utils/metaAdsScope');
      if (isMetaAdsScopeRefusal({ structuredError: body.error, message: body.error?.message })) {
        return 'denied';
      }
      return 'unknown';
    } catch (error: any) {
      console.warn(`[MetaService] probeAdsAccountAccess failed: ${error?.message ?? error}`);
      return 'unknown';
    }
  }

  /**
   * When `probeAdsAccountAccess` has just returned 'denied', which of the two
   * independent grants is actually missing? (ENG-1158 follow-up)
   *
   * The ad-account refusal alone cannot say — Meta stamps the same (#200)
   * shape whether the app never got `ads_read` or the app has it and the ad
   * account's owner just hasn't granted this person access to that asset.
   * Telling an owner who already granted the app scope to "reconnect and
   * approve Ads permissions" sends them through a flow that cannot fix
   * anything and leaves them locked out with no correct next step.
   *
   * Deliberately calls `/me/permissions`, NOT `debug_token` (`getGrantedScopes`).
   * `debug_token` authenticates with an APP token and only answers for a token
   * minted by the app whose credentials are currently configured — verified
   * live to fail with "(#100) The App_id in the input_token did not match the
   * Viewing App" on this repo's own dev test accounts, which would have made
   * this classifier silently inert wherever that mismatch holds. `/me/permissions`
   * authenticates with the USER token being classified, same as
   * `probeAdsAccountAccess`, so it carries no such precondition — this is the
   * exact call the original investigation used to diagnose account
   * 922903076601160 live.
   *
   * present + granted → the app grant is confirmed, so the ad account itself is
   * the gap ('asset'). Absent or declined → the app was never granted the scope
   * ('oauth'). Undetermined (the call itself failed) → 'unknown', which callers
   * must treat as "fall back to the OAuth-tier message" rather than guess.
   */
  public async classifyAdsRefusalTier(accessToken: string): Promise<'oauth' | 'asset' | 'unknown'> {
    try {
      const apiVersion = process.env.META_API_VERSION || 'v25.0';
      const res = await fetch(
        `https://graph.facebook.com/${apiVersion}/me/permissions?access_token=${encodeURIComponent(accessToken)}`
      );
      const body: any = await res.json();

      if (!Array.isArray(body?.data)) {
        console.warn(
          `[MetaService] classifyAdsRefusalTier: /me/permissions returned an unexpected shape: ${body?.error?.message ?? 'no data array'}`
        );
        return 'unknown';
      }

      const { META_ADS_READ_SCOPES } = await import('../utils/metaAdsScope');
      const hasAdsScope = body.data.some(
        (p: any) =>
          (META_ADS_READ_SCOPES as readonly string[]).includes(String(p?.permission).trim()) &&
          p?.status === 'granted'
      );
      return hasAdsScope ? 'asset' : 'oauth';
    } catch (error: any) {
      console.warn(`[MetaService] classifyAdsRefusalTier failed: ${error?.message ?? error}`);
      return 'unknown';
    }
  }

  public async getGrantedScopes(accessToken: string): Promise<string[] | undefined> {
    try {
      const { getMetaCredentials } = await import('../utils/secretsManager');
      const creds = await getMetaCredentials();
      const apiVersion = process.env.META_API_VERSION || 'v25.0';
      const appToken = `${creds.clientId}|${creds.clientSecret}`;

      const res = await fetch(
        `https://graph.facebook.com/${apiVersion}/debug_token` +
          `?input_token=${encodeURIComponent(accessToken)}` +
          `&access_token=${encodeURIComponent(appToken)}`
      );
      const body: any = await res.json();

      if (body?.error) {
        console.warn(`[MetaService] getGrantedScopes: debug_token returned an error: ${body.error?.message ?? 'unknown'}`);
        return undefined;
      }

      const flat: unknown[] = Array.isArray(body?.data?.scopes) ? body.data.scopes : [];
      const granular: unknown[] = Array.isArray(body?.data?.granular_scopes)
        ? body.data.granular_scopes.map((g: any) => g?.scope)
        : [];

      const merged = [...flat, ...granular].filter(
        (s): s is string => typeof s === 'string' && s.trim().length > 0
      );

      if (merged.length === 0) return undefined;
      return Array.from(new Set(merged.map(s => s.trim())));
    } catch (error: any) {
      console.warn(`[MetaService] getGrantedScopes failed: ${error?.message ?? error}`);
      return undefined;
    }
  }

  /**
   * Best-effort fallback for getPages: enumerate the page IDs the user opted in
   * during OAuth (debug_token granular_scopes → pages_show_list.target_ids) and
   * read each page directly. Returns [] on any failure rather than throwing —
   * callers treat "no pages" as a soft state.
   */
  private async getPagesFromGranularScopes(accessToken: string): Promise<MetaPage[]> {
    try {
      const { getMetaCredentials } = await import('../utils/secretsManager');
      const creds = await getMetaCredentials();
      const apiVersion = process.env.META_API_VERSION || 'v25.0';
      const appToken = `${creds.clientId}|${creds.clientSecret}`;

      const dbgRes = await fetch(
        `https://graph.facebook.com/${apiVersion}/debug_token?input_token=${accessToken}&access_token=${appToken}`
      );
      const dbg: any = await dbgRes.json();
      const granular: any[] = dbg?.data?.granular_scopes || [];
      const pageIds: string[] = granular.find((g: any) => g.scope === 'pages_show_list')?.target_ids || [];
      if (pageIds.length === 0) return [];

      const pages: MetaPage[] = [];
      for (const pageId of pageIds) {
        const pageRes = await fetch(
          `https://graph.facebook.com/${apiVersion}/${pageId}?fields=id,name,access_token,category&access_token=${accessToken}`
        );
        const page: any = await pageRes.json();
        if (page?.error || !page?.id) {
          console.warn(`[MetaService] getPages granular fallback: skipping page ${pageId}: ${page?.error?.message ?? 'no id in response'}`);
          continue;
        }
        pages.push({
          id: page.id,
          name: page.name,
          access_token: page.access_token,
          category: page.category,
          // tasks omitted — the field is not readable on business-task-assigned pages
        });
      }
      this.log(`getPages granular fallback returned ${pages.length} page(s)`);
      return pages;
    } catch (error: any) {
      console.warn(`[MetaService] getPages granular fallback failed: ${error?.message ?? error}`);
      return [];
    }
  }

  /**
   * Resolve the Instagram actor ID linked to a Facebook Page. Needed when building creatives that
   * serve Instagram placements (asset_feed_spec with story/reels rules), where Meta requires
   * object_story_spec.instagram_user_id or the ad fails with error_subcode 1772103
   * ("Instagram Account Is Missing"). Returns null if no IG account is linked or on error.
   */
  public async getPageInstagramActor(accessToken: string, pageId: string): Promise<string | null> {
    const extractInstagramActor = (result: any): string | null => {
      const data = result?._data || result || {};
      return data.instagram_business_account?.id || data.connected_instagram_account?.id || null;
    };

    try {
      const api = this.initApi(accessToken);
      // Use the generic Graph call — the SDK's Page object is not exported in its TS types.
      const result: any = await api.call('GET', [pageId], {
        fields: 'instagram_business_account,connected_instagram_account',
      });
      const igId = extractInstagramActor(result);
      if (igId) return igId;
    } catch (error: any) {
      console.warn(`[MetaService] getPageInstagramActor user-token lookup failed for page ${pageId}: ${error?.message}`);
    }

    try {
      const pages = await this.getPages(accessToken);
      const page = pages.find((p: any) => String(p.id) === String(pageId));
      const pageAccessToken = page?.access_token;
      if (!pageAccessToken || pageAccessToken === accessToken) return null;

      const pageApi = this.initApi(pageAccessToken);
      const pageResult: any = await pageApi.call('GET', [pageId], {
        fields: 'instagram_business_account,connected_instagram_account',
      });
      return extractInstagramActor(pageResult);
    } catch (error: any) {
      // Non-fatal: callers proceed without an IG actor (Facebook-only placements still work).
      console.warn(`[MetaService] getPageInstagramActor page-token lookup failed for page ${pageId}: ${error?.message}`);
      return null;
    }
  }

  /**
   * Verify if an access token is still valid
   * @param accessToken - Meta OAuth access token
   * @returns Object with valid status and optional error message
   */
  async verifyToken(accessToken: string): Promise<{ valid: boolean; error?: string }> {
    try {
      this.initApi(accessToken);
      const user = new User('me');
      await user.get(['id']); // Simple fetch to verify token
      return { valid: true };
    } catch (error: any) {
      const responseBy = error.response;
      if (responseBy) {
        const status = responseBy.status;
        if (status === 401 || status === 190) {
          return { valid: false, error: 'Token expired or revoked' };
        }
        if (status === 403) {
          return { valid: false, error: 'Token permissions revoked' };
        }
      }

      console.warn('[Meta verifyToken] Error:', error.message);
      return { valid: false, error: 'Could not verify token' };
    }
  }

  /**
   * Get user profile information
   * @param accessToken - Meta OAuth access token
   * @returns User profile with id, name, and email
   */
  async getUserProfile(accessToken: string): Promise<{
    id: string;
    name: string;
    email?: string;
  }> {
    try {
      this.initApi(accessToken);
      // The SDK returns a User object which should contain the requested fields.
      // TypeScript might not know about dynamic fields, so we cast to any to access them.
      const user = new User('me');
      const response = await user.get(['id', 'name', 'email']) as any;

      return {
        id: response.id,
        name: response.name,
        email: response.email
      };
    } catch (error: any) {
      this.handleError(error);
      throw error;
    }
  }

  /**
   * Get a single campaign
   */
  public async getCampaign(adAccountId: string, accessToken: string, campaignId: string) {
    try {
      this.initApi(accessToken);
      const campaign = new Campaign(campaignId);
      // bid_strategy: under CBO the ad set inherits the campaign's (createMetaAdsAdSet).
      const fields = ['id', 'name', 'status', 'objective', 'daily_budget', 'lifetime_budget', 'budget_remaining', 'spend_cap', 'bid_strategy'];
      this.log(`Fetching campaign: ${campaignId}`);
      /*
       * `adAccountId` was accepted and never used: a node id is global, so this returned any
       * campaign the token could reach. It matters more here than on a plain list, because one
       * caller renders the result's NAME into the confirmation prompt a user approves — so an id
       * from another ad account disclosed that account's campaign name to this user, which is
       * precisely the oracle behaviour assertOwnedByAccount refuses to produce.
       */
      const result = await campaign.get(MetaService.withOwnershipField(fields));
      const data = { ...(result?._data ?? {}) };
      MetaService.assertOwnedByAccount(data.account_id, campaignId, 'Campaign', adAccountId);
      delete data.account_id;
      return data;
    } catch (error) {
      return this.handleError(error, 'getCampaign');
    }
  }

  /**
   * List campaigns for an ad account.
   *
   * `options.fields` selects which config fields to read (validated against the
   * allow-list; unsupported fields throw loudly). When omitted, the default list now
   * includes budget/bid config (daily_budget, lifetime_budget, budget_remaining,
   * bid_strategy) so a plain LIST can actually see what the campaign is set to spend —
   * previously invisible (ENG-398). `options.campaignId` fetches that one campaign
   * directly (the Graph edge has no id filter) and returns it as a one-element list so
   * LIST semantics are preserved.
   *
   * ⚠ ENG-1625 follow-up: the account-wide read used to fetch ONE page with no limit, no
   * deadline, and no drain — the exact ENG-1476/ENG-1584 shape (`Found ${totalCount}
   * campaign(s)` with no bound was the sentence that told an Every.io customer a
   * protected ad did not exist). Paginates and reports truncation the same way `listAds`
   * does. Returns a result object rather than a bare array so truncation cannot be
   * dropped on the floor by a caller that just maps over it.
   */
  public async listCampaigns(
    adAccountId: string,
    accessToken: string,
    options: { campaignId?: string; fields?: string | string[]; maxPages?: number } = {}
  ): Promise<MetaCampaignListResult> {
    // Validate the requested fields BEFORE any API round-trip so an unsupported field is
    // a loud, dependency-free error rather than a silently-reduced payload.
    const fields =
      this.resolveReadFields(options.fields, MetaService.CAMPAIGN_READ_FIELDS, 'campaign') ??
      [...MetaService.CAMPAIGN_READ_FIELDS];
    try {
      this.initApi(accessToken);
      // `!== undefined`, not truthiness: `''` is the input `resolveScopeId` exists to REFUSE, and
      // a truthy test skipped the branch entirely and fell through to the account-wide list —
      // the silent widening the guard was written to stop, on the one input that names it.
      if (options.campaignId !== undefined && options.campaignId !== null) {
        const wantedId = MetaService.resolveScopeId(options.campaignId, 'campaign_id')!;
        this.log(`Fetching single campaign ${wantedId}`, { fields });
        const campaign = new Campaign(wantedId);
        // A node id is global — `new Campaign(id)` is NOT bounded by the ad account the way
        // the `/act_X/` edge is, and one Meta OAuth token routinely spans several ad accounts.
        // Without a check the selected-account scope is advisory: a caller could read a campaign
        // from an account it never selected.
        //
        // `account_id` is requested ALONGSIDE the caller's fields so ownership is answered by the
        // same response as the payload — one round trip, and no separate probe that could fail on
        // its own and refuse a read which would otherwise have succeeded.
        const result = await MetaService.withReadDeadline<any>(
          () => campaign.get(MetaService.withOwnershipField(fields)),
          'single campaign fetch',
        );
        const data = { ...(result?._data ?? {}) };
        MetaService.assertOwnedByAccount(data.account_id, wantedId, 'Campaign', adAccountId);
        // Always requested for the check, never by the caller: `account_id` is in neither
        // READ_FIELDS allow-list, so resolveReadFields would have thrown on an explicit request
        // for it. Dropped unconditionally, so the payload is exactly what the caller selected.
        delete data.account_id;
        return { campaigns: [data], truncated: false, pagesFetched: 1 };
      }
      const account = new AdAccount(`act_${adAccountId}`);
      const params: Record<string, any> = { limit: META_LIST_PAGE_SIZE };
      this.log(`Listing campaigns for account: ${adAccountId}`, { fields, ...params });
      const cursor = await MetaService.withReadDeadline(async () => account.getCampaigns(fields, params), 'campaign list');
      const { items, truncated, pagesFetched } = await this.drainCursor(
        cursor,
        options.maxPages ?? META_LIST_MAX_PAGES
      );
      return { campaigns: items.map((c: any) => c._data ?? c), truncated, pagesFetched };
    } catch (error) {
      // handleError always throws — a failed read must never look like "no campaigns".
      return this.handleError(error, 'listCampaigns') as never;
    }
  }

  /**
   * Create a new campaign. Money fields use Meta minor units, except the legacy
   * budget_amount convenience input. Agent-input validation happens before normalization.
   */
  public async createCampaign(adAccountId: string, accessToken: string, params: MetaAdsCampaignParams) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      const specialCategories = (params.special_ad_categories || [])
        .filter(cat => cat !== 'NONE' && cat !== '');

      // Use literal strings for keys to avoid any SDK field mapping issues
      const finalParams: any = {
        name: params.name,
        objective: params.objective,
        status: params.status || 'PAUSED',
        special_ad_categories: specialCategories,
      };

      // Agent calls supply normalized daily_budget. Direct SDK-wrapper callers may
      // still supply budget_amount in major units; use the same currency normalizer.
      if (params.daily_budget !== undefined) {
        finalParams.daily_budget = params.daily_budget;
      } else if ((params as any).advantage_campaign_budget && (params as any).budget_amount !== undefined) {
        const currency = await this.getAdAccountCurrency(adAccountId, accessToken);
        finalParams.daily_budget = normalizeMetaMoney((params as any).budget_amount, currency).minorUnits;
      }

      // Meta requires is_adset_budget_sharing_enabled (true/false) on a campaign WITHOUT a campaign
      // budget; it describes ad-set budgets, so it is only sent when the campaign has none.
      if (finalParams.daily_budget === undefined) {
        finalParams.is_adset_budget_sharing_enabled = false;
      }

      // ENG-2364: under CBO the bid strategy lives on the campaign. Without one, Meta rejects
      // every ad set with subcode 1815857 ("Bid amount required") even when the ad set asks
      // for LOWEST_COST_WITHOUT_CAP. Send the no-cap default whenever we set a campaign budget.
      if (finalParams.daily_budget !== undefined) {
        finalParams.bid_strategy = 'LOWEST_COST_WITHOUT_CAP';
      }

      // Already normalized by the agent, just like the ad-set SDK write fields.
      if (params.spend_cap !== undefined && params.spend_cap !== null) {
        finalParams.spend_cap = params.spend_cap;
      }

      this.log(`Attempting createCampaign with literal keys:`, finalParams);
      
      // Request 'id' back to ensure we don't get an empty return
      const campaign = await account.createCampaign(['id'], finalParams);
      return campaign._data;
    } catch (error) {
      return this.handleError(error, 'createCampaign');
    }
  }

  /**
   * Update campaign
   *
   * ENG-1724: a campaign id is a GLOBAL node id, so without this check the write reached any
   * campaign the token could touch, not just one in the caller's selected ad account — the
   * write-side counterpart to the read-side gap `getCampaign` already closed. Required (not
   * optional like the read-side scoping on `getAdSet`/`getAd`): a read has legitimate unscoped
   * callers reading their own back-reference; a write does not.
   */
  public async updateCampaign(accessToken: string, campaignId: string, params: any, adAccountId: string) {
    try {
      this.initApi(accessToken);
      const campaign = new Campaign(campaignId);
      await MetaService.verifyWriteOwnership(campaign, campaignId, 'Campaign', adAccountId);
      this.log(`Updating campaign ${campaignId} with params:`, params);
      await campaign.update([], params);
      return { success: true };
    } catch (error) {
      return this.handleError(error, 'updateCampaign');
    }
  }

  /**
   * Delete a campaign
   *
   * ENG-1724: same reasoning as `updateCampaign` above — a delete is the write this guard
   * matters most for, since it is irreversible.
   */
  public async deleteCampaign(accessToken: string, campaignId: string, adAccountId: string) {
    try {
      this.initApi(accessToken);
      const campaign = new Campaign(campaignId);
      await MetaService.verifyWriteOwnership(campaign, campaignId, 'Campaign', adAccountId);
      this.log(`Deleting campaign ${campaignId}`);
      await campaign.delete([], {});
      return { success: true };
    } catch (error) {
      return this.handleError(error, 'deleteCampaign');
    }
  }

  /**
   * List ad sets for an ad account, optionally scoped to one campaign.
   *
   * `options.fields` selects which config fields to read (validated; unsupported fields
   * throw loudly). When omitted, the default list now includes the fields that define
   * what the ad set optimizes for — optimization_goal, billing_event, destination_type,
   * promoted_object, bid_strategy — which the wrapper previously could not read despite
   * being able to WRITE them on CREATE (ENG-398, verify-after-write). `options.adSetId`
   * fetches that one ad set directly and returns it as a one-element list, preserving
   * LIST semantics.
   *
   * ⚠ ENG-1625 follow-up, two defects in the old code at once:
   * 1. Campaign scoping went through a bare `campaign_id` param on `/act_X/adsets`. Meta's
   *    own docs for the account-level adsets edge list only date_preset/effective_status/
   *    is_completed/time_range — `campaign_id` is not among them, the exact shape ENG-1476
   *    found and fixed for the ads edge (`/act_X/ads` silently ignores a bare adset_id/
   *    campaign_id param and returns the whole account). Scoping now goes through Meta's
   *    own node edge (`/{campaign_id}/adsets`) instead, which makes the scope structurally
   *    impossible to ignore — a bad id is an error, never a silent account-wide result.
   *    (Live confirmation against a real ad account was not possible from this workspace —
   *    no path to a live Meta access token was available; see the PR body.)
   * 2. No pagination — the old code returned exactly one page (ENG-1584's shape).
   *
   * Returns a result object rather than a bare array so truncation cannot be dropped on the
   * floor by a caller that just maps over it.
   */
  public async listAdSets(
    adAccountId: string,
    accessToken: string,
    campaignId?: string,
    options: { adSetId?: string; fields?: string | string[]; maxPages?: number } = {}
  ): Promise<MetaAdSetListResult> {
    // Validate requested fields BEFORE any API round-trip (loud, never silently reduced).
    const fields =
      this.resolveReadFields(options.fields, MetaService.AD_SET_READ_FIELDS, 'ad set') ??
      [...MetaService.AD_SET_READ_FIELDS];
    try {
      this.initApi(accessToken);
      // Same reason as the single-campaign branch above.
      if (options.adSetId !== undefined && options.adSetId !== null) {
        const wantedId = MetaService.resolveScopeId(options.adSetId, 'ad_set_id')!;
        this.log(`Fetching single ad set ${wantedId}`, { fields });
        const adSet = new AdSet(wantedId);
        // Same global-node-id boundary, and the same one-round-trip check, as the single
        // campaign fetch above.
        const result = await MetaService.withReadDeadline<any>(
          () => adSet.get(MetaService.withOwnershipField(fields)),
          'single ad set fetch',
        );
        const data = { ...(result?._data ?? {}) };
        MetaService.assertOwnedByAccount(data.account_id, wantedId, 'Ad set', adAccountId);
        // Always requested for the check, never by the caller: `account_id` is in neither
        // READ_FIELDS allow-list, so resolveReadFields would have thrown on an explicit request
        // for it. Dropped unconditionally, so the payload is exactly what the caller selected.
        delete data.account_id;
        return { adSets: [data], truncated: false, pagesFetched: 1, scope: { adSetId: wantedId } };
      }

      const wantedCampaign = MetaService.resolveScopeId(campaignId, 'campaign_id');
      const params: Record<string, any> = { limit: META_LIST_PAGE_SIZE };

      const scope: MetaAdListScope = {};
      let source: any;
      if (wantedCampaign) {
        scope.campaignId = wantedCampaign;
        source = new Campaign(wantedCampaign);
        // Node reads are not account-scoped by construction the way the account edge is —
        // same tenancy boundary listAds/listAdCreatives already enforce.
        await this.assertNodeInAccount(source, wantedCampaign, 'Campaign', adAccountId);
      } else {
        source = new AdAccount(`act_${adAccountId}`);
      }

      this.log(`Listing ad sets for account: ${adAccountId}`, { fields, scope });
      const cursor = await MetaService.withReadDeadline(() => source.getAdSets(fields, params), 'ad set list');
      const { items, truncated, pagesFetched } = await this.drainCursor(
        cursor,
        options.maxPages ?? META_LIST_MAX_PAGES
      );
      return { adSets: items.map((as: any) => as._data ?? as), truncated, pagesFetched, scope };
    } catch (error) {
      // handleError always throws — a failed read must never look like "no ad sets".
      return this.handleError(error, 'listAdSets') as never;
    }
  }

  /**
   * Create a new ad set
   */
  public async createAdSet(adAccountId: string, accessToken: string, params: MetaAdsAdSetParams) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      
      const adSetParams: any = {};
      
      // Mandatory Mapping (Strict !== undefined)
      if (params.name !== undefined) adSetParams[AdSet.Fields.name] = params.name;
      if (params.campaign_id !== undefined) adSetParams[AdSet.Fields.campaign_id] = params.campaign_id;
      if (params.billing_event !== undefined) adSetParams[AdSet.Fields.billing_event] = params.billing_event;
      if (params.optimization_goal !== undefined) adSetParams[AdSet.Fields.optimization_goal] = params.optimization_goal;
      if (params.targeting !== undefined) adSetParams[AdSet.Fields.targeting] = params.targeting;
      if (params.status !== undefined) adSetParams[AdSet.Fields.status] = params.status;
      
      // Monetary values: Expected in Meta minor units (integer). Caller (agentModeService.createMetaAdsAdSet)
      // normalizes major units using the ad account currency before passing to this method.
      if (params.daily_budget !== undefined) adSetParams[AdSet.Fields.daily_budget] = params.daily_budget;
      if (params.lifetime_budget !== undefined) adSetParams[AdSet.Fields.lifetime_budget] = params.lifetime_budget;
      if (params.bid_strategy !== undefined) adSetParams[AdSet.Fields.bid_strategy] = params.bid_strategy;
      if (params.bid_amount !== undefined) adSetParams[AdSet.Fields.bid_amount] = params.bid_amount;

      // Scheduling
      if (params.start_time !== undefined) adSetParams[AdSet.Fields.start_time] = params.start_time;
      if (params.end_time !== undefined) adSetParams[AdSet.Fields.end_time] = params.end_time;
      if (params.promoted_object !== undefined) adSetParams[AdSet.Fields.promoted_object] = params.promoted_object;
      // Conversion location (ENG-415). Literal key — Meta accepts 'destination_type' directly and it
      // is not guaranteed to exist on the SDK's AdSet.Fields enum across versions. Emitted only when
      // present so the payload is byte-identical to before when the caller passes nothing.
      if (params.destination_type !== undefined) adSetParams['destination_type'] = params.destination_type;
      // Dayparting (ENG-842). Emitted only when present so the payload is byte-identical to before
      // for every existing caller that never sends a schedule.
      if (params.adset_schedule !== undefined) adSetParams[AdSet.Fields.adset_schedule] = params.adset_schedule;
      if (params.pacing_type !== undefined) adSetParams[AdSet.Fields.pacing_type] = params.pacing_type;

      // Defensive: Ensure no 'id' or other accidental fields
      delete adSetParams.id;
      delete adSetParams.account_id;

      this.log(`Creating ad set in account: ${adAccountId} with payload:`, adSetParams);
      
      // Note: SDK v24.0.1+ internal POST mapping handlesact_ prefix and body params correctly.
      // Request id+name back explicitly — Meta's create response only echoes an
      // empty fields array as {id}, so callers reading adSet.name (e.g. success
      // message strings) got literal "undefined" against the live API.
      const adSet = await account.createAdSet(['id', 'name'], adSetParams);
      return adSet._data;
    } catch (error: any) {
      return this.handleError(error, 'createAdSet');
    }
  }

  /**
   * Get a single ad set with the fields needed to confirm a write target
   * (name + the campaign it belongs to).
   */
  public async getAdSet(
    accessToken: string,
    adSetId: string,
    /** When supplied, the node is verified to belong to this ad account before anything is
     *  returned. Optional so existing read-back callers are unchanged; the callers whose result
     *  reaches a user-facing prompt pass it. */
    adAccountId?: string,
  ) {
    try {
      this.initApi(accessToken);
      const adSet = new AdSet(adSetId);
      // ENG-838 AC4: the read-back after a create has to be able to prove the
      // spend-shaping settings landed, so the delivery fields ride along with
      // the write-target fields. Requesting more fields does not change the
      // shape callers already read (id/name/status/campaign_id).
      const fields = [
        'id', 'name', 'status', 'campaign_id',
        'bid_strategy', 'bid_amount', 'daily_budget', 'lifetime_budget',
        'start_time', 'end_time'
      ];
      this.log(`Fetching ad set: ${adSetId}`);
      /*
       * `adAccountId !== undefined/null`, not a truthiness test.
       *
       * `if (adAccountId)` treats a caller that SUPPLIED an empty string as one that supplied
       * nothing, and skips the ownership check entirely — so a scope that failed to resolve
       * silently widened the read to any ad set the token can reach. getCampaign fails closed
       * on exactly that input (assertOwnedByAccount refuses when the selected account is
       * blank); these two now agree. `undefined`/`null` still means "not supplied" and
       * legitimately opts out, which is what the post-write read-back callers rely on. Same
       * distinction resolveScopeId already draws for scope ids.
       */
      const scoped = adAccountId !== undefined && adAccountId !== null;
      const result = await adSet.get(
        scoped ? MetaService.withOwnershipField(fields) : fields,
      );
      const data = { ...(result?._data ?? {}) };
      if (scoped) {
        MetaService.assertOwnedByAccount(data.account_id, adSetId, 'Ad set', adAccountId);
        delete data.account_id;
      }
      return data;
    } catch (error) {
      return this.handleError(error, 'getAdSet');
    }
  }

  /**
   * Update ad set
   *
   * ENG-1724: see `updateCampaign` above — same global-node-id gap, write-side counterpart to
   * the read-side scoping `getAdSet` already has.
   */
  public async updateAdSet(accessToken: string, adSetId: string, params: any, adAccountId: string) {
    try {
      this.initApi(accessToken);
      const adSet = new AdSet(adSetId);
      await MetaService.verifyWriteOwnership(adSet, adSetId, 'Ad set', adAccountId);
      this.log(`Updating ad set ${adSetId} with params:`, params);
      await adSet.update([], params);
      return { success: true };
    } catch (error) {
      return this.handleError(error, 'updateAdSet');
    }
  }

  /**
   * Delete an ad set
   *
   * ENG-1724: same reasoning as `updateAdSet` above.
   */
  public async deleteAdSet(accessToken: string, adSetId: string, adAccountId: string) {
    try {
      this.initApi(accessToken);
      const adSet = new AdSet(adSetId);
      await MetaService.verifyWriteOwnership(adSet, adSetId, 'Ad set', adAccountId);
      this.log(`Deleting ad set ${adSetId}`);
      await adSet.delete([], {});
      return { success: true };
    } catch (error) {
      return this.handleError(error, 'deleteAdSet');
    }
  }

  /**
   * List ad creatives, optionally scoped to one ad set.
   *
   * Paginates and reports truncation for the same reason `listAds` does — this edge was the
   * other half of ENG-1476, where "Found 25 ad creative(s)" was the whole account's worth of
   * creatives as far as any caller could tell.
   *
   * ⚠ Meta exposes no `/{campaign_id}/adcreatives` edge, so there is no campaign scope here.
   * A campaign-scoped creative question is answered by `listAds({ campaignId })`, which already
   * returns `creative{...}` inline on each ad. The tool description says so explicitly.
   */
  public async listAdCreatives(
    adAccountId: string,
    accessToken: string,
    options: { adSetId?: string; maxPages?: number } = {}
  ): Promise<MetaAdCreativeListResult> {
    try {
      this.initApi(accessToken);
      const fields = ['id', 'name', 'status', 'body', 'title', 'image_url', 'thumbnail_url', 'object_type', 'link_url', 'object_story_spec', 'url_tags'];
      const params: Record<string, any> = { limit: META_LIST_PAGE_SIZE };

      const wantedAdSet = MetaService.resolveScopeId(options.adSetId, 'ad_set_id');

      const scope: MetaAdListScope = {};
      let source: any;
      if (wantedAdSet) {
        scope.adSetId = wantedAdSet;
        source = new AdSet(wantedAdSet);
        // Same tenancy boundary as listAds — an ad-set id is global, the token spans accounts.
        await this.assertNodeInAccount(source, wantedAdSet, 'Ad set', adAccountId);
      } else {
        source = new AdAccount(`act_${adAccountId}`);
      }

      this.log(`Listing ad creatives for account: ${adAccountId}`, { fields, scope });
      const cursor = await MetaService.withReadDeadline(
        () => source.getAdCreatives(fields, params),
        'ad creative list',
      );
      const { items, truncated, pagesFetched } = await this.drainCursor(
        cursor,
        options.maxPages ?? META_LIST_MAX_PAGES
      );

      return {
        creatives: items.map((c: any) => c._data ?? c),
        truncated,
        pagesFetched,
        scope
      };
    } catch (error) {
      // handleError always throws — see listAds.
      return this.handleError(error, 'listAdCreatives') as never;
    }
  }

  /**
   * Facebook Page IDs this account's existing ad creatives were built against,
   * sampled from the most recent page of creatives. Best-effort: returns []
   * on any failure rather than throwing, same discipline as `getPages`'
   * granular-scopes fallback — a failed sample must read as "couldn't tell",
   * never as "no existing ads".
   *
   * Lets a caller distinguish "this connection has zero accessible Pages"
   * from the subtler "it has Pages, but not the one this account's ads
   * actually run under" (ENG-2232) — a token can hold access to an unrelated
   * Page while the account's real ads keep failing.
   */
  public async getExistingAdPageIds(adAccountId: string, accessToken: string): Promise<string[]> {
    try {
      const { creatives } = await this.listAdCreatives(adAccountId, accessToken, { maxPages: 1 });
      const pageIds = new Set<string>();
      for (const creative of creatives) {
        const pageId = creative?.object_story_spec?.page_id;
        if (typeof pageId === 'string' && pageId) pageIds.add(pageId);
      }
      return [...pageIds];
    } catch (error: any) {
      console.warn(`[MetaService] getExistingAdPageIds failed for account ${adAccountId}: ${error?.message || error}`);
      return [];
    }
  }

  /**
   * Return caller-resolved creative `url_tags` verbatim.
   *
   * Customer defaults and per-lander overrides are resolved in AgentMode, where
   * both the authenticated customer and optional lander id are available. This
   * Meta boundary deliberately does not implement a second precedence system.
   */
  private static resolveUrlTags(params: MetaAdsAdCreativeParams): string | undefined {
    return params.url_tags || undefined;
  }

  /**
   * Create a new ad creative (Supports Image, Video, Carousel)
   */
  public async createAdCreative(adAccountId: string, accessToken: string, params: MetaAdsAdCreativeParams) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);

      // --- Pre-flight Validation ---

      // Media source: at least one must be provided
      const hasMedia = params.image_hash || params.image_url || params.video_id ||
        MetaService.isMultiVariantCreative(params) ||
        (params.carousel_cards && params.carousel_cards.length > 0) ||
        (params.placement_assets && params.placement_assets.length > 0);
      if (!hasMedia) {
        throw new Error('Creative requires at least one media source: image_hash, image_url, video_id, carousel_cards, or placement_assets.');
      }

      // MULTI-VARIANT CREATIVE (ENG-2915): several headlines/bodies/descriptions/media in one
      // asset_feed_spec. Checked first: its media lives in image_hashes/video_ids, not image_hash.
      if (MetaService.isMultiVariantCreative(params)) {
        const objectStorySpec: any = { page_id: params.page_id };
        if (params.instagram_user_id) objectStorySpec.instagram_user_id = params.instagram_user_id;
        const creativeParams: any = {
          [AdCreative.Fields.name]: params.name,
          [AdCreative.Fields.object_story_spec]: objectStorySpec,
          asset_feed_spec: MetaService.buildMultiVariantAssetFeedSpec(params),
        };
        const urlTags = MetaService.resolveUrlTags(params);
        if (urlTags) creativeParams.url_tags = urlTags;
        this.log(`Creating multi-variant ad creative in account: ${adAccountId}`, creativeParams);
        const creative = await account.createAdCreative([], creativeParams);
        return creative._data;
      }

      // PLACEMENT-CUSTOMIZED IMAGE CREATIVE (asset_feed_spec) — different image per placement
      // (e.g. square → Feed, 9:16 → Stories/Reels) in a single creative. Handled separately
      // because it uses asset_feed_spec rather than object_story_spec.{link_data,video_data}.
      if (params.placement_assets && params.placement_assets.length > 0) {
        MetaService.validatePlacementAssets(params.placement_assets);
        return await this.createPlacementCustomizedCreative(account, adAccountId, params);
      }

      // Carousel card count: Meta requires 2-10
      if (params.carousel_cards && params.carousel_cards.length > 0) {
        if (params.carousel_cards.length < 2) {
          throw new Error(`Carousel requires at least 2 cards (got ${params.carousel_cards.length}). Add more cards or use a single image/video creative instead.`);
        }
        if (params.carousel_cards.length > 10) {
          throw new Error(`Carousel supports a maximum of 10 cards (got ${params.carousel_cards.length}).`);
        }
      }

      let objectStorySpec: any = {
        page_id: params.page_id,
      };

      // 1. VIDEO CREATIVE
      if (params.video_id) {
        // Meta requires exactly one thumbnail field in video_data: image_hash (preferred) or image_url.
        // Missing thumbnail → error_subcode 1443226 "Your ad needs a video thumbnail".
        if (!params.image_hash && !params.image_url) {
          throw new Error(
            'Video creative requires a thumbnail. ' +
            'Provide image_hash (from AD_CREATIVE UPLOAD_IMAGE) or image_url alongside video_id.'
          );
        }
        const videoData: any = {
          video_id: params.video_id,
          message: params.body,
          title: params.title,
          call_to_action: params.call_to_action_type ? {
            type: params.call_to_action_type,
            value: { link: params.link_url }
          } : undefined
        };
        if (params.description) {
          videoData.link_description = params.description;
        }
        // Prefer image_hash (uploaded asset) over image_url
        if (params.image_hash) {
          videoData.image_hash = params.image_hash;
        } else {
          videoData.image_url = params.image_url;
        }
        objectStorySpec.video_data = videoData;
      } 
      // 2. CAROUSEL CREATIVE
      else if (params.carousel_cards && params.carousel_cards.length > 0) {
        objectStorySpec.link_data = {
          message: params.body,
          link: params.link_url, // Fallback/Main link
          caption: params.link_url,
          child_attachments: params.carousel_cards.map(card => ({
            link: card.link_url || params.link_url,
            image_hash: card.image_hash,
            picture: card.image_url,
            name: card.title,
            description: card.description,
            video_id: card.video_id,
            call_to_action: params.call_to_action_type ? { // Inherit CTA or customize per card if needed
                type: params.call_to_action_type, 
                value: { link: card.link_url || params.link_url }
            } : undefined
          })),
          call_to_action: params.call_to_action_type ? {
            type: params.call_to_action_type,
            value: { link: params.link_url }
          } : undefined
        };
      } 
      // 3. SINGLE IMAGE CREATIVE (Default)
      else {
        objectStorySpec.link_data = {
          message: params.body,
          link: params.link_url,
          caption: params.link_url, // Link data caption must be a URL string
          name: params.title,    // Large headline title
          call_to_action: params.call_to_action_type ? {
            type: params.call_to_action_type,
            value: { link: params.link_url }
          } : undefined
        };
        if (params.description) {
          objectStorySpec.link_data.description = params.description;
        }

        if (params.image_hash) {
          objectStorySpec.link_data.image_hash = params.image_hash;
        } else if (params.image_url) {
          objectStorySpec.link_data.picture = params.image_url;
        }
      }

      // Every non-placement creative type carries the Instagram identity too; without it the ad
      // runs under the Page's linked/default Instagram account instead of the one requested.
      if (params.instagram_user_id) {
        objectStorySpec.instagram_user_id = params.instagram_user_id;
      }

      const creativeParams: any = {
        [AdCreative.Fields.name]: params.name,
        [AdCreative.Fields.object_story_spec]: objectStorySpec
      };
      // Auto-generate UTM append rules when the caller supplies none (ENG-239), and
      // preserve an explicit value so a link_url swap doesn't strip them.
      const urlTags = MetaService.resolveUrlTags(params);
      if (urlTags) {
        creativeParams.url_tags = urlTags;
      }

      this.log(`Creating ad creative in account: ${adAccountId}`, creativeParams);
      const creative = await account.createAdCreative([], creativeParams);
      return creative._data;
    } catch (error) {
      return this.handleError(error, 'createAdCreative');
    }
  }

  /**
   * Build and create an AdCreative that maps different images to different placements within a
   * single creative, via Meta's asset_feed_spec + asset_customization_rules.
   *
   * Each placement_assets entry must already carry an image_hash (asset_feed_spec.images only
   * accepts hashes, not URLs — the caller resolves URLs to hashes before this point). Exactly one
   * asset is the default/fallback (is_default or no placements); the rest are scoped to placement
   * groups (feed, story, reels, …) which expand to Meta customization_spec objects.
   *
   * Shape matches Meta's Placement Asset Customization docs:
   *   object_story_spec: { page_id }
   *   asset_feed_spec: {
   *     images: [{ hash, adlabels: [{ name }] }, ...],
   *     bodies / titles / link_urls / call_to_action_types: [...],
   *     ad_formats: ['SINGLE_IMAGE'],
   *     optimization_type: 'PLACEMENT',
   *     asset_customization_rules: [
   *       { customization_spec: { publisher_platforms, *_positions }, image_label: { name } },  // scoped
   *       { customization_spec: {}, image_label: { name } },                                     // fallback
   *     ],
   *   }
   */
  private async createPlacementCustomizedCreative(
    account: InstanceType<typeof AdAccount>,
    adAccountId: string,
    params: MetaAdsAdCreativeParams
  ) {
    const assets = params.placement_assets!;

    const images: any[] = [];
    const rules: any[] = [];

    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      const hash = asset.image_hash;
      if (!hash) {
        // Defensive: the agentMode layer resolves URLs → hashes before calling us.
        throw new Error(
          `placement_assets[${i}] is missing image_hash. Upload the image via AD_CREATIVE UPLOAD_IMAGE first ` +
          `(asset_feed_spec requires image hashes, not URLs).`
        );
      }

      const label = `asset_${i}`;
      images.push({ hash, adlabels: [{ name: label }] });

      const isDefault = asset.is_default || !asset.placements || asset.placements.length === 0;
      if (isDefault) {
        // Per Meta docs, the fallback rule uses an EMPTY customization_spec ({}); it catches
        // every placement not matched by a scoped rule. (NOT { is_default: true } — that is invalid.)
        rules.push({
          customization_spec: {},
          image_label: { name: label },
        });
        continue;
      }

      const customizationSpec = asset.customization_spec || MetaService.buildCustomizationSpec(asset.placements!);
      if (!customizationSpec) {
        throw new Error(`placement_assets[${i}] resolved to an empty customization_spec.`);
      }
      rules.push({
        customization_spec: customizationSpec,
        image_label: { name: label },
      });
    }

    const assetFeedSpec: any = {
      images,
      bodies: [{ text: params.body }],
      titles: [{ text: params.title }],
      link_urls: [{ website_url: params.link_url }],
      ad_formats: ['SINGLE_IMAGE'],
      optimization_type: 'PLACEMENT',
      asset_customization_rules: rules,
    };
    if (params.call_to_action_type) {
      assetFeedSpec.call_to_action_types = [params.call_to_action_type];
    }
    if (params.description) {
      assetFeedSpec.descriptions = [{ text: params.description }];
    }

    // For asset_feed_spec creatives, all copy/link/format live in asset_feed_spec; object_story_spec
    // carries only the Page (and instagram_user_id). The IG actor is REQUIRED when the rules target
    // Instagram placements (story/reels) — Meta rejects the ad with error_subcode 1772103
    // "Instagram Account Is Missing" otherwise.
    const objectStorySpec: any = {
      page_id: params.page_id,
    };
    if (params.instagram_user_id) {
      objectStorySpec.instagram_user_id = params.instagram_user_id;
    }

    const creativeParams: any = {
      [AdCreative.Fields.name]: params.name,
      [AdCreative.Fields.object_story_spec]: objectStorySpec,
      asset_feed_spec: assetFeedSpec,
    };
    // Auto-generate UTM append rules when the caller supplies none (ENG-239), and
    // preserve an explicit value so a link_url swap doesn't strip them.
    const urlTags = MetaService.resolveUrlTags(params);
    if (urlTags) {
      creativeParams.url_tags = urlTags;
    }

    this.log(`Creating placement-customized ad creative in account: ${adAccountId}`, creativeParams);
    const creative = await account.createAdCreative([], creativeParams);
    return creative._data;
  }

  /**
   * Drain a Meta SDK `Cursor` into a single array.
   *
   * The SDK's Cursor extends Array but only ever holds ONE PAGE: `next()` REPLACES its
   * contents rather than appending (see the SDK's `cursor.js` -> `_loadPage` -> `this.set()`).
   * So `const xs = await account.getAds(...); xs.map(...)` reads page 1 — Meta's default 25
   * records — and nothing else. That is ENG-1476 / ENG-1584: 25 records reported as an
   * entire ad account, which told a customer an ad they were protecting did not exist.
   *
   * `maxPages` is a real bound, not a formality. An unbounded walk of a large account is a
   * latency risk AND produces a payload big enough to be offloaded to S3 — and the offloaded
   * read path is itself where ENG-1584's false negative surfaced. So when we stop early we
   * report `truncated: true` and the caller must say so. We never return a short list that
   * looks complete: that is the entire defect being fixed here.
   */
  /**
   * Bound the wait on a single Graph read.
   *
   * ⚠ Honest about what this does: it bounds how long WE wait, not how long the socket stays
   * open. Without an SDK hook for `AbortSignal` (there is none — see META_READ_CALL_TIMEOUT_MS)
   * the underlying request is abandoned rather than cancelled, and the connection closes on its
   * own. For a read that is safe: no side effect is left half-applied, and the caller gets an
   * answer instead of hanging. That distinction is exactly why this is not applied to writes.
   */
  private static async withReadDeadline<T>(
    op: () => Promise<T>,
    what: string,
    budgetMs: number = META_READ_CALL_TIMEOUT_MS,
  ): Promise<T> {
    // Never longer than the per-call ceiling, and never long enough to outlive a caller's own
    // remaining budget. At least 1ms so a deadline is always a real one.
    const limitMs = Math.max(1, Math.min(budgetMs, META_READ_CALL_TIMEOUT_MS));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inFlight = op();

    /*
     * ⚠ Claim the rejection NOW, before racing.
     *
     * When the deadline wins, `inFlight` is still pending. If it rejects later nothing is
     * listening, so it surfaces as an unhandledRejection — and the global handler in server.ts
     * logs `reason` in full. A Meta FacebookRequestError carries the request URL, and a PAGED
     * Graph URL carries the access token in its query string. So an un-awaited late failure
     * would print a live credential into the logs.
     *
     * `.catch()` here marks it handled without consuming it: `inFlight` still settles normally
     * for the race below.
     */
    inFlight.catch(() => { /* superseded by the deadline; swallowed on purpose */ });

    try {
      return await Promise.race([
        inFlight,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Meta ${what} did not respond within ${limitMs}ms`)),
            limitMs,
          );
          // Never hold the event loop open just for this timer.
          (timer as any)?.unref?.();
        }),
      ]);
    } finally {
      // Always clear it — a pending timer per page would otherwise pile up across a long walk.
      if (timer) clearTimeout(timer);
    }
  }

  private async drainCursor(
    cursor: any,
    maxPages: number,
    /** Wall-clock budget for this walk. Defaults to the ordinary read ceiling. */
    maxMs: number = META_LIST_MAX_MS,
  ): Promise<{ items: any[]; truncated: boolean; pagesFetched: number }> {
    /*
     * Normalise the bound before it is used as one. `maxPages` arrives from a caller-supplied
     * option, and `?? META_LIST_MAX_PAGES` only covers `undefined` — `Infinity` and `NaN` both
     * make `pagesFetched >= maxPages` permanently false, which turns the "hard bound" documented
     * on META_LIST_MAX_PAGES into an unbounded walk that accumulates every page in memory.
     * Anything not a positive safe integer falls back to the default, and valid values are
     * clamped, so the ceiling is real rather than merely described.
     */
    const pageLimit = Number.isSafeInteger(maxPages) && maxPages > 0
      ? Math.min(maxPages, META_LIST_MAX_PAGES)
      : META_LIST_MAX_PAGES;

    // `getAds`/`getAdCreatives` already fetched page 1 (getEdge defaults fetchFirstPage=true).
    const items: any[] = Array.isArray(cursor) ? [...cursor] : [];
    let pagesFetched = 1;

    // A plain array (tests, or any non-cursor) carries no paging: one page, nothing more.
    const canPage = typeof cursor?.hasNext === 'function' && typeof cursor?.next === 'function';
    if (!canPage) return { items, truncated: false, pagesFetched };

    // Same normalisation discipline as `pageLimit` above: a caller-supplied budget that is not a
    // positive safe integer must not quietly become an unbounded walk.
    const budgetMs = Number.isSafeInteger(maxMs) && maxMs > 0 ? maxMs : META_LIST_MAX_MS;
    const deadline = Date.now() + budgetMs;

    while (cursor.hasNext()) {
      if (Date.now() >= deadline) {
        this.log(`Stopped paginating at the ${budgetMs}ms wall-clock bound`, {
          pagesFetched,
          itemsSoFar: items.length,
        });
        return { items, truncated: true, pagesFetched };
      }
      if (pagesFetched >= pageLimit) {
        this.log(`Stopped paginating at the ${pageLimit}-page bound`, { pagesFetched, itemsSoFar: items.length });
        return { items, truncated: true, pagesFetched };
      }
      try {
        /*
         * Give the page only the budget the WALK still has.
         *
         * The wall-clock check above gates whether a new page STARTS; on its own that let a page
         * beginning at 44s of a 45s budget run for a further META_READ_CALL_TIMEOUT_MS, overshooting
         * the overall deadline by nearly the whole per-call ceiling. Clamping to whatever remains
         * makes META_LIST_MAX_MS an actual bound on the walk rather than a bound on its start times.
         */
        await MetaService.withReadDeadline(
          () => cursor.next(),
          'page fetch',
          deadline - Date.now(),
        );
      } catch (e: any) {
        /*
         * A page-N failure must not throw away pages 1..N-1. Adding pagination added this
         * failure mode — before, there was no second request to fail — and discarding good
         * data over a transient blip would be a regression introduced by the fix.
         *
         * Returning the partial set is safe precisely BECAUSE `truncated` exists: it carries
         * the "this list is incomplete, do not conclude absence" contract that the rest of
         * this change is built on. What would be unsafe is returning it as complete.
         *
         * Deliberately not logging the error object: the SDK attaches the request URL to
         * FacebookRequestError, and a paged URL carries the access token in its query string.
         */
        this.log(`Pagination stopped early after a page error; returning a partial list`, {
          pagesFetched,
          itemsSoFar: items.length,
          reason: typeof e?.message === 'string' ? e.message.slice(0, 200) : 'unknown',
        });
        return { items, truncated: true, pagesFetched };
      }
      items.push(...cursor);
      pagesFetched++;
    }

    return { items, truncated: false, pagesFetched };
  }

  /** Add `account_id` to a field selection so a single-entity read can verify its own ownership. */
  private static withOwnershipField(fields: string[]): string[] {
    return fields.includes('account_id') ? fields : [...fields, 'account_id'];
  }

  /**
   * Fetch a node's own `account_id` and verify it against `adAccountId` via `assertOwnedByAccount`
   * — the shared pre-write ownership check for `updateCampaign`/`deleteCampaign`/`updateAdSet`/
   * `deleteAdSet`/`updateAd`/`deleteAd` (ENG-1724).
   *
   * The Graph `.get()` call here has its OWN try/catch, deliberately separate from each write
   * method's outer one. Without it, a Graph failure DURING this ownership check (a transient
   * 5xx, a malformed response — anything short of an actual ownership mismatch) fell through to
   * the write's generic `catch (error) { return this.handleError(error, ...); }`, and
   * `handleError` copies `error.response?.data`/`error_user_msg`/etc. into the thrown error
   * largely unsanitized — correct for a failed WRITE (the caller needs Meta's real reason), but
   * this failure never reached the write at all. `assertOwnedByAccount`'s own refusal is
   * provably marker-only (see its doc comment); this closes the one path beside it that could
   * still carry raw Graph content — a Graph error message can embed account/business/page names,
   * which is exactly what the ownership check exists to keep from leaking. `refuse()` below
   * throws a fixed, generic message instead, same anti-oracle bar as the check it guards.
   */
  private static async verifyWriteOwnership(
    node: { get: (fields: string[]) => Promise<any> },
    nodeId: string,
    nodeLabel: string,
    adAccountId: string,
  ): Promise<void> {
    let ownerData: Record<string, any>;
    try {
      const owner = await node.get(MetaService.withOwnershipField([]));
      ownerData = { ...((owner as any)?._data ?? {}) };
    } catch (error) {
      console.error(`[MetaService] ownership check failed for ${nodeLabel} ${nodeId}:`, error);
      throw new Error(
        `Could not verify ownership of the requested ${nodeLabel.toLowerCase()} before this write. Retry; if it persists, verify the object in Meta Ads Manager.`,
      );
    }
    MetaService.assertOwnedByAccount(ownerData.account_id, nodeId, nodeLabel, adAccountId);
  }

  /**
   * Resolve a scope id that was SUPPLIED versus one that was omitted.
   *
   * `if (adSetId)` treats an explicitly-supplied empty string as absent, so a caller asking to
   * scope a read silently gets a broader one — a campaign-wide or account-wide list returned
   * for a request that named an ad set. That is the exact defect this change exists to remove,
   * so an empty scope id is refused rather than quietly widened.
   *
   * `undefined`/`null` means "not supplied" and legitimately selects the broader source.
   */
  private static resolveScopeId(value: unknown, label: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    const trimmed = String(value).trim();
    if (!trimmed) {
      throw new Error(
        `${label} was supplied but empty. Refusing to widen this read to a broader scope — ` +
        `omit ${label} entirely to list without it.`,
      );
    }
    return trimmed;
  }

  /**
   * Bind a campaign / ad-set node to the SELECTED ad account before reading through it.
   *
   * ⚠ This is a tenancy boundary, not a nicety. Listing through `new AdAccount('act_X')` was
   * implicitly account-scoped: Meta could only ever hand back X's ads. Reading through
   * `new Campaign(id)` / `new AdSet(id)` is NOT — a node id addresses a node globally, and one
   * Meta OAuth token routinely reaches several ad accounts. Without this check a caller could
   * select account A, pass a campaign id from account B, and receive B's ads labelled as A's.
   *
   * `getMetaCredentials` validates the selected account and returns its token; it says nothing
   * about the node. The token being valid is not the same as the node being in scope. This
   * mirrors the guard `AD_CREATIVE GET` already applies for exactly this reason (ENG-471).
   *
   * Fails closed on every uncertain branch: an unverifiable owner is refused, not returned.
   */
  private async assertNodeInAccount(
    node: any,
    nodeId: string,
    nodeLabel: string,
    adAccountId: string
  ): Promise<void> {
    /*
     * Separate "this node belongs to someone else" from "Meta could not be reached to answer".
     * Only the first is a tenancy violation. Failing the second identically would break a
     * legitimate read over a transient blip while protecting nobody, so the lookup is retried
     * once — the same reasoning the S3 offload path already applies.
     *
     * This costs nothing in strictness: a genuine mismatch refuses on both attempts, and an
     * unreachable lookup still ends in a refusal rather than an unverified read.
     */
    let data: any;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2 && data === undefined; attempt++) {
      try {
        const node_ = await MetaService.withReadDeadline<any>(
          () => node.get(['account_id']),
          `${nodeLabel.toLowerCase()} ownership lookup`,
        );
        data = node_?._data ?? {};
      } catch (e) {
        lastError = e;
      }
    }
    if (data === undefined) {
      // Distinguishable in logs, deliberately not to the caller — see the refusal note below.
      console.warn(
        `[MetaService] scope ownership unverifiable for ${nodeLabel} ${nodeId}: ` +
        `${(lastError as any)?.message ?? 'unknown error'}`,
      );
      throw new Error(
        `Could not verify the requested ${nodeLabel.toLowerCase()} against the selected ad account; ` +
        `please retry.`,
      );
    }

    MetaService.assertOwnedByAccount(data.account_id, nodeId, nodeLabel, adAccountId);
  }

  /**
   * Compare an ALREADY-READ `account_id` against the selected ad account and refuse a mismatch.
   *
   * Split out of `assertNodeInAccount` so a caller about to read the node anyway can request
   * `account_id` in the SAME call and check it here — one round trip instead of two. That
   * matters on the single-entity paths: a separate probe would double the Graph calls on a
   * routine read-back path AND add a failure mode of its own, refusing a read that would
   * otherwise have succeeded because the probe blipped. Edge-scoped callers still need
   * `assertNodeInAccount`, having no payload response to fold the field into.
   */
  /**
   * Public so the one guard that predates it (`AD_CREATIVE GET` in agentModeService) can share
   * this exact refusal instead of hand-rolling a near-copy that names the owning account.
   */
  public static assertOwnedByAccount(
    ownerAccountId: unknown,
    nodeId: string,
    nodeLabel: string,
    adAccountId: string,
  ): void {
    const norm = (id: unknown) => String(id ?? '').replace(/^act_/, '').trim();
    const owner = norm(ownerAccountId);
    const selected = norm(adAccountId);

    /*
     * ⚠ The refusal must not describe the OTHER tenant.
     *
     * Naming the owning account turns this guard into an oracle: anyone able to guess a node id
     * could learn which ad account owns it, which is cross-account disclosure of exactly the
     * kind the guard exists to prevent — a block that answers the question it is refusing.
     *
     * So the caller (and the model, and ultimately the user) gets the SAME marker sentence on
     * every failed branch, and the owning account never appears in any of them — the log keeps
     * that. What may differ after the marker is the remedy, because "select the other account"
     * is right for a mismatch and impossible when Meta reported no owner at all; see `refuse`.
     */
    /*
     * One marker sentence for every branch, but the REMEDY may differ.
     *
     * The marker is what `isMetaAccountScopeRefusal` keys on, so it must not vary — a caller
     * that stops recognising a refusal degrades past a guard it was told to respect, and for a
     * write that means proceeding to confirmation on a node the guard refused. What may vary is
     * the sentence after it, and it should: "select that account and try again" is the right
     * remedy when the node lives in a DIFFERENT account, and no remedy at all when Meta simply
     * did not tell us who owns it. Naming an action the user cannot take is the ENG-1636 shape.
     *
     * Neither variant discloses the owning account — that is the oracle this guard exists to
     * refuse, and the discriminating detail stays in the server log.
     */
    const OTHER_ACCOUNT_REMEDY = 'If it belongs to a different ad account, select that account and try again.';
    const refuse = (serverDetail: string, remedy: string = OTHER_ACCOUNT_REMEDY): never => {
      console.warn(`[MetaService] scope ownership refused: ${serverDetail}`);
      throw new Error(
        `The requested ${nodeLabel.toLowerCase()} ${META_ACCOUNT_SCOPE_REFUSAL_MARKER}. ${remedy}`,
      );
    };

    if (!owner) {
      // Fails closed on purpose: the field was requested, so its absence means the assumption
      // behind this check no longer holds — not that the node is in scope.
      refuse(
        `no account_id on ${nodeLabel} ${nodeId}`,
        `Meta did not report which ad account owns it, so ownership could not be CONFIRMED — ` +
        `this is a failed check, not a proven mismatch. Retry; if it persists, verify the object ` +
        `in Meta Ads Manager and that the intended ad account is selected.`,
      );
    }
    // Both sides must be known. An empty selected account cannot be compared against anything,
    // so treating it as "no mismatch" would pass every node the token can reach.
    if (!selected) {
      /*
       * OUR failure, not the user's, and it must not read like theirs.
       *
       * This fires when no ad account could be resolved for the request — a credential or
       * wiring problem on our side. The shared remedy ("it belongs to a different ad account,
       * select that one") accuses the user of pointing at someone else's node, which is a
       * confusing, unactionable thing to read about your own campaign. It is the same mistake
       * that shipped as "in ad account (undefined)" earlier in this work.
       */
      refuse(
        `no selected account resolved for ${nodeLabel} ${nodeId}`,
        `No ad account could be determined for this request, so ownership could not be checked. ` +
        `This is a connection problem, not a permissions one — reconnect Meta in Settings, or ` +
        `name the ad account explicitly, then try again.`,
      );
    }
    if (owner !== selected) {
      refuse(`${nodeLabel} ${nodeId} owned by ${owner}, selected ${selected}`);
    }
  }

  /**
   * List ads, optionally scoped to one campaign or one ad set.
   *
   * ⚠ Scoping goes through Meta's own node edges (`/{campaign_id}/ads`, `/{adset_id}/ads`),
   * NOT through `params.adset_id` / `params.campaign_id`. Meta **silently ignores** those as
   * bare params on the `/act_X/ads` edge and hands back the whole account — the filter looks
   * applied and is not (ENG-1476). Querying the node instead makes the scope structurally
   * impossible to ignore: a bad id is an error, never a silent account-wide result.
   *
   * Returns a result object rather than a bare array so truncation cannot be dropped on the
   * floor by a caller that just maps over it.
   */
  public async listAds(
    adAccountId: string,
    accessToken: string,
    adSetId?: string,
    options: { campaignId?: string; maxPages?: number } = {}
  ): Promise<MetaAdListResult> {
    try {
      this.initApi(accessToken);
      const fields = [
        'id', 'name', 'status', 'effective_status', 'adset_id', 'campaign_id',
        'creative{id,name,body,title,image_url,thumbnail_url,object_story_spec}'
      ];
      // Include all non-deleted effective statuses so ads paused at the campaign/adset
      // level (effective_status=CAMPAIGN_PAUSED or ADSET_PAUSED) are not silently omitted.
      const params: Record<string, any> = {
        effective_status: [
          'ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED',
          'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED',
          'PENDING_BILLING_INFO', 'IN_PROCESS', 'WITH_ISSUES'
        ],
        // Bigger pages mean fewer round trips for the same data, not more data.
        limit: META_LIST_PAGE_SIZE
      };

      // Most-specific scope wins: an ad set lives inside a campaign, so asking for both and
      // honouring the ad set is the narrower, more useful read.
      const wantedAdSet = MetaService.resolveScopeId(adSetId, 'ad_set_id');
      const wantedCampaign = MetaService.resolveScopeId(options.campaignId, 'campaign_id');

      const scope: MetaAdListScope = {};
      let source: any;
      if (wantedAdSet) {
        scope.adSetId = wantedAdSet;
        source = new AdSet(wantedAdSet);
        // Node reads are not account-scoped by construction the way the account edge is.
        await this.assertNodeInAccount(source, wantedAdSet, 'Ad set', adAccountId);
      } else if (wantedCampaign) {
        scope.campaignId = wantedCampaign;
        source = new Campaign(wantedCampaign);
        await this.assertNodeInAccount(source, wantedCampaign, 'Campaign', adAccountId);
      } else {
        source = new AdAccount(`act_${adAccountId}`);
      }

      this.log(`Listing ads for account: ${adAccountId}`, { fields, scope, ...params });
      const cursor = await MetaService.withReadDeadline(() => source.getAds(fields, params), 'ad list');
      const { items, truncated, pagesFetched } = await this.drainCursor(
        cursor,
        options.maxPages ?? META_LIST_MAX_PAGES
      );

      const ads = items
        .map((a: any) => a._data ?? a)
        // Net for a status filter Meta may have ignored on a node edge — see NON_LIVE_AD_STATUSES.
        .filter((a: any) => !NON_LIVE_AD_STATUSES.has(String(a?.effective_status ?? '').toUpperCase()));

      return { ads, truncated, pagesFetched, scope };
    } catch (error) {
      // handleError always throws — a failed read must never look like "no ads",
      // which a caller would report as an empty-but-complete account.
      return this.handleError(error, 'listAds') as never;
    }
  }

  /**
   * Every destination URL on a creative (ENG-239 AC3, read side).
   *
   * This is the exact mirror of `createAdCreative` / `createPlacementCustomizedCreative`'s
   * write sites, plus `creative.link_url` (which Meta populates and Ads Manager writes
   * directly). Read/write symmetry is the correctness bar: a location we fail to read is
   * a healthy ad reported as "untagged", and acting on that means swapping a live creative
   * and resetting its learning phase.
   *
   *   creative.link_url                                             (top-level / Ads Manager)
   *   object_story_spec.link_data.link                              (single image; carousel fallback :1044)
   *   object_story_spec.link_data.call_to_action.value.link         (:1058, :1071)
   *   object_story_spec.link_data.child_attachments[].link          (carousel cards :1047)
   *   object_story_spec.link_data.child_attachments[].call_to_action.value.link  (per-card CTA :1055)
   *   object_story_spec.video_data.call_to_action.value.link        (:1029)
   *   asset_feed_spec.link_urls[].website_url                       (placement-customized :1174)
   *
   * Deliberately NOT read: `link_data.caption`. The writer sets it to the link URL, but it is
   * a DISPLAY field — Ads Manager routinely holds a bare domain ("example.com") there, which
   * `readUtmKeys` cannot parse, and one unparseable URL marks the whole ad unreadable. It is
   * never a click destination, so reading it would only manufacture noise.
   *
   * Returns [] when nothing is extractable. The audit classes that `unreadable` and surfaces
   * it for a human — we never invent a placeholder URL.
   */
  static extractCreativeDestinationUrls(creative: any): string[] {
    // Graph subfields arrive as plain objects, but tolerate an SDK node wrapper.
    const c = creative?._data ?? creative;
    if (!c || typeof c !== 'object') return [];

    const urls: string[] = [];
    const push = (u: unknown) => {
      if (typeof u === 'string' && u.trim()) urls.push(u.trim());
    };

    push(c.link_url);

    const oss = c.object_story_spec ?? {};

    const linkData = oss.link_data ?? {};
    push(linkData.link);
    push(linkData.call_to_action?.value?.link);
    for (const card of Array.isArray(linkData.child_attachments) ? linkData.child_attachments : []) {
      push(card?.link);
      push(card?.call_to_action?.value?.link);
    }

    push(oss.video_data?.call_to_action?.value?.link);

    const linkUrls = c.asset_feed_spec?.link_urls;
    for (const entry of Array.isArray(linkUrls) ? linkUrls : []) {
      push(entry?.website_url);
    }

    return [...new Set(urls)];
  }

  /**
   * Read every ad's destination URLs and creative-level `url_tags` for the UTM audit
   * (ENG-239 AC3). STRICTLY READ-ONLY.
   *
   * Mirrors `listAds`: same SDK edge, same `effective_status` filter, so an ad paused at
   * campaign/adset level is audited rather than silently omitted (an omitted ad reads as a
   * vacuously-tagged campaign — a false negative that hides missing attribution).
   *
   * `campaignId` scopes the read to one campaign via Meta's `filtering` param; the caller
   * ALSO filters client-side, so a filter the API ignores can never attribute another
   * campaign's ads to this one.
   *
   * ⚠ ENG-1625 follow-up: paginates and reports truncation for the same ENG-1584 reason
   * `listAds` does — the old code returned exactly one page, and a silently short audit is
   * an attribution-correctness problem (it feeds the ENG-926/ENG-885 foundation), not just a
   * UI annoyance. Scoping is left as `filtering` here, unchanged — unlike a bare `campaign_id`
   * param, Meta's `filtering` operator is a documented, general-purpose Graph API mechanism,
   * not the same unsupported-param shape ENG-1476 found on this edge.
   */
  public async listAdsForUtmAudit(
    adAccountId: string,
    accessToken: string,
    campaignId?: string,
    options: { maxPages?: number; maxMs?: number } = {},
  ): Promise<{
    items: Array<{ adId: string; campaignId: string; destinationUrls: string[]; urlTags?: string }>;
    truncated: boolean;
    pagesFetched: number;
  }> {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      const fields = [
        'id',
        'campaign_id',
        'creative{id,link_url,url_tags,object_story_spec,asset_feed_spec}',
      ];
      const params: Record<string, any> = {
        effective_status: [
          'ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED',
          'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED',
          'PENDING_BILLING_INFO', 'IN_PROCESS', 'WITH_ISSUES'
        ],
        limit: META_LIST_PAGE_SIZE,
      };
      if (campaignId) {
        params.filtering = [{ field: 'campaign.id', operator: 'IN', value: [campaignId] }];
      }
      this.log(`Listing ads for UTM audit in account: ${adAccountId}`, { fields, campaignId });
      /*
       * The FIRST page must honour the caller's budget too.
       *
       * `drainCursor` applies `maxMs` to the pages it walks, but this initial fetch went through
       * the fixed per-call ceiling — so a caller arriving with its budget already spent still
       * paid for one full read. The launch gate's `Math.max(1_000, …)` floor made that concrete:
       * an exhausted wall still bought a 30s page. Capped to whatever the caller actually has.
       */
      const cursor = await MetaService.withReadDeadline(
        async () => account.getAds(fields, params),
        'UTM audit ad list',
        options.maxMs,
      );
      const { items: pages, truncated, pagesFetched } = await this.drainCursor(
        cursor,
        options.maxPages ?? META_LIST_MAX_PAGES,
        options.maxMs,
      );
      const items = pages.map((a: any) => {
        const data = a._data ?? a;
        const creative = data.creative;
        const urlTags = (creative?._data ?? creative)?.url_tags;
        return {
          adId: String(data.id),
          campaignId: data.campaign_id != null ? String(data.campaign_id) : '',
          destinationUrls: MetaService.extractCreativeDestinationUrls(creative),
          urlTags: typeof urlTags === 'string' && urlTags.trim() ? urlTags : undefined,
        };
      });
      return { items, truncated, pagesFetched };
    } catch (error) {
      // handleError always throws — a failed read must never look like "no ads"
      // (which the audit would report as a vacuously tagged, healthy account).
      return this.handleError(error, 'listAdsForUtmAudit') as never;
    }
  }

  /**
   * Create a new ad
   */
  public async createAd(adAccountId: string, accessToken: string, params: MetaAdsAdParams) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      const adParams = {
        [Ad.Fields.name]: params.name,
        [Ad.Fields.adset_id]: params.adset_id,
        [Ad.Fields.creative]: { creative_id: params.creative_id },
        [Ad.Fields.status]: params.status || Ad.Status.paused,
      };
      this.log(`Creating ad in account: ${adAccountId}`, adParams);
      const ad = await account.createAd([], adParams);
      return ad._data;
    } catch (error) {
      return this.handleError(error, 'createAd');
    }
  }

  /**
   * Get a single ad with its creative reference
   */
  public async getAd(
    accessToken: string,
    adId: string,
    /** When supplied, the node is verified to belong to this ad account before anything is
     *  returned. Optional so existing read-back callers are unchanged; the callers whose result
     *  reaches a user-facing prompt pass it. Same treatment getAdSet received. */
    adAccountId?: string,
  ) {
    try {
      this.initApi(accessToken);
      const ad = new Ad(adId);
      const fields = [
        'id', 'name', 'status', 'effective_status', 'adset_id', 'campaign_id',
        // ad_review_feedback + the creative's own status surface Meta's async policy/technical
        // review verdict, so a post-swap read-back can report PENDING/rejected creatives.
        'ad_review_feedback',
        'creative{id,name,body,title,image_url,thumbnail_url,object_story_spec,status}'
      ];
      this.log(`Fetching ad: ${adId}`);
      /*
       * An ad id is a GLOBAL node id, so this returns any ad the token can reach — and one Meta
       * OAuth token routinely spans several ad accounts. buildMetaWriteConfirmation renders this
       * result's NAME into the prompt the user approves, so an ad_id from another ad account
       * disclosed that account's ad name to this user. getCampaign and getAdSet were both given
       * this check; getAd, the resolver sitting between them, was not.
       */
      // Fails closed on a supplied-but-empty account id, exactly as getAdSet and getCampaign do:
      // "" is a scope that failed to resolve, not a caller opting out of scoping.
      const scoped = adAccountId !== undefined && adAccountId !== null;
      const result = await ad.get(
        scoped ? MetaService.withOwnershipField(fields) : fields,
      );
      const data = { ...(result?._data ?? {}) };
      if (scoped) {
        MetaService.assertOwnedByAccount(data.account_id, adId, 'Ad', adAccountId);
        delete data.account_id;
      }
      return data;
    } catch (error) {
      return this.handleError(error, 'getAd');
    }
  }

  /**
   * Resolve an ad's parent campaign without crossing the selected ad-account boundary.
   * Only the three ownership fields are requested, and the existing read deadline keeps
   * a stalled Graph request on the launch gate's fail-closed path.
   */
  public async getAdCampaignIdForAccount(accessToken: string, adAccountId: string, adId: string): Promise<string | undefined> {
    try {
      this.initApi(accessToken);
      return MetaService.ownedParentCampaignId(
        await MetaService.withReadDeadline(
          () => new Ad(adId).get(['id', 'campaign_id', 'account_id']),
          'ad parent campaign',
        ),
        adAccountId,
      );
    } catch (error) {
      return this.handleError(error, 'getAdCampaignIdForAccount') as never;
    }
  }

  /** Same contract as getAdCampaignIdForAccount, for an ad set's parent campaign. */
  public async getAdSetCampaignIdForAccount(accessToken: string, adAccountId: string, adSetId: string): Promise<string | undefined> {
    try {
      this.initApi(accessToken);
      return MetaService.ownedParentCampaignId(
        await MetaService.withReadDeadline(
          () => new AdSet(adSetId).get(['id', 'campaign_id', 'account_id']),
          'ad set parent campaign',
        ),
        adAccountId,
      );
    } catch (error) {
      return this.handleError(error, 'getAdSetCampaignIdForAccount') as never;
    }
  }

  /** The node's campaign_id, only when the node belongs to the selected ad account. */
  private static ownedParentCampaignId(result: unknown, adAccountId: string): string | undefined {
    const data: any = (result as any)?._data ?? result;
    const selectedAccountId = String(adAccountId).trim().replace(/^act_/, '');
    const ownerAccountId = String(data?.account_id ?? '').trim().replace(/^act_/, '');
    if (!selectedAccountId || !ownerAccountId || ownerAccountId !== selectedAccountId) return undefined;
    return typeof data?.campaign_id === 'string' && data.campaign_id ? data.campaign_id : undefined;
  }

  /**
   * Get a single ad creative with full details including object_story_spec
   */
  public async getAdCreative(accessToken: string, creativeId: string) {
    try {
      this.initApi(accessToken);
      const creative = new AdCreative(creativeId);
      // object_story_spec must be expanded with explicit subfields — the Graph API only returns
      // image_hash when it is named directly; requesting the bare "object_story_spec" field
      // silently drops image_hash and returns only the hosted "picture" URL. Copy/reuse flows
      // (COPY_AD) that read the hash back to attach it to a new creative would otherwise always
      // fall back to re-uploading that low-res preview URL, which Meta's AdCreative create
      // endpoint rejects (error code 100, subcode 1487390).
      const objectStorySpecField =
        'object_story_spec{page_id,instagram_user_id,' +
        'link_data{link,message,caption,name,description,image_hash,picture,call_to_action,' +
        'child_attachments{link,image_hash,picture,name,description,video_id,call_to_action}},' +
        'video_data{video_id,image_hash,image_url,title,message,link_description,call_to_action}}';
      const fields = [
        // account_id is requested so callers can bind the returned node to the ad
        // account they intended to read (ENG-471). A Meta OAuth token can span
        // several ad accounts, so a creative id alone does not identify a tenant.
        // Additive for existing callers, which simply ignore the extra field.
        'id', 'account_id', 'name', 'body', 'title', 'image_url', 'thumbnail_url',
        'object_type', 'link_url', objectStorySpecField, 'asset_feed_spec', 'url_tags'
      ];
      this.log(`Fetching ad creative: ${creativeId}`);
      const result = await MetaService.withReadDeadline<any>(() => creative.get(fields), 'ad creative');
      return result._data;
    } catch (error) {
      return this.handleError(error, 'getAdCreative');
    }
  }

  /** Render one existing ad or creative in a Meta placement. */
  public async generateAdPreview(accessToken: string, nodeId: string, adFormat: string) {
    const apiVersion = process.env.META_API_VERSION || 'v25.0';
    try {
      const response = await axios.get(
        `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(nodeId)}/previews`,
        {
          params: { ad_format: adFormat, access_token: accessToken },
          timeout: META_READ_CALL_TIMEOUT_MS,
          maxContentLength: 1_000_000,
        },
      );
      const rows = response?.data?.data;
      if (
        !Array.isArray(rows)
        || rows.length === 0
        || rows.some((row: any) => !row || typeof row.body !== 'string' || row.body.trim().length === 0)
      ) {
        throw new Error('Meta returned an invalid ad preview response.');
      }
      return rows.map((row: any) => ({ body: row.body }));
    } catch (error) {
      const responseData = (error as any)?.response?.data;
      const safeError = new Error((error as any)?.message || 'Meta ad preview request failed.');
      if (responseData) {
        (safeError as any).response = { data: responseData };
      }
      return this.handleError(safeError, 'generateAdPreview');
    }
  }

  /**
   * Update ad
   *
   * ENG-1724: see `updateCampaign` above — same global-node-id gap, write-side counterpart to
   * the read-side scoping `getAd` already has.
   */
  public async updateAd(accessToken: string, adId: string, params: any, adAccountId: string) {
    try {
      this.initApi(accessToken);
      const ad = new Ad(adId);
      await MetaService.verifyWriteOwnership(ad, adId, 'Ad', adAccountId);
      this.log(`Updating ad ${adId} with params:`, params);
      await ad.update([], params);
      return { success: true };
    } catch (error) {
      return this.handleError(error, 'updateAd');
    }
  }

  /**
   * Delete an ad
   *
   * ENG-1724: same reasoning as `updateAd` above.
   */
  public async deleteAd(accessToken: string, adId: string, adAccountId: string) {
    try {
      this.initApi(accessToken);
      const ad = new Ad(adId);
      await MetaService.verifyWriteOwnership(ad, adId, 'Ad', adAccountId);
      this.log(`Deleting ad ${adId}`);
      await ad.delete([], {});
      return { success: true };
    } catch (error) {
      return this.handleError(error, 'deleteAd');
    }
  }

  // Meta's image-ad upload rejects oversized assets with a generic "Invalid parameter".
  // Downscale the longest side to this many pixels (Meta's recommended ad image max) and
  // keep the encoded file under the byte cap before uploading.
  private static readonly META_MAX_IMAGE_DIMENSION = 1936;
  private static readonly META_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

  /**
   * Downscale/re-encode an image so it fits within Meta's ad-image dimension and size
   * limits. Oversized images (e.g. 4096x4096 renders) are otherwise rejected by the
   * Marketing API with an unhelpful generic "Invalid parameter" error.
   *
   * Behaviour:
   * - If the image is already within both limits, the original buffer/filename is returned.
   * - Otherwise the longest side is fit inside META_MAX_IMAGE_DIMENSION (aspect ratio
   *   preserved, never enlarged). PNGs stay PNG (preserving transparency for logo creatives);
   *   only if a re-encoded PNG is still over the byte cap do we fall back to JPEG.
   * - If sharp is unavailable or fails, the original buffer is used so upload still attempts.
   */
  public async resizeImageForMeta(
    fileBuffer: Buffer,
    filename: string
  ): Promise<{ buffer: Buffer; filename: string; resized: boolean }> {
    const MAX_DIM = MetaService.META_MAX_IMAGE_DIMENSION;
    const MAX_BYTES = MetaService.META_MAX_IMAGE_BYTES;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sharp = require('sharp');
      const metadata = await sharp(fileBuffer).metadata();
      const width = metadata.width || 0;
      const height = metadata.height || 0;
      const longestSide = Math.max(width, height);
      const tooLarge = longestSide > MAX_DIM;
      const tooHeavy = fileBuffer.length > MAX_BYTES;

      if (!tooLarge && !tooHeavy) {
        return { buffer: fileBuffer, filename, resized: false };
      }

      const resizeOpts = { width: MAX_DIM, height: MAX_DIM, fit: 'inside' as const, withoutEnlargement: true };
      const isPng = metadata.format === 'png';

      let out: Buffer;
      let outFilename = filename;
      if (isPng) {
        out = await sharp(fileBuffer).resize(resizeOpts).png({ compressionLevel: 9 }).toBuffer();
        // Transparency-preserving PNG is still too heavy — fall back to JPEG.
        if (out.length > MAX_BYTES) {
          out = await sharp(fileBuffer).resize(resizeOpts).jpeg({ quality: 85 }).toBuffer();
          outFilename = filename.replace(/\.[^/.]+$/, '') + '.jpg';
        }
      } else {
        let quality = 90;
        out = await sharp(fileBuffer).resize(resizeOpts).jpeg({ quality }).toBuffer();
        while (out.length > MAX_BYTES && quality > 40) {
          quality -= 15;
          out = await sharp(fileBuffer).resize(resizeOpts).jpeg({ quality }).toBuffer();
        }
        outFilename = filename.replace(/\.[^/.]+$/, '') + '.jpg';
      }

      this.log(`Resized image for Meta limits`, {
        from: { width, height, bytes: fileBuffer.length },
        to: { bytes: out.length, filename: outFilename },
      });
      return { buffer: out, filename: outFilename, resized: true };
    } catch (error: any) {
      console.error('[MetaService] resizeImageForMeta failed, uploading original buffer:', error?.message);
      return { buffer: fileBuffer, filename, resized: false };
    }
  }

  /**
   * Upload image to ad account
   */
  public async uploadImage(adAccountId: string, accessToken: string, filename: string, fileBuffer: Buffer) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      // Downscale oversized images up front — Meta rejects them with a generic error.
      const prepared = await this.resizeImageForMeta(fileBuffer, filename);
      const uploadFilename = prepared.filename;
      const uploadBuffer = prepared.buffer;
      this.log(`Uploading image to account: ${adAccountId}, filename: ${uploadFilename}`, {
        resized: prepared.resized,
        bytes: uploadBuffer.length,
      });
      const adImage = await account.createAdImage([], {
        filename: uploadFilename,
        bytes: uploadBuffer.toString('base64'),
      });
      // Meta's /adimages endpoint returns the result keyed by the uploaded filename,
      // e.g. { images: { "<filename>": { hash, url, ... } } }. The SDK stores this raw
      // payload on `_data`, so we must unwrap the (single) entry to expose a flat
      // { hash, url, ... } object. Returning the raw map forces every caller to dig the
      // hash out of a filename-keyed object, which is where distinct creatives end up
      // mapped to the wrong hash under batch uploads.
      const data = adImage._data || {};
      if (data.images && typeof data.images === 'object') {
        const keys = Object.keys(data.images);
        if (keys.length > 0) {
          const entry = data.images[keys[0]];
          this.log(`Image uploaded`, { filename: uploadFilename, hash: entry?.hash });
          return entry;
        }
      }
      // Fallback: response was already flat (e.g. { hash, url }).
      return data;
    } catch (error) {
      return this.handleError(error, 'uploadImage');
    }
  }

  /**
   * Upload video to ad account
   */
  public async uploadVideo(adAccountId: string, accessToken: string, videoUrl: string) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      this.log(`Uploading video to account: ${adAccountId}, url: ${videoUrl}`);
      // Using file_url for remote upload which is supported by Meta API
      const adVideo = await account.createAdVideo([], {
        file_url: videoUrl,
      });
      return adVideo._data;
    } catch (error) {
      return this.handleError(error, 'uploadVideo');
    }
  }

  /**
   * List Custom Audiences.
   *
   * ⚠ ENG-1625 follow-up: the old code hard-capped `limit: 50`, fetched exactly one page,
   * and returned a bare array — no truncation signal past that cap. Same ENG-1584 shape as
   * the other list edges. Returns a result object so truncation cannot be dropped on the
   * floor by a caller that just maps over it.
   */
  public async listCustomAudiences(
    adAccountId: string,
    accessToken: string,
    options: { maxPages?: number } = {}
  ): Promise<MetaCustomAudienceListResult> {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      const fields = [
        'id',
        'name',
        'description',
        'delivery_status',
        'subtype',
        'customer_file_source',
        // ENG-600: needed so a lookalike reuse-by-name match can verify the
        // existing audience's actual ratio/country, not just its name — see
        // agentModeService's executeAudienceCampaignLaunch.
        'lookalike_spec',
      ];
      const params: Record<string, any> = { limit: META_LIST_PAGE_SIZE };
      this.log(`Listing custom audiences for account: ${adAccountId}`, { fields });
      const cursor = await MetaService.withReadDeadline(
        async () => account.getCustomAudiences(fields, params),
        'custom audience list',
      );
      const { items, truncated, pagesFetched } = await this.drainCursor(
        cursor,
        options.maxPages ?? META_LIST_MAX_PAGES
      );
      return { audiences: items.map((a: any) => a._data ?? a), truncated, pagesFetched };
    } catch (error) {
      // handleError always throws — a failed read must never look like "no audiences".
      return this.handleError(error, 'listCustomAudiences') as never;
    }
  }

  /**
   * Create Custom Audience (Custom File or Lookalike)
   */
  public async createCustomAudience(adAccountId: string, accessToken: string, params: any) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      
      const audienceParams: any = {
        name: params.name,
        subtype: params.subtype, // CUSTOM, LOOKALIKE, WEBSITE
        description: params.description,
      };

      if (params.subtype === 'CUSTOM') {
          audienceParams.customer_file_source = params.customer_file_source || 'USER_PROVIDED_ONLY';
      } else if (params.subtype === 'LOOKALIKE') {
          // Meta's current create API takes the seed via a top-level
          // origin_audience_id param, not a lookalike_spec.origin array —
          // that shape only appears when READING a lookalike back (confirmed
          // live: "(#2654) ... No custom_audience ID given for lookalike
          // cluster" when origin was sent inside lookalike_spec). Callers
          // still pass the seed as lookalike_spec.origin[0].id (our public
          // shape, unchanged) — translated here at the Graph API boundary.
          const { origin, ...lookalikeSpecRest } = params.lookalike_spec || {};
          const originAudienceId = Array.isArray(origin) ? origin[0]?.id : undefined;
          if (originAudienceId) {
            audienceParams.origin_audience_id = originAudienceId;
          }
          audienceParams.lookalike_spec = {
            type: 'similarity',
            ...lookalikeSpecRest,
          };
      }

      this.log(`Creating custom audience in account: ${adAccountId}`, audienceParams);
      const audience = await account.createCustomAudience(['id', 'name'], audienceParams);
      return audience._data;
    } catch (error) {
      return this.handleError(error, 'createCustomAudience');
    }
  }

  // Meta caps a single POST /{audience_id}/users request at 10,000 records.
  // Uploads above that must be split into sequential batches sharing one
  // session_id, with batch_seq incrementing from 1 and last_batch_flag set
  // only on the final batch — Meta's documented multi-batch upload protocol.
  private static readonly CUSTOM_AUDIENCE_USERS_BATCH_SIZE = 10000;

  /**
   * Add users to a Custom Audience (from CSV/Hashed data). Payloads over
   * 10,000 rows are chunked into sequential session-batched requests
   * (see CUSTOM_AUDIENCE_USERS_BATCH_SIZE); smaller payloads are sent as a
   * single request with no session object, unchanged from prior behavior.
   */
  public async uploadCustomAudienceUsers(adAccountId: string, accessToken: string, audienceId: string, schema: string[], payload: string | string[][]) {
    try {
      this.initApi(accessToken);
      const audience = new CustomAudience(audienceId);

      this.log(`Uploading users to custom audience: ${audienceId}`, { schema, payloadType: typeof payload });

      const rows = payload;
      if (!Array.isArray(rows) || rows.length <= MetaService.CUSTOM_AUDIENCE_USERS_BATCH_SIZE) {
        const result = await audience.createUser([], { payload: { schema, data: payload } });
        return result._data || result;
      }

      // Multi-batch upload: same session_id across every chunk, sequential
      // (not parallel) so batch_seq ordering matches send order.
      const sessionId = Math.floor(Math.random() * 1_000_000_000);
      const totalBatches = Math.ceil(rows.length / MetaService.CUSTOM_AUDIENCE_USERS_BATCH_SIZE);
      let lastResult: any;
      for (let i = 0; i < totalBatches; i++) {
        const chunk = rows.slice(
          i * MetaService.CUSTOM_AUDIENCE_USERS_BATCH_SIZE,
          (i + 1) * MetaService.CUSTOM_AUDIENCE_USERS_BATCH_SIZE
        );
        const batchSeq = i + 1;
        const isLastBatch = batchSeq === totalBatches;
        this.log(`Uploading batch ${batchSeq}/${totalBatches} to custom audience: ${audienceId}`, { session_id: sessionId, rows: chunk.length });
        const result = await audience.createUser([], {
          // ENG-1343: Meta rejects `session` nested in `payload` ("(#100)
          // Invalid keys \"session\" were found in param \"payload\"") — it
          // must be a top-level sibling param, same as /usersreplace.
          payload: { schema, data: chunk },
          session: {
            session_id: sessionId,
            batch_seq: batchSeq,
            last_batch_flag: isLastBatch,
            estimated_num_total: rows.length,
          },
        });
        lastResult = result._data || result;
      }
      return lastResult;
    } catch (error) {
       return this.handleError(error, 'uploadCustomAudienceUsers');
    }
  }

  /**
   * Remove users from a Custom Audience (the sync-to-remove counterpart of
   * uploadCustomAudienceUsers). Chunking/session protocol mirrors the upload
   * method exactly — Meta's 10,000-record cap and session_id/batch_seq/
   * last_batch_flag batching apply to /users deletes the same way.
   */
  public async deleteCustomAudienceUsers(adAccountId: string, accessToken: string, audienceId: string, schema: string[], payload: string | string[][]) {
    try {
      this.initApi(accessToken);
      const audience = new CustomAudience(audienceId);

      this.log(`Deleting users from custom audience: ${audienceId}`, { schema, payloadType: typeof payload });

      const rows = payload;
      if (!Array.isArray(rows) || rows.length <= MetaService.CUSTOM_AUDIENCE_USERS_BATCH_SIZE) {
        // ENG-600 live-test finding: unlike createUser(fields, params),
        // CustomAudience.deleteUsers takes a SINGLE params argument — calling
        // it deleteUsers([], {...}) silently discards the real params object
        // (the SDK reads only arguments[0], which was the empty fields array),
        // so Meta received no payload at all: "(#100) Missing required
        // parameter: payload".
        const result = await audience.deleteUsers({ payload: { schema, data: payload } });
        return result._data || result;
      }

      const sessionId = Math.floor(Math.random() * 1_000_000_000);
      const totalBatches = Math.ceil(rows.length / MetaService.CUSTOM_AUDIENCE_USERS_BATCH_SIZE);
      let lastResult: any;
      for (let i = 0; i < totalBatches; i++) {
        const chunk = rows.slice(
          i * MetaService.CUSTOM_AUDIENCE_USERS_BATCH_SIZE,
          (i + 1) * MetaService.CUSTOM_AUDIENCE_USERS_BATCH_SIZE
        );
        const batchSeq = i + 1;
        const isLastBatch = batchSeq === totalBatches;
        this.log(`Deleting batch ${batchSeq}/${totalBatches} from custom audience: ${audienceId}`, { session_id: sessionId, rows: chunk.length });
        const result = await audience.deleteUsers({
          // ENG-1343: Meta rejects `session` nested in `payload` ("(#100)
          // Invalid keys \"session\" were found in param \"payload\"") — it
          // must be a top-level sibling param, same as /usersreplace.
          payload: { schema, data: chunk },
          session: {
            session_id: sessionId,
            batch_seq: batchSeq,
            last_batch_flag: isLastBatch,
            estimated_num_total: rows.length,
          },
        });
        lastResult = result._data || result;
      }
      return lastResult;
    } catch (error) {
      return this.handleError(error, 'deleteCustomAudienceUsers');
    }
  }

  /**
   * Atomically replace a Custom Audience's entire membership with the given
   * payload (Meta's /usersreplace edge). Used when reusing an audience with
   * no locally-saved membership snapshot to diff against (first sync since
   * ENG-600's stale-member sync shipped, or an audience created outside this
   * flow) — an add-only upload would never be able to remove members already
   * in the audience that aren't in the current source, whereas a replace
   * needs no diff/baseline at all: it sets membership to exactly this
   * payload in one operation. Chunking/session protocol mirrors
   * uploadCustomAudienceUsers/deleteCustomAudienceUsers.
   */
  public async replaceCustomAudienceUsers(adAccountId: string, accessToken: string, audienceId: string, schema: string[], payload: string | string[][]) {
    try {
      this.initApi(accessToken);
      const audience = new CustomAudience(audienceId);

      this.log(`Replacing users in custom audience: ${audienceId}`, { schema, payloadType: typeof payload });

      // Live-test finding: Meta's /usersreplace edge requires `session` as a
      // TOP-LEVEL param sibling to `payload` (as the /users edges do for
      // multi-batch, ENG-1343), always — even for a single batch. Nesting it
      // inside `payload` produces "(#100) The parameter session is required", confirmed
      // live against the real Graph API.
      const rows = payload;
      const sessionId = Math.floor(Math.random() * 1_000_000_000);
      if (!Array.isArray(rows) || rows.length <= MetaService.CUSTOM_AUDIENCE_USERS_BATCH_SIZE) {
        const result = await audience.createUsersReplace([], {
          payload: { schema, data: payload },
          session: {
            session_id: sessionId,
            batch_seq: 1,
            last_batch_flag: true,
            estimated_num_total: Array.isArray(rows) ? rows.length : undefined,
          },
        });
        return result._data || result;
      }

      const totalBatches = Math.ceil(rows.length / MetaService.CUSTOM_AUDIENCE_USERS_BATCH_SIZE);
      let lastResult: any;
      for (let i = 0; i < totalBatches; i++) {
        const chunk = rows.slice(
          i * MetaService.CUSTOM_AUDIENCE_USERS_BATCH_SIZE,
          (i + 1) * MetaService.CUSTOM_AUDIENCE_USERS_BATCH_SIZE
        );
        const batchSeq = i + 1;
        const isLastBatch = batchSeq === totalBatches;
        this.log(`Replacing batch ${batchSeq}/${totalBatches} in custom audience: ${audienceId}`, { session_id: sessionId, rows: chunk.length });
        const result = await audience.createUsersReplace([], {
          payload: { schema, data: chunk },
          session: {
            session_id: sessionId,
            batch_seq: batchSeq,
            last_batch_flag: isLastBatch,
            estimated_num_total: rows.length,
          },
        });
        lastResult = result._data || result;
      }
      return lastResult;
    } catch (error) {
      return this.handleError(error, 'replaceCustomAudienceUsers');
    }
  }

  // Geolocation search types must go through the top-level /search endpoint,
  // NOT the ad account 'targetingsearch' edge (which only resolves interests/
  // behaviors/demographics and silently returns interest-style results for
  // geo queries). See ENG-331.
  private static readonly GEO_SEARCH_TYPES = new Set([
    'adgeolocation',
    'adgeolocationmeta',
    'adcountry',
    'adregion',
    'adcity',
    'adzipcode',
  ]);

  /**
   * Search for Detailed Targeting options
   */
  public async searchTargeting(
    adAccountId: string,
    accessToken: string,
    q: string,
    type: string,
    locationTypes?: string[]
  ) {
    // Geolocation lookups (cities, regions, zips, countries) resolve via the
    // top-level /search endpoint, which returns entries with location keys/
    // region_ids usable in ad set geo_locations. The targetingsearch edge does
    // not support these types and returns interest results instead.
    if (MetaService.GEO_SEARCH_TYPES.has(type)) {
      return this.searchGeoLocations(accessToken, q, type, locationTypes);
    }

    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);

      const params: any = {
        q: q,
        type: type,
        class: type // behaviors and demographics often use 'class' parameter
      };

      if (type === 'adinterest') {
          delete params.class;
      }

      this.log(`Searching targeting options in account: ${adAccountId}`, params);

      // 'targetingsearch' edge returns a list of targeting options
      const results = await account.getTargetingSearch([], params);

      // Handle both Cursor and plain array responses
      const data = results.map((item: any) => item._data);
      return data;
    } catch (error) {
      return this.handleError(error, 'searchTargeting');
    }
  }

  /**
   * Search for geo-targeting locations (cities, regions, zips, countries) via the
   * top-level Graph API /search endpoint. Returns entries with a location `key`
   * and `region_id` that can be used directly in an ad set's `geo_locations`.
   */
  private async searchGeoLocations(accessToken: string, q: string, type: string, locationTypes?: string[]) {
    try {
      const apiVersion = process.env.META_API_VERSION || 'v25.0';
      let url = `https://graph.facebook.com/${apiVersion}/search?type=${encodeURIComponent(type)}` +
        `&q=${encodeURIComponent(q)}&limit=25&access_token=${encodeURIComponent(accessToken)}`;
      if (locationTypes && locationTypes.length > 0) {
        url += `&location_types=${encodeURIComponent(JSON.stringify(locationTypes))}`;
      }

      this.log(`Searching geo locations (type=${type})`, { q, locationTypes });

      const { fetchWithRetry } = await import('../utils/metaApiFetch');
      const response = await fetchWithRetry(url);
      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message || 'Failed to search geo locations');
      }
      return data.data || [];
    } catch (error) {
      return this.handleError(error, 'searchGeoLocations');
    }
  }

  /**
   * Get insights/performance data
   */
  public async getInsights(adAccountId: string, accessToken: string, params: { timeframe: string, level?: string }) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      
      // Calculate date range based on timeframe using explicit YYYY-MM-DD
      const now = new Date();
      const format = (d: Date) => d.toISOString().split('T')[0];
      
      const daysMap: Record<string, number> = {
        '7d': 7, '14d': 14, '30d': 30, '90d': 90
      };
      const days = daysMap[params.timeframe] || 7;
      const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

      const dateRange = { 
        since: format(since), 
        until: format(now) 
      };

      const level = params.level || 'campaign';
      
      // Define fields based on level to avoid "Invalid field" errors from Meta
      const fields = [
        'impressions',
        'clicks',
        'spend',
        'reach',
        'frequency',
        'objective',
        'cpc',
        'ctr',
      ];

      if (level === 'campaign') {
        fields.push('campaign_id', 'campaign_name');
      } else if (level === 'adset') {
        fields.push('campaign_id', 'campaign_name', 'adset_id', 'adset_name');
      } else if (level === 'ad') {
        fields.push('campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name');
      }

      const searchParams = {
        level: level,
        time_range: dateRange,
      };

      this.log(`Fetching insights for account: ${adAccountId}`, searchParams);
      const insights = await account.getInsights(fields, searchParams);
      return insights.map((i: any) => i._data);
    } catch (error) {
      return this.handleError(error, 'getInsights');
    }
  }

  /**
   * List ad pixels associated with an ad account.
   *
   * ⚠ ENG-1625 follow-up: the old code called the Graph API directly with `fetchWithRetry`
   * (bypassing the SDK's Cursor entirely) and read only `data.data`, ignoring `paging.next` —
   * one page, no bound, no truncation signal, the same ENG-1584 shape as every other edge in
   * this file. The SDK's `AdAccount.getAdsPixels` exposes the same edge as a proper Cursor
   * (confirmed against the installed SDK), so this now goes through the same
   * withReadDeadline/drainCursor path as every other list method here instead of a
   * bespoke fetch. Returns a result object so truncation cannot be dropped on the floor by a
   * caller that just maps over it.
   */
  public async listPixels(
    adAccountId: string,
    accessToken: string,
    options: { maxPages?: number } = {}
  ): Promise<MetaPixelListResult> {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      const fields = ['id', 'name', 'last_fired_time', 'is_created_by_business'];
      const params: Record<string, any> = { limit: META_LIST_PAGE_SIZE };
      this.log(`Listing pixels for account: ${adAccountId}`, { fields });
      const cursor = await MetaService.withReadDeadline(async () => account.getAdsPixels(fields, params), 'pixel list');
      const { items, truncated, pagesFetched } = await this.drainCursor(
        cursor,
        options.maxPages ?? META_LIST_MAX_PAGES
      );
      return { pixels: items.map((p: any) => p._data ?? p), truncated, pagesFetched };
    } catch (error) {
      // handleError always throws — a failed read must never look like "no pixels".
      return this.handleError(error, 'listPixels') as never;
    }
  }

  /**
   * Get event match quality (EMQ) scores for a dataset
   */
  public async getDatasetEventStats(datasetId: string, accessToken: string) {
    try {
      const apiVersion = process.env.META_API_VERSION || 'v25.0';
      const url = `https://graph.facebook.com/${apiVersion}/${datasetId}?fields=id,name,event_stats&access_token=${accessToken}`;
      const { fetchWithRetry } = await import('../utils/metaApiFetch');
      const response = await fetchWithRetry(url);
      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message || 'Failed to get dataset event stats');
      }
      return data;
    } catch (error) {
      return this.handleError(error, 'getDatasetEventStats');
    }
  }

  /**
   * Auto-resolve which Meta pixel a lander should use, from the site owner's already-connected
   * Meta ad account. Uses `pixel.id` directly as the dataset id — Meta unified
   * pixel + dataset in Graph v25, so there is no per-pixel dataset lookup to make. (The old
   * `listDatasets` helper hit the removed `/<pixel_id>/datasets` edge and was deleted in
   * ENG-399, which fixed the same bug in the DATASET LIST tool path.)
   *
   * Never throws: an unconnected account, an ambiguous pixel/account set, or any Graph/
   * credential error all resolve to `{ unresolved: true, reason }` so generation can proceed
   * without tracking rather than fail outright (AC3 — fail loud, never fail generation).
   *
   * Imports `services/metaAccountCredentials` dynamically (not at module top level) because
   * that module depends on `metaTokenRefresh.ts`, which already imports this file — a static
   * top-level import here would be circular. Deferring to call time (same pattern already used
   * in this file for `utils/metaApiFetch`) sidesteps it, since by the time this runs the whole
   * module graph is already loaded.
   */
  public async resolveMetaPixelForUser(
    user: any,
    userId: string,
  ): Promise<
    | { pixelId: string; accountId: string }
    /** `transient` distinguishes "this account structurally has no pixel to resolve" from
     *  "we could not reach Meta / could not refresh a token just now". Both surface as
     *  unresolved because this resolver never throws, but only the second is worth
     *  retrying — and a caller that treats them alike either drops a conversion forever or
     *  retries a permanent condition five times (ENG-926 §C, Greptile on #2412). */
    | { unresolved: true; reason: string; transient?: boolean }
  > {
    try {
      const { getConnectedMetaAccountsList, getMetaAccountCredentials } = await import('./metaAccountCredentials');

      const accounts = getConnectedMetaAccountsList(user);
      if (accounts.length === 0) {
        return { unresolved: true, reason: 'No Meta ad account connected' };
      }
      if (accounts.length > 1) {
        return { unresolved: true, reason: 'Multiple Meta ad accounts connected — no default account to resolve a pixel from' };
      }

      const { accountId, accessToken } = await getMetaAccountCredentials(user, userId, accounts[0].accountId);
      const { pixels } = await this.listPixels(accountId, accessToken);

      if (!pixels || pixels.length === 0) {
        return { unresolved: true, reason: `No Meta pixel found on ad account ${accountId}` };
      }
      if (pixels.length > 1) {
        return { unresolved: true, reason: `Ad account ${accountId} has ${pixels.length} pixels — ambiguous which to use` };
      }

      return { pixelId: pixels[0].id, accountId };
    } catch (error: any) {
      return { unresolved: true, reason: error?.message || 'Unknown error resolving Meta pixel' };
    }
  }

  /**
   * Calendly's resolution (ENG-1141) — deliberately NOT resolveMetaPixelForUser, because
   * a booking webhook is unattended (no human to prompt when ambiguous), so this defaults
   * to the caller's first connected account and its first pixel instead of refusing. An
   * explicit `stored` choice (the Calendly card's own account/pixel dropdowns) always wins
   * when both fields are present. Never throws, same AC3 guarantee as resolveMetaPixelForUser.
   */
  /**
   * Does the stored pixel still exist on its (still-connected) account?
   *
   * Cache-first by design: `/pixels` already caches the customer's full pixel set per user and
   * invalidates it on connect/disconnect, so a warm entry answers this for free. Only a cold
   * cache costs one Graph call, scoped to the single stored account rather than a full fan-out.
   *
   * FAILS OPEN. If the check itself cannot run — expired token, Graph outage, malformed record —
   * the answer is "keep the customer's explicit choice". Falling back to auto-resolution on an
   * outage would silently repoint a working configuration at a different pixel, which is worse
   * than briefly honoring one that may have been deleted (that case degrades visibly: the CAPI
   * send fails and is recorded in the job's `failures`).
   *
   * The partial result is deliberately NOT written back into the /pixels cache: it covers one
   * account, and storing it would make a later full read believe the customer has no others.
   */
  private async storedPixelStillExists(
    user: any,
    userId: string,
    stored: { pixelId: string; accountId: string },
  ): Promise<boolean> {
    try {
      const { getCachedPixels } = await import('./metaPixelsCache');
      const cached = getCachedPixels(userId);
      if (cached) {
        return cached.some((p) => p.pixelId === stored.pixelId && p.accountId === stored.accountId);
      }

      const { getMetaAccountCredentials } = await import('./metaAccountCredentials');

      // Two failures that must NOT be treated alike (Greptile round 5 on #2384).
      //
      // Credentials failing is evidence about the stored pair itself: that account's token is
      // gone or unusable, so keeping the selection would send every later booking down a path
      // whose credentials cannot resolve — retried to exhaustion while a healthy pixel on
      // another connected account sits unused. That is the exact failure the connectivity
      // check exists to prevent, so treat it as "not usable" and let the search continue.
      let credentials: { accountId: string; accessToken: string };
      try {
        credentials = await getMetaAccountCredentials(user, userId, stored.accountId);
      } catch (error: any) {
        console.warn(
          `[Meta] Stored Calendly attribution account ${stored.accountId} has no usable credentials ` +
          `(${error?.message}) — falling back to auto-resolution`,
        );
        return false;
      }

      // A Graph failure is evidence about Meta, not about the choice. Keep it: repointing a
      // working configuration because of a transient outage is worse than briefly honoring a
      // pixel that may have been deleted, which degrades visibly as a recorded CAPI failure.
      try {
        const { pixels } = await this.listPixels(credentials.accountId, credentials.accessToken);
        return (pixels || []).some((p: any) => p.id === stored.pixelId);
      } catch (error: any) {
        console.warn(
          `[Meta] Could not reach Meta to verify stored pixel ${stored.pixelId} ` +
          `(keeping the customer's choice): ${error?.message}`,
        );
        return true;
      }
    } catch (error: any) {
      // The cache lookup or module import failed — nothing learned about the pair either way.
      console.warn(
        `[Meta] Could not verify stored pixel ${stored.pixelId} (keeping the customer's choice): ${error?.message}`,
      );
      return true;
    }
  }

  public async resolveMetaPixelWithDefault(
    user: any,
    userId: string,
    stored: { pixelId: string; accountId: string } | undefined,
  ): Promise<
    | { pixelId: string; accountId: string }
    /** `transient` distinguishes "this account structurally has no pixel to resolve" from
     *  "we could not reach Meta / could not refresh a token just now". Both surface as
     *  unresolved because this resolver never throws, but only the second is worth
     *  retrying — and a caller that treats them alike either drops a conversion forever or
     *  retries a permanent condition five times (ENG-926 §C, Greptile on #2412). */
    | { unresolved: true; reason: string; transient?: boolean }
  > {
    try {
      const { getConnectedMetaAccountsList, getMetaAccountCredentials } = await import('./metaAccountCredentials');

      // The stored pair is a snapshot of a choice made earlier, so it can outlive the
      // connection it names — the customer disconnects that Meta account, or a reconnect
      // issues a different account id. Honoring it blindly sends every later booking down
      // a path whose credentials no longer resolve: the CAPI leg throws, the job is marked
      // failed and retried to exhaustion, and a healthy pixel on another connected account
      // is never tried (Greptile P1 on #2384; Pass 1 of this feature had this check and the
      // Pass-2 rework dropped it). The check is LOCAL — it reads the already-loaded user
      // record — deliberately not a Graph round-trip on every booking just to confirm a
      // stored choice. A pixel deleted from a still-connected account therefore still gets
      // honored here and surfaces as a CAPI failure instead; catching that would cost a
      // per-booking API call, which this resolver exists to avoid.
      if (stored?.pixelId && stored?.accountId) {
        let storedAccountStillConnected = true;
        try {
          storedAccountStillConnected = getConnectedMetaAccountsList(user)
            .some((account: { accountId: string }) => account.accountId === stored.accountId);
        } catch {
          // Unreadable/malformed user record: keep the customer's explicit choice rather
          // than silently downgrading it to "whatever account comes first".
          storedAccountStillConnected = true;
        }
        if (storedAccountStillConnected) {
          // The account surviving is only half of staleness — the pixel itself can be deleted
          // from an account that is still connected (Greptile round 4 on #2384). Verified via
          // the shared /pixels cache, so the common case (a customer who just looked at the
          // picker, or any second booking inside the TTL) costs no Graph traffic at all.
          if (await this.storedPixelStillExists(user, userId, stored)) {
            return { pixelId: stored.pixelId, accountId: stored.accountId };
          }
          console.warn(
            `[Meta] Stored Calendly attribution pixel ${stored.pixelId} no longer exists on account ` +
            `${stored.accountId} — falling back to auto-resolution`,
          );
        }
        console.warn(
          `[Meta] Stored Calendly attribution account ${stored.accountId} is no longer connected — falling back to auto-resolution`,
        );
      }

      const accounts = getConnectedMetaAccountsList(user);
      if (accounts.length === 0) {
        return { unresolved: true, reason: 'No Meta ad account connected' };
      }

      // Search every connected account in order for the first one that actually has
      // a pixel — the whole point of this resolver is "always resolvable once ANY
      // connected account has a pixel," so it can't stop at accounts[0] just because
      // that particular account happens to have none (a real regression caught live:
      // a customer's first-listed account had 0 pixels while a later one had 1, and
      // the naive accounts[0]-only version reproduced the exact silent-skip bug this
      // resolver exists to fix). One account's failure (expired token, Graph error)
      // is skipped, not fatal — the next account still gets a fair try.
      let lastReason = `No Meta pixel found on any of ${accounts.length} connected ad account(s)`;
      // A caught failure here is a credential refresh or a Graph call going wrong, not a
      // statement about how this account is configured — so the result is unresolved but
      // retryable, unlike "every connected account genuinely has zero pixels".
      let sawTransientFailure = false;
      for (const account of accounts) {
        try {
          const { accountId, accessToken } = await getMetaAccountCredentials(user, userId, account.accountId);
          const { pixels } = await this.listPixels(accountId, accessToken);
          if (pixels && pixels.length > 0) {
            return { pixelId: pixels[0].id, accountId };
          }
        } catch (error: any) {
          lastReason = error?.message || lastReason;
          sawTransientFailure = true;
        }
      }
      return { unresolved: true, reason: lastReason, transient: sawTransientFailure };
    } catch (error: any) {
      // An unexpected throw out of the resolver itself is likewise not a configuration fact.
      return { unresolved: true, reason: error?.message || 'Unknown error resolving Meta pixel', transient: true };
    }
  }

  /**
   * Server-side Meta Conversions API (CAPI) send. Fires a `Lead` event directly to
   * Meta from our own trusted backend — never from a generated customer repo, which would
   * require shipping an access token into code we push to a customer-owned deployment.
   *
   * `event_id` must match whatever the browser-side `fbq('track','Lead', {}, {eventID})` call
   * used, so Meta dedups the two into one conversion (AC2).
   *
   * Sends even with no email/phone present (event_source_url + IP/UA alone still counts as a
   * signal) — skipping would recreate the exact silent-undercounting bug this card exists to
   * fix. Never throws: the lead save that already happened in the caller must not be affected
   * by a Meta-side failure.
   */
  public async sendCapiLeadEvent(
    pixelId: string,
    accessToken: string,
    event: {
      eventId: string;
      email?: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
      clientIp?: string;
      userAgent?: string;
      sourceUrl?: string;
      /** Meta's own first-party click-id cookies (`_fbp`/`_fbc`) — opaque values, sent
       * verbatim per Meta's CAPI spec (unlike em/ph, these are NOT hashed). */
      fbp?: string;
      fbc?: string;
      /** Real client-submission time (Unix seconds), threaded from the customer's own
       *  capture route via forward-lead — NOT server CAPI-send time. Falls back to the
       *  current time when absent/invalid (an older, not-yet-regenerated capture route
       *  never sent one, or the caller's own validation rejected it as implausible). */
      eventTimeSeconds?: number;
      /** Meta standard event name. Defaults to 'Lead' (this function's original/only
       *  caller, webhooks.ts's form-submission forward-lead). Callers for a different
       *  conversion type — e.g. calendlyWebhook.ts sending 'Schedule' for a booking,
       *  per ENG-524's PRD and matching ENG-522's sendScheduleEvent — pass it explicitly. */
      eventName?: string;
      /** ENG-926 §C: Meta's `custom_data`, emitted only when present so every existing
       *  caller's payload is byte-identical to what it was before this field existed.
       *  `value`/`currency` are what make a closed-won `Purchase` usable for Meta's
       *  value-based bidding — without them the event counts but carries no revenue. */
      customData?: { value?: number; currency?: string };
      /** Meta's `action_source`. Defaults to 'website', which is correct for this
       *  function's original callers (a real form submission, and ENG-522's booking flow)
       *  and keeps their payloads unchanged.
       *
       *  A CRM status change is NOT a website event — nobody was on a page — and claiming
       *  otherwise misdescribes where the conversion happened. Meta validates this field:
       *  probed against Graph v25 on 2026-08-14, 'system_generated' and 'website' are both
       *  accepted while a bogus value is rejected with "Invalid Action Source Parameter",
       *  so acceptance here is meaningful rather than the API ignoring the field. */
      actionSource?: string;
    },
  ): Promise<
    | { success: true; fbtraceId?: string; usage?: CapiUsage }
    | { success: false; error: string; usage?: CapiUsage }
  > {
    try {
      const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

      // Normalisation rules live in metaUserDataNormalisation.ts, where they are pinned by
      // hash against Meta's own fbevents.js output. They are NOT interchangeable per field:
      // `em` keeps `.`/`+`/`@`, `ph` keeps digits only, `fn`/`ln` drop everything that is
      // not alphanumeric. See that module's header for how each rule was established.
      //
      // Empty means "no usable value" and the field is omitted entirely — hashing an empty
      // string produces a real, constant hash that Meta would accept as if it identified a
      // person, shared by every customer who left the field blank.
      const hashedOrOmit = (field: NormalisableUserDataField, raw?: string): string[] | undefined => {
        const normalised = normaliseUserDataField(field, raw);
        return normalised ? [sha256(normalised)] : undefined;
      };

      const userData: Record<string, any> = {};
      const em = hashedOrOmit('em', event.email);
      if (em) userData.em = em;
      const ph = hashedOrOmit('ph', event.phone);
      if (ph) userData.ph = ph;
      // Previously trimmed and lowercased only, so every name carrying punctuation or an
      // internal space hashed differently from Meta's version of the same name — "van der
      // Berg" and "O'Brien" never matched, silently, on every event we have ever sent.
      const fn = hashedOrOmit('fn', event.firstName);
      if (fn) userData.fn = fn;
      const ln = hashedOrOmit('ln', event.lastName);
      if (ln) userData.ln = ln;
      if (event.clientIp) userData.client_ip_address = event.clientIp;
      if (event.userAgent) userData.client_user_agent = event.userAgent;
      if (event.fbp) userData.fbp = event.fbp;
      if (event.fbc) userData.fbc = event.fbc;

      // Prefer the real client-submission time over server processing time — everything
      // else about this function is about not UNDER-counting; a stale/skewed event_time
      // is the opposite failure mode (risks Meta treating a delayed retry as a distinct
      // event past its dedup window, i.e. OVER-counting). Only trust a valid, safe, positive
      // integer; anything else (NaN, negative, non-integer) silently falls back to now.
      const eventTime =
        Number.isSafeInteger(event.eventTimeSeconds) && (event.eventTimeSeconds as number) > 0
          ? (event.eventTimeSeconds as number)
          : Math.floor(Date.now() / 1000);

      // Only build custom_data when there is something to put in it — an empty object
      // would still be a payload change for every existing caller.
      const customData: Record<string, any> = {};
      if (typeof event.customData?.value === 'number') customData.value = event.customData.value;
      if (event.customData?.currency) customData.currency = event.customData.currency;

      const apiVersion = process.env.META_API_VERSION || 'v25.0';
      const url = `https://graph.facebook.com/${apiVersion}/${pixelId}/events`;
      const body = {
        access_token: accessToken,
        data: [
          {
            event_name: event.eventName || 'Lead',
            event_id: event.eventId,
            event_time: eventTime,
            action_source: event.actionSource || 'website',
            event_source_url: event.sourceUrl,
            user_data: userData,
            ...(Object.keys(customData).length > 0 ? { custom_data: customData } : {}),
          },
        ],
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data: any = await response.json();
      const usage = parseBusinessUseCaseUsage(response);

      if (!response.ok || data.error) {
        const message = data?.error?.message || `CAPI send failed with HTTP ${response.status}`;
        console.error(`[MetaService] sendCapiLeadEvent failed for pixel ${pixelId}: ${message}`);
        return { success: false, error: message, usage };
      }

      // The ONLY record of what identity actually left this process, and the reason it exists
      // is specific: Meta's `/stats?aggregation=match_keys` does NOT report `fbc` or `fbp`.
      // Verified 2026-08-18 across three production pixels carrying real paid traffic and ~15
      // distinct event types — zero occurrences of either, including on a lander proven to set
      // both cookies. So an absent `fbc` there is NOT evidence it was never sent, and ENG-926's
      // AC2 was once judged failed on exactly that inference (§50, corrected in §55).
      //
      // Until someone has Business Manager access, this line is the only send-side proof
      // available — §42 recorded the gap as "nothing logs it".
      //
      // KEY NAMES ONLY, never values: every entry here is PII (`em`/`ph`/`fn`/`ln` hashes,
      // `client_ip_address`, `client_user_agent`) or a click identifier (`fbc`/`fbp`).
      const sentKeys = Object.keys(userData).sort();

      console.log(
        `[MetaService] CAPI ${event.eventName || 'Lead'} accepted — pixel ${pixelId} ` +
        `event_id=${event.eventId} user_data keys: ` +
        `${sentKeys.join(',') || '(none)'}`,
      );

      // ENG-926 §F — persist what that log line says, so send-side identity coverage is a
      // TREND rather than a grep. The card asks to track Event Match Quality over time and
      // Meta sells no such API, so the half we own is: of the conversions we actually sent,
      // what fraction carried each key. `fn`/`ln` were hashed wrong for 24 days and nothing
      // could see it, because the only symptom is a number quietly lower than it should be.
      //
      // ⚠ Awaited, and wrapped so it can NEVER throw. Meta has already ACCEPTED this
      // conversion by the time we get here — it cannot be recalled — so a storage fault must
      // not turn a delivered conversion into a reported failure, nor provoke a relay retry of
      // an event Meta already counted. Awaited rather than fire-and-forget because a floating
      // promise outliving the Jest environment is exactly the ENG-1286 shape, and a DynamoDB
      // update is ~10ms against a CAPI round trip of hundreds.
      try {
        const [{ recordCapiKeySend }, { addCapiKeyCounters }] = await Promise.all([
          import('./metaCapiKeyCoverage'),
          import('./metaCapiKeyCoverageDb'),
        ]);
        await recordCapiKeySend(
          { pixelId, eventName: event.eventName, keys: sentKeys, nowMs: Date.now() },
          { addCounters: addCapiKeyCounters },
        );
      } catch (coverageError: any) {
        console.warn(
          `[MetaService] CAPI key coverage not recorded for pixel ${pixelId}: ${coverageError?.message}`,
        );
      }

      return { success: true, fbtraceId: data.fbtrace_id, usage };
    } catch (error: any) {
      console.error(`[MetaService] sendCapiLeadEvent threw for pixel ${pixelId}: ${error?.message}`);
      return { success: false, error: error?.message || 'Unknown error sending CAPI event' };
    }
  }
}

export const metaService = MetaService.getInstance();

/**
 * Compute the `url_tags` an existing, already-live ad should carry after a
 * single-ad UTM retrofit (Harsha's ask — the audit tool can only find campaigns
 * missing UTMs, never fix them).
 *
 * Mirrors `resolveUrlTags`'s algorithm (a key already on ANY reference link URL
 * is never duplicated into `url_tags`) but operates on primitives instead of a
 * full `MetaAdsAdCreativeParams`, since a retrofit only has what it read back
 * from an existing creative, not a caller-supplied params object.
 *
 * `changed:false` means nothing should be written — either every required key
 * is already present (on `currentUrlTags` or any link URL), or a link URL could
 * not be parsed and we refuse to risk a duplicate. The caller (the creative-swap
 * retrofit) uses `changed` to skip the API call entirely rather than diffing
 * strings, which would be fooled by a normalized leading `?`/`&` on the input.
 */
export function computeRetagUrlTags(
  currentUrlTags: string | undefined,
  linkUrls: string[],
): { urlTags: string | undefined; changed: boolean; unreadable?: boolean } {
  const omit = new Set<string>(utmKeysInQueryString(currentUrlTags));
  for (const url of linkUrls) {
    const keys = readUtmKeys(url);
    // Unreadable link → we cannot know what it already carries, so we do not
    // tag at all rather than risk a duplicate — same rule as resolveUrlTags.
    // `unreadable: true` distinguishes this from a genuine "already fully
    // tagged" no-op: both return changed:false, but a caller that collapses
    // them into the same alreadyTagged:true response gives false confirmation
    // that a malformed-destination ad is actually covered (Greptile).
    if (!keys) return { urlTags: currentUrlTags, changed: false, unreadable: true };
    for (const k of keys) omit.add(k);
  }

  const spec = buildUtmSpec('meta', { campaign: '{{campaign.id}}', content: '{{ad.id}}' });
  const merged = mergeUtmIntoQueryString(currentUrlTags, spec, omit);
  const normalizedCurrent = (currentUrlTags || '').replace(/^[?&]+/, '').replace(/&+$/, '');

  if (merged === normalizedCurrent) return { urlTags: currentUrlTags, changed: false };
  return { urlTags: merged || undefined, changed: true };
}
