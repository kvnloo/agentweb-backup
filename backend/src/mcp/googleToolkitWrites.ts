/**
 * ENG-2823 — guarded Google Ads writes for external Zoma agents (provider #2 of the
 * ENG-2303 guarded-write flow; Meta's is metaToolkitWrites.ts).
 *
 * Allowed: BUDGET CREATE/UPDATE (amount), CAMPAIGN CREATE / UPDATE status, AD_GROUP CREATE /
 * UPDATE status. Everything else stays refused by googleToolkitManifest.assertGoogleToolkitCall.
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
import { assertZomaWriteReady, ZomaNotReadyError } from './zomaOnboarding';
import {
  consumePreviewToken, previewFingerprint, previewResponse, previewTokenMatches, type WriteVerification,
} from './zomaWriteGuard';

export type GoogleReadKind = 'budget' | 'campaign' | 'ad_group';

export interface GoogleBudgetState { resourceName: string; name?: string; amountMicros: number; explicitlyShared: boolean; referenceCount: number; status?: string }
export interface GoogleCampaignState { resourceName: string; name?: string; status: string; budget?: string }
export interface GoogleAdGroupState { resourceName: string; name?: string; status: string; campaign?: string }

export interface GoogleToolkitWriteDeps {
  assertReady: (userId: string) => Promise<void>;
  read: (userId: string, customerId: string, kind: GoogleReadKind, resourceName: string) => Promise<any | null>;
  /** The call_google_ads_api handler Emma registers (emma/googleAdsTools.ts). */
  dispatch: (userId: string, args: Record<string, unknown>) => Promise<any>;
  spendCeilingPolicy: () => MetaSpendCeilingPolicy | null;
  secret: () => string;
  now: () => number;
  consumedTokens: Map<string, number>;
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

const RESOURCE: Record<GoogleReadKind, string> = { budget: 'campaignBudgets', campaign: 'campaigns', ad_group: 'adGroups' };
const GAQL: Record<GoogleReadKind, string> = {
  budget: 'SELECT campaign_budget.resource_name, campaign_budget.name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count, campaign_budget.status FROM campaign_budget WHERE campaign_budget.resource_name = ',
  campaign: 'SELECT campaign.resource_name, campaign.name, campaign.status, campaign.campaign_budget FROM campaign WHERE campaign.resource_name = ',
  ad_group: 'SELECT ad_group.resource_name, ad_group.name, ad_group.status, ad_group.campaign FROM ad_group WHERE ad_group.resource_name = ',
};

/** Resource names are only accepted inside the resolved customer (also keeps GAQL injection-free). */
export function isCustomerResource(customerId: string, kind: GoogleReadKind, value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^customers/${customerId}/${RESOURCE[kind]}/\\d+$`).test(value);
}

export function mapGoogleReadRow(kind: GoogleReadKind, row: any): any | null {
  if (!row) return null;
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
    return c?.resourceName ? ({ resourceName: c.resourceName, name: c.name, status: c.status, budget: c.campaignBudget } as GoogleCampaignState) : null;
  }
  const g = row.adGroup;
  return g?.resourceName ? ({ resourceName: g.resourceName, name: g.name, status: g.status, campaign: g.campaign } as GoogleAdGroupState) : null;
}

// Loaded lazily: the Google service stack is not imported unless a Google write runs.
const defaultDeps: GoogleToolkitWriteDeps = {
  assertReady: (userId) => assertZomaWriteReady(userId, undefined, 'google_ads'),
  read: async (userId, customerId, kind, resourceName) => {
    if (!isCustomerResource(customerId, kind, resourceName)) return null;
    const { googleAdsService } = await import('../services/googleAdsService');
    const rows = await googleAdsService.queryReporting(userId, customerId, `${GAQL[kind]}'${resourceName}'`);
    return rows.length === 1 ? mapGoogleReadRow(kind, rows[0]) : null;
  },
  dispatch: async (userId, args) => (await import('../emma/googleAdsTools')).callGoogleAdsApiTool.execute(args, { userId }),
  spendCeilingPolicy: () => googleSpendCeilingPolicyFromEnv(),
  secret: () => getJwtSecret(),
  now: () => Date.now(),
  consumedTokens: new Map(),
};

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

interface ValidatedWrite {
  /** Exactly what call_google_ads_api receives (internal micros field names). */
  dispatchArgs: Record<string, unknown>;
  target?: { kind: GoogleReadKind; resourceName: string };
  budgetMicros?: number;
  expectedStatus?: 'ENABLED' | 'PAUSED';
}

const COMMON = ['customer_id', 'entity_type', 'action'];
const ALLOWED: Record<string, string[]> = {
  'BUDGET CREATE': ['name', 'amount', 'explicitly_shared'],
  'BUDGET UPDATE': ['budget_resource_name', 'amount'],
  'CAMPAIGN CREATE': ['name', 'type', 'budget_resource_name', 'bidding_strategy', 'bidding_strategy_resource_name', 'bidding_strategy_target', 'cpc_bid_ceiling', 'location_target_ids', 'status'],
  'CAMPAIGN UPDATE': ['campaign_resource_name', 'status'],
  'AD_GROUP CREATE': ['name', 'campaign_resource_name', 'type', 'cpc_bid', 'status'],
  'AD_GROUP UPDATE': ['ad_group_resource_name', 'status'],
};
const MICROS_HINT: Record<string, string> = { amount_micros: 'amount', cpc_bid_micros: 'cpc_bid', cpc_bid_ceiling_micros: 'cpc_bid_ceiling' };

const nonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

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
      throw new MetaToolkitRefusal('New campaigns and ad groups are always created PAUSED. Create it paused first, then enable it with a separate UPDATE status=ENABLED preview and approval.');
    }
  };
  const statusOnly = (kind: GoogleReadKind, field: string): ValidatedWrite => {
    const rn = resource(kind, field);
    need(args.status === 'ENABLED' || args.status === 'PAUSED', 'status must be ENABLED or PAUSED.');
    return { dispatchArgs: { ...base, [field]: rn, status: args.status }, target: { kind, resourceName: rn }, expectedStatus: args.status };
  };

  switch (op) {
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
      need(['SEARCH', 'DISPLAY', 'PERFORMANCE_MAX'].includes(args.type), 'type must be SEARCH, DISPLAY or PERFORMANCE_MAX.');
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
        },
        expectedStatus: 'PAUSED',
      };
    }
    case 'CAMPAIGN UPDATE':
      return statusOnly('campaign', 'campaign_resource_name');
    case 'AD_GROUP CREATE': {
      createdPaused();
      need(nonBlank(args.name), 'AD_GROUP CREATE requires name.');
      need(['SEARCH_STANDARD', 'DISPLAY_STANDARD'].includes(args.type), 'type must be SEARCH_STANDARD or DISPLAY_STANDARD.');
      const campaign = resource('campaign', 'campaign_resource_name');
      return {
        dispatchArgs: {
          ...base, name: args.name, campaign_resource_name: campaign, type: args.type,
          cpc_bid_micros: args.cpc_bid === undefined ? undefined : positiveMicros(args.cpc_bid, currency, 'cpc_bid'), status: 'PAUSED',
        },
        expectedStatus: 'PAUSED',
      };
    }
    default:
      return statusOnly('ad_group', 'ad_group_resource_name');
  }
}

function createdResourceName(entity: string, result: any): string | undefined {
  return entity === 'BUDGET' ? result?.budgetResourceName : entity === 'CAMPAIGN' ? result?.campaignResourceName : result?.adGroupResourceName;
}

function verify(validated: ValidatedWrite, entity: string, readBack: any | null): WriteVerification {
  if (!readBack) return 'UNCONFIRMED';
  if (entity === 'BUDGET') {
    if (!Number.isFinite(readBack.amountMicros)) return 'UNCONFIRMED';
    if (readBack.amountMicros !== validated.budgetMicros) return 'MISMATCH';
    const shared = validated.dispatchArgs.explicitly_shared;
    if (shared !== undefined && readBack.explicitlyShared !== shared) return 'MISMATCH';
    return 'CONFIRMED';
  }
  return readBack.status === validated.expectedStatus ? 'CONFIRMED' : 'MISMATCH';
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

const refuseNotFound = (what: string, rn: string) => {
  throw new MetaToolkitRefusal(`${what} ${rn} was not found in this Google Ads account. Nothing was sent.`);
};

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

  // State the preview describes (and the token is bound to).
  const lines: string[] = ['PREVIEW — nothing has changed yet.'];
  let state: Record<string, unknown> = {};
  const money = (micros: number) => `${formatMicros(micros, currency)}/day (= ${micros} micros)`;
  const sharedNote = (b: GoogleBudgetState) => (b.explicitlyShared
    ? `This is a SHARED budget: it caps the combined spend of all ${b.referenceCount} campaign(s) attached to it.`
    : '');
  const op = `${entity} ${action}`;
  let enableBudgetMicros: number | undefined;

  if (op === 'BUDGET CREATE') {
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
    lines.push(`Bidding: ${args.bidding_strategy ?? args.bidding_strategy_resource_name}${args.bidding_strategy_target !== undefined ? ` (target ${args.bidding_strategy_target})` : ''}.`);
  } else if (op === 'AD_GROUP CREATE') {
    const campaign: GoogleCampaignState | null = await deps.read(userId, cid, 'campaign', String(validated.dispatchArgs.campaign_resource_name));
    if (!campaign) refuseNotFound('Campaign', String(validated.dispatchArgs.campaign_resource_name));
    state = { campaign };
    const bid = validated.dispatchArgs.cpc_bid_micros as number | undefined;
    lines.push(`Create ${args.type} ad group "${args.name}" in campaign "${campaign!.name ?? campaign!.resourceName}" (campaign is ${campaign!.status})${bid !== undefined ? `, max CPC ${formatMicros(bid, currency)} (= ${bid} micros)` : ''}.`);
  } else {
    const kind = validated.target!.kind;
    const prior: GoogleCampaignState | GoogleAdGroupState | null = await deps.read(userId, cid, kind, validated.target!.resourceName);
    if (!prior) refuseNotFound(kind === 'campaign' ? 'Campaign' : 'Ad group', validated.target!.resourceName);
    state = { prior };
    lines.push(`${kind === 'campaign' ? 'Campaign' : 'Ad group'} "${prior!.name ?? prior!.resourceName}": ${prior!.status} → ${validated.expectedStatus}.`);
    // Enabling a campaign starts spend at its budget, so the preview names that budget and
    // the ceiling applies to it — otherwise a budget set above the ceiling outside Zoma
    // (or before the ceiling existed) could be switched on here (Hardening, ENG-2823).
    let campaign = kind === 'campaign' ? prior as GoogleCampaignState : null;
    if (kind === 'ad_group' && validated.expectedStatus === 'ENABLED') {
      const campaignName = (prior as GoogleAdGroupState).campaign;
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
  }
  lines.push(action === 'CREATE'
    ? 'Status: PAUSED — new campaigns and ad groups are always created paused; enabling is a separate preview and approval.'
    : validated.expectedStatus === 'ENABLED'
      ? 'Status: ENABLED — this can start delivery and spending as soon as Google applies it.'
      : validated.expectedStatus === 'PAUSED' ? 'Status: PAUSED — stops delivery.' : 'Status: unchanged.');

  const policy = deps.spendCeilingPolicy();
  if (policy && validated.budgetMicros !== undefined) {
    const prior = (state.prior as GoogleBudgetState | undefined)?.amountMicros;
    const verdict = evaluateMetaSpendCeiling(policy, { field: 'daily_budget', proposed: validated.budgetMicros, prior });
    if (!verdict.allowed) throw new MetaToolkitRefusal(verdict.message.replace('(minor units)', '(micros)'));
  }
  if (policy && (op === 'CAMPAIGN UPDATE' || op === 'AD_GROUP UPDATE') && validated.expectedStatus === 'ENABLED') {
    // Fail closed: a ceiling that cannot see the campaign's budget never allows enabling it.
    const verdict = evaluateMetaSpendCeiling(policy, { field: 'daily_budget', proposed: enableBudgetMicros });
    if (!verdict.allowed) {
      throw new MetaToolkitRefusal(`Enabling this ${entity === 'AD_GROUP' ? 'ad group' : 'campaign'} would start spend at its budget. ${verdict.message.replace('(minor units)', '(micros)')}`);
    }
  }

  const fingerprint = previewFingerprint({ platform: 'google_ads', userId, args: validated.dispatchArgs, state, currency });
  const now = deps.now();
  const secret = deps.secret();
  const freshPreview = () => previewResponse({ secret, userId, now, fingerprint, preview: lines.join('\n') });

  if (confirm !== true) return freshPreview();

  if (!previewTokenMatches(previewToken, secret, userId, fingerprint, now)) {
    return {
      ...freshPreview(),
      status: 'PREVIEW_MISMATCH',
      note: 'The confirmation did not match a current preview (missing, expired, or the arguments or Google Ads state changed). Nothing was sent. Show this new preview and get approval again.',
    };
  }
  if (!consumePreviewToken(deps.consumedTokens, previewToken, now)) {
    throw new MetaToolkitRefusal('This preview_token was already used. Run a new preview for another change.');
  }

  // A throw after the token was consumed is treated like a transport failure: outcome unknown.
  const result = await deps.dispatch(userId, validated.dispatchArgs)
    .catch((error: unknown) => ({ success: false, error: error instanceof Error ? error.message : String(error) }));
  if (result?.success === false && result?.errorType === 'unsupported_field') {
    // ENG-592: Google accepted the mutate but read-back shows it unchanged. Never success.
    return {
      success: false, verification: 'MISMATCH' as WriteVerification, id: validated.target?.resourceName ?? null,
      message: String(result.error ?? 'Google accepted the change but read-back shows it did not apply.'),
    };
  }
  if (result?.success !== true && outcomeUnknown(result)) {
    // The request may have reached Google and been applied (e.g. a timeout after Google
    // committed). "Did not apply" here invites a retry that double-applies a CREATE, so this
    // is UNCONFIRMED, metered as a write, with the current state read back when we can.
    const readBack = validated.target ? await deps.read(userId, cid, validated.target.kind, validated.target.resourceName).catch(() => null) : null;
    return {
      success: false,
      verification: 'UNCONFIRMED' as WriteVerification,
      id: validated.target?.resourceName ?? null,
      status: readBack?.status ?? null,
      ...(readBack?.amountMicros !== undefined ? { amount_micros: readBack.amountMicros, amount: formatMicros(readBack.amountMicros, currency) } : {}),
      message: `UNCONFIRMED: the ${action} ${entity} request failed without a definite answer from Google Ads (${String(result?.error ?? 'unknown error')}), so it may or may not have been applied. `
        + (action === 'CREATE'
          ? `Do not retry blindly — list the ${entity === 'AD_GROUP' ? 'ad groups' : `${entity.toLowerCase()}s`} first to check whether "${String(args.name)}" was created.`
          : `Do not retry blindly — check the current ${entity} state first${readBack ? ' (read back above)' : ''}.`),
    };
  }
  if (!result?.success || result?.blocked || result?.awaitingUserConfirmation) {
    return {
      status: 'FAILED', success: false,
      message: String(result?.error || result?.message || 'Google Ads did not apply the change.'),
      ...(result?.blocked ? { blocked: true, reason: result.reason } : {}),
    };
  }

  const id = action === 'CREATE' ? createdResourceName(entity, result) : validated.target!.resourceName;
  const kind: GoogleReadKind = entity === 'BUDGET' ? 'budget' : entity === 'CAMPAIGN' ? 'campaign' : 'ad_group';
  const readBack = id ? await deps.read(userId, cid, kind, id).catch(() => null) : null;
  const verification = verify(validated, entity, readBack);
  const base = {
    success: verification === 'CONFIRMED',
    verification,
    id: id ?? null,
    status: readBack?.status ?? null,
    ...(readBack?.amountMicros !== undefined ? { amount_micros: readBack.amountMicros, amount: formatMicros(readBack.amountMicros, currency) } : {}),
    ...(result.trackingWarning ? { tracking_warning: result.trackingWarning } : {}),
    ...(result.pausedChildEntitiesWarning ? { paused_children_warning: result.pausedChildEntitiesWarning } : {}),
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
