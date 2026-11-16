import { emmaToolRegistry } from './registry';
import { callerIdentity, callerOrg, type ToolContext } from './orgCaller';
import { requireApproval, userIdOf } from './hotLeadCallApproval';
import { MEMBER_ID, type HotLeadCallConfig } from '../services/hotLeadCallConfig';
import { VERIFICATION_CODE_TTL_MS, VERIFICATION_MAX_ATTEMPTS, VERIFICATION_MAX_STARTS_PER_MEMBER_PER_DAY, VERIFICATION_MAX_STARTS_PER_ORG_PER_DAY } from '../services/voice/memberVerification';
import { confirmMemberVerification, startMemberVerification, storedHotLeadCallConfig as storedConfig } from '../services/hotLeadCallSettingsService';
import { assertHotLeadCallEntitled, isHotLeadCallBillingRequired } from '../services/voice/hotLeadCallEntitlement';
import { provisionNumber, releaseNumber, monthlyRentText } from '../services/voice/numberProvisioning';

/**
 * Setup tools for the hot lead auto-call: caller number, then team-member phone verification. Unlike the
 * live call flow they do NOT depend on the global hot_lead_call_mode kill switch: setup can be finished
 * while calling is off. They need org:configure and are blocked in shared sessions (toolDispatch).
 *
 * Spending or irreversible tools (provision, release, start verification) refuse unattended runs, mirroring
 * A1 of services/crmSequenceActivationGate.ts (`=== true`: only an explicit unattended turn is refused).
 * Provision and release additionally need a human approval: the first call halts with a one-question card
 * and the purchase or release happens only on a later call, after the person in the chat clicked approve on
 * that card (services/voice/hotLeadCallApprovalGate.ts, emma/hotLeadCallApproval.ts). `confirm` on provision
 * is ignored. The per-org purchase/release caps in numberProvisioning.ts remain as a second, independent limit.
 */

const UNATTENDED_MESSAGE = 'This needs a person to confirm in an interactive chat';

function requireAttended(context: ToolContext): void {
  if (context?.isUnattendedRun === true) throw new Error(UNATTENDED_MESSAGE);
}

const NO_ARGS_MESSAGE = 'Invalid hot lead call setup arguments';

function onlyKeys(args: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(NO_ARGS_MESSAGE);
  // Models often send null for omitted optionals; treat null as "not provided".
  const entries = Object.entries(args).filter(([, v]) => v !== null);
  if (entries.some(([k]) => !allowed.includes(k))) throw new Error(NO_ARGS_MESSAGE);
  return Object.fromEntries(entries);
}

const MEMBER_ID_PROPERTY = { type: 'string', pattern: MEMBER_ID.source, description: 'The team member to verify (their id from get_hot_lead_call_settings). Optional when there is only one member.' };

function memberIdOf(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !MEMBER_ID.test(raw)) throw new Error(NO_ARGS_MESSAGE);
  return raw;
}

function configuredOrThrow(config: HotLeadCallConfig | undefined): HotLeadCallConfig {
  if (!config) throw new Error('Save the hot lead call settings first (update_hot_lead_call_settings): the phone of a team member and a business name are needed.');
  return config;
}

emmaToolRegistry.register({
  name: 'provision_hot_lead_call_number',
  definition: {
    name: 'provision_hot_lead_call_number',
    description: `Buy the phone number the hot lead auto-call is placed from (org owners/admins only; refused when the organization's plan does not include hot lead calls). This spends money: the number has a monthly fee on your Twilio account (the current price is stated when the user is asked to agree), charged now and every month until it is released. Set it up in this order: save settings, get a number with this tool, verify the team member's phone, then enable calling. Needs saved hot lead call settings, and each organization can hold one number. The user must approve each purchase: the first call stops with an approval card that states the monthly price, and the number is bought only when you call this tool again with the same arguments after they clicked approve (approval lasts 15 minutes and works once). Do not ask for the approval in text. confirm is ignored and authorizes nothing. Each organization can buy at most 2 numbers per day. areaCode (3 digits) is optional and picks a US area code. If the result says the purchase could not be confirmed, do not retry; tell the user to contact support. Works even while hot lead calling is switched off platform-wide.`,
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Ignored. The user approves on the approval card, not through this argument.' },
        areaCode: { type: 'string', pattern: '^\\d{3}$', description: 'Optional US area code, exactly 3 digits.' },
      },
      additionalProperties: false,
    },
  },
  execute: async (args: unknown, context?: ToolContext) => {
    requireAttended(context);
    const { areaCode } = onlyKeys(args, ['confirm', 'areaCode']);
    if (areaCode !== undefined && (typeof areaCode !== 'string' || !/^\d{3}$/.test(areaCode))) throw new Error('areaCode must be exactly 3 digits, for example 415');
    const org = await callerOrg(context, 'the hot lead caller number', true);
    await assertHotLeadCallEntitled(org);
    const config = configuredOrThrow(storedConfig(org));
    if (config.twilioNumber || config.twilioNumberSid) throw new Error('This organization already has a caller number. Release it first if you need a different one.');
    const halt = await requireApproval({
      org,
      context,
      priceText: monthlyRentText(),
      target: typeof areaCode === 'string' ? areaCode : null,
      card: { action: 'provision', areaCode: typeof areaCode === 'string' ? areaCode : undefined, coveredByAddon: isHotLeadCallBillingRequired() },
    });
    if (halt) return halt;
    const result = await provisionNumber({ org, config, userId: userIdOf(context), areaCode });
    return {
      success: true, ...result,
      note: 'The first month is billed now; the number renews monthly until released. Next: verify the phone of a team member.',
    };
  },
});

emmaToolRegistry.register({
  name: 'release_hot_lead_call_number',
  definition: {
    name: 'release_hot_lead_call_number',
    description: 'Release the hot lead auto-call phone number (org owners/admins only). The number goes back to the phone provider and cannot be recovered; a new one may differ and costs money again. Hot lead calling is turned off first and stays off until a new number is provisioned and calling is enabled again; the monthly charge stops. A call that is already in progress when this runs may fail. Limited to a few releases per day. Only run it when the user has clearly asked. The user must approve each release: the first call stops with an approval card, and the number is released only when you call this tool again after they clicked approve (approval lasts 15 minutes and works once). Works even while hot lead calling is switched off platform-wide.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  execute: async (args: unknown, context?: ToolContext) => {
    requireAttended(context);
    onlyKeys(args, []);
    const org = await callerOrg(context, 'the hot lead caller number', true);
    const config = configuredOrThrow(storedConfig(org));
    if (!config.twilioNumber && !config.twilioNumberSid) throw new Error('This organization has no caller number to release.');
    const halt = await requireApproval({
      org,
      context,
      priceText: monthlyRentText(),
      target: config.twilioNumberSid ?? config.twilioNumber ?? null,
      card: { action: 'release', number: config.twilioNumber },
    });
    if (halt) return halt;
    return { success: true, ...(await releaseNumber({ org, config })) };
  },
});

emmaToolRegistry.register({
  name: 'start_hot_lead_call_verification',
  definition: {
    name: 'start_hot_lead_call_verification',
    description: `Phone a saved team member's number and read out a 6-digit code, to prove the member controls it (org owners/admins only; refused when the organization's plan does not include hot lead calls). Needs saved settings and a provisioned caller number (provision_hot_lead_call_number first). It always calls the saved number, never one you pass. With one team member that member is called; with several, pass memberId. The code is only spoken on the call: it is never shown here, so ask the user to read it back, then call confirm_hot_lead_call_verification. The code is valid for ${VERIFICATION_CODE_TTL_MS / 60_000} minutes with ${VERIFICATION_MAX_ATTEMPTS} attempts. Limits: one call per person per 2 minutes, ${VERIFICATION_MAX_STARTS_PER_MEMBER_PER_DAY} per person per day and ${VERIFICATION_MAX_STARTS_PER_ORG_PER_DAY} per day for the organization. Each call costs a small Twilio voice charge. Verification proves the phone answered and the code was heard; a voicemail that plays the message back can also pass it, and the spoken code is visible in the Twilio call log to people with Twilio access. Works even while hot lead calling is switched off platform-wide.`,
    inputSchema: { type: 'object', properties: { memberId: MEMBER_ID_PROPERTY }, additionalProperties: false },
  },
  execute: async (args: unknown, context?: ToolContext) => {
    requireAttended(context);
    const { memberId } = onlyKeys(args, ['memberId']);
    const { org, caller } = await callerIdentity(context, 'hot lead call verification', true);
    // The service words these refusals for the portal; Emma is told which of her tools fixes them.
    if (!configuredOrThrow(storedConfig(org)).twilioNumber) {
      throw new Error('Provision a caller number first (provision_hot_lead_call_number): the verification call is placed from it.');
    }
    const result = await startMemberVerification(org, caller, memberIdOf(memberId));
    return {
      success: true, ...result,
      note: `A call to ${result.memberPhone} is on its way. Ask the user for the 6-digit code they hear.`,
    };
  },
});

emmaToolRegistry.register({
  name: 'confirm_hot_lead_call_verification',
  definition: {
    name: 'confirm_hot_lead_call_verification',
    description: `Check the 6-digit code the user heard on the verification call (org owners/admins only). On success the team member's phone is marked verified; calling can then be switched on with update_hot_lead_call_settings once a caller number and calling hours are also set. With several team members, pass the same memberId as when the verification was started. A wrong code uses one of ${VERIFICATION_MAX_ATTEMPTS} attempts; after that, or after ${VERIFICATION_CODE_TTL_MS / 60_000} minutes, start a new verification. Changing the member's phone cancels verification.`,
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^\\d{6}$', description: 'The 6 digits the user heard.' }, memberId: MEMBER_ID_PROPERTY },
      required: ['code'],
      additionalProperties: false,
    },
  },
  execute: async (args: unknown, context?: ToolContext) => {
    const { code, memberId } = onlyKeys(args, ['code', 'memberId']);
    const { org, caller } = await callerIdentity(context, 'hot lead call verification', true);
    configuredOrThrow(storedConfig(org));
    const result = await confirmMemberVerification(org, caller, memberIdOf(memberId), code);
    return { success: true, memberVerified: true, ...result };
  },
});
