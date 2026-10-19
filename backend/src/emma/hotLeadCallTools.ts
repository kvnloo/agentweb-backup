import { emmaToolRegistry } from './registry';
import { orgDb } from '../services/db';
import { callerOrg, type ToolContext } from './orgCaller';
import { isRecord } from '../services/leadNotificationAttribution';
import { LEAD_ORIGINS, LEAD_ORIGIN_DESCRIPTIONS } from '../services/leadNotificationConfig';
import {
  allowlistedE164, hotLeadCallConfigOf, normalizeTimezone, HHMM, HOT_LEAD_CALL_ANNOUNCED_NAME_MAX, HOT_LEAD_CALL_COUNTRIES,
  HOT_LEAD_CALL_LIMITS, HOT_LEAD_CALL_LIMIT_FIELDS, HOT_LEAD_CALL_SYSTEM_FIELDS, maskPhone,
  type HotLeadCallConfig,
} from '../services/hotLeadCallConfig';
import { toE164 } from '../services/whatsappService';
import { parsePhoneNumberWithError } from 'libphonenumber-js';

const WRITABLE = ['enabled', 'destinationPhone', 'leadTypes', ...HOT_LEAD_CALL_LIMIT_FIELDS, 'announcedName', 'quietHours', 'allowedCountries'];

function settings(config?: HotLeadCallConfig) {
  return {
    configured: !!config,
    enabled: config?.enabled ?? false,
    destinationPhone: config ? maskPhone(config.destinationPhone) : null,
    destinationVerified: !!config?.destinationVerifiedAt,
    callerNumberAssigned: !!config?.twilioNumber,
    leadTypes: config?.leadTypes ?? null,
    announcedName: config?.announcedName ?? null,
    quietHours: config?.quietHours ?? null,
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

function resolveDestinationPhone(sent: unknown, current: HotLeadCallConfig | undefined): string {
  let phone = current?.destinationPhone;
  if (sent !== undefined) {
    // toE164 silently drops extensions, which would make the owner's phone ring a different line.
    if (typeof sent === 'string' && hasExtension(sent)) throw new Error('destinationPhone must not include an extension');
    const normalized = typeof sent === 'string' ? toE164(sent, 'US') : null;
    phone = normalized ? allowlistedE164(normalized) ?? undefined : undefined;
    if (!phone) throw new Error('destinationPhone must be a valid US or Canadian phone number');
  }
  if (!phone) throw new Error('destinationPhone is required to set up hot lead calls');
  return phone;
}

/** Partial update over the current config; a changed phone drops verification and forces calling off. */
function mergeConfig(current: HotLeadCallConfig | undefined, destinationPhone: string, rest: Record<string, unknown>, quietHours: unknown) {
  if (quietHours !== undefined && !isRecord(quietHours)) throw new Error('quietHours must be an object with start, end and timezone');
  const phoneChanged = destinationPhone !== current?.destinationPhone;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { destinationVerifiedAt: _unverify, ...unverified } = current ?? ({} as Partial<HotLeadCallConfig>);
  const mergedQuietHours = quietHours === undefined ? undefined : { ...current?.quietHours, ...quietHours };
  const timezone = mergedQuietHours && normalizeTimezone(mergedQuietHours.timezone);
  if (mergedQuietHours && !timezone) {
    throw new Error(`timezone must be an IANA Area/Location name such as America/Chicago; UTC, abbreviations and Etc/ zones are refused; case is normalised (got ${JSON.stringify(mergedQuietHours.timezone)})`);
  }
  return {
    ...(phoneChanged ? unverified : current),
    ...rest,
    destinationPhone,
    ...(mergedQuietHours ? { quietHours: { ...mergedQuietHours, timezone } } : {}),
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
    description: 'Read your organization’s hot lead auto-call settings: when a new lead arrives, the system phones the owner first and then connects the lead. Shows whether it is on, which lead types trigger it, the call limits, quiet hours and the spoken business name. The owner phone is masked to its last 4 digits. Whether the phone is verified and a caller number is assigned is shown, but both are managed by the system, not by chat.',
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
    description: `Change your organization’s hot lead auto-call settings (org owners/admins only). Only the fields you send change; everything else is kept. The first save needs destinationPhone (US or Canada only, no extension; Puerto Rico, Guam and other territories are not supported) and announcedName. Changing destinationPhone clears its verification and turns calling off until the new number is verified. enabled:true is refused until the phone is verified and a caller number is assigned; both are managed by the system and cannot be set here. quietHours is the window in which calls ARE allowed (24h HH:MM in the given timezone, default 08:00-21:00; start later than end wraps past midnight) and is required to enable. The lead’s own timezone is not considered. timezone must be an IANA Area/Location name such as America/Chicago (UTC, abbreviations and Etc/ zones are refused; letter case is normalised). leadTypes must contain at least one type (default form_fill). announcedName is read aloud on the call: letters, digits, spaces and . , & ' - only, max ${HOT_LEAD_CALL_ANNOUNCED_NAME_MAX} characters.`,
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        destinationPhone: { type: 'string', description: 'Owner phone, US or Canada only (not Puerto Rico, Guam or other +1 territories), no extension, e.g. +15555550100.' },
        leadTypes: { type: 'array', items: { type: 'string', enum: [...LEAD_ORIGINS] }, uniqueItems: true, minItems: 1, maxItems: LEAD_ORIGINS.length },
        ...Object.fromEntries(HOT_LEAD_CALL_LIMIT_FIELDS.map(f => [f, { type: 'integer', minimum: HOT_LEAD_CALL_LIMITS[f].min, maximum: HOT_LEAD_CALL_LIMITS[f].max }])),
        announcedName: { type: 'string', minLength: 1, maxLength: HOT_LEAD_CALL_ANNOUNCED_NAME_MAX },
        quietHours: {
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
    const previous = org.hotLeadCall;
    const current = storedConfig(previous);

    const destinationPhone = resolveDestinationPhone(patch.destinationPhone, current);
    const rest = Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'quietHours' && key !== 'destinationPhone'));
    const merged = mergeConfig(current, destinationPhone, rest, patch.quietHours);
    const validated = hotLeadCallConfigOf(merged);
    if (!validated) {
      throw new Error('Invalid hot lead call settings. Check the limits and name format; enabling needs a verified phone, an assigned caller number, and quiet hours with a timezone.');
    }

    // First write must not race another first write; later writes must not clobber a concurrent edit.
    await orgDb.updateOrg(org.orgId, { hotLeadCall: validated }, { condition: previous === undefined
      ? { expression: 'attribute_not_exists(#previousHotLeadCall)', names: { '#previousHotLeadCall': 'hotLeadCall' } }
      : { expression: '#previousHotLeadCall = :previousHotLeadCall', names: { '#previousHotLeadCall': 'hotLeadCall' }, values: { ':previousHotLeadCall': previous } } });
    return { success: true, ...settings(validated) };
  },
});
