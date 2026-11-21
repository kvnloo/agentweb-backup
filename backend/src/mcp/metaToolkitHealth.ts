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
 *   meta_optimization_event_check   (ENG-2917) per ad set: is the event it optimizes for
 *                         arriving, and often enough to exit learning (7-day ad-set insights)
 *
 * Reads only: no preview, no write gate, no new storage. The ad account is resolved by the
 * gateway with the same ownership rule as every other toolkit call, and Graph reads go
 * through the account's own `act_<id>` node/edge, so a caller cannot read a foreign account.
 * Definitions and summarizers are pure; the Graph read is injected (defaults load
 * agentModeService lazily so the manifest never imports the service graph).
 */

import { MetaToolkitRefusal } from './metaToolkitErrors';
import { INSIGHTS_FAMILY_BY_OPTIMISATION, resolveOptimisationEvent } from '../services/metaOptimisationCoverage';
import { collapseActions, type ConversionFamily } from '../utils/metaActionFamilies';

export const META_HEALTH_TOOL_NAMES = ['meta_account_health', 'meta_learning_phase', 'meta_optimization_event_check'] as const;
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
    name: 'meta_optimization_event_check',
    description:
      'Read-only check that each ad set is optimizing for an event it actually receives. For every ad set in the account (or one campaign) it returns the ' +
      'optimization event, the spend, and how many of those conversions Meta attributed to the ad set in the last 7 days. Warns when an ad set spent and got ' +
      'none (wrong or broken event) or got fewer than about 50 in 7 days (too few to exit learning). Ad sets with no delivery, or optimizing for a custom ' +
      'event, are returned as not_judged. Call before scaling spend and when results drop.',
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
 * Meta's learning-phase guidance: an ad set needs about 50 optimization events within 7 days
 * to exit learning. https://www.facebook.com/business/help/112167992830700
 */
export const LEARNING_EVENTS_PER_WEEK = 50;
export const OPTIMIZATION_WINDOW = 'last_7d';
/**
 * One adsets read carries each ad set's own 7-day insights. Ad-set insights are the evidence,
 * not the pixel /stats edge: /stats serves about 24 hours and cannot be widened (see
 * metaOptimisationCoverage), so it cannot support a weekly count, and a pixel-wide count
 * would let a busy sibling ad set vouch for this one.
 */
export const OPTIMIZATION_ADSET_FIELDS =
  `id,name,campaign_id,effective_status,optimization_goal,promoted_object,insights.date_preset(${OPTIMIZATION_WINDOW}){spend,actions}`;

/**
 * Optimization goals that deliver against the promoted conversion event. Other goals (for
 * example LINK_CLICKS on a conversions campaign) may still carry a promoted_object, but Meta
 * does not optimize toward that event, so its volume says nothing about delivery.
 */
export const CONVERSION_OPTIMIZATION_GOALS = new Set(['OFFSITE_CONVERSIONS', 'VALUE']);

type OptimizationVerdict = 'ok' | 'low_volume' | 'no_events' | 'not_judged';

export interface OptimizationEventRow {
  ad_set_id: string;
  name?: string;
  campaign_id?: string;
  effective_status?: string;
  optimization_goal?: string;
  optimization_event?: string;
  pixel_id?: string;
  /** Present only when the ad set was judged. */
  spend_7d?: number;
  events_7d?: number;
  verdict: OptimizationVerdict;
  note: string;
}

/**
 * Pure. An ad set that cannot be judged is `not_judged` with the reason and carries no
 * events_7d at all: "we could not count" must never read as "zero arrived".
 */
export function summarizeOptimizationEvents(adSets: any[]) {
  const rows = (Array.isArray(adSets) ? adSets : []).filter((a) => a && typeof a === 'object').map((a): OptimizationEventRow => {
    const promoted = a.promoted_object && typeof a.promoted_object === 'object' ? a.promoted_object : null;
    const resolved = resolveOptimisationEvent(promoted);
    const base = {
      ad_set_id: String(a.id ?? ''),
      name: a.name,
      campaign_id: a.campaign_id,
      effective_status: a.effective_status,
      ...(a.optimization_goal ? { optimization_goal: a.optimization_goal } : {}),
      ...(resolved.kind === 'resolved' ? { optimization_event: resolved.expectedEventName } : {}),
      ...(promoted?.pixel_id ? { pixel_id: String(promoted.pixel_id) } : {}),
    };
    const notJudged = (note: string): OptimizationEventRow => ({ ...base, verdict: 'not_judged', note });

    const goal = typeof a.optimization_goal === 'string' ? a.optimization_goal.toUpperCase() : '';
    if (goal && !CONVERSION_OPTIMIZATION_GOALS.has(goal) && resolved.kind !== 'none') {
      return notJudged(`Optimizes for ${goal}, not for its promoted conversion event, so that event's volume does not apply to this ad set.`);
    }
    if (resolved.kind === 'none') return notJudged('Not optimizing for a conversion event, so there is no event volume to check.');
    if (resolved.kind === 'ignored') {
      return notJudged('Optimizes for a custom conversion. Meta insights do not report it under a standard event, so it is not counted here; check it in Events Manager.');
    }
    if (resolved.kind === 'unrecognised') return notJudged(`Optimization event type ${resolved.key} is not one this check can count.`);
    const family = resolved.custom ? undefined : INSIGHTS_FAMILY_BY_OPTIMISATION[resolved.key];
    if (!family) {
      return notJudged(`${resolved.expectedEventName} is not reported as a standard conversion in ad-set insights, so it is not counted here; check it in Events Manager.`);
    }
    const row = Array.isArray(a.insights?.data) ? a.insights.data[0] : undefined;
    const spend = Number(row?.spend);
    if (!row || !Number.isFinite(spend) || spend <= 0) {
      return notJudged('No spend in the last 7 days, so there is nothing to judge yet.');
    }
    const events = collapseActions(row.actions).get(family as ConversionFamily)?.total ?? 0;
    const counted = { ...base, spend_7d: spend, events_7d: events };
    const event = resolved.expectedEventName;
    if (events === 0) {
      return {
        ...counted,
        verdict: 'no_events',
        note: `Spent in the last 7 days with no ${event} conversions attributed to this ad set. Either ${event} is not firing or it is the wrong event to optimize for; verify the event before spending more.`,
      };
    }
    if (events < LEARNING_EVENTS_PER_WEEK) {
      return {
        ...counted,
        verdict: 'low_volume',
        note: `${events} ${event} conversions in 7 days. Meta needs about ${LEARNING_EVENTS_PER_WEEK} per ad set per week to exit learning; consider a more frequent event, a larger budget or audience, or fewer ad sets.`,
      };
    }
    return { ...counted, verdict: 'ok', note: `${events} ${event} conversions in 7 days.` };
  });
  const count = (v: OptimizationVerdict) => rows.filter((r) => r.verdict === v).length;
  return {
    ad_sets: rows,
    summary: { total: rows.length, ok: count('ok'), low_volume: count('low_volume'), no_events: count('no_events'), not_judged: count('not_judged') },
    warnings: rows
      .filter((r) => r.verdict === 'no_events' || r.verdict === 'low_volume')
      .map((r) => `Ad set ${r.name ? `"${r.name}" (${r.ad_set_id})` : r.ad_set_id}: ${r.note}`),
  };
}

export interface MetaHealthDeps {
  /** GET act_<accountId> (path '') or an act_<accountId>/<edge>, ownership-scoped by the account node. */
  readAccountGraph: (userId: string, accountId: string, edge: '' | 'adsets', params: Record<string, string>) => Promise<any>;
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
  const read = async (edge: '' | 'adsets', params: Record<string, string>) => {
    try {
      return await deps.readAccountGraph(userId, accountId, edge, params);
    } catch (error: any) {
      throw new MetaToolkitRefusal(`Could not read ${edge ? 'ad sets' : 'the ad account'} from Meta: ${error?.metaError?.message || error?.message || 'Meta request failed'}.`);
    }
  };
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
  const optimization = name === 'meta_optimization_event_check';
  const params: Record<string, string> = { fields: optimization ? OPTIMIZATION_ADSET_FIELDS : ADSET_FIELDS, limit: String(MAX_ADSETS) };
  if (filtering.length) params.filtering = JSON.stringify(filtering);
  const res = await read('adsets', params);
  const data = Array.isArray(res?.data) ? res.data : [];
  return {
    account_id: accountId,
    ...(optimization
      ? {
          window: OPTIMIZATION_WINDOW,
          ...summarizeOptimizationEvents(data),
          counting: 'Conversions are those Meta attributed to the ad set; the most recent day can still be filling in.',
        }
      : summarizeLearningPhase(data)),
    ...(res?.paging?.next
      ? { truncated: true, note: `Only the first ${MAX_ADSETS} ad sets were read; the summary counts cover those only. Pass campaign_id to narrow it.` }
      : {}),
  };
}
