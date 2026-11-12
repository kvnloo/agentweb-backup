/**
 * ENG-2914 — Zoma custom audiences for external MCP agents (`zoma_custom_audiences`).
 *
 *   Reads   LIST, GET (audience_id), LIST_AD_SETS (ad sets in the account that include or
 *           exclude audience_id).
 *   Writes  CREATE (source: customer_list | website | engagement | lookalike; external_provider
 *           is registered but refused, see metaToolkitAudienceSources.ts), UPDATE (name /
 *           description / rule), ADD_USERS / REMOVE_USERS (raw emails/phones, normalized and
 *           SHA-256 hashed server-side, batched at Meta's 10k-per-request cap), DELETE (refused
 *           while an active ad set uses it unless confirm_in_use=true), and EXCLUDE_CUSTOMERS
 *           (one call: create/reuse a customer-list audience and add it to
 *           excluded_custom_audiences on the given ad sets).
 *
 * Every write uses the same preview → confirm guard as CAMPAIGN/AD_SET/AD writes
 * (zomaWriteGuard: single-use HMAC token bound to the user, the exact arguments and the Meta
 * state the preview showed) behind the same write gate (payment method + usable Meta
 * connection + GRANTED ads_management). The ad-set targeting change in EXCLUDE_CUSTOMERS
 * goes through the shared toolkit preview + dispatchToolkitConfirmedMetaWrite path, exactly
 * like an approved AD_SET UPDATE. Nothing here creates or activates an ad, and nothing
 * here can raise spend.
 *
 * Every write is reported CONFIRMED / MISMATCH / UNCONFIRMED from a read-back, never from
 * Meta's acceptance alone. Ownership: audience and ad-set ids are global Meta nodes, so each
 * one is read and its account_id compared with the resolved ad account before use.
 *
 * PII: raw emails/phones are hashed in hashIdentifiers and dropped; this module never logs,
 * returns or persists them (only counts and hashes). No new persistence.
 */
import { getJwtSecret } from '../config/jwt';
import { getAccountsByUserIdIncludingOrgShared, type ConnectedAccount } from '../services/connectedAccountsDb';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { assertAdsManagementGranted } from './metaToolkitWrites';
import { assertZomaWriteReady, ZomaNotReadyError } from './zomaOnboarding';
import {
  consumeToken, defaultConsumedTokenStore, type ConsumedTokens, previewFingerprint, previewResponse, previewTokenMatches, type WriteVerification,
} from './zomaWriteGuard';
import {
  batches, buildAudienceSpec, hashIdentifiers, identifiersDigest, type HashedIdentifiers,
} from './metaToolkitAudienceSources';
import { AUDIENCE_READ_ACTIONS, AUDIENCE_TOOL_NAME, AUDIENCE_WRITE_ACTIONS } from './zomaToolDefinitions';

export type GraphMethod = 'GET' | 'POST' | 'DELETE';

export interface MetaToolkitAudienceDeps {
  assertReady: (userId: string) => Promise<void>;
  listAccounts: (userId: string) => Promise<ConnectedAccount[]>;
  /**
   * Meta Graph call with the caller's credentials for `accountId`. `{account}` in the path is
   * replaced by act_<id>. Throws an Error carrying `metaError` ({code, error_subcode, message,
   * error_user_msg}); never the access token.
   */
  graph: (userId: string, accountId: string, method: GraphMethod, path: string, params?: Record<string, any>) => Promise<any>;
  /** Add (or remove) one batch (≤10k) of already-hashed identifiers. */
  users: (
    userId: string, accountId: string, audienceId: string, schema: 'EMAIL' | 'PHONE', hashes: string[], remove: boolean,
  ) => Promise<{ success: boolean; message?: string; received?: number; invalid?: number }>;
  /** Shared sessionless gate for AD_SET UPDATE (never dispatches). */
  previewAdSetUpdate: (userId: string, accountId: string, adSetId: string, params: any) => Promise<any>;
  dispatch: (userId: string, dispatch: any) => Promise<{ result: any; createdId?: string }>;
  secret: () => string;
  now: () => number;
  consumedTokens: ConsumedTokens;
}

const ams = async () => (await import('../services/agentModeService')).agentModeService;

const defaultDeps: MetaToolkitAudienceDeps = {
  assertReady: (userId) => assertZomaWriteReady(userId),
  listAccounts: getAccountsByUserIdIncludingOrgShared,
  graph: async (userId, accountId, method, path, params) => (await ams()).toolkitMetaGraphRequest(userId, accountId, method, path, params),
  users: async (userId, accountId, audienceId, schema, hashes, remove) => {
    const r: any = await (await ams()).manageMetaCustomAudiences(
      userId, remove ? 'DELETE_USERS' : 'UPLOAD_USERS', accountId,
      { id: audienceId, schema: [schema], payload: hashes.map((h) => [h]) },
    );
    const received = r?.result?.num_received;
    const invalid = r?.result?.num_invalid_entries;
    return {
      success: !!r?.success, message: r?.message,
      ...(received !== undefined ? { received: Number(received) } : {}),
      ...(invalid !== undefined ? { invalid: Number(invalid) } : {}),
    };
  },
  previewAdSetUpdate: async (userId, accountId, adSetId, params) =>
    (await ams()).previewToolkitMetaWrite(userId, 'AD_SET', 'UPDATE', accountId, undefined, adSetId, undefined, params),
  dispatch: async (userId, d) => (await ams()).dispatchToolkitConfirmedMetaWrite(userId, d),
  secret: () => getJwtSecret(),
  now: () => Date.now(),
  consumedTokens: defaultConsumedTokenStore,
};

const AUDIENCE_FIELDS =
  'id,name,description,subtype,account_id,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,operation_status,lookalike_spec,rule,time_updated';
const AD_SET_FIELDS = 'id,name,account_id,status,effective_status,targeting';
const MAX_LIST_PAGES = 10;
const MAX_EXCLUDE_AD_SETS = 50;
const DEFAULT_EXCLUSION_NAME = 'Existing customers (Zoma)';
const FORBIDDEN_PARAMS = ['confirm', 'override_tracking_check', 'tracking_override_token', 'budget_confirmation_token'];

const normAccount = (v: unknown) => String(v ?? '').trim().replace(/^act_/, '');

interface Ctx {
  userId: string;
  accountId: string;
  deps: MetaToolkitAudienceDeps;
  confirm: unknown;
  previewToken: unknown;
}

function numericId(value: unknown, field: string): string {
  const id = String(value ?? '').trim();
  if (!/^\d+$/.test(id)) throw new MetaToolkitRefusal(`${field} must be a numeric Meta id.`);
  return id;
}

function metaErrorOf(error: any) {
  return error?.metaError ?? error?.response?.data?.error ?? null;
}

export function termsAcceptanceUrl(accountId: string): string {
  return `https://business.facebook.com/ads/manage/customaudiences/tos/?act=${normAccount(accountId)}`;
}

/** Meta's "Custom Audience Terms not accepted" error (subcode 1870090 or the terms wording). */
export function isTermsNotAccepted(errorOrMessage: unknown): boolean {
  const meta = typeof errorOrMessage === 'string' ? null : metaErrorOf(errorOrMessage);
  if (meta && Number(meta.error_subcode) === 1870090) return true;
  const text = typeof errorOrMessage === 'string'
    ? errorOrMessage
    : `${meta?.message ?? ''} ${meta?.error_user_msg ?? ''} ${(errorOrMessage as any)?.message ?? ''}`;
  return /terms/i.test(text) && /(custom audience|customer list|audience)/i.test(text);
}

function termsResult(accountId: string) {
  const url = termsAcceptanceUrl(accountId);
  return {
    success: false,
    status: 'TERMS_NOT_ACCEPTED',
    terms_url: url,
    message:
      `Meta requires the ad account's Custom Audience Terms to be accepted before custom audiences can be created or changed. ` +
      `Ask the user to open ${url} while logged into the Business that owns ad account act_${normAccount(accountId)}, accept the terms, then retry this exact request (it is a one-time step per ad account). Nothing was changed.`,
  };
}

function metaMessage(error: any): string {
  const meta = metaErrorOf(error);
  return String(meta?.error_user_msg || meta?.message || (error instanceof Error ? error.message : 'Meta request failed.'));
}

async function assertWriteGate(ctx: Ctx) {
  try {
    await ctx.deps.assertReady(ctx.userId);
  } catch (error) {
    if (error instanceof ZomaNotReadyError) throw new MetaToolkitRefusal(error.message);
    throw error;
  }
  assertAdsManagementGranted(await ctx.deps.listAccounts(ctx.userId), ctx.accountId);
}

/** Read an audience and prove it belongs to the resolved ad account. */
async function getOwnedAudience(ctx: Ctx, rawId: unknown, field = 'audience_id') {
  const id = numericId(rawId, field);
  let node: any;
  try {
    node = await ctx.deps.graph(ctx.userId, ctx.accountId, 'GET', id, { fields: AUDIENCE_FIELDS });
  } catch (error) {
    throw new MetaToolkitRefusal(`Could not read audience ${id}: ${metaMessage(error)}`);
  }
  if (!node?.id || normAccount(node.account_id) !== normAccount(ctx.accountId)) {
    throw new MetaToolkitRefusal(`Audience ${id} is not in the selected ad account act_${normAccount(ctx.accountId)}.`);
  }
  return node;
}

async function getOwnedAdSet(ctx: Ctx, id: string) {
  let node: any;
  try {
    node = await ctx.deps.graph(ctx.userId, ctx.accountId, 'GET', id, { fields: AD_SET_FIELDS });
  } catch (error) {
    throw new MetaToolkitRefusal(`Could not read ad set ${id}: ${metaMessage(error)}`);
  }
  if (!node?.id || normAccount(node.account_id) !== normAccount(ctx.accountId)) {
    throw new MetaToolkitRefusal(`Ad set ${id} is not in the selected ad account act_${normAccount(ctx.accountId)}.`);
  }
  return node;
}

async function listPaged(ctx: Ctx, path: string, fields: string) {
  const items: any[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await ctx.deps.graph(ctx.userId, ctx.accountId, 'GET', path, { fields, limit: 200, ...(after ? { after } : {}) });
    items.push(...(Array.isArray(res?.data) ? res.data : []));
    after = res?.paging?.next ? res?.paging?.cursors?.after : undefined;
    if (!after) return { items, truncated: false };
  }
  return { items, truncated: true };
}

const audienceIds = (list: unknown): string[] => (Array.isArray(list) ? list.map((a: any) => String(a?.id ?? '')).filter(Boolean) : []);
const isActive = (adSet: any) => adSet?.effective_status === 'ACTIVE' || adSet?.status === 'ACTIVE';

/** Ad sets in the account whose targeting includes or excludes the audience. */
async function adSetsUsing(ctx: Ctx, audienceId: string) {
  let listed;
  try {
    listed = await listPaged(ctx, '{account}/adsets', AD_SET_FIELDS);
  } catch (error) {
    throw new MetaToolkitRefusal(`Could not list ad sets: ${metaMessage(error)}`);
  }
  const adSets = listed.items.flatMap((a: any) => {
    const included = audienceIds(a?.targeting?.custom_audiences).includes(audienceId);
    const excluded = audienceIds(a?.targeting?.excluded_custom_audiences).includes(audienceId);
    if (!included && !excluded) return [];
    return [{ id: String(a.id), name: a.name ?? null, status: a.status ?? null, effective_status: a.effective_status ?? null, usage: included ? 'included' : 'excluded' }];
  });
  return { adSets, truncated: listed.truncated };
}

/** The preview → confirm guard shared by every audience write. */
async function guarded(ctx: Ctx, action: string, fingerprintData: Record<string, unknown>, lines: string[], apply: () => Promise<any>) {
  const fingerprint = previewFingerprint({
    userId: ctx.userId, tool: AUDIENCE_TOOL_NAME, action, accountId: normAccount(ctx.accountId), ...fingerprintData,
  });
  const now = ctx.deps.now();
  const secret = ctx.deps.secret();
  const preview = ['PREVIEW — nothing has changed yet.', ...lines].filter(Boolean).join('\n');
  const fresh = () => previewResponse({ secret, userId: ctx.userId, now, fingerprint, preview });
  if (ctx.confirm !== true) return fresh();
  if (!previewTokenMatches(ctx.previewToken, secret, ctx.userId, fingerprint, now)) {
    return {
      ...fresh(),
      status: 'PREVIEW_MISMATCH',
      note: 'The confirmation did not match a current preview (missing, expired, or the arguments or Meta state changed). Nothing was sent. Show this new preview and get approval again.',
    };
  }
  if (!(await consumeToken(ctx.deps.consumedTokens, ctx.previewToken as string, now))) {
    throw new MetaToolkitRefusal('This preview_token was already used. Run a new preview for another change.');
  }
  return apply();
}

function countLine(ids: HashedIdentifiers, verb: string): string {
  const total = ids.EMAIL.length + ids.PHONE.length;
  const skipped = [ids.invalid ? `${ids.invalid} invalid` : '', ids.duplicates ? `${ids.duplicates} duplicate` : ''].filter(Boolean).join(', ');
  return `${verb} ${total} hashed identifier(s) (${ids.EMAIL.length} email, ${ids.PHONE.length} phone)${skipped ? `; ${skipped} entr${ids.invalid + ids.duplicates === 1 ? 'y' : 'ies'} skipped` : ''}. Emails and phones are normalized and SHA-256 hashed by Zoma before anything is sent; raw values are never stored or logged.`;
}

function identifiersFrom(params: any, required: boolean): HashedIdentifiers | null {
  const given = params.emails !== undefined || params.phones !== undefined;
  if (!given) {
    if (required) throw new MetaToolkitRefusal('Provide params.emails and/or params.phones (arrays of strings).');
    return null;
  }
  const ids = hashIdentifiers(params.emails, params.phones);
  if (ids.EMAIL.length + ids.PHONE.length === 0) {
    throw new MetaToolkitRefusal('None of the supplied emails or phones were valid. Phones need the country code (e.g. 14155550123).');
  }
  return ids;
}

/** Send hashed identifiers in Meta-sized batches; verification from Meta's per-batch receipt counts. */
async function sendUsers(ctx: Ctx, audienceId: string, ids: HashedIdentifiers, remove: boolean) {
  const sent = ids.EMAIL.length + ids.PHONE.length;
  let received = 0;
  let invalid = 0;
  let countsKnown = true;
  for (const schema of ['EMAIL', 'PHONE'] as const) {
    for (const chunk of batches(ids[schema])) {
      const r = await ctx.deps.users(ctx.userId, ctx.accountId, audienceId, schema, chunk, remove);
      if (!r?.success) {
        if (isTermsNotAccepted(String(r?.message ?? ''))) return { terms: true as const, sent, received };
        return { failed: String(r?.message || 'Meta did not accept the identifiers.'), sent, received };
      }
      if (r.received === undefined || !Number.isFinite(r.received)) countsKnown = false;
      else received += r.received;
      if (r.invalid !== undefined && Number.isFinite(r.invalid)) invalid += r.invalid;
    }
  }
  // Meta counts rejected entries in num_received too, so received === sent alone is not success.
  const verification: WriteVerification = !countsKnown ? 'UNCONFIRMED' : received === sent && invalid === 0 ? 'CONFIRMED' : 'MISMATCH';
  return { verification, sent, received, invalid };
}

function usersMessage(remove: boolean, r: { verification: WriteVerification; sent: number; received: number; invalid?: number }, audienceId: string) {
  const verb = remove ? 'removal of' : 'upload of';
  if (r.verification === 'MISMATCH' && r.invalid) {
    return `Meta received ${r.received} of ${r.sent} hashed identifier(s) for audience ${audienceId} but rejected ${r.invalid} as invalid (check phone numbers include the country code). Check the list before retrying.`;
  }
  if (r.verification === 'CONFIRMED') return `Meta received the ${verb} all ${r.sent} hashed identifier(s) for audience ${audienceId}. Matching and size updates take Meta up to a few hours.`;
  if (r.verification === 'MISMATCH') return `Meta received ${r.received} of ${r.sent} hashed identifier(s) for audience ${audienceId}. Check the list before retrying.`;
  return `UNCONFIRMED: Meta accepted the ${verb} identifiers for audience ${audienceId} but did not report how many it received. Check the audience with GET before reporting this as done.`;
}

async function readAudienceState(ctx: Ctx, id: string) {
  return ctx.deps.graph(ctx.userId, ctx.accountId, 'GET', id, { fields: AUDIENCE_FIELDS }).catch(() => null);
}

function combine(verdicts: WriteVerification[]): WriteVerification {
  if (verdicts.includes('MISMATCH')) return 'MISMATCH';
  if (verdicts.includes('UNCONFIRMED')) return 'UNCONFIRMED';
  return 'CONFIRMED';
}

function audienceSummary(a: any) {
  return {
    id: a.id, name: a.name ?? null, subtype: a.subtype ?? null, description: a.description ?? null,
    approximate_count_lower_bound: a.approximate_count_lower_bound ?? null,
    approximate_count_upper_bound: a.approximate_count_upper_bound ?? null,
    delivery_status: a.delivery_status ?? null, operation_status: a.operation_status ?? null,
    ...(a.lookalike_spec ? { lookalike_spec: a.lookalike_spec } : {}),
    ...(a.rule ? { rule: a.rule } : {}),
  };
}

// ── actions ─────────────────────────────────────────────────────────────────────────

async function createAudience(ctx: Ctx, args: any, params: any) {
  const name = String(params.name ?? '').trim();
  if (!name || name.length > 200) throw new MetaToolkitRefusal('params.name is required (1-200 characters).');
  const description = params.description === undefined ? undefined : String(params.description).slice(0, 500);
  const spec = buildAudienceSpec(args.source);
  if (spec.type !== 'customer_list' && (params.emails !== undefined || params.phones !== undefined)) {
    throw new MetaToolkitRefusal('params.emails / params.phones are only for source.type customer_list.');
  }
  await assertWriteGate(ctx);
  const origin = spec.originAudienceId ? await getOwnedAudience(ctx, spec.originAudienceId, 'source.origin_audience_id') : null;
  const ids = spec.type === 'customer_list' ? identifiersFrom(params, false) : null;

  return guarded(ctx, 'CREATE', {
    name, description, createParams: spec.createParams, origin: origin?.id ?? null, ids: ids ? identifiersDigest(ids) : null,
  }, [
    `Create custom audience "${name}" in ad account act_${normAccount(ctx.accountId)}.`,
    spec.describe,
    origin ? `Source audience: "${origin.name}" (${origin.id}).` : '',
    ids ? countLine(ids, 'Initial members:') : '',
    'An audience cannot spend on its own; it only affects ad sets that target or exclude it.',
  ], async () => {
    let created: any;
    try {
      created = await ctx.deps.graph(ctx.userId, ctx.accountId, 'POST', '{account}/customaudiences', {
        ...spec.createParams, name, ...(description !== undefined ? { description } : {}),
      });
    } catch (error) {
      if (isTermsNotAccepted(error)) return termsResult(ctx.accountId);
      return { success: false, status: 'FAILED', message: `Meta did not create the audience: ${metaMessage(error)}` };
    }
    const id = created?.id ? String(created.id) : '';
    if (!id) return { success: false, status: 'FAILED', message: 'Meta returned no audience id.' };

    const verdicts: WriteVerification[] = [];
    let usersNote = '';
    if (ids) {
      const sent = await sendUsers(ctx, id, ids, false);
      if ('terms' in sent) return { ...termsResult(ctx.accountId), id, verification: 'MISMATCH' as const, message: `Audience ${id} was created but its members were not added: ${termsResult(ctx.accountId).message}` };
      if ('failed' in sent) {
        verdicts.push('MISMATCH');
        usersNote = ` Members were NOT added: ${sent.failed}`;
      } else {
        verdicts.push(sent.verification);
        usersNote = ` ${usersMessage(false, sent, id)}`;
      }
    }
    const read = await readAudienceState(ctx, id);
    verdicts.push(!read ? 'UNCONFIRMED' : String(read.name) === name && normAccount(read.account_id) === normAccount(ctx.accountId) ? 'CONFIRMED' : 'MISMATCH');
    const verification = combine(verdicts);
    return {
      success: verification === 'CONFIRMED',
      verification,
      id,
      audience_id: id,
      ...(read ? { audience: audienceSummary(read) } : {}),
      message: (verification === 'CONFIRMED'
        ? `Audience "${name}" (${id}) created and read back.`
        : verification === 'MISMATCH'
          ? `Audience ${id} was created, but not everything matches what was approved.`
          : `UNCONFIRMED: Meta returned audience ${id}, but the read-back could not confirm it. Check it with GET before using it.`) + usersNote,
    };
  });
}

function parseRule(raw: unknown): string {
  let rule: any = raw;
  if (typeof raw === 'string') {
    try {
      rule = JSON.parse(raw);
    } catch {
      throw new MetaToolkitRefusal('params.rule must be a JSON object (Meta audience rule with "inclusions").');
    }
  }
  if (!rule || typeof rule !== 'object' || Array.isArray(rule) || !rule.inclusions) {
    throw new MetaToolkitRefusal('params.rule must be a Meta audience rule object with "inclusions".');
  }
  return JSON.stringify(rule);
}

async function updateAudience(ctx: Ctx, args: any, params: any) {
  const allowed = ['name', 'description', 'rule'];
  const keys = Object.keys(params).filter((k) => params[k] !== undefined);
  const extra = keys.filter((k) => !allowed.includes(k));
  if (keys.length === 0 || extra.length) {
    throw new MetaToolkitRefusal(`UPDATE can change only: ${allowed.join(', ')}.${extra.length ? ` Not allowed: ${extra.join(', ')}. Use ADD_USERS / REMOVE_USERS for members.` : ''}`);
  }
  const change: Record<string, string> = {};
  if (params.name !== undefined) {
    change.name = String(params.name).trim();
    if (!change.name || change.name.length > 200) throw new MetaToolkitRefusal('params.name must be 1-200 characters.');
  }
  if (params.description !== undefined) change.description = String(params.description).slice(0, 500);
  if (params.rule !== undefined) change.rule = parseRule(params.rule);
  await assertWriteGate(ctx);
  const current = await getOwnedAudience(ctx, args.audience_id);
  if (change.rule && !current.rule) {
    throw new MetaToolkitRefusal(`Audience ${current.id} is not rule-based (${current.subtype ?? 'unknown type'}); only website and engagement audiences have a rule.`);
  }
  const diff = (field: string, before: unknown) => (change[field] === undefined ? '' : `${field}: ${JSON.stringify(before ?? null)} → ${field === 'rule' ? 'new rule ' : ''}${field === 'rule' ? change.rule : JSON.stringify(change[field])}`);
  return guarded(ctx, 'UPDATE', {
    audienceId: current.id, change, before: { name: current.name, description: current.description, rule: current.rule ?? null },
  }, [
    `Update audience "${current.name}" (${current.id}).`,
    diff('name', current.name), diff('description', current.description), diff('rule', current.rule),
  ], async () => {
    try {
      await ctx.deps.graph(ctx.userId, ctx.accountId, 'POST', String(current.id), change);
    } catch (error) {
      if (isTermsNotAccepted(error)) return termsResult(ctx.accountId);
      return { success: false, status: 'FAILED', message: `Meta did not update the audience: ${metaMessage(error)}` };
    }
    const read = await readAudienceState(ctx, String(current.id));
    let verification: WriteVerification = 'CONFIRMED';
    if (!read) verification = 'UNCONFIRMED';
    else if (change.name !== undefined && read.name !== change.name) verification = 'MISMATCH';
    else if (change.description !== undefined && (read.description ?? '') !== change.description) verification = 'MISMATCH';
    else if (change.rule !== undefined) verification = ruleVerification(change.rule, read.rule, current.rule);
    return {
      success: verification === 'CONFIRMED',
      verification,
      id: String(current.id),
      ...(read ? { audience: audienceSummary(read) } : {}),
      message: verification === 'CONFIRMED'
        ? `Audience ${current.id} updated and read back.`
        : verification === 'MISMATCH'
          ? `Meta accepted the update, but the read-back of audience ${current.id} does not match what was approved.`
          : `UNCONFIRMED: Meta accepted the update of audience ${current.id}, but the read-back could not confirm it.`,
    };
  });
}

/** Canonical JSON (sorted keys) of a rule given as a JSON string or object; null if unparseable. */
function canonicalRule(rule: unknown): string | null {
  let value: unknown = rule;
  if (typeof rule === 'string') {
    try { value = JSON.parse(rule); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value));
}

/** The read-back rule must be the approved rule; still the old rule is MISMATCH; anything else unproven. */
function ruleVerification(sent: unknown, got: unknown, before: unknown): WriteVerification {
  const want = canonicalRule(sent);
  const have = canonicalRule(got);
  if (!want || !have) return 'UNCONFIRMED';
  if (have === want) return 'CONFIRMED';
  return have === canonicalRule(before) ? 'MISMATCH' : 'UNCONFIRMED';
}

async function changeUsers(ctx: Ctx, args: any, params: any, remove: boolean) {
  const extra = Object.keys(params).filter((k) => !['emails', 'phones'].includes(k) && params[k] !== undefined);
  if (extra.length) throw new MetaToolkitRefusal(`${remove ? 'REMOVE_USERS' : 'ADD_USERS'} takes only params.emails and params.phones. Not allowed: ${extra.join(', ')}.`);
  const ids = identifiersFrom(params, true)!;
  await assertWriteGate(ctx);
  const audience = await getOwnedAudience(ctx, args.audience_id);
  if (String(audience.subtype ?? '').toUpperCase() !== 'CUSTOM') {
    throw new MetaToolkitRefusal(`Audience ${audience.id} is a ${audience.subtype ?? 'non-customer-list'} audience; members can only be ${remove ? 'removed from' : 'added to'} customer-list audiences.`);
  }
  return guarded(ctx, remove ? 'REMOVE_USERS' : 'ADD_USERS', { audienceId: audience.id, ids: identifiersDigest(ids) }, [
    `${remove ? 'Remove members from' : 'Add members to'} audience "${audience.name}" (${audience.id}).`,
    countLine(ids, remove ? 'Remove' : 'Add'),
  ], async () => {
    const sent = await sendUsers(ctx, String(audience.id), ids, remove);
    if ('terms' in sent) return termsResult(ctx.accountId);
    if ('failed' in sent) {
      return sent.received > 0
        ? { success: false, verification: 'MISMATCH' as const, id: String(audience.id), message: `Meta received ${sent.received} of ${sent.sent} identifier(s), then failed: ${sent.failed}` }
        : { success: false, status: 'FAILED', message: sent.failed };
    }
    return {
      success: sent.verification === 'CONFIRMED',
      verification: sent.verification,
      id: String(audience.id),
      identifiers_sent: sent.sent,
      identifiers_received: sent.received,
      ...(sent.invalid ? { identifiers_invalid: sent.invalid } : {}),
      message: usersMessage(remove, sent, String(audience.id)),
    };
  });
}

async function deleteAudience(ctx: Ctx, args: any) {
  await assertWriteGate(ctx);
  const audience = await getOwnedAudience(ctx, args.audience_id);
  const usage = await adSetsUsing(ctx, String(audience.id));
  const active = usage.adSets.filter(isActive);
  if (active.length && args.confirm_in_use !== true) {
    throw new MetaToolkitRefusal(
      `Audience "${audience.name}" (${audience.id}) is used by ${active.length} active ad set(s): ${active.map((a) => `${a.name ?? a.id} (${a.id}, ${a.usage})`).join('; ')}. ` +
      'Deleting it changes who those ad sets reach. Pause them or remove the audience from their targeting first, or, if the user explicitly wants this, repeat with confirm_in_use=true.',
    );
  }
  if (usage.truncated && args.confirm_in_use !== true) {
    throw new MetaToolkitRefusal('This ad account has too many ad sets to check them all for this audience. Repeat with confirm_in_use=true only if the user accepts deleting it without that check.');
  }
  return guarded(ctx, 'DELETE', { audienceId: audience.id, usage: usage.adSets.map((a) => `${a.id}:${a.usage}:${a.effective_status}`) }, [
    `DELETE audience "${audience.name}" (${audience.id}). This cannot be undone.`,
    usage.adSets.length
      ? `Used by ${usage.adSets.length} ad set(s): ${usage.adSets.map((a) => `${a.name ?? a.id} (${a.id}, ${a.usage}, ${a.effective_status ?? a.status})`).join('; ')}.`
      : 'No ad sets in this account use it.',
  ], async () => {
    try {
      await ctx.deps.graph(ctx.userId, ctx.accountId, 'DELETE', String(audience.id));
    } catch (error) {
      return { success: false, status: 'FAILED', message: `Meta did not delete the audience: ${metaMessage(error)}` };
    }
    let verification: WriteVerification;
    try {
      const still = await ctx.deps.graph(ctx.userId, ctx.accountId, 'GET', String(audience.id), { fields: 'id' });
      verification = still?.id ? 'MISMATCH' : 'UNCONFIRMED';
    } catch (error) {
      // Graph code 100 = the node no longer exists (deleted).
      verification = Number(metaErrorOf(error)?.code) === 100 ? 'CONFIRMED' : 'UNCONFIRMED';
    }
    return {
      success: verification === 'CONFIRMED',
      verification,
      id: String(audience.id),
      message: verification === 'CONFIRMED'
        ? `Audience ${audience.id} deleted; Meta no longer returns it.`
        : verification === 'MISMATCH'
          ? `Meta accepted the delete, but audience ${audience.id} still exists. Check it before doing anything else.`
          : `UNCONFIRMED: Meta accepted the delete of audience ${audience.id}, but the read-back could not confirm it.`,
    };
  });
}

async function excludeCustomers(ctx: Ctx, args: any, params: any) {
  const rawIds = Array.isArray(args.ad_set_ids) ? args.ad_set_ids : args.ad_set_id !== undefined ? [args.ad_set_id] : [];
  const adSetIds = [...new Set(rawIds.map((v: unknown) => numericId(v, 'ad_set_ids[]')))] as string[];
  if (adSetIds.length === 0 || adSetIds.length > MAX_EXCLUDE_AD_SETS) {
    throw new MetaToolkitRefusal(`ad_set_ids must list 1-${MAX_EXCLUDE_AD_SETS} ad set ids.`);
  }
  const extra = Object.keys(params).filter((k) => !['emails', 'phones', 'name'].includes(k) && params[k] !== undefined);
  if (extra.length) throw new MetaToolkitRefusal(`EXCLUDE_CUSTOMERS takes params.emails, params.phones and params.name only. Not allowed: ${extra.join(', ')}.`);
  const ids = identifiersFrom(params, args.audience_id === undefined);
  await assertWriteGate(ctx);

  // Resolve the audience: an existing one (owned), a reusable customer list with the same name, or a new one.
  let audience: { id: string; name: string; reuse: 'given' | 'by_name' | 'create' };
  if (args.audience_id !== undefined) {
    const a = await getOwnedAudience(ctx, args.audience_id);
    if (ids && String(a.subtype ?? '').toUpperCase() !== 'CUSTOM') {
      throw new MetaToolkitRefusal(`Audience ${a.id} is not a customer list, so emails/phones cannot be added to it. Omit audience_id to create a customer list.`);
    }
    audience = { id: String(a.id), name: String(a.name), reuse: 'given' };
  } else {
    const name = String(params.name ?? DEFAULT_EXCLUSION_NAME).trim();
    if (!name || name.length > 200) throw new MetaToolkitRefusal('params.name must be 1-200 characters.');
    let listed;
    try {
      listed = await listPaged(ctx, '{account}/customaudiences', 'id,name,subtype');
    } catch (error) {
      if (isTermsNotAccepted(error)) return termsResult(ctx.accountId);
      throw new MetaToolkitRefusal(`Could not list custom audiences: ${metaMessage(error)}`);
    }
    const match = listed.items.find((a: any) => String(a?.name) === name && String(a?.subtype ?? '').toUpperCase() === 'CUSTOM');
    audience = match ? { id: String(match.id), name, reuse: 'by_name' } : { id: '', name, reuse: 'create' };
  }

  const adSets = [];
  for (const id of adSetIds) adSets.push(await getOwnedAdSet(ctx, id));
  const plans = adSets.map((s: any) => {
    const targeting = s.targeting && typeof s.targeting === 'object' ? s.targeting : {};
    const excluded = audienceIds(targeting.excluded_custom_audiences);
    if (audience.id && audienceIds(targeting.custom_audiences).includes(audience.id)) {
      throw new MetaToolkitRefusal(`Ad set "${s.name}" (${s.id}) targets audience ${audience.id}; it cannot also exclude it. Remove it from that ad set's targeting first.`);
    }
    return { adSet: s, targeting, excluded, already: !!audience.id && excluded.includes(audience.id) };
  });
  const label = audience.id ? `${audience.id}` : '<new audience>';

  return guarded(ctx, 'EXCLUDE_CUSTOMERS', {
    audience: { id: audience.id, name: audience.name, reuse: audience.reuse },
    ids: ids ? identifiersDigest(ids) : null,
    adSets: plans.map((p) => ({ id: p.adSet.id, targeting: p.targeting })),
  }, [
    audience.reuse === 'create'
      ? `Create customer-list audience "${audience.name}".`
      : `Use ${audience.reuse === 'by_name' ? 'existing customer list' : 'audience'} "${audience.name}" (${audience.id}).`,
    ids ? countLine(ids, 'Add') : '',
    'Exclude it from these ad sets (targeting diff):',
    ...plans.map((p) => `- Ad set "${p.adSet.name}" (${p.adSet.id}, ${p.adSet.effective_status ?? p.adSet.status}): excluded_custom_audiences [${p.excluded.join(', ')}] → ${p.already ? 'unchanged (already excluded)' : `[${[...p.excluded, label].join(', ')}]`}`),
    'Nothing else about the ad sets changes; status and budget stay as they are.',
  ], async () => {
    const steps: Array<Record<string, unknown>> = [];
    const verdicts: WriteVerification[] = [];
    let audienceId = audience.id;
    if (!audienceId) {
      try {
        const created = await ctx.deps.graph(ctx.userId, ctx.accountId, 'POST', '{account}/customaudiences', {
          name: audience.name, subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY',
          description: 'Existing customers, excluded from prospecting (created by Zoma).',
        });
        audienceId = created?.id ? String(created.id) : '';
      } catch (error) {
        if (isTermsNotAccepted(error)) return termsResult(ctx.accountId);
        return { success: false, status: 'FAILED', message: `Meta did not create the audience; no ad set was changed: ${metaMessage(error)}` };
      }
      if (!audienceId) return { success: false, status: 'FAILED', message: 'Meta returned no audience id; no ad set was changed.' };
      steps.push({ step: 'create_audience', audience_id: audienceId, result: 'created' });
    }
    if (ids) {
      const sent = await sendUsers(ctx, audienceId, ids, false);
      if ('terms' in sent) return { ...termsResult(ctx.accountId), audience_id: audienceId };
      if ('failed' in sent) {
        return { success: false, verification: 'MISMATCH' as const, id: audienceId, audience_id: audienceId, steps, message: `Customer list ${audienceId} is ready but its members were not added (${sent.failed}); no ad set was changed.` };
      }
      verdicts.push(sent.verification);
      steps.push({ step: 'add_users', audience_id: audienceId, sent: sent.sent, received: sent.received, verification: sent.verification });
    }
    for (const plan of plans) {
      const adSetId = String(plan.adSet.id);
      if (plan.excluded.includes(audienceId)) {
        steps.push({ step: 'exclude', ad_set_id: adSetId, result: 'already_excluded', verification: 'CONFIRMED' });
        verdicts.push('CONFIRMED');
        continue;
      }
      const targeting = { ...plan.targeting, excluded_custom_audiences: [...plan.excluded, audienceId].map((id) => ({ id })) };
      const preview = await ctx.deps.previewAdSetUpdate(ctx.userId, ctx.accountId, adSetId, { targeting });
      if (!preview?.awaitingUserConfirmation || !preview.metaWriteDispatch) {
        steps.push({ step: 'exclude', ad_set_id: adSetId, result: 'not_sent', error: String(preview?.error || preview?.message || 'could not be prepared') });
        verdicts.push('MISMATCH');
        continue;
      }
      const { result } = await ctx.deps.dispatch(ctx.userId, preview.metaWriteDispatch);
      if (!result?.success || result?.blocked || result?.throttled) {
        steps.push({ step: 'exclude', ad_set_id: adSetId, result: 'failed', error: String(result?.error || result?.message || 'Meta did not apply it') });
        verdicts.push('MISMATCH');
        continue;
      }
      const read = await ctx.deps.graph(ctx.userId, ctx.accountId, 'GET', adSetId, { fields: AD_SET_FIELDS }).catch(() => null);
      const v: WriteVerification = !read
        ? 'UNCONFIRMED'
        : audienceIds(read?.targeting?.excluded_custom_audiences).includes(audienceId) ? 'CONFIRMED' : 'MISMATCH';
      steps.push({ step: 'exclude', ad_set_id: adSetId, result: 'applied', verification: v });
      verdicts.push(v);
    }
    const verification = combine(verdicts);
    return {
      success: verification === 'CONFIRMED',
      verification,
      id: audienceId,
      audience_id: audienceId,
      steps,
      message: verification === 'CONFIRMED'
        ? `Audience ${audienceId} is excluded from ${plans.length} ad set(s), confirmed by read-back.`
        : verification === 'MISMATCH'
          ? `Not every step matches what was approved; see steps. Check the listed ad sets before doing anything else.`
          : `UNCONFIRMED: Meta accepted the changes, but at least one read-back could not confirm them; see steps.`,
    };
  });
}

/**
 * Execute one zoma_custom_audiences call. `args.account_id` is already the resolved,
 * ownership-checked ad account (the gateway does that before calling here).
 */
export async function executeMetaToolkitAudience(userId: string, rawArgs: any, deps: MetaToolkitAudienceDeps = defaultDeps) {
  const { confirm, preview_token: previewToken, ...args } = rawArgs ?? {};
  const action = String(args.action ?? '');
  if (args.client_id !== undefined) throw new MetaToolkitRefusal('client_id is not available to external Meta Toolkit callers.');
  if (![...AUDIENCE_READ_ACTIONS, ...AUDIENCE_WRITE_ACTIONS].includes(action as any)) {
    throw new MetaToolkitRefusal(`action must be one of: ${[...AUDIENCE_READ_ACTIONS, ...AUDIENCE_WRITE_ACTIONS].join(', ')}.`);
  }
  const params = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? { ...args.params } : {};
  for (const key of FORBIDDEN_PARAMS) {
    if (params[key] !== undefined) throw new MetaToolkitRefusal(`params.${key} is not available to external Meta Toolkit callers. Use the top-level confirm + preview_token flow.`);
  }
  const ctx: Ctx = { userId, accountId: String(args.account_id ?? ''), deps, confirm, previewToken };

  switch (action) {
    case 'LIST': {
      try {
        const { items, truncated } = await listPaged(ctx, '{account}/customaudiences', 'id,name,subtype,description,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status');
        return {
          success: true,
          audiences: items.map(audienceSummary),
          truncated,
          message: `${items.length}${truncated ? '+' : ''} custom audience(s) in act_${normAccount(ctx.accountId)}${truncated ? ' (list truncated)' : ''}.`,
        };
      } catch (error) {
        if (isTermsNotAccepted(error)) return termsResult(ctx.accountId);
        throw new MetaToolkitRefusal(`Could not list custom audiences: ${metaMessage(error)}`);
      }
    }
    case 'GET':
      return { success: true, audience: audienceSummary(await getOwnedAudience(ctx, args.audience_id)) };
    case 'LIST_AD_SETS': {
      const audience = await getOwnedAudience(ctx, args.audience_id);
      const usage = await adSetsUsing(ctx, String(audience.id));
      return {
        success: true,
        audience_id: String(audience.id),
        ad_sets: usage.adSets,
        truncated: usage.truncated,
        message: `${usage.adSets.length} ad set(s) use audience ${audience.id} (${usage.adSets.filter(isActive).length} active)${usage.truncated ? '; ad set list truncated' : ''}.`,
      };
    }
    case 'CREATE':
      return createAudience(ctx, args, params);
    case 'UPDATE':
      return updateAudience(ctx, args, params);
    case 'ADD_USERS':
      return changeUsers(ctx, args, params, false);
    case 'REMOVE_USERS':
      return changeUsers(ctx, args, params, true);
    case 'DELETE':
      return deleteAudience(ctx, args);
    default:
      return excludeCustomers(ctx, args, params);
  }
}
