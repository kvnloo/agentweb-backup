import { emmaToolRegistry } from './registry';
import { orgDb, userDb } from '../services/db';
import { can } from '../services/orgAuthz';
import { LEAD_ORIGINS, LEAD_ORIGIN_DESCRIPTIONS } from '../services/leadNotificationConfig';
import {
  allowlistedE164, hotLeadCallConfigOf, HOT_LEAD_CALL_ANNOUNCED_NAME_MAX, HOT_LEAD_CALL_COUNTRIES,
  HOT_LEAD_CALL_LIMITS, HOT_LEAD_CALL_LIMIT_FIELDS, HOT_LEAD_CALL_SYSTEM_FIELDS,
  type HotLeadCallConfig,
} from '../services/hotLeadCallConfig';
import { toE164 } from '../services/whatsappService';

const WRITABLE = ['enabled', 'destinationPhone', 'leadTypes', ...HOT_LEAD_CALL_LIMIT_FIELDS, 'announcedName', 'quietHours', 'allowedCountries'];

type ToolContext = { userId?: unknown; agentUserId?: unknown } | undefined;

async function callerOrg(context: ToolContext, write = false) {
  const userId = context?.userId || context?.agentUserId;
  if (typeof userId !== 'string' || !userId.trim()) throw new Error('Authentication required');
  const user = await userDb.getUserById(userId);
  if (user?.userId !== userId || typeof user.orgId !== 'string' || !user.orgId.trim()) {
    throw new Error('Organization membership required');
  }
  const org = await orgDb.getOrgById(user.orgId);
  if (!org || org.orgId !== user.orgId) throw new Error('Organization not found');
  if (write && !can({ userId, orgId: user.orgId, orgRole: typeof user.orgRole === 'string' ? user.orgRole : undefined }, org, 'org:configure')) {
    throw new Error('Only org owners and admins can update hot lead call settings');
  }
  return org;
}

const maskPhone = (phone: string) => `***${phone.slice(-4)}`;

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

function validateArgs(args: unknown, allowed: readonly string[]): asserts args is Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid hot lead call settings arguments');
  for (const key of Object.keys(args)) {
    if ((HOT_LEAD_CALL_SYSTEM_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`${key} is managed by the system and cannot be set here`);
    }
    if (!allowed.includes(key)) throw new Error('Invalid hot lead call settings arguments');
  }
}

function storedConfig(stored: unknown): HotLeadCallConfig | undefined {
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
    const org = await callerOrg(context);
    return { success: true, ...settings(storedConfig(org.hotLeadCall)) };
  },
});

emmaToolRegistry.register({
  name: 'update_hot_lead_call_settings',
  definition: {
    name: 'update_hot_lead_call_settings',
    description: `Change your organization’s hot lead auto-call settings (org owners/admins only). Only the fields you send change; everything else is kept. The first save needs destinationPhone (US or Canada) and announcedName. Changing destinationPhone clears its verification and turns calling off until the new number is verified. enabled:true is refused until the phone is verified and a caller number is assigned; both are managed by the system and cannot be set here. quietHours is the window in which calls may be placed (24h HH:MM in the given IANA timezone, default 08:00-21:00) and is required to enable. leadTypes must contain at least one type (default form_fill). announcedName is read aloud on the call: letters, digits, spaces and . , & ' - only, max ${HOT_LEAD_CALL_ANNOUNCED_NAME_MAX} characters.`,
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        destinationPhone: { type: 'string', description: 'Owner phone, US or Canada, e.g. +15555550100.' },
        leadTypes: { type: 'array', items: { type: 'string', enum: [...LEAD_ORIGINS] }, uniqueItems: true, minItems: 1, maxItems: LEAD_ORIGINS.length },
        ...Object.fromEntries(HOT_LEAD_CALL_LIMIT_FIELDS.map(f => [f, { type: 'integer', minimum: HOT_LEAD_CALL_LIMITS[f].min, maximum: HOT_LEAD_CALL_LIMITS[f].max }])),
        announcedName: { type: 'string', minLength: 1, maxLength: HOT_LEAD_CALL_ANNOUNCED_NAME_MAX },
        quietHours: {
          type: 'object',
          properties: { start: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, end: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, timezone: { type: 'string' } },
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

    const org = await callerOrg(context, true);
    const previous = org.hotLeadCall;
    const current = storedConfig(previous);

    let destinationPhone = current?.destinationPhone;
    if (patch.destinationPhone !== undefined) {
      const normalized = typeof patch.destinationPhone === 'string' ? toE164(patch.destinationPhone, 'US') : null;
      destinationPhone = normalized ? allowlistedE164(normalized) ?? undefined : undefined;
      if (!destinationPhone) throw new Error('destinationPhone must be a valid US or Canadian phone number');
    }
    if (!destinationPhone) throw new Error('destinationPhone is required to set up hot lead calls');
    const phoneChanged = destinationPhone !== current?.destinationPhone;

    const { quietHours, ...rest } = patch;
    delete rest.destinationPhone;
    const unverified: Partial<HotLeadCallConfig> = { ...current };
    delete unverified.destinationVerifiedAt;
    const merged = {
      enabled: false,
      ...(phoneChanged ? unverified : current),
      ...rest,
      destinationPhone,
      ...(quietHours !== undefined ? { quietHours: { ...current?.quietHours, ...(quietHours as object) } } : {}),
      // A new number is unverified, so calling stays off until the system re-verifies it.
      ...(phoneChanged ? { enabled: false } : {}),
    };
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
