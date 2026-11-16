import crypto from 'crypto';
import { parsePhoneNumberWithError } from 'libphonenumber-js';
import { orgDb, type Organization } from './db';
import { can } from './orgAuthz';
import { toE164 } from './whatsappService';
import { isLeadTypes } from './leadNotificationConfig';
import { isRecord } from './leadNotificationAttribution';
import {
  allowlistedE164, announcedNameOf, generateMemberId, hhmmToMinutes, hotLeadCallConfigOf, maskPhone, memberNameOf, normalizeTimezone,
  checkWindow, isHhmm, HOT_LEAD_CALL_CA_ENABLED, HOT_LEAD_CALL_COUNTRIES, HOT_LEAD_CALL_LIMITS, HOT_LEAD_CALL_OWNER_MAX_CALLS_PER_MONTH, HOT_LEAD_CALL_LIMIT_FIELDS, HOT_LEAD_CALL_MAX_TEAM_SIZE,
  HOT_LEAD_CALL_MAX_WINDOWS_PER_MEMBER, HOT_LEAD_CALL_MEMBER_NAME_MAX, HOT_LEAD_CALL_ANNOUNCED_NAME_MAX, HOT_LEAD_CALL_SYSTEM_FIELDS,
  type HotLeadCallConfig, type HotLeadCallMember,
} from './hotLeadCallConfig';
import { previewHotLeadCallCandidates } from './hotLeadCallRoster';
import {
  ConflictError, ForbiddenError, NotEntitledError, NotFoundError, RevisionRequiredError, StoredStateInvalidError, UnattendedRunError,
  ValidationError, VerificationCodeError,
} from './hotLeadCallErrors';
import {
  HOT_LEAD_CALL_SUBSCRIBE_MESSAGE, isHotLeadCallBillingActive, isHotLeadCallBillingRequired, isHotLeadCallPlanEntitled,
} from './voice/hotLeadCallEntitlement';
import { isConditionalFailure, unchangedSince } from './voice/setupWrites';
import {
  confirmVerification, startVerification, verificationAfterTeamEdit, verificationStateOf, VERIFICATION_MAX_ATTEMPTS,
} from './voice/memberVerification';
import { isWithinCallWindow } from './voice/hotLeadCallLimits';
import { callingHoursReachLeadWindow, isLeadWindowOpenNow } from './voice/leadLocalHours';

/**
 * The one implementation of "read and change a business's hot-lead-call settings", shared by the REST routes
 * (routes/orgHotLeadCall.ts) and the Emma tools (emma/hotLeadCallTools.ts, emma/hotLeadCallSetupTools.ts).
 * Callers translate the typed errors of hotLeadCallErrors.ts into their own surface; nothing here knows about HTTP.
 *
 * Phones leave this module only masked, and the verification fields of a member (verifiedAt, codes) are
 * written only by the verification flow: a body that carries them is refused.
 */

export interface HotLeadCallCaller {
  userId: string;
  orgRole?: string;
  /** True for a scheduled or otherwise unattended agent run: changes that spend more or reach more people are refused. */
  unattended?: boolean;
}

export interface HotLeadCallSettingsDto {
  _revision: string;
  entitled: boolean;
  enabled: boolean;
  canEnable: boolean;
  blockers: string[];
  callingHours: { start: string; end: string; timezone: string } | null;
  maxAttemptsPerLead: number;
  /** Automatic calls allowed per calendar month; a value above the owner maximum is shown as stored (an operator set it). */
  maxCallsPerMonth: number;
  /** Plain-language notes that do not block enabling, e.g. a stored country that is not called yet. */
  warnings: string[];
  announcedName: string;
  twilioNumberMasked: string | null;
  team: Array<{ id: string; name: string; phoneMasked: string; verified: boolean; windows: Array<{ days: number[]; start: string; end: string }> }>;
  limits: { maxTeamSize: number; maxWindowsPerMember: number; minAttempts: number; maxAttempts: number; nameMaxLength: number };
}

interface HotLeadCallPreviewDto {
  at: string;
  timezone: string | null;
  outsideCallingHours: boolean;
  /** True when the lead's own window (10:00-18:00 local, judged for an ordinary US number) is closed at `at`. */
  outsideLeadHours: boolean;
  /** The first gate that would stop a call at `at`, named like the lead timeline's skip reason; null when neither hours gate does. */
  skipReason: 'outside_calling_hours' | 'outside_lead_hours' | null;
  warnings: string[];
  candidates: Array<{ id: string; name: string }>;
  excluded: Array<{ id: string; name: string; reason: 'unverified' | 'outside_window' }>;
}

/** Keys the REST body may carry. */
export const REST_SETTINGS_KEYS = ['_revision', 'enabled', 'callingHours', 'maxAttemptsPerLead', 'maxCallsPerMonth', 'announcedName', 'team'] as const;
/** Further scalar settings that only the Emma tool edits (the portal has no control for them). */
const TOOL_ONLY_SETTINGS_KEYS = ['leadTypes', 'maxAgeMinutes', 'maxCallsPerHour', 'maxCallsPerDay', 'memberCooldownMinutes', 'allowedCountries'] as const;
// Keys applied by their own logic rather than copied over the stored config.
const HANDLED_KEYS = ['_revision', 'enabled', 'team', 'callingHours'];
const TEAM_ENTRY_KEYS = ['id', 'name', 'phone', 'windows'] as const;

export const BLOCKER_NOT_ENTITLED = 'Your plan does not include hot-lead calls';
export const BLOCKER_NO_VERIFIED_PERSON = 'Add at least one person and verify their phone';
export const BLOCKER_UNVERIFIED = 'Verify the phone of at least one person';
export const BLOCKER_NO_HOURS = 'Set calling hours';
export const BLOCKER_NO_NUMBER = 'A phone number for calls has not been set up yet (ask Emma)';
export const BLOCKER_NO_CALLABLE_COUNTRY = 'None of the allowed countries can be called yet (Canadian numbers are not called yet); allow the United States';
export const BLOCKER_NO_LEAD_OVERLAP = 'Calling hours must include some time between about 13:00 and 18:00 Eastern, the hours when leads can be called; as set, no lead could ever be called';
export const WARNING_CANADA_NOT_CALLED = 'Canadian numbers are not called yet; leads with a Canadian number are skipped even though Canada is allowed here';
export const OWNER_MONTHLY_LIMIT_REFUSAL = 'Higher monthly limits are set by AgentWeb support';

/** The stored countries that can be dialled today: Canada is refused in code while HOT_LEAD_CALL_CA_ENABLED is false. */
const callableCountries = (config: Pick<HotLeadCallConfig, 'allowedCountries'>): string[] =>
  config.allowedCountries.filter(c => c !== 'CA' || HOT_LEAD_CALL_CA_ENABLED);

function warningsOf(config: HotLeadCallConfig | undefined): string[] {
  return config && !HOT_LEAD_CALL_CA_ENABLED && config.allowedCountries.includes('CA') ? [WARNING_CANADA_NOT_CALLED] : [];
}

/**
 * Reasons a config that is otherwise complete could never place a call. Shown in the read-out for every org (an enabled org
 * that is silently skipping every lead must see why) but only an explicit turn-on is refused for them: a benign edit of an
 * already-enabled org is not turned off by them.
 */
function effectiveBlockersOf(config: HotLeadCallConfig | undefined): string[] {
  if (!config) return [];
  const blockers: string[] = [];
  if (callableCountries(config).length === 0) blockers.push(BLOCKER_NO_CALLABLE_COUNTRY);
  if (config.callingHours && !callingHoursReachLeadWindow(config.callingHours)) blockers.push(BLOCKER_NO_LEAD_OVERLAP);
  return blockers;
}

// ---- revision ------------------------------------------------------------------------------------------------

/** Key-order independent JSON: equal values give equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Identifies one exact stored config: the SHA-256 of its canonical JSON (keys sorted, so the order DynamoDB
 * returns them in never matters). An org without settings has the revision of `null`. It covers system-managed
 * fields too, so a verification, a number purchase or another editor's save all make an old copy stale.
 */
export function hotLeadCallRevisionOf(storedConfig: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(storedConfig ?? null)).digest('hex');
}

// ---- reading ------------------------------------------------------------------------------------------------

function requireConfigure(org: Organization, caller: HotLeadCallCaller): void {
  if (!can({ userId: caller.userId, orgId: org.orgId, orgRole: caller.orgRole }, org, 'org:configure')) {
    throw new ForbiddenError('Only org owners and admins can use hot lead call settings');
  }
}

/** The stored config validated, undefined when the org has none. A stored value that no longer validates fails closed. */
export function storedHotLeadCallConfig(org: Pick<Organization, 'hotLeadCall'>): HotLeadCallConfig | undefined {
  if (org.hotLeadCall === undefined) return undefined;
  const config = hotLeadCallConfigOf(org.hotLeadCall);
  if (!config) throw new StoredStateInvalidError('Stored hot lead call settings are invalid');
  return config;
}

/** Plain-English reasons enabling is not possible yet, in the order the person should fix them. */
function blockersOf(config: HotLeadCallConfig | undefined, entitled: boolean, needsAddon: boolean): string[] {
  const blockers: string[] = [];
  if (!entitled) blockers.push(BLOCKER_NOT_ENTITLED);
  // The plan includes the feature but the paid add-on is not active: say how to get it (the portal cannot buy it).
  else if (needsAddon) blockers.push(HOT_LEAD_CALL_SUBSCRIBE_MESSAGE);
  if (!config?.team.length) blockers.push(BLOCKER_NO_VERIFIED_PERSON);
  else if (!config.team.some(m => m.verifiedAt)) blockers.push(BLOCKER_UNVERIFIED);
  if (!config?.callingHours) blockers.push(BLOCKER_NO_HOURS);
  if (!config?.twilioNumber) blockers.push(BLOCKER_NO_NUMBER);
  return blockers;
}

/** `entitled` is the PLAN check; `needsAddon` is true when the plan has the feature but the required paid add-on is not active. */
function toDto(org: Pick<Organization, 'hotLeadCall'>, config: HotLeadCallConfig | undefined, entitled: boolean, needsAddon = false): HotLeadCallSettingsDto {
  const blockers = [...blockersOf(config, entitled, needsAddon), ...effectiveBlockersOf(config)];
  return {
    _revision: hotLeadCallRevisionOf(org.hotLeadCall),
    entitled,
    enabled: config?.enabled ?? false,
    canEnable: blockers.length === 0,
    blockers,
    callingHours: config?.callingHours ? { ...config.callingHours } : null,
    maxAttemptsPerLead: config?.maxAttemptsPerLead ?? HOT_LEAD_CALL_LIMITS.maxAttemptsPerLead.default,
    maxCallsPerMonth: config?.maxCallsPerMonth ?? HOT_LEAD_CALL_LIMITS.maxCallsPerMonth.default,
    warnings: warningsOf(config),
    announcedName: config?.announcedName ?? '',
    twilioNumberMasked: config?.twilioNumber ? maskPhone(config.twilioNumber) : null,
    team: (config?.team ?? []).map(m => ({
      id: m.id, name: m.name, phoneMasked: maskPhone(m.phone), verified: !!m.verifiedAt,
      windows: m.windows.map(w => ({ days: [...w.days], start: w.start, end: w.end })),
    })),
    limits: {
      maxTeamSize: HOT_LEAD_CALL_MAX_TEAM_SIZE,
      maxWindowsPerMember: HOT_LEAD_CALL_MAX_WINDOWS_PER_MEMBER,
      minAttempts: HOT_LEAD_CALL_LIMITS.maxAttemptsPerLead.min,
      maxAttempts: HOT_LEAD_CALL_LIMITS.maxAttemptsPerLead.max,
      nameMaxLength: HOT_LEAD_CALL_MEMBER_NAME_MAX,
    },
  };
}

export async function getHotLeadCallSettings(org: Organization, caller: HotLeadCallCaller): Promise<HotLeadCallSettingsDto> {
  requireConfigure(org, caller);
  const planEntitled = await isHotLeadCallPlanEntitled(org);
  return toDto(org, storedHotLeadCallConfig(org), planEntitled, planEntitled && !await isHotLeadCallBillingActive(org));
}

export async function previewHotLeadCallSettings(org: Organization, caller: HotLeadCallCaller, at: Date): Promise<HotLeadCallPreviewDto> {
  requireConfigure(org, caller);
  const config = storedHotLeadCallConfig(org);
  const outsideLeadHours = !isLeadWindowOpenNow(at);
  if (!config) {
    return { at: at.toISOString(), timezone: null, outsideCallingHours: true, outsideLeadHours, skipReason: 'outside_calling_hours', warnings: [], candidates: [], excluded: [] };
  }
  const entries = previewHotLeadCallCandidates(config, at);
  // With no calling hours nobody is rung, so the portal is told the same as for a closed business.
  const outsideCallingHours = !isWithinCallWindow(config.callingHours, at);
  return {
    at: at.toISOString(),
    timezone: config.callingHours?.timezone ?? null,
    outsideCallingHours,
    outsideLeadHours,
    skipReason: outsideCallingHours ? 'outside_calling_hours' : outsideLeadHours ? 'outside_lead_hours' : null,
    warnings: warningsOf(config),
    candidates: entries.filter(e => !e.reason).map(e => ({ id: e.member.id, name: e.member.name })),
    excluded: entries.filter(e => e.reason).map(e => ({
      id: e.member.id, name: e.member.name, reason: e.reason === 'unverified' ? 'unverified' : 'outside_window',
    })),
  };
}

// ---- verification ----------------------------------------------------------------------------------------

function configOrNoMember(org: Organization): HotLeadCallConfig {
  const config = storedHotLeadCallConfig(org);
  if (!config) throw new NotFoundError('That team member does not exist. Save the hot lead call settings first.');
  return config;
}

export async function startMemberVerification(org: Organization, caller: HotLeadCallCaller, memberId: string | undefined) {
  requireConfigure(org, caller);
  if (!await isHotLeadCallPlanEntitled(org)) throw new NotEntitledError();
  return startVerification(org, configOrNoMember(org), caller.userId, memberId);
}

export async function confirmMemberVerification(org: Organization, caller: HotLeadCallCaller, memberId: string | undefined, code: unknown) {
  requireConfigure(org, caller);
  const config = configOrNoMember(org);
  const digits = typeof code === 'string' ? code.replace(/[\s-]/g, '') : '';
  if (!/^\d{6}$/.test(digits)) {
    const pending = memberId === undefined ? undefined : verificationStateOf(org.hotLeadCallVerification)?.members[memberId];
    throw new VerificationCodeError('The code is 6 digits', pending?.codeHash ? Math.max(0, VERIFICATION_MAX_ATTEMPTS - pending.attempts) : 0);
  }
  return confirmVerification(org, config, digits, memberId);
}

// ---- updating ------------------------------------------------------------------------------------------------

type Errors = Record<string, string>;

const MEMBER_NAME_HELP = `Use 1 to ${HOT_LEAD_CALL_MEMBER_NAME_MAX} characters: letters, digits, spaces and . , ' & - only`;
const PHONE_HELP = 'Enter a valid US or Canadian phone number without an extension';

function hasExtension(raw: string): boolean {
  try {
    return !!parsePhoneNumberWithError(raw, 'US').ext;
  } catch {
    return false;
  }
}

/** E.164 of a US/CA number typed in any common format, or null. Extensions are refused: toE164 would silently drop them. */
function phoneOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 40 || hasExtension(raw)) return null;
  const e164 = toE164(raw, 'US');
  return e164 ? allowlistedE164(e164) : null;
}

interface TeamBuild {
  stored: Map<string, HotLeadCallMember>;
  usedIds: string[];
  /** Stored ids already claimed by an earlier entry of this update. */
  seen: Set<string>;
}

/** One submitted person as a member, or null after recording every problem with it in `errors`. */
function parseTeamEntry(entry: unknown, i: number, build: TeamBuild, errors: Errors): HotLeadCallMember | null {
  const at = (field: string) => `team.${i}.${field}`;
  let failed = false;
  const fail = (path: string, message: string) => { errors[path] = message; failed = true; };
  if (!isRecord(entry)) { fail(`team.${i}`, 'Each person must be an object'); return null; }
  for (const key of Object.keys(entry)) {
    if (!(TEAM_ENTRY_KEYS as readonly string[]).includes(key)) fail(at(key), key === 'verifiedAt' ? 'Verification is managed by the system and cannot be set here' : 'Unknown field');
  }

  let existing: HotLeadCallMember | undefined;
  if (entry.id !== undefined) {
    existing = typeof entry.id === 'string' ? build.stored.get(entry.id) : undefined;
    if (!existing) fail(at('id'), 'Unknown person: reload the settings and try again');
    else if (build.seen.has(existing.id)) fail(at('id'), 'This person is listed twice');
    else build.seen.add(existing.id);
  }

  const name = memberNameOf(entry.name);
  if (!name) fail(at('name'), MEMBER_NAME_HELP);

  let phone: string | null = null;
  if (entry.phone !== undefined) {
    phone = phoneOf(entry.phone);
    if (!phone) fail(at('phone'), PHONE_HELP);
  } else if (existing) {
    phone = existing.phone;
  } else if (entry.id === undefined) {
    fail(at('phone'), 'A phone number is required for a new person');
  }

  const windows: HotLeadCallMember['windows'] = [];
  if (!Array.isArray(entry.windows) || entry.windows.length < 1 || entry.windows.length > HOT_LEAD_CALL_MAX_WINDOWS_PER_MEMBER) {
    fail(at('windows'), `Add between 1 and ${HOT_LEAD_CALL_MAX_WINDOWS_PER_MEMBER} availability windows`);
  } else {
    entry.windows.forEach((w, j) => {
      const checked = checkWindow(w);
      if ('window' in checked) windows.push(checked.window);
      else fail(`${at('windows')}.${j}${checked.field ? `.${checked.field}` : ''}`, checked.message);
    });
  }

  if (failed || !name || !phone) return null;
  const id = existing?.id ?? generateMemberId(build.usedIds);
  if (!existing) build.usedIds.push(id);
  // A phone that is kept stays verified; a different one starts unverified.
  const verifiedAt = existing && existing.phone === phone ? existing.verifiedAt : undefined;
  return { id, name, phone, ...(verifiedAt ? { verifiedAt } : {}), windows };
}

/** Members after this update, in the order given. Existing ids keep their stored phone and verification unless the phone changes. */
function buildTeam(rawTeam: unknown, current: HotLeadCallConfig | undefined, errors: Errors): HotLeadCallMember[] | undefined {
  if (!Array.isArray(rawTeam)) { errors.team = 'team must be a list of people'; return undefined; }
  if (rawTeam.length < 1) { errors.team = 'Add at least one person'; return undefined; }
  if (rawTeam.length > HOT_LEAD_CALL_MAX_TEAM_SIZE) { errors.team = `A team has at most ${HOT_LEAD_CALL_MAX_TEAM_SIZE} people`; return undefined; }

  const stored = new Map((current?.team ?? []).map(m => [m.id, m]));
  const build: TeamBuild = { stored, usedIds: [...stored.keys()], seen: new Set() };
  const team: HotLeadCallMember[] = [];
  let failed = false;
  const fail = (path: string, message: string) => { errors[path] = message; failed = true; };
  rawTeam.forEach((entry, i) => {
    const member = parseTeamEntry(entry, i, build, errors);
    if (member) team.push(member);
    else failed = true;
  });

  // Ids name a member in call records, and a shared phone would ring one person twice per lead.
  const indexByPhone = new Map<string, number>();
  team.forEach((m, i) => {
    if (indexByPhone.has(m.phone)) fail(`team.${i}.phone`, 'Another person already has this phone number');
    else indexByPhone.set(m.phone, i);
    if (current?.twilioNumber === m.phone) fail(`team.${i}.phone`, 'This is the number calls are placed from; enter the person\'s own phone');
  });
  return failed ? undefined : team;
}

function callingHoursProblems(raw: unknown, errors: Errors): void {
  if (!isRecord(raw)) { errors.callingHours = 'callingHours must have start, end and timezone'; return; }
  for (const key of Object.keys(raw)) if (key !== 'start' && key !== 'end' && key !== 'timezone') errors[`callingHours.${key}`] = 'Unknown field';
  if (!isHhmm(raw.start)) errors['callingHours.start'] = 'Start must be a time such as 09:00';
  if (!isHhmm(raw.end)) errors['callingHours.end'] = 'End must be a time such as 18:00';
  else if (raw.end === raw.start) errors['callingHours.end'] = 'End must differ from start';
  if (!normalizeTimezone(raw.timezone)) {
    errors['callingHours.timezone'] = 'Use a place name such as America/Chicago; UTC, abbreviations and Etc/ zones are not accepted';
  }
}

function scalarProblems(body: Record<string, unknown>, errors: Errors): void {
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') errors.enabled = 'enabled must be true or false';
  if (body.announcedName !== undefined && !announcedNameOf(body.announcedName)) {
    errors.announcedName = `Enter the business's registered (legal) name: it is the name the lead hears as the caller. Use 1 to ${HOT_LEAD_CALL_ANNOUNCED_NAME_MAX} characters: letters, digits, spaces and . , & ' - only`;
  }
  if (body.callingHours !== undefined) callingHoursProblems(body.callingHours, errors);
  for (const field of HOT_LEAD_CALL_LIMIT_FIELDS) {
    const value = body[field];
    const { min, max } = HOT_LEAD_CALL_LIMITS[field];
    // An operator may store up to the table maximum; the owner routes stop at HOT_LEAD_CALL_OWNER_MAX_CALLS_PER_MONTH (see the check in applyHotLeadCallSettings).
    if (field === 'maxCallsPerMonth' && typeof value === 'number' && Number.isInteger(value) && value > HOT_LEAD_CALL_OWNER_MAX_CALLS_PER_MONTH && value <= max) continue;
    if (value !== undefined && !(typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max)) {
      errors[field] = `${field} must be a whole number from ${min} to ${max}`;
    }
  }
  if (body.leadTypes !== undefined && !(isLeadTypes(body.leadTypes) && body.leadTypes.length > 0)) errors.leadTypes = 'leadTypes must list at least one known lead type';
  const countries = body.allowedCountries;
  if (countries !== undefined && !(Array.isArray(countries) && countries.length > 0 && new Set(countries).size === countries.length
    && countries.every(c => (HOT_LEAD_CALL_COUNTRIES as readonly unknown[]).includes(c)))) {
    errors.allowedCountries = `allowedCountries must be a subset of ${HOT_LEAD_CALL_COUNTRIES.join(', ')}`;
  }
}

const minutesCovered = (hours: { start: string; end: string }): Set<number> => {
  const start = hhmmToMinutes(hours.start);
  const end = hhmmToMinutes(hours.end);
  const covered = new Set<number>();
  for (let m = 0; m < 24 * 60; m++) if (start < end ? m >= start && m < end : m >= start || m < end) covered.add(m);
  return covered;
};

const teamKey = (team: readonly HotLeadCallMember[]) => JSON.stringify(team.map(m => [m.id, m.name, m.phone, m.windows]));

/**
 * Why `next` is a step up from `current` in what the system may spend or whom it may call, or null when it is
 * not. An unattended run must not take such a step: its instructions may have come from a prompt-injected page.
 */
function escalationOf(current: HotLeadCallConfig | undefined, next: HotLeadCallConfig): string | null {
  if (!current) return 'setting up hot lead calls';
  if (next.enabled && !current.enabled) return 'turning hot lead calls on';
  const raised = (['maxAgeMinutes', 'maxCallsPerHour', 'maxCallsPerDay', 'maxCallsPerMonth', 'maxAttemptsPerLead'] as const).find(f => next[f] > current[f]);
  if (raised) return `raising ${raised}`;
  if (next.memberCooldownMinutes < current.memberCooldownMinutes) return 'shortening the pause between calls to one person';
  if (next.leadTypes.some(t => !current.leadTypes.includes(t)) || next.allowedCountries.some(c => !current.allowedCountries.includes(c))) {
    return 'calling more kinds of leads or more countries';
  }
  if (next.callingHours) {
    const before = current.callingHours;
    if (!before || before.timezone !== next.callingHours.timezone) return 'changing the calling hours';
    const allowed = minutesCovered(before);
    for (const m of minutesCovered(next.callingHours)) if (!allowed.has(m)) return 'widening the calling hours';
  }
  // The business name is read aloud to the lead and the member, so a new one is a new thing to say to strangers.
  if (next.announcedName !== current.announcedName) return 'changing the business name';
  if (teamKey(next.team) !== teamKey(current.team)) return 'changing the team';
  return null;
}

function checkKeys(body: Record<string, unknown>): void {
  for (const key of Object.keys(body)) {
    if ((HOT_LEAD_CALL_SYSTEM_FIELDS as readonly string[]).includes(key)) throw new ValidationError(`${key} is managed by the system and cannot be set here`, { [key]: 'Managed by the system' });
    if (!(REST_SETTINGS_KEYS as readonly string[]).includes(key) && !(TOOL_ONLY_SETTINGS_KEYS as readonly string[]).includes(key)) {
      throw new ValidationError(`Unknown setting: ${key}`, { [key]: 'Unknown field' });
    }
  }
}

const summary = (errors: Errors) => `Some settings are not valid: ${Object.entries(errors).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join('; ')}`;

/**
 * Applies a settings update with the semantics of the REST PUT. `team`, when sent, replaces the whole team:
 * its order is the call priority, ids missing from it are removed, entries without an id are new people, and a
 * phone left out keeps the stored one. A changed phone drops that person's verification and any code in
 * flight. Everything not sent keeps its stored value. The body must carry the revision of the copy it edited
 * (_revision); the write is also conditional on the stored value, so two racing saves cannot both land.
 *
 * `beforeTurningOn` is for a caller whose request is not a person's click (the Emma tool): it runs after every
 * check above has passed, only for a change that turns calling on, and anything it throws stops the write.
 * The REST route has no such hook, because its caller is the person clicking; it therefore cannot buy the paid
 * add-on, and turning calling on there is refused while the add-on is required and not active.
 */
export async function applyHotLeadCallSettings(
  org: Organization, caller: HotLeadCallCaller, body: Record<string, unknown>, beforeTurningOn?: (next: HotLeadCallConfig) => Promise<void>,
): Promise<{ dto: HotLeadCallSettingsDto; config: HotLeadCallConfig }> {
  requireConfigure(org, caller);
  checkKeys(body);
  if (body._revision === undefined) throw new RevisionRequiredError();
  if (typeof body._revision !== 'string') throw new ValidationError('_revision must be a string', { _revision: 'Must be a string' });
  const previousRaw = org.hotLeadCall;
  if (body._revision !== hotLeadCallRevisionOf(previousRaw)) {
    throw new ConflictError('The settings were changed by someone else. Reload them and try again.');
  }

  const current = storedHotLeadCallConfig(org);
  const errors: Errors = {};
  scalarProblems(body, errors);
  const team = body.team === undefined ? current?.team : buildTeam(body.team, current, errors);
  if (!current) {
    if (body.team === undefined) errors.team = 'Add at least one person';
    if (body.announcedName === undefined) errors.announcedName = 'Enter the business\'s registered (legal) name: it is the name the lead hears as the caller';
  }
  // A value above the owner maximum is refused unless it is the very value already stored (a round trip of the read-out).
  const month = body.maxCallsPerMonth;
  if (typeof month === 'number' && month > HOT_LEAD_CALL_OWNER_MAX_CALLS_PER_MONTH && month !== current?.maxCallsPerMonth) {
    errors.maxCallsPerMonth = OWNER_MONTHLY_LIMIT_REFUSAL;
  }
  if (Object.keys(errors).length || !team) throw new ValidationError(summary(errors), errors);

  const entitled = await isHotLeadCallPlanEntitled(org);
  const wantsEnabled = (typeof body.enabled === 'boolean' ? body.enabled : undefined) ?? current?.enabled ?? false;
  // Turning calling on is what lets calls spend money; saving while off, or editing while already on, is not gated.
  if (wantsEnabled && !current?.enabled && !entitled) throw new NotEntitledError();

  const candidate = {
    ...current,
    ...Object.fromEntries(Object.entries(body).filter(([key]) => !HANDLED_KEYS.includes(key))),
    team,
    ...(isRecord(body.callingHours) ? { callingHours: { ...body.callingHours, timezone: normalizeTimezone(body.callingHours.timezone) } } : {}),
    enabled: false,
  };
  const draft = hotLeadCallConfigOf(candidate);
  if (!draft) throw new ValidationError('These settings are not valid');
  const blockers = blockersOf(draft, true, false);
  // Turning on is also refused when the settings could never place a call (no callable country, hours that never meet the
  // lead window); an org that is already on keeps its setting through an unrelated edit and sees the problem in the read-out.
  const turningOn = wantsEnabled && !current?.enabled;
  const effectiveBlockers = turningOn ? effectiveBlockersOf(draft) : [];
  const allBlockers = [...blockers, ...effectiveBlockers];
  if (wantsEnabled && allBlockers.length) {
    // An explicit "turn on" that cannot work is an error; an edit that merely made a running setup incomplete
    // (the only verified phone changed or was removed) turns calling off instead of leaving it on and broken.
    if (body.enabled === true) throw new ValidationError(`Calling cannot be turned on yet: ${allBlockers[0]}`, { enabled: allBlockers.join('. ') });
  }
  const next = hotLeadCallConfigOf({ ...candidate, enabled: wantsEnabled && blockers.length === 0 });
  if (!next) throw new ValidationError('These settings are not valid');

  if (caller.unattended) {
    const reason = escalationOf(current, next);
    if (reason) throw new UnattendedRunError(`This needs a person to confirm in an interactive chat (${reason})`);
  }
  let addOnBought = false;
  if (next.enabled && !current?.enabled) {
    // The paid add-on (when billing is required) is bought by the chat tool's hook after approval; a caller without
    // a hook (the portal's REST save) cannot buy it, so it is refused with the way to subscribe.
    if (!beforeTurningOn && !await isHotLeadCallBillingActive(org)) throw new NotEntitledError(HOT_LEAD_CALL_SUBSCRIBE_MESSAGE);
    await beforeTurningOn?.(next);
    addOnBought = isHotLeadCallBillingRequired();
  }

  const verification = verificationAfterTeamEdit(org.hotLeadCallVerification, next.team);
  try {
    await orgDb.updateOrg(org.orgId, { hotLeadCall: next, ...(verification ? { hotLeadCallVerification: verification } : {}) }, {
      condition: unchangedSince({ hotLeadCall: previousRaw, ...(verification ? { hotLeadCallVerification: org.hotLeadCallVerification } : {}) }),
    });
  } catch (err) {
    if (isConditionalFailure(err)) throw new ConflictError(`The settings were changed by someone else. Reload them and try again.${addOnBought ? ' The hot lead calls add-on is already active on your subscription and will not be charged again.' : ''}`);
    throw err;
  }
  return { dto: toDto({ hotLeadCall: next }, next, entitled, entitled && !(addOnBought || await isHotLeadCallBillingActive(org))), config: next };
}

export async function updateHotLeadCallSettings(org: Organization, caller: HotLeadCallCaller, body: Record<string, unknown>): Promise<HotLeadCallSettingsDto> {
  return (await applyHotLeadCallSettings(org, caller, body)).dto;
}
