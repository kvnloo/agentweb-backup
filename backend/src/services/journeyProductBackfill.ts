/**
 * ENG-2906 PR2 — pure planning for the one-off product backfill
 * (scripts/eng2906-backfill-products.ts). No I/O here: the script reads the rows and this module
 * decides what each user's attribution would have been, and which conditional writes may apply.
 *
 * Inputs (shapes as written today):
 *   - Dev-AW-LoopEvents, loop `emma-mcp` (prod also uses the Dev- table): `mcp_*` rows with
 *     `subjectId` = userId, `ts` ISO string, `dimensions` { product?, authMethod, clientId,
 *     clientName, clientType, toolName, platform, ref }. Rows before ENG-2906 have no `product`.
 *   - AW-ZomaDeviceAuth: `device#…` (status approved|issued + userId + createdAt + ref?) and
 *     `token#…` (userId + createdAt) items.
 *
 * Classification of one event (first match wins):
 *   1. a tracked `dimensions.product` of zoma | emma_mcp
 *   2. zoma: authMethod zoma_token, a Zoma client (id/name contains "zoma"), a `zoma_` tool, a
 *      tool name that only the Meta/Google toolkit manifest exposes (names Emma /mcp also
 *      registers, e.g. call_meta_marketing_api, are NOT evidence), or the `platform` dimension
 *      exactly as only the toolkit gateway writes it (mcp_tool_used / mcp_write_executed with
 *      platform meta | google_ads; Emma /mcp never sets platform, so any other shape is not evidence)
 *   3. an OAuth authorized/token-issued row with no tracked product (the shared OAuth server did
 *      not record the resource before ENG-2906) takes the product of the same client's tool
 *      use, and is dropped as unresolved when that client never used a tool
 *   4. otherwise emma_mcp (connection attempts and tool use are only recorded by /mcp)
 *
 * Per user: products.<p> { firstAt, lastAt } from the evidence; the signup guess is the product
 * of the earliest evidence within 1 h of createdAt, or emma_web when there is no MCP/Zoma
 * evidence at all; zomaStage is the furthest of connected < first_read < first_write (an
 * approved device or an issued token is connected). Everything written is
 * `attributionConfidence: inferred`.
 *
 * Write safety (buildBackfillUpdates): a row whose attributionConfidence is anything but absent or
 * `inferred` (tracked, verified, or an unrecognised value) gets NO write at all. Every UpdateItem
 * asserts attribute_exists(email) AND (attributionConfidence absent OR inferred), so a tracked or
 * verified value that appears after the read also makes the write fail; every SET is
 * if_not_exists and stamps attributionConfidence = if_not_exists(inferred), so a row that only
 * gains products/stage still shows as inferred. Signup fields additionally require no
 * signupProduct / signupPath; a product key, zomaStage/zomaStageAt and each milestone only when
 * absent. signupPath is deliberately not guessed.
 */
import type AWS from 'aws-sdk';
import { validateRef, type KnownProduct, type ZomaStage } from './journeyAttribution';

export const SIGNUP_WINDOW_MS = 3600 * 1000;
export const RECENT_WINDOW_MS = 30 * 24 * 3600 * 1000;

type BackfillStage = Extract<ZomaStage, 'connected' | 'first_read' | 'first_write'>;
type McpProduct = Extract<KnownProduct, 'zoma' | 'emma_mcp'>;

export interface ProductSpan {
  firstAt: string;
  lastAt: string;
}

export interface BackfillUser {
  email: string;
  userId: string;
  createdAt?: string;
  lastActiveAt?: string;
  lastLoginTime?: string;
  signupProduct?: string;
  signupPath?: string;
  attributionConfidence?: string;
  products?: Record<string, unknown>;
  isAdmin?: unknown;
  zomaStage?: string;
  zomaStageAt?: string;
  zomaFirstReadAt?: string;
  zomaFirstWriteAt?: string;
}

export interface ZomaDeviceEvidence {
  deviceAt?: string;
  tokenAt?: string;
  ref?: string;
}

export interface ClassifiedEvent {
  product: McpProduct;
  reason: string;
  eventType: string;
  ts: string;
  ms: number;
  client?: string;
  clientId?: string;
  ref?: string;
  /** Untracked OAuth lifecycle event: the shared OAuth server did not record the resource. */
  ambiguous?: boolean;
}

export interface BackfillPlan {
  email: string;
  userId: string;
  createdAt?: string;
  signupProduct?: KnownProduct;
  signupClient?: string;
  signupRef?: string;
  attributionConfidence: 'inferred';
  products: Partial<Record<KnownProduct, ProductSpan>>;
  zomaStage?: BackfillStage;
  zomaStageAt?: string;
  zomaFirstReadAt?: string;
  zomaFirstWriteAt?: string;
  evidence: string[];
  last30dToolCalls: number;
  /** internal | test when the account is ours or a fixture; review before --apply. */
  accountFlag?: AccountFlag;
}

export type AccountFlag = 'internal' | 'test';

const INTERNAL_DOMAINS = new Set(['agentweb.pro', 'hireemma.ai', 'usethread.io', 'argusoft.com']);
const TEST_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'test.com', 'mailinator.com']);
const TEST_LOCAL = /(^|[._+-])(test|qa|demo|fixture|e2e|smoke)([._+-]|\d|$)|^eng\d+[-_]/i;

/** Internal (our domains or an admin row) or test/fixture account; undefined for a real customer. */
export function accountFlag(email: string, isAdmin?: unknown): AccountFlag | undefined {
  const [local = '', domain = ''] = email.toLowerCase().split('@');
  if (INTERNAL_DOMAINS.has(domain) || domain.endsWith('.agentweb.pro') || isAdmin === true) return 'internal';
  if (TEST_DOMAINS.has(domain) || domain.endsWith('.test') || domain.endsWith('.invalid') || TEST_LOCAL.test(local)) return 'test';
  return undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const parseMs = (v: unknown): number | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : ms;
};

/** The only (eventType, platform) pairs the toolkit gateway writes; Emma /mcp writes no platform. */
const GATEWAY_PLATFORM_EVENTS = new Set(['mcp_tool_used', 'mcp_write_executed']);
const GATEWAY_PLATFORMS = new Set(['meta', 'google_ads']);

/** Written by the shared OAuth server for both /mcp and the Meta Toolkit; product only since ENG-2906. */
const OAUTH_LIFECYCLE_EVENTS = new Set(['mcp_oauth_authorized', 'mcp_oauth_token_issued']);

export function classifyMcpEvent(row: Record<string, unknown>, toolkitOnlyNames: ReadonlySet<string>): ClassifiedEvent | null {
  const eventType = str(row.eventType);
  const subjectId = str(row.subjectId);
  const ts = str(row.ts);
  const ms = parseMs(ts);
  if (!eventType?.startsWith('mcp_') || !subjectId || subjectId.startsWith('client:') || !ts || ms === undefined) return null;
  const raw = row.dimensions && typeof row.dimensions === 'object' && !Array.isArray(row.dimensions) ? (row.dimensions as Record<string, unknown>) : {};
  const d = (k: string) => str(raw[k]);
  const base = { eventType, ts, ms, client: d('clientType') ?? d('clientName'), clientId: d('clientId'), ref: validateRef(d('ref')) };
  const tracked = d('product');
  if (tracked === 'zoma' || tracked === 'emma_mcp') return { ...base, product: tracked, reason: `tracked:${tracked}` };
  const tool = d('toolName');
  const zomaClient = [d('clientId'), d('clientName')].some((v) => v && /zoma/i.test(v));
  const zomaReason =
    d('authMethod') === 'zoma_token' ? 'zoma_token'
    : zomaClient ? 'zoma_client'
    : tool?.startsWith('zoma_') ? 'zoma_tool'
    : tool && toolkitOnlyNames.has(tool) ? 'toolkit_tool'
    : GATEWAY_PLATFORM_EVENTS.has(eventType) && GATEWAY_PLATFORMS.has(d('platform') ?? '') ? 'toolkit_platform'
    : undefined;
  if (zomaReason) return { ...base, product: 'zoma', reason: zomaReason };
  if (OAUTH_LIFECYCLE_EVENTS.has(eventType)) return { ...base, product: 'emma_mcp', reason: 'oauth', ambiguous: true };
  return { ...base, product: 'emma_mcp', reason: `mcp:${d('authMethod') ?? 'unknown'}` };
}

/** Earliest approved/issued device and earliest token per user. Pending/denied devices are not evidence. */
export function zomaDeviceEvidence(rows: Array<Record<string, unknown>>): Map<string, ZomaDeviceEvidence> {
  const out = new Map<string, ZomaDeviceEvidence>();
  const earlier = (a: string | undefined, b: string) => (a === undefined || Date.parse(b) < Date.parse(a) ? b : a);
  for (const row of rows) {
    const pk = str(row.pk);
    const userId = str(row.userId);
    const createdAt = str(row.createdAt);
    if (!pk || !userId || !createdAt || parseMs(createdAt) === undefined) continue;
    const entry = out.get(userId) ?? {};
    if (pk.startsWith('token#')) {
      entry.tokenAt = earlier(entry.tokenAt, createdAt);
    } else if (pk.startsWith('device#') && (row.status === 'approved' || row.status === 'issued')) {
      const next = earlier(entry.deviceAt, createdAt);
      if (next !== entry.deviceAt) {
        entry.deviceAt = next;
        entry.ref = validateRef(row.ref);
      }
    } else {
      continue;
    }
    out.set(userId, entry);
  }
  return out;
}

const STAGE_ORDER: BackfillStage[] = ['connected', 'first_read', 'first_write'];

export function planUserBackfill(
  user: BackfillUser,
  rows: Array<Record<string, unknown>>,
  device: ZomaDeviceEvidence | undefined,
  opts: { now: Date; toolkitOnlyNames: ReadonlySet<string> },
): BackfillPlan {
  const classified = rows
    .filter((r) => r.subjectId === user.userId)
    .map((r) => classifyMcpEvent(r, opts.toolkitOnlyNames))
    .filter((e): e is ClassifiedEvent => !!e)
    .sort((a, b) => a.ms - b.ms);

  // An ambiguous OAuth event takes the product of its client's (unambiguous) tool use; a client
  // that never used a tool proves nothing about which product was connected, so it is dropped.
  const productByClient = new Map<string, McpProduct>();
  for (const e of classified) if (!e.ambiguous && e.clientId && !productByClient.has(e.clientId)) productByClient.set(e.clientId, e.product);
  let unresolved = 0;
  const events = classified.flatMap((e) => {
    if (!e.ambiguous) return [e];
    const product = e.clientId ? productByClient.get(e.clientId) : undefined;
    if (!product) {
      unresolved++;
      return [];
    }
    return [{ ...e, product, reason: 'oauth_client', ambiguous: false }];
  });

  // Device evidence joins the timeline as Zoma evidence (approval and token issue).
  const timeline: ClassifiedEvent[] = [...events];
  const deviceEvent = (ts: string | undefined, eventType: string, ref?: string) => {
    const ms = parseMs(ts);
    if (ts && ms !== undefined) timeline.push({ product: 'zoma', reason: eventType, eventType, ts, ms, client: 'zoma_device', ref });
  };
  deviceEvent(device?.deviceAt, 'device_approved', device?.ref);
  deviceEvent(device?.tokenAt, 'device_token');
  timeline.sort((a, b) => a.ms - b.ms);

  const products: Partial<Record<KnownProduct, ProductSpan>> = {};
  for (const e of timeline) {
    const span = products[e.product];
    if (!span) products[e.product] = { firstAt: e.ts, lastAt: e.ts };
    else span.lastAt = e.ts;
  }

  const plan: BackfillPlan = {
    email: user.email,
    userId: user.userId,
    createdAt: user.createdAt,
    attributionConfidence: 'inferred',
    products,
    evidence: [],
    accountFlag: accountFlag(user.email, user.isAdmin),
    last30dToolCalls: events.filter((e) => e.eventType === 'mcp_tool_used' && e.ms >= opts.now.getTime() - RECENT_WINDOW_MS).length,
  };

  const counts = new Map<string, number>();
  for (const e of timeline) counts.set(`${e.product}:${e.reason}`, (counts.get(`${e.product}:${e.reason}`) ?? 0) + 1);
  plan.evidence.push(...[...counts].map(([k, n]) => `${k}x${n}`));
  if (unresolved) plan.evidence.push(`unresolved_oauthx${unresolved}`);

  // Signup guess.
  const createdMs = parseMs(user.createdAt);
  if (timeline.length === 0) {
    if (createdMs !== undefined) {
      plan.signupProduct = 'emma_web';
      plan.signupClient = 'web';
      plan.products.emma_web = { firstAt: user.createdAt!, lastAt: str(user.lastActiveAt) ?? str(user.lastLoginTime) ?? user.createdAt! };
      plan.evidence.push('no_mcp:emma_web');
    } else {
      plan.evidence.push('no_mcp:no_createdAt');
    }
  } else if (createdMs !== undefined && Math.abs(timeline[0].ms - createdMs) <= SIGNUP_WINDOW_MS) {
    const first = timeline[0];
    plan.signupProduct = first.product;
    plan.signupClient = first.client;
    plan.signupRef = timeline.find((e) => e.product === first.product && e.ref && Math.abs(e.ms - createdMs) <= SIGNUP_WINDOW_MS)?.ref;
    plan.evidence.push(`signup:${first.product}@${Math.round((first.ms - createdMs) / 60000)}m`);
  } else {
    plan.evidence.push('signup:none_within_1h');
  }

  // Zoma stage (furthest reached) + write-once milestone timestamps.
  const zoma = events.filter((e) => e.product === 'zoma');
  const firstOf = (types: string[]) => zoma.find((e) => types.includes(e.eventType))?.ts;
  plan.zomaFirstWriteAt = firstOf(['mcp_write_executed']);
  plan.zomaFirstReadAt = firstOf(['mcp_tool_used', 'mcp_first_tool_used']);
  const connectedAt = [device?.deviceAt, device?.tokenAt, zoma[0]?.ts].filter((t): t is string => !!t).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const reached: Partial<Record<BackfillStage, string>> = { connected: connectedAt, first_read: plan.zomaFirstReadAt, first_write: plan.zomaFirstWriteAt };
  for (const stage of STAGE_ORDER) {
    if (reached[stage]) {
      plan.zomaStage = stage;
      plan.zomaStageAt = reached[stage];
    }
  }
  return plan;
}

const has = (v: unknown) => v !== undefined && v !== null && v !== '';

/** Rows the backfill may write: no attribution yet, or one it inferred itself. */
export const backfillMayWrite = (user: BackfillUser) => !has(user.attributionConfidence) || user.attributionConfidence === 'inferred';

/**
 * Conditional, never-overwriting UpdateItems for one user. Empty when nothing is missing or the
 * row carries a tracked/verified (or any non-inferred) attribution.
 */
export function buildBackfillUpdates(plan: BackfillPlan, user: BackfillUser, tableName: string): AWS.DynamoDB.DocumentClient.UpdateItemInput[] {
  if (!backfillMayWrite(user)) return [];
  const Key = { email: user.email };
  const updates: AWS.DynamoDB.DocumentClient.UpdateItemInput[] = [];
  // Every write: the row exists, its attribution is absent or inferred (never tracked/verified),
  // and every field is written only if absent — attributionConfidence included.
  const GUARD = 'attribute_exists(#email) AND (attribute_not_exists(#ac) OR #ac = :inferred)';
  const push = (sets: Record<string, { path: string; value: unknown }>, names: Record<string, string>, extraCondition?: string) => {
    const values: Record<string, unknown> = { ':inferred': plan.attributionConfidence };
    const exprs = Object.entries(sets).map(([k, { path, value }]) => {
      values[`:${k}`] = value;
      return `${path} = if_not_exists(${path}, :${k})`;
    });
    exprs.push('#ac = if_not_exists(#ac, :inferred)');
    updates.push({
      TableName: tableName,
      Key,
      UpdateExpression: `SET ${exprs.join(', ')}`,
      ConditionExpression: extraCondition ? `${GUARD} AND ${extraCondition}` : GUARD,
      ExpressionAttributeNames: { '#email': 'email', '#ac': 'attributionConfidence', ...names },
      ExpressionAttributeValues: values,
    });
  };

  if (plan.signupProduct && !has(user.signupProduct) && !has(user.signupPath)) {
    const fields: Record<string, string> = { signupProduct: plan.signupProduct };
    if (plan.signupClient) fields.signupClient = plan.signupClient.slice(0, 64);
    if (plan.signupRef) fields.signupRef = plan.signupRef;
    const names: Record<string, string> = { '#signupPath': 'signupPath' };
    const sets = Object.fromEntries(Object.entries(fields).map(([k, v]) => {
      names[`#${k}`] = k;
      return [k, { path: `#${k}`, value: v }];
    }));
    push(sets, names, 'attribute_not_exists(#signupProduct) AND attribute_not_exists(#signupPath)');
  }

  const existing = user.products && typeof user.products === 'object' ? user.products : undefined;
  const missing = Object.entries(plan.products).filter(([p]) => !existing || !Object.prototype.hasOwnProperty.call(existing, p));
  if (missing.length && !existing) {
    push({ products: { path: '#products', value: Object.fromEntries(missing) } }, { '#products': 'products' }, 'attribute_not_exists(#products)');
  } else {
    for (const [p, span] of missing) {
      push({ entry: { path: '#products.#p', value: span } }, { '#products': 'products', '#p': p }, 'attribute_exists(#products) AND attribute_not_exists(#products.#p)');
    }
  }

  if (plan.zomaStage && plan.zomaStageAt && !has(user.zomaStage) && !has(user.zomaStageAt)) {
    push(
      { stage: { path: '#zomaStage', value: plan.zomaStage }, at: { path: '#zomaStageAt', value: plan.zomaStageAt } },
      { '#zomaStage': 'zomaStage', '#zomaStageAt': 'zomaStageAt' },
      'attribute_not_exists(#zomaStage) AND attribute_not_exists(#zomaStageAt)',
    );
  }

  for (const [field, at] of [['zomaFirstReadAt', plan.zomaFirstReadAt], ['zomaFirstWriteAt', plan.zomaFirstWriteAt]] as const) {
    if (!at || has(user[field])) continue;
    push({ at: { path: '#m', value: at } }, { '#m': field }, 'attribute_not_exists(#m)');
  }
  return updates;
}

export const CSV_HEADER = 'email,userId,createdAt,signupProduct,products,zomaStage,evidence,last30dToolCalls,accountFlag';

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function csvRow(plan: BackfillPlan): string {
  const products = Object.entries(plan.products)
    .map(([p, s]) => `${p}:${s!.firstAt}..${s!.lastAt}`)
    .join(';');
  return [plan.email, plan.userId, plan.createdAt, plan.signupProduct, products, plan.zomaStage, plan.evidence.join(';'), plan.last30dToolCalls, plan.accountFlag]
    .map(csvCell)
    .join(',');
}

