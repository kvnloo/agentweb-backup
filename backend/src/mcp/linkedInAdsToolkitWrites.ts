/**
 * Guarded LinkedIn Ads writes for external Zoma agents (provider #4 of the ENG-2303 guarded-write
 * flow; X's is xAdsToolkitWrites.ts). Only while ZOMA_LINKEDIN_ADS_ENABLED=true (read mode refuses).
 *
 * Allowed: CAMPAIGN_GROUP CREATE / UPDATE (name, total budget) / PAUSE / ACTIVATE; CAMPAIGN CREATE /
 * UPDATE (name, budgets, unit cost, schedule) / PAUSE / ACTIVATE; CREATIVE CREATE (an existing post,
 * or a text ad) / PAUSE / ACTIVATE.
 *
 * Flow (shared guard, zomaWriteGuard.ts):
 *   1. Shape validation: pure, before any credential or LinkedIn call. Every value LinkedIn needs is
 *      REQUIRED from the caller and sent explicitly (name, type, objective, cost type, unit cost, daily
 *      budget, schedule, locale, political intent, targeting, the account's currency). Nothing is taken
 *      from linkedInAdsService's defaults (it would default a group to ACTIVE, a creative to ACTIVE, the
 *      unit cost to 2.00 USD, every currency to USD, the locale to US/en); a request that carries a
 *      status is refused.
 *   2. Write readiness (payment method + usable LinkedIn connection) and consent (rw_ads).
 *   3. Read the current state the preview describes.
 *   4. LINKEDIN_ADS_TOOLKIT_SPEND_CEILING, keyed by currency, on every budget this write sets and on
 *      the budget an ACTIVATE unlocks.
 *   5. No confirm → PREVIEW + single-use preview_token bound to user, arguments and state.
 *   6. confirm=true + matching token → applied ONCE → independent read-back.
 *
 * New campaign groups, campaigns and creatives are created DRAFT. DRAFT is never serving; ACTIVATE is
 * the only way to start delivery and it is its own preview and approval.
 *
 * READ-BACK HAS NEVER BEEN EXERCISED AGAINST A REAL LINKEDIN ACCOUNT. There is no test ad account; the
 * shapes below come from LinkedIn's documentation and from the mocked tests (Emma's own ENG-3064
 * read-back was merged on mocked evidence too). So it is conservative: only a well-formed answer whose
 * compared fields all match is CONFIRMED; a field that differs is MISMATCH; a missing field, an
 * unexpected shape or a failed read is UNCONFIRMED, never CONFIRMED. Nothing here may be described as
 * live-verified. A failure without a definite answer (no response, 5xx, 408) may have applied, so it
 * is UNCONFIRMED, never "did not apply".
 *
 * LinkedIn 403 "not configured to access the related advertiser account(s)" (the app's Development
 * tier: writes only work for ad accounts on its Account Management list) is turned into a customer
 * message (LINKEDIN_WRITE_NOT_ENABLED) and is never reported as applied.
 */
import crypto from 'crypto';
import { getJwtSecret } from '../config/jwt';
import { buildUtmSpec, mergeUtmIntoUrl } from '../utils/adUtm';
import { evaluateMetaSpendCeiling, type MetaSpendCeilingPolicy } from '../services/agentMode/metaSpendCeiling';
import * as linkedInAdsService from '../services/linkedInAdsService';
import { formatMicros, googleSpendCeilingPolicyFromEnv, majorToMicros } from './googleToolkitWrites';
import {
  assertLinkedInAdsToolkitCall, LINKEDIN_ADS_WRITE_TOOL, LINKEDIN_CAMPAIGN_TYPES, LINKEDIN_COST_TYPES, LINKEDIN_OBJECTIVE_TYPES,
  LINKEDIN_POLITICAL_INTENTS, linkedInId, validateTargetingClauses,
} from './linkedInAdsToolkitManifest';
import {
  callLinkedIn, classifyLinkedInFailure, LINKEDIN_WRITE_NOT_ENABLED, LINKEDIN_WRITES_NOT_AVAILABLE, linkedInRateLimitedResult, redactLinkedInText,
  type LinkedInAdsSession, type LinkedInCallResult,
} from './linkedInAdsCall';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { assertZomaWriteReady, ZomaNotReadyError } from './zomaOnboarding';
import { linkedInAdsWritesEnabled } from './zomaToolDefinitions';
import {
  consumeToken, defaultConsumedTokenStore, type ConsumedTokens, previewFingerprint, previewResponse, previewTokenMatches, stableStringify, type WriteVerification,
} from './zomaWriteGuard';

// ── Spend ceiling (LINKEDIN_ADS_TOOLKIT_SPEND_CEILING) ───────────────────────────

/**
 * Zoma's spend limit for LinkedIn, keyed by currency code, because LinkedIn budgets are decimal strings in the ad
 * account's own currency. LINKEDIN_ADS_TOOLKIT_SPEND_CEILING is JSON like
 * {"USD":{"maxDailyBudget":100000000,"maxChangeRatio":3,"maxTotalBudget":2000000000},"EUR":{...}}, money in
 * MICROS of that currency (the unit of GOOGLE_TOOLKIT_SPEND_CEILING and X_ADS_TOOLKIT_SPEND_CEILING); no message
 * to a customer ever shows micros.
 *   - unset or empty: the built-in default below (conservative: USD only), so nothing new is required and
 *     full mode is never unlimited. (Google's and X's unset means no ceiling; LinkedIn's does not.)
 *   - set but not that shape (not JSON, not an object, a key that is not a 3-letter currency code, a
 *     value with no limit): fails closed. Every budget INCREASE is refused until it is fixed.
 *   - set: a budget increase on an account whose currency is missing, or is not a key of the policy, is
 *     refused; the account's own entry is then applied.
 *   - a total (lifetime) budget is capped by maxTotalBudget; an entry that sets maxDailyBudget but no
 *     maxTotalBudget caps the total at 30 x that daily limit; an entry with neither has no total cap.
 *   - a change that LOWERS a budget is never refused for being above a limit (see executeLinkedInAdsWrite).
 */
export interface LinkedInCurrencyPolicy extends MetaSpendCeilingPolicy {
  /** Highest total (lifetime) budget, micros. */
  maxTotalBudget?: number;
}
export type LinkedInSpendCeiling = { unreadable: true } | { byCurrency: Record<string, LinkedInCurrencyPolicy> };

/** A total budget may be this many days of the daily limit when nothing says otherwise. */
export const DEFAULT_TOTAL_BUDGET_DAYS = 30;

/**
 * Built in, used when LINKEDIN_ADS_TOOLKIT_SPEND_CEILING is unset (no env var is needed for it to hold):
 * USD only, a daily budget of at most 50.00, a single change of at most 2x, a total budget of at most 1,500.00
 * (30 x the daily limit). Any other currency is refused until the env var configures it. Setting the env var
 * REPLACES this default entirely. Micros of the account currency (50 USD = 50_000_000).
 * TO CONFIRM WITH HARSHA: these numbers and the USD-only choice.
 */
export const DEFAULT_LINKEDIN_SPEND_CEILING: LinkedInSpendCeiling = {
  byCurrency: { USD: { maxDailyBudget: 50_000_000, maxChangeRatio: 2, maxTotalBudget: DEFAULT_TOTAL_BUDGET_DAYS * 50_000_000 } },
};

/** The cap on a total (lifetime) budget under a policy, micros; undefined when it sets none. */
export const totalBudgetCap = (policy: LinkedInCurrencyPolicy): number | undefined =>
  policy.maxTotalBudget ?? (typeof policy.maxDailyBudget === 'number' ? policy.maxDailyBudget * DEFAULT_TOTAL_BUDGET_DAYS : undefined);

function currencyPolicyFromEntry(entry: Record<string, unknown>): LinkedInCurrencyPolicy {
  const total = entry.maxTotalBudget;
  const totalOk = total === undefined || (typeof total === 'number' && Number.isFinite(total) && total > 0);
  const hasEvaluated = entry.maxDailyBudget !== undefined || entry.maxChangeRatio !== undefined;
  // The same parser the sibling providers use for the two limits it knows; anything it cannot read refuses everything.
  const base: MetaSpendCeilingPolicy = hasEvaluated
    ? (googleSpendCeilingPolicyFromEnv(JSON.stringify({ maxDailyBudget: entry.maxDailyBudget, maxChangeRatio: entry.maxChangeRatio })) ?? { maxChangeRatio: -1 })
    : {};
  if (!totalOk || (!hasEvaluated && total === undefined)) return { maxChangeRatio: -1 };
  return { ...base, ...(total !== undefined ? { maxTotalBudget: total as number } : {}) };
}

export function linkedInSpendCeilingFromEnv(raw: string | undefined = process.env.LINKEDIN_ADS_TOOLKIT_SPEND_CEILING): LinkedInSpendCeiling | null {
  if (!raw) return DEFAULT_LINKEDIN_SPEND_CEILING;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>);
      if (entries.length > 0 && entries.every(([code, value]) => /^[A-Z]{3}$/.test(code) && value && typeof value === 'object' && !Array.isArray(value))) {
        return { byCurrency: Object.fromEntries(entries.map(([code, value]) => [code, currencyPolicyFromEntry(value as Record<string, unknown>)])) };
      }
    }
  } catch {
    /* fall through */
  }
  return { unreadable: true };
}

const SUPPORT = 'Zoma support (support@agentweb.pro)';

/** The policy that applies to a budget increase on an account in `currency`, or the reason it is refused. */
export function ceilingForCurrency(ceiling: LinkedInSpendCeiling | null, currency: string): { policy: LinkedInCurrencyPolicy | null; refusal?: string } {
  if (!ceiling) return { policy: null };
  if ('unreadable' in ceiling) {
    return { policy: null, refusal: `Zoma's spend limit for LinkedIn is misconfigured, so no budget was changed. Please contact ${SUPPORT}.` };
  }
  if (!currency) return { policy: null, refusal: 'This LinkedIn ad account has no currency on record, so a budget cannot be checked against Zoma\'s spend limit and nothing was changed. Reconnect LinkedIn Ads.' };
  const policy = ceiling.byCurrency[currency];
  if (!policy) {
    return {
      policy: null,
      refusal: `Zoma's spend limit for LinkedIn currently covers ${Object.keys(ceiling.byCurrency).join(', ')} ad accounts only, and this ad account is in ${currency}, so no budget was changed. Ask ${SUPPORT} to enable ${currency}.`,
    };
  }
  return { policy };
}

/** "at most 50.00 USD a day, a change of at most 2x and at most 1,500.00 USD in total": what a policy allows, in words. */
function describePolicy(policy: LinkedInCurrencyPolicy, currency: string): string {
  const parts: string[] = [];
  if (typeof policy.maxDailyBudget === 'number') parts.push(`at most ${formatMicros(policy.maxDailyBudget, currency)} a day`);
  if (typeof policy.maxChangeRatio === 'number') parts.push(`a single change of at most ${policy.maxChangeRatio}x`);
  const total = totalBudgetCap(policy);
  if (total !== undefined) parts.push(`at most ${formatMicros(total, currency)} in total`);
  return parts.length ? parts.join(', ') : 'no limit';
}

/** Why a budget was refused, in terms a customer can act on (what the limit is and who changes it). */
function limitRefusal(what: string, policy: LinkedInCurrencyPolicy, currency: string): string {
  return `${what} Zoma's safety limit for LinkedIn ${currency} ad accounts is ${describePolicy(policy, currency)}. It is Zoma's own default limit: to raise it, ask ${SUPPORT}. Do not split the change to get around it. Nothing was sent.`;
}

// ── Dependencies ──────────────────────────────────────────────────────────────

export type LinkedInAdsWriteApi = Pick<
  typeof linkedInAdsService,
  | 'getCampaignGroup' | 'getCampaign' | 'getCreative' | 'getPost' | 'listCampaigns'
  | 'createCampaignGroup' | 'updateCampaignGroup' | 'createCampaign' | 'updateCampaign' | 'createCreative' | 'updateCreativeStatus'
>;

export interface LinkedInAdsWriteDeps {
  api: LinkedInAdsWriteApi;
  assertReady: (userId: string) => Promise<void>;
  spendCeiling: () => LinkedInSpendCeiling | null;
  secret: () => string;
  now: () => number;
  consumedTokens: ConsumedTokens;
  writesEnabled: () => boolean;
}

export const defaultLinkedInAdsWriteDeps: LinkedInAdsWriteDeps = {
  api: linkedInAdsService,
  assertReady: (userId) => assertZomaWriteReady(userId, undefined, 'linkedin_ads'),
  spendCeiling: () => linkedInSpendCeilingFromEnv(),
  secret: () => getJwtSecret(),
  now: () => Date.now(),
  consumedTokens: defaultConsumedTokenStore,
  writesEnabled: () => linkedInAdsWritesEnabled(),
};

// ── Validation ────────────────────────────────────────────────────────────────

type Kind = 'group' | 'campaign' | 'creative';

/** Validated, LinkedIn-shaped write. `params` is exactly what the service receives; nothing is spread from the caller. */
interface ValidatedLinkedInWrite {
  op: string;
  kind: Kind;
  action: 'CREATE' | 'UPDATE' | 'PAUSE' | 'ACTIVATE';
  /** Existing entity read before (preview) and after (read-back). */
  target?: { kind: Kind; id: string };
  /** CREATE: the existing entity the new one belongs to. */
  parent?: { kind: 'group' | 'campaign'; id: string };
  params: Record<string, any>;
  /** What the read-back must show (path in the entity → expected value). */
  expect: Array<{ path: string; value: string | number; as: 'string' | 'amount' | 'number' }>;
  /** Fields the read-back does not compare, said out loud in the result. */
  notCompared: string[];
  /** Money this write sets, in micros. */
  dailyMicros?: number;
  totalMicros?: number;
  unitCostMicros?: number;
  /** CAMPAIGN UPDATE / ACTIVATE: a new start was given (the stored end is carried over). */
  newStartMs?: number;
  newEndMs?: number;
  /** For the preview. */
  summary: string[];
}

const ACCEPTED: Record<string, string[]> = {
  'CAMPAIGN_GROUP CREATE': ['name', 'start_time', 'end_time', 'total_budget'],
  'CAMPAIGN_GROUP UPDATE': ['campaign_group_id', 'name', 'total_budget'],
  'CAMPAIGN_GROUP PAUSE': ['campaign_group_id'],
  'CAMPAIGN_GROUP ACTIVATE': ['campaign_group_id'],
  'CAMPAIGN CREATE': [
    'campaign_group_id', 'name', 'campaign_type', 'objective_type', 'cost_type', 'unit_cost', 'daily_budget', 'total_budget', 'start_time', 'end_time',
    'locale_country', 'locale_language', 'political_intent', 'targeting_include', 'targeting_exclude',
  ],
  'CAMPAIGN UPDATE': ['campaign_id', 'name', 'daily_budget', 'total_budget', 'unit_cost', 'start_time', 'end_time'],
  'CAMPAIGN PAUSE': ['campaign_id'],
  'CAMPAIGN ACTIVATE': ['campaign_id', 'start_time'],
  'CREATIVE CREATE': ['campaign_id', 'post_urn', 'headline', 'description', 'landing_page', 'image_urn'],
  'CREATIVE PAUSE': ['creative_id'],
  'CREATIVE ACTIVATE': ['creative_id'],
};
const ENVELOPE = ['entity_type', 'action', 'account_id', 'confirm', 'preview_token'];

/** Line breaks and other control characters (and bidi overrides) in text the user is asked to approve. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
const noControlChars = (value: string, field: string): string => {
  if (CONTROL_CHARS.test(value)) throw new MetaToolkitRefusal(`${field} must not contain line breaks or other control characters.`);
  return value;
};
const requireName = (v: unknown): string => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > 100) throw new MetaToolkitRefusal('name must be 1-100 characters.');
  return noControlChars(v.trim(), 'name');
};

/**
 * Text that did not come from this call (a name or content stored on LinkedIn) or that a caller typed, as it is
 * echoed in a preview: control characters and newlines become spaces (so it can never start a line of its own and
 * pose as part of the preview), runs of spaces collapse, and a long text is cut with a visible marker.
 */
export function previewText(value: unknown, max = 200): string {
  let raw: string;
  try {
    raw = String(value ?? '');
  } catch {
    raw = '';
  }
  const text = raw.replace(new RegExp(CONTROL_CHARS.source, 'g'), ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}… [cut: ${text.length - max} more characters]` : text;
}

/** The URL LinkedIn really receives for a text ad: the service appends its utm tags (appendLinkedInUtm); a URL it cannot parse is sent as it is. */
export function finalLandingPage(url: string, campaignId: string): string {
  try {
    return mergeUtmIntoUrl(url, buildUtmSpec('linkedin', { campaign: campaignId }));
  } catch {
    return url;
  }
}

/** The preview as a whole is bounded: a change too large to show in full is refused rather than approved unseen. */
export const PREVIEW_MAX_CHARS = 20_000;
/** How many of a group's campaigns an ACTIVATE preview lists by name. */
export const PREVIEW_MAX_LISTED_CAMPAIGNS = 20;
const isoToMs = (v: unknown, field: string): number => {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms) || !/\d{4}-\d{2}-\d{2}/.test(String(v))) throw new MetaToolkitRefusal(`${field} must be an ISO 8601 date-time, e.g. 2026-12-01T09:00:00Z.`);
  return ms;
};
const pickEnum = <T extends string>(v: unknown, allowed: readonly T[], field: string): T => {
  if (!allowed.includes(v as T)) throw new MetaToolkitRefusal(`${field} is required and must be one of ${allowed.join(', ')}.`);
  return v as T;
};
const currencyDigits = (currency: string): number => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
};
/** LinkedIn sends and echoes money as a decimal string in major units of the account currency. */
export const microsToAmount = (micros: number, currency: string): string => (micros / 1e6).toFixed(currencyDigits(currency));
/** A LinkedIn amount string → micros; undefined when it is not a finite non-negative number. */
export const amountToMicros = (amount: unknown): number | undefined => {
  if (typeof amount !== 'string' && typeof amount !== 'number') return undefined;
  if (typeof amount === 'string' && !amount.trim()) return undefined; // "" is not zero: Number("") would say so
  const n = Number(amount);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6) : undefined;
};
/** The bare numeric id in a LinkedIn id, a URN, or a number; undefined when there is none. */
export const trailingId = (value: unknown): string | undefined => {
  const m = /(\d{1,20})(?:\D*)$/.exec(String(value ?? ''));
  return m ? m[1] : undefined;
};

export function validateLinkedInAdsWriteShape(rawArgs: any, currency: string): ValidatedLinkedInWrite {
  assertLinkedInAdsToolkitCall(LINKEDIN_ADS_WRITE_TOOL, rawArgs);
  const entity = String(rawArgs.entity_type);
  const action = String(rawArgs.action) as ValidatedLinkedInWrite['action'];
  const op = `${entity} ${action}`;
  const allowed = new Set([...ENVELOPE, ...(ACCEPTED[op] ?? [])]);
  const extra = Object.keys(rawArgs).filter((k) => !allowed.has(k));
  if (extra.length) throw new MetaToolkitRefusal(`${op} does not accept: ${extra.slice(0, 5).join(', ')}.`);
  const a = rawArgs;
  const kind: Kind = entity === 'CAMPAIGN_GROUP' ? 'group' : entity === 'CAMPAIGN' ? 'campaign' : 'creative';
  const cur = /^[A-Z]{3}$/.test(currency) ? currency : '';
  const money = (v: unknown, field: string): { micros: number; amount: string } => {
    if (!cur) throw new MetaToolkitRefusal('This LinkedIn ad account has no currency on record, so a budget or bid cannot be set and nothing was changed. Reconnect LinkedIn Ads.');
    const micros = majorToMicros(v, cur, field);
    if (micros <= 0) throw new MetaToolkitRefusal(`${field} must be greater than 0.`);
    return { micros, amount: microsToAmount(micros, cur) };
  };
  const base = { op, kind, action, expect: [] as ValidatedLinkedInWrite['expect'], notCompared: [] as string[], summary: [] as string[] };

  // Status changes: PAUSE / ACTIVATE only. (A `status` argument never reaches here: the schema has none.)
  if (action === 'PAUSE' || action === 'ACTIVATE') {
    const status = action === 'ACTIVATE' ? 'ACTIVE' : 'PAUSED';
    if (kind === 'creative') {
      const id = linkedInId(a.creative_id, 'creative', 'creative_id');
      return { ...base, target: { kind, id }, params: { status }, expect: [{ path: 'intendedStatus', value: status, as: 'string' }] };
    }
    if (kind === 'group') {
      const id = linkedInId(a.campaign_group_id, 'group', 'campaign_group_id');
      return { ...base, target: { kind, id }, params: { status }, expect: [{ path: 'status', value: status, as: 'string' }] };
    }
    const id = linkedInId(a.campaign_id, 'campaign', 'campaign_id');
    const params: Record<string, any> = { status };
    const out: ValidatedLinkedInWrite = { ...base, target: { kind, id }, params, expect: [{ path: 'status', value: status, as: 'string' }] };
    if (a.start_time !== undefined) {
      out.newStartMs = isoToMs(a.start_time, 'start_time');
      out.expect.push({ path: 'runSchedule.start', value: out.newStartMs, as: 'number' });
    }
    return out;
  }

  switch (op) {
    case 'CAMPAIGN_GROUP CREATE': {
      const name = requireName(a.name);
      const start = isoToMs(a.start_time, 'start_time');
      const end = a.end_time === undefined ? undefined : isoToMs(a.end_time, 'end_time');
      if (end !== undefined && end <= start) throw new MetaToolkitRefusal('end_time must be after start_time.');
      const params: Record<string, any> = { name, status: 'DRAFT', run_schedule_start: start };
      const expect: ValidatedLinkedInWrite['expect'] = [
        { path: 'name', value: name, as: 'string' }, { path: 'status', value: 'DRAFT', as: 'string' }, { path: 'runSchedule.start', value: start, as: 'number' },
      ];
      if (end !== undefined) { params.run_schedule_end = end; expect.push({ path: 'runSchedule.end', value: end, as: 'number' }); }
      const out: ValidatedLinkedInWrite = { ...base, params, expect };
      if (a.total_budget !== undefined) {
        const m = money(a.total_budget, 'total_budget');
        params.total_budget_amount = m.amount;
        params.total_budget_currency = cur;
        out.totalMicros = m.micros;
        expect.push({ path: 'totalBudget.amount', value: m.amount, as: 'amount' }, { path: 'totalBudget.currencyCode', value: cur, as: 'string' });
      }
      return out;
    }
    case 'CAMPAIGN_GROUP UPDATE': {
      const id = linkedInId(a.campaign_group_id, 'group', 'campaign_group_id');
      const params: Record<string, any> = {};
      const expect: ValidatedLinkedInWrite['expect'] = [];
      const out: ValidatedLinkedInWrite = { ...base, target: { kind, id }, params, expect };
      if (a.name !== undefined) { params.name = requireName(a.name); expect.push({ path: 'name', value: params.name, as: 'string' }); }
      if (a.total_budget !== undefined) {
        const m = money(a.total_budget, 'total_budget');
        params.total_budget_amount = m.amount;
        params.total_budget_currency = cur;
        out.totalMicros = m.micros;
        expect.push({ path: 'totalBudget.amount', value: m.amount, as: 'amount' }, { path: 'totalBudget.currencyCode', value: cur, as: 'string' });
      }
      if (!expect.length) throw new MetaToolkitRefusal('CAMPAIGN_GROUP UPDATE needs name or total_budget.');
      return out;
    }
    case 'CAMPAIGN CREATE': {
      const groupId = linkedInId(a.campaign_group_id, 'group', 'campaign_group_id');
      const name = requireName(a.name);
      const type = pickEnum(a.campaign_type, LINKEDIN_CAMPAIGN_TYPES, 'campaign_type');
      const objective = pickEnum(a.objective_type, LINKEDIN_OBJECTIVE_TYPES, 'objective_type');
      const costType = pickEnum(a.cost_type, LINKEDIN_COST_TYPES, 'cost_type');
      const political = pickEnum(a.political_intent, LINKEDIN_POLITICAL_INTENTS, 'political_intent');
      if (a.unit_cost === undefined) throw new MetaToolkitRefusal('unit_cost is required (the max bid in major units of the account currency): Zoma never picks a bid for you.');
      if (a.daily_budget === undefined) throw new MetaToolkitRefusal('daily_budget is required (major units of the account currency).');
      const unit = money(a.unit_cost, 'unit_cost');
      const daily = money(a.daily_budget, 'daily_budget');
      const total = a.total_budget === undefined ? undefined : money(a.total_budget, 'total_budget');
      if (!/^[A-Z]{2}$/.test(String(a.locale_country ?? ''))) throw new MetaToolkitRefusal('locale_country is required: a two-letter country, e.g. US.');
      if (!/^[a-z]{2}$/.test(String(a.locale_language ?? ''))) throw new MetaToolkitRefusal('locale_language is required: a two-letter language, e.g. en.');
      const start = isoToMs(a.start_time, 'start_time');
      const end = a.end_time === undefined ? undefined : isoToMs(a.end_time, 'end_time');
      if (end !== undefined && end <= start) throw new MetaToolkitRefusal('end_time must be after start_time.');
      const include = validateTargetingClauses(a.targeting_include, 'targeting_include', { required: true });
      const exclude = validateTargetingClauses(a.targeting_exclude, 'targeting_exclude', { required: false });
      const params: Record<string, any> = {
        name, status: 'DRAFT', type, objective_type: objective, cost_type: costType,
        unit_cost_amount: unit.amount, unit_cost_currency: cur,
        daily_budget_amount: daily.amount, daily_budget_currency: cur,
        campaign_group_id: groupId, locale_country: a.locale_country, locale_language: a.locale_language,
        // Explicit, not the service's defaults: no off-LinkedIn delivery, no audience expansion, optimized creative rotation.
        offsite_delivery_enabled: false, audience_expansion_enabled: false, creative_selection: 'OPTIMIZED',
        politicalIntent: political, run_schedule_start: start,
        targeting_include: include, ...(exclude ? { targeting_exclude: exclude } : {}),
      };
      const expect: ValidatedLinkedInWrite['expect'] = [
        { path: 'name', value: name, as: 'string' }, { path: 'status', value: 'DRAFT', as: 'string' }, { path: 'type', value: type, as: 'string' },
        { path: 'costType', value: costType, as: 'string' },
        { path: 'unitCost.amount', value: unit.amount, as: 'amount' }, { path: 'unitCost.currencyCode', value: cur, as: 'string' },
        { path: 'dailyBudget.amount', value: daily.amount, as: 'amount' }, { path: 'dailyBudget.currencyCode', value: cur, as: 'string' },
        { path: 'runSchedule.start', value: start, as: 'number' },
        { path: 'locale.country', value: String(a.locale_country), as: 'string' }, { path: 'locale.language', value: String(a.locale_language), as: 'string' },
      ];
      if (total) {
        params.total_budget_amount = total.amount;
        params.total_budget_currency = cur;
        expect.push({ path: 'totalBudget.amount', value: total.amount, as: 'amount' }, { path: 'totalBudget.currencyCode', value: cur, as: 'string' });
      }
      if (end !== undefined) { params.run_schedule_end = end; expect.push({ path: 'runSchedule.end', value: end, as: 'number' }); }
      return {
        ...base, parent: { kind: 'group', id: groupId }, params, expect,
        notCompared: ['targetingCriteria', 'objectiveType', 'politicalIntent', 'offsiteDeliveryEnabled', 'audienceExpansionEnabled', 'creativeSelection'],
        dailyMicros: daily.micros, totalMicros: total?.micros, unitCostMicros: unit.micros,
      };
    }
    case 'CAMPAIGN UPDATE': {
      const id = linkedInId(a.campaign_id, 'campaign', 'campaign_id');
      const params: Record<string, any> = {};
      const expect: ValidatedLinkedInWrite['expect'] = [];
      const out: ValidatedLinkedInWrite = { ...base, target: { kind, id }, params, expect };
      if (a.name !== undefined) { params.name = requireName(a.name); expect.push({ path: 'name', value: params.name, as: 'string' }); }
      if (a.daily_budget !== undefined) {
        const m = money(a.daily_budget, 'daily_budget');
        Object.assign(params, { daily_budget_amount: m.amount, daily_budget_currency: cur });
        out.dailyMicros = m.micros;
        expect.push({ path: 'dailyBudget.amount', value: m.amount, as: 'amount' }, { path: 'dailyBudget.currencyCode', value: cur, as: 'string' });
      }
      if (a.total_budget !== undefined) {
        const m = money(a.total_budget, 'total_budget');
        Object.assign(params, { total_budget_amount: m.amount, total_budget_currency: cur });
        out.totalMicros = m.micros;
        expect.push({ path: 'totalBudget.amount', value: m.amount, as: 'amount' }, { path: 'totalBudget.currencyCode', value: cur, as: 'string' });
      }
      if (a.unit_cost !== undefined) {
        const m = money(a.unit_cost, 'unit_cost');
        Object.assign(params, { unit_cost_amount: m.amount, unit_cost_currency: cur });
        out.unitCostMicros = m.micros;
        expect.push({ path: 'unitCost.amount', value: m.amount, as: 'amount' }, { path: 'unitCost.currencyCode', value: cur, as: 'string' });
      }
      if (a.end_time !== undefined && a.start_time === undefined) {
        throw new MetaToolkitRefusal('end_time on a campaign needs start_time too: LinkedIn replaces the whole schedule, so both are sent.');
      }
      if (a.start_time !== undefined) {
        out.newStartMs = isoToMs(a.start_time, 'start_time');
        expect.push({ path: 'runSchedule.start', value: out.newStartMs, as: 'number' });
        if (a.end_time !== undefined) {
          out.newEndMs = isoToMs(a.end_time, 'end_time');
          if (out.newEndMs <= out.newStartMs) throw new MetaToolkitRefusal('end_time must be after start_time.');
        }
      }
      if (!expect.length) throw new MetaToolkitRefusal('CAMPAIGN UPDATE needs name, daily_budget, total_budget, unit_cost or start_time.');
      out.notCompared = ['targetingCriteria'];
      return out;
    }
    case 'CREATIVE CREATE': {
      const campaignId = linkedInId(a.campaign_id, 'campaign', 'campaign_id');
      const textAd = a.headline !== undefined || a.description !== undefined || a.landing_page !== undefined || a.image_urn !== undefined;
      const params: Record<string, any> = { campaign_id: campaignId, status: 'DRAFT' };
      const expect: ValidatedLinkedInWrite['expect'] = [{ path: 'intendedStatus', value: 'DRAFT', as: 'string' }];
      if (a.post_urn !== undefined) {
        if (textAd) throw new MetaToolkitRefusal('CREATIVE CREATE takes either post_urn or the text-ad fields (headline, description, landing_page), not both.');
        if (typeof a.post_urn !== 'string' || !/^urn:li:(share|ugcPost):\d{1,30}$/.test(a.post_urn)) throw new MetaToolkitRefusal('post_urn must look like urn:li:share:123 or urn:li:ugcPost:123.');
        params.post_urn = a.post_urn;
        expect.push({ path: 'content.reference', value: a.post_urn, as: 'string' });
      } else {
        if (typeof a.headline !== 'string' || !a.headline.trim() || a.headline.trim().length > 25) throw new MetaToolkitRefusal('headline is required for a text ad (up to 25 characters), or pass post_urn.');
        if (typeof a.description !== 'string' || !a.description.trim() || a.description.trim().length > 75) throw new MetaToolkitRefusal('description is required for a text ad (up to 75 characters).');
        noControlChars(a.headline.trim(), 'headline');
        noControlChars(a.description.trim(), 'description');
        let url: URL | null = null;
        try { url = typeof a.landing_page === 'string' ? new URL(a.landing_page) : null; } catch { url = null; }
        if (!url || url.protocol !== 'https:' || String(a.landing_page).length > 1000) throw new MetaToolkitRefusal('landing_page is required for a text ad and must be an https URL of at most 1000 characters.');
        noControlChars(String(a.landing_page), 'landing_page');
        if (a.image_urn !== undefined && (typeof a.image_urn !== 'string' || !/^urn:li:image:[A-Za-z0-9_-]{1,80}$/.test(a.image_urn))) throw new MetaToolkitRefusal('image_urn must look like urn:li:image:C4E10AQ...');
        Object.assign(params, { headline: a.headline.trim(), description: a.description.trim(), landing_page: a.landing_page, ...(a.image_urn ? { image_urn: a.image_urn } : {}) });
        expect.push({ path: 'content.textAd.headline', value: params.headline, as: 'string' }, { path: 'content.textAd.description', value: params.description, as: 'string' });
      }
      return { ...base, parent: { kind: 'campaign', id: campaignId }, params, expect, notCompared: ['content.textAd.landingPage (LinkedIn UTM tags are added)'] };
    }
    default:
      throw new MetaToolkitRefusal(`${op} is not part of the LinkedIn Ads toolkit surface.`);
  }
}

// ── State the preview describes ─────────────────────────────────────────────────

const TERMINAL = ['ARCHIVED', 'CANCELED', 'COMPLETED', 'REMOVED', 'PENDING_DELETION'];

const stateOf = (kind: Kind, row: any) => {
  const money = (m: any) => (m && typeof m === 'object' ? { amount: m.amount === undefined ? undefined : String(m.amount), currency: m.currencyCode } : undefined);
  if (kind === 'group') {
    return { id: trailingId(row.id), name: row.name, status: row.status, totalBudget: money(row.totalBudget), start: row.runSchedule?.start, end: row.runSchedule?.end };
  }
  if (kind === 'campaign') {
    return {
      id: trailingId(row.id), name: row.name, status: row.status, group: trailingId(row.campaignGroup), type: row.type, costType: row.costType,
      unitCost: money(row.unitCost), dailyBudget: money(row.dailyBudget), totalBudget: money(row.totalBudget), start: row.runSchedule?.start, end: row.runSchedule?.end,
    };
  }
  const textAd = row.content?.textAd;
  return {
    id: trailingId(row.id), status: row.intendedStatus, campaign: trailingId(row.campaign),
    reference: typeof row.content?.reference === 'string' ? row.content.reference : undefined,
    headline: textAd?.headline, description: textAd?.description, landingPage: textAd?.landingPage, image: textAd?.image,
    // EVERYTHING LinkedIn holds as this creative's content, shown or not: a change to any part of it voids the preview token.
    contentHash: crypto.createHash('sha256').update(stableStringify(row.content ?? null)).digest('hex'),
  };
};

/** An ISO time without the pointless .000, so the preview shows the time the caller typed. */
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
/** One line per targeting facet, with the facet URN and every value, exactly as they will be sent. */
const targetingLines = (label: string, clauses: Array<{ facet_urn: string; values: string[] }> | undefined): string[] =>
  (clauses ?? []).map((c) => `${label} ${c.facet_urn}: ${c.values.join(', ')}`);

const ID_ARG: Record<Kind, string> = { group: 'campaign group', campaign: 'campaign', creative: 'creative' };

// ── Execute ─────────────────────────────────────────────────────────────────────

export async function executeLinkedInAdsWrite(
  userId: string,
  rawArgs: any,
  session: LinkedInAdsSession,
  deps: LinkedInAdsWriteDeps = defaultLinkedInAdsWriteDeps,
) {
  // Defense in depth: the gateway already refuses the write tool in read mode.
  if (!deps.writesEnabled()) throw new MetaToolkitRefusal(LINKEDIN_WRITES_NOT_AVAILABLE);
  const { confirm, preview_token: previewToken, account_id: _ignored, ...args } = rawArgs ?? {};
  const v = validateLinkedInAdsWriteShape(args, session.currency);
  const acct = session.accountId;
  const { api } = deps;
  const scrub = (text: string) => redactLinkedInText(text, [session.accessToken]);

  // Consent: a connection made without rw_ads (read mode) cannot change anything. A connection that
  // never recorded its scopes is not blocked here; LinkedIn decides.
  if (session.scopes && !session.scopes.includes('rw_ads')) {
    throw new MetaToolkitRefusal('This LinkedIn connection was made without permission to change ads (read-only consent), so nothing was changed. Reconnect LinkedIn Ads to grant it.');
  }
  try {
    await deps.assertReady(userId);
  } catch (error) {
    if (error instanceof ZomaNotReadyError) throw new MetaToolkitRefusal(error.message);
    throw error;
  }

  /** One LinkedIn call before anything is applied: a refusal says what happened and that nothing was sent. */
  const before = async <T extends LinkedInCallResult>(what: string, call: (token: string) => Promise<T>, notFound?: string): Promise<T> => {
    const result = await callLinkedIn(session, call, { changedNothing: true });
    if (result.success) return result;
    const kind = classifyLinkedInFailure(result);
    if (kind === 'not_enabled') throw new MetaToolkitRefusal(LINKEDIN_WRITE_NOT_ENABLED);
    if (kind === 'rate_limited') throw new MetaToolkitRefusal(linkedInRateLimitedResult(what, true).message);
    if (result.status === 404 && notFound) throw new MetaToolkitRefusal(`${notFound} was not found on LinkedIn Ads account ${acct}. Nothing was sent.`);
    throw new MetaToolkitRefusal(`LinkedIn could not ${what}, so nothing was sent: ${scrub(result.error || 'no details')}`);
  };
  const readEntity = async (kind: Kind, id: string) => {
    const result = await before(
      `read the ${ID_ARG[kind]} ${id}`,
      (t) => (kind === 'group' ? api.getCampaignGroup(t, acct, id) : kind === 'campaign' ? api.getCampaign(t, acct, id) : api.getCreative(t, acct, id)),
      `The ${ID_ARG[kind]} ${id}`,
    );
    const row = result.data;
    // An answer that is not the entity asked for is not something a preview may describe.
    if (!row || typeof row !== 'object' || trailingId(row.id) !== id || (kind === 'creative' ? typeof row.intendedStatus !== 'string' : typeof row.status !== 'string')) {
      throw new MetaToolkitRefusal(`LinkedIn returned an unexpected answer for the ${ID_ARG[kind]} ${id}, so nothing was sent.`);
    }
    return row;
  };
  const cur = /^[A-Z]{3}$/.test(session.currency) ? session.currency : '';
  const money = (micros: number | undefined) => (micros === undefined ? 'not set' : cur ? formatMicros(micros, cur) : `${micros / 1e6}`);
  // A budget as LinkedIn answered it (currencyCode) or as the preview state holds it (currency).
  const moneyOf = (m: any) => (m?.amount === undefined ? 'not set' : `${m.amount} ${m.currencyCode ?? m.currency ?? ''}`.trim());

  // State the preview describes (and the token is bound to).
  const lines: string[] = ['PREVIEW — nothing has changed yet.'];
  let state: Record<string, unknown> = {};
  /** Daily spend this write unlocks (ACTIVATE), in micros; undefined when it cannot be bounded. */
  let unlockMicros: number | undefined;
  let unlockUnbounded: string | undefined;
  /** Currency codes (as LinkedIn reports them) of every budget the unlock figure is made of. */
  const unlockCurrencies: Array<string | undefined> = [];
  const isActivate = v.action === 'ACTIVATE';
  const verb = (kind: Kind) => ({ group: 'campaign group', campaign: 'campaign', creative: 'creative' })[kind];
  // Everything below that did not come from this call (names and content stored on LinkedIn, post text) or that a
  // caller typed goes through previewText, so it can neither start a line of its own nor run on without end.
  const t = (value: unknown, max = 200) => previewText(value, max);

  if (v.action === 'CREATE') {
    if (v.kind === 'group') {
      lines.push(`Create campaign group "${t(v.params.name, 150)}" as DRAFT (it cannot deliver).`);
      lines.push(`Schedule: starts ${iso(v.params.run_schedule_start)}${v.params.run_schedule_end ? `, ends ${iso(v.params.run_schedule_end)}` : ', no end date'}.`);
      lines.push(`Total budget: ${money(v.totalMicros)}.`);
    } else if (v.kind === 'campaign') {
      const group = await readEntity('group', v.parent!.id);
      if (TERMINAL.includes(group.status)) throw new MetaToolkitRefusal(`Campaign group ${v.parent!.id} is ${group.status}, so no campaign can be added to it. Nothing was sent.`);
      state = { parent: stateOf('group', group) };
      lines.push(`Create campaign "${t(v.params.name, 150)}" in campaign group "${t(group.name, 150)}" (id ${v.parent!.id}, group is ${t(group.status, 30)}) as DRAFT (it cannot deliver).`);
      lines.push(`Type ${v.params.type}, objective ${v.params.objective_type}, cost type ${v.params.cost_type} with a bid of ${money(v.unitCostMicros)}.`);
      lines.push(`Daily budget: ${money(v.dailyMicros)}.${v.totalMicros !== undefined ? ` Total budget: ${money(v.totalMicros)}.` : ''}`);
      lines.push(`Schedule: starts ${iso(v.params.run_schedule_start)}${v.params.run_schedule_end ? `, ends ${iso(v.params.run_schedule_end)}` : ', no end date'}.`);
      if (v.params.run_schedule_start < deps.now()) lines.push('The start time is already in the past: LinkedIn may refuse the campaign, and a later ACTIVATE then needs a new start_time.');
      lines.push(`Locale ${v.params.locale_country}/${v.params.locale_language}, political intent ${v.params.politicalIntent}, no LinkedIn Audience Network, no audience expansion.`);
      lines.push(...targetingLines('Targeting include', v.params.targeting_include), ...targetingLines('Targeting exclude', v.params.targeting_exclude));
    } else {
      const campaign = await readEntity('campaign', v.parent!.id);
      if (TERMINAL.includes(campaign.status)) throw new MetaToolkitRefusal(`Campaign ${v.parent!.id} is ${campaign.status}, so no creative can be added to it. Nothing was sent.`);
      state = { parent: stateOf('campaign', campaign) };
      lines.push(`Create a creative in campaign "${t(campaign.name, 150)}" (id ${v.parent!.id}, campaign is ${t(campaign.status, 30)}) as DRAFT (it cannot deliver).`);
      if (v.params.post_urn) lines.push(`Post: ${v.params.post_urn}`);
      else {
        lines.push(`Text ad headline: ${t(v.params.headline, 60)}`, `Text ad description: ${t(v.params.description, 150)}`);
        // The URL as given AND the URL LinkedIn receives: the service appends its tracking tags (appendLinkedInUtm).
        lines.push(`Landing page: ${t(v.params.landing_page, 1000)}`, `Landing page as sent (LinkedIn tracking tags added): ${t(finalLandingPage(v.params.landing_page, v.parent!.id), 1500)}`);
        if (v.params.image_urn) lines.push(`Image: ${v.params.image_urn}`);
      }
    }
    lines.push('It is created DRAFT: nothing delivers or spends until you approve a separate ACTIVATE.');
  } else {
    const prior = await readEntity(v.kind, v.target!.id);
    const priorState = stateOf(v.kind, prior);
    state = { prior: priorState };
    const priorStatus = String(priorState.status);
    const name = v.kind === 'creative' ? `creative ${v.target!.id}` : `${verb(v.kind)} "${t(priorState.name, 150)}" (id ${v.target!.id})`;
    if (v.params.status) {
      if (TERMINAL.includes(priorStatus)) throw new MetaToolkitRefusal(`The ${name} is ${priorStatus} and cannot be ${isActivate ? 'activated' : 'paused'}. Nothing was sent.`);
      if (priorStatus === v.params.status) throw new MetaToolkitRefusal(`The ${name} is already ${priorStatus}. Nothing was sent.`);
      lines.push(`${isActivate ? 'Activate' : 'Pause'} ${name}: ${priorStatus} → ${v.params.status}.`);
      if (v.kind === 'creative') {
        // What the user is approving to put live: the creative's own content, as LinkedIn holds it. A creative
        // whose content cannot be described is never activated: approving it would be approving blind.
        const c = priorState as any;
        if (isActivate && !c.reference && c.headline === undefined) {
          throw new MetaToolkitRefusal('LinkedIn did not describe this creative\'s content, so it cannot be shown to you and is not activated from here. Nothing was sent.');
        }
        if (c.reference) {
          lines.push(`Post: ${c.reference}`);
          if (isActivate) {
            // The post text is what people will read: fetch it (the service's getPost) and show it, or refuse.
            const post = await callLinkedIn(session, (tok) => api.getPost(tok, c.reference), { changedNothing: true });
            const body: any = post.data;
            if (!post.success || !body || typeof body !== 'object' || typeof body.commentary !== 'string') {
              throw new MetaToolkitRefusal(`LinkedIn would not give Zoma the text of the post this creative runs (${c.reference}), so it cannot be shown to you and is not activated from here. Nothing was sent.`);
            }
            lines.push(`Post text: ${t(body.commentary, 1500)}`);
            if (typeof body.contentLandingPage === 'string') lines.push(`Post landing page: ${t(body.contentLandingPage, 1000)}`);
            // Bound into the token: a post edited after the preview voids it.
            state = {
              ...state,
              post: crypto.createHash('sha256').update(stableStringify({ commentary: body.commentary, landing: body.contentLandingPage ?? null, content: body.content ?? null })).digest('hex'),
            };
          }
        }
        if (c.headline !== undefined) lines.push(`Text ad headline: ${t(c.headline, 300)}`);
        if (c.description !== undefined) lines.push(`Text ad description: ${t(c.description, 300)}`);
        if (c.landingPage !== undefined) lines.push(`Landing page: ${t(c.landingPage, 1500)}`);
        if (c.image !== undefined) lines.push(`Image: ${t(c.image, 120)}`);
        if (!c.reference && c.headline === undefined) lines.push('LinkedIn did not describe this creative\'s content, so it cannot be shown here.');
        if (c.campaign) lines.push(`Campaign: ${c.campaign}`);
      }
      if (v.kind === 'campaign') {
        const cp = priorState as any;
        if (v.newStartMs !== undefined) {
          v.params.run_schedule_start = v.newStartMs;
          if (cp.end !== undefined) v.params.run_schedule_end = cp.end;
          lines.push(`New start ${iso(v.newStartMs)}${cp.end !== undefined ? ` (end ${iso(cp.end)} kept)` : ''}.`);
          v.expect.push(...(cp.end !== undefined ? [{ path: 'runSchedule.end', value: Number(cp.end), as: 'number' as const }] : []));
        } else if (typeof cp.start === 'number' && cp.start < deps.now() && priorStatus === 'DRAFT') {
          lines.push('Its stored start time has passed: LinkedIn refuses any change to a campaign in that state unless start_time is passed too.');
        }
      }
      if (isActivate) {
        if (v.kind === 'campaign') {
          unlockMicros = amountToMicros((priorState as any).dailyBudget?.amount);
          if ((priorState as any).dailyBudget) unlockCurrencies.push((priorState as any).dailyBudget.currency);
          lines.push(unlockMicros === undefined
            ? 'It has no daily budget (lifetime budget only), so its daily spend cannot be bounded.'
            : `It will start delivering and can spend up to ${money(unlockMicros)}/day.`);
          if (unlockMicros === undefined) unlockUnbounded = 'It has no daily budget, so its daily spend cannot be bounded.';
          const groupId = (priorState as any).group as string | undefined;
          if (groupId) {
            const g = await callLinkedIn(session, (tok) => api.getCampaignGroup(tok, acct, groupId), { changedNothing: true });
            if (g.success && typeof g.data?.status === 'string') lines.push(`It delivers only while its campaign group "${t(g.data.name, 150)}" is ACTIVE (now ${t(g.data.status, 30)}).`);
          }
        } else if (v.kind === 'group') {
          const listed = await before('list the campaigns of the campaign group', (tok) => api.listCampaigns(tok, acct, { campaign_group_id: v.target!.id }));
          const campaigns: any[] = Array.isArray(listed.data?.elements) ? listed.data.elements : [];
          const live = campaigns.filter((c) => c?.status === 'ACTIVE');
          state = { ...state, campaigns: campaigns.map((c) => ({ id: trailingId(c?.id), status: c?.status, daily: c?.dailyBudget?.amount === undefined ? undefined : String(c.dailyBudget.amount) })) };
          const unbounded = live.filter((c) => amountToMicros(c?.dailyBudget?.amount) === undefined);
          unlockCurrencies.push(...live.filter((c) => c?.dailyBudget).map((c) => c.dailyBudget.currencyCode));
          unlockMicros = unbounded.length ? undefined : live.reduce((sum, c) => sum + (amountToMicros(c.dailyBudget.amount) as number), 0);
          if (unbounded.length) unlockUnbounded = `${unbounded.length} ACTIVE campaign(s) in it have no daily budget (${unbounded.map((c) => trailingId(c?.id)).join(', ')}), so the daily spend cannot be bounded.`;
          for (const c of campaigns.slice(0, PREVIEW_MAX_LISTED_CAMPAIGNS)) lines.push(`Campaign ${trailingId(c?.id)} "${t(c?.name, 150)}": ${t(c?.status, 30)}, daily budget ${moneyOf(c?.dailyBudget)}`);
          if (campaigns.length > PREVIEW_MAX_LISTED_CAMPAIGNS) {
            const rest = campaigns.slice(PREVIEW_MAX_LISTED_CAMPAIGNS);
            lines.push(`...and ${rest.length} more campaign(s) not listed here (${rest.filter((c) => c?.status === 'ACTIVE').length} of them ACTIVE; the total below counts every ACTIVE campaign).`);
          }
          lines.push(live.length
            ? `Its ${live.length} ACTIVE campaign(s) can start delivering${unlockMicros === undefined ? '' : ` and can spend up to ${money(unlockMicros)}/day together`}; DRAFT or PAUSED ones spend only after their own ACTIVATE.`
            : 'It has no ACTIVE campaigns, so nothing delivers until a campaign in it is activated.');
        } else {
          const campaignId = (priorState as any).campaign as string | undefined;
          if (!campaignId) throw new MetaToolkitRefusal('LinkedIn did not say which campaign this creative belongs to, so nothing was sent.');
          const campaign = await readEntity('campaign', campaignId);
          state = { ...state, campaign: stateOf('campaign', campaign) };
          unlockMicros = amountToMicros(campaign.dailyBudget?.amount);
          if (campaign.dailyBudget) unlockCurrencies.push(campaign.dailyBudget.currencyCode);
          if (unlockMicros === undefined) unlockUnbounded = 'Its campaign has no daily budget, so its daily spend cannot be bounded.';
          lines.push(`It can serve in campaign "${t(campaign.name, 150)}" (now ${t(campaign.status, 30)}), which spends up to ${money(unlockMicros)}/day.`);
        }
      }
    } else {
      if (TERMINAL.includes(priorStatus)) throw new MetaToolkitRefusal(`The ${name} is ${priorStatus} and cannot be edited. Nothing was sent.`);
      const p = priorState as any;
      lines.push(`Change ${name}.`);
      if (v.params.name !== undefined) lines.push(`Rename ${name} → "${t(v.params.name, 150)}".`);
      if (v.params.daily_budget_amount !== undefined) lines.push(`Daily budget: ${moneyOf(p.dailyBudget)} → ${v.params.daily_budget_amount} ${cur}.`);
      if (v.params.total_budget_amount !== undefined) lines.push(`Total budget: ${moneyOf(p.totalBudget)} → ${v.params.total_budget_amount} ${cur}.`);
      if (v.params.unit_cost_amount !== undefined) lines.push(`Bid: ${moneyOf(p.unitCost)} → ${v.params.unit_cost_amount} ${cur}.`);
      if (v.newStartMs !== undefined) {
        // LinkedIn replaces the whole schedule object, so the stored end is carried over unless a new one is given.
        const end = v.newEndMs ?? (typeof p.end === 'number' ? p.end : undefined);
        v.params.run_schedule_start = v.newStartMs;
        if (end !== undefined) { v.params.run_schedule_end = end; v.expect.push({ path: 'runSchedule.end', value: end, as: 'number' }); }
        lines.push(`Schedule: starts ${iso(v.newStartMs)}${end !== undefined ? `, ends ${iso(end)}` : ', no end date'}.`);
      }
      lines.push(`Status stays ${priorStatus}.`);
      if (priorStatus === 'ACTIVE' && (v.dailyMicros !== undefined || v.totalMicros !== undefined)) lines.push('It is ACTIVE, so the new budget applies to live delivery.');
    }
  }

  // Spend limit (micros of the account currency): budgets raised here, and what an ACTIVATE unlocks.
  {
    const priorOf = (key: 'dailyBudget' | 'totalBudget') => {
      const m = (state.prior as any)?.[key];
      return { present: !!m, micros: amountToMicros(m?.amount), currency: m?.currency as string | undefined };
    };
    const changes: Array<{ label: string; field: 'daily_budget' | 'lifetime_budget'; proposed: number; prior: ReturnType<typeof priorOf> }> = [];
    if (v.dailyMicros !== undefined) changes.push({ label: 'daily budget', field: 'daily_budget', proposed: v.dailyMicros, prior: priorOf('dailyBudget') });
    if (v.totalMicros !== undefined) changes.push({ label: 'total budget', field: 'lifetime_budget', proposed: v.totalMicros, prior: priorOf('totalBudget') });
    // A stored budget that exists but cannot be read fails closed: skipping the ratio check would let any raise through.
    for (const change of changes) {
      if (change.prior.present && change.prior.micros === undefined) {
        throw new MetaToolkitRefusal(`The ${change.label} LinkedIn holds for this ${verb(v.kind)} could not be read, so the change cannot be checked against Zoma's spend limit. Nothing was sent.`);
      }
      // Compared in the account's own currency or not at all.
      if (change.prior.present && String(change.prior.currency ?? '').toUpperCase() !== cur) {
        throw new MetaToolkitRefusal(`The ${change.label} LinkedIn holds is in ${change.prior.currency ? String(change.prior.currency) : 'an unknown currency'}, but this ad account's currency is ${cur || 'unknown'}, so the change cannot be checked against Zoma's spend limit. Nothing was sent.`);
      }
    }
    // Lowering a budget is never refused for still being above a limit: it can only reduce spend.
    const increases = changes.filter((change) => !(change.prior.micros !== undefined && change.proposed <= change.prior.micros));
    if (increases.length > 0 || isActivate) {
      const { policy, refusal } = ceilingForCurrency(deps.spendCeiling(), cur);
      if (refusal) throw new MetaToolkitRefusal(refusal);
      if (policy) {
        const total = totalBudgetCap(policy);
        for (const change of increases) {
          const verdict = evaluateMetaSpendCeiling(policy, { field: change.field, proposed: change.proposed, prior: change.prior.micros });
          if (!verdict.allowed) {
            throw new MetaToolkitRefusal(verdict.code === 'SPEND_CEILING_INVALID'
              ? `Zoma's spend limit for this ad account could not be evaluated, so nothing was sent. Please contact ${SUPPORT}.`
              : limitRefusal(
                verdict.ceiling === 'maxDailyBudget'
                  ? `The daily budget of ${formatMicros(change.proposed, cur)} is above the limit.`
                  : `This change takes the ${change.label} from ${formatMicros(change.prior.micros ?? 0, cur)} to ${formatMicros(change.proposed, cur)}, more than ${policy.maxChangeRatio}x in one change.`,
                policy, cur,
              ));
          }
          if (change.field === 'lifetime_budget' && total !== undefined && change.proposed > total) {
            throw new MetaToolkitRefusal(limitRefusal(`The total (lifetime) budget of ${formatMicros(change.proposed, cur)} is above the limit.`, policy, cur));
          }
        }
        if (isActivate) {
          // What an ACTIVATE unlocks must be in the account's currency and bounded, then within the daily limit.
          const wrong = unlockCurrencies.find((currency) => !currency || String(currency).toUpperCase() !== cur);
          if (unlockCurrencies.some((currency) => !currency || String(currency).toUpperCase() !== cur)) {
            throw new MetaToolkitRefusal(
              `A budget this change depends on is in ${wrong ? String(wrong) : 'an unknown currency'}, but this ad account's currency is ${cur}, so it cannot be checked against Zoma's spend limit. Nothing was sent.`,
            );
          }
          if (unlockUnbounded) throw new MetaToolkitRefusal(`${unlockUnbounded} With a spend limit in force, activating is refused until every budget it unlocks is a daily budget. Nothing was sent.`);
          const verdict = evaluateMetaSpendCeiling(policy, { field: 'daily_budget', proposed: unlockMicros });
          if (!verdict.allowed) {
            throw new MetaToolkitRefusal(verdict.code === 'SPEND_CEILING_INVALID'
              ? `Zoma's spend limit for this ad account could not be evaluated, so nothing was sent. Please contact ${SUPPORT}.`
              : limitRefusal(`Activating would start spend at ${formatMicros(unlockMicros as number, cur)} a day, above the limit.`, policy, cur));
          }
        }
      }
    }
  }

  if (lines.join('\n').length > PREVIEW_MAX_CHARS) {
    throw new MetaToolkitRefusal(`This change is too large to show you in full (over ${PREVIEW_MAX_CHARS} characters), so it is not previewed and nothing was sent. Split it into smaller changes.`);
  }

  const fingerprint = previewFingerprint({ platform: 'linkedin_ads', userId, accountId: acct, op: v.op, params: v.params, state, currency: cur });
  const now = deps.now();
  const secret = deps.secret();
  if (confirm !== true) return previewResponse({ secret, userId, now, fingerprint, preview: lines.join('\n') });
  if (!previewTokenMatches(previewToken, secret, userId, fingerprint, now)) {
    throw new MetaToolkitRefusal('preview_token is missing, expired, or does not match these arguments (or the object changed since the preview). Get a fresh PREVIEW. Nothing was sent.');
  }
  if (!(await consumeToken(deps.consumedTokens, previewToken, now))) {
    throw new MetaToolkitRefusal('This preview_token was already used. Get a fresh PREVIEW. Nothing was sent.');
  }

  // Apply once.
  const unconfirmed = (message: string) => ({ success: false, verification: 'UNCONFIRMED' as WriteVerification, op: v.op, message });
  const applyCall = async (): Promise<LinkedInCallResult> => {
    const p = v.params;
    if (v.op === 'CAMPAIGN_GROUP CREATE') return callLinkedIn(session, (t) => api.createCampaignGroup(t, acct, p), { changedNothing: true });
    if (v.op === 'CAMPAIGN CREATE') return callLinkedIn(session, (t) => api.createCampaign(t, acct, p), { changedNothing: true });
    if (v.op === 'CREATIVE CREATE') return callLinkedIn(session, (t) => api.createCreative(t, { ...p, ad_account_id: acct }), { changedNothing: true });
    const id = v.target!.id;
    if (v.kind === 'group') return callLinkedIn(session, (t) => api.updateCampaignGroup(t, acct, id, p), { changedNothing: true });
    if (v.kind === 'campaign') return callLinkedIn(session, (t) => api.updateCampaign(t, acct, id, p), { changedNothing: true });
    return callLinkedIn(session, (t) => api.updateCreativeStatus(t, acct, id, String(p.status)), { changedNothing: true });
  };
  let applied: LinkedInCallResult;
  try {
    applied = await applyCall();
  } catch (error) {
    // A reconnect or similar refusal means nothing was sent; anything else gave no answer, so it may have applied.
    if (error instanceof MetaToolkitRefusal) throw error;
    return unconfirmed(`The call to LinkedIn failed without an answer (${scrub(error instanceof Error ? error.message : 'unknown error')}). The change may have applied: re-read with linkedin_ads_read before retrying so nothing is duplicated.`);
  }
  let createdId: string | undefined;
  if (!applied.success) {
    // The service's own update read-back (ENG-3064) saw the change not land / could not read it.
    if (applied.errorType === 'unsupported_field') {
      return {
        success: false, verification: 'MISMATCH' as WriteVerification, op: v.op, id: v.target?.id, mismatched_fields: applied.fields ?? [],
        message: `${v.op} was accepted by LinkedIn but read-back shows these field(s) did not change: ${(applied.fields ?? []).join(', ')}. Re-read before retrying.`,
      };
    }
    if (applied.errorType === 'read_back_failed') {
      return { ...unconfirmed(`${v.op} was accepted by LinkedIn but the read-back request failed, so it is not confirmed. Re-read before retrying so nothing is duplicated.`), id: v.target?.id };
    }
    const kind = classifyLinkedInFailure(applied);
    if (kind === 'not_enabled') throw new MetaToolkitRefusal(LINKEDIN_WRITE_NOT_ENABLED);
    if (kind === 'rate_limited') return linkedInRateLimitedResult('this change', true);
    if (kind === 'outcome_unknown') {
      return unconfirmed(`LinkedIn did not give a definite answer (${scrub(applied.error || 'no response')}). The change may have applied: re-read with linkedin_ads_read before retrying so nothing is duplicated.`);
    }
    throw new MetaToolkitRefusal(`LinkedIn rejected the change, so nothing was changed: ${scrub(applied.error || 'no details')}`);
  }
  if (v.action === 'CREATE') {
    const rawId = typeof applied.data?.id === 'string' || typeof applied.data?.id === 'number' ? String(applied.data.id) : '';
    let decoded = rawId;
    try { decoded = decodeURIComponent(rawId); } catch { /* keep the raw text */ }
    createdId = trailingId(decoded);
    if (!createdId) {
      return unconfirmed(`LinkedIn accepted the create but returned no id, so it is not confirmed. List with linkedin_ads_read before retrying so nothing is duplicated.`);
    }
  }

  // Independent read-back. Conservative: anything but a well-formed, fully matching answer is not CONFIRMED.
  const id = createdId ?? v.target!.id;
  const result: Record<string, unknown> = { success: false, op: v.op, id };
  let verification: WriteVerification = 'UNCONFIRMED';
  try {
    const read = await callLinkedIn(
      session,
      (t) => (v.kind === 'group' ? api.getCampaignGroup(t, acct, id) : v.kind === 'campaign' ? api.getCampaign(t, acct, id) : api.getCreative(t, acct, id)),
      { unauthorized: 'return' },
    );
    const row = read.data;
    if (!read.success) {
      result.read_back_error = scrub(read.error || 'the read-back request failed');
    } else if (!row || typeof row !== 'object' || Array.isArray(row)) {
      result.read_back_error = 'LinkedIn answered the read-back with something that is not the object that was changed.';
    } else if (trailingId(row.id) !== id) {
      result.read_back_error = 'LinkedIn answered the read-back with a different object than the one that was changed.';
    } else {
      const mismatched: string[] = [];
      const unreadable: string[] = [];
      for (const check of v.expect) {
        const actual = check.path.split('.').reduce((node: any, key) => (node && typeof node === 'object' ? node[key] : undefined), row);
        if (actual === undefined || actual === null || typeof actual === 'object') { unreadable.push(check.path); continue; }
        if (check.as === 'string') {
          if (String(actual) !== String(check.value)) mismatched.push(check.path);
        } else {
          const got = Number(actual);
          if (!Number.isFinite(got) || (typeof actual === 'string' && !actual.trim())) unreadable.push(check.path);
          else if (check.as === 'amount' ? Math.abs(got - Number(check.value)) > 1e-6 : got !== Number(check.value)) mismatched.push(check.path);
        }
      }
      verification = mismatched.length ? 'MISMATCH' : unreadable.length ? 'UNCONFIRMED' : 'CONFIRMED';
      if (mismatched.length) result.mismatched_fields = mismatched;
      if (unreadable.length) result.unreadable_fields = unreadable;
      result.status = v.kind === 'creative' ? row.intendedStatus : row.status;
      if (v.notCompared.length) result.not_compared = v.notCompared;
    }
  } catch (error) {
    if (error instanceof MetaToolkitRefusal) throw error;
    result.read_back_error = scrub(error instanceof Error ? error.message : 'the read-back failed');
    verification = 'UNCONFIRMED';
  }
  result.verification = verification;
  result.success = verification === 'CONFIRMED';
  result.message = verification === 'CONFIRMED'
    ? `${v.op} applied and read back from LinkedIn${v.action === 'CREATE' ? ' (created DRAFT: nothing is live)' : ''}.`
    : `${v.op} was sent to LinkedIn but the read-back did not confirm it (${verification}). Re-read with linkedin_ads_read before retrying.`;
  return result;
}
