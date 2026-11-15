/**
 * ENG-2916 (slice 1) — Zoma "beyond Meta" health reads for external agents.
 *
 * Meta's own ads MCP does not tell an agent that an ad set is still in the learning phase
 * or that the ad account is disabled / in a payment grace period / near its spend cap.
 * Slashy burned budget editing ad sets mid-learning and lost an account without noticing.
 * These two read-only tools surface that state in plain, labelled fields:
 *
 *   meta_account_health   account_status, disable_reason, spend cap / amount spent (major units)
 *   meta_learning_phase   per ad set learning_stage_info (LEARNING / SUCCESS / FAIL)
 *
 * ENG-3030 (slice 2) adds one Meta-parity read on the same account node:
 *
 *   ads_get_opportunity_score   Meta's 0-100 opportunity score and its recommendations
 *
 * Reads only: no preview, no write gate, no new storage. The ad account is resolved by the
 * gateway with the same ownership rule as every other toolkit call, and Graph reads go
 * through the account's own `act_<id>` node/edge, so a caller cannot read a foreign account.
 * Definitions and summarizers are pure; the Graph read is injected (defaults load
 * agentModeService lazily so the manifest never imports the service graph).
 */

import { MetaToolkitRefusal } from './metaToolkitErrors';

export const META_HEALTH_TOOL_NAMES = ['meta_account_health', 'meta_learning_phase', 'ads_get_opportunity_score'] as const;
export type MetaHealthToolName = (typeof META_HEALTH_TOOL_NAMES)[number];

export function isMetaHealthTool(name: string): name is MetaHealthToolName {
  return (META_HEALTH_TOOL_NAMES as readonly string[]).includes(name);
}

export const META_HEALTH_TOOL_DEFINITIONS = [
  {
    name: 'meta_account_health',
    description:
      'Read-only health check of the Meta ad account: whether it can deliver (account_status), why it is disabled if it is (disable_reason), ' +
      'and the account spending limit (spend_cap, amount_spent, remaining, in MAJOR currency units). Returns warnings when ads cannot deliver ' +
      'or the spending limit is nearly used. Call before launching or scaling spend, and when delivery stops unexpectedly.',
    inputSchema: {
      type: 'object',
      properties: { account_id: { type: 'string', description: 'Optional Meta ad account id; defaults to the only connected account.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'meta_learning_phase',
    description:
      'Read-only learning-phase status for every ad set in the account (or one campaign): LEARNING, SUCCESS (exited learning) or FAIL ("learning limited"). ' +
      'Significant edits (budget, bid, targeting, creative, pausing) to an ad set in LEARNING reset learning and waste spend, so check this before changing a live ad set.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Optional Meta ad account id; defaults to the only connected account.' },
        campaign_id: { type: 'string', description: 'Optional: only ad sets of this campaign.' },
        include_inactive: { type: 'boolean', description: 'Include paused/archived ad sets (default false: delivering ad sets only).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ads_get_opportunity_score',
    description:
      "Read-only: Meta's opportunity score for the ad account (0-100, how closely the account follows Meta's own performance recommendations) " +
      'and the recommendations behind it. Each recommendation has its type, the campaigns / ad sets / ads it applies to (object_ids), ' +
      "Meta's estimated score gain (opportunity_score_lift), Meta's explanation when it gives one, and an Ads Manager link. " +
      'These are Meta suggestions, not instructions: this tool applies nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Optional Meta ad account id; defaults to the only connected account.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum recommendations to return (default 50).' },
      },
      additionalProperties: false,
    },
  },
];

// https://developers.facebook.com/docs/marketing-api/reference/ad-account/ (account_status, disable_reason)
const ACCOUNT_STATUS: Record<number, string> = {
  1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED', 7: 'PENDING_RISK_REVIEW', 8: 'PENDING_SETTLEMENT',
  9: 'IN_GRACE_PERIOD', 100: 'PENDING_CLOSURE', 101: 'CLOSED', 201: 'ANY_ACTIVE', 202: 'ANY_CLOSED',
};
const DISABLE_REASON: Record<number, string> = {
  0: 'NONE', 1: 'ADS_INTEGRITY_POLICY', 2: 'ADS_IP_REVIEW', 3: 'RISK_PAYMENT', 4: 'GRAY_ACCOUNT_SHUT_DOWN',
  5: 'ADS_AFC_REVIEW', 6: 'BUSINESS_INTEGRITY_RAR', 7: 'PERMANENT_CLOSE', 8: 'UNUSED_RESELLER_ACCOUNT',
  9: 'UNUSED_ACCOUNT', 10: 'UMBRELLA_AD_ACCOUNT', 11: 'BUSINESS_MANAGER_INTEGRITY_POLICY',
  12: 'MISREPRESENTED_AD_ACCOUNT', 13: 'AOAB_DESHARE_LEGAL_ENTITY', 14: 'CTX_THREAD_REVIEW', 15: 'COMPROMISED_AD_ACCOUNT',
};
/** Currencies Meta bills without a minor unit (offset 1); everything else is cents (offset 100). */
const ZERO_DECIMAL = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']);
export const SPEND_CAP_WARN_RATIO = 0.9;

export const ACCOUNT_FIELDS = 'id,name,currency,account_status,disable_reason,spend_cap,amount_spent';
export const ADSET_FIELDS = 'id,name,campaign_id,effective_status,learning_stage_info';

function toMajor(minor: unknown, currency: string): number | null {
  if (minor === undefined || minor === null || minor === '') return null;
  const n = Number(minor);
  if (!Number.isFinite(n)) return null;
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? n : Math.round(n) / 100;
}

export function summarizeAccountHealth(raw: any) {
  const currency = String(raw?.currency ?? '').toUpperCase();
  const statusCode = Number(raw?.account_status);
  const reasonCode = Number(raw?.disable_reason ?? 0);
  const status = ACCOUNT_STATUS[statusCode] ?? `UNKNOWN_${raw?.account_status}`;
  const disableReason = DISABLE_REASON[reasonCode] ?? `UNKNOWN_${raw?.disable_reason}`;
  // Meta reports spend_cap "0" (or nothing) when no account spending limit is set.
  const capMajor = toMajor(raw?.spend_cap, currency);
  const spendCap = capMajor && capMajor > 0 ? capMajor : null;
  const amountSpent = toMajor(raw?.amount_spent, currency);
  const remaining = spendCap !== null && amountSpent !== null ? Math.max(0, Math.round((spendCap - amountSpent) * 100) / 100) : null;

  // IN_GRACE_PERIOD (9): a payment failed, Meta keeps delivering while it retries the charge.
  const inGracePeriod = statusCode === 9;
  const canDeliver = statusCode === 1 || inGracePeriod;
  const warnings: string[] = [];
  if (inGracePeriod) {
    warnings.push('Ad account is IN_GRACE_PERIOD: a payment failed. Ads still deliver for now, but delivery stops if the balance is not paid; fix the payment method in Meta Billing.');
  }
  if (!canDeliver) {
    warnings.push(
      `Ad account is ${status}${reasonCode ? ` (reason: ${disableReason})` : ''}; ads will not deliver. ` +
        'Do not create or activate ads until it is resolved in Meta Business Settings / Account Quality.',
    );
  }
  if (spendCap !== null && amountSpent !== null) {
    if (amountSpent >= spendCap) warnings.push('Account spending limit is reached; all ads in this account are stopped until it is raised or reset.');
    else if (amountSpent >= spendCap * SPEND_CAP_WARN_RATIO) warnings.push(`Account spending limit is ${Math.round((amountSpent / spendCap) * 100)}% used; delivery stops when it is reached.`);
  }
  return {
    account_id: String(raw?.id ?? ''),
    name: raw?.name,
    currency,
    can_deliver: canDeliver,
    account_status: status,
    disable_reason: disableReason,
    spend_cap: spendCap,
    amount_spent: amountSpent,
    remaining,
    warnings,
  };
}

const LEARNING_STATUSES = new Set(['LEARNING', 'SUCCESS', 'FAIL']);

export function summarizeLearningPhase(adSets: any[]) {
  const rows = (adSets ?? []).map((a) => {
    const info = a?.learning_stage_info;
    const rawStatus = String(info?.status ?? '').toUpperCase();
    const learning = LEARNING_STATUSES.has(rawStatus) ? rawStatus : 'UNKNOWN';
    const lastEdit = Number(info?.last_sig_edit_ts);
    return {
      ad_set_id: String(a?.id ?? ''),
      name: a?.name,
      campaign_id: a?.campaign_id,
      effective_status: a?.effective_status,
      learning_status: learning,
      ...(info?.conversions !== undefined ? { conversions_in_window: Number(info.conversions) } : {}),
      ...(Number.isFinite(lastEdit) && lastEdit > 0 ? { last_significant_edit: new Date(lastEdit * 1000).toISOString() } : {}),
      note:
        learning === 'LEARNING'
          ? 'In learning: avoid significant edits (budget, bid, targeting, creative, pause) until it exits, or learning restarts.'
          : learning === 'FAIL'
            ? 'Learning limited: not getting enough optimization events. Consider consolidating ad sets, a broader audience, a higher budget or a higher-funnel optimization event.'
            : learning === 'SUCCESS'
              ? 'Exited learning; delivery is stable.'
              : 'Meta returned no learning status (often paused, new without delivery, or not optimizing for conversions).',
    };
  });
  const count = (s: string) => rows.filter((r) => r.learning_status === s).length;
  return {
    ad_sets: rows,
    summary: { total: rows.length, learning: count('LEARNING'), success: count('SUCCESS'), learning_limited: count('FAIL'), unknown: count('UNKNOWN') },
  };
}

/**
 * ENG-3030. Meta "Opportunity Score and Recommendations":
 * https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/performance-recommendations
 *   act_<id>?fields=opportunity_score   "provided as a field of an ad account", 0-100
 *   act_<id>/recommendations            documented with no fields / limit parameter; answers
 *                                       { data: [{ recommendations: [...] }] }
 * The edge is called exactly as documented (no parameters) and `limit` is applied here.
 * recommendation_signature (the perishable handle for Meta's apply call) comes back in that
 * response and is deliberately not passed on: Zoma has no apply path, so it would be an
 * unusable write handle in a read result.
 */
export const OPPORTUNITY_SCORE_FIELDS = 'opportunity_score';
export const DEFAULT_RECOMMENDATIONS = 50;
export const MAX_RECOMMENDATIONS = 100;
const OPPORTUNITY_SCORE_ARGS = new Set(['account_id', 'limit']);

function finiteOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Throws before any Graph read when an argument is unknown or malformed; returns the limit. */
export function parseOpportunityScoreArgs(args: any): number {
  if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
    throw new MetaToolkitRefusal('Arguments must be an object.');
  }
  const unknown = Object.keys(args ?? {}).filter((k) => !OPPORTUNITY_SCORE_ARGS.has(k));
  if (unknown.length) throw new MetaToolkitRefusal(`Unknown argument(s): ${unknown.join(', ')}. Allowed: account_id, limit.`);
  if (args?.limit === undefined) return DEFAULT_RECOMMENDATIONS;
  if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_RECOMMENDATIONS) {
    throw new MetaToolkitRefusal(`limit must be an integer from 1 to ${MAX_RECOMMENDATIONS}.`);
  }
  return args.limit;
}

export function summarizeOpportunityScore(accountId: string, account: any, edge: any, limit: number) {
  const data: any[] = Array.isArray(edge?.data) ? edge.data : [];
  // Documented shape is grouped ({ recommendations: [...] } per row; the business-level edge adds
  // opportunity_score to the row). A flat list is accepted too rather than silently dropped.
  const flat = data.flatMap((row) => (Array.isArray(row?.recommendations) ? row.recommendations : [row]))
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row));
  const all = flat.map((r) => {
    const content = r.recommendation_content && typeof r.recommendation_content === 'object' ? r.recommendation_content : {};
    const lift = finiteOrNull(r.opportunity_score_lift ?? content.opportunity_score_lift);
    return {
      type: typeof r.type === 'string' ? r.type : 'UNKNOWN',
      object_ids: Array.isArray(r.object_ids) ? r.object_ids.map((id: unknown) => String(id)) : [],
      opportunity_score_lift: lift,
      ...(content.lift_estimate !== undefined && content.lift_estimate !== null ? { lift_estimate: String(content.lift_estimate) } : {}),
      ...(typeof content.body === 'string' && content.body ? { body: content.body } : {}),
      ...(typeof r.url === 'string' && r.url ? { url: r.url } : {}),
    };
  });
  const recommendations = all.slice(0, limit);
  const groupedScore = data.find((row) => row && typeof row === 'object' && row.opportunity_score !== undefined)?.opportunity_score;
  const score = finiteOrNull(account?.opportunity_score ?? groupedScore);
  const truncated = all.length > limit || Boolean(edge?.paging?.next);
  return {
    account_id: accountId,
    opportunity_score: score,
    recommendations,
    summary: { returned: recommendations.length },
    ...(score === null ? { note: 'Meta returned no opportunity score for this ad account (it is not available on every account).' } : {}),
    ...(truncated ? { truncated: true, truncated_note: `Only the first ${recommendations.length} recommendations are returned; Meta has more.` } : {}),
  };
}

export type MetaHealthEdge = '' | 'adsets' | 'recommendations';

export interface MetaHealthDeps {
  /** GET act_<accountId> (path '') or an act_<accountId>/<edge>, ownership-scoped by the account node. */
  readAccountGraph: (userId: string, accountId: string, edge: MetaHealthEdge, params: Record<string, string>) => Promise<any>;
}

const defaultDeps: MetaHealthDeps = {
  readAccountGraph: async (userId, accountId, edge, params) => {
    const { agentModeService } = await import('../services/agentModeService');
    return agentModeService.readToolkitMetaAccountGraph(userId, accountId, edge, params);
  },
};

const MAX_ADSETS = 200;

export async function runMetaHealthTool(
  name: MetaHealthToolName,
  userId: string,
  accountId: string,
  args: any,
  deps: MetaHealthDeps = defaultDeps,
) {
  // Graph errors are re-thrown as a refusal with Meta's own message only (never the request).
  const read = async (edge: MetaHealthEdge, params: Record<string, string>) => {
    try {
      return await deps.readAccountGraph(userId, accountId, edge, params);
    } catch (error: any) {
      const what = edge === 'adsets' ? 'ad sets' : edge === 'recommendations' ? 'recommendations' : 'the ad account';
      throw new MetaToolkitRefusal(`Could not read ${what} from Meta: ${error?.metaError?.message || error?.message || 'Meta request failed'}.`);
    }
  };
  if (name === 'ads_get_opportunity_score') {
    const limit = parseOpportunityScoreArgs(args);
    const account = await read('', { fields: OPPORTUNITY_SCORE_FIELDS });
    const edge = await read('recommendations', {});
    return summarizeOpportunityScore(accountId, account, edge, limit);
  }
  if (name === 'meta_account_health') {
    return summarizeAccountHealth(await read('', { fields: ACCOUNT_FIELDS }));
  }
  const filtering: any[] = [];
  if (args?.campaign_id !== undefined) {
    const campaignId = String(args.campaign_id);
    if (!/^\d+$/.test(campaignId)) throw new MetaToolkitRefusal('campaign_id must be a numeric Meta campaign id.');
    filtering.push({ field: 'campaign.id', operator: 'IN', value: [campaignId] });
  }
  if (args?.include_inactive !== true) filtering.push({ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] });
  const params: Record<string, string> = { fields: ADSET_FIELDS, limit: String(MAX_ADSETS) };
  if (filtering.length) params.filtering = JSON.stringify(filtering);
  const res = await read('adsets', params);
  const data = Array.isArray(res?.data) ? res.data : [];
  return {
    account_id: accountId,
    ...summarizeLearningPhase(data),
    ...(res?.paging?.next
      ? { truncated: true, note: `Only the first ${MAX_ADSETS} ad sets were read; the summary counts cover those only. Pass campaign_id to narrow it.` }
      : {}),
  };
}
