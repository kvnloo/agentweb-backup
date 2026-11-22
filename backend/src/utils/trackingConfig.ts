import { CHANNELS, CHANNEL_GROUPS, PAID_CHANNEL_SPLIT, type ChannelGroup, type TrafficClassification } from './trafficSource';

/**
 * ENG-2315 / ENG-2316: the tracker config stored on a SESSION list row as `trackingConfig`.
 *
 *   allowedOrigins  browser origins permitted to post events for this list (exact scheme+host[:port])
 *   pageLabel       free label stamped on every session row as `page`
 *   routing         ENG-2316: copy a session into child session lists by traffic segment
 *
 * Pure validation + matching, no I/O, so the rules the public ingest and the owner-facing config
 * API enforce are one set of rules in one place. Anything stored here was typed by a customer and
 * is later compared against attacker-controlled input (Origin, classification), so every field is
 * shape- and length-checked on the way IN and again defensively on the way OUT (a malformed stored
 * value must deny / skip, never throw).
 */

export const MAX_ALLOWED_ORIGINS = 10;
export const MAX_PAGE_LABEL = 60;
export const MAX_ROUTING_RULES = 5;

export interface RoutingMatch {
  trafficType?: 'paid' | 'organic';
  channelGroup?: ChannelGroup;
  /** A CHANNELS key (or 'other' / 'direct'), i.e. TrafficClassification.channelKey. */
  channel?: string;
}
export interface RoutingRule {
  id: string;
  match: RoutingMatch;
  childListId: string;
}
export interface TrackingConfig {
  allowedOrigins: string[];
  pageLabel?: string;
  routing?: RoutingRule[];
}

export class TrackingConfigError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

const LIST_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;
export const isPlausibleListId = (v: unknown): v is string => typeof v === 'string' && LIST_ID_RE.test(v);

const RULE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CHANNEL_KEYS: ReadonlySet<string> = new Set([...CHANNELS.map((c) => c.key), ...Object.values(PAID_CHANNEL_SPLIT).map((s) => s.key), 'other', 'direct']);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * One origin the way a browser sends it in the Origin header: scheme://host[:port], nothing else.
 * Returns the canonical form (lower-case, default port dropped) so the stored value is exactly what
 * `new URL(origin).origin` / the Origin header will be. Wildcards, paths, queries, credentials and
 * non-http(s) schemes are rejected — a "*.example.com" or a bare "example.com" would otherwise be
 * stored and silently never match (or, worse, be matched loosely by a future refactor).
 * Plain http is allowed only for loopback, so a production page cannot be allow-listed over http.
 */
export function normalizeAllowedOrigin(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) {
    throw new TrackingConfigError('invalid_origin', 'each allowed origin must be a string of at most 200 characters');
  }
  const s = raw.trim();
  if (s.includes('*')) throw new TrackingConfigError('invalid_origin', `wildcards are not allowed in origins: "${s}"`);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new TrackingConfigError('invalid_origin', `not a valid origin (expected https://host[:port]): "${s}"`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new TrackingConfigError('invalid_origin', `origin must be http(s): "${s}"`);
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '') || /^[a-z]+:\/\/[^/]+\/./i.test(s)) {
    throw new TrackingConfigError('invalid_origin', `origin must be scheme + host[:port] only (no path, query or credentials): "${s}"`);
  }
  if (u.protocol === 'http:' && !LOOPBACK_HOSTS.has(u.hostname)) {
    throw new TrackingConfigError('invalid_origin', `plain http is only allowed for localhost: "${s}"`);
  }
  if (!u.hostname.includes('.') && !LOOPBACK_HOSTS.has(u.hostname)) {
    throw new TrackingConfigError('invalid_origin', `origin needs a full host name: "${s}"`);
  }
  return u.origin;
}

export function normalizeAllowedOrigins(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new TrackingConfigError('invalid_origins', 'allowedOrigins must be an array');
  if (raw.length > MAX_ALLOWED_ORIGINS) {
    throw new TrackingConfigError('too_many_origins', `at most ${MAX_ALLOWED_ORIGINS} allowed origins`);
  }
  return Array.from(new Set(raw.map(normalizeAllowedOrigin)));
}

export function normalizePageLabel(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new TrackingConfigError('invalid_page_label', 'pageLabel must be a string');
  const s = raw.trim();
  if (s.length > MAX_PAGE_LABEL) throw new TrackingConfigError('invalid_page_label', `pageLabel must be at most ${MAX_PAGE_LABEL} characters`);
  // Rendered in the CRM grid and CSV exports: no markup, no control characters.
  if (/[\u0000-\u001f\u007f<>"]/.test(s)) throw new TrackingConfigError('invalid_page_label', 'pageLabel contains characters that are not allowed');
  return s || undefined;
}

/** Shape-only validation of a routing array (no database). Cross-list rules live in validateRoutingTargets. */
export function normalizeRouting(raw: unknown): RoutingRule[] {
  if (!Array.isArray(raw)) throw new TrackingConfigError('invalid_routing', 'routing must be an array');
  if (raw.length > MAX_ROUTING_RULES) throw new TrackingConfigError('too_many_rules', `at most ${MAX_ROUTING_RULES} routing rules`);
  const seen = new Set<string>();
  return raw.map((r, i) => {
    const at = `routing[${i}]`;
    if (!isObject(r)) throw new TrackingConfigError('invalid_rule', `${at} must be an object`);
    for (const k of Object.keys(r)) {
      if (k !== 'id' && k !== 'match' && k !== 'childListId') throw new TrackingConfigError('invalid_rule', `${at}: unknown field "${k}"`);
    }
    if (typeof r.id !== 'string' || !RULE_ID_RE.test(r.id)) {
      throw new TrackingConfigError('invalid_rule', `${at}.id must be a slug (a-z, 0-9, "-", up to 32 chars)`);
    }
    if (seen.has(r.id)) throw new TrackingConfigError('duplicate_rule_id', `${at}: duplicate rule id "${r.id}"`);
    seen.add(r.id);
    if (!isPlausibleListId(r.childListId)) throw new TrackingConfigError('invalid_rule', `${at}.childListId must be a list id`);
    if (!isObject(r.match)) throw new TrackingConfigError('invalid_rule', `${at}.match must be an object`);

    const match: RoutingMatch = {};
    for (const [k, v] of Object.entries(r.match)) {
      if (k === 'trafficType') {
        if (v !== 'paid' && v !== 'organic') throw new TrackingConfigError('invalid_rule', `${at}.match.trafficType must be "paid" or "organic"`);
        match.trafficType = v;
      } else if (k === 'channelGroup') {
        if (typeof v !== 'string' || !(CHANNEL_GROUPS as readonly string[]).includes(v)) {
          throw new TrackingConfigError('invalid_rule', `${at}.match.channelGroup must be one of: ${CHANNEL_GROUPS.join(', ')}`);
        }
        match.channelGroup = v as ChannelGroup;
      } else if (k === 'channel') {
        if (typeof v !== 'string' || !CHANNEL_KEYS.has(v)) throw new TrackingConfigError('invalid_rule', `${at}.match.channel must be a channel key`);
        match.channel = v;
      } else {
        throw new TrackingConfigError('invalid_rule', `${at}.match: unknown field "${k}"`);
      }
    }
    // A rule with no condition would match every session: a copy of the parent, never what was meant.
    if (Object.keys(match).length === 0) throw new TrackingConfigError('invalid_rule', `${at}.match needs at least one of trafficType, channelGroup, channel`);
    return { id: r.id, match, childListId: r.childListId };
  });
}

/**
 * Cross-list rules for routing, checked against the lists as the DATABASE returns them.
 * No chains or loops: a child must not be the parent, must itself have no routing, must be a
 * session list, and must belong to the same owner. `getList` is injected so this stays unit-testable.
 */
export async function validateRoutingTargets(
  parent: { listId: string; userId: string },
  rules: RoutingRule[],
  getList: (listId: string) => Promise<Record<string, any> | null | undefined>,
): Promise<void> {
  const seenChildren = new Set<string>();
  for (const rule of rules) {
    const at = `routing rule "${rule.id}"`;
    if (rule.childListId === parent.listId) {
      throw new TrackingConfigError('routing_self', `${at}: a list cannot route into itself`);
    }
    if (seenChildren.has(rule.childListId)) {
      throw new TrackingConfigError('routing_duplicate_child', `${at}: child list ${rule.childListId} is already the target of another rule`);
    }
    seenChildren.add(rule.childListId);

    const child = await getList(rule.childListId);
    if (!child) throw new TrackingConfigError('routing_child_not_found', `${at}: child list ${rule.childListId} does not exist`);
    if (child.listType !== 'session') throw new TrackingConfigError('routing_child_not_session', `${at}: child list must be a session list`);
    if (child.userId !== parent.userId) throw new TrackingConfigError('routing_child_other_owner', `${at}: child list belongs to a different owner`);
    if (Array.isArray(child.trackingConfig?.routing) && child.trackingConfig.routing.length > 0) {
      throw new TrackingConfigError('routing_chain', `${at}: child list ${rule.childListId} has routing of its own (chains are not allowed)`);
    }
  }
}

/**
 * The child list ids a classified session should ALSO be written to. Every given match field must
 * equal the classification (AND); rules are independent, so a session can land in several children.
 * Defensive about the stored value: a malformed rule matches nothing.
 */
function baseChannelKey(key: string): string {
  for (const [base, split] of Object.entries(PAID_CHANNEL_SPLIT)) if (split.key === key) return base;
  return key;
}

export function matchRoutingRules(
  rules: unknown,
  c: Pick<TrafficClassification, 'trafficType' | 'channelGroup' | 'channelKey'>,
): string[] {
  if (!Array.isArray(rules)) return [];
  const out = new Set<string>();
  for (const r of rules) {
    if (!isObject(r) || !isObject(r.match) || typeof r.childListId !== 'string') continue;
    const m = r.match as RoutingMatch;
    if (m.trafficType === undefined && m.channelGroup === undefined && m.channel === undefined) continue;
    if (m.trafficType !== undefined && m.trafficType !== c.trafficType) continue;
    if (m.channelGroup !== undefined && m.channelGroup !== c.channelGroup) continue;
    // A rule saved before 2.1.0 as `google_search` / `youtube` still means "that platform, paid or
    // organic"; the paid split (google_ads / youtube_ads) must not silently drop it.
    if (m.channel !== undefined && m.channel !== c.channelKey && m.channel !== baseChannelKey(c.channelKey)) continue;
    out.add(r.childListId);
  }
  return Array.from(out);
}

/** Origin check for the public ingest. Fails closed on an empty / malformed stored list. */
export function isOriginAllowed(config: { allowedOrigins?: unknown } | null | undefined, origin: string): boolean {
  const list = config?.allowedOrigins;
  return Array.isArray(list) && list.length > 0 && list.includes(origin);
}
