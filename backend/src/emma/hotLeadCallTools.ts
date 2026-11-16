import { emmaToolRegistry } from './registry';
import { callerIdentity, type ToolContext } from './orgCaller';
import { requireApproval } from './hotLeadCallApproval';
import { LEAD_ORIGINS, LEAD_ORIGIN_DESCRIPTIONS } from '../services/leadNotificationConfig';
import { isRecord } from '../services/leadNotificationAttribution';
import {
  HHMM, MEMBER_ID, maskPhone, HOT_LEAD_CALL_ANNOUNCED_NAME_MAX, HOT_LEAD_CALL_COUNTRIES, HOT_LEAD_CALL_DEFAULT_CALLING_HOURS, HOT_LEAD_CALL_LIMITS, HOT_LEAD_CALL_LIMIT_FIELDS, HOT_LEAD_CALL_OWNER_MAX_CALLS_PER_MONTH,
  HOT_LEAD_CALL_MAX_TEAM_SIZE, HOT_LEAD_CALL_MAX_WINDOWS_PER_MEMBER, HOT_LEAD_CALL_MEMBER_NAME_MAX, HOT_LEAD_CALL_SYSTEM_FIELDS,
  type HotLeadCallConfig, type HotLeadCallWindow,
} from '../services/hotLeadCallConfig';
import {
  applyHotLeadCallSettings, canonicalJson, getHotLeadCallSettings, hotLeadCallRevisionOf, storedHotLeadCallConfig, type HotLeadCallSettingsDto,
} from '../services/hotLeadCallSettingsService';
import { callRateText } from '../services/voice/numberProvisioning';
import { isHotLeadCallBillingActive, isHotLeadCallBillingRequired } from '../services/voice/hotLeadCallEntitlement';
import { addHotLeadCallBilling, HOT_LEAD_CALL_ADDON_PRICE_TEXT } from '../services/hotLeadCallBillingService';

// A member created from chat with a bare phone has no schedule of their own, so they are available whenever the calling hours are open.
const ALWAYS_AVAILABLE: HotLeadCallWindow = { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' };
const DEFAULT_MEMBER_NAME = 'Team member';
const WRITABLE = [
  'enabled', 'memberPhone', 'memberName', 'team', 'leadTypes', ...HOT_LEAD_CALL_LIMIT_FIELDS, 'announcedName', 'callingHours', 'allowedCountries',
];

/** Carries the approval card out of the settings service's hook, which can only continue or throw. */
class ApprovalHalt extends Error {
  constructor(readonly halt: Record<string, unknown>) {
    super('Turning hot lead calling on waits for the user to approve');
  }
}

/** The settings as Emma reads them: the portal's view (phones masked) plus the scalar settings only chat edits. */
function view(dto: HotLeadCallSettingsDto, config: HotLeadCallConfig | undefined) {
  return {
    configured: !!config,
    // The revision is for the portal's save protocol; chat edits the copy it just read.
    ...Object.fromEntries(Object.entries(dto).filter(([key]) => key !== '_revision')),
    callerNumberAssigned: !!config?.twilioNumber,
    leadTypes: config?.leadTypes ?? null,
    allowedCountries: config?.allowedCountries ?? null,
    ...Object.fromEntries(HOT_LEAD_CALL_LIMIT_FIELDS.filter(f => f !== 'maxAttemptsPerLead').map(f => [f, config?.[f] ?? HOT_LEAD_CALL_LIMITS[f].default])),
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

/**
 * `memberPhone` / `memberName` edit a team of one (or create it); they become a one-person `team` for the shared
 * service, which keeps the stored id, windows and verification unless the phone really changes.
 */
function teamFromMemberFields(patch: Record<string, unknown>, current: HotLeadCallConfig | undefined): unknown[] {
  if (current && current.team.length > 1) {
    throw new Error('Several team members are set up: edit them with the team field (the full list), not memberPhone or memberName.');
  }
  const existing = current?.team[0];
  const name = patch.memberName === undefined ? existing?.name ?? DEFAULT_MEMBER_NAME : patch.memberName;
  if (!existing && patch.memberPhone === undefined) throw new Error('memberPhone is required to set up hot lead calls');
  return [{
    ...(existing ? { id: existing.id } : {}),
    name,
    ...(patch.memberPhone === undefined ? {} : { phone: patch.memberPhone }),
    windows: existing?.windows ?? [ALWAYS_AVAILABLE],
  }];
}

emmaToolRegistry.register({
  name: 'get_hot_lead_call_settings',
  definition: {
    name: 'get_hot_lead_call_settings',
    description: 'Read your organization’s hot lead auto-call settings (org owners/admins only): when a new lead arrives, the system phones an available team member first and then connects the lead. Shows whether it is on, whether the plan includes it, what is still missing before it can be turned on (blockers), which lead types trigger it, the call limits, the calling hours, the spoken business name and the team in priority order (id, name, availability windows, phone masked to its last 4 digits and whether it is verified). Whether each phone is verified and whether a caller number is assigned is shown, but both are managed by the system, not by chat.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  execute: async (args: unknown, context?: ToolContext) => {
    validateArgs(args, []);
    const { org, caller } = await callerIdentity(context, 'hot lead call settings');
    return { success: true, ...view(await getHotLeadCallSettings(org, caller), storedHotLeadCallConfig(org)) };
  },
});

const WINDOW_SCHEMA = {
  type: 'object',
  properties: {
    days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, uniqueItems: true, minItems: 1, maxItems: 7, description: '0 = Sunday .. 6 = Saturday.' },
    start: { type: 'string', pattern: HHMM.source },
    end: { type: 'string', description: 'HH:MM after start, or 24:00 for the end of the day. A window never wraps midnight: overnight is two windows.' },
  },
  required: ['days', 'start', 'end'],
  additionalProperties: false,
};

emmaToolRegistry.register({
  name: 'update_hot_lead_call_settings',
  definition: {
    name: 'update_hot_lead_call_settings',
    description: `Change your organization’s hot lead auto-call settings (org owners/admins only). Only the fields you send change; everything else is kept. The first save needs a team (or memberPhone) and announcedName. With one team member, memberPhone and memberName edit that member (US or Canada only, no extension; Puerto Rico, Guam and other territories are not supported). For several people send team: the FULL list in priority order (first is called first); it replaces the stored team, people left out are removed, an entry with an id edits that person (their phone is kept when omitted), an entry without an id is a new person and needs a phone, and each person needs 1 to ${HOT_LEAD_CALL_MAX_WINDOWS_PER_MEMBER} availability windows read in the calling-hours timezone. At most ${HOT_LEAD_CALL_MAX_TEAM_SIZE} people. Changing a person’s phone clears their verification (and turns calling off if nobody verified is left) until the system re-verifies it. maxAttemptsPerLead (1-5, default 3) is how many people are tried for one lead. maxCallsPerHour and maxCallsPerDay count leads that get a call: a lead uses one slot however many people are tried for it. maxCallsPerMonth (1-200, default 150) is the same per calendar month; higher monthly limits are set by AgentWeb support. enabled:true is refused until a team member's phone is verified, a caller number is assigned and calling hours are set, and when the organization's plan does not include hot lead calls. Once it can work, the user must approve turning calling on: the first call stops with an approval card that says who will be phoned and what calls cost, and calling is turned on only when you call this tool again with the same arguments after they clicked approve (approval lasts 15 minutes and works once; do not ask for it in text). When the organization must pay for the hot lead calls add-on ($70 per month, includes one calling number and 150 lead calls per month) the same card states that price and the add-on is added to the owner's subscription only after approval; if that fails nothing is turned on. Turning calling off (it does not cancel the add-on) and every other change need no approval. Verification and the caller number are managed by the system and cannot be set here. callingHours is the window in which calls ARE allowed (24h HH:MM in the given timezone, default 08:00-21:00; start later than end wraps past midnight). Leads are also called only 10:00-18:00 their own time (so in practice about 13:00-18:00 Eastern for most US numbers); Canadian numbers are not called. timezone must be an IANA Area/Location name such as America/Chicago (UTC, abbreviations and Etc/ zones are refused; letter case is normalised). leadTypes must contain at least one type (default form_fill). announcedName is read aloud on the call as the caller and is the name in the consent notice, so it must be the business's registered (legal) name, not a brand or nickname: letters, digits, spaces and . , & ' - only, max ${HOT_LEAD_CALL_ANNOUNCED_NAME_MAX} characters. In a scheduled or otherwise unattended run, anything that raises a limit, widens the calling hours, turns calling on or edits the team is refused; ask in an interactive chat.`,
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        memberPhone: { type: 'string', description: 'Phone of the only team member, US or Canada only (not Puerto Rico, Guam or other +1 territories), no extension, e.g. +15555550100.' },
        memberName: { type: 'string', minLength: 1, maxLength: HOT_LEAD_CALL_MEMBER_NAME_MAX, description: 'Name of the only team member (letters, digits, spaces and . , & \' - only).' },
        team: {
          type: 'array', minItems: 1, maxItems: HOT_LEAD_CALL_MAX_TEAM_SIZE,
          description: 'The full team in priority order. Replaces the stored team.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', pattern: MEMBER_ID.source, description: 'Id from get_hot_lead_call_settings; leave out for a new person.' },
              name: { type: 'string', minLength: 1, maxLength: HOT_LEAD_CALL_MEMBER_NAME_MAX },
              phone: { type: 'string', description: 'US or Canadian number. Required for a new person; leave out to keep the saved one.' },
              windows: { type: 'array', items: WINDOW_SCHEMA, minItems: 1, maxItems: HOT_LEAD_CALL_MAX_WINDOWS_PER_MEMBER },
            },
            required: ['name', 'windows'],
            additionalProperties: false,
          },
        },
        leadTypes: { type: 'array', items: { type: 'string', enum: [...LEAD_ORIGINS] }, uniqueItems: true, minItems: 1, maxItems: LEAD_ORIGINS.length },
        ...Object.fromEntries(HOT_LEAD_CALL_LIMIT_FIELDS.map(f => [f, { type: 'integer', minimum: HOT_LEAD_CALL_LIMITS[f].min, maximum: f === 'maxCallsPerMonth' ? HOT_LEAD_CALL_OWNER_MAX_CALLS_PER_MONTH : HOT_LEAD_CALL_LIMITS[f].max }])),
        announcedName: { type: 'string', minLength: 1, maxLength: HOT_LEAD_CALL_ANNOUNCED_NAME_MAX, description: 'The business\'s registered (legal) name: the name the lead hears as the caller and the name in the consent notice.' },
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
    if (patch.team !== undefined && (patch.memberPhone !== undefined || patch.memberName !== undefined)) {
      throw new Error('Send either team or memberPhone/memberName, not both.');
    }

    const { org, caller } = await callerIdentity(context, 'hot lead call settings', true);
    const current = storedHotLeadCallConfig(org);
    const { callingHours } = patch;
    const body = Object.fromEntries(Object.entries(patch).filter(([key]) => !['memberPhone', 'memberName', 'callingHours'].includes(key)));
    if (patch.memberPhone !== undefined || patch.memberName !== undefined || (!current && patch.team === undefined)) {
      body.team = teamFromMemberFields(patch, current);
    }
    if (callingHours !== undefined) {
      if (!isRecord(callingHours)) throw new Error('callingHours must be an object with start, end and timezone');
      body.callingHours = { ...HOT_LEAD_CALL_DEFAULT_CALLING_HOURS, ...current?.callingHours, ...callingHours };
    }
    // The tool edits the copy it just read; the service's conditional write is what catches a concurrent editor.
    // Turning calling on is the one change that waits for a person's approval; the portal's own click covers REST.
    const requireEnableApproval = async (next: HotLeadCallConfig) => {
      // With billing required and the add-on not active, the card quotes the flat price (part of the approved digest)
      // and the add-on is bought only after the approval, just before the settings write below.
      const billingRequired = isHotLeadCallBillingRequired();
      const needsAddon = billingRequired && !await isHotLeadCallBillingActive(org);
      const halt = await requireApproval({
        org,
        context,
        priceText: billingRequired ? HOT_LEAD_CALL_ADDON_PRICE_TEXT : callRateText(),
        // Whether this approval buys the add-on is part of what was approved: the digest changes if that flips before the answer.
        target: canonicalJson(needsAddon ? { ...patch, _buysAddon: true } : patch),
        card: {
          action: 'enable',
          number: next.twilioNumber && maskPhone(next.twilioNumber),
          members: next.team.filter(m => m.verifiedAt).map(m => `${m.name} (${maskPhone(m.phone)})`),
          limits: next,
          addon: billingRequired,
          purchase: needsAddon,
        },
      });
      if (halt) throw new ApprovalHalt(halt);
      // Throws a plain message when Stripe refuses; the settings are then not written and calling stays off.
      if (needsAddon) await addHotLeadCallBilling(org.orgId);
    };
    try {
      const { dto, config } = await applyHotLeadCallSettings(org, caller, { ...body, _revision: hotLeadCallRevisionOf(org.hotLeadCall) }, requireEnableApproval);
      return { success: true, ...view(dto, config) };
    } catch (err) {
      if (err instanceof ApprovalHalt) return err.halt;
      throw err;
    }
  },
});
