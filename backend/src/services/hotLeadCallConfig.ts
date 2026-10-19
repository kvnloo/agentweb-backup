import { parsePhoneNumberWithError } from 'libphonenumber-js';
import { toE164 } from './whatsappService';
import { isLeadTypes, type LeadOrigin } from './leadNotificationConfig';
import { isValidTimezone as parsesAsTimezone } from './dripSendWindow';

export const HOT_LEAD_CALL_COUNTRIES = ['US', 'CA'] as const;
type HotLeadCallCountry = typeof HOT_LEAD_CALL_COUNTRIES[number];

const HOT_LEAD_CALL_DEFAULT_LEAD_TYPES: readonly LeadOrigin[] = ['form_fill'];
const HOT_LEAD_CALL_DEFAULT_QUIET_HOURS = { start: '08:00', end: '21:00' } as const;
export const HOT_LEAD_CALL_ANNOUNCED_NAME_MAX = 60;

export const HOT_LEAD_CALL_LIMITS = {
  maxAgeMinutes: { default: 10, min: 1, max: 60 },
  maxCallsPerHour: { default: 6, min: 1, max: 30 },
  maxCallsPerDay: { default: 20, min: 1, max: 100 },
  ownerCooldownMinutes: { default: 2, min: 1, max: 60 },
} as const;
type HotLeadCallLimitField = keyof typeof HOT_LEAD_CALL_LIMITS;
export const HOT_LEAD_CALL_LIMIT_FIELDS = Object.keys(HOT_LEAD_CALL_LIMITS) as HotLeadCallLimitField[];

/** System-managed: set only by the number-provisioning / verification flow, never by Emma tools. */
export const HOT_LEAD_CALL_SYSTEM_FIELDS = ['destinationVerifiedAt', 'twilioNumber', 'twilioNumberSid'] as const;

interface HotLeadCallQuietHours {
  /** Calls are only placed between start and end (24h HH:MM, local to timezone). */
  start: string;
  end: string;
  /** IANA zone, e.g. America/Chicago. */
  timezone: string;
}

export interface HotLeadCallConfig {
  enabled: boolean;
  /** E.164, US/CA only. The owner's phone that is rung first. */
  destinationPhone: string;
  destinationVerifiedAt?: string;
  twilioNumber?: string;
  twilioNumberSid?: string;
  leadTypes: LeadOrigin[];
  maxAgeMinutes: number;
  maxCallsPerHour: number;
  maxCallsPerDay: number;
  ownerCooldownMinutes: number;
  /** Spoken aloud inside TwiML, hence the restricted charset. */
  announcedName: string;
  /** Required before the config can be enabled. */
  quietHours?: HotLeadCallQuietHours;
  allowedCountries: HotLeadCallCountry[];
}

const KEYS: ReadonlySet<string> = new Set([
  'enabled', 'destinationPhone', 'destinationVerifiedAt', 'twilioNumber', 'twilioNumberSid', 'leadTypes',
  ...HOT_LEAD_CALL_LIMIT_FIELDS, 'announcedName', 'quietHours', 'allowedCountries',
]);
const QUIET_KEYS: ReadonlySet<string> = new Set(['start', 'end', 'timezone']);
// SECURITY: this text is spoken inside TwiML <Say>. '&' is deliberately allowed ('Smith & Sons'),
// so the TwiML builder MUST XML-escape announcedName before interpolating it.
const ANNOUNCED_NAME = /^[\p{L}\p{N} .,&'-]+$/u;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const TWILIO_SID = /^PN[0-9a-f]{32}$/;

// Local copy: leadNotificationAttribution.isRecord lives in a module that imports aws-sdk (via leadNotificationLookup).
export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// Canonical IANA names only: Intl accepts aliases like 'EST', 'america/chicago' and '+05:00', which are
// ambiguous or case-variant. 'UTC' is not in the supported list and is meaningless as a local calling window.
const CANONICAL_TIMEZONES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('timeZone'));
const isValidTimezone = (tz: unknown): tz is string => typeof tz === 'string' && CANONICAL_TIMEZONES.has(tz) && parsesAsTimezone(tz);

// Numbers that bill the caller (toll fraud) or cannot ring a person's phone. Only a positive match
// rejects: the default build's metadata returns undefined for types it cannot tell apart.
const BLOCKED_NUMBER_TYPES: ReadonlySet<string | undefined> = new Set(['PREMIUM_RATE', 'TOLL_FREE', 'PERSONAL_NUMBER', 'SHARED_COST', 'UAN', 'VOIP']);

/** Canonical E.164 whose country is in the US/CA allowlist, else null. */
export function allowlistedE164(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e164 = toE164(raw);
  if (!e164 || e164 !== raw) return null;
  try {
    const parsed = parsePhoneNumberWithError(e164);
    if (BLOCKED_NUMBER_TYPES.has(parsed.getType())) return null;
    return parsed.country && (HOT_LEAD_CALL_COUNTRIES as readonly string[]).includes(parsed.country) ? e164 : null;
  } catch {
    return null;
  }
}

const isCountries = (v: unknown): v is HotLeadCallCountry[] =>
  Array.isArray(v) && v.length > 0 && new Set(v).size === v.length &&
  v.every(c => (HOT_LEAD_CALL_COUNTRIES as readonly unknown[]).includes(c));

function limit(raw: unknown, field: HotLeadCallLimitField): number | null {
  const { default: dflt, min, max } = HOT_LEAD_CALL_LIMITS[field];
  if (raw === undefined) return dflt;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max ? raw : null;
}

function quietHoursOf(raw: unknown): HotLeadCallQuietHours | null {
  if (!isRecord(raw) || Object.keys(raw).some(k => !QUIET_KEYS.has(k))) return null;
  const start = raw.start === undefined ? HOT_LEAD_CALL_DEFAULT_QUIET_HOURS.start : raw.start;
  const end = raw.end === undefined ? HOT_LEAD_CALL_DEFAULT_QUIET_HOURS.end : raw.end;
  if (typeof start !== 'string' || typeof end !== 'string' || !HHMM.test(start) || !HHMM.test(end) || start === end) return null;
  if (!isValidTimezone(raw.timezone)) return null;
  return { start, end, timezone: raw.timezone };
}

/** Strict validator: returns the normalized config (defaults filled) or null on anything invalid. */
export function hotLeadCallConfigOf(raw: unknown): HotLeadCallConfig | null {
  if (!isRecord(raw) || Object.keys(raw).some(k => !KEYS.has(k))) return null;
  if (typeof raw.enabled !== 'boolean') return null;

  const destinationPhone = allowlistedE164(raw.destinationPhone);
  if (!destinationPhone) return null;

  let destinationVerifiedAt: string | undefined;
  if (raw.destinationVerifiedAt !== undefined) {
    const at = raw.destinationVerifiedAt;
    if (typeof at !== 'string' || isNaN(Date.parse(at)) || new Date(at).toISOString() !== at) return null;
    destinationVerifiedAt = at;
  }
  let twilioNumber: string | undefined;
  if (raw.twilioNumber !== undefined) {
    twilioNumber = allowlistedE164(raw.twilioNumber) ?? undefined;
    if (!twilioNumber) return null;
  }
  let twilioNumberSid: string | undefined;
  if (raw.twilioNumberSid !== undefined) {
    if (typeof raw.twilioNumberSid !== 'string' || !TWILIO_SID.test(raw.twilioNumberSid)) return null;
    twilioNumberSid = raw.twilioNumberSid;
  }
  // The system would otherwise call itself.
  if (twilioNumber === destinationPhone) return null;

  const leadTypes = raw.leadTypes === undefined ? [...HOT_LEAD_CALL_DEFAULT_LEAD_TYPES] : raw.leadTypes;
  if (!isLeadTypes(leadTypes) || leadTypes.length === 0) return null;

  const limits = {} as Record<HotLeadCallLimitField, number>;
  for (const field of HOT_LEAD_CALL_LIMIT_FIELDS) {
    const value = limit(raw[field], field);
    if (value === null) return null;
    limits[field] = value;
  }

  if (typeof raw.announcedName !== 'string') return null;
  const announcedName = raw.announcedName.trim();
  if (!announcedName || announcedName.length > HOT_LEAD_CALL_ANNOUNCED_NAME_MAX || !ANNOUNCED_NAME.test(announcedName)) return null;

  let quietHours: HotLeadCallQuietHours | undefined;
  if (raw.quietHours !== undefined) {
    quietHours = quietHoursOf(raw.quietHours) ?? undefined;
    if (!quietHours) return null;
  }

  const allowedCountries = raw.allowedCountries === undefined ? [...HOT_LEAD_CALL_COUNTRIES] : raw.allowedCountries;
  if (!isCountries(allowedCountries)) return null;

  // A half-configured org may save disabled while it sets up, but never enabled.
  if (raw.enabled && (!destinationVerifiedAt || !twilioNumber || !quietHours)) return null;

  return {
    enabled: raw.enabled,
    destinationPhone,
    ...(destinationVerifiedAt ? { destinationVerifiedAt } : {}),
    ...(twilioNumber ? { twilioNumber } : {}),
    ...(twilioNumberSid ? { twilioNumberSid } : {}),
    leadTypes,
    ...limits,
    announcedName,
    ...(quietHours ? { quietHours } : {}),
    allowedCountries,
  };
}
