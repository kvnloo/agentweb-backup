/**
 * ENG-2303 P3 — guarded Meta writes for external MCP agents (lifts ENG-2268 D2 for a
 * narrow surface, per Harsha 2026-10-12).
 *
 * Allowed: CAMPAIGN / AD_SET / AD  CREATE, and UPDATE of status (ACTIVE|PAUSED), budget, and
 * (ENG-2913) post-launch edits: CAMPAIGN bid_strategy/spend_cap, AD_SET bid_amount/
 * bid_strategy/targeting/start_time/end_time, AD creative swap (creative_id), and name on all three (ENG-2960). Every
 * UPDATE preview shows a before → after field diff and the read-back verifies every field.
 * Still excluded here: COPY_AD, RETAG_UTM, launch_*. ARCHIVE / DELETE / COPY are their own guarded
 * path (ENG-2922, metaToolkitLifecycle.ts). Custom audiences are metaToolkitAudiences.ts (ENG-2914).
 * Creative assets (AD_CREATIVE UPLOAD_IMAGE / UPLOAD_VIDEO / CREATE) are metaToolkitCreatives.ts.
 *
 * Flow (preview → confirm, bound):
 *   1. Call without `confirm` → full guard run, nothing sent to Meta, returns a PREVIEW and a
 *      single-use `preview_token` (HMAC over the user, the exact arguments, and what the
 *      preview showed: target summary, money echo, budget-anomaly verdict; 15 min TTL).
 *   2. Same call with `confirm: true` + that token → the guards and preview are recomputed;
 *      the token must match the fresh preview, so changed arguments or changed Meta state
 *      cannot ride an old approval. Then the write is dispatched exactly like an approved
 *      Emma approval-deck item (dispatchAuthorizedMetaWrite: budget-anomaly re-check,
 *      tracking pre-flight, rate shaper) and read back.
 *
 * Invariants: new entities are always created PAUSED; activation (status→ACTIVE) is its own
 * UPDATE with its own preview + confirm; writes need a payment method + usable Meta
 * connection (P2) and a GRANTED `ads_management` scope (D4); money is echoed in the ad
 * account's currency (`5000 (= $50.00)`); a write whose read-back cannot confirm it is
 * reported UNCONFIRMED, never success.
 *
 * Replay: tokens are single-use per process. There is no durable claim store (that would
 * be new persistence — data-plane gate); a cross-instance replay inside the TTL could at
 * worst repeat an identical PAUSED create or an idempotent status/budget update.
 */
import { getJwtSecret } from '../config/jwt';
import { getAccountsByUserIdIncludingOrgShared, type ConnectedAccount } from '../services/connectedAccountsDb';
import { isMetaAdAccount } from '../services/metaTokenRefresh';
import { evaluateMetaSpendCeiling, type MetaSpendCeilingPolicy } from '../services/agentMode/metaSpendCeiling';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { flattenNestedCampaignCreate } from '../services/agentMode/metaCampaignCreateParams';
import { metaPageAccessRefusalText } from './metaPageAccessRefusal';
import { getAccessiblePageIds, getMetaPagesAccessState } from '../utils/metaAdsScope';
import { assertOptimisationEventConfigured, type ConversionLookup } from './metaToolkitConversionGate';
import { GUARDED_WRITE_ACTIONS, GUARDED_WRITE_ENTITIES, isGuardedWriteRequest } from './metaToolkitWriteSurface';
import { adsManagementScopeState, assertZomaWriteReady, ZomaNotReadyError } from './zomaOnboarding';
import {
  consumeToken, defaultConsumedTokenStore, type ConsumedTokens, isOutcomeUnknownFailure, previewFingerprint, previewResponse, previewTokenMatches,
  rememberTokenOutcome, replayTokenOutcome,
  PREVIEW_TOKEN_TTL_MS, type WriteVerification,
} from './zomaWriteGuard';

export { GUARDED_WRITE_ENTITIES, GUARDED_WRITE_ACTIONS, isGuardedWriteRequest, PREVIEW_TOKEN_TTL_MS };
export type { WriteVerification };

const UPDATE_FIELDS: Record<string, string[]> = {
  CAMPAIGN: ['status', 'daily_budget', 'lifetime_budget', 'budget_amount', 'bid_strategy', 'spend_cap', 'name'],
  AD_SET: ['status', 'daily_budget', 'lifetime_budget', 'bid_amount', 'bid_strategy', 'targeting', 'start_time', 'end_time', 'name'],
  AD: ['status', 'creative_id', 'name'],
};
// LOWEST_COST_WITH_MIN_ROAS is not offered: it needs a ROAS floor (bid_constraints) that no
// allowed UPDATE field carries, and the create path rejects ROAS bidding as unsupported.
export const BID_STRATEGIES = ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP'];
const TIME_FIELDS = ['start_time', 'end_time'] as const;
/** ISO 8601 date-time with an explicit offset; Meta reads offsetless times in the ad account's timezone. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
/**
 * Budget fields the write rate shaper coalesces on (metaWriteRateShaper BUDGET_FIELDS): a repeat
 * of the same budget is answered "no change" without sending, so it must not carry other edits.
 */
const SHAPED_BUDGET_FIELDS = ['daily_budget', 'lifetime_budget', 'budget_amount', 'spend_cap'];
/** Targeting lists that are removed when a full replacement spec leaves them out. */
const REMOVABLE_TARGETING_LISTS = ['custom_audiences', 'excluded_custom_audiences', 'flexible_spec', 'exclusions'];
const MONEY_FIELDS = ['budget_amount', 'daily_budget', 'lifetime_budget', 'bid_amount', 'spend_cap'];
const CEILING_FIELDS = ['daily_budget', 'lifetime_budget', 'spend_cap', 'bid_amount'] as const;
// Gate-only flags of the internal path; an external caller never supplies these.
const FORBIDDEN_PARAMS = ['confirm', 'override_tracking_check', 'tracking_override_token', 'budget_confirmation_token'];

export interface MetaToolkitWriteDeps {
  assertReady: (userId: string) => Promise<void>;
  listAccounts: (userId: string) => Promise<ConnectedAccount[]>;
  previewMoney: (userId: string, accountId: string, params: any) => Promise<{ params: any; currency?: string; confirmation: string }>;
  /** Sessionless shared-gate preview (AgentModeService.previewToolkitMetaWrite); never dispatches. */
  preview: (
    userId: string, entity: any, action: string, accountId: string,
    campaignId?: string, adSetId?: string, adId?: string, params?: any,
  ) => Promise<any>;
  dispatch: (userId: string, dispatch: any) => Promise<{ result: any; createdId?: string }>;
  readBack: (userId: string, accountId: string, entity: string, id: string) => Promise<Record<string, any> | null>;
  /** ENG-2913: throws unless the creative belongs to the selected ad account (creative ids are global). */
  assertCreativeOwned: (userId: string, accountId: string, creativeId: string) => Promise<void>;
  /** ENG-3129: one-click Meta reconnect link for the Page-access refusal. */
  connectLink?: (userId: string) => Promise<string>;
  /** ENG-2942: account-scoped custom conversion / pixel event reads for AD_SET CREATE. */
  conversionLookup?: (userId: string, accountId: string) => Promise<ConversionLookup>;
  spendCeilingPolicy: () => MetaSpendCeilingPolicy | null;
  secret: () => string;
  now: () => number;
  consumedTokens: ConsumedTokens;
  /** ENG-2931: outcome per consumed preview token, replayed on a repeat confirm. */
  /** requestKey binds a recorded CREATE outcome to its exact request (see createRequestKey). */
  tokenOutcomes?: Map<string, { exp: number; outcome: any; requestKey?: string }>;
}

/**
 * Optional global ceiling for external writes, minor units. Per-account ceilings need a
 * policy store (data-plane, not built). Unset = no ceiling; malformed = fail closed.
 */
export function spendCeilingPolicyFromEnv(raw = process.env.META_TOOLKIT_SPEND_CEILING): MetaSpendCeilingPolicy | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return { maxDailyBudget: parsed.maxDailyBudget, maxChangeRatio: parsed.maxChangeRatio };
  } catch {
    /* fall through */
  }
  return { maxChangeRatio: -1 }; // invalid on purpose → evaluator refuses
}

// agentModeService is loaded lazily: it is the 24k-line monolith and the toolkit's read
// path (and its tests) must not pay for importing it.
const ams = async () => (await import('../services/agentModeService')).agentModeService;

const defaultDeps: MetaToolkitWriteDeps = {
  assertReady: (userId) => assertZomaWriteReady(userId),
  listAccounts: getAccountsByUserIdIncludingOrgShared,
  previewMoney: async (userId, accountId, params) => (await ams()).previewMetaMoneyParams(userId, accountId, params),
  preview: async (...a) => (await ams()).previewToolkitMetaWrite(...a),
  dispatch: async (userId, d) => (await ams()).dispatchToolkitConfirmedMetaWrite(userId, d),
  readBack: async (userId, accountId, entity, id) => (await ams()).readBackMetaWriteTarget(userId, accountId, entity, id),
  assertCreativeOwned: async (userId, accountId, creativeId) => (await ams()).assertToolkitMetaCreativeOwned(userId, accountId, creativeId),
  conversionLookup: async (userId, accountId) => (await ams()).toolkitMetaConversionLookup(userId, accountId),
  // Zoma-token callers: the zoma state claim routes the Meta callback back to Zoma's pages.
  connectLink: async (userId) =>
    (await import('../services/metaConnectUrl')).buildMetaConnectUrl(userId, 'marketing', { zoma: (await import('./zomaSetupLinks')).ZOMA_MCP_SETUP }),
  spendCeilingPolicy: () => spendCeilingPolicyFromEnv(),
  secret: () => getJwtSecret(),
  now: () => Date.now(),
  consumedTokens: defaultConsumedTokenStore,
  tokenOutcomes: new Map(),
};

function targetId(entity: string, args: any): string | undefined {
  return entity === 'CAMPAIGN' ? args.campaign_id : entity === 'AD_SET' ? args.ad_set_id : args.ad_id;
}

/** Shape checks that need no I/O. Returns the params to preview/dispatch. */
function validateWriteShape(entity: string, action: string, args: any): any {
  if (args.client_id !== undefined) throw new MetaToolkitRefusal('client_id is not available to external Meta Toolkit callers.');
  let params = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? { ...args.params } : {};
  // The campaign's fields may arrive nested as params.campaign; lifted before anything reads them
  // (the objective line, money normalization, the preview binding).
  if (entity === 'CAMPAIGN' && action === 'CREATE') {
    const flat = flattenNestedCampaignCreate(
      params,
      'Zoma creates one entity per call: create the campaign, then AD_SET CREATE with its campaign_id, then AD CREATE with the ad set id — each with its own preview and approval.',
    );
    if (flat.error !== undefined) throw new MetaToolkitRefusal(flat.error);
    params = flat.params;
  }
  for (const key of FORBIDDEN_PARAMS) {
    if (params[key] !== undefined) {
      throw new MetaToolkitRefusal(`params.${key} is not available to external Meta Toolkit callers. Use the top-level confirm + preview_token flow.`);
    }
  }
  if (action === 'CREATE') {
    if (params.status !== undefined && params.status !== 'PAUSED') {
      throw new MetaToolkitRefusal(
        'New campaigns, ad sets and ads are always created PAUSED. Create it paused first, then activate it with a separate UPDATE status=ACTIVE preview and approval.',
      );
    }
    params.status = 'PAUSED';
    return params;
  }
  // UPDATE
  if (!targetId(entity, args)) {
    const field = entity === 'CAMPAIGN' ? 'campaign_id' : entity === 'AD_SET' ? 'ad_set_id' : 'ad_id';
    throw new MetaToolkitRefusal(`${entity} UPDATE requires ${field}.`);
  }
  const keys = Object.keys(params).filter((k) => params[k] !== undefined);
  const allowed = UPDATE_FIELDS[entity];
  const extra = keys.filter((k) => !allowed.includes(k));
  if (keys.length === 0 || extra.length > 0) {
    throw new MetaToolkitRefusal(`${entity} UPDATE via the Meta Toolkit can change only: ${allowed.join(', ')}.${extra.length ? ` Not allowed: ${extra.join(', ')}.` : ''}`);
  }
  if (params.status !== undefined && !['ACTIVE', 'PAUSED'].includes(params.status)) {
    throw new MetaToolkitRefusal('status can only be set to ACTIVE or PAUSED.');
  }
  if (params.status === 'ACTIVE' && keys.length > 1) {
    throw new MetaToolkitRefusal('Activation (status=ACTIVE) must be its own change with its own preview and approval. Change the budget first, then activate separately.');
  }
  validateEditFields(params, keys);
  return params;
}

/** ENG-2913: shape checks for the post-launch edit fields. */
function validateEditFields(params: any, keys: string[]) {
  // status counts too: a coalesced budget repeat would also drop a bundled PAUSE.
  const others = (fields: string[]) => keys.filter((k) => !fields.includes(k));
  if (keys.some((k) => SHAPED_BUDGET_FIELDS.includes(k)) && others(SHAPED_BUDGET_FIELDS).length) {
    throw new MetaToolkitRefusal(
      `Change the budget or spend cap in its own UPDATE, separately from ${others(SHAPED_BUDGET_FIELDS).join(', ')}. ` +
        'A repeated budget can be answered "no change" without sending anything, which would drop the other edits.',
    );
  }
  if (params.creative_id !== undefined && keys.some((k) => k !== 'creative_id')) {
    throw new MetaToolkitRefusal(
      'Swap the creative (creative_id) in its own UPDATE. Meta applies a creative swap and other ad edits as separate updates, ' +
        'and allows one update per ad about every 30 seconds, so combining them can leave the ad half-changed.',
    );
  }
  if (params.bid_strategy !== undefined && !BID_STRATEGIES.includes(params.bid_strategy)) {
    throw new MetaToolkitRefusal(`bid_strategy must be one of: ${BID_STRATEGIES.join(', ')}.`);
  }
  if (params.bid_strategy === 'LOWEST_COST_WITHOUT_CAP' && params.bid_amount !== undefined) {
    throw new MetaToolkitRefusal('bid_amount must not be set with LOWEST_COST_WITHOUT_CAP.');
  }
  // Same bid guard as AD_SET CREATE (createMetaAdsAdSet): major units, $0.01 – $1,000.
  if (params.bid_amount !== undefined) {
    const bid = Number(params.bid_amount);
    if (!Number.isFinite(bid) || bid < 0.01) throw new MetaToolkitRefusal('bid_amount must be at least 0.01.');
    if (bid > 1000) throw new MetaToolkitRefusal('bid_amount exceeds safety limit of 1,000 (same limit as creating an ad set).');
  }
  if (params.targeting !== undefined && (!params.targeting || typeof params.targeting !== 'object' || Array.isArray(params.targeting))) {
    throw new MetaToolkitRefusal('targeting must be a Meta targeting object (e.g. {geo_locations, age_min, excluded_custom_audiences}). Send the full targeting spec; it replaces the current one.');
  }
  const excluded = params.targeting?.excluded_custom_audiences;
  if (excluded !== undefined && (!Array.isArray(excluded) || excluded.some((a: any) => !a || typeof a !== 'object' || !a.id))) {
    throw new MetaToolkitRefusal('targeting.excluded_custom_audiences must be a list of {id} objects.');
  }
  // Same location guard as AD_SET CREATE: a replacement spec without locations would silently
  // strip the ad set's country targeting (the spec replaces the current one as a whole).
  if (params.targeting !== undefined) {
    const geo = params.targeting.geo_locations;
    const hasLocation = geo && typeof geo === 'object' && ['countries', 'regions', 'cities', 'zips', 'geo_markets', 'custom_locations', 'places']
      .some((k) => Array.isArray(geo[k]) && geo[k].length > 0);
    if (!hasLocation) {
      throw new MetaToolkitRefusal('targeting.geo_locations is required and cannot be empty: the targeting spec replaces the current one, so include the locations (e.g. {"countries": ["US"]}) along with any other changes.');
    }
  }
  for (const f of TIME_FIELDS) {
    if (params[f] === undefined) continue;
    if (typeof params[f] !== 'string' || !ISO_WITH_OFFSET.test(params[f]) || Number.isNaN(Date.parse(params[f])) || !isCalendarDate(params[f])) {
      throw new MetaToolkitRefusal(`${f} must be an ISO 8601 date-time with a timezone offset (e.g. 2026-12-01T09:00:00-0800).`);
    }
  }
  if (params.start_time !== undefined && params.end_time !== undefined && Date.parse(params.end_time) <= Date.parse(params.start_time)) {
    throw new MetaToolkitRefusal('end_time must be after start_time.');
  }
  if (params.creative_id !== undefined && !/^\d+$/.test(String(params.creative_id))) {
    throw new MetaToolkitRefusal('creative_id must be a Meta ad creative id (digits). Create the new creative first (AD_CREATIVE CREATE), then swap it in.');
  }
  if (params.name !== undefined && (typeof params.name !== 'string' || !params.name.trim())) {
    throw new MetaToolkitRefusal('name must be a non-empty string.');
  }
}

const BOUND_PRIOR_FIELDS = ['status', 'name', 'daily_budget', 'lifetime_budget', 'spend_cap', 'bid_amount', 'bid_strategy', 'targeting', 'start_time', 'end_time', 'creative_id'];
function priorStateForBinding(prior: Record<string, any> | null): Record<string, unknown> | null {
  if (!prior) return null;
  return Object.fromEntries(BOUND_PRIOR_FIELDS.filter((f) => prior[f] !== undefined).map((f) => [f, prior[f]]));
}

/** The YYYY-MM-DD part is a real calendar day (Date.parse rolls 2026-02-30 over to March). */
function isCalendarDate(iso: string): boolean {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function show(v: unknown): string {
  if (v === undefined || v === null || v === '') return '(not set)';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** ENG-2913: "field: before → after" lines for an UPDATE preview (money shown in minor units). */
export function fieldDiffLines(params: any, minor: any, prior: Record<string, any> | null): string[] {
  return Object.keys(params).filter((k) => params[k] !== undefined && k !== 'status').map((k) => {
    const apiField = k === 'budget_amount' ? 'daily_budget' : k;
    const after = MONEY_FIELDS.includes(k) ? minor?.[apiField] ?? params[k] : params[k];
    const before = prior ? prior[apiField] : undefined;
    return `- ${apiField}: ${prior ? show(before) : '(current value unavailable)'} → ${show(after)}`;
  });
}

function findMetaAdAccount(accounts: ConnectedAccount[], accountId: string): ConnectedAccount | undefined {
  const norm = (v: unknown) => String(v ?? '').trim().replace(/^act_/, '');
  return accounts.filter(isMetaAdAccount).find(
    (a) => norm((a.config as any)?.ad_account_id) === norm(accountId) || norm(a.account_id) === norm(accountId),
  );
}

export function assertAdsManagementGranted(accounts: ConnectedAccount[], accountId: string) {
  const account = findMetaAdAccount(accounts, accountId);
  const state = account ? adsManagementScopeState(account) : 'missing';
  if (state === 'granted') return;
  throw new MetaToolkitRefusal(
    state === 'missing'
      ? 'This Meta connection was not granted the ads_management permission, so Zoma cannot change ads on it. Reconnect Meta (run zoma_status for the link) and approve ads management.'
      : 'Zoma cannot verify that this Meta connection was granted the ads_management permission. Reconnect Meta (run zoma_status for the link) so the granted permissions are recorded.',
  );
}

/**
 * ENG-3129: refuse an ad / creative CREATE on an account whose stored Page probe says no
 * Facebook Page is accessible, before anything reaches Meta. Only a confirmed 'missing'
 * refuses; never-probed ('unknown') goes through, as in the Emma gate (adsApis.ts).
 * A link that cannot be minted degrades to "run zoma_status for the link", never blocks.
 */
export async function assertMetaPageAccessForCreate(
  accounts: ConnectedAccount[], accountId: string,
  opts: { pageId?: string; pageIds?: string[]; connectLink?: () => Promise<string> } = {},
) {
  const config = findMetaAdAccount(accounts, accountId)?.config as any;
  if (getMetaPagesAccessState(config) !== 'missing') return;
  // The account flag is account-wide; requested Pages the probe lists as accessible are usable.
  // Ids compare as text (callers may send numbers); every requested Page must be reachable.
  const requested = [...(opts.pageIds ?? []), ...(opts.pageId ? [opts.pageId] : [])].map(String);
  const storedList = getAccessiblePageIds(config);
  // No stored reachable-Page list but the probe counted Pages: the flag is a wrong-Page
  // mismatch we cannot check per Page, so a named Page goes on to Meta (Opslane run 2370 AT4).
  if (requested.length && storedList === undefined && Number(config?.meta_page_count) > 0) return;
  const accessible = (storedList ?? []).map(String);
  const blocked = requested.find((id) => !accessible.includes(id));
  if (requested.length && !blocked) return;
  const link = opts.connectLink ? await opts.connectLink().catch(() => undefined) : undefined;
  throw new MetaToolkitRefusal(metaPageAccessRefusalText(config, { pageId: blocked, link }));
}

function errorText(result: any): string {
  return String(result?.error || result?.message || 'The change could not be prepared.');
}

function statusLine(action: string, params: any): string {
  if (action === 'CREATE') return 'Status: PAUSED — new entities are always created paused; going live is a separate preview and approval.';
  if (params.status === 'ACTIVE') return 'Status: ACTIVE — this starts delivery and spending as soon as Meta applies it.';
  if (params.status === 'PAUSED') return 'Status: PAUSED — stops delivery.';
  return 'Status: unchanged.';
}

/**
 * Execute (or preview) one guarded write. `args.account_id` must already be the resolved,
 * ownership-checked ad account (the gateway does that before calling here).
 */
/** Stable identity of a CREATE request (user + every argument except confirm/preview_token). */
function createRequestKey(userId: string, args: any): string {
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
  return JSON.stringify([userId, stable(args)]);
}

export async function executeMetaToolkitWrite(userId: string, rawArgs: any, deps: MetaToolkitWriteDeps = defaultDeps) {
  const { confirm, preview_token: previewToken, ...args } = rawArgs ?? {};
  const entity = String(args.entity_type);
  const action = String(args.action);
  const accountId = String(args.account_id ?? '');
  const params = validateWriteShape(entity, action, args);

  try {
    await deps.assertReady(userId);
  } catch (error) {
    if (error instanceof ZomaNotReadyError) throw new MetaToolkitRefusal(error.message);
    throw error;
  }
  const accounts = await deps.listAccounts(userId);
  assertAdsManagementGranted(accounts, accountId);
  // Only an AD needs a Page here (creatives are gated in metaToolkitCreatives); CAMPAIGN / AD_SET carry none.
  if (action === 'CREATE' && entity === 'AD') {
    // A repeat confirm of a CREATE that already ran gets its recorded outcome, not a
    // "nothing was sent" Page refusal; only new CREATE dispatch is gated.
    // The replay is bound to the request that recorded it: the same token with changed
    // arguments falls through to the gate (and later PREVIEW_MISMATCH), never a stale success.
    if (confirm === true && typeof previewToken === 'string') {
      const outcomes = (deps.tokenOutcomes ??= new Map());
      const replay = replayTokenOutcome(outcomes, previewToken, deps.now());
      if (replay && outcomes.get(previewToken)?.requestKey === createRequestKey(userId, args)) return replay;
    }
    await assertMetaPageAccessForCreate(accounts, accountId, { connectLink: deps.connectLink && (() => deps.connectLink!(userId)) });
  }

  // Currency echo + minor units, via the same normalizer the writers use.
  let money: { params: any; confirmation: string } = { params, confirmation: '' };
  if (MONEY_FIELDS.some((f) => params[f] !== undefined)) {
    try {
      money = await deps.previewMoney(userId, accountId, params);
    } catch (error) {
      throw new MetaToolkitRefusal(error instanceof Error ? error.message : 'Money amounts could not be normalized; nothing was sent.');
    }
  }

  const policy = deps.spendCeilingPolicy();
  let enableBudgetState: Record<string, any> | undefined;
  if (entity === 'AD_SET' && action === 'UPDATE' && params.status === 'ACTIVE' && policy) {
    const adSet = await deps.readBack(userId, accountId, entity, targetId(entity, args)!).catch(() => null);
    // Campaign-budgeted ad sets have no positive daily budget of their own. Resolve
    // their parent from provider state, never from a caller-supplied campaign_id.
    const budget = adSet?.daily_budget != null && Number(adSet.daily_budget) !== 0
      ? adSet
      : adSet?.campaign_id
        ? await deps.readBack(userId, accountId, 'CAMPAIGN', String(adSet.campaign_id)).catch(() => null)
        : null;
    enableBudgetState = { adSet, budget };
    const verdict = evaluateMetaSpendCeiling(policy, { field: 'daily_budget', proposed: budget?.daily_budget });
    if (!verdict.allowed) throw new MetaToolkitRefusal(`Enabling this ad set would start spend at its budget. ${verdict.message}`);
  }
  const priorId = targetId(entity, args);
  const prior = action === 'UPDATE' && priorId ? await deps.readBack(userId, accountId, entity, priorId).catch(() => null) : null;
  const diff = action === 'UPDATE' ? fieldDiffLines(params, money.params, prior) : [];
  if (action === 'UPDATE' && params.creative_id !== undefined) {
    try {
      await deps.assertCreativeOwned(userId, accountId, String(params.creative_id));
    } catch (error: any) {
      // Only a confirmed "not in this account" answer says so; a Meta outage is not a verdict.
      if (error?.creativeLookupFailed) {
        throw new MetaToolkitRefusal(`Could not check creative ${params.creative_id} with Meta right now (${error?.message || 'Meta request failed'}). Nothing was changed; try again shortly.`);
      }
      throw new MetaToolkitRefusal(`Creative ${params.creative_id} was not found in ad account ${accountId}. Nothing was changed.`);
    }
  }
  // ENG-2942: a custom conversion / custom pixel event is accepted only when the account has it.
  if (entity === 'AD_SET' && action === 'CREATE' && params.promoted_object && deps.conversionLookup) {
    const lookup = await deps.conversionLookup(userId, accountId);
    await assertOptimisationEventConfigured(params.promoted_object, lookup);
  }
  // A bid amount on an ad set that stays on the no-cap strategy is stored but unused by Meta.
  if (action === 'UPDATE' && entity === 'AD_SET' && params.bid_amount !== undefined && params.bid_strategy === undefined
    && prior?.bid_strategy === 'LOWEST_COST_WITHOUT_CAP') {
    throw new MetaToolkitRefusal('This ad set uses LOWEST_COST_WITHOUT_CAP, which ignores bid_amount. Send bid_strategy (LOWEST_COST_WITH_BID_CAP or COST_CAP) together with bid_amount.');
  }
  // A schedule change on a live ad set can start or extend delivery (e.g. a past end_time moved
  // into the future), so it gets the same treatment as an activation: its own change, current
  // status known, and the enable spend ceiling.
  const scheduleChange = action === 'UPDATE' && TIME_FIELDS.some((f) => params[f] !== undefined);
  let scheduleBudgetState: Record<string, any> | undefined;
  if (scheduleChange) {
    if (!prior?.status) throw new MetaToolkitRefusal('Could not read the current status of this ad set, so its schedule was not changed. Try again.');
    if (prior.status === 'ACTIVE') {
      const extra = Object.keys(params).filter((k) => params[k] !== undefined && !TIME_FIELDS.includes(k as any));
      if (extra.length) {
        throw new MetaToolkitRefusal(`This ad set is ACTIVE: change its schedule in its own UPDATE, separately from ${extra.join(', ')}.`);
      }
      if (policy) {
        const budget = prior.daily_budget != null && Number(prior.daily_budget) !== 0
          ? prior
          : prior.campaign_id
            ? await deps.readBack(userId, accountId, 'CAMPAIGN', String(prior.campaign_id)).catch(() => null)
            : null;
        scheduleBudgetState = { budget };
        const verdict = evaluateMetaSpendCeiling(policy, { field: 'daily_budget', proposed: budget?.daily_budget });
        if (!verdict.allowed) throw new MetaToolkitRefusal(`Changing the schedule of this ACTIVE ad set can start spend at its budget. ${verdict.message}`);
      }
    }
  }
  if (policy) {
    for (const field of CEILING_FIELDS) {
      if (money.params[field] === undefined) continue;
      const verdict = evaluateMetaSpendCeiling(policy, { field, proposed: money.params[field], prior: prior?.[field] });
      if (!verdict.allowed) throw new MetaToolkitRefusal(verdict.message);
    }
  }

  // The shared gate: validation, objective/Page checks, ownership, budget anomaly. With no
  // session it can only halt with a preview; it never dispatches.
  const preview = await deps.preview(
    userId, entity, action, accountId, args.campaign_id, args.ad_set_id, args.ad_id, params,
  );
  if (!preview?.awaitingUserConfirmation || !preview.metaWriteDispatch) {
    throw new MetaToolkitRefusal(`Not prepared, nothing was sent to Meta: ${errorText(preview)}`);
  }

  const fingerprint = previewFingerprint({
    userId, entity, action, accountId,
    campaign_id: args.campaign_id, ad_set_id: args.ad_set_id, ad_id: args.ad_id, params,
    summary: preview.summary, budgetAnomaly: preview.budgetAnomaly ?? null, money: money.confirmation,
    ...(diff.length ? { diff } : {}),
    ...(enableBudgetState ? { enableBudgetState } : {}),
    ...(scheduleBudgetState ? { scheduleBudgetState } : {}),
    // Bind the status the schedule warning was based on, with or without a spend policy.
    ...(scheduleChange ? { schedulePriorStatus: prior?.status ?? null } : {}),
    // Bind the entity's configured state (not delivery state), so an approval does not apply
    // to an ad set someone else changed after the preview (targeting, status, bidding, …).
    ...(action === 'UPDATE' ? { priorState: priorStateForBinding(prior) } : {}),
  });
  const now = deps.now();
  const secret = deps.secret();
  const previewText = [
    'PREVIEW — nothing has changed yet.',
    String(preview.summary ?? `${action} ${entity}`),
    entity === 'CAMPAIGN' && action === 'CREATE' ? `Objective: ${params.objective} (cannot be changed after creation)` : '',
    money.confirmation ? `Money${money.confirmation}` : '',
    diff.length ? `Changes (current → proposed):\n${diff.join('\n')}` : '',
    params.targeting !== undefined ? 'Targeting is replaced as a whole by the proposed spec; anything not in it is removed.' : '',
    scheduleChange && prior?.status === 'ACTIVE' ? 'This ad set is ACTIVE: the new schedule can start or extend delivery (and spend) as soon as it is applied.' : '',
    statusLine(action, params),
  ].filter(Boolean).join('\n');
  const freshPreview = () => previewResponse({ secret, userId, now, fingerprint, preview: previewText });

  if (confirm !== true) return freshPreview();

  if (!previewTokenMatches(previewToken, secret, userId, fingerprint, now)) {
    return {
      ...freshPreview(),
      status: 'PREVIEW_MISMATCH',
      note: 'The confirmation did not match a current preview (missing, expired, or the arguments or Meta state changed). Nothing was sent. Show this new preview and get approval again.',
    };
  }
  if (!(await consumeToken(deps.consumedTokens, previewToken, now))) {
    // ENG-2931: a client that lost the answer and repeats the same confirm gets that outcome back.
    const replay = replayTokenOutcome((deps.tokenOutcomes ??= new Map()), previewToken, now);
    if (replay) return replay;
    throw new MetaToolkitRefusal('This preview_token was already used. Run a new preview for another change.');
  }

  const outcome = await (async () => {
    // ENG-2931: a throw after the token was consumed (timeout, 5xx, transport) is outcome-unknown:
    // Meta may have applied it, so it is UNCONFIRMED, never success and never "did not apply".
    let dispatched: { result: any; createdId?: string | null };
    try {
      dispatched = await deps.dispatch(userId, preview.metaWriteDispatch);
    } catch (error: unknown) {
      return {
        success: false,
        verification: 'UNCONFIRMED' as WriteVerification,
        id: action === 'CREATE' ? null : (targetId(entity, args) ?? null),
        message: `UNCONFIRMED: the ${action} ${entity} request failed without a definite answer from Meta (${error instanceof Error ? error.message : String(error)}), so it may or may not have been applied. Do not report this as done and do not retry blindly — check the ${entity} first.`,
      };
    }
    const { result, createdId } = dispatched;
    if (result?.coalesced) {
      return { status: 'NO_CHANGE', success: true, message: String(result.message ?? 'No change was needed.') };
    }
    if (result?.awaitingUserConfirmation) {
      return { status: 'NEEDS_NEW_PREVIEW', success: false, message: 'Meta state changed after approval; nothing was sent. Run the preview again.' };
    }
    if (isOutcomeUnknownFailure(result)) {
      // ENG-2931: the wrapper caught a transport failure (no response, timeout, 5xx); Meta may
      // have applied it, so UNCONFIRMED — never a definite "did not apply" that invites a duplicate.
      return {
        success: false,
        verification: 'UNCONFIRMED' as WriteVerification,
        id: action === 'CREATE' ? null : (targetId(entity, args) ?? null),
        message: `UNCONFIRMED: the ${action} ${entity} request failed without a definite answer from Meta (${errorText(result)}), so it may or may not have been applied. Do not report this as done and do not retry blindly — check the ${entity} first.`,
      };
    }
    if (!result?.success || result?.blocked || result?.throttled) {
      return {
        status: 'FAILED', success: false, message: errorText(result),
        ...(result?.retryAfterMs ? { retry_after_ms: result.retryAfterMs } : {}),
      };
    }

    const id = action === 'CREATE' ? createdId : targetId(entity, args);
    const readBack = id ? await deps.readBack(userId, accountId, entity, id).catch(() => null) : null;
    const verification = verify(action, params, money.params, readBack);
    const base = {
      success: verification === 'CONFIRMED',
      verification,
      id: id ?? null,
      status: readBack?.status ?? null,
      effective_status: readBack?.effective_status ?? null,
      meta_message: String(result.message ?? ''),
    };
    if (verification === 'CONFIRMED') {
      return { ...base, message: `${action} ${entity} confirmed by read-back: id ${id}, status ${readBack!.status}${readBack!.effective_status ? ` (effective ${readBack!.effective_status})` : ''}.` };
    }
    if (verification === 'MISMATCH') {
      return { ...base, message: `Meta accepted the ${action}, but the read-back does not match what was approved. Review ${entity} ${id} before doing anything else.` };
    }
    return {
      ...base,
      message: `UNCONFIRMED: Meta accepted the ${action} request${id ? ` (id ${id})` : ''}, but the read-back could not confirm it. Do not report this as done and do not retry blindly — check the ${entity} first.`,
    };
  })();
  const outcomes = (deps.tokenOutcomes ??= new Map());
  rememberTokenOutcome(outcomes, previewToken, outcome);
  if (action === 'CREATE') outcomes.get(previewToken)!.requestKey = createRequestKey(userId, args);
  return outcome;
}

function verify(action: string, params: any, minor: any, readBack: Record<string, any> | null): WriteVerification {
  if (!readBack) return 'UNCONFIRMED';
  const expectedStatus = action === 'CREATE' ? 'PAUSED' : params.status;
  if (expectedStatus !== undefined && readBack.status !== expectedStatus) return 'MISMATCH';
  for (const field of ['daily_budget', 'lifetime_budget', 'bid_amount', 'spend_cap'] as const) {
    if (minor?.[field] === undefined) continue;
    if (readBack[field] === undefined || readBack[field] === null) return 'UNCONFIRMED';
    if (Number(readBack[field]) !== Number(minor[field])) return 'MISMATCH';
  }
  if (action !== 'UPDATE') return 'CONFIRMED';
  for (const field of ['bid_strategy', 'name', 'creative_id'] as const) {
    if (params[field] === undefined) continue;
    if (readBack[field] === undefined || readBack[field] === null) return 'UNCONFIRMED';
    if (String(readBack[field]) !== String(params[field])) return 'MISMATCH';
  }
  for (const field of TIME_FIELDS) {
    if (params[field] === undefined) continue;
    if (!readBack[field]) return 'UNCONFIRMED';
    const got = Date.parse(readBack[field]);
    const want = Date.parse(params[field]);
    if (Number.isNaN(got) || Number.isNaN(want)) return 'UNCONFIRMED';
    if (got !== want) return 'MISMATCH';
  }
  if (params.targeting !== undefined) {
    if (!readBack.targeting || typeof readBack.targeting !== 'object') return 'UNCONFIRMED';
    if (!targetingApplied(params.targeting, readBack.targeting)) return 'MISMATCH';
    // A full replacement that leaves out a list (e.g. drops all exclusions) must remove it.
    for (const key of REMOVABLE_TARGETING_LISTS) {
      if (params.targeting[key] === undefined && Array.isArray(readBack.targeting[key]) && readBack.targeting[key].length) return 'MISMATCH';
    }
  }
  return 'CONFIRMED';
}

/**
 * Meta enriches targeting on read (names, defaults, automation flags), so objects are checked
 * by containment: every key sent must be present in what Meta reports. Lists must match
 * exactly as sets (Meta does not add list items): objects by `id`/`key` when they have one,
 * primitives by value. An empty list (or null) sent means "none", matched by an absent field.
 */
export function targetingApplied(sent: any, got: any): boolean {
  if (sent === null || (Array.isArray(sent) && sent.length === 0)) {
    return got === undefined || got === null || (Array.isArray(got) && got.length === 0);
  }
  if (Array.isArray(sent)) {
    if (!Array.isArray(got) || got.length !== sent.length) return false;
    return sent.every((item) => {
      if (item && typeof item === 'object') {
        const k = item.id !== undefined ? 'id' : item.key !== undefined ? 'key' : null;
        const match = k ? got.find((g: any) => g && String(g[k]) === String(item[k])) : undefined;
        return k ? match !== undefined && targetingApplied(item, match) : got.some((g: any) => targetingApplied(item, g));
      }
      return got.map(String).includes(String(item));
    });
  }
  if (sent && typeof sent === 'object') {
    if (!got || typeof got !== 'object') return false;
    return Object.keys(sent).every((k) => sent[k] === undefined || targetingApplied(sent[k], got[k]));
  }
  return got !== undefined && got !== null && String(got) === String(sent);
}
