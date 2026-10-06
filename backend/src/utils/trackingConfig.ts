/**
 * ENG-2315: the tracker config stored on a SESSION list row as `trackingConfig`.
 *
 *   allowedOrigins  browser origins permitted to post events for this list (exact scheme+host[:port])
 *   pageLabel       free label stamped on every session row as `page`
 *
 * Pure validation + matching, no I/O, so the rules the public ingest and the owner-facing config
 * API enforce are one set of rules in one place. Anything stored here was typed by a customer and
 * is later compared against attacker-controlled input (Origin, classification), so every field is
 * shape- and length-checked on the way IN and again defensively on the way OUT (a malformed stored
 * value must deny / skip, never throw).
 */

export const MAX_ALLOWED_ORIGINS = 10;
export const MAX_PAGE_LABEL = 60;

export interface TrackingConfig {
  allowedOrigins: string[];
  pageLabel?: string;
}

export class TrackingConfigError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

const LIST_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;
export const isPlausibleListId = (v: unknown): v is string => typeof v === 'string' && LIST_ID_RE.test(v);

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

/** Origin check for the public ingest. Fails closed on an empty / malformed stored list. */
export function isOriginAllowed(config: { allowedOrigins?: unknown } | null | undefined, origin: string): boolean {
  const list = config?.allowedOrigins;
  return Array.isArray(list) && list.length > 0 && list.includes(origin);
}
