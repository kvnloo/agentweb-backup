/**
 * ENG-2914 — pluggable custom-audience sources for the Zoma toolkit (pure: no I/O).
 *
 * An AudienceSource turns a caller's `source` object into (a) a validated spec, (b) the
 * Meta Graph create params, and (c) one preview line. Meta-native sources are implemented
 * here; `external_provider` is the seam for a third-party data provider (e.g. Tero AI,
 * contract pending) and is registered but refused with "not available yet" until it ships.
 * Adding a provider = one more entry in AUDIENCE_SOURCES; the executor does not change.
 *
 * Customer-list identifiers are normalized and SHA-256 hashed here, server-side, so raw
 * emails/phones never leave this module: callers get counts back, Meta gets hashes only.
 */
import crypto from 'crypto';
import { MetaToolkitRefusal } from './metaToolkitErrors';

export const AUDIENCE_SOURCE_TYPES = ['customer_list', 'website', 'engagement', 'lookalike', 'external_provider'] as const;
export type AudienceSourceType = (typeof AUDIENCE_SOURCE_TYPES)[number];

/** Meta's per-request cap for POST/DELETE /{audience_id}/users. */
export const META_AUDIENCE_USERS_BATCH = 10_000;
/** Toolkit cap per call, so one MCP request stays bounded. */
export const MAX_IDENTIFIERS_PER_CALL = 100_000;

export interface AudienceSpec {
  type: AudienceSourceType;
  /** Graph params for POST act_<id>/customaudiences (name/description added by the executor). */
  createParams: Record<string, any>;
  /** One human line for the preview. Never contains raw PII. */
  describe: string;
  /** Origin audience id to ownership-check before a lookalike create. */
  originAudienceId?: string;
}

export interface AudienceSource {
  type: AudienceSourceType;
  available: boolean;
  build(source: Record<string, any>): AudienceSpec;
}

const numericId = (value: unknown, field: string): string => {
  const id = String(value ?? '').trim();
  if (!/^\d+$/.test(id)) throw new MetaToolkitRefusal(`source.${field} must be a numeric Meta id.`);
  return id;
};

const retentionSeconds = (value: unknown, max: number, fallback: number): number => {
  const days = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(days) || days < 1 || days > max) {
    throw new MetaToolkitRefusal(`source.retention_days must be a whole number from 1 to ${max}.`);
  }
  return days * 86_400;
};

const customerList: AudienceSource = {
  type: 'customer_list',
  available: true,
  build: () => ({
    type: 'customer_list',
    createParams: { subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY' },
    describe: 'Customer list (hashed emails/phones you supply; add members with ADD_USERS or params.emails / params.phones).',
  }),
};

const website: AudienceSource = {
  type: 'website',
  available: true,
  build: (source) => {
    const pixelId = numericId(source.pixel_id, 'pixel_id');
    const retention = retentionSeconds(source.retention_days, 180, 30);
    const filters: any[] = [];
    if (source.url_contains !== undefined) {
      const v = String(source.url_contains).trim();
      if (!v || v.length > 500) throw new MetaToolkitRefusal('source.url_contains must be 1-500 characters.');
      filters.push({ field: 'url', operator: 'i_contains', value: v });
    }
    if (source.event_name !== undefined) {
      const v = String(source.event_name).trim();
      if (!/^[A-Za-z0-9_]{1,100}$/.test(v)) throw new MetaToolkitRefusal('source.event_name must be a pixel event name such as Purchase or AddToCart.');
      filters.push({ field: 'event', operator: 'eq', value: v });
    }
    const rule = {
      inclusions: {
        operator: 'or',
        rules: [{
          event_sources: [{ id: pixelId, type: 'pixel' }],
          retention_seconds: retention,
          filter: { operator: 'and', filters: filters.length ? filters : [{ field: 'url', operator: 'i_contains', value: '' }] },
        }],
      },
    };
    const what = filters.map((f) => (f.field === 'url' ? `URL contains "${f.value}"` : `event ${f.value}`)).join(' and ') || 'any page visit';
    return {
      type: 'website',
      createParams: { rule: JSON.stringify(rule), prefill: true },
      describe: `Website visitors from pixel ${pixelId}: ${what}, last ${retention / 86_400} days.`,
    };
  },
};

const ENGAGEMENT_DEFAULT_EVENT: Record<string, string> = { page: 'page_engaged', ig_business: 'ig_business_profile_all' };

const engagement: AudienceSource = {
  type: 'engagement',
  available: true,
  build: (source) => {
    const sourceType = String(source.source_type ?? '');
    if (!ENGAGEMENT_DEFAULT_EVENT[sourceType]) throw new MetaToolkitRefusal('source.source_type must be "page" (Facebook Page) or "ig_business" (Instagram account).');
    const sourceId = numericId(source.source_id, 'source_id');
    const event = source.event === undefined ? ENGAGEMENT_DEFAULT_EVENT[sourceType] : String(source.event).trim();
    if (!/^[a-z_]{3,60}$/.test(event)) throw new MetaToolkitRefusal('source.event must be a Meta engagement event such as page_engaged or ig_business_profile_all.');
    const retention = retentionSeconds(source.retention_days, 365, 365);
    const rule = {
      inclusions: {
        operator: 'or',
        rules: [{
          event_sources: [{ id: sourceId, type: sourceType }],
          retention_seconds: retention,
          filter: { operator: 'and', filters: [{ field: 'event', operator: 'eq', value: event }] },
        }],
      },
    };
    return {
      type: 'engagement',
      createParams: { rule: JSON.stringify(rule), prefill: true },
      describe: `Engagement with ${sourceType === 'page' ? 'Facebook Page' : 'Instagram account'} ${sourceId} (${event}), last ${retention / 86_400} days.`,
    };
  },
};

const lookalike: AudienceSource = {
  type: 'lookalike',
  available: true,
  build: (source) => {
    const origin = numericId(source.origin_audience_id, 'origin_audience_id');
    const country = String(source.country ?? '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw new MetaToolkitRefusal('source.country must be a 2-letter ISO country code, e.g. "US".');
    const pct = Number(source.ratio_percent);
    if (!Number.isInteger(pct) || pct < 1 || pct > 10) throw new MetaToolkitRefusal('source.ratio_percent must be a whole number from 1 to 10 (1 = the closest 1% of people in the country).');
    return {
      type: 'lookalike',
      createParams: {
        subtype: 'LOOKALIKE',
        origin_audience_id: origin,
        lookalike_spec: JSON.stringify({ type: 'similarity', ratio: pct / 100, country }),
      },
      describe: `Lookalike of audience ${origin}: closest ${pct}% of people in ${country}.`,
      originAudienceId: origin,
    };
  },
};

const externalProvider: AudienceSource = {
  type: 'external_provider',
  available: false,
  build: () => {
    throw new MetaToolkitRefusal('external_provider audiences are not available yet. Use customer_list, website, engagement or lookalike.');
  },
};

export const AUDIENCE_SOURCES: Record<AudienceSourceType, AudienceSource> = {
  customer_list: customerList,
  website,
  engagement,
  lookalike,
  external_provider: externalProvider,
};

export function buildAudienceSpec(source: unknown): AudienceSpec {
  const s = source && typeof source === 'object' && !Array.isArray(source) ? (source as Record<string, any>) : {};
  const impl = AUDIENCE_SOURCES[String(s.type) as AudienceSourceType];
  if (!impl) throw new MetaToolkitRefusal(`source.type must be one of: ${AUDIENCE_SOURCE_TYPES.join(', ')}.`);
  return impl.build(s);
}

// ── customer-list identifiers ────────────────────────────────────────────────────────

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

/** Meta normalization: trimmed, lowercased email. Null when not an email. */
export function normalizeEmail(raw: unknown): string | null {
  const v = String(raw ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254 ? v : null;
}

/** Meta normalization: digits only, with country code, no leading zeros or '+'. Null when implausible. */
export function normalizePhone(raw: unknown): string | null {
  const v = String(raw ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return v.length >= 8 && v.length <= 15 ? v : null;
}

export interface HashedIdentifiers {
  EMAIL: string[];
  PHONE: string[];
  invalid: number;
  duplicates: number;
}

/**
 * Normalize + hash caller-supplied emails/phones. Raw values are dropped as soon as they are
 * hashed; only hashes and counts leave this function. Already-hashed (64-hex) values pass through.
 */
export function hashIdentifiers(emails: unknown, phones: unknown): HashedIdentifiers {
  const out: HashedIdentifiers = { EMAIL: [], PHONE: [], invalid: 0, duplicates: 0 };
  const lists: Array<['EMAIL' | 'PHONE', unknown, (v: unknown) => string | null]> = [
    ['EMAIL', emails, normalizeEmail],
    ['PHONE', phones, normalizePhone],
  ];
  for (const [schema, input, normalize] of lists) {
    if (input === undefined || input === null) continue;
    if (!Array.isArray(input)) throw new MetaToolkitRefusal(`params.${schema === 'EMAIL' ? 'emails' : 'phones'} must be an array of strings.`);
    const seen = new Set<string>();
    for (const raw of input) {
      const trimmed = String(raw ?? '').trim();
      const hash = /^[a-f0-9]{64}$/i.test(trimmed) ? trimmed.toLowerCase() : (() => {
        const n = normalize(trimmed);
        return n ? sha256(n) : null;
      })();
      if (!hash) {
        out.invalid += 1;
        continue;
      }
      if (seen.has(hash)) {
        out.duplicates += 1;
        continue;
      }
      seen.add(hash);
      out[schema].push(hash);
    }
  }
  const total = out.EMAIL.length + out.PHONE.length;
  if (total > MAX_IDENTIFIERS_PER_CALL) {
    throw new MetaToolkitRefusal(`At most ${MAX_IDENTIFIERS_PER_CALL} identifiers per call; split the list into several calls.`);
  }
  return out;
}

export function batches<T>(items: T[], size = META_AUDIENCE_USERS_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Digest of the hashed identifiers, for the preview fingerprint (order-independent). */
export function identifiersDigest(ids: HashedIdentifiers): string {
  return sha256(`E:${[...ids.EMAIL].sort().join(',')}|P:${[...ids.PHONE].sort().join(',')}`);
}
