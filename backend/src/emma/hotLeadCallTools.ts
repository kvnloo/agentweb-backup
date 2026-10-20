import { emmaToolRegistry } from './registry';
import { orgDb } from '../services/db';
import { callerOrg, type ToolContext } from './orgCaller';
import { isRecord } from '../services/leadNotificationAttribution';
import { LEAD_ORIGINS, LEAD_ORIGIN_DESCRIPTIONS } from '../services/leadNotificationConfig';
import {
  allowlistedE164, generateMemberId, hotLeadCallConfigOf, normalizeTimezone, HHMM, HOT_LEAD_CALL_ANNOUNCED_NAME_MAX, HOT_LEAD_CALL_COUNTRIES,
  HOT_LEAD_CALL_LIMITS, HOT_LEAD_CALL_LIMIT_FIELDS, HOT_LEAD_CALL_MEMBER_NAME_MAX, HOT_LEAD_CALL_SYSTEM_FIELDS, maskPhone,
  type HotLeadCallConfig, type HotLeadCallMember, type HotLeadCallWindow,
} from '../services/hotLeadCallConfig';
import { assertHotLeadCallEntitled } from '../services/voice/hotLeadCallEntitlement';
import { unchangedSince } from '../services/voice/setupWrites';
import { toE164 } from '../services/whatsappService';
import { parsePhoneNumberWithError } from 'libphonenumber-js';

// Through chat a team of one is edited (memberPhone/memberName); the full team editor is a separate surface.
const WRITABLE = ['enabled', 'memberPhone', 'memberName', 'leadTypes', ...HOT_LEAD_CALL_LIMIT_FIELDS, 'announcedName', 'callingHours', 'allowedCountries'];
const DEFAULT_MEMBER_NAME = 'Team member';
// A member created from chat has no schedule of their own, so they are available whenever the calling hours are open.
const ALWAYS_AVAILABLE: HotLeadCallWindow = { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' };

function settings(config?: HotLeadCallConfig) {
  return {
    configured: !!config,
    enabled: config?.enabled ?? false,
    team: config?.team.map(m => ({ id: m.id, name: m.name, phone: maskPhone(m.phone), verified: !!m.verifiedAt, windows: m.windows })) ?? [],
    callerNumberAssigned: !!config?.twilioNumber,
    leadTypes: config?.leadTypes ?? null,
    announcedName: config?.announcedName ?? null,
    callingHours: config?.callingHours ?? null,
    allowedCountries: config?.allowedCountries ?? null,
    ...Object.fromEntries(HOT_LEAD_CALL_LIMIT_FIELDS.map(f => [f, config?.[f] ?? HOT_LEAD_CALL_LIMITS[f].default])),
    availableLeadTypes: LEAD_ORIGINS.map(value => ({ value, description: LEAD_ORIGIN_DESCRIPTIONS[value] })),
  };
}

function hasExtension(raw: string): boolean {
  try {
    return !!parsePhoneNumberWithError(raw, 'US').ext;
  } catch {
    return false;
  }
}

function resolveMemberPhone(sent: unknown, current: HotLeadCallConfig | undefined): string {
  let phone = current?.team[0]?.phone;
  if (sent !== undefined) {
    // toE164 silently drops extensions, which would make the member's phone ring a different line.
    if (typeof sent === 'string' && hasExtension(sent)) throw new Error('memberPhone must not include an extension');
    const normalized = typeof sent === 'string' ? toE164(sent, 'US') : null;
    phone = normalized ? allowlistedE164(normalized) ?? undefined : undefined;
    if (!phone) throw new Error('memberPhone must be a valid US or Canadian phone number');
  }
  if (!phone) throw new Error('memberPhone is required to set up hot lead calls');
  return phone;
}

/** The team after this update: a team of one is edited in place, a larger team is left to its own editor. */
function mergeTeam(current: HotLeadCallConfig | undefined, memberPhone: string, memberName: unknown): HotLeadCallMember[] {
  if (memberName !== undefined && (typeof memberName !== 'string' || !memberName.trim() || memberName.trim().length > HOT_LEAD_CALL_MEMBER_NAME_MAX)) {
    throw new Error(`memberName must be 1 to ${HOT_LEAD_CALL_MEMBER_NAME_MAX} characters`);
  }
  const team = current?.team ?? [];
  if (team.length > 1) throw new Error('Several team members are set up and cannot be changed through chat; only the other settings can.');
  const existing = team[0];
  const name = typeof memberName === 'string' ? memberName.trim() : existing?.name ?? DEFAULT_MEMBER_NAME;
  if (!existing) return [{ id: generateMemberId(), name, phone: memberPhone, windows: [ALWAYS_AVAILABLE] }];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { verifiedAt: _unverify, ...unverified } = existing;
  return [{ ...(memberPhone === existing.phone ? existing : unverified), name, phone: memberPhone }];
}

/** Partial update over the current config; a changed phone drops that member's verification and forces calling off. */
function mergeConfig(current: HotLeadCallConfig | undefined, team: HotLeadCallMember[], phoneChanged: boolean, rest: Record<string, unknown>, callingHours: unknown) {
  if (callingHours !== undefined && !isRecord(callingHours)) throw new Error('callingHours must be an object with start, end and timezone');
  const mergedHours = callingHours === undefined ? undefined : { ...current?.callingHours, ...callingHours };
  const timezone = mergedHours && normalizeTimezone(mergedHours.timezone);
  if (mergedHours && !timezone) {
    throw new Error(`timezone must be an IANA Area/Location name such as America/Chicago; UTC, abbreviations and Etc/ zones are refused; case is normalised (got ${JSON.stringify(mergedHours.timezone)})`);
  }
  return {
    ...current,
    ...rest,
    team,
    ...(mergedHours ? { callingHours: { ...mergedHours, timezone } } : {}),
    // A new number is unverified, so calling stays off until the system re-verifies it.
    enabled: phoneChanged ? false : rest.enabled ?? current?.enabled ?? false,
  };
}

function validateArgs(args: unknown, allowed: readonly string[]): asserts args is Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid hot lead call settings arguments');
  for (const key of Object.keys(args)) {
    if ((HOT_LEAD_CALL_SYSTEM_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`${key} is managed by the system and cannot be set here`);
    }
    if (!allowed.includes(key)) throw new Error('Invalid hot lead call settings arguments');
  }
}

export function storedConfig(stored: unknown): HotLeadCallConfig | undefined {
  if (stored === undefined) return undefined;
  const config = hotLeadCallConfigOf(stored);
  if (!config) throw new Error('Stored hot lead call settings are invalid');
  return config;
}

emmaToolRegistry.register({
  name: 'get_hot_lead_call_settings',
  definition: {
    name: 'get_hot_lead_call_settings',
    description: 'Read your organization’s hot lead auto-call settings: when a new lead arrives, the system phones an available team member first and then connects the lead. Shows whether it is on, which lead types trigger it, the call limits, the calling hours, the spoken business name and the team (name, availability windows, phone masked to its last 4 digits and whether it is verified). Whether each phone is verified and whether a caller number is assigned is shown, but both are managed by the system, not by chat.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  execute: async (args: unknown, context?: ToolContext) => {
    validateArgs(args, []);
    const org = await callerOrg(context, 'hot lead call settings');
    return { success: true, ...settings(storedConfig(org.hotLeadCall)) };
  },
});

emmaToolRegistry.register({
  name: 'update_hot_lead_call_settings',
  definition: {
    name: 'update_hot_lead_call_settings',
    description: `Change your organization’s hot lead auto-call settings (org owners/admins only). Only the fields you send change; everything else is kept. The first save needs memberPhone (the team member's phone: US or Canada only, no extension; Puerto Rico, Guam and other territories are not supported) and announcedName; memberName is optional. With one team member, memberPhone and memberName edit that member; changing memberPhone clears its verification and turns calling off until the new number is verified. A team of several members cannot be changed through chat, only the other settings. maxAttemptsPerLead (1-5, default 3) is how many members are tried for one lead. enabled:true is refused until a team member's phone is verified and a caller number is assigned, and when the organization's plan does not include hot lead calls; both are managed by the system and cannot be set here. callingHours is the window in which calls ARE allowed (24h HH:MM in the given timezone, default 08:00-21:00; start later than end wraps past midnight) and is required to enable. The lead’s own timezone is not considered. timezone must be an IANA Area/Location name such as America/Chicago (UTC, abbreviations and Etc/ zones are refused; letter case is normalised). leadTypes must contain at least one type (default form_fill). announcedName is read aloud on the call: letters, digits, spaces and . , & ' - only, max ${HOT_LEAD_CALL_ANNOUNCED_NAME_MAX} characters.`,
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        memberPhone: { type: 'string', description: 'Team member phone, US or Canada only (not Puerto Rico, Guam or other +1 territories), no extension, e.g. +15555550100.' },
        memberName: { type: 'string', minLength: 1, maxLength: HOT_LEAD_CALL_MEMBER_NAME_MAX, description: 'Name of the team member (letters, digits, spaces and . , & \' - only).' },
        leadTypes: { type: 'array', items: { type: 'string', enum: [...LEAD_ORIGINS] }, uniqueItems: true, minItems: 1, maxItems: LEAD_ORIGINS.length },
        ...Object.fromEntries(HOT_LEAD_CALL_LIMIT_FIELDS.map(f => [f, { type: 'integer', minimum: HOT_LEAD_CALL_LIMITS[f].min, maximum: HOT_LEAD_CALL_LIMITS[f].max }])),
        announcedName: { type: 'string', minLength: 1, maxLength: HOT_LEAD_CALL_ANNOUNCED_NAME_MAX },
        callingHours: {
          type: 'object',
          properties: { start: { type: 'string', pattern: HHMM.source }, end: { type: 'string', pattern: HHMM.source }, timezone: { type: 'string', description: 'An IANA Area/Location name such as America/Chicago (UTC, abbreviations and Etc/ zones are refused).' } },
          additionalProperties: false,
        },
        allowedCountries: { type: 'array', items: { type: 'string', enum: [...HOT_LEAD_CALL_COUNTRIES] }, uniqueItems: true, minItems: 1 },
      },
      additionalProperties: false,
    },
  },
  execute: async (args: unknown, context?: ToolContext) => {
    validateArgs(args, WRITABLE);
    // Models often send null for omitted optionals; treat null as "not provided".
    const patch: Record<string, unknown> = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null));
    if (Object.keys(patch).length === 0) throw new Error('Invalid hot lead call settings arguments: provide at least one setting');

    const org = await callerOrg(context, 'hot lead call settings', true);
    // Turning calling on is what lets calls spend money; saving settings while off is always allowed.
    if (patch.enabled === true) await assertHotLeadCallEntitled(org);
    const previous = org.hotLeadCall;
    const current = storedConfig(previous);

    // The team is only touched when a member field is sent (or on the first save, which needs one).
    const editsMember = !current || patch.memberPhone !== undefined || patch.memberName !== undefined;
    const team = editsMember ? mergeTeam(current, resolveMemberPhone(patch.memberPhone, current), patch.memberName) : current.team;
    const phoneChanged = editsMember && team[0].phone !== current?.team[0]?.phone;
    const rest = Object.fromEntries(Object.entries(patch).filter(([key]) => !['callingHours', 'memberPhone', 'memberName'].includes(key)));
    const merged = mergeConfig(current, team, phoneChanged, rest, patch.callingHours);
    const validated = hotLeadCallConfigOf(merged);
    if (!validated) {
      throw new Error('Invalid hot lead call settings. Check the limits and name format; enabling needs a verified team member, an assigned caller number, and calling hours with a timezone.');
    }

    // First write must not race another first write; later writes must not clobber a concurrent edit.
    await orgDb.updateOrg(org.orgId, { hotLeadCall: validated }, { condition: unchangedSince({ hotLeadCall: previous }) });
    return { success: true, ...settings(validated) };
  },
});
