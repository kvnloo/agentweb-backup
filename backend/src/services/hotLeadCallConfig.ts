import { randomInt } from 'crypto';
import { parsePhoneNumberWithError } from 'libphonenumber-js';
import { toE164 } from './whatsappService';
import { isLeadTypes, type LeadOrigin } from './leadNotificationConfig';
import { isRecord } from './leadNotificationAttribution';

export const HOT_LEAD_CALL_COUNTRIES = ['US', 'CA'] as const;

/**
 * Canada is refused in code (callableLeadPhone -> country_not_allowed) whatever allowedCountries stores. CRTC ADAD rules
 * need an identification message with an email/postal address and a local or toll-free number, which we do not
 * implement. Re-enabling Canada needs (a) flipping this constant, (b) that identification message in the lead
 * prompt, and (c) a Canada branch in leadLocalHours.ts (it returns false for Canada today). The stored config,
 * default and validation are unchanged.
 */
export const HOT_LEAD_CALL_CA_ENABLED = false;

type HotLeadCallCountry = typeof HOT_LEAD_CALL_COUNTRIES[number];

const HOT_LEAD_CALL_DEFAULT_LEAD_TYPES: readonly LeadOrigin[] = ['form_fill'];
export const HOT_LEAD_CALL_DEFAULT_CALLING_HOURS = { start: '08:00', end: '21:00' } as const;
export const HOT_LEAD_CALL_ANNOUNCED_NAME_MAX = 60;
export const HOT_LEAD_CALL_MAX_TEAM_SIZE = 10;
export const HOT_LEAD_CALL_MAX_WINDOWS_PER_MEMBER = 7;
export const HOT_LEAD_CALL_MEMBER_NAME_MAX = 40;
/** The only time that is valid as a window end but not as a start: midnight at the end of the day. */
const END_OF_DAY = '24:00';

export const HOT_LEAD_CALL_LIMITS = {
  maxAgeMinutes: { default: 10, min: 1, max: 60 },
  // The two caps below count LEADS that get a call, not member calls: a lead can ring up to maxAttemptsPerLead
  // members and then the lead's own leg, and still uses one slot.
  maxCallsPerHour: { default: 6, min: 1, max: 30 },
  maxCallsPerDay: { default: 20, min: 1, max: 100 },
  // Leads that get a call in one org-local calendar month (ENG-2783). Stored values up to `max` are valid (an operator
  // raises a customer's limit by a data write); owner-level routes may only set up to HOT_LEAD_CALL_OWNER_MAX_CALLS_PER_MONTH.
  maxCallsPerMonth: { default: 150, min: 1, max: 2000 },
  memberCooldownMinutes: { default: 2, min: 1, max: 60 },
  /** Calls placed for one lead (each to a different team member) before giving up. */
  maxAttemptsPerLead: { default: 3, min: 1, max: 5 },
} as const;
/** The highest maxCallsPerMonth an owner (Emma tool, REST PUT) may set. Independent of the default (150, the included allowance): an owner may raise it to 200. Higher values are an operator's data write. */
export const HOT_LEAD_CALL_OWNER_MAX_CALLS_PER_MONTH = 200;
/**
 * Platform-wide ceiling (ENG-2783): leads that get a call per UTC day across ALL orgs. It bounds Twilio spend when a bug, an
 * abusive org or a spike gets past the per-org caps. 300 is a conservative starting value chosen by the builder (about
 * $45/day at an order-of-$0.15 per-lead estimate, not a measurement: two legs of about 5 minutes at the $0.014/min list rate, other costs excluded); it is the owner's to change via
 * HOT_LEAD_CALL_PLATFORM_DAILY_MAX, with no deploy of code.
 */
export const HOT_LEAD_CALL_PLATFORM_DAILY = { default: 300, min: 1, max: 100000 } as const;
const warnedPlatformValues = new Set<string>();

/** Parses HOT_LEAD_CALL_PLATFORM_DAILY_MAX: a positive integer (clamped to max); unset/blank -> default; anything else -> default with one warn per distinct value. */
export function parsePlatformDailyMax(raw: string | undefined): number {
  const { default: dflt, min, max } = HOT_LEAD_CALL_PLATFORM_DAILY;
  const text = raw?.trim();
  if (!text) return dflt;
  if (/^\d{1,15}$/.test(text)) {
    const n = Number(text);
    if (n >= min) return Math.min(n, max);
  }
  if (!warnedPlatformValues.has(text)) {
    warnedPlatformValues.add(text);
    console.warn(`[hotLeadCall] HOT_LEAD_CALL_PLATFORM_DAILY_MAX is not a positive integer, using ${dflt}`, { length: text.length });
  }
  return dflt;
}
/** The current platform daily cap (read per call so an env change on a long-lived process needs no code path). */
export const platformDailyMax = (): number => parsePlatformDailyMax(process.env.HOT_LEAD_CALL_PLATFORM_DAILY_MAX);
type HotLeadCallLimitField = keyof typeof HOT_LEAD_CALL_LIMITS;
export const HOT_LEAD_CALL_LIMIT_FIELDS = Object.keys(HOT_LEAD_CALL_LIMITS) as HotLeadCallLimitField[];

/**
 * Last 4 digits only: the form in which a phone number may appear in tool output. Distinct on purpose from
 * whatsappService.redactPhone (log lines, keeps the length) and orgLeadNotificationService.maskLeadPhone
 * (Slack text, formatted): this one has a fixed width so it reveals neither length nor country.
 */
export const maskPhone = (phone: string) => `***${phone.slice(-4)}`;

/** System-managed: set only by the number-provisioning / verification flow, never by Emma tools. */
export const HOT_LEAD_CALL_SYSTEM_FIELDS = ['twilioNumber', 'twilioNumberSid'] as const;

interface HotLeadCallCallingHours {
  /**
   * The window in which calls ARE allowed (24h HH:MM, local to `timezone`); outside it the system stays quiet.
   * start > end wraps past midnight, so consumers must handle both orders. The lead's own local hours are a separate gate (leadLocalHours.ts).
   */
  start: string;
  end: string;
  /** An IANA Area/Location name such as America/Chicago (UTC, abbreviations and Etc/ zones are refused); case is normalised. */
  timezone: string;
}

/** One weekly availability slot of a member, read on the callingHours clock. */
export interface HotLeadCallWindow {
  /** 0 = Sunday .. 6 = Saturday, unique, 1..7 entries. */
  days: number[];
  /** HH:MM, inclusive. */
  start: string;
  /** HH:MM or 24:00, exclusive; always after start. A window never wraps midnight: overnight is two windows. */
  end: string;
}

export interface HotLeadCallMember {
  /** Server-generated (see generateMemberId); stable across edits so cooldowns and call records can refer to it. */
  id: string;
  /** Read in tool output and the portal only; never spoken on a call. */
  name: string;
  /** E.164, US/CA only (other +1 territories such as Puerto Rico or Guam are refused). */
  phone: string;
  /**
   * System-managed. Any writer (the verification flow) must write conditionally on this member's phone still
   * equalling the verified phone, and must validate the result through hotLeadCallConfigOf.
   */
  verifiedAt?: string;
  windows: HotLeadCallWindow[];
}

export interface HotLeadCallConfig {
  enabled: boolean;
  /** 1..HOT_LEAD_CALL_MAX_TEAM_SIZE people to ring; the order is the priority (first is rung first). */
  team: HotLeadCallMember[];
  twilioNumber?: string;
  twilioNumberSid?: string;
  leadTypes: LeadOrigin[];
  maxAgeMinutes: number;
  maxCallsPerHour: number;
  maxCallsPerDay: number;
  /** Leads that get a call per org-local calendar month; absent in stored configs from before ENG-2783, which read as the default. */
  maxCallsPerMonth: number;
  memberCooldownMinutes: number;
  maxAttemptsPerLead: number;
  /** Spoken aloud inside TwiML, hence the restricted charset. */
  announcedName: string;
  /** Required before the config can be enabled. Also the clock that member windows are read on. */
  callingHours?: HotLeadCallCallingHours;
  allowedCountries: HotLeadCallCountry[];
}

const KEYS: ReadonlySet<string> = new Set([
  'enabled', 'team', 'twilioNumber', 'twilioNumberSid', 'leadTypes',
  ...HOT_LEAD_CALL_LIMIT_FIELDS, 'announcedName', 'callingHours', 'allowedCountries',
]);
const CALLING_HOURS_KEYS: ReadonlySet<string> = new Set(['start', 'end', 'timezone']);
const MEMBER_KEYS: ReadonlySet<string> = new Set(['id', 'name', 'phone', 'verifiedAt', 'windows']);
const WINDOW_KEYS: ReadonlySet<string> = new Set(['days', 'start', 'end']);
export const MEMBER_ID = /^m[a-z0-9]{7}$/;
// Shown in the portal and in tool output, never spoken, but kept as strict as the announced name.
const MEMBER_NAME = /^[\p{L}\p{N} .,'&-]+$/u;
// SECURITY: this text is spoken inside TwiML <Say>. '&' is deliberately allowed ('Smith & Sons'),
// so the TwiML builder MUST XML-escape announcedName before interpolating it.
const ANNOUNCED_NAME = /^[\p{L}\p{N} .,&'-]+$/u;
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isHhmm = (v: unknown): v is string => typeof v === 'string' && HHMM.test(v);
const TWILIO_SID = /^PN[0-9a-f]{32}$/;

/** Whether a stored value looks like a Twilio phone-number sid. */
export const isTwilioNumberSid = (v: unknown): v is string => typeof v === 'string' && TWILIO_SID.test(v);

// Area/Location only: UTC, abbreviations (EST), offsets and Etc/ zones are not a place whose local clock gates
// calls. Intl folds case and resolves aliases, so we store the name it resolves to.
export function normalizeTimezone(tz: unknown): string | null {
  if (typeof tz !== 'string' || !/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/.test(tz) || /^etc\//i.test(tz)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// Types that bill the caller (toll fraud: premium, toll-free, shared-cost, personal, UAN) or are not a
// person's direct line. The default (min) metadata does classify US/CA toll-free (800/844/...), premium
// (900) and personal (500/533/522) numbers, but it cannot tell VOIP from fixed or mobile in the US (only
// Canadian 600 numbers come back as VOIP), so US Google-Voice-style numbers still pass. Only a positive
// match rejects: the min metadata returns undefined for types it cannot tell apart.
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

/**
 * The number to ring for a lead, from the lead row's raw phone. National-format numbers are parsed as US
 * (forms for US/CA carry no '+1'); anything that resolves to another country or a blocked number type is
 * refused, as is a country outside this org's allowedCountries (a strict subset of the global US/CA list) and Canada
 * while HOT_LEAD_CALL_CA_ENABLED is false.
 * Shared by the call orchestrator's gates and the voice webhooks, which re-check at bridge time.
 */
export function callableLeadPhone(
  rawPhone: unknown,
  config: Pick<HotLeadCallConfig, 'allowedCountries'>,
): { phone: string } | { reason: 'invalid_phone' | 'country_not_allowed' } {
  const e164 = typeof rawPhone === 'string' ? toE164(rawPhone, 'US') : null;
  const phone = e164 ? allowlistedE164(e164) : null;
  if (!phone) return { reason: 'invalid_phone' };
  let country: string | undefined;
  try { country = parsePhoneNumberWithError(phone).country; } catch { country = undefined; }
  if (country === 'CA' && !HOT_LEAD_CALL_CA_ENABLED) return { reason: 'country_not_allowed' };
  return country && config.allowedCountries.some(c => c === country) ? { phone } : { reason: 'country_not_allowed' };
}

const isCountries = (v: unknown): v is HotLeadCallCountry[] =>
  Array.isArray(v) && v.length > 0 && new Set(v).size === v.length &&
  v.every(c => (HOT_LEAD_CALL_COUNTRIES as readonly unknown[]).includes(c));

function limit(raw: unknown, field: HotLeadCallLimitField): number | null {
  const { default: dflt, min, max } = HOT_LEAD_CALL_LIMITS[field];
  if (raw === undefined) return dflt;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max ? raw : null;
}

/** Minutes since local midnight of a local-time reading (hour and minute). */
export const minutesOfDay = (l: { hour: number; minute: number }): number => l.hour * 60 + l.minute;

/** Minutes since local midnight of an HH:MM (or 24:00) string that already passed validation. */
export const hhmmToMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function callingHoursOf(raw: unknown): HotLeadCallCallingHours | null {
  if (!isRecord(raw) || Object.keys(raw).some(k => !CALLING_HOURS_KEYS.has(k))) return null;
  const start = raw.start === undefined ? HOT_LEAD_CALL_DEFAULT_CALLING_HOURS.start : raw.start;
  const end = raw.end === undefined ? HOT_LEAD_CALL_DEFAULT_CALLING_HOURS.end : raw.end;
  if (!isHhmm(start) || !isHhmm(end) || start === end) return null;
  const timezone = normalizeTimezone(raw.timezone);
  return timezone ? { start, end, timezone } : null;
}

interface WindowProblem {
  /** The field the problem concerns; '' for the window as a whole. */
  field: '' | 'days' | 'start' | 'end';
  message: string;
}

/** The one validator of an availability window: the window, or its first problem worded for the person who typed it. */
export function checkWindow(raw: unknown): { window: HotLeadCallWindow } | WindowProblem {
  if (!isRecord(raw)) return { field: '', message: 'Each availability window must be an object' };
  if (Object.keys(raw).some(k => !WINDOW_KEYS.has(k))) return { field: '', message: 'Unknown field in an availability window' };
  const { days, start, end } = raw;
  if (!Array.isArray(days) || days.length < 1 || days.length > 7 || new Set(days).size !== days.length
    || !days.every(d => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)) {
    return { field: 'days', message: 'Pick between 1 and 7 different days (0 = Sunday to 6 = Saturday)' };
  }
  if (!isHhmm(start)) return { field: 'start', message: 'Start must be a time such as 09:00' };
  if (!(isHhmm(end) || end === END_OF_DAY)) return { field: 'end', message: 'End must be a time such as 17:00, or 24:00 for the end of the day' };
  if (hhmmToMinutes(start) >= hhmmToMinutes(end)) return { field: 'end', message: 'End must be after start; an overnight shift is two windows' };
  return { window: { days: [...days], start, end } };
}

function windowOf(raw: unknown): HotLeadCallWindow | null {
  const checked = checkWindow(raw);
  return 'window' in checked ? checked.window : null;
}

/** The trimmed member name, or null when it is empty, too long or has characters outside the allowed set. */
export function memberNameOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name && name.length <= HOT_LEAD_CALL_MEMBER_NAME_MAX && MEMBER_NAME.test(name) ? name : null;
}

/** The trimmed spoken business name, or null when it is empty, too long or has characters outside the allowed set. */
export function announcedNameOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name && name.length <= HOT_LEAD_CALL_ANNOUNCED_NAME_MAX && ANNOUNCED_NAME.test(name) ? name : null;
}

function memberOf(raw: unknown): HotLeadCallMember | null {
  if (!isRecord(raw) || Object.keys(raw).some(k => !MEMBER_KEYS.has(k))) return null;
  if (typeof raw.id !== 'string' || !MEMBER_ID.test(raw.id)) return null;
  const name = memberNameOf(raw.name);
  if (!name) return null;
  const phone = allowlistedE164(raw.phone);
  if (!phone) return null;
  let verifiedAt: string | undefined;
  if (raw.verifiedAt !== undefined) {
    const at = raw.verifiedAt;
    if (typeof at !== 'string' || isNaN(Date.parse(at)) || new Date(at).toISOString() !== at) return null;
    verifiedAt = at;
  }
  if (!Array.isArray(raw.windows) || raw.windows.length < 1 || raw.windows.length > HOT_LEAD_CALL_MAX_WINDOWS_PER_MEMBER) return null;
  const windows: HotLeadCallWindow[] = [];
  for (const w of raw.windows) {
    const window = windowOf(w);
    if (!window) return null;
    windows.push(window);
  }
  return { id: raw.id, name, phone, ...(verifiedAt ? { verifiedAt } : {}), windows };
}

function teamOf(raw: unknown): HotLeadCallMember[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > HOT_LEAD_CALL_MAX_TEAM_SIZE) return null;
  const team: HotLeadCallMember[] = [];
  for (const m of raw) {
    const member = memberOf(m);
    if (!member) return null;
    team.push(member);
  }
  // Ids name a member in call records and cooldown keys; a shared phone would ring one person twice per lead.
  if (new Set(team.map(m => m.id)).size !== team.length || new Set(team.map(m => m.phone)).size !== team.length) return null;
  return team;
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** A fresh member id (crypto random, lowercase base36) that is not in `existing`. */
export function generateMemberId(existing: readonly string[] = []): string {
  for (;;) {
    let id = 'm';
    for (let i = 0; i < 7; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
    if (!existing.includes(id)) return id;
  }
}

/**
 * Strict validator: returns the normalized config (defaults filled) or null on anything invalid.
 * A null for a STORED config means the consumer must skip the call and fall back to the Slack alert.
 */
export function hotLeadCallConfigOf(raw: unknown): HotLeadCallConfig | null {
  if (!isRecord(raw) || Object.keys(raw).some(k => !KEYS.has(k))) return null;
  if (typeof raw.enabled !== 'boolean') return null;

  const team = teamOf(raw.team);
  if (!team) return null;

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
  if (twilioNumber && team.some(m => m.phone === twilioNumber)) return null;

  const leadTypes = raw.leadTypes === undefined ? [...HOT_LEAD_CALL_DEFAULT_LEAD_TYPES] : raw.leadTypes;
  if (!isLeadTypes(leadTypes) || leadTypes.length === 0) return null;

  const limits = {} as Record<HotLeadCallLimitField, number>;
  for (const field of HOT_LEAD_CALL_LIMIT_FIELDS) {
    const value = limit(raw[field], field);
    if (value === null) return null;
    limits[field] = value;
  }

  const announcedName = announcedNameOf(raw.announcedName);
  if (!announcedName) return null;

  let callingHours: HotLeadCallCallingHours | undefined;
  if (raw.callingHours !== undefined) {
    callingHours = callingHoursOf(raw.callingHours) ?? undefined;
    if (!callingHours) return null;
  }

  const allowedCountries = raw.allowedCountries === undefined ? [...HOT_LEAD_CALL_COUNTRIES] : raw.allowedCountries;
  if (!isCountries(allowedCountries)) return null;

  // A half-configured org may save disabled while it sets up, but never enabled. Every member has a window
  // (the member validator requires one), so a verified member is a reachable one.
  if (raw.enabled && (!team.some(m => m.verifiedAt) || !twilioNumber || !callingHours)) return null;

  return {
    enabled: raw.enabled,
    team,
    ...(twilioNumber ? { twilioNumber } : {}),
    ...(twilioNumberSid ? { twilioNumberSid } : {}),
    leadTypes,
    ...limits,
    announcedName,
    ...(callingHours ? { callingHours } : {}),
    allowedCountries,
  };
}
