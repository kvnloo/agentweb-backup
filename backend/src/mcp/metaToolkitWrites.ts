/**
 * ENG-2303 P3 — guarded Meta writes for external MCP agents (lifts ENG-2268 D2 for a
 * narrow surface, per Harsha 2026-10-12).
 *
 * Allowed: CAMPAIGN / AD_SET / AD  CREATE, and UPDATE of status (ACTIVE|PAUSED) or budget.
 * Still excluded: DELETE, COPY_AD, RETAG_UTM, creatives, custom audiences/uploads, launch_*.
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
import crypto from 'crypto';
import { getJwtSecret } from '../config/jwt';
import { getAccountsByUserIdIncludingOrgShared, type ConnectedAccount } from '../services/connectedAccountsDb';
import { isMetaAdAccount } from '../services/metaTokenRefresh';
import { evaluateMetaSpendCeiling, type MetaSpendCeilingPolicy } from '../services/agentMode/metaSpendCeiling';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { GUARDED_WRITE_ACTIONS, GUARDED_WRITE_ENTITIES, isGuardedWriteRequest } from './metaToolkitWriteSurface';
import { adsManagementScopeState, assertZomaWriteReady, ZomaNotReadyError } from './zomaOnboarding';

export { GUARDED_WRITE_ENTITIES, GUARDED_WRITE_ACTIONS, isGuardedWriteRequest };
export const PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000;

const UPDATE_FIELDS: Record<string, string[]> = {
  CAMPAIGN: ['status', 'daily_budget', 'lifetime_budget', 'budget_amount'],
  AD_SET: ['status', 'daily_budget', 'lifetime_budget'],
  AD: ['status'],
};
const MONEY_FIELDS = ['budget_amount', 'daily_budget', 'lifetime_budget', 'bid_amount', 'spend_cap'];
const CEILING_FIELDS = ['daily_budget', 'lifetime_budget', 'spend_cap', 'bid_amount'] as const;
// Gate-only flags of the internal path; an external caller never supplies these.
const FORBIDDEN_PARAMS = ['confirm', 'override_tracking_check', 'tracking_override_token', 'budget_confirmation_token'];

export type WriteVerification = 'CONFIRMED' | 'MISMATCH' | 'UNCONFIRMED';

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
  spendCeilingPolicy: () => MetaSpendCeilingPolicy | null;
  secret: () => string;
  now: () => number;
  consumedTokens: Map<string, number>;
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
  spendCeilingPolicy: () => spendCeilingPolicyFromEnv(),
  secret: () => getJwtSecret(),
  now: () => Date.now(),
  consumedTokens: new Map(),
};

function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sign(secret: string, userId: string, exp: number, fingerprint: string): string {
  const mac = crypto.createHmac('sha256', secret).update(`zoma-preview:v1:${userId}:${exp}:${fingerprint}`).digest('base64url');
  return `v1.${exp}.${mac}`;
}

function tokenMatches(token: unknown, secret: string, userId: string, fingerprint: string, now: number): boolean {
  if (typeof token !== 'string') return false;
  const [version, expRaw] = token.split('.');
  const exp = Number(expRaw);
  if (version !== 'v1' || !Number.isSafeInteger(exp) || exp <= now) return false;
  const expected = Buffer.from(sign(secret, userId, exp, fingerprint));
  const given = Buffer.from(token);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function pruneConsumed(consumed: Map<string, number>, now: number) {
  for (const [token, exp] of consumed) if (exp <= now) consumed.delete(token);
}

function targetId(entity: string, args: any): string | undefined {
  return entity === 'CAMPAIGN' ? args.campaign_id : entity === 'AD_SET' ? args.ad_set_id : args.ad_id;
}

/** Shape checks that need no I/O. Returns the params to preview/dispatch. */
function validateWriteShape(entity: string, action: string, args: any): any {
  if (args.client_id !== undefined) throw new MetaToolkitRefusal('client_id is not available to external Meta Toolkit callers.');
  const params = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? { ...args.params } : {};
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
  return params;
}

function assertAdsManagementGranted(accounts: ConnectedAccount[], accountId: string) {
  const norm = (v: unknown) => String(v ?? '').trim().replace(/^act_/, '');
  const account = accounts.filter(isMetaAdAccount).find(
    (a) => norm((a.config as any)?.ad_account_id) === norm(accountId) || norm(a.account_id) === norm(accountId),
  );
  const state = account ? adsManagementScopeState(account) : 'missing';
  if (state === 'granted') return;
  throw new MetaToolkitRefusal(
    state === 'missing'
      ? 'This Meta connection was not granted the ads_management permission, so Zoma cannot change ads on it. Reconnect Meta (run zoma_status for the link) and approve ads management.'
      : 'Zoma cannot verify that this Meta connection was granted the ads_management permission. Reconnect Meta (run zoma_status for the link) so the granted permissions are recorded.',
  );
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
  assertAdsManagementGranted(await deps.listAccounts(userId), accountId);

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
  if (policy) {
    const id = targetId(entity, args);
    const prior = action === 'UPDATE' && id ? await deps.readBack(userId, accountId, entity, id).catch(() => null) : null;
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

  const fingerprint = crypto.createHash('sha256').update(stable({
    userId, entity, action, accountId,
    campaign_id: args.campaign_id, ad_set_id: args.ad_set_id, ad_id: args.ad_id, params,
    summary: preview.summary, budgetAnomaly: preview.budgetAnomaly ?? null, money: money.confirmation,
  })).digest('hex');
  const now = deps.now();
  const secret = deps.secret();
  const previewText = [
    'PREVIEW — nothing has changed yet.',
    String(preview.summary ?? `${action} ${entity}`),
    entity === 'CAMPAIGN' && action === 'CREATE' ? `Objective: ${params.objective} (cannot be changed after creation)` : '',
    money.confirmation ? `Money${money.confirmation}` : '',
    statusLine(action, params),
  ].filter(Boolean).join('\n');
  const freshPreview = () => {
    const exp = now + PREVIEW_TOKEN_TTL_MS;
    return {
      status: 'PREVIEW',
      success: false,
      preview: previewText,
      preview_token: sign(secret, userId, exp, fingerprint),
      expires_at: new Date(exp).toISOString(),
      next_step: 'Show this preview to the user. Only after they explicitly approve it, repeat this exact call with confirm=true and this preview_token (single use, 15 minutes).',
    };
  };

  if (confirm !== true) return freshPreview();

  pruneConsumed(deps.consumedTokens, now);
  if (!tokenMatches(previewToken, secret, userId, fingerprint, now)) {
    return {
      ...freshPreview(),
      status: 'PREVIEW_MISMATCH',
      note: 'The confirmation did not match a current preview (missing, expired, or the arguments or Meta state changed). Nothing was sent. Show this new preview and get approval again.',
    };
  }
  if (deps.consumedTokens.has(previewToken)) {
    throw new MetaToolkitRefusal('This preview_token was already used. Run a new preview for another change.');
  }
  deps.consumedTokens.set(previewToken, Number(String(previewToken).split('.')[1]));

  const { result, createdId } = await deps.dispatch(userId, preview.metaWriteDispatch);
  if (result?.coalesced) {
    return { status: 'NO_CHANGE', success: true, message: String(result.message ?? 'No change was needed.') };
  }
  if (result?.awaitingUserConfirmation) {
    return { status: 'NEEDS_NEW_PREVIEW', success: false, message: 'Meta state changed after approval; nothing was sent. Run the preview again.' };
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
}

function verify(action: string, params: any, minor: any, readBack: Record<string, any> | null): WriteVerification {
  if (!readBack) return 'UNCONFIRMED';
  const expectedStatus = action === 'CREATE' ? 'PAUSED' : params.status;
  if (expectedStatus !== undefined && readBack.status !== expectedStatus) return 'MISMATCH';
  for (const field of ['daily_budget', 'lifetime_budget'] as const) {
    if (minor?.[field] === undefined) continue;
    if (readBack[field] === undefined || readBack[field] === null) return 'UNCONFIRMED';
    if (Number(readBack[field]) !== Number(minor[field])) return 'MISMATCH';
  }
  return 'CONFIRMED';
}
