/**
 * taggedLink — pure generator for per-channel organic tracking links. ENG-2313 (slice S3).
 *
 * The other half of trafficSource.ts: the classifier READS a visit, this WRITES the link that
 * makes the visit classifiable. Presets come from the same CHANNELS taxonomy, so the utm_source a
 * link carries is by construction one the classifier maps back to the intended channel
 * (taggedLink.test.ts enforces that round trip for every preset, with and without a referrer).
 *
 * Contract with the rest of the UTM system (landerUtm.ts / adUtm.ts, ENG-327/ENG-538):
 *  - Visitor-supplied UTMs win at read time and we do not touch that. This module only builds an
 *    OUTBOUND link, so it refuses a base URL that already carries utm_* — silently overwriting would
 *    break "never overwrite customer UTMs", and appending would emit a duplicate utm_source.
 *  - `aw_lander=1` is AgentWeb's provenance marker for lander links; it is reserved here, never emitted.
 *  - Paid click ids / Meta ad params are refused in `extra` and in the base URL: one of them makes the
 *    classifier call the visit paid, so a link containing one cannot be an organic link.
 *  - Only organic utm_medium values are emitted (ORGANIC_MEDIUMS); a test asserts none can read as paid.
 *
 * Heads-up for the DramaBreak LP: it reads `lp_variant = ?lp_variant || ?utm_content` and forwards
 * that as the Adjust ad group, and `creative_id` falls back to `utm_term`. So utm_content here is
 * NOT cosmetic on that LP, and we never set utm_term. Pass `extra: { lp_variant: 'v2' }` if the
 * variant must stay pinned.
 *
 * PURE: no clock, env, network or storage. Throws TaggedLinkError (with a stable `code`) on invalid input.
 */

import { UTM_KEYS } from './adUtm';
import { LANDER_PROVENANCE_KEY } from './landerUtm';
import {
  AGENCY_SOURCE_PREFIX,
  CHANNELS,
  ORGANIC_MEDIUMS,
  PAID_PARAM_KEYS,
  type ChannelDef,
  type ChannelGroup,
  type OrganicMedium,
} from './trafficSource';

export const MAX_BASE_URL_LENGTH = 1800;
export const MAX_URL_LENGTH = 2000;
export const MAX_CAMPAIGN_LENGTH = 60;
export const MAX_CONTENT_LENGTH = 40;
export const MAX_POST_ID_LENGTH = 32;
export const MAX_UTM_CONTENT_LENGTH = 100;
export const MAX_AGENCY_NAME_LENGTH = 32;
export const MAX_EXTRA_PARAMS = 5;
export const MAX_EXTRA_VALUE_LENGTH = 100;
/** Rows per bulk call. The route enforces the same number at the envelope. */
export const MAX_BULK_ROWS = 200;

export type TaggedLinkErrorCode =
  | 'invalid_base_url'
  | 'base_url_not_https'
  | 'base_url_host_not_allowed'
  | 'base_url_reserved_param'
  | 'base_url_too_long'
  | 'unknown_platform'
  | 'invalid_agency_name'
  | 'invalid_campaign'
  | 'invalid_medium'
  | 'field_too_long'
  | 'invalid_extra'
  | 'url_too_long'
  | 'too_many_rows'
  | 'invalid_rows';

export class TaggedLinkError extends Error {
  constructor(public readonly code: TaggedLinkErrorCode, message: string) {
    super(message);
    this.name = 'TaggedLinkError';
  }
}

export interface TaggedLinkInput {
  /** Destination, https only. Existing non-UTM query params and the fragment are preserved. */
  baseUrl: string;
  /** A preset key ('tiktok', 'instagram', 'youtube', 'facebook', 'linkedin', 'x', 'reddit', 'pinterest', 'newsletter') or 'agency:<name>'. */
  platform: string;
  campaign: string;
  /** Human label for the placement, e.g. 'ep3 teaser'. Slugged, prefixed with the platform code. */
  content?: string;
  /** Post/creative id appended to utm_content, e.g. '1009'. */
  postId?: string;
  /** One of ORGANIC_MEDIUMS; defaults to the preset's. */
  medium?: string;
  /** Additional non-reserved params (<= 5), e.g. { lp_variant: 'v2' }. */
  extra?: Record<string, string>;
  /** Exact hostnames, or '*.example.com'. When non-empty the base URL host must match one. */
  allowedHosts?: readonly string[];
}

export interface TaggedLink {
  url: string;
  /** Exactly the params this call appended, in emitted order. */
  params: Record<string, string>;
  platform: string;
  /** The channel the classifier is expected to assign to this link (verified by the round-trip test). */
  channel: string;
  channelKey: string;
  channelGroup: ChannelGroup;
}

export interface TaggedLinkPreset {
  platform: string;
  channelKey: string;
  channel: string;
  channelGroup: ChannelGroup;
  utmSource: string;
  contentCode: string;
  defaultMedium: OrganicMedium;
  referrerOrigin: string | null;
}

const PRESET_DEFS: ReadonlyArray<ChannelDef & { link: NonNullable<ChannelDef['link']> }> = CHANNELS.filter(
  (c): c is ChannelDef & { link: NonNullable<ChannelDef['link']> } => !!c.link,
);

/** Presets for the portal's link builder. `agency` takes a name: `agency:<name>`. */
export function listTaggedLinkPresets(): TaggedLinkPreset[] {
  return PRESET_DEFS.map((c) => ({
    platform: c.link.platform,
    channelKey: c.key,
    channel: c.name,
    channelGroup: c.group,
    utmSource: c.utmSource ?? '',
    contentCode: c.link.contentCode,
    defaultMedium: c.link.defaultMedium,
    referrerOrigin: c.link.referrerOrigin,
  }));
}

/** Readable, URL-safe slug: lowercase [a-z0-9-], diacritics folded, runs collapsed, no edge dashes. */
export function slugify(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const RESERVED_QUERY_KEYS: ReadonlySet<string> = new Set<string>([
  ...UTM_KEYS,
  ...PAID_PARAM_KEYS,
  LANDER_PROVENANCE_KEY,
]);

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((raw) => {
    const a = raw.trim().toLowerCase();
    if (!a) return false;
    if (a.startsWith('*.')) return host.endsWith(a.slice(1)) && host.length > a.length - 1;
    return host === a;
  });
}

function parseBaseUrl(baseUrl: unknown, allowedHosts?: readonly string[]): URL {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new TaggedLinkError('invalid_base_url', 'baseUrl is required');
  }
  const raw = baseUrl.trim();
  if (raw.length > MAX_BASE_URL_LENGTH) {
    throw new TaggedLinkError('base_url_too_long', `baseUrl exceeds ${MAX_BASE_URL_LENGTH} characters`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TaggedLinkError('invalid_base_url', 'baseUrl is not a valid absolute URL');
  }
  if (url.protocol !== 'https:') {
    throw new TaggedLinkError('base_url_not_https', 'baseUrl must use https');
  }
  if (url.username || url.password) {
    throw new TaggedLinkError('invalid_base_url', 'baseUrl must not contain credentials');
  }
  const host = url.hostname.toLowerCase();
  // A tracking link points at a public site: no bare names (localhost), no IP literals.
  if (!host.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[')) {
    throw new TaggedLinkError('invalid_base_url', 'baseUrl must use a public domain name');
  }
  if (allowedHosts && allowedHosts.length > 0 && !hostAllowed(host, allowedHosts)) {
    throw new TaggedLinkError('base_url_host_not_allowed', `baseUrl host "${host}" is not in the allowed hosts`);
  }
  const clash: string[] = [];
  for (const key of url.searchParams.keys()) {
    if (RESERVED_QUERY_KEYS.has(key.toLowerCase()) && !clash.includes(key)) clash.push(key);
  }
  if (clash.length > 0) {
    throw new TaggedLinkError(
      'base_url_reserved_param',
      `baseUrl already carries ${clash.join(', ')}; remove it so the generated link cannot duplicate or contradict it`,
    );
  }
  return url;
}

function resolvePreset(platformIn: unknown): { def: ChannelDef & { link: NonNullable<ChannelDef['link']> }; agencyName?: string } {
  const platform = typeof platformIn === 'string' ? platformIn.trim().toLowerCase() : '';
  const agencyMatch = /^agency(?::(.*))?$/.exec(platform);
  if (agencyMatch) {
    const name = slugify(agencyMatch[1] ?? '');
    if (!name) {
      throw new TaggedLinkError('invalid_agency_name', "agency presets need a name, e.g. 'agency:acme'");
    }
    if (name.length > MAX_AGENCY_NAME_LENGTH) {
      throw new TaggedLinkError('invalid_agency_name', `agency name exceeds ${MAX_AGENCY_NAME_LENGTH} characters`);
    }
    return { def: PRESET_DEFS.find((c) => c.link.platform === 'agency')!, agencyName: name };
  }
  const def = PRESET_DEFS.find((c) => c.link.platform === platform);
  if (!def) {
    const known = PRESET_DEFS.map((c) => c.link.platform).join(', ');
    throw new TaggedLinkError('unknown_platform', `unknown platform "${String(platformIn)}"; use one of: ${known}`);
  }
  return { def };
}

function cappedSlug(label: string, value: unknown, max: number): string {
  const s = slugify(value);
  if (s.length > max) throw new TaggedLinkError('field_too_long', `${label} exceeds ${max} characters after slugging`);
  return s;
}

export function buildTaggedLink(input: TaggedLinkInput): TaggedLink {
  if (!input || typeof input !== 'object') {
    throw new TaggedLinkError('invalid_base_url', 'input must be an object');
  }
  const url = parseBaseUrl(input.baseUrl, input.allowedHosts);
  const { def, agencyName } = resolvePreset(input.platform);

  const campaign = cappedSlug('campaign', input.campaign, MAX_CAMPAIGN_LENGTH);
  if (!campaign) throw new TaggedLinkError('invalid_campaign', 'campaign is required');

  const mediumRaw = input.medium === undefined || input.medium === '' ? def.link.defaultMedium : slugify(input.medium);
  if (!(ORGANIC_MEDIUMS as readonly string[]).includes(mediumRaw)) {
    throw new TaggedLinkError('invalid_medium', `medium must be one of: ${ORGANIC_MEDIUMS.join(', ')}`);
  }

  const contentSlug = cappedSlug('content', input.content, MAX_CONTENT_LENGTH);
  const postSlug = cappedSlug('postId', input.postId, MAX_POST_ID_LENGTH);
  const utmContent = [def.link.contentCode, contentSlug, postSlug].filter(Boolean).join('-');
  if (utmContent.length > MAX_UTM_CONTENT_LENGTH) {
    throw new TaggedLinkError('field_too_long', `utm_content exceeds ${MAX_UTM_CONTENT_LENGTH} characters`);
  }

  const utmSource = agencyName ? `${AGENCY_SOURCE_PREFIX}${agencyName}` : (def.utmSource as string);

  // Insertion order of this object IS the emitted order, and an object cannot hold a key twice.
  const params: Record<string, string> = {
    utm_source: utmSource,
    utm_medium: mediumRaw,
    utm_campaign: campaign,
    utm_content: utmContent,
  };

  const existingKeys = new Set<string>();
  for (const k of url.searchParams.keys()) existingKeys.add(k.toLowerCase());
  const extra = input.extra;
  if (extra !== undefined) {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
      throw new TaggedLinkError('invalid_extra', 'extra must be an object of string values');
    }
    const keys = Object.keys(extra);
    if (keys.length > MAX_EXTRA_PARAMS) {
      throw new TaggedLinkError('invalid_extra', `extra allows at most ${MAX_EXTRA_PARAMS} params`);
    }
    for (const rawKey of keys.sort()) {
      const key = rawKey.trim().toLowerCase();
      const value = (extra as Record<string, unknown>)[rawKey];
      if (!/^[a-z][a-z0-9_]{0,29}$/.test(key)) {
        throw new TaggedLinkError('invalid_extra', `extra key "${rawKey}" must match [a-z][a-z0-9_]{0,29}`);
      }
      if (RESERVED_QUERY_KEYS.has(key)) {
        throw new TaggedLinkError('invalid_extra', `extra key "${key}" is reserved (UTM, ad/click id or provenance parameter)`);
      }
      if (existingKeys.has(key) || key in params) {
        throw new TaggedLinkError('invalid_extra', `extra key "${key}" is already present in the link`);
      }
      if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_EXTRA_VALUE_LENGTH) {
        throw new TaggedLinkError('invalid_extra', `extra "${key}" must be a non-empty string up to ${MAX_EXTRA_VALUE_LENGTH} characters`);
      }
      params[key] = value.trim();
    }
  }

  // Preserve the original query verbatim and append; do not re-serialise it.
  const added = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const finalUrl = `${url.origin}${url.pathname}${url.search}${url.search ? '&' : '?'}${added}${url.hash}`;
  if (finalUrl.length > MAX_URL_LENGTH) {
    throw new TaggedLinkError('url_too_long', `generated URL exceeds ${MAX_URL_LENGTH} characters`);
  }

  return {
    url: finalUrl,
    params,
    platform: agencyName ? `agency:${agencyName}` : def.link.platform,
    channel: def.name,
    channelKey: def.key,
    channelGroup: def.group,
  };
}

export type BulkTaggedLinkResult =
  | { index: number; ok: true; link: TaggedLink }
  | { index: number; ok: false; error: { code: TaggedLinkErrorCode | 'invalid_row'; message: string } };

/**
 * Build many links, e.g. from parsed CSV rows. One bad row never fails the batch; each row gets
 * its own result in input order. `defaults` fill fields a row leaves blank (a CSV cell is '' not
 * undefined), so a sheet can share one baseUrl/campaign/allowedHosts.
 */
export function buildTaggedLinks(
  rows: ReadonlyArray<Partial<TaggedLinkInput>>,
  defaults: Partial<TaggedLinkInput> = {},
): BulkTaggedLinkResult[] {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new TaggedLinkError('invalid_rows', 'rows must be a non-empty array');
  }
  if (rows.length > MAX_BULK_ROWS) {
    throw new TaggedLinkError('too_many_rows', `at most ${MAX_BULK_ROWS} rows per request`);
  }
  return rows.map((row, index): BulkTaggedLinkResult => {
    try {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        return { index, ok: false, error: { code: 'invalid_row', message: 'row must be an object' } };
      }
      const merged: Record<string, unknown> = { ...defaults };
      for (const [k, v] of Object.entries(row)) {
        if (v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')) merged[k] = v;
      }
      return { index, ok: true, link: buildTaggedLink(merged as unknown as TaggedLinkInput) };
    } catch (err) {
      if (err instanceof TaggedLinkError) return { index, ok: false, error: { code: err.code, message: err.message } };
      throw err;
    }
  });
}
