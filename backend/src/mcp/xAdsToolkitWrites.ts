/**
 * ENG-3142 — guarded X (Twitter) Ads writes for external Zoma agents (provider #3 of the
 * ENG-2303 guarded-write flow; Google's is googleToolkitWrites.ts).
 *
 * Allowed: CAMPAIGN CREATE / UPDATE (name; budgets only on a legacy campaign that has one) /
 * PAUSE / ACTIVATE; LINE_ITEM CREATE (daily budget required, optional basic targeting: locations,
 * broad keywords, follower lookalikes) / UPDATE (name, bid, budgets) / PAUSE / ACTIVATE;
 * PROMOTED_TWEET CREATE (promote existing posts on a line item).
 *
 * Budgets live on line items: X v12 rejects new campaigns with campaign budget optimization
 * ("Create the campaign with budget_optimization=LINE_ITEM and set a daily budget on each line
 * item instead"), so CAMPAIGN CREATE sends budget_optimization=LINE_ITEM and no budget, and every
 * LINE_ITEM CREATE carries its own daily budget. A campaign's max daily spend is the sum of its
 * line items' daily budgets (or its own budget, for a legacy campaign that has one).
 *
 * Flow (shared guard, zomaWriteGuard.ts):
 *   1. Shape validation — pure, before any credential or X call.
 *   2. Payment method + usable X Ads connection (assertZomaWriteReady 'x_ads'); CAMPAIGN CREATE
 *      also needs a usable funding instrument on the X ad account (a card added at ads.x.com).
 *   3. Read the current state the preview describes (stable fields only, so spend counters
 *      moving between preview and confirm do not void the token).
 *   4. X_ADS_TOOLKIT_SPEND_CEILING (micros, same shape as GOOGLE_TOOLKIT_SPEND_CEILING) on
 *      daily budgets, and on activating at the daily spend that activation unlocks.
 *   5. No confirm → PREVIEW + single-use preview_token bound to user, arguments and state.
 *   6. confirm=true + matching token → applied ONCE → independent read-back. Only CONFIRMED is
 *      success. A failure without a definite answer (no response, 5xx, 408) may have applied,
 *      so it is UNCONFIRMED, never "did not apply".
 *
 * New campaigns and line items are always created with entity_status PAUSED; ACTIVATE is the
 * only way to start delivery, and it is its own preview.
 */
import { getJwtSecret } from '../config/jwt';
import { evaluateMetaSpendCeiling, type MetaSpendCeilingPolicy } from '../services/agentMode/metaSpendCeiling';
import { xAdsListAll, xAdsRequest, XAdsApiError, type XAdsRequestOptions } from '../services/xAdsClient';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { formatMicros, googleSpendCeilingPolicyFromEnv, majorToMicros } from './googleToolkitWrites';
import { assertXAdsToolkitCall, X_ADS_LINE_ITEM_OBJECTIVES, X_ADS_WRITE_TOOL, type XAdsSession } from './xAdsToolkitManifest';
import { assertZomaWriteReady, ZomaNotReadyError } from './zomaOnboarding';
import {
  consumeToken, defaultConsumedTokenStore, type ConsumedTokens, previewFingerprint, previewResponse, previewTokenMatches, type WriteVerification,
} from './zomaWriteGuard';

export interface XAdsWriteDeps {
  assertReady: (userId: string) => Promise<void>;
  request: <T = any>(opts: XAdsRequestOptions) => Promise<T>;
  listAll: (opts: XAdsRequestOptions) => Promise<any[]>;
  spendCeilingPolicy: () => MetaSpendCeilingPolicy | null;
  secret: () => string;
  now: () => number;
  consumedTokens: ConsumedTokens;
}

export const defaultXAdsWriteDeps: XAdsWriteDeps = {
  assertReady: (userId) => assertZomaWriteReady(userId, undefined, 'x_ads'),
  request: xAdsRequest,
  listAll: (opts) => xAdsListAll(opts),
  spendCeilingPolicy: () => googleSpendCeilingPolicyFromEnv(process.env.X_ADS_TOOLKIT_SPEND_CEILING),
  secret: () => getJwtSecret(),
  now: () => Date.now(),
  consumedTokens: defaultConsumedTokenStore,
};

const ID = /^[A-Za-z0-9]{1,32}$/;
const NUMERIC_ID = /^\d{1,25}$/;
const PLACEMENTS = ['ALL_ON_TWITTER', 'PUBLISHER_NETWORK', 'TWITTER_PROFILE', 'TWITTER_SEARCH', 'TWITTER_TIMELINE'];

const requireId = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !ID.test(v)) throw new MetaToolkitRefusal(`${field} is required (an X id from x_ads_read).`);
  return v;
};
const requireName = (v: unknown): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > 255) throw new MetaToolkitRefusal('name must be 1-255 characters.');
  return v.trim();
};
/** X requires an end_time on every line item; used when the caller gives none. */
export const X_ADS_LINE_ITEM_DEFAULT_DAYS = 30;
/** X accepts only yyyy-MM-ddTHH:mm:ssZ (no milliseconds, UTC). */
export const toXTime = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const optionalIso = (v: unknown, field: string): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) throw new MetaToolkitRefusal(`${field} must be an ISO 8601 date-time.`);
  return toXTime(Date.parse(v));
};
const stringList = (v: unknown, field: string, max: number, re: RegExp): string[] => {
  if (!Array.isArray(v) || v.length === 0 || v.length > max || !v.every((s) => typeof s === 'string' && re.test(s))) {
    throw new MetaToolkitRefusal(`${field} must be 1-${max} valid values.`);
  }
  return [...new Set(v as string[])];
};

interface TargetingCriterion { targeting_type: string; targeting_value: string }

/** Validated, X-shaped write. `fields` is what X receives and what the read-back must show. */
interface ValidatedXWrite {
  op: string;
  /** Entity read before (preview) and after (read-back). */
  target?: { kind: 'campaign' | 'line_item'; id: string };
  parent?: { kind: 'funding_instrument' | 'campaign' | 'line_item'; id: string };
  fields: Record<string, string | number>;
  targeting: TargetingCriterion[];
  tweetIds?: string[];
}

export function validateXAdsWriteShape(args: any, currency: string): ValidatedXWrite {
  assertXAdsToolkitCall(X_ADS_WRITE_TOOL, args);
  const op = `${args.entity_type} ${args.action}`;
  const fields: Record<string, string | number> = {};
  const money = (v: unknown, field: string) => {
    const micros = majorToMicros(v, currency, field);
    if (micros <= 0) throw new MetaToolkitRefusal(`${field} must be greater than 0.`);
    return micros;
  };
  if ('entity_status' in (args ?? {}) || 'status' in (args ?? {})) {
    throw new MetaToolkitRefusal('Status changes are their own PAUSE / ACTIVATE call; creates are always PAUSED.');
  }

  switch (op) {
    case 'CAMPAIGN CREATE': {
      if (args.daily_budget !== undefined || args.total_budget !== undefined) {
        throw new MetaToolkitRefusal(
          'X no longer accepts budgets on new campaigns (campaign budget optimization is retired). Create the campaign without '
          + 'daily_budget/total_budget, then set daily_budget (and optional total_budget) on each LINE_ITEM CREATE.',
        );
      }
      fields.name = requireName(args.name);
      fields.funding_instrument_id = requireId(args.funding_instrument_id, 'funding_instrument_id');
      fields.budget_optimization = 'LINE_ITEM';
      const start = optionalIso(args.start_time, 'start_time');
      const end = optionalIso(args.end_time, 'end_time');
      if (start) fields.start_time = start;
      if (end) fields.end_time = end;
      fields.entity_status = 'PAUSED';
      return { op, parent: { kind: 'funding_instrument', id: String(fields.funding_instrument_id) }, fields, targeting: [] };
    }
    case 'CAMPAIGN UPDATE': {
      const id = requireId(args.campaign_id, 'campaign_id');
      if (args.name !== undefined) fields.name = requireName(args.name);
      if (args.daily_budget !== undefined) fields.daily_budget_amount_local_micro = money(args.daily_budget, 'daily_budget');
      if (args.total_budget !== undefined) fields.total_budget_amount_local_micro = money(args.total_budget, 'total_budget');
      if (!Object.keys(fields).length) throw new MetaToolkitRefusal('CAMPAIGN UPDATE needs name, daily_budget or total_budget.');
      return { op, target: { kind: 'campaign', id }, fields, targeting: [] };
    }
    case 'LINE_ITEM CREATE': {
      const campaignId = requireId(args.campaign_id, 'campaign_id');
      fields.campaign_id = campaignId;
      fields.name = requireName(args.name);
      if (args.daily_budget === undefined) throw new MetaToolkitRefusal('LINE_ITEM CREATE needs daily_budget (major currency units): X budgets live on line items.');
      fields.daily_budget_amount_local_micro = money(args.daily_budget, 'daily_budget');
      if (args.total_budget !== undefined) fields.total_budget_amount_local_micro = money(args.total_budget, 'total_budget');
      if (!(X_ADS_LINE_ITEM_OBJECTIVES as readonly string[]).includes(args.objective)) {
        throw new MetaToolkitRefusal(`objective must be one of ${X_ADS_LINE_ITEM_OBJECTIVES.join(', ')}.`);
      }
      fields.objective = args.objective;
      fields.product_type = 'PROMOTED_TWEETS';
      fields.placements = (args.placements === undefined ? ['ALL_ON_TWITTER'] : stringList(args.placements, 'placements', 5, /^[A-Z_]+$/)).join(',');
      if (String(fields.placements).split(',').some((p) => !PLACEMENTS.includes(p))) throw new MetaToolkitRefusal(`placements must be from ${PLACEMENTS.join(', ')}.`);
      if (args.bid_amount === undefined) fields.bid_strategy = 'AUTO';
      else {
        fields.bid_strategy = 'MAX';
        fields.bid_amount_local_micro = money(args.bid_amount, 'bid_amount');
      }
      // X requires start_time on line items. An explicit one is part of the previewed fields;
      // otherwise "now" is filled in at apply time (outside the preview fingerprint).
      const liStart = optionalIso(args.start_time, 'start_time');
      const liEnd = optionalIso(args.end_time, 'end_time');
      if (liStart) fields.start_time = liStart;
      if (liEnd) fields.end_time = liEnd;
      fields.entity_status = 'PAUSED';
      const targeting: TargetingCriterion[] = [];
      const t = args.targeting;
      if (t !== undefined) {
        if (!t || typeof t !== 'object' || Array.isArray(t)) throw new MetaToolkitRefusal('targeting must be an object.');
        if (t.locations !== undefined) {
          for (const v of stringList(t.locations, 'targeting.locations', 2000, /^[a-f0-9]{16}$/)) targeting.push({ targeting_type: 'LOCATION', targeting_value: v });
        }
        if (t.keywords !== undefined) {
          for (const v of stringList(t.keywords, 'targeting.keywords', 100, /^[^\n]{1,80}$/)) targeting.push({ targeting_type: 'BROAD_KEYWORD', targeting_value: v.trim() });
        }
        if (t.follower_lookalike_user_ids !== undefined) {
          for (const v of stringList(t.follower_lookalike_user_ids, 'targeting.follower_lookalike_user_ids', 100, NUMERIC_ID)) {
            targeting.push({ targeting_type: 'SIMILAR_TO_FOLLOWERS_OF_USER', targeting_value: v });
          }
        }
      }
      return { op, parent: { kind: 'campaign', id: campaignId }, fields, targeting };
    }
    case 'LINE_ITEM UPDATE': {
      const id = requireId(args.line_item_id, 'line_item_id');
      if (args.name !== undefined) fields.name = requireName(args.name);
      if (args.bid_amount !== undefined) {
        fields.bid_strategy = 'MAX';
        fields.bid_amount_local_micro = money(args.bid_amount, 'bid_amount');
      }
      if (args.daily_budget !== undefined) fields.daily_budget_amount_local_micro = money(args.daily_budget, 'daily_budget');
      if (args.total_budget !== undefined) fields.total_budget_amount_local_micro = money(args.total_budget, 'total_budget');
      if (!Object.keys(fields).length) throw new MetaToolkitRefusal('LINE_ITEM UPDATE needs name, bid_amount, daily_budget or total_budget.');
      return { op, target: { kind: 'line_item', id }, fields, targeting: [] };
    }
    case 'CAMPAIGN PAUSE':
    case 'CAMPAIGN ACTIVATE':
      return { op, target: { kind: 'campaign', id: requireId(args.campaign_id, 'campaign_id') }, fields: { entity_status: args.action === 'ACTIVATE' ? 'ACTIVE' : 'PAUSED' }, targeting: [] };
    case 'LINE_ITEM PAUSE':
    case 'LINE_ITEM ACTIVATE':
      return { op, target: { kind: 'line_item', id: requireId(args.line_item_id, 'line_item_id') }, fields: { entity_status: args.action === 'ACTIVATE' ? 'ACTIVE' : 'PAUSED' }, targeting: [] };
    case 'PROMOTED_TWEET CREATE': {
      const lineItemId = requireId(args.line_item_id, 'line_item_id');
      const tweetIds = stringList(args.tweet_ids, 'tweet_ids', 50, NUMERIC_ID);
      return { op, parent: { kind: 'line_item', id: lineItemId }, fields: { line_item_id: lineItemId, tweet_ids: tweetIds.join(',') }, targeting: [], tweetIds };
    }
    default:
      throw new MetaToolkitRefusal(`${op} is not part of the X Ads toolkit surface.`);
  }
}

const PATH: Record<'funding_instrument' | 'campaign' | 'line_item', string> = {
  funding_instrument: 'funding_instruments', campaign: 'campaigns', line_item: 'line_items',
};
/** Fields the preview token binds to (spend counters are left out: they move on their own). */
const STABLE: Record<'funding_instrument' | 'campaign' | 'line_item', string[]> = {
  funding_instrument: ['id', 'entity_status', 'currency', 'able_to_fund', 'deleted'],
  campaign: ['id', 'name', 'entity_status', 'funding_instrument_id', 'budget_optimization', 'daily_budget_amount_local_micro', 'total_budget_amount_local_micro', 'deleted'],
  line_item: [
    'id', 'name', 'entity_status', 'campaign_id', 'objective', 'bid_amount_local_micro', 'bid_strategy',
    'daily_budget_amount_local_micro', 'total_budget_amount_local_micro', 'deleted',
  ],
};
const pick = (row: any, keys: string[]) => Object.fromEntries(keys.map((k) => [k, row?.[k]]));

/** A funding instrument that can pay for delivery: live, not cancelled, and not flagged unable to fund. */
const fundingUsable = (fi: any) => !fi?.deleted && fi?.entity_status === 'ACTIVE' && fi?.able_to_fund !== false;
const NO_FUNDING =
  'has no usable payment method, so X would not deliver anything. Add a payment method at ads.x.com (Billing) first, then retry. Nothing was sent.';

/** Outcome-unknown transport failures (the write may have applied). */
const outcomeUnknown = (error: unknown) => error instanceof XAdsApiError && (error.status === 0 || error.status >= 500 || error.status === 408);

export async function executeXAdsWrite(
  userId: string,
  rawArgs: any,
  session: XAdsSession,
  currency: string,
  deps: XAdsWriteDeps = defaultXAdsWriteDeps,
) {
  const { confirm, preview_token: previewToken, account_id: _ignored, ...args } = rawArgs ?? {};
  const v = validateXAdsWriteShape(args, currency);
  const acct = encodeURIComponent(session.accountId);
  const call = <T = any>(opts: Omit<XAdsRequestOptions, 'credentials' | 'fetchImpl'>) =>
    deps.request<T>({ ...opts, credentials: session.credentials, fetchImpl: session.fetchImpl });

  try {
    await deps.assertReady(userId);
  } catch (error) {
    if (error instanceof ZomaNotReadyError) throw new MetaToolkitRefusal(error.message);
    throw error;
  }

  const read = async (kind: 'funding_instrument' | 'campaign' | 'line_item', id: string) => {
    try {
      const body = await call({ path: `/accounts/${acct}/${PATH[kind]}/${encodeURIComponent(id)}` });
      const row = body?.data;
      return row && !row.deleted ? row : null;
    } catch (error) {
      if (error instanceof XAdsApiError && error.status === 404) return null;
      throw error;
    }
  };
  const mustRead = async (kind: 'funding_instrument' | 'campaign' | 'line_item', id: string) => {
    const row = await read(kind, id);
    if (!row) throw new MetaToolkitRefusal(`${kind.replace('_', ' ')} ${id} was not found on X Ads account ${session.accountId}. Nothing was sent.`);
    return row;
  };
  const money = (micros: unknown) => (typeof micros === 'number' ? `${formatMicros(micros, currency)} (= ${micros} micros)` : 'not set');

  // State the preview describes (and the token is bound to).
  const lines: string[] = ['PREVIEW — nothing has changed yet.'];
  let state: Record<string, unknown> = {};
  let activateBudgetMicros: unknown;
  if (v.op === 'CAMPAIGN CREATE') {
    const instruments = await deps.listAll({ credentials: session.credentials, fetchImpl: session.fetchImpl, path: `/accounts/${acct}/funding_instruments` });
    const usable = instruments.filter(fundingUsable);
    if (!usable.length) throw new MetaToolkitRefusal(`X Ads account ${session.accountId} ${NO_FUNDING}`);
    const fi = usable.find((f) => String(f.id) === v.parent!.id);
    if (!fi) {
      const known = instruments.some((f) => String(f.id) === v.parent!.id && !f.deleted);
      throw new MetaToolkitRefusal(
        `Funding instrument ${v.parent!.id} ${known ? 'is not usable (inactive or unable to fund)' : `was not found on X Ads account ${session.accountId}`}. `
        + `Usable funding instruments: ${usable.map((f) => f.id).join(', ')}. Nothing was sent.`,
      );
    }
    if (fi.currency && fi.currency !== currency) {
      throw new MetaToolkitRefusal(`Funding instrument ${fi.id} is in ${fi.currency}, but this account is ${currency}. Nothing was sent.`);
    }
    state = { parent: pick(fi, STABLE.funding_instrument) };
    lines.push(`Create campaign "${v.fields.name}" on funding instrument ${fi.id}${fi.description ? ` (${fi.description})` : ''}.`);
    lines.push('Budget: set per line item (budget_optimization=LINE_ITEM); the campaign itself has no budget. Add line items with a daily_budget next.');
    lines.push('It is created PAUSED: nothing delivers or spends until you approve a separate ACTIVATE.');
  } else if (v.op === 'LINE_ITEM CREATE') {
    const campaign = await mustRead('campaign', v.parent!.id);
    state = { parent: pick(campaign, STABLE.campaign) };
    lines.push(`Create line item "${v.fields.name}" in campaign "${campaign.name}" (campaign is ${campaign.entity_status}).`);
    lines.push(`Daily budget: ${money(v.fields.daily_budget_amount_local_micro)}/day.${v.fields.total_budget_amount_local_micro !== undefined ? ` Total budget: ${money(v.fields.total_budget_amount_local_micro)}.` : ''}`);
    lines.push(`Schedule: ${v.fields.start_time ? `starts ${v.fields.start_time}` : 'starts when created'}, ${v.fields.end_time ? `ends ${v.fields.end_time}` : `ends ${X_ADS_LINE_ITEM_DEFAULT_DAYS} days after start (pass end_time to change)`}.`);
    lines.push(`Objective ${v.fields.objective}, placements ${v.fields.placements}, bid ${v.fields.bid_strategy === 'AUTO' ? 'automatic' : `max ${money(v.fields.bid_amount_local_micro)}`}.`);
    if (v.targeting.length) {
      const by = (t: string) => v.targeting.filter((c) => c.targeting_type === t).map((c) => c.targeting_value);
      const parts = [
        by('LOCATION').length ? `locations ${by('LOCATION').join(', ')}` : '',
        by('BROAD_KEYWORD').length ? `keywords ${by('BROAD_KEYWORD').map((k) => `"${k}"`).join(', ')}` : '',
        by('SIMILAR_TO_FOLLOWERS_OF_USER').length ? `followers-lookalike of user ids ${by('SIMILAR_TO_FOLLOWERS_OF_USER').join(', ')}` : '',
      ].filter(Boolean);
      lines.push(`Targeting: ${parts.join('; ')}.`);
    } else {
      lines.push('Targeting: none (X default audience).');
    }
    lines.push('It is created PAUSED: nothing delivers or spends until you approve a separate ACTIVATE.');
  } else if (v.op === 'PROMOTED_TWEET CREATE') {
    const lineItem = await mustRead('line_item', v.parent!.id);
    state = { parent: pick(lineItem, STABLE.line_item) };
    lines.push(`Promote post(s) ${v.tweetIds!.join(', ')} on line item "${lineItem.name}" (line item is ${lineItem.entity_status}).`);
    if (lineItem.entity_status === 'ACTIVE') lines.push('This line item is ACTIVE, so these posts can start delivering (and spending) as soon as X approves them.');
  } else {
    const kind = v.target!.kind;
    const prior = await mustRead(kind, v.target!.id);
    state = { prior: pick(prior, STABLE[kind]) };
    const noun = kind === 'campaign' ? 'campaign' : 'line item';
    if (v.fields.entity_status) {
      lines.push(`${v.fields.entity_status === 'ACTIVE' ? 'Activate' : 'Pause'} ${noun} "${prior.name}": ${prior.entity_status} → ${v.fields.entity_status}.`);
      if (v.fields.entity_status === 'ACTIVE') {
        if (kind === 'campaign') {
          if (typeof prior.daily_budget_amount_local_micro === 'number') {
            // Legacy campaign-budget campaign: its own budget caps the whole campaign.
            activateBudgetMicros = prior.daily_budget_amount_local_micro;
            lines.push(`It will start delivering and can spend up to ${money(prior.daily_budget_amount_local_micro)}/day (campaign budget).`);
          } else {
            const items = (await deps.listAll({
              credentials: session.credentials, fetchImpl: session.fetchImpl, path: `/accounts/${acct}/line_items`, query: { campaign_ids: prior.id },
            })).filter((li) => !li.deleted);
            state = { ...state, line_items: items.map((li) => pick(li, STABLE.line_item)) };
            const sum = items.reduce((total, li) => total + (typeof li.daily_budget_amount_local_micro === 'number' ? li.daily_budget_amount_local_micro : 0), 0);
            activateBudgetMicros = sum;
            const active = items.filter((li) => li.entity_status === 'ACTIVE').length;
            lines.push(items.length
              ? `It will start delivering and can spend up to ${money(sum)}/day: the sum of its ${items.length} line item daily budget(s) (${active} ACTIVE now; paused ones spend only after their own ACTIVATE).`
              : 'It has no line items yet, so nothing delivers until a line item (with its own daily budget) is created and activated.');
          }
        } else {
          const campaign = await mustRead('campaign', prior.campaign_id);
          state = { ...state, campaign: pick(campaign, STABLE.campaign) };
          const own = prior.daily_budget_amount_local_micro;
          activateBudgetMicros = typeof own === 'number' ? own : campaign.daily_budget_amount_local_micro;
          lines.push(typeof own === 'number'
            ? `It can spend up to ${money(own)}/day (its daily budget).`
            : `It has no daily budget of its own; campaign "${campaign.name}" caps it at ${money(campaign.daily_budget_amount_local_micro)}/day.`);
          lines.push(`It delivers only while campaign "${campaign.name}" is ACTIVE (now ${campaign.entity_status}).`);
        }
      }
    } else {
      if (kind === 'campaign' && (v.fields.daily_budget_amount_local_micro !== undefined || v.fields.total_budget_amount_local_micro !== undefined)
        && typeof prior.daily_budget_amount_local_micro !== 'number' && typeof prior.total_budget_amount_local_micro !== 'number') {
        throw new MetaToolkitRefusal(
          `Campaign "${prior.name}" has no campaign budget (budget_optimization=${prior.budget_optimization ?? 'LINE_ITEM'}): its budget lives on its line items. `
          + 'Change daily_budget/total_budget with LINE_ITEM UPDATE on each line item instead. Nothing was sent.',
        );
      }
      if (v.fields.name !== undefined) lines.push(`Rename ${noun} "${prior.name}" → "${v.fields.name}".`);
      if (v.fields.daily_budget_amount_local_micro !== undefined) lines.push(`Daily budget: ${money(prior.daily_budget_amount_local_micro)} → ${money(v.fields.daily_budget_amount_local_micro)}.`);
      if (v.fields.total_budget_amount_local_micro !== undefined) lines.push(`Total budget: ${money(prior.total_budget_amount_local_micro)} → ${money(v.fields.total_budget_amount_local_micro)}.`);
      if (v.fields.bid_amount_local_micro !== undefined) lines.push(`Max bid: ${money(prior.bid_amount_local_micro)} → ${money(v.fields.bid_amount_local_micro)}.`);
      lines.push(`Status stays ${prior.entity_status}.`);
    }
  }

  // Spend ceiling (micros): daily budgets set here, and activating at the current daily budget.
  const policy = deps.spendCeilingPolicy();
  if (policy && v.fields.daily_budget_amount_local_micro !== undefined) {
    const prior = (state.prior as any)?.daily_budget_amount_local_micro;
    const verdict = evaluateMetaSpendCeiling(policy, { field: 'daily_budget', proposed: v.fields.daily_budget_amount_local_micro, prior });
    if (!verdict.allowed) throw new MetaToolkitRefusal(verdict.message.replace('(minor units)', '(micros)'));
  }
  if (policy && v.fields.entity_status === 'ACTIVE') {
    const verdict = evaluateMetaSpendCeiling(policy, { field: 'daily_budget', proposed: activateBudgetMicros });
    if (!verdict.allowed) throw new MetaToolkitRefusal(`Activating would start spend at its daily budget. ${verdict.message.replace('(minor units)', '(micros)')}`);
  }

  const fingerprint = previewFingerprint({ platform: 'x_ads', userId, accountId: session.accountId, op: v.op, fields: v.fields, targeting: v.targeting, state, currency });
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
  let createdId: string | undefined;
  try {
    if (v.op === 'CAMPAIGN CREATE') {
      createdId = (await call({ method: 'POST', path: `/accounts/${acct}/campaigns`, query: v.fields }))?.data?.id;
    } else if (v.op === 'LINE_ITEM CREATE') {
      // X requires both start_time and end_time on line items. Defaults (outside the preview
      // fingerprint): start now, end X_ADS_LINE_ITEM_DEFAULT_DAYS later.
      const liStartIso = String(v.fields.start_time ?? toXTime(now));
      const liEndIso = String(v.fields.end_time ?? toXTime(Date.parse(liStartIso) + X_ADS_LINE_ITEM_DEFAULT_DAYS * 86400000));
      const liQuery = { ...v.fields, start_time: liStartIso, end_time: liEndIso };
      createdId = (await call({ method: 'POST', path: `/accounts/${acct}/line_items`, query: liQuery }))?.data?.id;
    } else if (v.op === 'PROMOTED_TWEET CREATE') {
      await call({ method: 'POST', path: `/accounts/${acct}/promoted_tweets`, query: v.fields });
    } else {
      await call({ method: 'PUT', path: `/accounts/${acct}/${PATH[v.target!.kind]}/${encodeURIComponent(v.target!.id)}`, query: v.fields });
    }
  } catch (error) {
    if (outcomeUnknown(error)) {
      return {
        success: false,
        verification: 'UNCONFIRMED' as WriteVerification,
        message: `X did not give a definite answer (${(error as Error).message}). The change may have applied: re-read with x_ads_read before retrying so nothing is duplicated.`,
      };
    }
    throw new MetaToolkitRefusal(`X rejected the change, so nothing was changed: ${(error as Error).message}`);
  }

  // Targeting for a new line item (one batch request); a failure leaves a PAUSED line item without it.
  let targetingError: string | undefined;
  if (v.op === 'LINE_ITEM CREATE' && createdId && v.targeting.length) {
    try {
      await call({
        method: 'POST',
        path: `/batch/accounts/${acct}/targeting_criteria`,
        json: v.targeting.map((c) => ({ operation_type: 'Create', params: { line_item_id: createdId, ...c } })),
      });
    } catch (error) {
      targetingError = (error as Error).message;
    }
  }

  // Independent read-back.
  const result: Record<string, unknown> = { success: false, op: v.op };
  let verification: WriteVerification = 'UNCONFIRMED';
  try {
    if (v.op === 'PROMOTED_TWEET CREATE') {
      const rows = await deps.listAll({ credentials: session.credentials, fetchImpl: session.fetchImpl, path: `/accounts/${acct}/promoted_tweets`, query: { line_item_ids: v.parent!.id } });
      const live = new Set(rows.filter((r) => !r.deleted).map((r) => String(r.tweet_id)));
      const missing = v.tweetIds!.filter((t) => !live.has(t));
      verification = missing.length ? 'MISMATCH' : 'CONFIRMED';
      result.promoted_tweet_ids = rows.filter((r) => v.tweetIds!.includes(String(r.tweet_id))).map((r) => r.id);
      if (missing.length) result.missing_tweet_ids = missing;
    } else {
      const kind = v.target?.kind ?? (v.op === 'CAMPAIGN CREATE' ? 'campaign' : 'line_item');
      const id = v.target?.id ?? createdId;
      result.id = id;
      const row = id ? await read(kind, id) : null;
      if (row) {
        const expected = { ...v.fields };
        delete expected.placements; // X echoes placements as an array
        const same = (k: string, want: unknown) => (k.endsWith('_time') ? Date.parse(String(row[k])) === Date.parse(String(want)) : String(row[k]) === String(want));
        const diff = Object.entries(expected).filter(([k, want]) => !same(k, want)).map(([k]) => k);
        verification = diff.length ? 'MISMATCH' : 'CONFIRMED';
        if (diff.length) result.mismatched_fields = diff;
        result.entity_status = row.entity_status;
      } else {
        verification = 'MISMATCH';
      }
      if (v.op === 'LINE_ITEM CREATE' && v.targeting.length && id) {
        if (targetingError) {
          verification = 'MISMATCH';
          result.targeting_error = `The line item was created PAUSED but its targeting was not set: ${targetingError}`;
        } else {
          const criteria = await deps.listAll({ credentials: session.credentials, fetchImpl: session.fetchImpl, path: `/accounts/${acct}/targeting_criteria`, query: { line_item_ids: id } });
          const have = new Set(criteria.filter((c) => !c.deleted).map((c) => `${c.targeting_type}:${String(c.targeting_value).toLowerCase()}`));
          const missing = v.targeting.filter((c) => !have.has(`${c.targeting_type}:${c.targeting_value.toLowerCase()}`));
          if (missing.length) {
            verification = 'MISMATCH';
            result.missing_targeting = missing;
          }
        }
      }
    }
  } catch (error) {
    result.read_back_error = (error as Error).message;
    verification = 'UNCONFIRMED';
  }
  result.verification = verification;
  result.success = verification === 'CONFIRMED';
  result.message = verification === 'CONFIRMED'
    ? `${v.op} applied and verified on X.`
    : `${v.op} was sent to X but the read-back did not confirm it (${verification}). Re-read with x_ads_read before retrying.`;
  return result;
}
