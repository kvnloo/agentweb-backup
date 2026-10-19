import { emmaToolRegistry } from './registry';
import { callerOrg, type ToolContext } from './orgCaller';
import { storedConfig } from './hotLeadCallTools';
import { maskPhone, type HotLeadCallConfig } from '../services/hotLeadCallConfig';
import { startVerification, confirmVerification, VERIFICATION_CODE_TTL_MS, VERIFICATION_MAX_ATTEMPTS } from '../services/voice/destinationVerification';
import { provisionNumber, releaseNumber } from '../services/voice/numberProvisioning';

/**
 * Setup tools for the hot lead auto-call: caller number, then destination-phone verification. Unlike the
 * live call flow they do NOT depend on the global hot_lead_call_mode kill switch: setup can be finished
 * while calling is off. They need org:configure and are blocked in shared sessions (toolDispatch).
 */

const NO_ARGS_MESSAGE = 'Invalid hot lead call setup arguments';

function onlyKeys(args: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(NO_ARGS_MESSAGE);
  // Models often send null for omitted optionals; treat null as "not provided".
  const entries = Object.entries(args).filter(([, v]) => v !== null);
  if (entries.some(([k]) => !allowed.includes(k))) throw new Error(NO_ARGS_MESSAGE);
  return Object.fromEntries(entries);
}

function userIdOf(context: ToolContext): string {
  return String(context?.userId || context?.agentUserId);
}

function configuredOrThrow(config: HotLeadCallConfig | undefined): HotLeadCallConfig {
  if (!config) throw new Error('Save the hot lead call settings first (update_hot_lead_call_settings): a destination phone and a business name are needed.');
  return config;
}

emmaToolRegistry.register({
  name: 'provision_hot_lead_call_number',
  definition: {
    name: 'provision_hot_lead_call_number',
    description: 'Buy the phone number the hot lead auto-call is placed from (org owners/admins only). This spends money: the number costs about $1.15 per month on your Twilio account, charged now and every month until it is released. Set it up in this order: save settings, get a number with this tool, verify the destination phone, then enable calling. Needs saved hot lead call settings, and each organization can hold one number. Pass confirm:true only after the user has agreed to the cost. areaCode (3 digits) is optional and picks a US area code. If the result says the purchase could not be confirmed, do not retry; tell the user to contact support. Works even while hot lead calling is switched off platform-wide.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Must be true: the user agreed to the monthly cost.' },
        areaCode: { type: 'string', pattern: '^\\d{3}$', description: 'Optional US area code, exactly 3 digits.' },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
  },
  execute: async (args: unknown, context?: ToolContext) => {
    const { confirm, areaCode } = onlyKeys(args, ['confirm', 'areaCode']);
    if (confirm !== true) throw new Error('Buying a number costs money. Ask the user to agree to about $1.15 per month, then call again with confirm:true.');
    if (areaCode !== undefined && (typeof areaCode !== 'string' || !/^\d{3}$/.test(areaCode))) throw new Error('areaCode must be exactly 3 digits, for example 415');
    const org = await callerOrg(context, 'the hot lead caller number', true);
    const config = configuredOrThrow(storedConfig(org.hotLeadCall));
    const result = await provisionNumber({ org, config, userId: userIdOf(context), areaCode });
    return {
      success: true, ...result,
      note: 'The first month is billed now; the number renews monthly until released. Next: verify the destination phone.',
    };
  },
});

emmaToolRegistry.register({
  name: 'release_hot_lead_call_number',
  definition: {
    name: 'release_hot_lead_call_number',
    description: 'Release the hot lead auto-call phone number (org owners/admins only). Hot lead calling is turned off first and stays off until a new number is provisioned and calling is enabled again; the monthly charge stops. Works even while hot lead calling is switched off platform-wide.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  execute: async (args: unknown, context?: ToolContext) => {
    onlyKeys(args, []);
    const org = await callerOrg(context, 'the hot lead caller number', true);
    const config = configuredOrThrow(storedConfig(org.hotLeadCall));
    return { success: true, ...(await releaseNumber({ org, config })) };
  },
});

emmaToolRegistry.register({
  name: 'start_hot_lead_call_verification',
  definition: {
    name: 'start_hot_lead_call_verification',
    description: `Phone the saved destination number and read out a 6-digit code, to prove the owner controls it (org owners/admins only). Needs saved settings and a provisioned caller number (provision_hot_lead_call_number first). It always calls the saved number, never one you pass. The code is only spoken on the call: it is never shown here, so ask the user to read it back, then call confirm_hot_lead_call_verification. The code is valid for ${VERIFICATION_CODE_TTL_MS / 60_000} minutes with ${VERIFICATION_MAX_ATTEMPTS} attempts. Limits: one call per 2 minutes and 5 per day. Each call costs a small Twilio voice charge. Works even while hot lead calling is switched off platform-wide.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  execute: async (args: unknown, context?: ToolContext) => {
    onlyKeys(args, []);
    const org = await callerOrg(context, 'hot lead call verification', true);
    const config = configuredOrThrow(storedConfig(org.hotLeadCall));
    const result = await startVerification(org, config, userIdOf(context));
    return {
      success: true, ...result,
      note: `A call to ${result.destinationPhone} is on its way. Ask the user for the 6-digit code they hear.`,
    };
  },
});

emmaToolRegistry.register({
  name: 'confirm_hot_lead_call_verification',
  definition: {
    name: 'confirm_hot_lead_call_verification',
    description: `Check the 6-digit code the user heard on the verification call (org owners/admins only). On success the destination phone is marked verified; calling can then be switched on with update_hot_lead_call_settings once a caller number and quiet hours are also set. A wrong code uses one of ${VERIFICATION_MAX_ATTEMPTS} attempts; after that, or after ${VERIFICATION_CODE_TTL_MS / 60_000} minutes, start a new verification. Changing the destination phone cancels verification.`,
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^\\d{6}$', description: 'The 6 digits the user heard.' } },
      required: ['code'],
      additionalProperties: false,
    },
  },
  execute: async (args: unknown, context?: ToolContext) => {
    const { code } = onlyKeys(args, ['code']);
    const digits = typeof code === 'string' ? code.replace(/[\s-]/g, '') : '';
    if (!/^\d{6}$/.test(digits)) throw new Error('The code is 6 digits');
    const org = await callerOrg(context, 'hot lead call verification', true);
    const config = configuredOrThrow(storedConfig(org.hotLeadCall));
    const result = await confirmVerification(org, config, digits);
    return { success: true, destinationVerified: true, destinationPhone: maskPhone(config.destinationPhone), verifiedAt: result.verifiedAt };
  },
});
