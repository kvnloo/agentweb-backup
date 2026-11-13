/**
 * ENG-2906 — product journey events (PostHog), fail-open.
 *
 *   trackJourney({userId}|{anonId}, event, props)  capture one journey event
 *   identifyJourney(userId, personProps)            signup* set-once, products/zomaStage set
 *   aliasJourney(userId, anonId)                    join a pre-signup setup to the user
 *
 * Events: setup_started, signed_up, connected, meta_connected, google_connected, card_saved,
 * first_read, first_write. `ad_live` is a documented stub only (see docs/journey-tracking.md):
 * nothing emits it yet. `abandoned` is deliberately not emitted.
 *
 * Privacy: only allowlisted property keys with short scalar values leave this process. Never
 * email, tokens/credentials, ad-account ids, or ad data (names, budgets, spend, creatives).
 * The distinct id is the AgentWeb userId, or before signup a hash of the Zoma setup's device id.
 *
 * Every function here resolves; nothing can fail or slow the request that called it beyond
 * an in-memory enqueue (posthog-node batches and flushes in the background; the shutdown
 * drain flushes the tail — server.ts).
 */
import crypto from 'crypto';

export const POSTHOG_PUBLIC_PROJECT_TOKEN = 'phc_miHNk9CcBDiPNUkGnNvKuvaJDPy8zzKGqSj3RnsusHwL';
export const POSTHOG_DEFAULT_HOST = 'https://us.i.posthog.com';

export type JourneyEvent =
  | 'setup_started'
  | 'signed_up'
  | 'connected'
  | 'meta_connected'
  | 'google_connected'
  | 'card_saved'
  | 'first_read'
  | 'first_write'
  /** ENG-2902: first provider-verified delivering Zoma ad (services/zomaScoreboard). */
  | 'ad_live';

export type JourneySubject = { userId: string } | { anonId: string };

/** The subset of posthog-node's client this module uses (explicit seam; no type import). */
export interface JourneyClient {
  capture(input: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
  identify(input: { distinctId: string; properties?: Record<string, unknown> }): void;
  alias(input: { distinctId: string; alias: string }): void;
  flush(): Promise<unknown>;
  shutdown(): Promise<unknown>;
}

const EVENT_PROP_KEYS = new Set([
  'product',
  'path',
  'client',
  'clientType',
  'authMethod',
  'ref',
  'platform',
  'stage',
  'toolName',
  'entityType',
  'action',
  'verification',
  'confidence',
  'source',
]);
const SET_ONCE_KEYS = new Set(['signupProduct', 'signupPath', 'signupClient', 'signupRef', 'attributionConfidence']);
const SET_KEYS = new Set(['products', 'zomaStage']);

const TOKEN_LIKE = /^(?:bearer\s|aw_[A-Za-z0-9_-]{20,}$|zoma_[A-Za-z0-9_-]{30,}$|eyJ)/i;
function safeScalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' || !value || value.length > 64) return undefined;
  if (value.includes('@') || TOKEN_LIKE.test(value)) return undefined;
  return value;
}

function pick(raw: Record<string, unknown> | undefined, keys: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!keys.has(key)) continue;
    if (Array.isArray(value)) {
      const items = value.map(safeScalar).filter((v): v is string => typeof v === 'string');
      if (items.length) out[key] = items;
      continue;
    }
    const scalar = safeScalar(value);
    if (scalar !== undefined) out[key] = scalar;
  }
  return out;
}

export const sanitizeJourneyProps = (raw: Record<string, unknown>) => pick(raw, EVENT_PROP_KEYS);

/** Pre-signup distinct id for a Zoma setup. Hashed: the device id is a live store key. */
export function anonymousSetupId(deviceId: string): string {
  return `zoma_setup_${crypto.createHash('sha256').update(`journey:${deviceId}`).digest('hex').slice(0, 32)}`;
}

export function resolveJourneyClientConfig(env: NodeJS.ProcessEnv = process.env): { token: string; host: string } | null {
  if (env.NODE_ENV === 'test' || env.JOURNEY_TRACKING_DISABLED === 'true') return null;
  return {
    token: env.POSTHOG_PROJECT_TOKEN || POSTHOG_PUBLIC_PROJECT_TOKEN,
    host: env.POSTHOG_HOST || POSTHOG_DEFAULT_HOST,
  };
}

// undefined = not resolved yet; null = disabled.
let client: JourneyClient | null | undefined;

function getClient(): JourneyClient | null {
  if (client !== undefined) return client;
  const config = resolveJourneyClientConfig();
  if (!config) return (client = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PostHog } = require('posthog-node');
    client = new PostHog(config.token, { host: config.host, flushAt: 20, flushInterval: 10_000 }) as JourneyClient;
  } catch (error) {
    warn('init', error);
    client = null;
  }
  return client;
}

/** Test seam: inject a fake client, `null` to disable, `undefined` to re-resolve from env. */
export function setJourneyClientForTests(next: JourneyClient | null | undefined): void {
  client = next;
}

function warn(op: string, error: unknown) {
  console.warn(`[journey] ${op} failed (ignored):`, error instanceof Error ? error.message : String(error));
}

const distinctIdOf = (subject: JourneySubject) => ('userId' in subject ? subject.userId : subject.anonId);

export async function trackJourney(subject: JourneySubject, event: JourneyEvent, props: Record<string, unknown> = {}): Promise<void> {
  try {
    const distinctId = distinctIdOf(subject);
    const c = getClient();
    if (!c || typeof distinctId !== 'string' || !distinctId) return;
    c.capture({ distinctId, event, properties: sanitizeJourneyProps(props) });
  } catch (error) {
    warn(`capture ${event}`, error);
  }
}

export async function identifyJourney(userId: string, personProps: Record<string, unknown>): Promise<void> {
  try {
    const c = getClient();
    if (!c || !userId) return;
    const $set_once = pick(personProps, SET_ONCE_KEYS);
    const $set = pick(personProps, SET_KEYS);
    const properties: Record<string, unknown> = {};
    if (Object.keys($set_once).length) properties.$set_once = $set_once;
    if (Object.keys($set).length) properties.$set = $set;
    if (!Object.keys(properties).length) return;
    c.identify({ distinctId: userId, properties });
  } catch (error) {
    warn('identify', error);
  }
}

export async function aliasJourney(userId: string, anonId: string): Promise<void> {
  try {
    const c = getClient();
    if (!c || !userId || !anonId) return;
    c.alias({ distinctId: userId, alias: anonId });
  } catch (error) {
    warn('alias', error);
  }
}

/** Called from the shutdown drain so queued events are not lost with the process. */
export async function flushJourney(): Promise<void> {
  try {
    const c = client;
    if (c) await c.shutdown();
  } catch (error) {
    warn('flush', error);
  }
}
