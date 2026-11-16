import axios from 'axios';
import { getHubSpotCredentials } from './secretsManager';

const HUBSPOT_WEBHOOKS_BASE = 'https://api.hubapi.com/webhooks/v3';
// Bounded so a hung socket cannot hold the boot claim (and queue every later sync behind it) forever.
const REQUEST_TIMEOUT_MS = 15000;

const STANDARD_CONTACT_PROPS_TO_SUBSCRIBE = new Set([
  'email', 'firstname', 'lastname', 'phone', 'jobtitle', 'company', 'hs_linkedin_url',
]);

const STANDARD_DEAL_PROPS_TO_SUBSCRIBE = new Set([
  'amount', 'dealstage', 'deal_currency_code',
]);

interface HubSpotWebhookSubscription {
  id: number;
  eventType: string;
  propertyName?: string;
  active: boolean;
}

async function getExistingSubscriptions(appId: string, developerApiKey: string): Promise<Set<string>> {
  const res = await axios.get<{ results: HubSpotWebhookSubscription[] } | HubSpotWebhookSubscription[]>(
    `${HUBSPOT_WEBHOOKS_BASE}/${appId}/subscriptions`,
    { params: { hapikey: developerApiKey }, timeout: REQUEST_TIMEOUT_MS }
  );
  const subscribed = new Set<string>();
  const subs: HubSpotWebhookSubscription[] = Array.isArray(res.data)
    ? res.data
    : Array.isArray((res.data as any)?.results)
      ? (res.data as any).results
      : [];
  for (const sub of subs) {
    if (sub.propertyName &&
        (sub.eventType === 'contact.propertyChange' || sub.eventType === 'deal.propertyChange')) {
      subscribed.add(`${sub.eventType}:${sub.propertyName.toLowerCase()}`);
    } else if (!sub.propertyName &&
        (sub.eventType === 'contact.creation' || sub.eventType === 'contact.deletion' || sub.eventType === 'contact.merge')) {
      subscribed.add(sub.eventType);
    }
  }
  return subscribed;
}

async function registerSubscription(appId: string, developerApiKey: string, eventType: string, propertyName?: string): Promise<void> {
  const payload: Record<string, any> = { eventType, active: true };
  if (propertyName) payload.propertyName = propertyName;
  await axios.post(
    `${HUBSPOT_WEBHOOKS_BASE}/${appId}/subscriptions`,
    payload,
    { params: { hapikey: developerApiKey }, timeout: REQUEST_TIMEOUT_MS }
  );
  console.log(`[HubSpotWebhook] Registered ${eventType}${propertyName ? ` for "${propertyName}"` : ''}`);
}

/** HubSpot's answer when the app was created by a project: 403 BANNED / PROJECT_BASED_APP_WEBHOOK_EDIT_ERROR. */
function isProjectManagedWebhookError(err: any): boolean {
  if (err?.response?.status !== 403) return false;
  const d = err.response.data;
  return d?.subCategory === 'AppProjectAssociationErrors.PROJECT_BASED_APP_WEBHOOK_EDIT_ERROR'
    || /webhook configuration can't be edited through the API/i.test(String(d?.message ?? ''));
}

type FieldMappings = Array<{ crmProperty: string; enabled: boolean; direction: string }>;

// Runs are serialised within a process: each reads the subscription list, then registers what is
// missing, so two overlapping runs (boot sync + a config save) could both register the same one.
let inFlight: Promise<void> = Promise.resolve();

/**
 * Ensures webhook subscriptions exist for all HubSpot contact and deal properties
 * that need real-time sync. Fire-and-forget — never throws.
 *
 * Contact: standard fields + any enabled non-push-only custom mappings.
 * Deal: amount, dealstage, deal_currency_code (always — no user config needed).
 */
export function ensureWebhookSubscriptions(
  contactFieldMapping: FieldMappings,
  customFieldMapping: FieldMappings,
): Promise<void> {
  return runSerialised(contactFieldMapping, customFieldMapping).then(() => undefined);
}

/** Same work, but reports whether every subscription is now in place (false = something failed and is worth retrying). */
export function ensureWebhookSubscriptionsChecked(
  contactFieldMapping: FieldMappings = [],
  customFieldMapping: FieldMappings = [],
): Promise<boolean> {
  return runSerialised(contactFieldMapping, customFieldMapping);
}

function runSerialised(contactFieldMapping: FieldMappings, customFieldMapping: FieldMappings): Promise<boolean> {
  const run = inFlight.then(() => syncSubscriptions(contactFieldMapping, customFieldMapping));
  inFlight = run.then(() => undefined, () => undefined);
  return run;
}

async function syncSubscriptions(
  contactFieldMapping: FieldMappings,
  customFieldMapping: FieldMappings,
): Promise<boolean> {
  try {
    const credentials = await getHubSpotCredentials();
    const { developerApiKey, hubspotAppId: appId } = credentials;
    if (!appId) {
      console.warn('[HubSpotWebhook] No hubspotAppId in credentials — skipping subscription sync');
      return true;   // nothing this environment can do; retrying would not help
    }
    if (!developerApiKey) {
      console.warn('[HubSpotWebhook] No developerApiKey in credentials — skipping subscription sync');
      return true;
    }

    const candidateProps = new Set<string>();

    // Contact: lifecycle events (no propertyName)
    candidateProps.add('contact.creation');
    candidateProps.add('contact.deletion');
    // A merge leaves our stored hubspot_contact_id pointing at the merged-away contact (ENG-2465).
    candidateProps.add('contact.merge');

    // Contact: standard props
    for (const prop of STANDARD_CONTACT_PROPS_TO_SUBSCRIBE) {
      candidateProps.add(`contact.propertyChange:${prop}`);
    }

    // Contact: custom-mapped props (enabled, not push-only)
    for (const m of [...contactFieldMapping, ...customFieldMapping]) {
      if (!m.enabled || m.direction === 'push') continue;
      const prop = m.crmProperty?.trim().toLowerCase();
      if (prop) candidateProps.add(`contact.propertyChange:${prop}`);
    }

    // Deal: fixed set — always subscribe regardless of user config
    for (const prop of STANDARD_DEAL_PROPS_TO_SUBSCRIBE) {
      candidateProps.add(`deal.propertyChange:${prop}`);
    }

    const existingSubscriptions = await getExistingSubscriptions(appId, developerApiKey);

    const toRegister = Array.from(candidateProps).filter(p => !existingSubscriptions.has(p));
    if (toRegister.length === 0) {
      console.log('[HubSpotWebhook] All properties already subscribed — nothing to register');
      return true;
    }

    // HubSpot enforces a 1,000 subscription limit per app. Warn early.
    const totalAfter = existingSubscriptions.size + toRegister.length;
    if (totalAfter >= 900) {
      console.warn(`[HubSpotWebhook] Approaching subscription limit: ${totalAfter}/1000 after this batch`);
    }

    let allRegistered = true;
    for (const key of toRegister) {
      const colonIdx = key.indexOf(':');
      const eventType = colonIdx >= 0 ? key.slice(0, colonIdx) : key;
      const propertyName = colonIdx >= 0 ? key.slice(colonIdx + 1) : undefined;
      try {
        await registerSubscription(appId, developerApiKey, eventType, propertyName);
      } catch (err: any) {
        if (isProjectManagedWebhookError(err)) {
          // A developer-platform project app owns its webhook subscriptions: the API refuses every
          // edit, now and on every retry. Retrying (or posting the remaining ones) cannot help, so
          // say what to do once and report "nothing this code can do" instead of failing the build.
          console.warn(
            `[HubSpotWebhook] HubSpot refuses API changes to this app's webhook subscriptions (it is managed by a HubSpot project). ` +
            `Not registered: ${toRegister.slice(toRegister.indexOf(key)).join(', ')}. Add them to the project's webhook configuration and redeploy the project.`,
          );
          return true;
        }
        const detail = err?.response?.data ?? err?.message;
        const status = err?.response?.status;
        console.error(`[HubSpotWebhook] Failed to register ${eventType} for "${propertyName}" (HTTP ${status}):`, JSON.stringify(detail));
        allRegistered = false;
      }
    }
    return allRegistered;
  } catch (err: any) {
    console.error('[HubSpotWebhook] ensureWebhookSubscriptions error:', err?.message);
    return false;
  }
}
