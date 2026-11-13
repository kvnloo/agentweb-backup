/**
 * ENG-2906 — product attribution for the shared AgentWeb account (Zoma and Emma are one
 * account; product is attribution metadata only and NEVER restricts access).
 *
 * Pure helpers:
 *   - product derivation from the RFC 8707 `resource` / request path
 *   - `ref` validation (/^[a-z0-9_-]{1,64}$/; anything else is dropped, never rejected)
 *
 * AW-Users writes (key: email, resolved from userId). Every write is a single conditional
 * UpdateItem — never a read-modify-write — and every write asserts attribute_exists(email) so an
 * UpdateItem can never upsert a ghost user row:
 *   - signupProduct / signupPath / signupClient / signupRef / attributionConfidence:
 *     write-once as a set (`if_not_exists` under attribute_not_exists(signupPath)).
 *     attributionConfidence on the row (and the person) uses the contract enum
 *     tracked | inferred | verified: the internal `explicit` is written as `tracked`, and an
 *     `unknown` confidence is omitted rather than invented.
 *   - zomaFirstReadAt / zomaFirstWriteAt: write-once milestone timestamps, independent of the
 *     stage, so first_read is still recorded once when first_write happened first.
 *   - products.<product> = { firstAt, lastAt }: firstAt write-once; lastAt bumped at most once
 *     an hour per user/product (in-process throttle + `lastAt < cutoff` condition).
 *   - zomaStage / zomaStageAt: forward-only via `zomaStage IN (<strictly earlier stages>)`.
 *
 * Stage order (ZOMA_STAGES): setup_started < signed_up < connected < platform_connected
 * < card_saved < first_read < first_write < ad_live. Meta and Google connections are the
 * same stage (`platform_connected`). The stage is the furthest milestone reached, so a later
 * milestone reached out of order is never rewound. No backfill: users who predate ENG-2906
 * have no signup* / products / zomaStage until they generate a new event.
 */
import AWS from 'aws-sdk';
import { tableName } from '../config/constants';
import { META_TOOLKIT_MCP_RESOURCE_PATH, MCP_RESOURCE_PATH, getBackendUrl } from '../mcp/oauth/authChallenge';

export type JourneyProduct = 'zoma' | 'emma_mcp' | 'emma_web' | 'unknown';
export type KnownProduct = Exclude<JourneyProduct, 'unknown'>;
export type SignupPath = 'oauth_direct' | 'zoma_device' | 'api_key' | 'webapp';
/**
 * Internal derivation confidence. explicit: the client/user told us (resource, setup endpoint,
 * web form); inferred: from a reliable endpoint hint; unknown: no signal.
 */
export type AttributionConfidence = 'explicit' | 'inferred' | 'unknown';
/** Contract enum stored on the AW-Users row and the person. Nothing emits `verified` yet. */
export type UserAttributionConfidence = 'tracked' | 'inferred' | 'verified';

/** explicit -> tracked; inferred -> inferred; unknown -> undefined (omitted, never invented). */
export function toUserAttributionConfidence(confidence: AttributionConfidence | UserAttributionConfidence | undefined): UserAttributionConfidence | undefined {
  switch (confidence) {
    case 'explicit':
    case 'tracked':
      return 'tracked';
    case 'inferred':
      return 'inferred';
    case 'verified':
      return 'verified';
    default:
      return undefined;
  }
}

export const JOURNEY_PRODUCTS: readonly JourneyProduct[] = ['zoma', 'emma_mcp', 'emma_web', 'unknown'];
export const ZOMA_STAGES = [
  'setup_started',
  'signed_up',
  'connected',
  'platform_connected',
  'card_saved',
  'first_read',
  'first_write',
  'ad_live',
] as const;
export type ZomaStage = (typeof ZOMA_STAGES)[number];

/** Write-once milestone timestamps on AW-Users, independent of the forward-only stage. */
export const ZOMA_MILESTONE_FIELDS = { first_read: 'zomaFirstReadAt', first_write: 'zomaFirstWriteAt' } as const;
export type ZomaMilestone = keyof typeof ZOMA_MILESTONE_FIELDS;

/**
 * AW-Users `signupSource` value the register endpoint stamps for an account created on the MCP
 * OAuth consent page. The consent decision attributes the signup only when this marker is on
 * the row and no signup attribution exists yet — never from account age alone.
 */
export const MCP_CONSENT_SIGNUP_SOURCE = 'mcp';

/** First-party OAuth client used by the Zoma device flow (zomaDeviceFlow re-exports it). */
export const ZOMA_DEVICE_OAUTH_CLIENT_ID = 'zoma-device-setup';

export const REF_PATTERN = /^[a-z0-9_-]{1,64}$/;
export const PRODUCT_TOUCH_THROTTLE_MS = 3600 * 1000;

export function isJourneyProduct(value: unknown): value is JourneyProduct {
  return typeof value === 'string' && (JOURNEY_PRODUCTS as readonly string[]).includes(value);
}

export function normalizeProduct(value: unknown): JourneyProduct {
  return isJourneyProduct(value) ? value : 'unknown';
}

/** `?product=` values the admin roster accepts. `unknown` is not a filter. */
export const PRODUCT_FILTERS: readonly KnownProduct[] = ['zoma', 'emma_mcp', 'emma_web'];

/** undefined = no filter; null = present but invalid (caller answers 400). */
export function parseProductFilter(raw: unknown): KnownProduct | undefined | null {
  if (raw === undefined) return undefined;
  return typeof raw === 'string' && (PRODUCT_FILTERS as readonly string[]).includes(raw) ? (raw as KnownProduct) : null;
}

/** A user "has" a product when it is their signup product or it is in their products map. */
export function userHasProduct(user: { signupProduct?: unknown; products?: unknown } | null | undefined, product: KnownProduct): boolean {
  if (!user) return false;
  if (user.signupProduct === product) return true;
  const products = user.products;
  return !!products && typeof products === 'object' && Object.prototype.hasOwnProperty.call(products, product);
}

export function validateRef(raw: unknown): string | undefined {
  return typeof raw === 'string' && REF_PATTERN.test(raw) ? raw : undefined;
}

/** `ref` from an MCP URL's query string (e.g. https://api.agentweb.pro/mcp?ref=hn). */
export function readRef(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    return validateRef(new URL(url).searchParams.get('ref'));
  } catch {
    return undefined;
  }
}

const stripSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

export function productFromRequestPath(path: string): JourneyProduct {
  const p = stripSlash(path.split('?')[0]);
  if (p === MCP_RESOURCE_PATH) return 'emma_mcp';
  if (p === '/api/meta-toolkit' || p.startsWith('/api/meta-toolkit/')) return 'zoma';
  return 'unknown';
}

/**
 * RFC 8707 resource indicator -> product. Only our own origin counts; anything else (or a
 * malformed value) is `unknown` — never an error, never an authorization restriction.
 */
export function productFromResource(
  resource: unknown,
  backendUrl: string = getBackendUrl(),
): { product: JourneyProduct; confidence: AttributionConfidence } {
  const unknown = { product: 'unknown' as const, confidence: 'unknown' as const };
  if (typeof resource !== 'string' || !resource) return unknown;
  try {
    const url = new URL(resource);
    if (url.origin !== new URL(backendUrl).origin) return unknown;
    const path = stripSlash(url.pathname);
    if (path === MCP_RESOURCE_PATH) return { product: 'emma_mcp', confidence: 'explicit' };
    if (path === META_TOOLKIT_MCP_RESOURCE_PATH) return { product: 'zoma', confidence: 'explicit' };
    return unknown;
  } catch {
    return unknown;
  }
}

// ─── AW-Users writes ─────────────────────────────────────────────────────────

export interface JourneyAttributionDeps {
  update: (params: AWS.DynamoDB.DocumentClient.UpdateItemInput) => Promise<unknown>;
  resolveEmail: (userId: string) => Promise<string | undefined>;
  now: () => number;
  tableName: string;
}

export interface SignupAttribution {
  product: JourneyProduct;
  path: SignupPath;
  client: string;
  ref?: string;
  confidence: AttributionConfidence;
}

const isConditionalFailure = (error: unknown) => (error as { code?: string })?.code === 'ConditionalCheckFailedException';
const isMissingPath = (error: unknown) =>
  (error as { code?: string })?.code === 'ValidationException' && /document path/i.test(String((error as Error)?.message));

const MEMO_LIMIT = 10_000;
function boundedSet(set: Map<string, number>, key: string, value: number) {
  if (set.size >= MEMO_LIMIT) set.clear();
  set.set(key, value);
}

export interface SignupAttributionOptions {
  /** Only attribute when the row's `signupSource` equals this (e.g. MCP_CONSENT_SIGNUP_SOURCE). */
  requireSignupSource?: string;
}

export interface JourneyAttribution {
  recordSignupAttribution(userId: string, attribution: SignupAttribution, opts?: SignupAttributionOptions): Promise<boolean>;
  touchProduct(userId: string, product: JourneyProduct): Promise<'created' | 'touched' | 'throttled' | 'skipped'>;
  advanceZomaStage(userId: string, stage: ZomaStage, opts?: { requireZoma?: boolean }): Promise<boolean>;
  /** Write-once milestone timestamp; true only for the call that set it. */
  markZomaMilestone(userId: string, milestone: ZomaMilestone): Promise<boolean>;
}

export function createJourneyAttribution(deps: JourneyAttributionDeps): JourneyAttribution {
  const touched = new Map<string, number>();
  const stagesSettled = new Map<string, number>();
  const milestonesSettled = new Map<string, number>();

  const userKey = async (userId: string) => {
    const email = typeof userId === 'string' && userId ? await deps.resolveEmail(userId) : undefined;
    return email ? { email } : null;
  };

  return {
    async recordSignupAttribution(userId, attribution, opts = {}) {
      const Key = await userKey(userId);
      if (!Key) return false;
      const fields: Record<string, string> = {
        signupProduct: normalizeProduct(attribution.product),
        signupPath: attribution.path,
        signupClient: attribution.client.slice(0, 64),
      };
      const confidence = toUserAttributionConfidence(attribution.confidence);
      if (confidence) fields.attributionConfidence = confidence;
      const ref = validateRef(attribution.ref);
      if (ref) fields.signupRef = ref;
      const names: Record<string, string> = { '#email': 'email' };
      const values: Record<string, string> = {};
      const sets = Object.entries(fields).map(([k, v]) => {
        names[`#${k}`] = k;
        values[`:${k}`] = v;
        return `#${k} = if_not_exists(#${k}, :${k})`;
      });
      let condition = 'attribute_exists(#email) AND attribute_not_exists(#signupPath)';
      if (opts.requireSignupSource) {
        names['#signupSource'] = 'signupSource';
        values[':signupSource'] = opts.requireSignupSource;
        condition += ' AND #signupSource = :signupSource';
      }
      try {
        await deps.update({
          TableName: deps.tableName,
          Key,
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        });
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },

    async touchProduct(userId, product) {
      if (!isJourneyProduct(product) || product === 'unknown') return 'skipped';
      const memoKey = `${userId}:${product}`;
      const nowMs = deps.now();
      const last = touched.get(memoKey);
      if (last !== undefined && nowMs - last < PRODUCT_TOUCH_THROTTLE_MS) return 'throttled';
      const Key = await userKey(userId);
      if (!Key) return 'skipped';
      boundedSet(touched, memoKey, nowMs);
      const now = new Date(nowMs).toISOString();
      const entry = { firstAt: now, lastAt: now };
      const names = { '#email': 'email', '#products': 'products', '#p': product };
      const create = () =>
        deps.update({
          TableName: deps.tableName,
          Key,
          UpdateExpression: 'SET #products.#p = :entry',
          ConditionExpression: 'attribute_exists(#email) AND attribute_not_exists(#products.#p)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: { ':entry': entry },
        });
      try {
        await create();
        return 'created';
      } catch (error) {
        if (isMissingPath(error)) {
          try {
            await deps.update({
              TableName: deps.tableName,
              Key,
              UpdateExpression: 'SET #products = :products',
              ConditionExpression: 'attribute_exists(#email) AND attribute_not_exists(#products)',
              ExpressionAttributeNames: { '#email': 'email', '#products': 'products' },
              ExpressionAttributeValues: { ':products': { [product]: entry } },
            });
            return 'created';
          } catch (initError) {
            if (!isConditionalFailure(initError)) throw initError;
            // A concurrent writer created the map first; add our entry to it.
            try {
              await create();
              return 'created';
            } catch (retryError) {
              if (!isConditionalFailure(retryError)) throw retryError;
            }
          }
        } else if (!isConditionalFailure(error)) {
          throw error;
        }
      }
      try {
        await deps.update({
          TableName: deps.tableName,
          Key,
          UpdateExpression: 'SET #products.#p.#lastAt = :now',
          ConditionExpression: '#products.#p.#lastAt < :cutoff',
          ExpressionAttributeNames: { '#products': 'products', '#p': product, '#lastAt': 'lastAt' },
          ExpressionAttributeValues: { ':now': now, ':cutoff': new Date(nowMs - PRODUCT_TOUCH_THROTTLE_MS).toISOString() },
        });
        return 'touched';
      } catch (error) {
        if (isConditionalFailure(error)) return 'throttled';
        throw error;
      }
    },

    async advanceZomaStage(userId, stage, opts = {}) {
      const rank = ZOMA_STAGES.indexOf(stage);
      if (rank < 0) return false;
      const memoKey = `${userId}:${stage}:${opts.requireZoma ? 'z' : ''}`;
      if (stagesSettled.has(memoKey)) return false;
      const Key = await userKey(userId);
      if (!Key) return false;
      const names: Record<string, string> = { '#email': 'email', '#zomaStage': 'zomaStage', '#zomaStageAt': 'zomaStageAt' };
      const values: Record<string, string> = { ':stage': stage, ':now': new Date(deps.now()).toISOString() };
      const earlier = ZOMA_STAGES.slice(0, rank).map((s, i) => {
        values[`:s${i}`] = s;
        return `:s${i}`;
      });
      let condition = earlier.length
        ? `attribute_exists(#email) AND (attribute_not_exists(#zomaStage) OR #zomaStage IN (${earlier.join(', ')}))`
        : 'attribute_exists(#email) AND attribute_not_exists(#zomaStage)';
      if (opts.requireZoma) {
        names['#products'] = 'products';
        names['#zoma'] = 'zoma';
        condition += ' AND attribute_exists(#products.#zoma)';
      }
      try {
        await deps.update({
          TableName: deps.tableName,
          Key,
          UpdateExpression: 'SET #zomaStage = :stage, #zomaStageAt = :now',
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        });
        // Reached: this process never needs to try this stage again for the user.
        boundedSet(stagesSettled, memoKey, 1);
        return true;
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
        // Already at/after this stage: permanent, so stop retrying it on every call. A requireZoma
        // failure may only mean "not a Zoma user yet", which can change — never memoize that.
        if (!opts.requireZoma) boundedSet(stagesSettled, memoKey, 1);
        return false;
      }
    },

    async markZomaMilestone(userId, milestone) {
      const field = ZOMA_MILESTONE_FIELDS[milestone];
      if (!field) return false;
      const memoKey = `${userId}:${milestone}`;
      if (milestonesSettled.has(memoKey)) return false;
      const Key = await userKey(userId);
      if (!Key) return false;
      try {
        await deps.update({
          TableName: deps.tableName,
          Key,
          UpdateExpression: 'SET #m = :now',
          ConditionExpression: 'attribute_exists(#email) AND attribute_not_exists(#m)',
          ExpressionAttributeNames: { '#email': 'email', '#m': field },
          ExpressionAttributeValues: { ':now': new Date(deps.now()).toISOString() },
        });
        boundedSet(milestonesSettled, memoKey, 1);
        return true;
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
        // Already set (permanent): stop writing it on every tool call.
        boundedSet(milestonesSettled, memoKey, 1);
        return false;
      }
    },
  };
}

// One-off helpers (fresh instance: no shared memo/throttle) — mainly for tests and scripts.
export const recordSignupAttribution = (
  userId: string,
  attribution: SignupAttribution,
  opts: SignupAttributionOptions = {},
  deps: JourneyAttributionDeps = defaultDeps(),
) => createJourneyAttribution(deps).recordSignupAttribution(userId, attribution, opts);
export const touchProduct = (userId: string, product: JourneyProduct, deps: JourneyAttributionDeps = defaultDeps()) =>
  createJourneyAttribution(deps).touchProduct(userId, product);
export const advanceZomaStage = (
  userId: string,
  stage: ZomaStage,
  opts: { requireZoma?: boolean } = {},
  deps: JourneyAttributionDeps = defaultDeps(),
) => createJourneyAttribution(deps).advanceZomaStage(userId, stage, opts);

const emailCache = new Map<string, string>();
let docClient: AWS.DynamoDB.DocumentClient | undefined;

function defaultDeps(): JourneyAttributionDeps {
  return {
    update: (params) => (docClient ??= new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' })).update(params).promise(),
    resolveEmail: async (userId) => {
      // Inert under jest unless a test injects its own deps: suites that merely import a route
      // must never reach DynamoDB through fire-and-forget attribution.
      if (process.env.NODE_ENV === 'test') return undefined;
      const cached = emailCache.get(userId);
      if (cached) return cached;
      // Lazy: db.ts is heavy and most importers (routes/tests) never write attribution.
      const { userDb } = await import('./db');
      const user = await userDb.getUserById(userId);
      const email = typeof user?.email === 'string' ? user.email : undefined;
      if (email) {
        if (emailCache.size >= MEMO_LIMIT) emailCache.clear();
        emailCache.set(userId, email);
      }
      return email;
    },
    now: () => Date.now(),
    tableName: tableName('AW-Users'),
  };
}

export const markZomaMilestone = (userId: string, milestone: ZomaMilestone, deps: JourneyAttributionDeps = defaultDeps()) =>
  createJourneyAttribution(deps).markZomaMilestone(userId, milestone);

/** Process-wide instance: shares the hourly product throttle and the stage memo. */
export const journeyAttribution: JourneyAttribution = createJourneyAttribution(defaultDeps());
