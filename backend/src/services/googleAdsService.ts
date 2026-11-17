import axios from 'axios';
import { getGoogleAdsCredentials } from '../utils/secretsManager';
import { resolvePinnedPublicAddress } from '../utils/ssrfGuard';
import { updateAccountTokens } from './connectedAccountsDb'; // sibling in services/
import { buildUtmSpec, mergeUtmIntoQueryString, mergeUtmIntoUrl, readUtmKeys, utmKeysInQueryString, utmQueryString } from '../utils/adUtm';
import {
  BidAdjustmentDevice,
  buildDeviceBidAdjustmentOperations,
  NormalizedDeviceBidAdjustments,
  validateNegativeCampaignCriteria,
} from './googleAdsCampaignCriteria';
import {
  assertCountingType,
  assertConversionActionStatus,
  assertCreatableConversionActionStatus,
  describeGoogleAdsError,
  parseTagSnippets,
  diffConversionAction,
  type ConversionActionDrift,
  type ConversionTagPair,
} from '../utils/googleAdsConversionActions';
import {
  summarizePartialFailure,
  type ConversionUploadFailure,
} from '../utils/googleAdsOfflineConversions';

/** Google's authorizationError CUSTOMER_NOT_ENABLED, read defensively: this runs inside a catch and must never throw. */
function isCustomerNotEnabled(err: any): boolean {
  const details = err?.response?.data?.error?.details;
  if (!Array.isArray(details)) return false;
  return details.some((d: any) => Array.isArray(d?.errors) && d.errors.some((e: any) => e?.errorCode?.authorizationError === 'CUSTOMER_NOT_ENABLED'));
}

const GOOGLE_ADS_API_BASE = 'https://googleads.googleapis.com/v24';

/**
 * Every Google Ads call goes through callApi, and it had no timeout at all — an axios
 * request with none waits forever on a stalled connection.
 *
 * That is not an abstract risk here. A hung call blocks the agent-mode tool call that
 * made it, and on the offline-conversion path (ENG-1325) it would stall a background
 * sweep with nobody watching, so the symptom is "conversions stopped uploading" with no
 * error anywhere.
 *
 * 60s rather than something tighter: a GAQL search over a large account is legitimately
 * slow, and a timeout that fires on normal traffic is worse than none — it turns a slow
 * read into a spurious failure. This is a ceiling on hanging, not a latency target.
 */
const GOOGLE_ADS_HTTP_TIMEOUT_MS = 60_000;

/** ENG-2475: true when a Google Ads error body carries databaseError CONCURRENT_MODIFICATION. */
function isConcurrentModificationError(err: any): boolean {
  const details = err?.response?.data?.error?.details;
  if (!Array.isArray(details)) return false;
  return details.some((d: any) => Array.isArray(d?.errors) && d.errors.some((e: any) =>
    e?.errorCode && typeof e.errorCode === 'object' && Object.values(e.errorCode).includes('CONCURRENT_MODIFICATION')));
}
const TOKEN_REFRESH_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleAdAccount {
  customerId: string;
  name: string;
  currency: string;
}

export interface GoogleAdsAccountCredentials {
  accessToken: string;
  customerId: string;
  currency: string;
  /**
   * The `login-customer-id` to use for API calls. Equals the manager (MCC) id when the
   * account is a leaf reached through a manager; otherwise equals customerId.
   */
  loginCustomerId: string;
}

/** A leaf (non-manager) Google Ads account the user can connect. */
export interface GoogleAdLeaf {
  customerId: string;
  name: string;
  currency: string;
  /** Manager id to send as login-customer-id, or the account's own id when standalone. */
  loginCustomerId: string;
  /** True if this customerId is already a connected google_ads account for the user. */
  alreadyConnected?: boolean;
  /**
   * ENG-1362. Google's `test_account` flag — the ONLY thing that guarantees an account
   * cannot serve ads and cannot spend. Captured at discovery so nothing downstream has to
   * infer it from the account NAME, which guarantees nothing: a real, billable, ENABLED
   * account named "Test" is exactly the case this exists to disambiguate.
   */
  testAccount?: boolean;
}

/** A node in the account-selection tree returned during OAuth finalize. */
export type GoogleAdsAccountNode =
  | { type: 'leaf'; customerId: string; name: string; currency: string; loginCustomerId: string; alreadyConnected?: boolean; testAccount?: boolean }
  | { type: 'manager'; customerId: string; name: string; children: GoogleAdLeaf[] };

/**
 * ENG-1527. Refuse a bid target that cannot be written, instead of dropping it.
 *
 * Google stores a bid target as a LEAF of the bidding strategy — `target_cpa.target_cpa_micros`,
 * `target_roas.target_roas`, `maximize_conversions.target_cpa_micros` and so on. There is no
 * strategy-agnostic field, so a target supplied without a strategy has nowhere to go: both
 * createCampaign and updateCampaign read it into `params` and then never touch it.
 *
 * On UPDATE that was silent whenever any OTHER field was masked — `name` alone made the
 * update mask non-empty, the mutate went through, and the caller was told "Campaign updated"
 * while the target it asked for was never sent. Smart bidding then keeps optimising to the
 * old target, spending real money at the wrong efficiency point, and there is no read-back on
 * campaigns to catch it.
 *
 * Refused rather than inferred: guessing the leaf would mean reading the campaign's current
 * strategy and writing a MONEY field based on a value that can change between the read and
 * the write. A refusal costs the caller one retry; a wrong guess costs budget.
 *
 * Shared by both call sites deliberately. The same invariant written twice is how these
 * diverge, which is the shape of most of the defects this ticket collects.
 */
/**
 * Which bid targets each strategy can actually carry, and where Google stores them.
 *
 * `target` is bidding_strategy_target, `ceiling` is cpc_bid_ceiling_micros. A `false` here
 * does not mean "we chose not to support it" — it means the field does not exist on that
 * strategy at campaign level, so sending it writes nothing.
 *
 * cpc_bid_ceiling_micros is documented as "mutable for portfolio bidding strategies only",
 * which is why it is false on every STANDARD strategy that is not TARGET_IMPRESSION_SHARE
 * (where it is required) or TARGET_SPEND (where it is the strategy's only knob). We
 * deliberately do NOT start writing it onto TargetCpa/TargetRoas to "support" it: that is a
 * new, spend-affecting write we cannot validate against the live API from here, and the
 * caller is better served by a loud rejection than by a bid cap that may be ignored.
 */
const BID_TARGET_SUPPORT: Record<string, { target: boolean; ceiling: boolean; targetMeans: string }> = {
  MAXIMIZE_CONVERSIONS:      { target: true,  ceiling: false, targetMeans: 'a target CPA' },
  MAXIMIZE_CONVERSION_VALUE: { target: true,  ceiling: false, targetMeans: 'a target ROAS' },
  TARGET_CPA:                { target: true,  ceiling: false, targetMeans: 'a target CPA' },
  TARGET_ROAS:               { target: true,  ceiling: false, targetMeans: 'a target ROAS' },
  TARGET_IMPRESSION_SHARE:   { target: true,  ceiling: true,  targetMeans: 'an impression share fraction' },
  TARGET_SPEND:              { target: false, ceiling: true,  targetMeans: '' },
  MANUAL_CPC:                { target: false, ceiling: false, targetMeans: '' },
};

/**
 * Refuse any bid target the selected strategy cannot store, BEFORE anything is sent.
 *
 * Google keeps a bid target as a leaf of the bidding strategy (target_cpa.target_cpa_micros
 * and friends), so a target is only reachable through the strategy branch that owns it.
 * Every combination this rejects used to be accepted, dropped on the floor, and reported as
 * `success: true` — the caller was told the campaign was updated while the number they sent
 * was never written, leaving smart bidding optimising to the OLD target with real money.
 *
 * Three distinct shapes of that bug, all confirmed against the mutate payload:
 *   - no strategy at all: the target had no branch to live in;
 *   - a strategy that has no such field (MANUAL_CPC + target, TARGET_SPEND + target,
 *     MAXIMIZE_* + ceiling);
 *   - a portfolio resource name, where the campaign only carries a REFERENCE and every
 *     target belongs to the shared strategy object instead.
 */
function assertBidTargetIsAddressable(params: {
  biddingStrategy?: string;
  biddingStrategyResourceName?: string;
  biddingStrategyTarget?: number;
  cpcBidCeilingMicros?: number;
}): void {
  const sentTarget = params.biddingStrategyTarget !== undefined;
  const sentCeiling = params.cpcBidCeilingMicros !== undefined;
  if (!sentTarget && !sentCeiling) return;

  const supplied = [
    sentTarget ? 'bidding_strategy_target' : '',
    sentCeiling ? 'cpc_bid_ceiling_micros' : '',
  ].filter(Boolean).join(' / ');

  if (!params.biddingStrategy && !params.biddingStrategyResourceName) {
    throw new Error(
      `${supplied} cannot be applied on their own: Google stores a bid target as a leaf of the bidding strategy, so the strategy has to be named to know which field to write. Re-send with bidding_strategy set to the campaign's current strategy (read it with call_google_ads_reporting_api: SELECT campaign.bidding_strategy_type FROM campaign). Nothing was sent to Google Ads.`,
    );
  }

  // A portfolio/shared strategy is attached to the campaign by REFERENCE. The campaign row
  // has nowhere to put a target, so one supplied here would be silently discarded — it has
  // to be written on the shared strategy object itself, where it applies to every campaign
  // using it.
  if (params.biddingStrategyResourceName) {
    throw new Error(
      `${supplied} cannot be set on a campaign that uses the portfolio bidding strategy ${params.biddingStrategyResourceName}: the campaign only holds a reference to it, and the target lives on the shared strategy, where it applies to every campaign using that strategy. Update the bidding strategy itself instead. Nothing was sent to Google Ads.`,
    );
  }

  const support = BID_TARGET_SUPPORT[params.biddingStrategy as string];
  // An unknown strategy is rejected further down with the list of supported values; let
  // that error win rather than shadowing it with a less specific one.
  if (!support) return;

  if (sentTarget && !support.target) {
    throw new Error(
      `bidding_strategy_target is not a field of ${params.biddingStrategy}: that strategy has no bid target to set${params.biddingStrategy === 'MANUAL_CPC' ? ' (bids are per ad group / keyword with MANUAL_CPC)' : ''}. Drop bidding_strategy_target, or choose a strategy that takes one (${Object.entries(BID_TARGET_SUPPORT).filter(([, v]) => v.target).map(([k]) => k).join(', ')}). Nothing was sent to Google Ads.`,
    );
  }

  if (sentCeiling && !support.ceiling) {
    throw new Error(
      `cpc_bid_ceiling_micros is not a campaign-level field of ${params.biddingStrategy}: Google makes the ceiling on this strategy mutable only through a PORTFOLIO bidding strategy, so a ceiling sent here is not stored and the campaign keeps bidding uncapped. Either move the campaign onto a portfolio strategy that carries the ceiling, or drop cpc_bid_ceiling_micros${support.target ? ` and control cost with bidding_strategy_target (${support.targetMeans})` : ''}. Nothing was sent to Google Ads.`,
    );
  }
}

export type GoogleAdsServingState = 'BLOCKED_BY_CAMPAIGN' | 'BLOCKED_BY_BUDGET' | 'BLOCKED_BY_AD_GROUP'
  | 'BLOCKED_BY_AD' | 'BLOCKED_BY_POLICY' | 'BLOCKED_BY_KEYWORD' | 'READY' | 'DELIVERING' | 'UNVERIFIED';

export interface GoogleAdsServingBlocker {
  state: GoogleAdsServingState;
  entityId: string;
  reason: string;
  adGroupId?: string;
}

export interface GoogleAdsServingPath {
  adGroupId: string;
  adGroup: { id: string; resourceName: string; status: string };
  state: GoogleAdsServingState;
  blockers: GoogleAdsServingBlocker[];
  // Raw readback is retained so the agent can cite exact creative/keyword evidence.
  ads: any[];
  keywords: any[];
  telemetry: { impressions: number; costMicros: number } | null;
}

export interface GoogleAdsServingCampaign {
  campaignId: string;
  campaign?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  state: GoogleAdsServingState;
  adGroups: GoogleAdsServingPath[];
  blockers: GoogleAdsServingBlocker[];
}

export interface GoogleAdsServingReport {
  customerId: string;
  checkedAt: string;
  timeZone: string | null;
  currency: string | null;
  window: { preset: 'TODAY'; startDate: string; endDate: string } | null;
  state: GoogleAdsServingState;
  campaigns: GoogleAdsServingCampaign[];
  blockers: GoogleAdsServingBlocker[];
}

/**
 * ENG-592: a mutate reported success but read-back shows the requested field(s) unchanged.
 * Never convert this into a success response.
 */
export class GoogleAdsReadBackError extends Error {
  readonly code = 'unsupported_field' as const;
  constructor(readonly resourceName: string, readonly fields: string[]) {
    super(`unsupported_field: Google Ads accepted the update for ${resourceName} but read-back shows these field(s) did not change: ${fields.join(', ')}. The change was NOT applied; do not report it as done.`);
    this.name = 'GoogleAdsReadBackError';
  }
}

export class GoogleAdsService {
  /** ENG-1922: Search-only readback. Configuration and account-local TODAY metrics
   * are independent evidence. Historical delivery never overrides a blocked path.
   * Google enums: https://developers.google.com/google-ads/api/fields/v24/ad_group_criterion
   */
  async getServingChainStatus(userId: string, customerId: string, campaignIds?: string[]): Promise<GoogleAdsServingReport> {
    const checkedAt = new Date().toISOString();
    const report: GoogleAdsServingReport = { customerId, checkedAt, timeZone: null, currency: null, window: null,
      state: 'UNVERIFIED', campaigns: [], blockers: [] };
    const blocker = (state: GoogleAdsServingState, entityId: string, reason: string, adGroupId?: string): GoogleAdsServingBlocker =>
      ({ state, entityId, reason, ...(adGroupId ? { adGroupId } : {}) });
    const assert = (condition: unknown, reason: string): void => { if (!condition) throw new Error(reason); };
    const id = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);
    const number = (value: unknown): number => {
      assert((typeof value === 'string' && /^\d+$/.test(value)) || typeof value === 'number', 'Missing or malformed numeric evidence');
      const n = Number(value);
      assert(Number.isSafeInteger(n) && n >= 0, 'Invalid numeric evidence');
      return n;
    };
    const status = (value: unknown, allowed: string[]): void => assert(typeof value === 'string' && allowed.includes(value), 'Missing or unknown status');
    const priority: GoogleAdsServingState[] = ['UNVERIFIED', 'DELIVERING', 'READY', 'BLOCKED_BY_CAMPAIGN',
      'BLOCKED_BY_BUDGET', 'BLOCKED_BY_AD_GROUP', 'BLOCKED_BY_AD', 'BLOCKED_BY_POLICY', 'BLOCKED_BY_KEYWORD'];
    const rollup = (states: GoogleAdsServingState[]): GoogleAdsServingState => priority.find(s => states.includes(s)) || 'UNVERIFIED';
    try {
      assert(id(customerId) && (campaignIds === undefined || (Array.isArray(campaignIds) && campaignIds.length > 0 && campaignIds.every(id))), 'Invalid customer or campaign IDs');
      const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
      const read = async (query: string): Promise<any[]> => {
        const completeness: { truncated?: boolean } = {};
        const rows = await this.search(customerId, accessToken, query, loginCustomerId, completeness);
        assert(!completeness.truncated && Array.isArray(rows) && rows.every(r => r && typeof r === 'object' && !Array.isArray(r)), 'Incomplete Google Ads read');
        return rows;
      };
      const customers = await read('SELECT customer.time_zone, customer.currency_code FROM customer');
      assert(customers.length === 1 && typeof customers[0]?.customer?.timeZone === 'string' && typeof customers[0]?.customer?.currencyCode === 'string', 'Missing account timezone/currency');
      report.timeZone = customers[0].customer.timeZone;
      report.currency = customers[0].customer.currencyCode;
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: customers[0].customer.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(checkedAt));
      const date = ['year', 'month', 'day'].map(key => parts.find(p => p.type === key)!.value).join('-');
      report.window = { preset: 'TODAY', startDate: date, endDate: date };
      const filter = campaignIds ? `campaign.id IN (${campaignIds.join(',')})` : "campaign.status != 'REMOVED'";
      const campaigns = await read(`SELECT campaign.id, campaign.resource_name, campaign.status, campaign.start_date_time, campaign.end_date_time, campaign.advertising_channel_type, campaign.campaign_budget, campaign_budget.id, campaign_budget.resource_name, campaign_budget.status, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE ${filter}`);
      const seen = new Set<string>();
      for (const row of campaigns) {
        assert(id(row.campaign?.id) && !seen.has(row.campaign.id) && (!campaignIds || campaignIds.includes(row.campaign.id)), 'Missing, duplicate or unexpected campaign');
        seen.add(row.campaign.id);
        const campaign = row.campaign;
        const result: GoogleAdsServingCampaign = { campaignId: campaign.id, campaign, budget: row.campaignBudget, state: 'UNVERIFIED', adGroups: [], blockers: [] };
        report.campaigns.push(result);
        try {
          assert(campaign.advertisingChannelType === 'SEARCH', 'Unsupported campaign type: Search only');
          assert(campaign.resourceName === `customers/${customerId}/campaigns/${campaign.id}`, 'Missing campaign hierarchy');
          const budget = row.campaignBudget;
          assert(id(budget?.id) && budget.resourceName === `customers/${customerId}/campaignBudgets/${budget.id}` && campaign.campaignBudget === budget.resourceName && typeof budget.explicitlyShared === 'boolean', 'Missing attached budget');
          status(campaign.status, ['ENABLED', 'PAUSED', 'REMOVED']);
          status(budget.status, ['ENABLED', 'PAUSED', 'REMOVED']);
          const amount = number(budget.amountMicros);
          const parentBlockers: GoogleAdsServingBlocker[] = [];
          // ENG-2031: v23+ renamed campaign.start_date/end_date to start_date_time/end_date_time
          // ("yyyy-MM-dd HH:mm:ss" in the serving customer's timezone). GAQL returns the raw
          // string; compare on the date prefix so a set-to-midnight start and a 23:59:59 end
          // behave exactly like the old YYYY-MM-DD window check.
          const campaignDay = (value: unknown): string | null => typeof value === 'string'
            && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
          const validDay = (day: string | null): day is string => day !== null
            && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
          const startDay = campaignDay(campaign.startDateTime);
          const endDay = campaignDay(campaign.endDateTime);
          assert(validDay(startDay) && (campaign.endDateTime == null || campaign.endDateTime === '' || validDay(endDay)), 'Missing or malformed campaign dates');
          if (campaign.status !== 'ENABLED' || (startDay as string) > date || (endDay !== null && endDay < date)) {
            parentBlockers.push(blocker('BLOCKED_BY_CAMPAIGN', campaign.id, `${campaign.status}; dates=${startDay}..${endDay ?? 'indefinite'}`));
          }
          if (budget.status !== 'ENABLED' || amount === 0) parentBlockers.push(blocker('BLOCKED_BY_BUDGET', budget.id, `${budget.status}; amountMicros=${budget.amountMicros}`));
          const groups = await read(`SELECT campaign.id, ad_group.id, ad_group.resource_name, ad_group.status FROM ad_group WHERE campaign.id = ${campaign.id} AND ad_group.status != 'REMOVED'`);
          assert(groups.length > 0, 'Missing ad groups');
          const groupIds = new Set<string>();
          for (const g of groups) {
            assert(id(g.adGroup?.id) && g.campaign?.id === campaign.id && g.adGroup.resourceName === `customers/${customerId}/adGroups/${g.adGroup.id}` && !groupIds.has(g.adGroup.id), 'Missing or inconsistent ad group hierarchy');
            groupIds.add(g.adGroup.id);
            result.adGroups.push({ adGroupId: g.adGroup.id, adGroup: g.adGroup, state: 'UNVERIFIED', blockers: [], ads: [], keywords: [], telemetry: null });
          }
          const ads = await read(`SELECT ad_group.id, ad_group_ad.resource_name, ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status FROM ad_group_ad WHERE campaign.id = ${campaign.id} AND ad_group_ad.status != 'REMOVED' AND ad_group.status != 'REMOVED'`);
          const keywords = await read(`SELECT ad_group.id, ad_group_criterion.resource_name, ad_group_criterion.criterion_id, ad_group_criterion.status, ad_group_criterion.negative, ad_group_criterion.approval_status, ad_group_criterion.primary_status FROM ad_group_criterion WHERE campaign.id = ${campaign.id} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED'`);
          // No config fields in this query: zero rows means zero observed delivery,
          // only after a complete successful read. Errors are never zero telemetry.
          const telemetry = await read(`SELECT ad_group.id, metrics.impressions, metrics.cost_micros FROM ad_group WHERE campaign.id = ${campaign.id} AND ad_group.status != 'REMOVED' AND segments.date = '${date}'`);
          for (const list of [ads, keywords, telemetry]) {
            const children = new Set<string>();
            for (const r of list) {
              assert(groupIds.has(r.adGroup?.id), 'Child without known ad group');
              const key = list === ads ? r.adGroupAd?.resourceName : list === keywords ? r.adGroupCriterion?.resourceName : r.adGroup.id;
              assert(typeof key === 'string' && !children.has(key), 'Missing or duplicate child evidence');
              children.add(key);
            }
          }
          for (const path of result.adGroups) {
            const groupId = path.adGroupId;
            try {
              path.blockers = parentBlockers.map(b => ({ ...b, adGroupId: groupId }));
              status(path.adGroup.status, ['ENABLED', 'PAUSED', 'REMOVED']);
              if (path.adGroup.status !== 'ENABLED') path.blockers.push(blocker('BLOCKED_BY_AD_GROUP', groupId, path.adGroup.status, groupId));
              path.ads = ads.filter(r => r.adGroup.id === groupId).map(r => r.adGroupAd);
              path.keywords = keywords.filter(r => r.adGroup.id === groupId).map(r => r.adGroupCriterion);
              assert(path.ads.length > 0, 'Missing ad creative hierarchy');
              for (const a of path.ads) {
                assert(id(a.ad?.id) && a.resourceName === `customers/${customerId}/adGroupAds/${groupId}~${a.ad.id}`, 'Missing ad identity');
                status(a.status, ['ENABLED', 'PAUSED', 'REMOVED']);
                status(a.policySummary?.approvalStatus, ['APPROVED', 'APPROVED_LIMITED', 'DISAPPROVED', 'AREA_OF_INTEREST_ONLY']);
                status(a.policySummary?.reviewStatus, ['REVIEWED', 'REVIEW_IN_PROGRESS', 'UNDER_APPEAL', 'ELIGIBLE_MAY_SERVE']);
              }
              const enabledAds = path.ads.filter((a: any) => a.status === 'ENABLED');
              if (!enabledAds.length) {
                path.blockers.push(...path.ads.map((a: any) => blocker('BLOCKED_BY_AD', a.ad.id, a.status, groupId)));
              } else if (!enabledAds.some((a: any) =>
                ['APPROVED', 'APPROVED_LIMITED', 'AREA_OF_INTEREST_ONLY'].includes(a.policySummary.approvalStatus) &&
                ['REVIEWED', 'ELIGIBLE_MAY_SERVE'].includes(a.policySummary.reviewStatus))) {
                path.blockers.push(...enabledAds.map((a: any) => blocker('BLOCKED_BY_POLICY', a.ad.id, `${a.policySummary.approvalStatus}; ${a.policySummary.reviewStatus}`, groupId)));
              }
              for (const k of path.keywords) {
                assert(id(k.criterionId) && k.resourceName === `customers/${customerId}/adGroupCriteria/${groupId}~${k.criterionId}` && typeof k.negative === 'boolean', 'Missing keyword identity');
                status(k.status, ['ENABLED', 'PAUSED', 'REMOVED']);
                if (!k.negative) {
                  status(k.approvalStatus, ['APPROVED', 'PENDING_REVIEW', 'DISAPPROVED', 'UNDER_REVIEW']);
                  status(k.primaryStatus, ['ELIGIBLE', 'PAUSED', 'REMOVED', 'PENDING', 'NOT_ELIGIBLE']);
                }
              }
              const positiveKeywords = path.keywords.filter((k: any) => !k.negative);
              if (!positiveKeywords.some((k: any) => k.status === 'ENABLED' && k.approvalStatus === 'APPROVED' && k.primaryStatus === 'ELIGIBLE')) {
                path.blockers.push(...(positiveKeywords.length ? positiveKeywords.map((k: any) => blocker('BLOCKED_BY_KEYWORD', k.criterionId, `${k.status}; ${k.approvalStatus}; ${k.primaryStatus}`, groupId)) : [blocker('BLOCKED_BY_KEYWORD', groupId, 'No positive keywords', groupId)]));
              }
              const metrics = telemetry.find(r => r.adGroup.id === groupId)?.metrics;
              path.telemetry = metrics === undefined && !telemetry.some(r => r.adGroup.id === groupId)
                ? { impressions: 0, costMicros: 0 } : { impressions: number(metrics?.impressions), costMicros: number(metrics?.costMicros) };
              path.state = path.blockers[0]?.state || (path.telemetry.impressions > 0 || path.telemetry.costMicros > 0 ? 'DELIVERING' : 'READY');
            } catch (error) {
              path.state = 'UNVERIFIED';
              path.blockers.push(blocker('UNVERIFIED', groupId, error instanceof Error ? error.message : 'Failed child read', groupId));
            }
          }
          result.blockers = result.adGroups.flatMap((g) => g.blockers);
          result.state = rollup(result.adGroups.map((g) => g.state));
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'API or permission failure';
          result.blockers.push(blocker('UNVERIFIED', campaign.id, reason));
          for (const path of result.adGroups) {
            path.state = 'UNVERIFIED';
            path.blockers.push(blocker('UNVERIFIED', path.adGroupId, reason, path.adGroupId));
          }
        }
      }
      for (const missing of campaignIds || []) {
        if (!seen.has(missing)) report.campaigns.push({ campaignId: missing, state: 'UNVERIFIED', adGroups: [], blockers: [blocker('UNVERIFIED', missing, 'Campaign not returned')] });
      }
      report.state = rollup(report.campaigns.map((c) => c.state));
      report.blockers = report.campaigns.flatMap((c) => c.blockers);
      if (!report.campaigns.length) report.blockers.push(blocker('UNVERIFIED', customerId, 'No campaigns returned'));
    } catch (error) {
      report.state = 'UNVERIFIED';
      report.blockers.push(blocker('UNVERIFIED', customerId, error instanceof Error ? error.message : 'API or permission failure'));
    }
    return report;
  }

  // Single-flight refresh guard: userId:accountId → in-flight promise
  private refreshInFlight = new Map<string, Promise<string>>();

  // ── Internal HTTP helper ─────────────────────────────────────────────────

  private async callApi(
    method: 'GET' | 'POST',
    path: string,
    accessToken: string,
    body?: any,
    loginCustomerIdOverride?: string,
  ): Promise<any> {
    const secrets = await getGoogleAdsCredentials();
    // For leaf accounts reached through a manager, the API requires login-customer-id to be
    // the manager id, not the (path) customer id. Callers pass that via the override; standalone
    // accounts fall back to the path customer id (login == customer).
    const loginCustomerId = loginCustomerIdOverride || path.match(/\/customers\/(\d+)\//)?.[1];
    if (!loginCustomerId) throw new Error('Could not determine login-customer-id for Google Ads API call');
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': secrets.developerToken,
      'login-customer-id': loginCustomerId,
      'Content-Type': 'application/json',
    };
    const url = `${GOOGLE_ADS_API_BASE}${path}`;
    if (process.env.NODE_ENV !== 'production') {
      console.log('[GoogleAds] callApi request:', method, url, body ? JSON.stringify(body, null, 2) : '(no body)');
    }
    try {
      const response = method === 'GET'
        ? await axios.get(url, { headers, timeout: GOOGLE_ADS_HTTP_TIMEOUT_MS })
        : await axios.post(url, body, { headers, timeout: GOOGLE_ADS_HTTP_TIMEOUT_MS });
      if (process.env.NODE_ENV !== 'production') {
        console.log('[GoogleAds] callApi response:', JSON.stringify(response.data, null, 2));
      }
      return response.data;
    } catch (err: any) {
      // Log ONLY the response body — never the error object at large, which carries the
      // full request config including its headers. The body is the part with diagnostic
      // value; the rest is noise at best.
      const detail = err?.response?.data;
      console.error('[GoogleAds] callApi error:', JSON.stringify(detail, null, 2));
      // Google's body names the exact field or error code; axios's own message is only
      // "Request failed with status code 400", so that detail reached the log and nowhere
      // else. Enrich the message in place and rethrow the SAME error.
      //
      // Deliberately NOT a new Error wrapping this one. Callers read Google Ads error
      // codes straight off `err.response.data.error.details[0].errors[]` — agentModeService
      // builds its errorType/errorCode for CAMPAIGN_CRITERION from exactly that — so
      // replacing the object silently degrades every Google Ads failure to a generic
      // message. Caught by googleAdsService.test.ts asserting the original is rethrown.
      const described = describeGoogleAdsError(err);
      if (described) err.message = described;
      throw err;
    }
  }

  /**
   * @param completeness Optional out-param. When the `MAX_PAGES` cap stops the walk with rows
   *   still unread, `completeness.truncated` is set to true.
   *
   *   An out-param rather than a widened return type because `search` returns `any[]` to a long
   *   tail of callers that map straight over it; changing the shape would touch every one of
   *   them for a signal only the audit path reads. Same trade-off `adUtmAuditService` already
   *   made for `CampaignAuditReport[]`.
   *
   *   Why it exists at all: the cap silently dropped rows, so a caller that counted what it got
   *   back could not tell a complete read from a capped one. The UTM audit then printed
   *   "✅ All N campaign(s) on google carry UTM tracking" about ads it had never seen — the
   *   fabricated-PASS shape this whole change set exists to remove. ~500k rows makes it
   *   unlikely, not impossible, and "unlikely" is not what a ✅ claims.
   */
  async search(
    customerId: string,
    accessToken: string,
    query: string,
    loginCustomerId?: string,
    completeness?: { truncated?: boolean },
  ): Promise<any[]> {
    const MAX_PAGES = 50; // safety cap (~500k rows at the default page size) to avoid a runaway loop
    const all: any[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    let expectedCount: number | undefined;
    do {
      const body: any = { query };
      if (completeness) body.searchSettings = { returnTotalResultsCount: true };
      if (pageToken) body.pageToken = pageToken;
      const data = await this.callApi('POST', `/customers/${customerId}/googleAds:search`, accessToken, body, loginCustomerId);
      // All search callers share this network boundary; never turn a partial/error
      // envelope or malformed row into a successful (possibly empty) read.
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.error || data.partialFailureError ||
          (data.results !== undefined && (!Array.isArray(data.results) || data.results.some((row: unknown) =>
            !row || typeof row !== 'object' || Array.isArray(row)))) ||
          (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string')) {
        throw new Error('Incomplete or malformed Google Ads search response');
      }
      if (completeness) {
        const rawCount = data.totalResultsCount === undefined && (data.results === undefined || data.results.length === 0)
          ? 0
          : data.totalResultsCount;
        if (rawCount === undefined) {
          throw new Error('Missing Google Ads result count');
        }
        const count = Number(rawCount);
        if (!/^\d+$/.test(String(rawCount)) || !Number.isSafeInteger(count)) {
          throw new Error('Malformed Google Ads result count');
        }
        if (expectedCount !== undefined && expectedCount !== count) completeness.truncated = true;
        expectedCount = count;
      }
      if (data.results) all.push(...data.results);
      pageToken = data.nextPageToken;
      pages++;
    } while (pageToken && pages < MAX_PAGES);
    // A token still in hand means Google had more rows and the cap stopped the walk.
    if (completeness && (pageToken || (expectedCount !== undefined && !/\bLIMIT\b/i.test(query) && expectedCount !== all.length))) {
      completeness.truncated = true;
    }
    return all;
  }

  /** Internal passthrough for endpoints that are not `:mutate` (e.g. conversionUploads). */
  private async callApiPublic(method: 'GET' | 'POST', path: string, accessToken: string, body?: any, loginCustomerId?: string): Promise<any> {
    return this.callApi(method, path, accessToken, body, loginCustomerId);
  }

  async mutate(customerId: string, accessToken: string, resource: string, operations: any[], loginCustomerId?: string): Promise<any> {
    return this.withConcurrentModificationRetry(() =>
      this.callApi('POST', `/customers/${customerId}/${resource}:mutate`, accessToken, { operations }, loginCustomerId));
  }

  async batchMutate(customerId: string, accessToken: string, mutateOperations: any[], loginCustomerId?: string): Promise<any> {
    return this.withConcurrentModificationRetry(() =>
      this.callApi('POST', `/customers/${customerId}/googleAds:mutate`, accessToken, { mutateOperations }, loginCustomerId));
  }

  /** Jittered backoff between CONCURRENT_MODIFICATION retries (overridable in tests). */
  private concurrentRetryDelayMs(attempt: number): number {
    return 250 * attempt + Math.floor(Math.random() * 250);
  }

  /**
   * ENG-2475: Google rejects a whole mutate with CONCURRENT_MODIFICATION when parallel
   * writes hit the same resource, and its message says "Retry the request." Nothing was
   * applied, so retrying is safe. Only that code is retried; every other error (and the
   * final failure) is rethrown as the original object, which callers read codes from.
   */
  private async withConcurrentModificationRetry<T>(fn: () => Promise<T>): Promise<T> {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        if (attempt >= MAX_ATTEMPTS || !isConcurrentModificationError(err)) throw err;
        await new Promise((r) => setTimeout(r, this.concurrentRetryDelayMs(attempt)));
      }
    }
  }

  makeAuthError(message: string): Error {
    const err = new Error(message);
    (err as any).isGoogleAdsAuthError = true;
    return err;
  }

  // ── Token refresh (single-flight) ────────────────────────────────────────

  private async refreshAccessToken(userId: string, accountId: string, refreshToken: string): Promise<string> {
    const key = `${userId}:${accountId}`;
    if (this.refreshInFlight.has(key)) {
      return this.refreshInFlight.get(key)!;
    }
    const promise = (async () => {
      const secrets = await getGoogleAdsCredentials();
      const response = await axios.post(TOKEN_REFRESH_URL, new URLSearchParams({
        client_id: secrets.clientId,
        client_secret: secrets.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: GOOGLE_ADS_HTTP_TIMEOUT_MS,
      });
      const { access_token, expires_in } = response.data as { access_token: string; expires_in: number };
      await updateAccountTokens(userId, 'google_ads', {
        access_token,
        token_expires_at: Date.now() + expires_in * 1000,
      }, accountId);
      return access_token;
    })();
    this.refreshInFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.refreshInFlight.delete(key);
    }
  }

  // ── Account credentials + ownership validation ───────────────────────────

  async getAccountCredentials(userId: string, customerId: string): Promise<GoogleAdsAccountCredentials> {
    // Source accounts from the org-shared set so a teammate's Google Ads account
    // shared with the org (sharedWithOrg=true) is usable, not just visible. Each
    // account carries its owner userId so a token refresh updates the owner's record.
    const { getAccountsWithOwnerIncludingOrgShared } = await import('./connectedAccountsDb');
    const accounts = await getAccountsWithOwnerIncludingOrgShared(userId);

    const account = accounts.find(
      (a: any) => a.platform === 'google_ads' && a.config?.customer_id === customerId
    );
    if (!account) throw this.makeAuthError('Google Ads account not found in your connected accounts. Connect it in Settings.');

    const cfg = account.config as any;
    let accessToken = cfg.access_token;
    const isExpired = cfg.token_expires_at && Date.now() > cfg.token_expires_at - 60_000;
    if (isExpired && cfg.refresh_token) {
      accessToken = await this.refreshAccessToken(account.userId, account.account_id, cfg.refresh_token);
    }

    if (!accessToken) {
      throw this.makeAuthError('No access token available. Please reconnect your Google Ads account in Settings.');
    }

    return {
      accessToken,
      customerId,
      currency: cfg.currency || 'USD',
      loginCustomerId: cfg.login_customer_id || customerId,
    };
  }

  // ── Account listing (used during OAuth finalize) ─────────────────────────
  // Builds a 2-level selection tree:
  //   level 0 — standalone/direct leaf accounts AND manager (MCC) accounts the user can access
  //   level 1 — leaf accounts managed under a level-0 manager (descendants flattened to one list)
  // A leaf the user can access both directly and through a discovered manager is shown only
  // under the manager (deduped out of the top level). Managers themselves are not connectable.

  /**
   * @param diagnostics Optional out-param (same trade-off as `search`'s `completeness`): ids Google lists as
   *   accessible but refuses to read with CUSTOMER_NOT_ENABLED — an account whose signup was started and never
   *   finished (or that was deactivated). They are not connectable, but "you have no account" would be untrue.
   */
  async listAccountHierarchy(accessToken: string, diagnostics?: { notEnabledCustomerIds?: string[] }): Promise<GoogleAdsAccountNode[]> {
    const secrets = await getGoogleAdsCredentials();
    const response = await axios.get(`${GOOGLE_ADS_API_BASE}/customers:listAccessibleCustomers`, {
      timeout: GOOGLE_ADS_HTTP_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'developer-token': secrets.developerToken,
      },
    });

    const resourceNames: string[] = (response.data as { resourceNames?: string[] }).resourceNames || [];
    if (resourceNames.length === 0) return [];

    const directLeaves = new Map<string, GoogleAdLeaf>(); // customerId → level-0 direct/standalone leaf
    const managers: { customerId: string; name: string; children: GoogleAdLeaf[] }[] = [];
    const managedLeafIds = new Set<string>(); // ids appearing under any manager (for dedupe)

    for (const resourceName of resourceNames) {
      const customerId = resourceName.replace('customers/', '');
      try {
        const results = await this.search(customerId, accessToken,
          'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager, customer.test_account FROM customer LIMIT 1'
        );
        if (results.length === 0) continue;
        const c = results[0].customer;
        const id = String(c.id);
        if (c.manager === true) {
          // A failure enumerating a manager's children must NOT drop the whole manager —
          // otherwise an MCC-only user (whose accounts are all under one manager) is shown a
          // fake "no accounts" state. Surface the manager with whatever resolved (possibly no
          // children) and log the gap so a transient/partial failure is diagnosable.
          let children: GoogleAdLeaf[] = [];
          try {
            children = await this.listManagerLeaves(id, accessToken);
          } catch (err: any) {
            console.warn(`[GoogleAds] listAccountHierarchy: could not load child accounts for manager ${id}:`, err?.message || err);
          }
          children.forEach(ch => managedLeafIds.add(ch.customerId));
          managers.push({ customerId: id, name: c.descriptiveName || customerId, children });
        } else {
          directLeaves.set(id, {
            customerId: id,
            name: c.descriptiveName || customerId,
            currency: c.currencyCode || 'USD',
            loginCustomerId: id,
            // Strict === true: anything Google did not affirmatively mark as a test
            // account is billable, and an absent field must never read as safe.
            testAccount: c.testAccount === true,
          });
        }
      } catch (err: any) {
        // Couldn't even identify this account — skip it, but log so the drop isn't silent.
        if (diagnostics && isCustomerNotEnabled(err)) (diagnostics.notEnabledCustomerIds ??= []).push(customerId);
        console.warn(`[GoogleAds] listAccountHierarchy: skipping customer ${customerId} (probe failed):`, err?.message || err);
      }
    }

    const nodes: GoogleAdsAccountNode[] = [];
    // Top-level leaves first (those not also managed by a discovered manager), then managers.
    for (const [id, leaf] of directLeaves) {
      if (!managedLeafIds.has(id)) {
        nodes.push({ type: 'leaf', customerId: leaf.customerId, name: leaf.name, currency: leaf.currency, loginCustomerId: leaf.loginCustomerId, testAccount: leaf.testAccount });
      }
    }
    for (const m of managers) {
      nodes.push({ type: 'manager', customerId: m.customerId, name: m.name, children: m.children });
    }
    return nodes;
  }

  /**
   * ENG-1362. Google's `test_account` flag for one connected account.
   *
   * Only needed for accounts connected BEFORE discovery started capturing it — new
   * connections carry it in their stored config and never reach this. Cached for the
   * life of the process because the flag is immutable: Google fixes it when the account
   * is created and provides no way to change it afterwards.
   *
   * Returns `null` when the lookup fails, and callers must treat null as BILLABLE. An
   * account we could not verify is not an account we may describe as safe — that is the
   * whole point of reading the flag instead of the name.
   */
  private testAccountCache = new Map<string, boolean>();

  async isTestAccount(userId: string, customerId: string): Promise<boolean | null> {
    const cached = this.testAccountCache.get(customerId);
    if (cached !== undefined) return cached;
    try {
      const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
      const rows = await this.search(
        customerId, accessToken,
        'SELECT customer.id, customer.test_account FROM customer LIMIT 1',
        loginCustomerId,
      );
      const value = rows[0]?.customer?.testAccount === true;
      this.testAccountCache.set(customerId, value);
      return value;
    } catch (err: any) {
      // Deliberately not cached: a transient failure must not pin this account as
      // "unknown" for the life of the process.
      console.warn(`[GoogleAds] isTestAccount(${customerId}) failed; reporting unknown:`, err?.message || err);
      return null;
    }
  }

  // Enumerate every enabled non-manager leaf under a manager (descendants at any depth,
  // flattened). login-customer-id must be the manager id for these queries and for all
  // later API calls against these leaves.
  private async listManagerLeaves(managerId: string, accessToken: string): Promise<GoogleAdLeaf[]> {
    const results = await this.search(managerId, accessToken,
      "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.status, customer_client.test_account FROM customer_client WHERE customer_client.manager = false AND customer_client.status = 'ENABLED'",
      managerId,
    );
    const leaves: GoogleAdLeaf[] = [];
    const seen = new Set<string>();
    for (const r of results) {
      const cc = r.customerClient;
      if (!cc || cc.manager === true) continue;
      const id = String(cc.id);
      if (id === managerId || seen.has(id)) continue;
      seen.add(id);
      leaves.push({
        customerId: id,
        name: cc.descriptiveName || id,
        currency: cc.currencyCode || 'USD',
        loginCustomerId: managerId,
        testAccount: cc.testAccount === true,
      });
    }
    return leaves;
  }

  // Flatten the selection tree to the list of connectable leaves (used to validate /connect).
  flattenConnectableLeaves(nodes: GoogleAdsAccountNode[]): GoogleAdLeaf[] {
    const out: GoogleAdLeaf[] = [];
    for (const n of nodes) {
      if (n.type === 'leaf') {
        out.push({ customerId: n.customerId, name: n.name, currency: n.currency, loginCustomerId: n.loginCustomerId, testAccount: n.testAccount });
      } else {
        out.push(...n.children);
      }
    }
    return out;
  }

  // ── Budgets ──────────────────────────────────────────────────────────────

  async createBudget(userId: string, customerId: string, params: {
    name: string;
    amountMicros: number;
    explicitlyShared?: boolean;
  }): Promise<{ resourceName: string }> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const data = await this.mutate(customerId, accessToken, 'campaignBudgets', [{
      create: {
        name: params.name,
        amountMicros: String(params.amountMicros),
        deliveryMethod: 'STANDARD',
        explicitlyShared: params.explicitlyShared ?? false,
      },
    }], loginCustomerId);
    return { resourceName: data.results[0].resourceName };
  }

  async updateBudget(userId: string, customerId: string, budgetResourceName: string, amountMicros: number): Promise<void> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'campaignBudgets', [{
      update: { resourceName: budgetResourceName, amountMicros: String(amountMicros) },
      updateMask: 'amount_micros',
    }], loginCustomerId);
    await this.verifyFieldsReadBack(customerId, accessToken, 'campaign_budget', budgetResourceName,
      { amountMicros: { gaql: 'amount_micros', value: amountMicros } }, loginCustomerId);
  }

  async removeBudget(userId: string, customerId: string, budgetResourceName: string): Promise<void> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'campaignBudgets', [{ remove: budgetResourceName }], loginCustomerId);
    await this.verifyRemovedReadBack(customerId, accessToken, 'campaign_budget', budgetResourceName, loginCustomerId);
  }

  async listBudgets(userId: string, customerId: string): Promise<{ resourceName: string; name: string; amountMicros: string; explicitlyShared: boolean; referenceCount: number }[]> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const results = await this.search(customerId, accessToken,
      'SELECT campaign_budget.resource_name, campaign_budget.name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count FROM campaign_budget ORDER BY campaign_budget.name',
      loginCustomerId,
    );
    return results.map((r: any) => ({
      resourceName: r.campaignBudget.resourceName,
      name: r.campaignBudget.name,
      amountMicros: r.campaignBudget.amountMicros,
      explicitlyShared: r.campaignBudget.explicitlyShared,
      referenceCount: r.campaignBudget.referenceCount,
    }));
  }

  // ── Conversion actions (ENG-1322) ─────────────────────────────────────────
  //
  // CREATE / LIST / UPDATE only. REMOVE is deliberately not implemented (Harsha,
  // ENG-1329): removing a conversion action severs historical attribution in the
  // customer's account, and it is the one operation whose damage we cannot undo
  // from our side. Pausing via UPDATE covers what an operator actually needs.

  /** The fields a conversion action's tag and reporting behaviour actually hinge on. */
  private conversionActionSelect(): string {
    return 'SELECT conversion_action.resource_name, conversion_action.id, conversion_action.name, '
      + 'conversion_action.status, conversion_action.type, conversion_action.category, '
      + 'conversion_action.counting_type, conversion_action.primary_for_goal, '
      + 'conversion_action.include_in_conversions_metric, '
      + 'conversion_action.click_through_lookback_window_days, conversion_action.tag_snippets '
      + 'FROM conversion_action';
  }

  private mapConversionAction(row: any): any {
    const ca = row.conversionAction || {};
    return {
      resourceName: ca.resourceName,
      id: ca.id,
      name: ca.name,
      status: ca.status,
      type: ca.type,
      category: ca.category,
      countingType: ca.countingType,
      primaryForGoal: ca.primaryForGoal,
      includeInConversionsMetric: ca.includeInConversionsMetric,
      clickThroughLookbackWindowDays: ca.clickThroughLookbackWindowDays,
      tagSnippets: ca.tagSnippets,
      // The pair the page actually needs. A resource name cannot be installed.
      tag: parseTagSnippets(ca.tagSnippets),
    };
  }

  async listConversionActions(userId: string, customerId: string): Promise<any[]> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const results = await this.search(customerId, accessToken, this.conversionActionSelect(), loginCustomerId);
    return results.map((r: any) => this.mapConversionAction(r));
  }

  private async getConversionActionByResourceName(
    customerId: string, accessToken: string, resourceName: string, loginCustomerId?: string,
  ): Promise<any | null> {
    const escaped = resourceName.replace(/'/g, "\\'");
    const rows = await this.search(
      customerId, accessToken,
      `${this.conversionActionSelect()} WHERE conversion_action.resource_name = '${escaped}'`,
      loginCustomerId,
    );
    return rows.length > 0 ? this.mapConversionAction(rows[0]) : null;
  }

  /**
   * Create a conversion action and hand back the tag pair, not just a resource name.
   *
   * Two things this deliberately does NOT do. It does not default `countingType` —
   * that field fails silently and picking for the customer is how reported
   * conversions quietly inflate. And it does not trust the create: the action is
   * read back and diffed field by field, because `createAdGroup`/`createAd` already
   * prove a create can return success while storing something else (ENG-1293).
   */
  async createConversionAction(userId: string, customerId: string, params: {
    name: string;
    category: string;
    countingType: string;
    status?: string;
    primaryForGoal?: boolean;
    clickThroughLookbackWindowDays?: number;
  }): Promise<{ resourceName: string; tag: ConversionTagPair | null; stored: any; drift: ConversionActionDrift[] }> {
    if (!params?.name || !params.name.trim()) {
      throw new Error('name is required to create a conversion action.');
    }
    if (!params?.category || !params.category.trim()) {
      throw new Error(
        'category is required and is never inferred — it decides how Google reports and optimises '
        + 'this action (for example SUBMIT_LEAD_FORM, PURCHASE, SIGNUP, DOWNLOAD).',
      );
    }
    const countingType = assertCountingType(params.countingType);

    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const create: any = {
      name: params.name,
      type: 'WEBPAGE',
      category: params.category,
      countingType,
      // Validated, not passed through: ConversionActionStatus has no PAUSED, and an
      // unvalidated value returns an opaque 400 (ENG-1329 e2e).
      //
      // Keyed on `undefined`, not falsiness. `status: ''` is a supplied-but-invalid value,
      // and treating it as "omitted" would silently create an ENABLED action off a request
      // the caller got wrong — the same silent-substitution the PAUSED fix exists to stop,
      // and inconsistent with updateConversionAction, which validates every defined status.
      status: params.status === undefined ? 'ENABLED' : assertCreatableConversionActionStatus(params.status),
    };
    if (params.primaryForGoal !== undefined) create.primaryForGoal = params.primaryForGoal;
    if (params.clickThroughLookbackWindowDays !== undefined) {
      create.clickThroughLookbackWindowDays = params.clickThroughLookbackWindowDays;
    }

    const data = await this.mutate(customerId, accessToken, 'conversionActions', [{ create }], loginCustomerId);
    const resourceName = data.results[0].resourceName;

    const stored = await this.getConversionActionByResourceName(customerId, accessToken, resourceName, loginCustomerId);
    const requested: Record<string, unknown> = {
      name: params.name, category: params.category, countingType, status: create.status,
    };
    if (params.primaryForGoal !== undefined) requested.primaryForGoal = params.primaryForGoal;
    // Every field we SEND has to be a field we CHECK, or drift on it is invisible.
    // A silently-widened attribution window misattributes conversions for weeks.
    if (params.clickThroughLookbackWindowDays !== undefined) {
      requested.clickThroughLookbackWindowDays = params.clickThroughLookbackWindowDays;
    }

    return {
      resourceName,
      tag: stored?.tag ?? null,
      stored,
      drift: diffConversionAction(requested, stored || {}),
    };
  }

  /**
   * Amend an existing conversion action. Only the fields supplied are sent, so an
   * omitted field is left alone rather than reset — and `countingType`, when given,
   * still goes through the same no-inference check as on create.
   */
  async updateConversionAction(userId: string, customerId: string, resourceName: string, params: {
    name?: string;
    status?: string;
    category?: string;
    countingType?: string;
    primaryForGoal?: boolean;
    clickThroughLookbackWindowDays?: number;
  }): Promise<{ resourceName: string; stored: any; drift: ConversionActionDrift[] }> {
    if (!resourceName) throw new Error('conversion_action_resource_name is required for CONVERSION_ACTION UPDATE.');

    const update: any = { resourceName };
    const updateMask: string[] = [];
    const requested: Record<string, unknown> = {};

    if (params.name !== undefined) { update.name = params.name; updateMask.push('name'); requested.name = params.name; }
    if (params.status !== undefined) {
      const status = assertConversionActionStatus(params.status);
      // status=REMOVED reaches the same end as the REMOVE operation, and REMOVE carries the
      // confirmation gate. Route it there rather than letting UPDATE be an unconfirmed
      // back door to the same irreversible change.
      if (status === 'REMOVED') {
        throw new Error(
          'To stop a conversion action recording, use CONVERSION_ACTION REMOVE with '
          + 'confirm_conversion_action_removal=true rather than UPDATE status=REMOVED — the '
          + 'change is permanent and cannot be re-enabled, so it goes through the confirmation '
          + 'step. Conversions already recorded stay in your reports either way.',
        );
      }
      update.status = status; updateMask.push('status'); requested.status = status;
    }
    if (params.category !== undefined) { update.category = params.category; updateMask.push('category'); requested.category = params.category; }
    if (params.countingType !== undefined) {
      const countingType = assertCountingType(params.countingType);
      update.countingType = countingType; updateMask.push('counting_type'); requested.countingType = countingType;
    }
    if (params.primaryForGoal !== undefined) {
      update.primaryForGoal = params.primaryForGoal; updateMask.push('primary_for_goal'); requested.primaryForGoal = params.primaryForGoal;
    }
    if (params.clickThroughLookbackWindowDays !== undefined) {
      update.clickThroughLookbackWindowDays = params.clickThroughLookbackWindowDays;
      updateMask.push('click_through_lookback_window_days');
      requested.clickThroughLookbackWindowDays = params.clickThroughLookbackWindowDays;
    }

    if (updateMask.length === 0) {
      throw new Error('CONVERSION_ACTION UPDATE requires at least one field to change.');
    }

    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'conversionActions',
      [{ update, updateMask: updateMask.join(',') }], loginCustomerId);

    const stored = await this.getConversionActionByResourceName(customerId, accessToken, resourceName, loginCustomerId);
    return { resourceName, stored, drift: diffConversionAction(requested, stored || {}) };
  }

  /**
   * ENG-2804. Conversion GOALS (category~origin pairs) decide what smart bidding
   * optimises. Codeless (WEBPAGE_CODELESS) and Universal Analytics actions refuse
   * CONVERSION_ACTION UPDATE with MUTATE_NOT_ALLOWED, so the only API lever to stop
   * them driving bidding is the goal's `biddable` flag — at the campaign level
   * (CampaignConversionGoal) or the account default (CustomerConversionGoal).
   * Update is the only mutate Google offers for either; nothing is created or removed.
   */
  async listConversionGoals(
    userId: string, customerId: string, level: 'CAMPAIGN' | 'CUSTOMER', campaignId?: string,
  ): Promise<Array<{ resourceName: string; campaign?: string; category: string; origin: string; biddable: boolean }>> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const rows = await this.search(customerId, accessToken, this.conversionGoalQuery(level, campaignId), loginCustomerId);
    return rows.map((r: any) => this.mapConversionGoal(level, r));
  }

  async updateConversionGoalBiddable(
    userId: string, customerId: string, level: 'CAMPAIGN' | 'CUSTOMER', resourceName: string, biddable: boolean,
  ): Promise<{ resourceName: string; stored: any; drift: ConversionActionDrift[] }> {
    if (!resourceName) throw new Error('resource_name is required for conversion goal UPDATE.');
    if (typeof biddable !== 'boolean') throw new Error('biddable (true/false) is required for conversion goal UPDATE.');
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const resource = level === 'CAMPAIGN' ? 'campaignConversionGoals' : 'customerConversionGoals';
    await this.mutate(customerId, accessToken, resource,
      [{ update: { resourceName, biddable }, updateMask: 'biddable' }], loginCustomerId);

    const field = level === 'CAMPAIGN' ? 'campaign_conversion_goal' : 'customer_conversion_goal';
    const escaped = resourceName.replace(/'/g, "\\'");
    const rows = await this.search(
      customerId, accessToken,
      `${this.conversionGoalQuery(level)} WHERE ${field}.resource_name = '${escaped}'`,
      loginCustomerId,
    );
    const stored = rows.length > 0 ? this.mapConversionGoal(level, rows[0]) : null;
    const drift: ConversionActionDrift[] = [];
    if (!stored || stored.biddable !== biddable) {
      drift.push({ field: 'biddable', requested: biddable, stored: stored ? stored.biddable : undefined } as ConversionActionDrift);
    }
    return { resourceName, stored, drift };
  }

  private conversionGoalQuery(level: 'CAMPAIGN' | 'CUSTOMER', campaignId?: string): string {
    if (level === 'CAMPAIGN') {
      const base = 'SELECT campaign_conversion_goal.resource_name, campaign_conversion_goal.campaign, '
        + 'campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable '
        + 'FROM campaign_conversion_goal';
      if (campaignId !== undefined) {
        if (!/^\d+$/.test(String(campaignId))) throw new Error(`campaign_id must be numeric, got ${campaignId}.`);
        return `${base} WHERE campaign.id = ${campaignId}`;
      }
      return base;
    }
    return 'SELECT customer_conversion_goal.resource_name, customer_conversion_goal.category, '
      + 'customer_conversion_goal.origin, customer_conversion_goal.biddable FROM customer_conversion_goal';
  }

  private mapConversionGoal(level: 'CAMPAIGN' | 'CUSTOMER', row: any) {
    const g = (level === 'CAMPAIGN' ? row?.campaignConversionGoal : row?.customerConversionGoal) || {};
    return {
      resourceName: g.resourceName,
      ...(level === 'CAMPAIGN' ? { campaign: g.campaign } : {}),
      category: g.category,
      origin: g.origin,
      biddable: g.biddable === true,
    };
  }

  /**
   * Retire a conversion action. Google models this as a soft state, not a delete: the
   * action stops recording, and conversions it already recorded stay in reporting — the
   * same way a REMOVED campaign still returns its historical metrics.
   *
   * Scope note: ENG-1329 deferred this, on the stated basis that removal "severs historical
   * attribution". The end-to-end run showed that premise is only half right — it cannot be
   * undone, but nothing already attributed is lost — and that HIDDEN, the alternative every
   * earlier message recommended, cannot be set through the API at all. That left no working
   * retire path, which is the "if REMOVE is needed later" case that decision anticipated.
   *
   * The caller-facing confirmation lives in the handler, not here, so this stays a plain
   * service method like removeBudget/removeCampaign.
   */
  async removeConversionAction(userId: string, customerId: string, resourceName: string): Promise<void> {
    if (!resourceName) throw new Error('conversion_action_resource_name is required for CONVERSION_ACTION REMOVE.');
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'conversionActions', [{ remove: resourceName }], loginCustomerId);
    await this.verifyRemovedReadBack(customerId, accessToken, 'conversion_action', resourceName, loginCustomerId);
  }

  /**
   * The account's own IANA time zone, read from Google rather than assumed.
   *
   * Offline conversion timestamps are interpreted in the ACCOUNT's zone. Defaulting to
   * UTC would shift every conversion by the account's real offset — for the INR account
   * this work was verified against, 5.5 hours — and the only symptom is conversions
   * attributed to the wrong day, which reads as a reporting oddity rather than a bug.
   */
  async getAccountTimeZone(userId: string, customerId: string): Promise<string> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const rows = await this.search(
      customerId, accessToken,
      'SELECT customer.time_zone FROM customer LIMIT 1',
      loginCustomerId,
    );
    const tz = rows?.[0]?.customer?.timeZone;
    if (!tz) throw new Error('Could not read the account time zone, so a conversion timestamp cannot be placed correctly.');
    return tz;
  }

  /**
   * Upload offline conversions keyed on gclid (ENG-1325).
   *
   * `partialFailure` is on deliberately. A sweep of fifty leads where one click has aged
   * past its lookback window should upload forty-nine, not zero — an all-or-nothing batch
   * turns one stale row into a silent gap across the whole run. The caller gets the
   * per-row failures back so "uploaded" never quietly means "some of them".
   *
   * `validateOnly` exists for the same reason the drift read-back does: this runs from a
   * background sweep with nobody watching, so being able to rehearse a batch before
   * committing it is the difference between a caught mistake and a discovered one.
   */
  async uploadClickConversions(
    userId: string,
    customerId: string,
    conversions: Record<string, unknown>[],
    opts?: { validateOnly?: boolean },
  ): Promise<{ uploaded: number; failures: ConversionUploadFailure[]; raw: any }> {
    if (!Array.isArray(conversions) || conversions.length === 0) {
      throw new Error('At least one conversion is required for an offline conversion upload.');
    }
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const raw = await this.callApiPublic(
      'POST',
      // `resource:method`, not a sub-collection. Verified against the real API: the
      // sub-collection form returned Google's own 404 naming the URL
      // `/v24/customers/…/conversionUploads:uploadClickConversions`. Same shape as the
      // two other custom methods in this service, `customers:listAccessibleCustomers`
      // and `geoTargetConstants:suggest`.
      `/customers/${customerId}:uploadClickConversions`,
      accessToken,
      { conversions, partialFailure: true, validateOnly: opts?.validateOnly === true },
      loginCustomerId,
    );
    const failures = summarizePartialFailure(raw);
    // Counted from what Google accepted, not from what we sent — those differ exactly
    // when partial failure fires, which is the case this reporting exists for.
    return { uploaded: Math.max(0, conversions.length - failures.length), failures, raw };
  }

  // ── Portfolio (shared) bidding strategies ─────────────────────────────────

  async listBiddingStrategies(userId: string, customerId: string): Promise<{ resourceName: string; id: string; name: string; type: string; status: string }[]> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const results = await this.search(customerId, accessToken,
      'SELECT bidding_strategy.resource_name, bidding_strategy.id, bidding_strategy.name, bidding_strategy.type, bidding_strategy.status FROM bidding_strategy ORDER BY bidding_strategy.name',
      loginCustomerId,
    );
    return results.map((r: any) => ({
      resourceName: r.biddingStrategy.resourceName,
      id: String(r.biddingStrategy.id),
      name: r.biddingStrategy.name,
      type: r.biddingStrategy.type,
      status: r.biddingStrategy.status,
    }));
  }

  // ── Campaigns ────────────────────────────────────────────────────────────

  /**
   * ENG-1913: read-only per-campaign delivery input for the account-health zero-delivery check.
   * Status + approved daily budget + go-live time, joined with impressions/clicks over the last
   * 7 days. Throws on any incomplete read: a partial read must never become "zero delivery".
   * A campaign absent from the metrics rows had no delivery in the window (Google omits
   * all-zero metric rows), which is only trusted because every read completed.
   *
   * Go-live: `campaign.start_date_time` is only the scheduled start, not when the campaign was
   * last turned on (a campaign paused for weeks and re-enabled an hour ago keeps its old start).
   * The API has no "enabled since" field, so `liveSince` is the later of the start and the most
   * recent `change_event` on the campaign in the metrics window; any recent edit restarts the
   * grace period, which can only suppress a verdict, never create one.
   *
   * Ended: an elapsed `campaign.end_date_time` leaves status ENABLED, so it is reported as
   * `ENDED` (excluded by the classifier). Date-times are in the account timezone and are read
   * as UTC, so they can be off by the UTC-12..+14 range: an end counts as passed 14h early and
   * `liveSince` is pushed 12h late, both toward abstaining.
   */
  async getCampaignDelivery(userId: string, customerId: string, nowMs: number = Date.now()): Promise<Array<{
    campaignId: string; status: string; approvedDailyBudget: number; liveSince: string; impressions: number; clicks: number;
  }>> {
    const HOUR = 3_600_000;
    const CHANGE_EVENT_LIMIT = 10_000; // GAQL requires a LIMIT (max 10000) on change_event
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const read = async (query: string): Promise<any[]> => {
      const completeness: { truncated?: boolean } = {};
      const rows = await this.search(customerId, accessToken, query, loginCustomerId, completeness);
      if (completeness.truncated) throw new Error('Incomplete Google Ads read');
      return rows;
    };
    // "yyyy-MM-dd HH:mm:ss[.ffffff]" (account timezone) -> epoch ms read as UTC, or NaN.
    const parseLocal = (value: unknown): number => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return NaN;
      return Date.parse(`${value.slice(0, 10)}T${value.slice(11, 19) || '00:00:00'}Z`);
    };
    const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    const config = await read("SELECT campaign.id, campaign.status, campaign.start_date_time, campaign.end_date_time, campaign_budget.amount_micros, campaign_budget.status FROM campaign WHERE campaign.status != 'REMOVED'");
    const metrics = await read("SELECT campaign.id, metrics.impressions, metrics.clicks FROM campaign WHERE campaign.status != 'REMOVED' AND segments.date DURING LAST_7_DAYS");
    const changes = await this.search(customerId, accessToken,
      `SELECT change_event.campaign, change_event.change_date_time FROM change_event WHERE change_event.change_resource_type = 'CAMPAIGN' AND change_event.change_date_time >= '${stamp(nowMs - 8 * 24 * HOUR)}' AND change_event.change_date_time <= '${stamp(nowMs + 24 * HOUR)}' ORDER BY change_event.change_date_time DESC LIMIT ${CHANGE_EVENT_LIMIT}`,
      loginCustomerId);
    if (changes.length >= CHANGE_EVENT_LIMIT) throw new Error('Incomplete Google Ads read');
    const lastChange = new Map<string, number>();
    for (const row of changes) {
      const id = /\/campaigns\/(\d+)$/.exec(String(row.changeEvent?.campaign ?? ''))?.[1];
      const at = parseLocal(row.changeEvent?.changeDateTime);
      if (!id || !Number.isFinite(at)) throw new Error('Malformed Google Ads change event row');
      lastChange.set(id, Math.max(lastChange.get(id) ?? 0, at));
    }
    const delivered = new Map<string, { impressions: number; clicks: number }>();
    for (const row of metrics) {
      const id = String(row.campaign?.id ?? '');
      if (!id) throw new Error('Malformed Google Ads metrics row');
      const prev = delivered.get(id) ?? { impressions: 0, clicks: 0 };
      delivered.set(id, {
        impressions: prev.impressions + Number(row.metrics?.impressions ?? 0),
        clicks: prev.clicks + Number(row.metrics?.clicks ?? 0),
      });
    }
    return config.map((row: any) => {
      const id = String(row.campaign?.id ?? '');
      if (!id) throw new Error('Malformed Google Ads campaign row');
      const startMs = parseLocal(row.campaign?.startDateTime);
      const liveMs = Number.isFinite(startMs) ? Math.max(startMs, lastChange.get(id) ?? 0) + 12 * HOUR : NaN;
      const endMs = parseLocal(row.campaign?.endDateTime);
      const ended = Number.isFinite(endMs) && endMs - 14 * HOUR <= nowMs;
      const budgetEnabled = row.campaignBudget?.status === undefined || row.campaignBudget.status === 'ENABLED';
      const amount = Number(row.campaignBudget?.amountMicros ?? 0);
      const d = delivered.get(id) ?? { impressions: 0, clicks: 0 };
      const status = String(row.campaign?.status ?? 'UNKNOWN');
      return {
        campaignId: id,
        status: ended && status === 'ENABLED' ? 'ENDED' : status,
        approvedDailyBudget: budgetEnabled && Number.isFinite(amount) ? amount / 1_000_000 : 0,
        liveSince: Number.isFinite(liveMs) ? new Date(liveMs).toISOString() : '',
        impressions: d.impressions,
        clicks: d.clicks,
      };
    });
  }

  /** @param completeness Optional out-param — see `search`. Set when the page cap truncated the read. */
  async listCampaigns(userId: string, customerId: string, completeness?: { truncated?: boolean }): Promise<{ resourceName: string; id: string; name: string; status: string; type: string }[]> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const results = await this.search(customerId, accessToken,
      'SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign ORDER BY campaign.id',
      loginCustomerId,
      completeness,
    );
    return results.map((r: any) => ({
      resourceName: r.campaign.resourceName,
      id: String(r.campaign.id),
      name: r.campaign.name,
      status: r.campaign.status,
      type: r.campaign.advertisingChannelType,
    }));
  }

  async createCampaign(userId: string, customerId: string, params: {
    name: string;
    type: 'SEARCH' | 'DISPLAY' | 'PERFORMANCE_MAX';
    budgetResourceName: string;
    biddingStrategy?: 'MAXIMIZE_CONVERSIONS' | 'TARGET_CPA' | 'TARGET_ROAS' | 'MAXIMIZE_CONVERSION_VALUE' | 'TARGET_IMPRESSION_SHARE' | 'TARGET_SPEND' | 'MANUAL_CPC';
    biddingStrategyResourceName?: string;
    biddingStrategyTarget?: number;
    cpcBidCeilingMicros?: number;
    locationTargetIds: number[];
    status?: 'ENABLED' | 'PAUSED';
    brandBusinessName?: string;
    brandLogoAssetResourceName?: string;
  }): Promise<{ resourceName: string }> {

    // DISPLAY campaigns cannot use MAXIMIZE_CONVERSIONS with a shared budget
    if (params.type === 'DISPLAY' && params.biddingStrategy === 'MAXIMIZE_CONVERSIONS') {
      throw new Error('DISPLAY campaigns do not support MAXIMIZE_CONVERSIONS with a shared budget. Use MANUAL_CPC or TARGET_CPA instead.');
    }

    if (params.biddingStrategy && params.biddingStrategyResourceName) {
      throw new Error('Provide either bidding_strategy (a standard strategy) or bidding_strategy_resource_name (a portfolio/shared strategy), not both.');
    }
    assertBidTargetIsAddressable(params);
    if (!params.biddingStrategy && !params.biddingStrategyResourceName) {
      throw new Error('A campaign requires a bidding strategy: pass bidding_strategy (standard) or bidding_strategy_resource_name (portfolio/shared).');
    }

    const biddingField: Record<string, any> = {};
    // Portfolio/shared strategy: attach by resource-name reference on campaign.bidding_strategy.
    if (params.biddingStrategyResourceName) biddingField.biddingStrategy = params.biddingStrategyResourceName;
    // A supplied target is carried, matching updateCampaign. This branch used to emit `{}`
    // unconditionally, so a target sent at CREATE was dropped while the same call at UPDATE
    // applied it — the campaign launched optimising to no target at all.
    else if (params.biddingStrategy === 'MAXIMIZE_CONVERSIONS') biddingField.maximizeConversions =
      params.biddingStrategyTarget !== undefined
        ? { targetCpaMicros: String(Math.round(params.biddingStrategyTarget * 1_000_000)) }
        : {};
    else if (params.biddingStrategy === 'MAXIMIZE_CONVERSION_VALUE') biddingField.maximizeConversionValue =
      params.biddingStrategyTarget !== undefined ? { targetRoas: params.biddingStrategyTarget } : {};
    else if (params.biddingStrategy === 'TARGET_CPA') biddingField.targetCpa = { targetCpaMicros: String(Math.round((params.biddingStrategyTarget || 0) * 1_000_000)) };
    else if (params.biddingStrategy === 'TARGET_ROAS') biddingField.targetRoas = { targetRoas: params.biddingStrategyTarget || 1 };
    else if (params.biddingStrategy === 'TARGET_IMPRESSION_SHARE') biddingField.targetImpressionShare = {
      location: 'ANYWHERE_ON_PAGE',
      locationFractionMicros: String(Math.round((params.biddingStrategyTarget || 1) * 1_000_000)),
      cpcBidCeilingMicros: String(params.cpcBidCeilingMicros ?? 100_000_000),
    };
    else if (params.biddingStrategy === 'MANUAL_CPC') biddingField.manualCpc = { enhancedCpcEnabled: false };
    else if (params.biddingStrategy === 'TARGET_SPEND') {
      // Uncapped is valid on CREATE (empty target_spend). A provided ceiling must be positive —
      // Google rejects 0 as TOO_LOW — so reject <= 0 locally rather than send it and get an opaque error.
      if (params.cpcBidCeilingMicros !== undefined && params.cpcBidCeilingMicros <= 0) {
        throw new Error('TARGET_SPEND (Maximize Clicks) requires a positive cpc_bid_ceiling_micros, or omit it for an uncapped strategy. A ceiling of 0 is rejected by Google as TOO_LOW.');
      }
      biddingField.targetSpend = params.cpcBidCeilingMicros !== undefined
        ? { cpcBidCeilingMicros: String(params.cpcBidCeilingMicros) }
        : {};
    }
    else throw new Error(`Unsupported bidding_strategy '${params.biddingStrategy}' for CAMPAIGN CREATE. Supported values: MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE, TARGET_CPA, TARGET_ROAS, TARGET_IMPRESSION_SHARE, TARGET_SPEND, MANUAL_CPC.`);

    // Credentials are loaded only AFTER every local validation above, matching
    // updateCampaign. Loading them first meant an invalid request could trigger a token
    // refresh and rewrite the stored tokens on its way to being rejected, and a caller
    // with an expired connection got an authentication error instead of the validation
    // error that actually described their mistake.
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);

    const campaignCreate = {
      name: params.name,
      advertisingChannelType: params.type,
      campaignBudget: params.budgetResourceName,
      status: params.status || 'PAUSED',
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      ...biddingField,
    };

    let campaignResourceName: string;

    if (params.type === 'PERFORMANCE_MAX' && (params.brandBusinessName || params.brandLogoAssetResourceName)) {
      const tempCampaignName = `customers/${customerId}/campaigns/-1`;
      const mutateOps: any[] = [];
      let textAssetIndex = -1;

      if (params.brandBusinessName) {
        textAssetIndex = mutateOps.length;
        mutateOps.push({
          assetOperation: {
            create: {
              resourceName: `customers/${customerId}/assets/-2`,
              name: params.brandBusinessName.substring(0, 50),
              type: 'TEXT',
              textAsset: { text: params.brandBusinessName },
            },
          },
        });
      }

      mutateOps.push({ campaignOperation: { create: { resourceName: tempCampaignName, ...campaignCreate } } });

      if (params.brandBusinessName) {
        mutateOps.push({
          campaignAssetOperation: {
            create: { campaign: tempCampaignName, asset: `customers/${customerId}/assets/-2`, fieldType: 'BUSINESS_NAME' },
          },
        });
      }
      if (params.brandLogoAssetResourceName) {
        mutateOps.push({
          campaignAssetOperation: {
            create: { campaign: tempCampaignName, asset: params.brandLogoAssetResourceName, fieldType: 'LOGO' },
          },
        });
      }

      const batchResult = await this.batchMutate(customerId, accessToken, mutateOps, loginCustomerId);
      const campaignOpIndex = params.brandBusinessName ? 1 : 0;
      campaignResourceName = batchResult.mutateOperationResponses[campaignOpIndex].campaignResult.resourceName;
    } else {
      const data = await this.mutate(customerId, accessToken, 'campaigns', [{ create: campaignCreate }], loginCustomerId);
      campaignResourceName = data.results[0].resourceName;
    }

    if (params.locationTargetIds.length > 0) {
      await this.mutate(customerId, accessToken, 'campaignCriteria', params.locationTargetIds.map(id => ({
        create: {
          campaign: campaignResourceName,
          location: { geoTargetConstant: `geoTargetConstants/${id}` },
        },
      })), loginCustomerId);
    }

    return { resourceName: campaignResourceName };
  }

  /**
   * ENG-487 — add a PROXIMITY (mile/km-radius) campaign criterion centered on a street
   * address. Google geocodes the address into a geo point server-side; this is
   * additive to (not a replacement for) any existing LOCATION (city) criteria on the
   * campaign — remove those separately via removeCampaignCriterion if only the radius
   * should apply.
   */
  async addProximityCriterion(userId: string, customerId: string, campaignResourceName: string, params: {
    radius: number;
    radiusUnits?: 'MILES' | 'KILOMETERS';
    address: {
      streetAddress?: string;
      cityName?: string;
      postalCode?: string;
      provinceCode?: string;
      provinceName?: string;
      countryCode?: string;
    };
    /** Alternative center: decimal-degree coordinates (ENG-486). Takes precedence over address. */
    geoPoint?: { latitude: number; longitude: number };
  }): Promise<{ resourceName: string }> {
    if (!Number.isFinite(params.radius) || params.radius <= 0) {
      throw new Error('addProximityCriterion radius must be a positive finite number');
    }
    if (params.geoPoint) {
      const { latitude, longitude } = params.geoPoint;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        throw new Error('addProximityCriterion geo_point requires latitude in [-90,90] and longitude in [-180,180]');
      }
    }
    const address: Record<string, any> = {};
    if (!params.geoPoint) {
      if (params.address?.streetAddress) address.streetAddress = params.address.streetAddress;
      if (params.address?.cityName) address.cityName = params.address.cityName;
      if (params.address?.postalCode) address.postalCode = params.address.postalCode;
      if (params.address?.provinceCode) address.provinceCode = params.address.provinceCode;
      if (params.address?.provinceName) address.provinceName = params.address.provinceName;
      if (params.address?.countryCode) address.countryCode = params.address.countryCode;
      if (Object.keys(address).length === 0) {
        throw new Error('addProximityCriterion requires at least one address field (street_address, city_name, postal_code, province_code, province_name, country_code)');
      }
    }
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    if (params.geoPoint) {
      const data = await this.mutate(customerId, accessToken, 'campaignCriteria', [{
        create: {
          campaign: campaignResourceName,
          proximity: {
            radius: params.radius,
            radiusUnits: params.radiusUnits || 'MILES',
            geoPoint: {
              latitudeInMicroDegrees: Math.round(params.geoPoint.latitude * 1e6),
              longitudeInMicroDegrees: Math.round(params.geoPoint.longitude * 1e6),
            },
          },
        },
      }], loginCustomerId);
      return { resourceName: data.results[0].resourceName };
    }
    const data = await this.mutate(customerId, accessToken, 'campaignCriteria', [{
      create: {
        campaign: campaignResourceName,
        proximity: {
          radius: params.radius,
          radiusUnits: params.radiusUnits || 'MILES',
          address,
        },
      },
    }], loginCustomerId);
    return { resourceName: data.results[0].resourceName };
  }

  /**
   * Remove a campaign-level criterion by resource name, restricted to the given type(s)
   * so a mis-selected resource name (e.g. an audience or demographic criterion) can't be
   * deleted through an action scoped to a narrower purpose (e.g. REMOVE_PROXIMITY).
   */
  async removeCampaignCriterion(userId: string, customerId: string, criterionResourceName: string, allowedTypes?: string[]): Promise<void> {
    this.assertResourceName(criterionResourceName, 'campaignCriteria');
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    if (allowedTypes?.length) {
      const rows = await this.search(customerId, accessToken, `SELECT campaign_criterion.type FROM campaign_criterion WHERE campaign_criterion.resource_name = '${criterionResourceName}'`, loginCustomerId);
      const actualType = rows[0]?.campaignCriterion?.type;
      if (!actualType || !allowedTypes.includes(actualType)) {
        throw new Error(`Refusing to remove ${criterionResourceName}: expected criterion type ${allowedTypes.join(' or ')}, found ${actualType || 'unknown (criterion not found)'}`);
      }
    }
    await this.mutate(customerId, accessToken, 'campaignCriteria', [{ remove: criterionResourceName }], loginCustomerId);
    await this.verifyRemovedReadBack(customerId, accessToken, 'campaign_criterion', criterionResourceName, loginCustomerId);
  }

  async updateCampaign(userId: string, customerId: string, campaignResourceName: string, params: {
    name?: string;
    status?: 'ENABLED' | 'PAUSED';
    biddingStrategy?: string;
    biddingStrategyResourceName?: string;
    biddingStrategyTarget?: number;
    cpcBidCeilingMicros?: number;
    budgetResourceName?: string;
    finalUrlSuffix?: string;
    targetGoogleSearch?: boolean;
    targetSearchNetwork?: boolean;
    targetContentNetwork?: boolean;
    targetPartnerSearchNetwork?: boolean;
  }): Promise<boolean> {
    if (params.biddingStrategy && params.biddingStrategyResourceName) {
      throw new Error('Provide either bidding_strategy (a standard strategy) or bidding_strategy_resource_name (a portfolio/shared strategy), not both.');
    }
    if (params.targetSearchNetwork === true && params.targetGoogleSearch !== true) {
      throw new Error('target_search_network=true requires target_google_search=true; nothing was sent to Google Ads.');
    }
    assertBidTargetIsAddressable(params);
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const updateMask: string[] = [];
    const update: any = { resourceName: campaignResourceName };
    if (params.name) { update.name = params.name; updateMask.push('name'); }
    if (params.status) { update.status = params.status; updateMask.push('status'); }
    if (params.budgetResourceName) { update.campaignBudget = params.budgetResourceName; updateMask.push('campaign_budget'); }
    if (params.finalUrlSuffix !== undefined) { update.finalUrlSuffix = params.finalUrlSuffix; updateMask.push('final_url_suffix'); }
    const networkSettings: Record<string, boolean> = {};
    const networkSettingFields = [
      ['targetGoogleSearch', 'target_google_search'],
      ['targetSearchNetwork', 'target_search_network'],
      ['targetContentNetwork', 'target_content_network'],
      ['targetPartnerSearchNetwork', 'target_partner_search_network'],
    ] as const;
    for (const [paramName, maskName] of networkSettingFields) {
      if (params[paramName] !== undefined) {
        networkSettings[paramName] = params[paramName];
        updateMask.push(`network_settings.${maskName}`);
      }
    }
    if (Object.keys(networkSettings).length > 0) update.networkSettings = networkSettings;
    if (params.biddingStrategyResourceName) {
      // Portfolio/shared strategy: bidding_strategy is a scalar resource-name field, so masking
      // the leaf directly is correct (and setting it detaches any prior embedded strategy).
      update.biddingStrategy = params.biddingStrategyResourceName;
      updateMask.push('bidding_strategy');
    } else if (params.biddingStrategy) {
      if (params.biddingStrategy === 'MAXIMIZE_CONVERSIONS') {
        // ENG-1527. The target is OPTIONAL on Maximize Conversions, and 0 means "no CPA
        // constraint" — so 0 is the right value when none was supplied, and was the only
        // value ever written. A caller who DID supply one got it discarded on a success
        // response, which is the same silent drop as the guard above by another route.
        //
        // This is also what makes that guard's advice safe: it tells the caller to restate
        // the strategy, and before this, restating MAXIMIZE_CONVERSIONS would have wiped
        // the very target they were trying to set.
        update.maximizeConversions = {
          targetCpaMicros: params.biddingStrategyTarget !== undefined
            ? String(Math.round(params.biddingStrategyTarget * 1_000_000))
            : '0',
        };
        updateMask.push('maximize_conversions.target_cpa_micros');
      } else if (params.biddingStrategy === 'MAXIMIZE_CONVERSION_VALUE') {
        // Same as above: 0 = no ROAS constraint, which is correct only when none was given.
        update.maximizeConversionValue = {
          targetRoas: params.biddingStrategyTarget !== undefined ? params.biddingStrategyTarget : 0,
        };
        updateMask.push('maximize_conversion_value.target_roas');
      } else if (params.biddingStrategy === 'TARGET_CPA') {
        update.targetCpa = { targetCpaMicros: String(Math.round((params.biddingStrategyTarget || 0) * 1_000_000)) };
        updateMask.push('target_cpa.target_cpa_micros');
      } else if (params.biddingStrategy === 'TARGET_ROAS') {
        update.targetRoas = { targetRoas: params.biddingStrategyTarget || 1 };
        updateMask.push('target_roas.target_roas');
      } else if (params.biddingStrategy === 'TARGET_IMPRESSION_SHARE') {
        update.targetImpressionShare = {
          location: 'ANYWHERE_ON_PAGE',
          locationFractionMicros: String(Math.round((params.biddingStrategyTarget || 1) * 1_000_000)),
          cpcBidCeilingMicros: String(params.cpcBidCeilingMicros ?? 100_000_000),
        };
        updateMask.push('target_impression_share.location', 'target_impression_share.location_fraction_micros', 'target_impression_share.cpc_bid_ceiling_micros');
      } else if (params.biddingStrategy === 'MANUAL_CPC') {
        update.manualCpc = { enhancedCpcEnabled: false };
        updateMask.push('manual_cpc.enhanced_cpc_enabled');
      } else if (params.biddingStrategy === 'TARGET_SPEND') {
        // Maximize Clicks. The Google Ads update mutate can only mask the leaf
        // 'target_spend.cpc_bid_ceiling_micros': masking the bare parent 'target_spend'
        // is rejected with FieldMaskError.FIELD_HAS_SUBFIELDS, and a ceiling of 0 is
        // rejected as TOO_LOW. So a truly uncapped switch isn't expressible on an
        // existing campaign — a real cpc_bid_ceiling_micros is required.
        if (params.cpcBidCeilingMicros === undefined || params.cpcBidCeilingMicros <= 0) {
          throw new Error('TARGET_SPEND (Maximize Clicks) requires a positive cpc_bid_ceiling_micros — the max CPC bid limit in micros (e.g. 9000000 for $9). A ceiling of 0 is rejected by Google as TOO_LOW. Ask the user for their max CPC bid before switching an existing campaign to Maximize Clicks.');
        }
        update.targetSpend = { cpcBidCeilingMicros: String(params.cpcBidCeilingMicros) };
        updateMask.push('target_spend.cpc_bid_ceiling_micros');
      } else {
        throw new Error(`Unsupported bidding_strategy '${params.biddingStrategy}' for CAMPAIGN UPDATE. Supported values: MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE, TARGET_CPA, TARGET_ROAS, TARGET_IMPRESSION_SHARE, TARGET_SPEND, MANUAL_CPC.`);
      }
    }
    if (updateMask.length === 0) return false;
    await this.mutate(customerId, accessToken, 'campaigns', [{ update, updateMask: updateMask.join(',') }], loginCustomerId);
    await this.verifyCampaignUpdate(customerId, accessToken, campaignResourceName, params, loginCustomerId);
    return true;
  }

  /**
   * ENG-592 / ENG-286 / ENG-312: Google can answer a campaign `:mutate` with success while a
   * masked field is left unchanged. A success built on our own request is not evidence, so
   * read the campaign back and fail loudly (code `unsupported_field`) on any field that did
   * not land. The error reaches the tool caller and is logged for telemetry.
   */
  private async verifyCampaignUpdate(
    customerId: string,
    accessToken: string,
    campaignResourceName: string,
    params: Parameters<GoogleAdsService['updateCampaign']>[3],
    loginCustomerId?: string,
  ): Promise<void> {
    const rows = await this.search(
      customerId,
      accessToken,
      'SELECT campaign.resource_name, campaign.name, campaign.status, campaign.final_url_suffix, ' +
        'campaign.campaign_budget, campaign.bidding_strategy, campaign.bidding_strategy_type, ' +
        'campaign.network_settings.target_google_search, campaign.network_settings.target_search_network, ' +
        'campaign.network_settings.target_content_network, campaign.network_settings.target_partner_search_network ' +
        `FROM campaign WHERE campaign.resource_name = '${campaignResourceName}'`,
      loginCustomerId,
    );
    const c = rows[0]?.campaign;
    if (!c) {
      throw new GoogleAdsReadBackError(campaignResourceName, ['<campaign not found on read-back>']);
    }
    const unchanged: string[] = [];
    if (params.name && c.name !== params.name) unchanged.push('name');
    if (params.status && c.status !== params.status) unchanged.push('status');
    if (params.finalUrlSuffix !== undefined && (c.finalUrlSuffix ?? '') !== params.finalUrlSuffix) unchanged.push('final_url_suffix');
    if (params.budgetResourceName && c.campaignBudget !== params.budgetResourceName) unchanged.push('campaign_budget');
    if (params.biddingStrategyResourceName && c.biddingStrategy !== params.biddingStrategyResourceName) unchanged.push('bidding_strategy');
    if (params.biddingStrategy && c.biddingStrategyType !== params.biddingStrategy) unchanged.push('bidding_strategy_type');
    const ns = c.networkSettings ?? {};
    for (const key of ['targetGoogleSearch', 'targetSearchNetwork', 'targetContentNetwork', 'targetPartnerSearchNetwork'] as const) {
      if (params[key] !== undefined && Boolean(ns[key]) !== params[key]) unchanged.push(`network_settings.${key}`);
    }
    if (unchanged.length > 0) {
      const err = new GoogleAdsReadBackError(campaignResourceName, unchanged);
      console.error('[GoogleAds] read-back mismatch', { code: err.code, resource: campaignResourceName, fields: unchanged });
      throw err;
    }
  }

  /**
   * ENG-2398 (ENG-592 slice 1b): generic read-back for the non-campaign mutation surface.
   * `expected` maps a camelCase field on the read-back row (e.g. `cpcBidMicros`) to the
   * snake_case GAQL field name used in the error. Values are compared as strings so that
   * int64 micros (returned by REST as strings) match the numbers we sent.
   */
  private async verifyFieldsReadBack(
    customerId: string,
    accessToken: string,
    entity: 'campaign_budget' | 'ad_group' | 'ad_group_criterion' | 'ad_group_ad' | 'asset_group',
    resourceName: string,
    expected: Record<string, { gaql: string; value: unknown }>,
    loginCustomerId?: string,
  ): Promise<void> {
    const keys = Object.keys(expected);
    if (keys.length === 0) return;
    if (!this.isValidGoogleAdsResourceName(resourceName)) {
      throw new GoogleAdsReadBackError(resourceName, ['<invalid resource name>']);
    }
    const rowKey = entity.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
    const select = [`${entity}.resource_name`, ...keys.map((k) => `${entity}.${expected[k].gaql}`)].join(', ');
    const rows = await this.search(
      customerId, accessToken,
      `SELECT ${select} FROM ${entity} WHERE ${entity}.resource_name = '${resourceName}'`,
      loginCustomerId,
    );
    const row = rows[0]?.[rowKey];
    if (!row) throw new GoogleAdsReadBackError(resourceName, [`<${entity} not found on read-back>`]);
    const unchanged = keys.filter((k) => String(row[k] ?? '') !== String(expected[k].value ?? '')).map((k) => expected[k].gaql);
    if (unchanged.length > 0) {
      const err = new GoogleAdsReadBackError(resourceName, unchanged);
      console.error('[GoogleAds] read-back mismatch', { code: err.code, resource: resourceName, fields: unchanged });
      throw err;
    }
  }

  /**
   * ENG-2398 AC3: a remove is proven when the resource reads back REMOVED or is gone.
   * Anything else (still ENABLED/PAUSED) is a loud failure, never a silent success.
   */
  private async verifyRemovedReadBack(
    customerId: string,
    accessToken: string,
    entity: 'campaign' | 'campaign_budget' | 'ad_group' | 'ad_group_criterion' | 'ad_group_ad' | 'conversion_action' | 'campaign_criterion',
    resourceName: string,
    loginCustomerId?: string,
  ): Promise<void> {
    if (!this.isValidGoogleAdsResourceName(resourceName)) {
      throw new GoogleAdsReadBackError(resourceName, ['<invalid resource name>']);
    }
    const rowKey = entity.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
    const rows = await this.search(
      customerId, accessToken,
      `SELECT ${entity}.resource_name, ${entity}.status FROM ${entity} WHERE ${entity}.resource_name = '${resourceName}'`,
      loginCustomerId,
    );
    const status = rows[0]?.[rowKey]?.status;
    if (status !== undefined && status !== 'REMOVED') {
      const err = new GoogleAdsReadBackError(resourceName, ['status']);
      console.error('[GoogleAds] remove read-back mismatch', { code: err.code, resource: resourceName, status });
      throw err;
    }
  }

  async pauseCampaign(userId: string, customerId: string, campaignResourceName: string): Promise<void> {
    await this.updateCampaign(userId, customerId, campaignResourceName, { status: 'PAUSED' });
  }

  async resumeCampaign(userId: string, customerId: string, campaignResourceName: string): Promise<void> {
    await this.updateCampaign(userId, customerId, campaignResourceName, { status: 'ENABLED' });
  }

  async removeCampaign(userId: string, customerId: string, campaignResourceName: string): Promise<void> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'campaigns', [{ remove: campaignResourceName }], loginCustomerId);
    await this.verifyRemovedReadBack(customerId, accessToken, 'campaign', campaignResourceName, loginCustomerId);
  }

  /**
   * Validate a Google Ads resource name before it is interpolated into a GAQL WHERE
   * clause (ENG-335). Unlike the other queries in this service, the ENG-335 lookups
   * splice a caller-supplied value into the query, and that value ultimately originates
   * from an LLM tool-call argument. Real resource names are only `customers/<n>/<segment>/<n>`,
   * so we reject anything else rather than let a crafted string alter the query (e.g. one
   * engineered to return zero rows and silently skip the creative-addition gate).
   */
  private assertResourceName(value: string, segment: 'campaigns' | 'adGroups' | 'campaignCriteria' | 'assetGroups'): void {
    const idPattern = segment === 'campaignCriteria' ? '\\d+~\\d+' : '\\d+';
    if (typeof value !== 'string' || !new RegExp(`^customers/\\d+/${segment}/${idPattern}$`).test(value)) {
      throw new Error(`Invalid Google Ads ${segment} resource name`);
    }
  }

  /**
   * Collect the de-duplicated set of final URLs a campaign points at, across its
   * (non-removed) responsive ads and PMax asset groups. Used by the pre-flight
   * tracking gate (ENG-335) before a campaign is enabled/launched.
   */
  async getCampaignFinalUrls(userId: string, customerId: string, campaignResourceName: string): Promise<string[]> {
    this.assertResourceName(campaignResourceName, 'campaigns');
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const urls = new Set<string>();

    const adRows = await this.search(customerId, accessToken,
      `SELECT ad_group_ad.ad.final_urls FROM ad_group_ad WHERE campaign.resource_name = '${campaignResourceName}' AND ad_group_ad.status != 'REMOVED'`,
      loginCustomerId,
    );
    for (const r of adRows) {
      for (const u of (r.adGroupAd?.ad?.finalUrls || [])) urls.add(u);
    }

    const assetGroupRows = await this.search(customerId, accessToken,
      `SELECT asset_group.final_urls FROM asset_group WHERE campaign.resource_name = '${campaignResourceName}' AND asset_group.status != 'REMOVED'`,
      loginCustomerId,
    );
    for (const r of assetGroupRows) {
      for (const u of (r.assetGroup?.finalUrls || [])) urls.add(u);
    }

    return [...urls];
  }

  /**
   * Current serving status of a campaign (e.g. 'ENABLED', 'PAUSED'), or null if
   * the campaign can't be found. Used by the ENG-335 launch gate to decide whether
   * adding a creative to it serves paid traffic instantly.
   */
  async getCampaignStatus(userId: string, customerId: string, campaignResourceName: string): Promise<string | null> {
    this.assertResourceName(campaignResourceName, 'campaigns');
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const rows = await this.search(customerId, accessToken,
      `SELECT campaign.status FROM campaign WHERE campaign.resource_name = '${campaignResourceName}'`,
      loginCustomerId,
    );
    return rows[0]?.campaign?.status ?? null;
  }

  /**
   * Resolve the parent campaign (resource name + current status) of an ad group.
   * Returns null if the ad group can't be found. Used by the ENG-335 launch gate
   * so a new ad added to a live campaign is checked before it serves.
   */
  async getAdGroupCampaign(userId: string, customerId: string, adGroupResourceName: string): Promise<{ campaignResourceName: string; campaignStatus: string } | null> {
    this.assertResourceName(adGroupResourceName, 'adGroups');
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const rows = await this.search(customerId, accessToken,
      `SELECT ad_group.campaign, campaign.status FROM ad_group WHERE ad_group.resource_name = '${adGroupResourceName}'`,
      loginCustomerId,
    );
    const row = rows[0];
    if (!row?.adGroup?.campaign) return null;
    return { campaignResourceName: row.adGroup.campaign, campaignStatus: row.campaign?.status ?? '' };
  }

  // ── Location search ───────────────────────────────────────────────────────

  async searchLocations(userId: string, customerId: string, query: string, locale: string = 'en'): Promise<{ id: string; name: string; countryCode: string; targetType: string }[]> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const secrets = await getGoogleAdsCredentials();
    let response;
    try {
      response = await axios.post(`${GOOGLE_ADS_API_BASE}/geoTargetConstants:suggest`, { locale, locationNames: { names: [query] } }, {
        timeout: GOOGLE_ADS_HTTP_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'developer-token': secrets.developerToken,
          'login-customer-id': loginCustomerId,
        },
      });
    } catch (err: any) {
      console.error('[GoogleAds] searchLocations error:', JSON.stringify(err?.response?.data ?? err?.message));
      throw err;
    }
    const responseData = response.data as { geoTargetConstantSuggestions?: any[] };
    return (responseData.geoTargetConstantSuggestions || []).map((s: any) => ({
      id: String(s.geoTargetConstant.id),
      name: s.geoTargetConstant.name,
      countryCode: s.geoTargetConstant.countryCode,
      targetType: s.geoTargetConstant.targetType,
    }));
  }

  // ── Ad Groups ────────────────────────────────────────────────────────────

  async listAdGroups(userId: string, customerId: string, campaignResourceName: string): Promise<any[]> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const results = await this.search(customerId, accessToken,
      `SELECT ad_group.resource_name, ad_group.id, ad_group.name, ad_group.status, ad_group.type FROM ad_group WHERE ad_group.campaign = '${campaignResourceName}'`,
      loginCustomerId,
    );
    return results.map((r: any) => ({
      resourceName: r.adGroup.resourceName,
      id: String(r.adGroup.id),
      name: r.adGroup.name,
      status: r.adGroup.status,
      type: r.adGroup.type,
    }));
  }

  async createAdGroup(userId: string, customerId: string, params: {
    name: string;
    campaignResourceName: string;
    type: 'SEARCH_STANDARD' | 'DISPLAY_STANDARD';
    status?: 'ENABLED' | 'PAUSED';
    cpcBidMicros?: number;
  }): Promise<{ resourceName: string }> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const data = await this.mutate(customerId, accessToken, 'adGroups', [{
      create: {
        name: params.name,
        campaign: params.campaignResourceName,
        status: params.status ?? 'ENABLED',
        type: params.type,
        ...(params.cpcBidMicros !== undefined && { cpcBidMicros: String(params.cpcBidMicros) }),
      },
    }], loginCustomerId);
    return { resourceName: data.results[0].resourceName };
  }

  async updateAdGroup(userId: string, customerId: string, adGroupResourceName: string, params: {
    name?: string;
    status?: 'ENABLED' | 'PAUSED';
    cpcBidMicros?: number;
    adRotationMode?: 'OPTIMIZE' | 'ROTATE_FOREVER';
    targetCpaMicros?: number;
    targetRoas?: number;
  }): Promise<boolean> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const updateMask: string[] = [];
    const update: any = { resourceName: adGroupResourceName };
    if (params.name) { update.name = params.name; updateMask.push('name'); }
    if (params.status) { update.status = params.status; updateMask.push('status'); }
    if (params.cpcBidMicros !== undefined) { update.cpcBidMicros = String(params.cpcBidMicros); updateMask.push('cpc_bid_micros'); }
    if (params.adRotationMode) { update.adRotationMode = params.adRotationMode; updateMask.push('ad_rotation_mode'); }
    if (params.targetCpaMicros !== undefined) { update.targetCpaMicros = String(params.targetCpaMicros); updateMask.push('target_cpa_micros'); }
    if (params.targetRoas !== undefined) { update.targetRoas = params.targetRoas; updateMask.push('target_roas'); }
    if (updateMask.length === 0) return false;
    await this.mutate(customerId, accessToken, 'adGroups', [{ update, updateMask: updateMask.join(',') }], loginCustomerId);
    const expected: Record<string, { gaql: string; value: unknown }> = {};
    if (params.name) expected.name = { gaql: 'name', value: params.name };
    if (params.status) expected.status = { gaql: 'status', value: params.status };
    if (params.cpcBidMicros !== undefined) expected.cpcBidMicros = { gaql: 'cpc_bid_micros', value: params.cpcBidMicros };
    if (params.adRotationMode) expected.adRotationMode = { gaql: 'ad_rotation_mode', value: params.adRotationMode };
    if (params.targetCpaMicros !== undefined) expected.targetCpaMicros = { gaql: 'target_cpa_micros', value: params.targetCpaMicros };
    if (params.targetRoas !== undefined) expected.targetRoas = { gaql: 'target_roas', value: params.targetRoas };
    await this.verifyFieldsReadBack(customerId, accessToken, 'ad_group', adGroupResourceName, expected, loginCustomerId);
    return true;
  }

  async removeAdGroup(userId: string, customerId: string, adGroupResourceName: string): Promise<void> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'adGroups', [{ remove: adGroupResourceName }], loginCustomerId);
    await this.verifyRemovedReadBack(customerId, accessToken, 'ad_group', adGroupResourceName, loginCustomerId);
  }

  // ── Keywords ─────────────────────────────────────────────────────────────

  /**
   * ENG-1527. `status` was hardcoded ENABLED with no parameter at all — the last create on
   * this surface that could not be staged, after ENG-1514 gave AD_GROUP and AD one.
   *
   * The greenfield case was contained (a keyword under a paused ad group cannot serve), but
   * that containment does not exist on the path that matters: adding keywords to an
   * ALREADY-LIVE ad group starts buying new queries on the next refresh, at the ad group's
   * default bid, with no review of match type or bid — and unlike AD CREATE and
   * ASSET_GROUP CREATE, KEYWORD ADD passes through no gate at all.
   *
   * Defaults to PAUSED, matching CAMPAIGN/AD_GROUP/AD and Management RULE 11. That is a
   * deliberate trade: an operator who expected delivery sees keywords sitting paused, which
   * is visible and one call to fix, where unreviewed spend is neither.
   */
  async addKeywords(userId: string, customerId: string, adGroupResourceName: string, keywords: {
    text: string;
    matchType: 'BROAD' | 'PHRASE' | 'EXACT';
  }[], status: 'ENABLED' | 'PAUSED' = 'PAUSED'): Promise<void> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'adGroupCriteria', keywords.map(kw => ({
      create: {
        adGroup: adGroupResourceName,
        status,
        keyword: { text: kw.text, matchType: kw.matchType },
      },
    })), loginCustomerId);
  }

  async addNegativeKeywords(userId: string, customerId: string, target: {
    campaignResourceName?: string;
    adGroupResourceName?: string;
  }, keywords: { text: string; matchType: 'BROAD' | 'PHRASE' | 'EXACT' }[]): Promise<void> {
    if (!target.campaignResourceName && !target.adGroupResourceName) {
      throw new Error('addNegativeKeywords requires either campaignResourceName or adGroupResourceName');
    }
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    if (target.campaignResourceName) {
      await this.mutate(customerId, accessToken, 'campaignCriteria', keywords.map(kw => ({
        create: {
          campaign: target.campaignResourceName,
          negative: true,
          keyword: { text: kw.text, matchType: kw.matchType },
        },
      })), loginCustomerId);
    } else if (target.adGroupResourceName) {
      await this.mutate(customerId, accessToken, 'adGroupCriteria', keywords.map(kw => ({
        create: {
          adGroup: target.adGroupResourceName,
          negative: true,
          keyword: { text: kw.text, matchType: kw.matchType },
        },
      })), loginCustomerId);
    }
  }

  async addNegativeCampaignCriteria(
    userId: string,
    customerId: string,
    campaignResourceName: string,
    params: {
      placementUrls: string[];
      mobileAppCategoryResourceNames: string[];
    },
  ): Promise<void> {
    const { placementUrls, mobileAppCategoryResourceNames } = validateNegativeCampaignCriteria(
      customerId,
      campaignResourceName,
      params.placementUrls,
      params.mobileAppCategoryResourceNames,
    );

    const operations = [
      ...placementUrls.map((url) => ({
        create: {
          campaign: campaignResourceName,
          negative: true,
          placement: { url },
        },
      })),
      ...mobileAppCategoryResourceNames.map((mobileAppCategoryConstant) => ({
        create: {
          campaign: campaignResourceName,
          negative: true,
          mobileAppCategory: { mobileAppCategoryConstant },
        },
      })),
    ];

    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'campaignCriteria', operations, loginCustomerId);
  }

  /** ENG-2036: device bid adjustments (campaign DEVICE criteria or ad-group bid modifiers). */
  async setDeviceBidAdjustments(userId: string, params: NormalizedDeviceBidAdjustments): Promise<void> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, params.customerId);
    // Ad-group device modifiers may already exist; those need update, not create.
    const existing: Partial<Record<BidAdjustmentDevice, string>> = {};
    if (params.scope === 'AD_GROUP') {
      const rows = await this.search(
        params.customerId,
        accessToken,
        `SELECT ad_group_bid_modifier.resource_name, ad_group_bid_modifier.device.type FROM ad_group_bid_modifier WHERE ad_group_bid_modifier.ad_group = '${params.adGroupResourceName}'`,
        loginCustomerId,
      );
      for (const r of rows) {
        const type = r?.adGroupBidModifier?.device?.type as BidAdjustmentDevice | undefined;
        if (type && r.adGroupBidModifier.resourceName) existing[type] = r.adGroupBidModifier.resourceName;
      }
    }
    const { resource, operations } = buildDeviceBidAdjustmentOperations(params, existing);
    const res = await this.mutate(params.customerId, accessToken, resource, operations, loginCustomerId);
    await this.verifyDeviceBidModifiersReadBack(params, operations, res, accessToken, loginCustomerId);
  }

  /**
   * ENG-2398: prove every device bid modifier landed. Read each targeted criterion / ad-group
   * bid modifier back and compare bid_modifier numerically (proto3 JSON omits a 0 value, so a
   * missing field reads as 0 — that is the -100% "exclude device" case). Any mismatch or
   * missing resource throws GoogleAdsReadBackError, never a silent success.
   */
  private async verifyDeviceBidModifiersReadBack(
    params: NormalizedDeviceBidAdjustments,
    operations: any[],
    mutateResult: any,
    accessToken: string,
    loginCustomerId?: string,
  ): Promise<void> {
    const entity = params.scope === 'CAMPAIGN' ? 'campaign_criterion' : 'ad_group_bid_modifier';
    const rowKey = params.scope === 'CAMPAIGN' ? 'campaignCriterion' : 'adGroupBidModifier';
    const results: any[] = mutateResult?.results ?? [];
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      const resourceName: string | undefined = op.update?.resourceName ?? results[i]?.resourceName;
      const expected = Number(op.update?.bidModifier ?? op.create?.bidModifier);
      if (!resourceName || !this.isValidGoogleAdsResourceName(resourceName)) {
        throw new GoogleAdsReadBackError(resourceName ?? '<missing resource name>', ['<invalid resource name>']);
      }
      const rows = await this.search(
        params.customerId, accessToken,
        `SELECT ${entity}.resource_name, ${entity}.bid_modifier FROM ${entity} WHERE ${entity}.resource_name = '${resourceName}'`,
        loginCustomerId,
      );
      const row = rows[0]?.[rowKey];
      if (!row) throw new GoogleAdsReadBackError(resourceName, [`<${entity} not found on read-back>`]);
      const actual = Number(row.bidModifier ?? 0);
      if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-6) {
        const err = new GoogleAdsReadBackError(resourceName, ['bid_modifier']);
        console.error('[GoogleAds] read-back mismatch', { code: err.code, resource: resourceName, fields: ['bid_modifier'] });
        throw err;
      }
    }
  }

  async listKeywords(userId: string, customerId: string, adGroupResourceName: string): Promise<any[]> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const query = `SELECT ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.negative FROM ad_group_criterion WHERE ad_group_criterion.ad_group = '${adGroupResourceName}' AND ad_group_criterion.type = 'KEYWORD'`;
    const results = await this.search(customerId, accessToken, query, loginCustomerId);
    return results.map((r: any) => ({
      resourceName: r.adGroupCriterion.resourceName,
      text: r.adGroupCriterion.keyword?.text,
      matchType: r.adGroupCriterion.keyword?.matchType,
      status: r.adGroupCriterion.status,
      negative: r.adGroupCriterion.negative,
    }));
  }

  async updateKeyword(userId: string, customerId: string, criterionResourceName: string, params: {
    status?: 'ENABLED' | 'PAUSED';
    cpcBidMicros?: number;
  }): Promise<boolean> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const updateMask: string[] = [];
    const update: any = { resourceName: criterionResourceName };
    if (params.status) { update.status = params.status; updateMask.push('status'); }
    if (params.cpcBidMicros !== undefined) { update.cpcBidMicros = String(params.cpcBidMicros); updateMask.push('cpc_bid_micros'); }
    if (updateMask.length === 0) return false;
    await this.mutate(customerId, accessToken, 'adGroupCriteria', [{ update, updateMask: updateMask.join(',') }], loginCustomerId);
    const expected: Record<string, { gaql: string; value: unknown }> = {};
    if (params.status) expected.status = { gaql: 'status', value: params.status };
    if (params.cpcBidMicros !== undefined) expected.cpcBidMicros = { gaql: 'cpc_bid_micros', value: params.cpcBidMicros };
    await this.verifyFieldsReadBack(customerId, accessToken, 'ad_group_criterion', criterionResourceName, expected, loginCustomerId);
    return true;
  }

  async removeKeyword(userId: string, customerId: string, criterionResourceName: string): Promise<void> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'adGroupCriteria', [{ remove: criterionResourceName }], loginCustomerId);
    await this.verifyRemovedReadBack(customerId, accessToken, 'ad_group_criterion', criterionResourceName, loginCustomerId);
  }

  // ── Ads ──────────────────────────────────────────────────────────────────

  /**
   * ENG-239 — the Google `final_url_suffix` Emma stamps on an ad so leads from it
   * reach the CRM with attribution. Returns `undefined` when nothing should be
   * written (so the caller omits the field rather than sending an empty one).
   *
   * `final_url_suffix` is a native field on the `Ad` (`ad_group_ad.ad.final_url_suffix`),
   * appended to the destination URL by Google at click time and shown in the ad's
   * URL options — which is what makes AC1 ("verifiable in the platform's ad
   * settings") hold literally. The generated value uses ValueTrack macros
   * (`{campaignid}`, `{creative}`) that reach the API un-encoded and resolve per
   * click. An explicit caller-supplied suffix wins verbatim; otherwise any UTM key
   * the user already put on `finalUrl` is omitted (AC4), and when every key is
   * already present `utmQueryString` returns "" → we return `undefined`.
   */
  private buildAdFinalUrlSuffix(opts: {
    finalUrl?: string;
    explicitSuffix?: string;
    /** The suffix this ad would otherwise inherit from its campaign. */
    inheritedSuffix?: string;
  }): string | undefined {
    if (opts.explicitSuffix) return opts.explicitSuffix;
    if (!opts.finalUrl) return undefined;
    // If we cannot read the destination URL we do not tag it: it may well already
    // carry a utm_source (`example.com?utm_source=news` fails `new URL()` for want of
    // a scheme), and appending a second one would corrupt the attribution. Nor do we
    // throw — Google should reject a bad URL with its own precise error, not ours.
    const urlKeys = readUtmKeys(opts.finalUrl);
    if (!urlKeys) return undefined;
    const spec = buildUtmSpec('google', { campaign: '{campaignid}', content: '{creative}' });
    // Carry the campaign's suffix forward — an ad-level suffix REPLACES it, so not
    // doing so would silently destroy the client's own tracking (AC4).
    const merged = mergeUtmIntoQueryString(opts.inheritedSuffix, spec, urlKeys);
    return merged || undefined;
  }

  /**
   * The `final_url_suffix` an ad in this ad group would inherit from its campaign.
   *
   * Google resolves the suffix by most-specific level (ad > ad group > campaign >
   * account) and the winner REPLACES the others — they are not concatenated. So we
   * must know what we would be replacing before we write at ad level.
   *
   * Returns `{ ok: false }` if the read fails. Callers then write no generated
   * suffix at all: losing attribution on one ad is recoverable, silently destroying
   * a client's campaign-level tracking is not.
   */
  private async getInheritedFinalUrlSuffix(
    customerId: string,
    accessToken: string,
    adGroupResourceName: string,
    loginCustomerId?: string,
  ): Promise<{ ok: true; suffix?: string } | { ok: false }> {
    try {
      const rows = await this.search(
        customerId,
        accessToken,
        `SELECT ad_group.final_url_suffix, campaign.final_url_suffix FROM ad_group WHERE ad_group.resource_name = '${adGroupResourceName}'`,
        loginCustomerId,
      );
      // Ad group is more specific than campaign, so its own suffix (if set) is
      // the one actually in effect — campaign's is only a fallback.
      const suffix = rows[0]?.adGroup?.finalUrlSuffix || rows[0]?.campaign?.finalUrlSuffix || undefined;
      return { ok: true, suffix };
    } catch (err: any) {
      console.warn(
        `[GoogleAds] could not read inherited final_url_suffix for ${adGroupResourceName}; skipping UTM suffix to avoid clobbering it:`,
        err?.message || err,
      );
      return { ok: false };
    }
  }

  /**
   * Google Ads resource names are always `[A-Za-z0-9_/~-]+` — no quotes, no
   * whitespace. Both retag entry points interpolate their resource name
   * argument directly into a GAQL string literal, so this guard closes that
   * injection vector before the value ever reaches a query (Greptile).
   */
  private isValidGoogleAdsResourceName(name: string): boolean {
    return /^[A-Za-z0-9_/~-]+$/.test(name);
  }

  async listAds(userId: string, customerId: string, adGroupResourceName: string): Promise<any[]> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const results = await this.search(customerId, accessToken,
      `SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_display_ad.headlines, ad_group_ad.ad.responsive_display_ad.descriptions FROM ad_group_ad WHERE ad_group_ad.ad_group = '${adGroupResourceName}'`,
      loginCustomerId,
    );
    return results.map((r: any) => ({
      resourceName: r.adGroupAd.resourceName,
      adId: String(r.adGroupAd.ad.id),
      status: r.adGroupAd.status,
      type: r.adGroupAd.ad.type,
      finalUrls: r.adGroupAd.ad.finalUrls,
      headlines: (r.adGroupAd.ad.responsiveSearchAd?.headlines || r.adGroupAd.ad.responsiveDisplayAd?.headlines || []).map((h: any) => h.text),
      descriptions: (r.adGroupAd.ad.responsiveSearchAd?.descriptions || r.adGroupAd.ad.responsiveDisplayAd?.descriptions || []).map((d: any) => d.text),
    }));
  }

  /**
   * Read every destination the UTM audit must judge for this account (ENG-239 AC3).
   * STRICTLY READ-ONLY.
   *
   * TWO resource types, because our tagger writes to two:
   *
   *   1. `ad_group_ad` — a normal ad. Tagged via the ad's native `final_url_suffix`
   *      (`buildAdFinalUrlSuffix`), which Google appends to the final URL at click time.
   *
   *   2. `asset_group` — a Performance Max campaign. A PMax campaign has NO ad_group_ads at
   *      all; its destinations live on `asset_group.final_urls`. Reading only ad_group_ad would
   *      see zero ads for such a campaign and the audit would report it `tagged: true`
   *      VACUOUSLY — a clean bill of health for a campaign we never actually looked at. That
   *      is worse than a false "untagged": the team trusts the report and skips a client who
   *      has no attribution at all.
   *
   * INHERITANCE — the thing that must not be got wrong: Google resolves `final_url_suffix`
   * most-specific-wins (ad > ad group > campaign > account) and the winner REPLACES the
   * others; they are NEVER concatenated. So an ad's effective suffix is its own if set, else
   * the campaign's. Concatenating (or ignoring the campaign level) would report a properly
   * tagged campaign as untagged — a false positive the team would act on.
   *
   * ASSET-GROUP SUFFIX: an asset group has NO `final_url_suffix` field of its own (that is
   * precisely why `createAssetGroup` merges the UTMs straight into `final_urls` — see :1072).
   * Its append field is therefore the CAMPAIGN's suffix and nothing else. Selecting
   * `asset_group.final_url_suffix` in GAQL would not merely be wrong, it would fail the whole
   * query and take the audit down with it.
   *
   * AD-GROUP SUFFIX: `getInheritedFinalUrlSuffix` reads and inherits from the ad group level
   * too (an ad group's own suffix is more specific than its campaign's), so the audit must
   * read it as well — an ad-group-tagged campaign with no ad/campaign-level suffix would
   * otherwise be a false "untagged".
   *
   * `destinationUrls` is the whole `finalUrls` array — every one of them must carry the UTMs,
   * not just `finalUrls[0]`.
   */
  async listAdsForUtmAudit(
    userId: string,
    customerId: string,
    campaignId?: string,
    /** Optional out-param — see `search`. Set when either underlying query hit the page cap. */
    completeness?: { truncated?: boolean },
  ): Promise<Array<{
    adId: string;
    campaignId: string;
    campaignName: string;
    destinationUrls: string[];
    appendField?: string;
  }>> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);

    // Campaign ids are numeric; the guard keeps a caller-supplied value out of the GAQL text.
    const where = campaignId && /^\d+$/.test(campaignId) ? ` WHERE campaign.id = ${campaignId}` : '';

    const adQuery =
      'SELECT campaign.id, campaign.name, campaign.final_url_suffix, ad_group.final_url_suffix, ' +
      'ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.ad.final_url_suffix ' +
      'FROM ad_group_ad' + where;

    // NOTE: no `asset_group.final_url_suffix` — that field does not exist on the resource.
    const assetGroupQuery =
      'SELECT campaign.id, campaign.name, campaign.final_url_suffix, ' +
      'asset_group.id, asset_group.final_urls ' +
      'FROM asset_group' + where;

    // Either query hitting the cap makes the combined result partial, so both feed the same flag.
    const [adRows, assetGroupRows] = await Promise.all([
      this.search(customerId, accessToken, adQuery, loginCustomerId, completeness),
      this.search(customerId, accessToken, assetGroupQuery, loginCustomerId, completeness),
    ]);

    const urls = (value: any): string[] =>
      (Array.isArray(value) ? value : []).filter((u: any) => typeof u === 'string' && u.trim());

    const ads = adRows.map((r: any) => {
      const ad = r.adGroupAd?.ad ?? {};
      const adGroup = r.adGroup ?? {};
      const campaign = r.campaign ?? {};
      return {
        adId: String(ad.id ?? ''),
        campaignId: campaign.id != null ? String(campaign.id) : '',
        campaignName: campaign.name ?? '',
        destinationUrls: urls(ad.finalUrls),
        // Most-specific-wins: ad > ad group > campaign — each level REPLACES the
        // others, never appends to them.
        appendField: ad.finalUrlSuffix || adGroup.finalUrlSuffix || campaign.finalUrlSuffix || undefined,
      };
    });

    const assetGroups = assetGroupRows.map((r: any) => {
      const assetGroup = r.assetGroup ?? {};
      const campaign = r.campaign ?? {};
      return {
        // Namespaced so an asset group is never mistaken for an ad id in the report — the two
        // are different resources and are actioned differently.
        adId: `assetGroup/${assetGroup.id ?? ''}`,
        campaignId: campaign.id != null ? String(campaign.id) : '',
        campaignName: campaign.name ?? '',
        destinationUrls: urls(assetGroup.finalUrls),
        // Campaign level ONLY — an asset group has no suffix field of its own.
        appendField: campaign.finalUrlSuffix || undefined,
      };
    });

    return [...ads, ...assetGroups];
  }

  async createAd(userId: string, customerId: string, params: {
    adGroupResourceName: string;
    type: 'RESPONSIVE_SEARCH_AD' | 'RESPONSIVE_DISPLAY_AD';
    headlines: string[];
    descriptions: string[];
    finalUrl: string;
    status?: 'ENABLED' | 'PAUSED';
    imageAssetResourceNames?: string[];
    /** ENG-239: explicit UTM/tracking suffix; wins over the auto-generated one. */
    finalUrlSuffix?: string;
  }): Promise<{ resourceName: string }> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);

    let adContent: any;
    if (params.type === 'RESPONSIVE_SEARCH_AD') {
      adContent = {
        responsiveSearchAd: {
          headlines: params.headlines.map(text => ({ text })),
          descriptions: params.descriptions.map(text => ({ text })),
        },
      };
    } else if (params.type === 'RESPONSIVE_DISPLAY_AD') {
      adContent = {
        responsiveDisplayAd: {
          headlines: params.headlines.map(text => ({ text })),
          descriptions: params.descriptions.map(text => ({ text })),
          ...(params.imageAssetResourceNames && {
            marketingImages: params.imageAssetResourceNames.map(asset => ({ asset })),
          }),
        },
      };
    } else {
      // Reject unknown types rather than silently defaulting to a display ad —
      // the agent could otherwise spend on the wrong ad format.
      throw new Error(`Unsupported ad type "${params.type}". Use RESPONSIVE_SEARCH_AD or RESPONSIVE_DISPLAY_AD.`);
    }

    // Read what this ad would inherit from its campaign BEFORE writing at ad level —
    // an ad-level suffix replaces the campaign's outright (ENG-239 AC4).
    const inherited = await this.getInheritedFinalUrlSuffix(
      customerId, accessToken, params.adGroupResourceName, loginCustomerId,
    );
    const finalUrlSuffix = inherited.ok
      ? this.buildAdFinalUrlSuffix({
          finalUrl: params.finalUrl,
          explicitSuffix: params.finalUrlSuffix,
          inheritedSuffix: inherited.suffix,
        })
      : params.finalUrlSuffix; // read failed → only an explicitly-supplied suffix is safe to write

    const data = await this.mutate(customerId, accessToken, 'adGroupAds', [{
      create: {
        adGroup: params.adGroupResourceName,
        status: params.status ?? 'ENABLED',
        ad: {
          ...adContent,
          finalUrls: [params.finalUrl],
          ...(finalUrlSuffix ? { finalUrlSuffix } : {}),
        },
      },
    }], loginCustomerId);
    return { resourceName: data.results[0].resourceName };
  }

  /**
   * `finalUrl`/`finalUrlSuffix` params were removed (ENG-239 follow-up):
   * `ad_group_ad.ad.final_url_suffix` is LIVE-VERIFIED IMMUTABLE on UPDATE —
   * Google rejects it with `IMMUTABLE_FIELD: Field 'ad.final_url_suffix' cannot
   * be modified by 'UPDATE' operation`, even though the v24 proto carries no
   * IMMUTABLE annotation on the field. This path was never reachable from any
   * real caller (the AD UPDATE dispatcher only ever passes `status`), so no
   * behavior changes for real traffic — this only removes dead code whose own
   * unit tests were asserting on a write Google's live API always rejects. A
   * suffix can still be set at CREATE time (`createAd`, which uses a `create`
   * mutate op — Google's immutability rule is UPDATE-only) or via `retagAdUtm`,
   * which correctly writes at the CAMPAIGN level instead.
   */
  async updateAd(userId: string, customerId: string, adGroupAdResourceName: string, params: {
    status?: 'ENABLED' | 'PAUSED';
    /** ENG-2979: responsive search ad content edits (AdService on customers/{cid}/ads/{adId}). */
    headlines?: string[];
    descriptions?: string[];
    finalUrl?: string;
  }): Promise<boolean> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const hasContent = params.headlines !== undefined || params.descriptions !== undefined || params.finalUrl !== undefined;
    if (!params.status && !hasContent) return false;
    if (hasContent) await this.updateResponsiveSearchAdContent(customerId, accessToken, adGroupAdResourceName, params, loginCustomerId);
    if (params.status) {
      const update: any = { resourceName: adGroupAdResourceName, status: params.status };
      await this.mutate(customerId, accessToken, 'adGroupAds', [{ update, updateMask: 'status' }], loginCustomerId);
      await this.verifyFieldsReadBack(customerId, accessToken, 'ad_group_ad', adGroupAdResourceName,
        { status: { gaql: 'status', value: params.status } }, loginCustomerId);
    }
    return true;
  }

  /**
   * ENG-2979: edit an existing RESPONSIVE_SEARCH_AD's headlines / descriptions / final URL in
   * place. The Ad lives at customers/{cid}/ads/{adId} (the adGroupAd id is `<adGroupId>~<adId>`);
   * the update_mask names only the changed fields, then every changed field is read back.
   */
  private async updateResponsiveSearchAdContent(
    customerId: string,
    accessToken: string,
    adGroupAdResourceName: string,
    params: { headlines?: string[]; descriptions?: string[]; finalUrl?: string },
    loginCustomerId?: string,
  ): Promise<void> {
    const match = /^customers\/(\d+)\/adGroupAds\/\d+~(\d+)$/.exec(adGroupAdResourceName);
    if (!match || match[1] !== String(customerId)) throw new GoogleAdsReadBackError(adGroupAdResourceName, ['<invalid resource name>']);
    const adResourceName = `customers/${match[1]}/ads/${match[2]}`;
    const update: any = { resourceName: adResourceName };
    const mask: string[] = [];
    if (params.headlines !== undefined || params.descriptions !== undefined) update.responsiveSearchAd = {};
    if (params.headlines !== undefined) {
      update.responsiveSearchAd.headlines = params.headlines.map((text) => ({ text }));
      mask.push('responsive_search_ad.headlines');
    }
    if (params.descriptions !== undefined) {
      update.responsiveSearchAd.descriptions = params.descriptions.map((text) => ({ text }));
      mask.push('responsive_search_ad.descriptions');
    }
    if (params.finalUrl !== undefined) { update.finalUrls = [params.finalUrl]; mask.push('final_urls'); }
    await this.mutate(customerId, accessToken, 'ads', [{ update, updateMask: mask.join(',') }], loginCustomerId);

    const rows = await this.search(customerId, accessToken,
      'SELECT ad_group_ad.resource_name, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, '
      + `ad_group_ad.ad.responsive_search_ad.descriptions FROM ad_group_ad WHERE ad_group_ad.resource_name = '${adGroupAdResourceName}'`,
      loginCustomerId);
    const ad = rows[0]?.adGroupAd?.ad;
    if (!ad) throw new GoogleAdsReadBackError(adGroupAdResourceName, ['<ad_group_ad not found on read-back>']);
    const same = (a: unknown[] | undefined, b: string[]) => JSON.stringify(a ?? []) === JSON.stringify(b);
    const unchanged: string[] = [];
    if (params.headlines !== undefined && !same(ad.responsiveSearchAd?.headlines?.map((h: any) => h.text), params.headlines)) unchanged.push('responsive_search_ad.headlines');
    if (params.descriptions !== undefined && !same(ad.responsiveSearchAd?.descriptions?.map((d: any) => d.text), params.descriptions)) unchanged.push('responsive_search_ad.descriptions');
    if (params.finalUrl !== undefined && !same(ad.finalUrls, [params.finalUrl])) unchanged.push('final_urls');
    if (unchanged.length) throw new GoogleAdsReadBackError(adGroupAdResourceName, unchanged);
  }

  /**
   * Retag ONE existing, already-live ad that's missing UTMs (Harsha's ask —
   * the audit tool can only find these, never fix them). Deliberately single-ad
   * INPUT: never loop or accept a list. But the WRITE lands on that ad's
   * CAMPAIGN, not the ad itself — see below — so retagging affects every ad
   * under that campaign, not just the one named. Callers/tools must disclose
   * this blast radius; it is bigger than the name suggests.
   *
   * LIVE-VERIFIED 2026-07-16 against a real Google Ads account (customer
   * 2883029950): an ad-level `UPDATE` of `final_url_suffix` is REJECTED —
   * `IMMUTABLE_FIELD: Field 'ad.final_url_suffix' cannot be modified by
   * 'UPDATE' operation` — even though the v24 `Ad` proto carries no IMMUTABLE
   * annotation on this field (unlike the ad-type oneof fields, which do). The
   * public proto and the live server's actual validation disagree; proto
   * silence is not proof of mutability. `updateAd`'s finalUrl-based edit path
   * (used at CREATE time, where this write is allowed) cannot be reused here.
   *
   * CAMPAIGN-level `UPDATE` of `final_url_suffix`, by contrast, was confirmed
   * live to succeed and read back correctly, and a newly-created ad under that
   * campaign was confirmed to correctly INHERIT + MERGE (not overwrite) it —
   * exactly the AC4 behavior `mergeUtmIntoQueryString` is designed for. So this
   * reads the ad's final_url (for the AC4 omission check — never duplicate a
   * key the destination already carries) and the campaign's CURRENT
   * `final_url_suffix` (to merge into, not replace), then writes the merged
   * value back to the CAMPAIGN.
   */
  async retagAdUtm(
    userId: string,
    customerId: string,
    adGroupAdResourceName: string,
  ): Promise<{ success: boolean; reason?: 'no_destination_url' | 'invalid_resource_name' }> {
    if (!this.isValidGoogleAdsResourceName(adGroupAdResourceName)) {
      return { success: false, reason: 'invalid_resource_name' };
    }
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const rows = await this.search(
      customerId,
      accessToken,
      `SELECT ad_group_ad.ad.final_urls, campaign.resource_name, campaign.final_url_suffix `
      + `FROM ad_group_ad WHERE ad_group_ad.resource_name = '${adGroupAdResourceName}'`,
      loginCustomerId,
    );
    const finalUrl = rows[0]?.adGroupAd?.ad?.finalUrls?.[0];
    if (!finalUrl) return { success: false, reason: 'no_destination_url' };

    // Unreadable destination — do not tag; we can't confirm this ad's URL is
    // even a URL, so refuse rather than risk writing anything at all.
    if (!readUtmKeys(finalUrl)) return { success: false };

    const campaignResourceName: string | undefined = rows[0]?.campaign?.resourceName;
    const existingSuffix: string | undefined = rows[0]?.campaign?.finalUrlSuffix;
    const spec = buildUtmSpec('google', { campaign: '{campaignid}', content: '{creative}' });
    // Greptile P1: omission must be driven ONLY by what the EXISTING campaign
    // suffix already defines (mergeUtmIntoQueryString computes that internally
    // from `existingSuffix`) — never by the targeted ad's own URL. The suffix
    // applies to every ad in the campaign at click time; using one ad's URL as
    // the omit mask either strips a key from sibling ads that never had it, or
    // adds a key that duplicates onto one of this ad's OTHER final urls.
    const merged = mergeUtmIntoQueryString(existingSuffix, spec);
    const normalizedExisting = (existingSuffix || '').replace(/^[?&]+/, '').replace(/&+$/, '');
    if (!campaignResourceName || merged === normalizedExisting) return { success: false };

    const success = await this.updateCampaign(userId, customerId, campaignResourceName, { finalUrlSuffix: merged });
    return { success };
  }

  /**
   * Retag ONE existing PMax asset group that's missing UTMs (Harsha's ask,
   * PMax slice — `retagAdUtm` only covers `ad_group_ad`, which a PMax campaign
   * has none of). Deliberately single-target: never loop or accept a list.
   *
   * An asset group has no `final_url_suffix` field of its own (same reason
   * `createAssetGroup` merges straight into `final_urls`) — but it DOES inherit
   * the CAMPAIGN's `final_url_suffix` at delivery. So a key the campaign
   * already supplies must be omitted here too, or the click URL carries it
   * twice. No `content`: Google's docs mark `{creative}` unsupported on PMax
   * (see `createAssetGroup`), so it's never added here either.
   *
   * LIVE-VERIFIED 2026-07-17: `asset_group.final_urls` is writable via UPDATE.
   * That same live run caught a real bug — `updateMask: 'final_urls'` replaces
   * the whole array, so writing back only the first URL silently dropped every
   * other URL a multi-URL PMax asset group had. Fixed by retagging every URL
   * in the array independently and writing the full array back; confirmed live
   * against a real 2-URL asset group that both URLs survive and get tagged.
   */
  async retagAssetGroupUtm(
    userId: string,
    customerId: string,
    assetGroupResourceName: string,
  ): Promise<{ success: boolean; reason?: 'no_destination_url' | 'invalid_resource_name' }> {
    if (!this.isValidGoogleAdsResourceName(assetGroupResourceName)) {
      return { success: false, reason: 'invalid_resource_name' };
    }
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const rows = await this.search(
      customerId,
      accessToken,
      `SELECT asset_group.final_urls, campaign.final_url_suffix `
      + `FROM asset_group WHERE asset_group.resource_name = '${assetGroupResourceName}'`,
      loginCustomerId,
    );
    const finalUrls: string[] = rows[0]?.assetGroup?.finalUrls ?? [];
    if (finalUrls.length === 0) return { success: false, reason: 'no_destination_url' };

    const campaignSuffix: string | undefined = rows[0]?.campaign?.finalUrlSuffix;
    const inheritedKeys = utmKeysInQueryString(campaignSuffix);
    const spec = buildUtmSpec('google', { campaign: '{campaignid}' });

    let changed = false;
    const retaggedUrls = finalUrls.map((finalUrl) => {
      const urlKeys = readUtmKeys(finalUrl);
      if (!urlKeys) return finalUrl; // unreadable — never risk a duplicate, leave as-is

      const omit = new Set<string>([...urlKeys, ...inheritedKeys]);
      const additions = utmQueryString(spec, omit);
      if (!additions) return finalUrl; // this url is already fully tagged

      const hashIndex = finalUrl.indexOf('#');
      const base = hashIndex === -1 ? finalUrl : finalUrl.slice(0, hashIndex);
      const fragment = hashIndex === -1 ? '' : finalUrl.slice(hashIndex);
      const queryIndex = base.indexOf('?');
      const separator = queryIndex === -1 ? '?' : queryIndex === base.length - 1 ? '' : '&';
      changed = true;
      return `${base}${separator}${additions}${fragment}`;
    });

    if (!changed) return { success: false }; // nothing missing on any url

    await this.mutate(customerId, accessToken, 'assetGroups', [{
      update: { resourceName: assetGroupResourceName, finalUrls: retaggedUrls },
      updateMask: 'final_urls',
    }], loginCustomerId);
    // ENG-2398: prove the full array landed (final_urls replaces the whole array).
    await this.verifyFieldsReadBack(customerId, accessToken, 'asset_group', assetGroupResourceName, {
      finalUrls: { gaql: 'final_urls', value: retaggedUrls },
    }, loginCustomerId);
    return { success: true };
  }

  async removeAd(userId: string, customerId: string, adGroupAdResourceName: string): Promise<void> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'adGroupAds', [{ remove: adGroupAdResourceName }], loginCustomerId);
    await this.verifyRemovedReadBack(customerId, accessToken, 'ad_group_ad', adGroupAdResourceName, loginCustomerId);
  }

  // ── Assets ───────────────────────────────────────────────────────────────

  async uploadAsset(userId: string, customerId: string, asset: {
    type: 'IMAGE' | 'LOGO' | 'VIDEO' | 'TEXT';
    name: string;
    data: Buffer | string;
  }): Promise<string> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);

    const assetContent: any = {};
    if (asset.type === 'TEXT') {
      // ENG-2928: a standalone text asset (e.g. a PMax business name or headline).
      if (typeof asset.data !== 'string' || asset.data.trim() === '') throw new Error('TEXT asset data must be the non-empty text');
      assetContent.textAsset = { text: asset.data };
    } else if (asset.type === 'IMAGE' || asset.type === 'LOGO') {
      let imageBuffer: Buffer;
      if (Buffer.isBuffer(asset.data)) {
        imageBuffer = asset.data;
      } else if (typeof asset.data === 'string' && asset.data.startsWith('https://')) {
        // The URL is agent/LLM-supplied (call_google_ads_api `data` arg, reachable
        // via chat or indirect prompt injection), so guard against SSRF before the
        // server-side fetch: block private/internal hosts, disable redirects (a 302
        // to a private IP would otherwise bypass the guard), and cap the size.
        // Mirrors the established pattern in routes/crm.ts.
        // ENG-2928: resolve once and PIN the connection to the validated address. A separate
        // check followed by axios' own DNS lookup can be rebound to an internal address
        // between the two (this path is now reachable by external Zoma API keys).
        const pinned = await resolvePinnedPublicAddress(asset.data);
        const MAX_ASSET_BYTES = 10 * 1024 * 1024; // 10 MB
        // `as any` routes around the legacy @types/axios shim in this repo that
        // doesn't carry maxRedirects/validateStatus on its config interface
        // (same workaround as routes/crm.ts). validateStatus rejects 3xx so a
        // redirect (which maxRedirects:0 stops following) surfaces as an error.
        const response = await axios.get(asset.data, {
          responseType: 'arraybuffer',
          maxRedirects: 0,
          maxContentLength: MAX_ASSET_BYTES,
          maxBodyLength: MAX_ASSET_BYTES,
          timeout: 15000,
          signal: AbortSignal.timeout(15000),
          validateStatus: (s: number) => s >= 200 && s < 300,
          lookup: (_hostname: string, options: any, callback: any) => {
            if (typeof options === 'function') callback = options;
            callback(null, pinned.address, pinned.family);
          },
        } as any);
        imageBuffer = Buffer.from(response.data as ArrayBuffer);
      } else {
        throw new Error('IMAGE/LOGO asset data must be a Buffer or an https:// URL string');
      }
      assetContent.imageAsset = { data: imageBuffer.toString('base64') };
    } else {
      // VIDEO: data is a YouTube video ID string
      if (Buffer.isBuffer(asset.data)) {
        throw new Error('VIDEO asset data must be a YouTube video ID string, not a Buffer');
      }
      assetContent.youtubeVideoAsset = { youtubeVideoId: asset.data };
    }

    // LOGO is a fieldType for CampaignAsset, not a valid AssetType — always upload as IMAGE
    const assetType = asset.type === 'TEXT' ? 'TEXT' : asset.type === 'VIDEO' ? 'YOUTUBE_VIDEO' : 'IMAGE';
    const data = await this.mutate(customerId, accessToken, 'assets', [{
      create: { name: asset.name, type: assetType, ...assetContent },
    }], loginCustomerId);
    return data.results[0].resourceName;
  }

  async attachCampaignAssets(userId: string, customerId: string, campaignResourceName: string, assets: {
    fieldType: 'BUSINESS_NAME' | 'LOGO' | 'SQUARE_MARKETING_IMAGE' | 'MARKETING_IMAGE' | 'HEADLINE' | 'DESCRIPTION';
    assetResourceName?: string;
    text?: string;
  }[]): Promise<void> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const operations: any[] = [];
    for (const asset of assets) {
      let assetResourceName = asset.assetResourceName;
      if (!assetResourceName && asset.text) {
        const textData = await this.mutate(customerId, accessToken, 'assets', [{
          create: { name: asset.text.substring(0, 50), type: 'TEXT', textAsset: { text: asset.text } },
        }], loginCustomerId);
        assetResourceName = textData.results[0].resourceName;
      }
      if (!assetResourceName) {
        throw new Error(`attachCampaignAssets: asset with fieldType "${asset.fieldType}" must provide either assetResourceName or text`);
      }
      operations.push({ create: { campaign: campaignResourceName, asset: assetResourceName, fieldType: asset.fieldType } });
    }
    await this.mutate(customerId, accessToken, 'campaignAssets', operations, loginCustomerId);
  }

  // ── Asset Groups (PMax) ───────────────────────────────────────────────────

  private async createTextAsset(customerId: string, accessToken: string, text: string): Promise<string> {
    const data = await this.mutate(customerId, accessToken, 'assets', [{
      create: { name: text.substring(0, 50), type: 'TEXT', textAsset: { text } },
    }]);
    return data.results[0].resourceName;
  }

  async createAssetGroup(userId: string, customerId: string, params: {
    name: string;
    campaignResourceName: string;
    headlines: string[];
    longHeadlines: string[];
    descriptions: string[];
    squareImageAssets: string[];
    landscapeImageAssets: string[];
    logoAssets: string[];
    videoAssets?: string[];
    finalUrl: string;
  }): Promise<{ resourceName: string }> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);

    // Build everything as a single batch mutate — order: assets first, then asset group, then links
    const assetOps: any[] = [];
    const linkOps: any[] = [];
    let tempIdx = -2; // -1 reserved for asset group

    const tempAssetGroupName = `customers/${customerId}/assetGroups/-1`;

    type AssetFieldType = 'HEADLINE' | 'LONG_HEADLINE' | 'DESCRIPTION' | 'MARKETING_IMAGE' | 'SQUARE_MARKETING_IMAGE' | 'LOGO' | 'YOUTUBE_VIDEO';

    const addTextAssets = (texts: string[], fieldType: AssetFieldType) => {
      for (const text of texts) {
        const tempName = `customers/${customerId}/assets/${tempIdx--}`;
        assetOps.push({
          assetOperation: {
            create: { resourceName: tempName, name: text.substring(0, 50), type: 'TEXT', textAsset: { text } },
          },
        });
        linkOps.push({
          assetGroupAssetOperation: {
            create: { assetGroup: tempAssetGroupName, asset: tempName, fieldType },
          },
        });
      }
    };

    const addImageAssets = (resourceNames: string[], fieldType: AssetFieldType) => {
      for (const asset of resourceNames) {
        linkOps.push({
          assetGroupAssetOperation: {
            create: { assetGroup: tempAssetGroupName, asset, fieldType },
          },
        });
      }
    };

    addTextAssets(params.headlines, 'HEADLINE');
    addTextAssets(params.longHeadlines, 'LONG_HEADLINE');
    addTextAssets(params.descriptions, 'DESCRIPTION');
    addImageAssets(params.squareImageAssets, 'SQUARE_MARKETING_IMAGE');
    addImageAssets(params.landscapeImageAssets, 'MARKETING_IMAGE');
    addImageAssets(params.logoAssets, 'LOGO');
    if (params.videoAssets) addImageAssets(params.videoAssets, 'YOUTUBE_VIDEO');

    // ENG-239: PMax asset groups have no `final_url_suffix` field (unlike Ad and
    // Campaign), so the per-asset-group way to tag the destination is to merge the
    // UTMs straight into `final_urls`. `mergeUtmIntoUrl` is per-key, so a UTM the
    // user already set is left untouched (AC4); ValueTrack macros pass through
    // un-encoded and resolve at click time.
    //
    // No `content` here: Google's own developer docs mark `{creative}` unsupported
    // for Performance Max (developers.google.com/google-ads/api/performance-max/
    // valuetrack) -- it never resolves on a PMax asset group, so emitting it would
    // bake literal, permanently-unresolved text into every click URL. Same fallback
    // LinkedIn already uses for a macro it can't supply.
    // Tagging is a best-effort overlay; it must never be the reason a whole PMax
    // build (headlines, images, links — already assembled at this point) gets
    // thrown away. Google surfaces its own precise validation error for a bad URL.
    let finalUrlWithUtm: string;
    try {
      finalUrlWithUtm = mergeUtmIntoUrl(params.finalUrl, buildUtmSpec('google', { campaign: '{campaignid}' }));
    } catch {
      finalUrlWithUtm = params.finalUrl;
    }

    const assetGroupOp = {
      assetGroupOperation: {
        create: {
          resourceName: tempAssetGroupName,
          name: params.name,
          campaign: params.campaignResourceName,
          status: 'PAUSED',
          finalUrls: [finalUrlWithUtm],
        },
      },
    };

    // Order: text assets → asset group → links
    let mutateOps = [...assetOps, assetGroupOp, ...linkOps];
    let batchResult: any;
    try {
      batchResult = await this.batchMutate(customerId, accessToken, mutateOps, loginCustomerId);
    } catch (err: any) {
      // If brand guidelines enforced: logo must not be in asset group — retry without LOGO links
      const errStr = JSON.stringify(err?.response?.data || err?.message || '');
      if (errStr.includes('BRAND_ASSETS_NOT_LINKED_AT_CAMPAIGN_LEVEL') && errStr.includes('LOGO')) {
        const linkOpsNoLogo = linkOps.filter((op: any) => op.assetGroupAssetOperation?.create?.fieldType !== 'LOGO');
        mutateOps = [...assetOps, assetGroupOp, ...linkOpsNoLogo];
        batchResult = await this.batchMutate(customerId, accessToken, mutateOps, loginCustomerId);
      } else {
        throw err;
      }
    }
    const assetGroupResultIdx = assetOps.length; // asset group is after text assets
    const assetGroupResourceName = batchResult.mutateOperationResponses[assetGroupResultIdx].assetGroupResult.resourceName;

    return { resourceName: assetGroupResourceName };
  }

  /** ENG-2928: campaign + final URLs of a PMax asset group, or null when it can't be found. */
  async getAssetGroup(userId: string, customerId: string, assetGroupResourceName: string): Promise<{ campaignResourceName: string; finalUrls: string[]; status?: string } | null> {
    this.assertResourceName(assetGroupResourceName, 'assetGroups');
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const rows = await this.search(customerId, accessToken,
      `SELECT asset_group.campaign, asset_group.final_urls, asset_group.status FROM asset_group WHERE asset_group.resource_name = '${assetGroupResourceName}'`,
      loginCustomerId,
    );
    const g = rows[0]?.assetGroup;
    return g?.campaign ? { campaignResourceName: g.campaign, finalUrls: g.finalUrls ?? [], status: g.status } : null;
  }

  /** ENG-2928: PMax asset groups are created PAUSED; this is how one is enabled (or paused again). */
  async updateAssetGroup(userId: string, customerId: string, assetGroupResourceName: string, params: {
    status?: 'ENABLED' | 'PAUSED';
  }): Promise<boolean> {
    if (!params.status) return false;
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'assetGroups', [{ update: { resourceName: assetGroupResourceName, status: params.status }, updateMask: 'status' }], loginCustomerId);
    await this.verifyFieldsReadBack(customerId, accessToken, 'asset_group', assetGroupResourceName, { status: { gaql: 'status', value: params.status } }, loginCustomerId);
    return true;
  }

  // ── Reporting ─────────────────────────────────────────────────────────────

  async queryReporting(userId: string, customerId: string, gaqlQuery: string): Promise<any[]> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    return this.search(customerId, accessToken, gaqlQuery, loginCustomerId);
  }

  async getQuickMetrics(userId: string, customerId: string, options: {
    campaignIds?: string[];
    datePreset?: string;
  }): Promise<{ campaigns: any[]; totals: any; currency: string }> {
    const { accessToken, currency, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const dateClause = options.datePreset ? `DURING ${options.datePreset}` : 'DURING LAST_30_DAYS';
    const whereClause = options.campaignIds?.length
      ? `WHERE campaign.id IN (${options.campaignIds.join(',')}) AND segments.date ${dateClause}`
      : `WHERE segments.date ${dateClause}`;

    const query = `SELECT campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.ctr, metrics.average_cpc FROM campaign ${whereClause} ORDER BY metrics.cost_micros DESC`;
    const results = await this.search(customerId, accessToken, query, loginCustomerId);

    const campaigns = results.map((r: any) => {
      const m = r.metrics;
      const spendRaw = Number(m.costMicros || 0) / 1_000_000;
      const clicks = Number(m.clicks || 0);
      const impressions = Number(m.impressions || 0);
      return {
        id: String(r.campaign.id),
        name: r.campaign.name,
        status: r.campaign.status,
        impressions,
        clicks,
        ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
        spendRaw,
        spendFormatted: spendRaw.toFixed(2),
        conversions: Number(m.conversions || 0),
        avgCpc: clicks > 0 ? (spendRaw / clicks).toFixed(2) : '0.00',
      };
    });

    const totals = campaigns.reduce((acc, c) => ({
      impressions: acc.impressions + c.impressions,
      clicks: acc.clicks + c.clicks,
      spend: acc.spend + c.spendRaw,
      conversions: acc.conversions + c.conversions,
    }), { impressions: 0, clicks: 0, spend: 0, conversions: 0 });

    return { campaigns, totals, currency };
  }
}

export const googleAdsService = new GoogleAdsService();
