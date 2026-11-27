/**
 * ENG-2823 — guarded Google Ads writes for external Zoma agents (provider #2 of the
 * ENG-2303 guarded-write flow; Meta's is metaToolkitWrites.ts).
 *
 * Allowed: BUDGET CREATE/UPDATE (amount), CAMPAIGN CREATE (PMax with its brand business name +
 * logo) / UPDATE status or name, AD_GROUP CREATE / UPDATE status or name+cpc_bid (ENG-2959),
 * CAMPAIGN_CONVERSION_GOAL UPDATE.
 * ENG-2928: KEYWORD ADD / UPDATE status / REMOVE / ADD_NEGATIVE (ad group or campaign level),
 * AD CREATE (RESPONSIVE_SEARCH_AD) / UPDATE status or RSA content (ENG-2979), ASSET_GROUP CREATE / UPDATE status, and
 * ASSET UPLOAD (image/logo from https or a staged file, text, YouTube video).
 * Everything else stays refused by googleToolkitManifest.assertGoogleToolkitCall.
 *
 * ASSET UPLOAD cannot spend (an asset does nothing until an ad / asset group uses it, and those
 * are created PAUSED on this guarded path), so — like Meta's creative upload — it runs without
 * a preview token, behind the same write gate, key scope, read-back and metering.
 *
 * Flow (shared guard, zomaWriteGuard.ts):
 *   1. Shape validation — pure, before any credential or Google call (ENG-2036).
 *   2. Payment method + usable Google Ads connection (assertZomaWriteReady 'google_ads').
 *   3. Read the current state the preview describes (target, budget, shared-budget usage).
 *   4. GOOGLE_TOOLKIT_SPEND_CEILING (mirrors META_TOOLKIT_SPEND_CEILING, micros) — on budget
 *      amounts, and on enabling a campaign at its current budget.
 *   5. No confirm → PREVIEW + single-use preview_token bound to the user, the exact arguments
 *      AND the state read in step 3. Nothing is sent to Google.
 *   6. confirm=true + matching token → dispatched ONCE through the same call_google_ads_api
 *      handler Emma uses (tracking pre-flight on enable, PAUSED defaults, ENG-592 read-back)
 *      → independent read-back. Only CONFIRMED is success; ENG-592's "accepted but unchanged"
 *      is MISMATCH, never success. A failure without a definite answer (timeout, network,
 *      5xx) may have applied, so it is UNCONFIRMED (metered), never "did not apply".
 *
 * Money: callers send MAJOR currency units (amount: 50 = $50.00); converted to micros using
 * the account currency's minor-unit precision (more precision than the currency has is
 * refused, not rounded) and echoed as both.
 */
import { getJwtSecret } from '../config/jwt';
import { evaluateMetaSpendCeiling, type MetaSpendCeilingPolicy } from '../services/agentMode/metaSpendCeiling';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { resolveZomaImageUrl } from './metaToolkitCreatives';
import { assertZomaWriteReady, ZomaNotReadyError } from './zomaOnboarding';
import {
  consumeToken, defaultConsumedTokenStore, type ConsumedTokens, previewFingerprint, previewResponse, previewTokenMatches, type WriteVerification,
} from './zomaWriteGuard';

export type GoogleReadKind =
  | 'budget' | 'campaign' | 'ad_group' | 'campaign_conversion_goal'
  | 'keyword' | 'ad' | 'asset' | 'asset_group'
  /** Multi-row reads (arrays / aggregates), keyed by the parent's resource name. */
  | 'ad_group_keywords' | 'campaign_negative_keywords' | 'campaign_brand' | 'campaign_conversion_goals';

export interface GoogleBudgetState { resourceName: string; name?: string; amountMicros: number; explicitlyShared: boolean; referenceCount: number; status?: string }
export interface GoogleCampaignState {
  resourceName: string; name?: string; status: string; budget?: string; channelType?: string;
  /** network_settings (proto3 JSON omits false, so absent reads as false). */
  searchPartners?: boolean; displayNetwork?: boolean;
}
export interface GoogleAdGroupState { resourceName: string; name?: string; status: string; campaign?: string; cpcBidMicros?: number }
export interface GoogleKeywordState { resourceName: string; text: string; matchType: string; status?: string; negative: boolean; adGroup?: string }
export interface GoogleAdState { resourceName: string; status: string; type?: string; adGroup?: string; finalUrls?: string[]; headlines?: string[]; descriptions?: string[] }
export interface GoogleAssetState { resourceName: string; name?: string; type: string; text?: string }
export interface GoogleAssetGroupState { resourceName: string; name?: string; status: string; campaign?: string; finalUrls?: string[] }
export interface GoogleCampaignBrand { businessName?: string; logoAssets: string[] }

export interface GoogleToolkitWriteDeps {
  assertReady: (userId: string) => Promise<void>;
  read: (userId: string, customerId: string, kind: GoogleReadKind, resourceName: string) => Promise<any | null>;
  /** The call_google_ads_api handler Emma registers (emma/googleAdsTools.ts). */
  dispatch: (userId: string, args: Record<string, unknown>) => Promise<any>;
  /** Staged file (caller's own) or public https image URL → the URL Google's uploader fetches. Defaults to the Meta creative rule. */
  resolveImageUrl?: (userId: string, raw: unknown, field: string) => Promise<string>;
  spendCeilingPolicy: () => MetaSpendCeilingPolicy | null;
  secret: () => string;
  now: () => number;
  consumedTokens: ConsumedTokens;
}

/**
 * Optional global ceiling for external Google writes, in MICROS (Google's native unit):
 * {"maxDailyBudget": 100000000, "maxChangeRatio": 3}. Unset = no ceiling; malformed = fail closed.
 */
export function googleSpendCeilingPolicyFromEnv(raw = process.env.GOOGLE_TOOLKIT_SPEND_CEILING): MetaSpendCeilingPolicy | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed.maxDailyBudget !== undefined || parsed.maxChangeRatio !== undefined)) return { maxDailyBudget: parsed.maxDailyBudget, maxChangeRatio: parsed.maxChangeRatio };
  } catch {
    /* fall through */
  }
  return { maxChangeRatio: -1 }; // invalid on purpose → evaluator refuses
}

const RESOURCE: Record<GoogleReadKind, string> = {
  budget: 'campaignBudgets', campaign: 'campaigns', ad_group: 'adGroups', campaign_conversion_goal: 'campaignConversionGoals',
  keyword: 'adGroupCriteria', ad: 'adGroupAds', asset: 'assets', asset_group: 'assetGroups',
  ad_group_keywords: 'adGroups', campaign_negative_keywords: 'campaigns', campaign_brand: 'campaigns',
  campaign_conversion_goals: 'campaigns',
};
/** Composite ids (`<adGroupId>~<id>`); every other resource is a bare numeric id. */
const COMPOSITE_ID: Partial<Record<GoogleReadKind, true>> = { keyword: true, ad: true };
const MULTI_ROW: Partial<Record<GoogleReadKind, true>> = { ad_group_keywords: true, campaign_negative_keywords: true, campaign_brand: true, campaign_conversion_goals: true };
const KEYWORD_FIELDS = 'ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.negative, ad_group_criterion.ad_group';
const GAQL: Record<GoogleReadKind, string> = {
  campaign_conversion_goal: 'SELECT campaign.name, campaign_conversion_goal.resource_name, campaign_conversion_goal.campaign, campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable FROM campaign_conversion_goal WHERE campaign_conversion_goal.resource_name = ',
  budget: 'SELECT campaign_budget.resource_name, campaign_budget.name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count, campaign_budget.status FROM campaign_budget WHERE campaign_budget.resource_name = ',
  campaign: 'SELECT campaign.resource_name, campaign.name, campaign.status, campaign.campaign_budget, campaign.advertising_channel_type, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network FROM campaign WHERE campaign.resource_name = ',
  campaign_conversion_goals: 'SELECT campaign.name, campaign_conversion_goal.resource_name, campaign_conversion_goal.campaign, campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable FROM campaign_conversion_goal WHERE campaign_conversion_goal.campaign = ',
  ad_group: 'SELECT ad_group.resource_name, ad_group.name, ad_group.status, ad_group.campaign, ad_group.cpc_bid_micros FROM ad_group WHERE ad_group.resource_name = ',
  keyword: `SELECT ${KEYWORD_FIELDS} FROM ad_group_criterion WHERE ad_group_criterion.resource_name = `,
  ad: 'SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad_group, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions FROM ad_group_ad WHERE ad_group_ad.resource_name = ',
  asset: 'SELECT asset.resource_name, asset.name, asset.type, asset.text_asset.text FROM asset WHERE asset.resource_name = ',
  asset_group: 'SELECT asset_group.resource_name, asset_group.name, asset_group.status, asset_group.campaign, asset_group.final_urls FROM asset_group WHERE asset_group.resource_name = ',
  ad_group_keywords: `SELECT ${KEYWORD_FIELDS} FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED' AND ad_group_criterion.ad_group = `,
  campaign_negative_keywords: 'SELECT campaign_criterion.resource_name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type, campaign_criterion.negative, campaign_criterion.campaign FROM campaign_criterion WHERE campaign_criterion.type = \'KEYWORD\' AND campaign_criterion.negative = TRUE AND campaign_criterion.status != \'REMOVED\' AND campaign_criterion.campaign = ',
  campaign_brand: 'SELECT campaign_asset.resource_name, campaign_asset.field_type, campaign_asset.asset, asset.text_asset.text FROM campaign_asset WHERE campaign_asset.status != \'REMOVED\' AND campaign_asset.field_type IN (\'BUSINESS_NAME\', \'LOGO\') AND campaign_asset.campaign = ',
};

/** Resource names are only accepted inside the resolved customer (also keeps GAQL injection-free). */
export function isCustomerResource(customerId: string, kind: GoogleReadKind, value: unknown): value is string {
  if (!/^\d+$/.test(customerId)) return false;
  if (kind === 'campaign_conversion_goal') return typeof value === 'string' && new RegExp(`^customers/${customerId}/campaignConversionGoals/\\d+~[A-Z][A-Z_]*~[A-Z][A-Z_]*$`).test(value);
  const id = COMPOSITE_ID[kind] ? '\\d+~\\d+' : '\\d+';
  return typeof value === 'string' && new RegExp(`^customers/${customerId}/${RESOURCE[kind]}/${id}$`).test(value);
}

export function mapGoogleReadRow(kind: GoogleReadKind, row: any): any | null {
  if (!row) return null;
  if (kind === 'campaign_conversion_goal' || kind === 'campaign_conversion_goals') {
    const g = row.campaignConversionGoal;
    // ENG-2995: Google Ads REST (proto3 JSON) omits `false` booleans, so a non-biddable goal
    // arrives with no `biddable` field. The query selects it, so absent means false.
    if (!g?.resourceName || (g.biddable !== undefined && typeof g.biddable !== 'boolean')) return null;
    return { resourceName: g.resourceName, campaign: g.campaign, name: row.campaign?.name, category: g.category, origin: g.origin, biddable: g.biddable === true };
  }
  if (kind === 'budget') {
    const b = row.campaignBudget;
    if (!b?.resourceName) return null;
    return {
      resourceName: b.resourceName, name: b.name, amountMicros: Number(b.amountMicros),
      explicitlyShared: b.explicitlyShared === true, referenceCount: Number(b.referenceCount ?? 0), status: b.status,
    } as GoogleBudgetState;
  }
  if (kind === 'campaign') {
    const c = row.campaign;
    return c?.resourceName ? ({
      resourceName: c.resourceName, name: c.name, status: c.status, budget: c.campaignBudget, channelType: c.advertisingChannelType,
      searchPartners: c.networkSettings?.targetSearchNetwork === true, displayNetwork: c.networkSettings?.targetContentNetwork === true,
    } as GoogleCampaignState) : null;
  }
  if (kind === 'keyword' || kind === 'ad_group_keywords') {
    const k = row.adGroupCriterion;
    return k?.resourceName && k.keyword?.text
      ? ({ resourceName: k.resourceName, text: k.keyword.text, matchType: k.keyword.matchType, status: k.status, negative: k.negative === true, adGroup: k.adGroup } as GoogleKeywordState) : null;
  }
  if (kind === 'campaign_negative_keywords') {
    const k = row.campaignCriterion;
    return k?.resourceName && k.keyword?.text
      ? ({ resourceName: k.resourceName, text: k.keyword.text, matchType: k.keyword.matchType, negative: k.negative === true } as GoogleKeywordState) : null;
  }
  if (kind === 'ad') {
    const a = row.adGroupAd;
    return a?.resourceName ? ({ resourceName: a.resourceName, status: a.status, type: a.ad?.type, adGroup: a.adGroup, finalUrls: a.ad?.finalUrls,
      headlines: a.ad?.responsiveSearchAd?.headlines?.map((h: any) => h.text), descriptions: a.ad?.responsiveSearchAd?.descriptions?.map((d: any) => d.text) } as GoogleAdState) : null;
  }
  if (kind === 'asset') {
    const a = row.asset;
    return a?.resourceName && a.type ? ({ resourceName: a.resourceName, name: a.name, type: a.type, text: a.textAsset?.text } as GoogleAssetState) : null;
  }
  if (kind === 'asset_group') {
    const g = row.assetGroup;
    return g?.resourceName ? ({ resourceName: g.resourceName, name: g.name, status: g.status, campaign: g.campaign, finalUrls: g.finalUrls } as GoogleAssetGroupState) : null;
  }
  const g = row.adGroup;
  return g?.resourceName ? ({
    resourceName: g.resourceName, name: g.name, status: g.status, campaign: g.campaign,
    ...(g.cpcBidMicros !== undefined && g.cpcBidMicros !== null ? { cpcBidMicros: Number(g.cpcBidMicros) } : {}),
  } as GoogleAdGroupState) : null;
}

/** Multi-row reads: keyword lists, and a campaign's brand (business name + logos). */
export function mapGoogleReadRows(kind: GoogleReadKind, rows: any[]): any {
  if (kind === 'campaign_brand') {
    const brand: GoogleCampaignBrand = { logoAssets: [] };
    for (const r of rows) {
      if (r?.campaignAsset?.fieldType === 'BUSINESS_NAME' && r.asset?.textAsset?.text) brand.businessName = r.asset.textAsset.text;
      if (r?.campaignAsset?.fieldType === 'LOGO' && r.campaignAsset.asset) brand.logoAssets.push(r.campaignAsset.asset);
    }
    return brand;
  }
  return rows.map((r) => mapGoogleReadRow(kind, r)).filter(Boolean);
}

// Loaded lazily: the Google service stack is not imported unless a Google write runs.
const defaultDeps: GoogleToolkitWriteDeps = {
  assertReady: (userId) => assertZomaWriteReady(userId, undefined, 'google_ads'),
  read: async (userId, customerId, kind, resourceName) => {
    if (!isCustomerResource(customerId, kind, resourceName)) return null;
    const { googleAdsService } = await import('../services/googleAdsService');
    const rows = await googleAdsService.queryReporting(userId, customerId, `${GAQL[kind]}'${resourceName}'`);
    if (MULTI_ROW[kind]) return mapGoogleReadRows(kind, rows);
    return rows.length === 1 ? mapGoogleReadRow(kind, rows[0]) : null;
  },
  dispatch: async (userId, args) => (await import('../emma/googleAdsTools')).callGoogleAdsApiTool.execute(args, { userId }),
  spendCeilingPolicy: () => googleSpendCeilingPolicyFromEnv(),
  secret: () => getJwtSecret(),
  now: () => Date.now(),
  consumedTokens: defaultConsumedTokenStore,
};

/** CAMPAIGN CREATE preview: the strategy with its target and CPC cap, in the account currency. */
function biddingLabel(args: any, currency: string): string {
  if (args.bidding_strategy_resource_name) return `portfolio strategy ${args.bidding_strategy_resource_name}`;
  const s = String(args.bidding_strategy);
  const t = args.bidding_strategy_target;
  const money = (major: number) => formatMicros(Math.round(major * 1_000_000), currency);
  const parts: string[] = [];
  if (t !== undefined && (s === 'MAXIMIZE_CONVERSIONS' || s === 'TARGET_CPA')) parts.push(`target CPA ${money(Number(t))}`);
  if (t !== undefined && (s === 'MAXIMIZE_CONVERSION_VALUE' || s === 'TARGET_ROAS')) parts.push(`target ROAS ${t} (${Math.round(Number(t) * 100)}%)`);
  if (s === 'TARGET_IMPRESSION_SHARE') parts.push(`${Math.round(Number(t ?? 1) * 100)}% impression share`);
  if (args.cpc_bid_ceiling !== undefined) parts.push(`max CPC cap ${money(Number(args.cpc_bid_ceiling))}`);
  else if (s === 'TARGET_IMPRESSION_SHARE') parts.push(`max CPC cap ${money(100)} (default)`);
  else if (s === 'TARGET_SPEND') parts.push('no max CPC cap');
  return `${s}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Major units → micros at the currency's precision. Refuses (never rounds) extra precision. */
export function majorToMicros(amount: unknown, currency: string, field: string): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new MetaToolkitRefusal(`${field} must be a non-negative number in major units of ${currency} (e.g. 50 = 50.00 ${currency}).`);
  }
  const digits = currencyDigits(currency);
  const minor = Math.round(amount * 10 ** digits);
  if (Math.abs(minor / 10 ** digits - amount) > 1e-9) {
    throw new MetaToolkitRefusal(`${field} ${amount} has more decimals than ${currency} allows (${digits}). Nothing was sent.`);
  }
  const micros = minor * 10 ** (6 - digits);
  // A huge amount must not reach Google as an imprecise float / "1e+21" (Hardening, ENG-2823).
  if (!Number.isSafeInteger(micros)) throw new MetaToolkitRefusal(`${field} ${amount} is too large. Nothing was sent.`);
  return micros;
}

const positiveMicros = (amount: unknown, currency: string, field: string): number => {
  const micros = majorToMicros(amount, currency, field);
  if (micros <= 0) throw new MetaToolkitRefusal(`${field} must be greater than 0.`);
  return micros;
};

export function formatMicros(micros: number, currency: string): string {
  const digits = currencyDigits(currency);
  return `${(micros / 1e6).toFixed(digits)} ${currency}`;
}

export interface ToolkitKeyword { text: string; matchType: 'BROAD' | 'PHRASE' | 'EXACT' }

interface ValidatedWrite {
  /** Exactly what call_google_ads_api receives (internal micros field names). */
  dispatchArgs: Record<string, unknown>;
  /** The existing object an UPDATE / REMOVE changes (read before and after). */
  target?: { kind: GoogleReadKind; resourceName: string };
  /** CREATE / ADD: the existing object the new one is added to (read for the preview). */
  parent?: { kind: GoogleReadKind; resourceName: string };
  budgetMicros?: number;
  expectedStatus?: 'ENABLED' | 'PAUSED';
  /** ENG-2959: CAMPAIGN / AD_GROUP non-status UPDATE — the values the read-back must show. */
  expectedEdit?: { name?: string; cpcBidMicros?: number; searchPartners?: boolean; displayNetwork?: boolean };
  /** ENG-2979: AD UPDATE responsive search ad content — the values the read-back must show. */
  expectedAdContent?: { headlines?: string[]; descriptions?: string[]; finalUrl?: string };
  /** KEYWORD ADD / ADD_NEGATIVE: what the read-back of the parent's keyword list must contain. */
  keywords?: ToolkitKeyword[];
  /** Keyword list read before (duplicates) and after (read-back) the write. */
  keywordList?: { kind: 'ad_group_keywords' | 'campaign_negative_keywords'; resourceName: string; negative: boolean };
  /** ASSET UPLOAD: non-spending, so no preview token. */
  direct?: boolean;
}

/** Google Ads text limits (characters). */
export const GOOGLE_TEXT_LIMITS = {
  rsaHeadlines: { min: 3, max: 15, chars: 30 },
  rsaDescriptions: { min: 2, max: 4, chars: 90 },
  pmaxHeadlines: { min: 3, max: 15, chars: 30 },
  pmaxLongHeadlines: { min: 1, max: 5, chars: 90 },
  pmaxDescriptions: { min: 2, max: 5, chars: 90 },
  businessName: 25,
  keyword: 80,
  keywordWords: 10,
  keywordsPerCall: 100,
  textAsset: 90,
} as const;
const MATCH_TYPES = ['BROAD', 'PHRASE', 'EXACT'];

const COMMON = ['customer_id', 'entity_type', 'action'];
const ALLOWED: Record<string, string[]> = {
  'CAMPAIGN_CONVERSION_GOAL UPDATE': ['resource_name', 'biddable'],
  'BUDGET CREATE': ['name', 'amount', 'explicitly_shared'],
  'BUDGET UPDATE': ['budget_resource_name', 'amount'],
  'CAMPAIGN CREATE': ['name', 'type', 'budget_resource_name', 'bidding_strategy', 'bidding_strategy_resource_name', 'bidding_strategy_target', 'cpc_bid_ceiling', 'location_target_ids', 'status', 'brand_business_name', 'brand_logo_asset_resource_name', 'target_search_network', 'target_content_network'],
  'CAMPAIGN UPDATE': ['campaign_resource_name', 'status', 'name', 'target_search_network', 'target_content_network'],
  'AD_GROUP CREATE': ['name', 'campaign_resource_name', 'type', 'cpc_bid', 'status'],
  'AD_GROUP UPDATE': ['ad_group_resource_name', 'status', 'name', 'cpc_bid'],
  'KEYWORD ADD': ['ad_group_resource_name', 'keywords', 'status'],
  'KEYWORD UPDATE': ['criterion_resource_name', 'status'],
  'KEYWORD REMOVE': ['criterion_resource_name'],
  'KEYWORD ADD_NEGATIVE': ['keywords', 'ad_group_resource_name', 'campaign_resource_name'],
  'AD CREATE': ['ad_group_resource_name', 'type', 'headlines', 'descriptions', 'final_url', 'status'],
  'AD UPDATE': ['ad_resource_name', 'status', 'headlines', 'descriptions', 'final_url'],
  'ASSET UPLOAD': ['asset_type', 'name', 'data'],
  'ASSET_GROUP CREATE': ['name', 'campaign_resource_name', 'final_url', 'headlines', 'long_headlines', 'descriptions', 'square_image_assets', 'landscape_image_assets', 'logo_assets', 'video_assets', 'status'],
  'ASSET_GROUP UPDATE': ['asset_group_resource_name', 'status'],
};
const MICROS_HINT: Record<string, string> = { amount_micros: 'amount', cpc_bid_micros: 'cpc_bid', cpc_bid_ceiling_micros: 'cpc_bid_ceiling' };

const nonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
/** Double-width scripts (CJK, Hangul, kana, fullwidth forms) that Google counts as two characters toward ad-text limits. */
const DOUBLE_WIDTH = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u;
/** Characters as Google counts them for these limits: code points, double-width scripts weighted 2. */
const chars = (v: string) => [...v].reduce((n, ch) => n + (DOUBLE_WIDTH.test(ch) ? 2 : 1), 0);
const normalizeKeyword = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
const keywordKey = (k: { text: string; matchType: string }) => `${k.matchType}:${normalizeKeyword(k.text)}`;

/** ENG-2036: every shape check, with no I/O, before credentials or Google are touched. */
export function validateGoogleWriteShape(args: any, currency: string): ValidatedWrite {
  const entity = String(args.entity_type);
  const action = String(args.action);
  const op = `${entity} ${action}`;
  const cid = String(args.customer_id ?? '');
  if (!/^\d+$/.test(cid)) throw new MetaToolkitRefusal('customer_id must be the numeric Google Ads customer id.');
  const allowed = ALLOWED[op];
  if (!allowed) throw new MetaToolkitRefusal(`${op} is not part of the Google Ads toolkit surface.`);

  const keys = Object.keys(args).filter((k) => args[k] !== undefined && !COMMON.includes(k));
  for (const key of keys) {
    if (MICROS_HINT[key]) throw new MetaToolkitRefusal(`${key} is not accepted by the Google Ads toolkit; pass ${MICROS_HINT[key]} in major units of ${currency} (it is converted to micros and echoed in the preview).`);
  }
  const extra = keys.filter((k) => !allowed.includes(k));
  if (extra.length) throw new MetaToolkitRefusal(`${op} via the Google Ads toolkit accepts only: ${allowed.join(', ')}. Not allowed: ${extra.join(', ')}.`);

  const base = { customer_id: cid, entity_type: entity, action };
  const need = (cond: unknown, message: string) => {
    if (!cond) throw new MetaToolkitRefusal(message);
  };
  const resource = (kind: GoogleReadKind, field: string) => {
    need(isCustomerResource(cid, kind, args[field]), `${field} must be a ${RESOURCE[kind]} resource name in customer ${cid} (customers/${cid}/${RESOURCE[kind]}/<id>).`);
    return args[field] as string;
  };
  const createdPaused = () => {
    if (args.status !== undefined && args.status !== 'PAUSED') {
      throw new MetaToolkitRefusal('New campaigns, ad groups, keywords, ads and asset groups are always created PAUSED. Create it paused first, then enable it with a separate UPDATE status=ENABLED preview and approval.');
    }
  };
  const texts = (field: string, limits: { min: number; max: number; chars: number }): string[] => {
    const v = args[field];
    need(Array.isArray(v) && v.length >= limits.min && v.length <= limits.max && v.every(nonBlank),
      `${field} must be ${limits.min}-${limits.max} non-empty strings.`);
    const tooLong = (v as string[]).filter((t) => chars(t) > limits.chars);
    need(!tooLong.length, `${field} must be at most ${limits.chars} characters each. Too long: ${tooLong.map((t) => `"${t}" (${chars(t)})`).join(', ')}.`);
    const seen = new Set<string>();
    for (const t of v as string[]) {
      const key = t.trim().toLowerCase();
      need(!seen.has(key), `${field} contains a duplicate: "${t}". Google rejects duplicate text assets.`);
      seen.add(key);
    }
    return v as string[];
  };
  const assets = (field: string, min: number, max: number): string[] => {
    const v = args[field] ?? [];
    need(Array.isArray(v) && v.length >= min && v.length <= max && v.every((a: unknown) => isCustomerResource(cid, 'asset', a)),
      `${field} must be ${min}-${max} asset resource names in customer ${cid} (customers/${cid}/assets/<id>, from ASSET UPLOAD).`);
    return v as string[];
  };
  const httpsUrl = (field: string): string => {
    let url: URL | null = null;
    try {
      url = nonBlank(args[field]) ? new URL(args[field]) : null;
    } catch {
      url = null;
    }
    need(url && url.protocol === 'https:' && !url.username && !url.password, `${field} must be an https URL.`);
    return args[field] as string;
  };
  const keywordList = (): ToolkitKeyword[] => {
    const v = args.keywords;
    need(Array.isArray(v) && v.length >= 1 && v.length <= GOOGLE_TEXT_LIMITS.keywordsPerCall,
      `keywords must be 1-${GOOGLE_TEXT_LIMITS.keywordsPerCall} items of {text, matchType}.`);
    const seen = new Set<string>();
    return (v as any[]).map((k) => {
      need(k && typeof k === 'object' && !Array.isArray(k) && Object.keys(k).every((key) => key === 'text' || key === 'matchType'),
        'Each keyword is {text, matchType} only.');
      need(nonBlank(k.text) && chars(k.text) <= GOOGLE_TEXT_LIMITS.keyword && k.text.trim().split(/\s+/).length <= GOOGLE_TEXT_LIMITS.keywordWords,
        `Keyword text must be non-empty, at most ${GOOGLE_TEXT_LIMITS.keyword} characters and ${GOOGLE_TEXT_LIMITS.keywordWords} words: "${String(k.text)}".`);
      need(MATCH_TYPES.includes(k.matchType), `matchType must be BROAD, PHRASE or EXACT ("${String(k.text)}").`);
      const key = keywordKey(k);
      need(!seen.has(key), `Duplicate keyword in this call: ${k.matchType} "${k.text}".`);
      seen.add(key);
      return { text: k.text, matchType: k.matchType };
    });
  };
  const statusOnly = (kind: GoogleReadKind, field: string): ValidatedWrite => {
    const rn = resource(kind, field);
    need(args.status === 'ENABLED' || args.status === 'PAUSED', 'status must be ENABLED or PAUSED.');
    return { dispatchArgs: { ...base, [field]: rn, status: args.status }, target: { kind, resourceName: rn }, expectedStatus: args.status };
  };
  /** ENG-2959: CAMPAIGN UPDATE (status | name) and AD_GROUP UPDATE (status | name and/or cpc_bid). */
  const statusOrEdit = (kind: 'campaign' | 'ad_group', field: string): ValidatedWrite => {
    const edits = kind === 'campaign' ? ['name', 'target_search_network', 'target_content_network'] : ['name', 'cpc_bid'];
    const present = edits.filter((k) => args[k] !== undefined);
    if (args.status !== undefined) {
      need(!present.length, `status must be sent alone. Change ${present.join(' / ')} in a separate ${op} preview and approval.`);
      return statusOnly(kind, field);
    }
    need(present.length > 0, `${op} requires status${kind === 'campaign' ? ', name, target_search_network or target_content_network' : ', name or cpc_bid'}.`);
    const rn = resource(kind, field);
    const dispatchArgs: Record<string, unknown> = { ...base, [field]: rn };
    const expectedEdit: NonNullable<ValidatedWrite['expectedEdit']> = {};
    for (const key of ['target_search_network', 'target_content_network'] as const) {
      if (args[key] === undefined) continue;
      need(typeof args[key] === 'boolean', `${key} must be true or false.`);
      dispatchArgs[key] = args[key];
      if (key === 'target_search_network') expectedEdit.searchPartners = args[key];
      else expectedEdit.displayNetwork = args[key];
    }
    if (args.name !== undefined) {
      need(nonBlank(args.name) && chars(args.name.trim()) <= 255, 'name must be a non-empty string of at most 255 characters.');
      dispatchArgs.name = expectedEdit.name = (args.name as string).trim();
    }
    if (args.cpc_bid !== undefined) dispatchArgs.cpc_bid_micros = expectedEdit.cpcBidMicros = positiveMicros(args.cpc_bid, currency, 'cpc_bid');
    return { dispatchArgs, target: { kind, resourceName: rn }, expectedEdit };
  };

  switch (op) {
    case 'CAMPAIGN_CONVERSION_GOAL UPDATE': {
      const rn = resource('campaign_conversion_goal', 'resource_name');
      need(typeof args.biddable === 'boolean', 'biddable must be true or false.');
      return { dispatchArgs: { ...base, resource_name: rn, biddable: args.biddable }, target: { kind: 'campaign_conversion_goal', resourceName: rn } };
    }
    case 'BUDGET CREATE': {
      need(nonBlank(args.name), 'BUDGET CREATE requires name.');
      need(args.explicitly_shared === undefined || typeof args.explicitly_shared === 'boolean', 'explicitly_shared must be true or false.');
      const micros = positiveMicros(args.amount, currency, 'amount');
      return {
        dispatchArgs: { ...base, name: args.name, amount_micros: micros, explicitly_shared: args.explicitly_shared === true },
        budgetMicros: micros,
      };
    }
    case 'BUDGET UPDATE': {
      const rn = resource('budget', 'budget_resource_name');
      const micros = positiveMicros(args.amount, currency, 'amount');
      return { dispatchArgs: { ...base, budget_resource_name: rn, amount_micros: micros }, target: { kind: 'budget', resourceName: rn }, budgetMicros: micros };
    }
    case 'CAMPAIGN CREATE': {
      createdPaused();
      need(nonBlank(args.name), 'CAMPAIGN CREATE requires name.');
      // Display is not offered: Zoma cannot create Display ads, so a Display campaign could never serve.
      need(['SEARCH', 'PERFORMANCE_MAX'].includes(args.type), 'type must be SEARCH or PERFORMANCE_MAX (Display campaigns are not available in Zoma).');
      for (const key of ['target_search_network', 'target_content_network']) {
        need(args[key] === undefined || (args.type === 'SEARCH' && typeof args[key] === 'boolean'), `${key} applies to SEARCH campaigns only and must be true or false.`);
      }
      // Performance Max requires its brand (business name + logo) at the campaign level, created
      // atomically with the campaign — without them the campaign can never serve (ENG-2928).
      if (args.type === 'PERFORMANCE_MAX') {
        need(nonBlank(args.brand_business_name) && chars(args.brand_business_name) <= GOOGLE_TEXT_LIMITS.businessName,
          `PERFORMANCE_MAX requires brand_business_name (at most ${GOOGLE_TEXT_LIMITS.businessName} characters).`);
        need(isCustomerResource(cid, 'asset', args.brand_logo_asset_resource_name),
          `PERFORMANCE_MAX requires brand_logo_asset_resource_name: a square logo image asset in customer ${cid} (ASSET UPLOAD asset_type=LOGO first).`);
      } else {
        need(args.brand_business_name === undefined && args.brand_logo_asset_resource_name === undefined,
          'brand_business_name / brand_logo_asset_resource_name apply to PERFORMANCE_MAX campaigns only.');
      }
      const budget = resource('budget', 'budget_resource_name');
      need(!!args.bidding_strategy !== !!args.bidding_strategy_resource_name, 'Pass exactly one of bidding_strategy (standard) or bidding_strategy_resource_name (portfolio).');
      if (args.bidding_strategy_resource_name !== undefined) {
        need(typeof args.bidding_strategy_resource_name === 'string' && new RegExp(`^customers/${cid}/biddingStrategies/\\d+$`).test(args.bidding_strategy_resource_name),
          `bidding_strategy_resource_name must be in customer ${cid}.`);
      }
      need(args.location_target_ids === undefined || (Array.isArray(args.location_target_ids) && args.location_target_ids.every((n: unknown) => Number.isSafeInteger(n))),
        'location_target_ids must be an array of numeric location ids (from LOCATION SEARCH).');
      return {
        dispatchArgs: {
          ...base, name: args.name, type: args.type, budget_resource_name: budget,
          bidding_strategy: args.bidding_strategy, bidding_strategy_resource_name: args.bidding_strategy_resource_name,
          bidding_strategy_target: args.bidding_strategy_target,
          cpc_bid_ceiling_micros: args.cpc_bid_ceiling === undefined ? undefined : positiveMicros(args.cpc_bid_ceiling, currency, 'cpc_bid_ceiling'),
          location_target_ids: args.location_target_ids, status: 'PAUSED',
          brand_business_name: args.brand_business_name, brand_logo_asset_resource_name: args.brand_logo_asset_resource_name,
          // Search campaigns are Google Search only unless the caller opts in: Google's own create
          // default also serves on search partners and the Display Network.
          ...(args.type === 'SEARCH' ? {
            target_google_search: true,
            target_search_network: args.target_search_network === true,
            target_content_network: args.target_content_network === true,
          } : {}),
        },
        expectedStatus: 'PAUSED',
      };
    }
    case 'CAMPAIGN UPDATE':
      return statusOrEdit('campaign', 'campaign_resource_name');
    case 'AD_GROUP CREATE': {
      createdPaused();
      need(nonBlank(args.name), 'AD_GROUP CREATE requires name.');
      need(args.type === 'SEARCH_STANDARD', 'type must be SEARCH_STANDARD (Display ad groups are not available in Zoma).');
      const campaign = resource('campaign', 'campaign_resource_name');
      return {
        dispatchArgs: {
          ...base, name: args.name, campaign_resource_name: campaign, type: args.type,
          cpc_bid_micros: args.cpc_bid === undefined ? undefined : positiveMicros(args.cpc_bid, currency, 'cpc_bid'), status: 'PAUSED',
        },
        expectedStatus: 'PAUSED',
      };
    }
    case 'KEYWORD ADD': {
      createdPaused();
      const adGroup = resource('ad_group', 'ad_group_resource_name');
      const keywords = keywordList();
      return {
        dispatchArgs: { ...base, ad_group_resource_name: adGroup, keywords, status: 'PAUSED' },
        parent: { kind: 'ad_group', resourceName: adGroup },
        expectedStatus: 'PAUSED',
        keywords,
        keywordList: { kind: 'ad_group_keywords', resourceName: adGroup, negative: false },
      };
    }
    case 'KEYWORD UPDATE':
      return statusOnly('keyword', 'criterion_resource_name');
    case 'KEYWORD REMOVE': {
      const rn = resource('keyword', 'criterion_resource_name');
      return { dispatchArgs: { ...base, criterion_resource_name: rn }, target: { kind: 'keyword', resourceName: rn } };
    }
    case 'KEYWORD ADD_NEGATIVE': {
      need((args.ad_group_resource_name === undefined) !== (args.campaign_resource_name === undefined),
        'Pass exactly one of ad_group_resource_name (ad group level) or campaign_resource_name (campaign level).');
      const level = args.campaign_resource_name !== undefined ? 'campaign' : 'ad_group';
      const field = level === 'campaign' ? 'campaign_resource_name' : 'ad_group_resource_name';
      const rn = resource(level, field);
      const keywords = keywordList();
      return {
        dispatchArgs: { ...base, [field]: rn, keywords },
        parent: { kind: level, resourceName: rn },
        keywords,
        keywordList: { kind: level === 'campaign' ? 'campaign_negative_keywords' : 'ad_group_keywords', resourceName: rn, negative: true },
      };
    }
    case 'AD CREATE': {
      createdPaused();
      need(args.type === undefined || args.type === 'RESPONSIVE_SEARCH_AD', 'The Google Ads toolkit creates RESPONSIVE_SEARCH_AD ads only (type may be omitted).');
      const adGroup = resource('ad_group', 'ad_group_resource_name');
      return {
        dispatchArgs: {
          ...base, ad_group_resource_name: adGroup, type: 'RESPONSIVE_SEARCH_AD',
          headlines: texts('headlines', GOOGLE_TEXT_LIMITS.rsaHeadlines),
          descriptions: texts('descriptions', GOOGLE_TEXT_LIMITS.rsaDescriptions),
          final_url: httpsUrl('final_url'), status: 'PAUSED',
        },
        parent: { kind: 'ad_group', resourceName: adGroup },
        expectedStatus: 'PAUSED',
      };
    }
    case 'AD UPDATE': {
      // ENG-2979: status | responsive search ad content (headlines / descriptions / final_url).
      const present = ['headlines', 'descriptions', 'final_url'].filter((k) => args[k] !== undefined);
      if (args.status !== undefined) {
        need(!present.length, `status must be sent alone. Change ${present.join(' / ')} in a separate AD UPDATE preview and approval.`);
        return statusOnly('ad', 'ad_resource_name');
      }
      need(present.length > 0, 'AD UPDATE requires status, or headlines / descriptions / final_url (responsive search ads only).');
      const rn = resource('ad', 'ad_resource_name');
      const dispatchArgs: Record<string, unknown> = { ...base, ad_resource_name: rn };
      const expectedAdContent: NonNullable<ValidatedWrite['expectedAdContent']> = {};
      if (args.headlines !== undefined) dispatchArgs.headlines = expectedAdContent.headlines = texts('headlines', GOOGLE_TEXT_LIMITS.rsaHeadlines);
      if (args.descriptions !== undefined) dispatchArgs.descriptions = expectedAdContent.descriptions = texts('descriptions', GOOGLE_TEXT_LIMITS.rsaDescriptions);
      if (args.final_url !== undefined) dispatchArgs.final_url = expectedAdContent.finalUrl = httpsUrl('final_url');
      return { dispatchArgs, target: { kind: 'ad', resourceName: rn }, expectedAdContent };
    }
    case 'ASSET UPLOAD': {
      need(['IMAGE', 'LOGO', 'TEXT', 'VIDEO'].includes(args.asset_type), 'asset_type must be IMAGE, LOGO, TEXT or VIDEO.');
      need(nonBlank(args.data), 'data is required: an https image URL or zoma_prepare_upload file_url (IMAGE/LOGO), the text (TEXT), or a YouTube video id (VIDEO).');
      if (args.asset_type === 'TEXT') {
        need(chars(args.data) <= GOOGLE_TEXT_LIMITS.textAsset, `A TEXT asset is at most ${GOOGLE_TEXT_LIMITS.textAsset} characters.`);
      } else {
        need(nonBlank(args.name), `ASSET UPLOAD ${args.asset_type} requires name.`);
      }
      if (args.asset_type === 'VIDEO') need(/^[A-Za-z0-9_-]{11}$/.test(args.data), 'VIDEO data must be the 11-character YouTube video id.');
      return {
        dispatchArgs: { ...base, asset_type: args.asset_type, name: nonBlank(args.name) ? args.name : String(args.data).slice(0, 50), data: args.data },
        direct: true,
      };
    }
    case 'ASSET_GROUP CREATE': {
      createdPaused();
      need(nonBlank(args.name), 'ASSET_GROUP CREATE requires name.');
      const campaign = resource('campaign', 'campaign_resource_name');
      const descriptions = texts('descriptions', GOOGLE_TEXT_LIMITS.pmaxDescriptions);
      need(descriptions.some((d) => chars(d) <= 60), 'Performance Max needs at least one description of 60 characters or fewer.');
      return {
        dispatchArgs: {
          ...base, name: args.name, campaign_resource_name: campaign, final_url: httpsUrl('final_url'),
          headlines: texts('headlines', GOOGLE_TEXT_LIMITS.pmaxHeadlines),
          long_headlines: texts('long_headlines', GOOGLE_TEXT_LIMITS.pmaxLongHeadlines),
          descriptions,
          square_image_assets: assets('square_image_assets', 1, 20),
          landscape_image_assets: assets('landscape_image_assets', 1, 20),
          logo_assets: assets('logo_assets', 0, 5),
          video_assets: args.video_assets === undefined ? undefined : assets('video_assets', 0, 5),
        },
        parent: { kind: 'campaign', resourceName: campaign },
        expectedStatus: 'PAUSED',
      };
    }
    case 'ASSET_GROUP UPDATE':
      return statusOnly('asset_group', 'asset_group_resource_name');
    default:
      return statusOrEdit('ad_group', 'ad_group_resource_name');
  }
}


const CREATED: Record<string, { kind: GoogleReadKind; field: string }> = {
  BUDGET: { kind: 'budget', field: 'budgetResourceName' },
  CAMPAIGN: { kind: 'campaign', field: 'campaignResourceName' },
  AD_GROUP: { kind: 'ad_group', field: 'adGroupResourceName' },
  AD: { kind: 'ad', field: 'adResourceName' },
  ASSET_GROUP: { kind: 'asset_group', field: 'assetGroupResourceName' },
  ASSET: { kind: 'asset', field: 'assetResourceName' },
};
const NOUN: Partial<Record<GoogleReadKind, string>> = {
  campaign: 'campaign', ad_group: 'ad group', keyword: 'keyword', ad: 'ad', asset_group: 'asset group',
};
const PLURAL: Record<string, string> = {
  BUDGET: 'budgets', CAMPAIGN: 'campaigns', AD_GROUP: 'ad groups', KEYWORD: 'keywords', AD: 'ads', ASSET_GROUP: 'asset groups', ASSET: 'assets',
};
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const keywordLabel = (k: { text: string; matchType: string }) => `${k.matchType} "${k.text}"`;

/** CONFIRMED only when every requested keyword is in the read-back list with the expected shape. */
function verifyKeywords(validated: ValidatedWrite, list: unknown): { verification: WriteVerification; ids: string[] } {
  if (!Array.isArray(list)) return { verification: 'UNCONFIRMED', ids: [] };
  const negative = validated.keywordList!.negative;
  const byKey = new Map<string, GoogleKeywordState>();
  for (const k of list as GoogleKeywordState[]) if (k.negative === negative) byKey.set(keywordKey(k), k);
  const ids: string[] = [];
  let ok = true;
  for (const k of validated.keywords!) {
    const found = byKey.get(keywordKey(k));
    if (!found || (validated.expectedStatus && found.status !== validated.expectedStatus)) ok = false;
    if (found) ids.push(found.resourceName);
  }
  return { verification: ok ? 'CONFIRMED' : 'MISMATCH', ids };
}

function verify(validated: ValidatedWrite, entity: string, readBack: any | null): WriteVerification {
  if (!readBack) return 'UNCONFIRMED';
  if (entity === 'CAMPAIGN_CONVERSION_GOAL') {
    if (typeof readBack.biddable !== 'boolean') return 'UNCONFIRMED';
    return readBack.biddable === validated.dispatchArgs.biddable ? 'CONFIRMED' : 'MISMATCH';
  }
  if (entity === 'BUDGET') {
    if (!Number.isFinite(readBack.amountMicros)) return 'UNCONFIRMED';
    if (readBack.amountMicros !== validated.budgetMicros) return 'MISMATCH';
    const shared = validated.dispatchArgs.explicitly_shared;
    if (shared !== undefined && readBack.explicitlyShared !== shared) return 'MISMATCH';
    return 'CONFIRMED';
  }
  if (validated.expectedAdContent) {
    const e = validated.expectedAdContent;
    const same = (a: unknown, b: string[]) => Array.isArray(a) && JSON.stringify(a) === JSON.stringify(b);
    if (readBack.type !== 'RESPONSIVE_SEARCH_AD') return 'MISMATCH';
    if (e.headlines && !Array.isArray(readBack.headlines)) return 'UNCONFIRMED';
    if (e.descriptions && !Array.isArray(readBack.descriptions)) return 'UNCONFIRMED';
    if (e.finalUrl !== undefined && !Array.isArray(readBack.finalUrls)) return 'UNCONFIRMED';
    if (e.headlines && !same(readBack.headlines, e.headlines)) return 'MISMATCH';
    if (e.descriptions && !same(readBack.descriptions, e.descriptions)) return 'MISMATCH';
    if (e.finalUrl !== undefined && !same(readBack.finalUrls, [e.finalUrl])) return 'MISMATCH';
    return 'CONFIRMED';
  }
  if (validated.expectedEdit) {
    const e = validated.expectedEdit;
    if (e.name !== undefined && readBack.name !== e.name) return 'MISMATCH';
    if (e.searchPartners !== undefined && (readBack.searchPartners === true) !== e.searchPartners) return 'MISMATCH';
    if (e.displayNetwork !== undefined && (readBack.displayNetwork === true) !== e.displayNetwork) return 'MISMATCH';
    if (e.cpcBidMicros !== undefined) {
      if (!Number.isFinite(readBack.cpcBidMicros)) return 'UNCONFIRMED';
      if (readBack.cpcBidMicros !== e.cpcBidMicros) return 'MISMATCH';
    }
    return 'CONFIRMED';
  }
  if (readBack.status !== validated.expectedStatus) return 'MISMATCH';
  if (entity === 'CAMPAIGN' && validated.dispatchArgs.action === 'CREATE' && validated.dispatchArgs.target_content_network !== undefined) {
    // Google's REST JSON omits false booleans, so an absent setting reads as off.
    if ((readBack.searchPartners === true) !== validated.dispatchArgs.target_search_network) return 'MISMATCH';
    if ((readBack.displayNetwork === true) !== validated.dispatchArgs.target_content_network) return 'MISMATCH';
  }
  if (entity === 'AD' && validated.dispatchArgs.action === 'CREATE' && readBack.type !== 'RESPONSIVE_SEARCH_AD') return 'MISMATCH';
  if (entity === 'ASSET_GROUP' && validated.parent && readBack.campaign !== validated.parent.resourceName) return 'MISMATCH';
  return 'CONFIRMED';
}

/**
 * True when a dispatch may have been applied without a definite answer: no success verdict at
 * all, or a failure with no HTTP status (timeout, network error) or a 5xx. A 4xx, an auth failure, a gate block or a confirmation halt happened
 * before or instead of the mutate, so nothing was applied.
 */
function outcomeUnknown(result: any): boolean {
  if (result?.success !== false && result?.success !== undefined && result?.success !== null) return false;
  if (result?.blocked || result?.awaitingUserConfirmation || result?.authError) return false;
  const code = Number(result?.code);
  return !Number.isInteger(code) || code >= 500;
}

const refuseNotFound = (what: string, rn: string): never => {
  throw new MetaToolkitRefusal(`${what} ${rn} was not found in this Google Ads account. Nothing was sent.`);
};

const failedResult = (result: any) => ({
  status: 'FAILED', success: false,
  message: String(result?.error || result?.message || 'Google Ads did not apply the change.'),
  ...(result?.blocked ? { blocked: true, reason: result.reason } : {}),
});

const dispatchOnce = (deps: GoogleToolkitWriteDeps, userId: string, args: Record<string, unknown>) => deps.dispatch(userId, args)
  .catch((error: unknown) => ({ success: false, error: error instanceof Error ? error.message : String(error) }));

/** A read whose failure is distinguishable from "not found" (needed to prove a REMOVE). */
const readSettled = (deps: GoogleToolkitWriteDeps, userId: string, cid: string, kind: GoogleReadKind, rn: string) => deps.read(userId, cid, kind, rn)
  .then((value) => ({ ok: true as const, value }), () => ({ ok: false as const, value: null }));

/** Where each uploaded asset type is used (ASSET_GROUP CREATE takes headlines and descriptions as plain text). */
const ASSET_USE: Record<string, string> = {
  IMAGE: 'Use it in ASSET_GROUP CREATE square_image_assets or landscape_image_assets.',
  LOGO: 'Use it in ASSET_GROUP CREATE logo_assets or as brand_logo_asset_resource_name on a PERFORMANCE_MAX CAMPAIGN CREATE.',
  VIDEO: 'Use it in ASSET_GROUP CREATE video_assets.',
  TEXT: 'It is stored in the account library; ASSET_GROUP CREATE and AD CREATE take headlines and descriptions as plain text, not asset ids.',
};

/**
 * ASSET UPLOAD (ENG-2928): an asset cannot spend on its own, so there is no preview token —
 * but it is still gated (readiness checked by the caller), URL-checked, dispatched once through
 * the Emma handler, read back and reported CONFIRMED / MISMATCH / UNCONFIRMED (and metered).
 */
async function executeAssetUpload(userId: string, cid: string, validated: ValidatedWrite, deps: GoogleToolkitWriteDeps) {
  const args = { ...validated.dispatchArgs };
  const type = String(args.asset_type);
  if (type === 'IMAGE' || type === 'LOGO') args.data = await (deps.resolveImageUrl ?? resolveZomaImageUrl)(userId, args.data, 'data');
  const result = await dispatchOnce(deps, userId, args);
  if (result?.success !== true && outcomeUnknown(result)) {
    return {
      success: false, verification: 'UNCONFIRMED' as WriteVerification, id: null,
      message: `UNCONFIRMED: the ASSET UPLOAD failed without a definite answer from Google Ads (${String(result?.error ?? 'unknown error')}), so the asset may or may not exist. An asset cannot spend on its own; check before uploading it again to avoid a duplicate.`,
    };
  }
  if (!result?.success) return failedResult(result);
  const id: string | undefined = result.assetResourceName;
  const readBack: GoogleAssetState | null = id && isCustomerResource(cid, 'asset', id) ? await deps.read(userId, cid, 'asset', id).catch(() => null) : null;
  const expectedType = type === 'TEXT' ? 'TEXT' : type === 'VIDEO' ? 'YOUTUBE_VIDEO' : 'IMAGE';
  const verification: WriteVerification = !readBack ? 'UNCONFIRMED'
    : readBack.type !== expectedType || (type === 'TEXT' && readBack.text !== args.data) ? 'MISMATCH' : 'CONFIRMED';
  return {
    success: verification === 'CONFIRMED', verification, id: id ?? null, asset_type: readBack?.type ?? null,
    message: verification === 'CONFIRMED'
      ? `ASSET ${type} confirmed by read-back: ${id}. ${ASSET_USE[type] ?? ''}`.trim()
      : verification === 'MISMATCH'
        ? `Google accepted the upload, but the read-back of ${id} does not match what was sent. Review it before using it.`
        : `UNCONFIRMED: Google accepted the upload${id ? ` (${id})` : ''}, but the read-back could not confirm it. Check the asset before using it or uploading again.`,
  };
}

/**
 * Execute (or preview) one guarded Google Ads write. `args.customer_id` must already be the
 * resolved, ownership-checked customer, and `currency` its account currency (the gateway
 * does both before calling here).
 */
export async function executeGoogleToolkitWrite(
  userId: string,
  rawArgs: any,
  currency: string,
  deps: GoogleToolkitWriteDeps = defaultDeps,
) {
  const { confirm, preview_token: previewToken, ...args } = rawArgs ?? {};
  const entity = String(args.entity_type);
  const action = String(args.action);
  const validated = validateGoogleWriteShape(args, currency);
  const cid = String(validated.dispatchArgs.customer_id);

  try {
    await deps.assertReady(userId);
  } catch (error) {
    if (error instanceof ZomaNotReadyError) throw new MetaToolkitRefusal(error.message);
    throw error;
  }
  if (validated.direct) return executeAssetUpload(userId, cid, validated, deps);

  // State the preview describes (and the token is bound to).
  const lines: string[] = ['PREVIEW — nothing has changed yet.'];
  let state: Record<string, unknown> = {};
  const money = (micros: number) => `${formatMicros(micros, currency)}/day (= ${micros} micros)`;
  const sharedNote = (b: GoogleBudgetState) => (b.explicitlyShared
    ? `This is a SHARED budget: it caps the combined spend of all ${b.referenceCount} campaign(s) attached to it.`
    : '');
  const op = `${entity} ${action}`;
  let enableBudgetMicros: number | undefined;
  /** Enabling a child of a paused campaign: it cannot spend until the campaign is enabled too. */
  let parentPaused = false;
  const readParent = async <T>(what: string): Promise<T> => {
    const parent = await deps.read(userId, cid, validated.parent!.kind, validated.parent!.resourceName);
    if (!parent) refuseNotFound(what, validated.parent!.resourceName);
    return parent as T;
  };
  /** Existing keywords at the parent; a duplicate is refused here, before any token is minted. */
  const readExistingKeywords = async (): Promise<GoogleKeywordState[]> => {
    const list = await deps.read(userId, cid, validated.keywordList!.kind, validated.keywordList!.resourceName);
    if (!Array.isArray(list)) throw new MetaToolkitRefusal('Could not read the existing keywords, so nothing was sent. Try again shortly.');
    const existing = new Set((list as GoogleKeywordState[]).filter((k) => k.negative === validated.keywordList!.negative).map(keywordKey));
    const dupes = validated.keywords!.filter((k) => existing.has(keywordKey(k)));
    if (dupes.length) {
      throw new MetaToolkitRefusal(`Already present: ${dupes.map(keywordLabel).join(', ')}. Remove them from this call. Nothing was sent.`);
    }
    return list as GoogleKeywordState[];
  };

  if (op === 'CAMPAIGN_CONVERSION_GOAL UPDATE') {
    const prior = await deps.read(userId, cid, 'campaign_conversion_goal', validated.target!.resourceName);
    if (!prior || typeof prior.biddable !== 'boolean') refuseNotFound('Campaign conversion goal', validated.target!.resourceName);
    state = { prior };
    lines.push(`Campaign "${prior.name ?? prior.campaign ?? prior.resourceName}", category ${prior.category}, origin ${prior.origin}: biddable ${prior.biddable} → ${args.biddable}.`);
    if (args.biddable === false && prior.biddable === true && isCustomerResource(cid, 'campaign_conversion_goals', prior.campaign)) {
      const goals = await deps.read(userId, cid, 'campaign_conversion_goals', prior.campaign);
      if (Array.isArray(goals) && !goals.some((g: any) => g.biddable === true && g.resourceName !== prior.resourceName)) {
        throw new MetaToolkitRefusal(`This is the only conversion goal campaign "${prior.name ?? prior.campaign}" bids on. Google rejects a campaign with no goal (EMPTY_CONVERSION_GOALS), so turn another goal on first. Nothing was sent.`);
      }
      state = { ...state, goals };
    }
    lines.push('This changes which conversion goal drives campaign bidding; it does not change the account default or campaign status.');
  } else if (op === 'BUDGET CREATE') {
    lines.push(`Create budget "${args.name}": ${money(validated.budgetMicros!)}${validated.dispatchArgs.explicitly_shared ? ', SHARED (can be attached to several campaigns; it caps their combined spend)' : ''}.`);
  } else if (op === 'BUDGET UPDATE') {
    const prior: GoogleBudgetState | null = await deps.read(userId, cid, 'budget', validated.target!.resourceName);
    if (!prior) refuseNotFound('Budget', validated.target!.resourceName);
    state = { prior };
    lines.push(`Change budget "${prior!.name ?? prior!.resourceName}": ${money(prior!.amountMicros)} → ${money(validated.budgetMicros!)}.`);
    const note = sharedNote(prior!);
    if (note) lines.push(note);
  } else if (op === 'CAMPAIGN CREATE') {
    const budget: GoogleBudgetState | null = await deps.read(userId, cid, 'budget', String(validated.dispatchArgs.budget_resource_name));
    if (!budget) refuseNotFound('Budget', String(validated.dispatchArgs.budget_resource_name));
    if (!budget!.explicitlyShared && budget!.referenceCount > 0) {
      throw new MetaToolkitRefusal('That budget already belongs to another campaign and is not shared. Create a new BUDGET for this campaign (or use a shared one). Nothing was sent.');
    }
    state = { budget };
    lines.push(`Create ${args.type} campaign "${args.name}" on budget "${budget!.name ?? budget!.resourceName}" (${money(budget!.amountMicros)}).`);
    const note = sharedNote(budget!);
    if (note) lines.push(`${note} This campaign would be added to it.`);
    if (!budget!.explicitlyShared && budget!.name !== args.name) {
      lines.push(`Google renames this (unshared) budget to "${args.name}" when the campaign is created.`);
    }
    lines.push(`Bidding: ${biddingLabel(args, currency)}.`);
    const d = validated.dispatchArgs;
    if (args.type === 'SEARCH') {
      lines.push(`Networks: Google Search${d.target_search_network ? ' + search partners' : ''}${d.target_content_network ? ' + Display Network (ads can also show on websites and apps)' : ''}`
        + `${!d.target_search_network || !d.target_content_network ? ` (off: ${[!d.target_search_network && 'search partners', !d.target_content_network && 'Display Network'].filter(Boolean).join(', ')})` : ''}.`);
    }
    const locations = (d.location_target_ids as number[] | undefined) ?? [];
    lines.push(locations.length
      ? `Locations: ${locations.join(', ')} (Google location ids) — people in, or showing interest in, these locations (Google's default).`
      : 'Locations: none set — the campaign can serve in every country.');
    if (args.type === 'PERFORMANCE_MAX') {
      const logoRn = String(validated.dispatchArgs.brand_logo_asset_resource_name);
      const logo: GoogleAssetState | null = await deps.read(userId, cid, 'asset', logoRn);
      if (!logo) refuseNotFound('Logo asset', logoRn);
      if (logo!.type !== 'IMAGE') throw new MetaToolkitRefusal(`brand_logo_asset_resource_name ${logoRn} is a ${logo!.type} asset, not an image. Upload the logo with ASSET UPLOAD asset_type=LOGO. Nothing was sent.`);
      state = { ...state, logo };
      lines.push(`Brand: business name "${args.brand_business_name}", logo ${logoRn} — attached to the campaign in the same atomic request (Performance Max cannot serve without them).`);
    }
  } else if (op === 'AD_GROUP CREATE') {
    const campaign: GoogleCampaignState | null = await deps.read(userId, cid, 'campaign', String(validated.dispatchArgs.campaign_resource_name));
    if (!campaign) refuseNotFound('Campaign', String(validated.dispatchArgs.campaign_resource_name));
    state = { campaign };
    const bid = validated.dispatchArgs.cpc_bid_micros as number | undefined;
    lines.push(`Create ${args.type} ad group "${args.name}" in campaign "${campaign!.name ?? campaign!.resourceName}" (campaign is ${campaign!.status})${bid !== undefined ? `, max CPC ${formatMicros(bid, currency)} (= ${bid} micros)` : ''}.`);
  } else if (op === 'KEYWORD ADD') {
    const adGroup = await readParent<GoogleAdGroupState>('Ad group');
    const existing = await readExistingKeywords();
    state = { adGroup, existing: existing.map(keywordKey).sort() };
    lines.push(`Add ${validated.keywords!.length} keyword(s) to ad group "${adGroup.name ?? adGroup.resourceName}" (ad group is ${adGroup.status}): ${validated.keywords!.map(keywordLabel).join(', ')}.`);
  } else if (op === 'KEYWORD ADD_NEGATIVE') {
    const level = validated.parent!.kind === 'campaign' ? 'campaign' : 'ad group';
    const parent = await readParent<GoogleCampaignState | GoogleAdGroupState>(capitalize(level));
    const existing = await readExistingKeywords();
    state = { parent, existing: existing.filter((k) => k.negative).map(keywordKey).sort() };
    lines.push(`Exclude ${validated.keywords!.length} negative keyword(s) at ${level} level on "${parent.name ?? parent.resourceName}": ${validated.keywords!.map(keywordLabel).join(', ')}.`);
    lines.push('Negative keywords only stop ads showing on matching searches; they cannot start or increase spend.');
  } else if (op === 'KEYWORD REMOVE') {
    const prior: GoogleKeywordState | null = await deps.read(userId, cid, 'keyword', validated.target!.resourceName);
    if (!prior || prior.status === 'REMOVED') refuseNotFound('Keyword', validated.target!.resourceName);
    state = { prior };
    lines.push(`Remove ${prior!.negative ? 'negative ' : ''}keyword ${keywordLabel(prior!)}${prior!.status ? ` (currently ${prior!.status})` : ''}${prior!.adGroup ? ` from ad group ${prior!.adGroup}` : ''}.`);
    lines.push('Removal is permanent: adding the keyword again later creates a new keyword without its history.');
    if (prior!.negative) {
      lines.push('Removing this negative keyword lets ads show for these searches again, which can increase spend.');
    }
  } else if (op === 'AD CREATE') {
    const adGroup = await readParent<GoogleAdGroupState>('Ad group');
    state = { adGroup };
    const d = validated.dispatchArgs;
    lines.push(`Create a responsive search ad in ad group "${adGroup.name ?? adGroup.resourceName}" (ad group is ${adGroup.status}) → ${d.final_url}`);
    lines.push(`Headlines (${(d.headlines as string[]).length}): ${(d.headlines as string[]).map((h) => `"${h}"`).join(' | ')}`);
    lines.push(`Descriptions (${(d.descriptions as string[]).length}): ${(d.descriptions as string[]).map((h) => `"${h}"`).join(' | ')}`);
    lines.push('Headlines, descriptions and the final URL can be changed later with AD UPDATE (its own preview and approval).');
  } else if (op === 'ASSET_GROUP CREATE') {
    const campaign = await readParent<GoogleCampaignState>('Campaign');
    if (campaign.channelType !== 'PERFORMANCE_MAX') {
      throw new MetaToolkitRefusal(`Campaign "${campaign.name ?? campaign.resourceName}" is ${campaign.channelType ?? 'not confirmed as'} PERFORMANCE_MAX; asset groups belong to Performance Max campaigns. Nothing was sent.`);
    }
    const brand: GoogleCampaignBrand | null = await deps.read(userId, cid, 'campaign_brand', campaign.resourceName);
    const logos = validated.dispatchArgs.logo_assets as string[];
    if (!brand?.businessName || (!brand.logoAssets.length && !logos.length)) {
      throw new MetaToolkitRefusal(`Campaign "${campaign.name ?? campaign.resourceName}" has no ${!brand?.businessName ? 'business name' : 'logo'} linked. Create Performance Max campaigns with brand_business_name and brand_logo_asset_resource_name (PERFORMANCE_MAX CAMPAIGN CREATE). Nothing was sent.`);
    }
    state = { campaign, brand };
    const d = validated.dispatchArgs;
    const count = (k: string) => ((d[k] as string[] | undefined) ?? []).length;
    lines.push(`Create asset group "${d.name}" in Performance Max campaign "${campaign.name ?? campaign.resourceName}" (campaign is ${campaign.status}) → ${d.final_url}`);
    lines.push(`Brand (campaign level): business name "${brand.businessName}", ${brand.logoAssets.length} logo(s)${logos.length ? ` + ${logos.length} asset-group logo(s)` : ''}.`);
    lines.push(`Headlines (${count('headlines')}): ${(d.headlines as string[]).map((h) => `"${h}"`).join(' | ')}`);
    lines.push(`Long headlines (${count('long_headlines')}): ${(d.long_headlines as string[]).map((h) => `"${h}"`).join(' | ')}`);
    lines.push(`Descriptions (${count('descriptions')}): ${(d.descriptions as string[]).map((h) => `"${h}"`).join(' | ')}`);
    lines.push(`Images: ${count('square_image_assets')} square, ${count('landscape_image_assets')} landscape${count('video_assets') ? `, ${count('video_assets')} video(s)` : ''}.`);
  } else {
    // Status-only UPDATE of a CAMPAIGN, AD_GROUP, KEYWORD, AD or ASSET_GROUP.
    const kind = validated.target!.kind;
    const noun = capitalize(NOUN[kind] ?? kind);
    const prior = await deps.read(userId, cid, kind, validated.target!.resourceName);
    if (!prior) refuseNotFound(noun, validated.target!.resourceName);
    if (kind === 'keyword' && prior.negative) {
      throw new MetaToolkitRefusal('Negative keywords have no status to change. Use KEYWORD REMOVE to stop excluding it. Nothing was sent.');
    }
    state = { prior };
    if (validated.expectedAdContent) {
      // ENG-2979: only responsive search ads are editable; current vs new, status untouched.
      if (prior.type !== 'RESPONSIVE_SEARCH_AD') {
        throw new MetaToolkitRefusal(`Ad ${prior.resourceName} is a ${prior.type ?? 'unknown type'} ad. Only RESPONSIVE_SEARCH_AD headlines, descriptions and final URL can be edited here. Nothing was sent.`);
      }
      const e = validated.expectedAdContent;
      const list = (v: unknown) => (Array.isArray(v) && v.length ? (v as string[]).map((t) => `"${t}"`).join(' | ') : '(none)');
      lines.push(`Responsive search ad ${prior.resourceName} (status ${prior.status}, unchanged):`);
      if (e.headlines) lines.push(`Headlines: ${list(prior.headlines)} → ${list(e.headlines)}.`);
      if (e.descriptions) lines.push(`Descriptions: ${list(prior.descriptions)} → ${list(e.descriptions)}.`);
      if (e.finalUrl !== undefined) lines.push(`Final URL: ${prior.finalUrls?.[0] ?? '(none)'} → ${e.finalUrl}.`);
      lines.push('Edited ads go back through Google policy review; the ad may stop serving until it is approved again.');
    } else if (validated.expectedEdit) {
      // ENG-2959: rename / ad-group max CPC — current vs new, status untouched.
      const e = validated.expectedEdit;
      lines.push(`${noun} "${prior.name ?? prior.resourceName}" (status ${prior.status}, unchanged):`);
      if (e.name !== undefined) lines.push(`Name: "${prior.name ?? ''}" → "${e.name}".`);
      if (e.searchPartners !== undefined || e.displayNetwork !== undefined) {
        if (prior.channelType !== 'SEARCH') {
          throw new MetaToolkitRefusal(`Campaign "${prior.name ?? prior.resourceName}" is ${prior.channelType ?? 'not confirmed as'} SEARCH; network settings apply to Search campaigns only. Nothing was sent.`);
        }
        const onOff = (v: unknown) => (v === true ? 'on' : 'off');
        if (e.searchPartners !== undefined) lines.push(`Search partners: ${onOff(prior.searchPartners)} → ${onOff(e.searchPartners)}.`);
        if (e.displayNetwork !== undefined) {
          lines.push(`Display Network (ads on websites and apps): ${onOff(prior.displayNetwork)} → ${onOff(e.displayNetwork)}.`);
          if (e.displayNetwork && !prior.displayNetwork) lines.push('Turning the Display Network on lets this budget also spend on display placements.');
        }
      }
      if (e.cpcBidMicros !== undefined) {
        const cur = Number.isFinite(prior.cpcBidMicros) ? `${formatMicros(prior.cpcBidMicros, currency)} (= ${prior.cpcBidMicros} micros)` : 'not set';
        lines.push(`Max CPC: ${cur} → ${formatMicros(e.cpcBidMicros, currency)} (= ${e.cpcBidMicros} micros).`);
      }
    } else lines.push(`${noun} ${kind === 'keyword' ? keywordLabel(prior) : `"${prior.name ?? prior.resourceName}"`}: ${prior.status} → ${validated.expectedStatus}.`);
    // Enabling starts spend at the campaign's budget, so the preview names that budget and
    // the ceiling applies to it — otherwise a budget set above the ceiling outside Zoma
    // (or before the ceiling existed) could be switched on here (Hardening, ENG-2823).
    let campaign = kind === 'campaign' ? prior as GoogleCampaignState : null;
    if (validated.expectedStatus === 'ENABLED' && kind !== 'campaign') {
      let campaignName: string | undefined = kind === 'ad_group' ? prior.campaign : kind === 'asset_group' ? prior.campaign : undefined;
      if ((kind === 'keyword' || kind === 'ad') && isCustomerResource(cid, 'ad_group', prior.adGroup)) {
        const adGroup: GoogleAdGroupState | null = await deps.read(userId, cid, 'ad_group', prior.adGroup);
        state = { ...state, adGroup };
        campaignName = adGroup?.campaign;
      }
      if (isCustomerResource(cid, 'campaign', campaignName)) {
        campaign = await deps.read(userId, cid, 'campaign', campaignName);
        state = { ...state, campaign };
      }
    }
    const budgetName = campaign?.budget;
    if (validated.expectedStatus === 'ENABLED' && isCustomerResource(cid, 'budget', budgetName)) {
      const budget: GoogleBudgetState | null = await deps.read(userId, cid, 'budget', budgetName);
      if (budget) {
        state = { ...state, budget };
        enableBudgetMicros = budget.amountMicros;
        lines.push(`Budget "${budget.name ?? budget.resourceName}": ${money(budget.amountMicros)}.`);
        const note = sharedNote(budget);
        if (note) lines.push(note);
      }
    }
    if (validated.expectedStatus === 'ENABLED' && kind !== 'campaign' && campaign && campaign.status !== 'ENABLED') {
      lines.push(`Its campaign "${campaign.name ?? campaign.resourceName}" is ${campaign.status}, so this alone does not start delivery.`);
      parentPaused = true;
    }
  }
  const adds = action === 'CREATE' || action === 'ADD';
  lines.push(validated.expectedStatus === 'ENABLED'
    ? parentPaused
      ? 'Status: ENABLED — it starts delivery and spending once its campaign is also enabled.'
      : 'Status: ENABLED — this can start delivery and spending as soon as Google applies it.'
    : validated.expectedStatus === 'PAUSED' && adds
      ? 'Status: PAUSED — new campaigns, ad groups, keywords, ads and asset groups are always created paused; enabling is a separate preview and approval.'
      : validated.expectedStatus === 'PAUSED'
        ? 'Status: PAUSED — stops delivery.'
        : op === 'BUDGET CREATE' ? 'A new budget spends nothing until an enabled campaign uses it.'
          : op === 'KEYWORD REMOVE' ? '' : 'Status: unchanged.');

  const policy = deps.spendCeilingPolicy();
  if (policy && validated.budgetMicros !== undefined) {
    const prior = (state.prior as GoogleBudgetState | undefined)?.amountMicros;
    const verdict = evaluateMetaSpendCeiling(policy, { field: 'daily_budget', proposed: validated.budgetMicros, prior });
    if (!verdict.allowed) throw new MetaToolkitRefusal(verdict.message.replace('(minor units)', '(micros)'));
  }
  if (policy && action === 'UPDATE' && validated.expectedStatus === 'ENABLED') {
    // Fail closed: a ceiling that cannot see the campaign's budget never allows enabling it.
    const verdict = evaluateMetaSpendCeiling(policy, { field: 'daily_budget', proposed: enableBudgetMicros });
    if (!verdict.allowed) {
      throw new MetaToolkitRefusal(`Enabling this ${NOUN[validated.target!.kind] ?? 'object'} would start spend at its budget. ${verdict.message.replace('(minor units)', '(micros)')}`);
    }
  }

  const fingerprint = previewFingerprint({ platform: 'google_ads', userId, args: validated.dispatchArgs, state, currency });
  const now = deps.now();
  const secret = deps.secret();
  const freshPreview = () => previewResponse({ secret, userId, now, fingerprint, preview: lines.filter(Boolean).join('\n') });

  if (confirm !== true) return freshPreview();

  if (!previewTokenMatches(previewToken, secret, userId, fingerprint, now)) {
    return {
      ...freshPreview(),
      status: 'PREVIEW_MISMATCH',
      note: 'The confirmation did not match a current preview (missing, expired, or the arguments or Google Ads state changed). Nothing was sent. Show this new preview and get approval again.',
    };
  }
  if (!(await consumeToken(deps.consumedTokens, previewToken, now))) {
    throw new MetaToolkitRefusal('This preview_token was already used. Run a new preview for another change.');
  }

  // A throw after the token was consumed is treated like a transport failure: outcome unknown.
  const result = await dispatchOnce(deps, userId, validated.dispatchArgs);
  const objectId = validated.target?.resourceName ?? validated.keywordList?.resourceName ?? null;
  if (result?.success === false && result?.errorType === 'unsupported_field') {
    // ENG-592: Google accepted the mutate but read-back shows it unchanged. Never success.
    return {
      success: false, verification: 'MISMATCH' as WriteVerification, id: objectId,
      message: String(result.error ?? 'Google accepted the change but read-back shows it did not apply.'),
    };
  }
  if (result?.success !== true && outcomeUnknown(result)) {
    // The request may have reached Google and been applied (e.g. a timeout after Google
    // committed). "Did not apply" here invites a retry that double-applies a CREATE, so this
    // is UNCONFIRMED, metered as a write, with the current state read back when we can.
    const readBack = validated.target ? await deps.read(userId, cid, validated.target.kind, validated.target.resourceName).catch(() => null) : null;
    const what = args.name !== undefined ? `"${String(args.name)}" was created` : `they were ${action === 'CREATE' ? 'created' : 'added'}`;
    return {
      success: false,
      verification: 'UNCONFIRMED' as WriteVerification,
      id: objectId,
      status: readBack?.status ?? null,
      ...(readBack?.amountMicros !== undefined ? { amount_micros: readBack.amountMicros, amount: formatMicros(readBack.amountMicros, currency) } : {}),
      message: `UNCONFIRMED: the ${action} ${entity} request failed without a definite answer from Google Ads (${String(result?.error ?? 'unknown error')}), so it may or may not have been applied. `
        + (validated.target
          ? `Do not retry blindly — check the current ${entity} state first${readBack ? ' (read back above)' : ''}.`
          : `Do not retry blindly — list the ${PLURAL[entity] ?? `${entity.toLowerCase()}s`} first to check whether ${what}.`),
    };
  }
  if (!result?.success || result?.blocked || result?.awaitingUserConfirmation) return failedResult(result);

  const warnings = {
    ...(result.trackingWarning ? { tracking_warning: result.trackingWarning } : {}),
    ...(result.pausedChildEntitiesWarning ? { paused_children_warning: result.pausedChildEntitiesWarning } : {}),
  };

  // KEYWORD ADD / ADD_NEGATIVE: Google returns no ids, so the parent's keyword list is the proof.
  if (validated.keywordList) {
    const list = await deps.read(userId, cid, validated.keywordList.kind, validated.keywordList.resourceName).catch(() => null);
    const { verification, ids } = verifyKeywords(validated, list);
    const n = validated.keywords!.length;
    return {
      success: verification === 'CONFIRMED', verification, id: objectId, ids, ...warnings,
      message: verification === 'CONFIRMED'
        ? `${action} KEYWORD confirmed by read-back: ${n} ${validated.keywordList.negative ? 'negative ' : ''}keyword(s)${validated.expectedStatus ? `, status ${validated.expectedStatus}` : ''}.`
        : verification === 'MISMATCH'
          ? `Google accepted the ${action}, but the read-back found ${ids.length} of ${n} keyword(s) as approved. Review the keywords of ${objectId} before doing anything else.`
          : `UNCONFIRMED: Google accepted the ${action} request, but the keyword read-back failed. Do not report this as done and do not retry blindly — list the keywords first.`,
    };
  }

  // KEYWORD REMOVE: proven when the criterion reads back REMOVED or is gone.
  if (action === 'REMOVE') {
    const rb = await readSettled(deps, userId, cid, validated.target!.kind, validated.target!.resourceName);
    const verification: WriteVerification = !rb.ok ? 'UNCONFIRMED' : !rb.value || rb.value.status === 'REMOVED' ? 'CONFIRMED' : 'MISMATCH';
    return {
      success: verification === 'CONFIRMED', verification, id: objectId, status: rb.value?.status ?? (rb.ok ? 'REMOVED' : null),
      message: verification === 'CONFIRMED' ? `REMOVE ${entity} confirmed by read-back: ${objectId}.`
        : verification === 'MISMATCH' ? `Google accepted the REMOVE, but ${objectId} still reads back ${rb.value?.status}. Review it before doing anything else.`
          : `UNCONFIRMED: Google accepted the REMOVE, but the read-back failed. Check ${objectId} before retrying.`,
    };
  }

  const created = CREATED[entity];
  const id: string | undefined = action === 'CREATE' ? result?.[created?.field] : validated.target!.resourceName;
  const kind: GoogleReadKind = validated.target?.kind ?? created.kind;
  const readBack = id ? await deps.read(userId, cid, kind, id).catch(() => null) : null;
  let verification = verify(validated, entity, readBack);
  let brand: GoogleCampaignBrand | null = null;
  if (verification === 'CONFIRMED' && op === 'CAMPAIGN CREATE' && args.type === 'PERFORMANCE_MAX') {
    // The brand assets are part of what was approved: a PMax campaign without them cannot serve.
    brand = await deps.read(userId, cid, 'campaign_brand', id!).catch(() => null);
    verification = !brand ? 'UNCONFIRMED'
      : brand.businessName === args.brand_business_name && brand.logoAssets.includes(String(args.brand_logo_asset_resource_name)) ? 'CONFIRMED' : 'MISMATCH';
  }
  const base = {
    success: verification === 'CONFIRMED',
    verification,
    id: id ?? null,
    status: readBack?.status ?? null,
    ...(readBack?.amountMicros !== undefined ? { amount_micros: readBack.amountMicros, amount: formatMicros(readBack.amountMicros, currency) } : {}),
    ...(typeof readBack?.biddable === 'boolean' ? { biddable: readBack.biddable } : {}),
    ...(brand ? { brand: { business_name: brand.businessName ?? null, logo_assets: brand.logoAssets } } : {}),
    ...warnings,
  };
  if (verification === 'CONFIRMED') {
    return { ...base, message: `${action} ${entity} confirmed by read-back: ${id}${readBack?.status ? `, status ${readBack.status}` : ''}.` };
  }
  if (verification === 'MISMATCH') {
    return { ...base, message: `Google accepted the ${action}, but the read-back does not match what was approved. Review ${entity} ${id} before doing anything else.` };
  }
  return {
    ...base,
    message: `UNCONFIRMED: Google accepted the ${action} request${id ? ` (${id})` : ''}, but the read-back could not confirm it. Do not report this as done and do not retry blindly — check the ${entity} first.`,
  };
}
