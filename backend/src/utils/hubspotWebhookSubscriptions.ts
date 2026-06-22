import axios from 'axios';
import { getHubSpotCredentials } from './secretsManager';

const HUBSPOT_WEBHOOKS_BASE = 'https://api.hubapi.com/webhooks/v3';

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
    { params: { hapikey: developerApiKey } }
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
        (sub.eventType === 'contact.creation' || sub.eventType === 'contact.deletion')) {
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
    { params: { hapikey: developerApiKey } }
  );
  console.log(`[HubSpotWebhook] Registered ${eventType}${propertyName ? ` for "${propertyName}"` : ''}`);
}

/**
 * Ensures webhook subscriptions exist for all HubSpot contact and deal properties
 * that need real-time sync. Fire-and-forget — never throws.
 *
 * Contact: standard fields + any enabled non-push-only custom mappings.
 * Deal: amount, dealstage, deal_currency_code (always — no user config needed).
 */
export async function ensureWebhookSubscriptions(
  contactFieldMapping: Array<{ crmProperty: string; enabled: boolean; direction: string }>,
  customFieldMapping: Array<{ crmProperty: string; enabled: boolean; direction: string }>,
): Promise<void> {
  try {
    const credentials = await getHubSpotCredentials();
    const { developerApiKey, hubspotAppId: appId } = credentials;
    if (!appId) {
      console.warn('[HubSpotWebhook] No hubspotAppId in credentials — skipping subscription sync');
      return;
    }
    if (!developerApiKey) {
      console.warn('[HubSpotWebhook] No developerApiKey in credentials — skipping subscription sync');
      return;
    }

    const candidateProps = new Set<string>();

    // Contact: lifecycle events (no propertyName)
    candidateProps.add('contact.creation');
    candidateProps.add('contact.deletion');

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
      return;
    }

    // HubSpot enforces a 1,000 subscription limit per app. Warn early.
    const totalAfter = existingSubscriptions.size + toRegister.length;
    if (totalAfter >= 900) {
      console.warn(`[HubSpotWebhook] Approaching subscription limit: ${totalAfter}/1000 after this batch`);
    }

    for (const key of toRegister) {
      const colonIdx = key.indexOf(':');
      const eventType = colonIdx >= 0 ? key.slice(0, colonIdx) : key;
      const propertyName = colonIdx >= 0 ? key.slice(colonIdx + 1) : undefined;
      try {
        await registerSubscription(appId, developerApiKey, eventType, propertyName);
      } catch (err: any) {
        const detail = err?.response?.data ?? err?.message;
        const status = err?.response?.status;
        console.error(`[HubSpotWebhook] Failed to register ${eventType} for "${propertyName}" (HTTP ${status}):`, JSON.stringify(detail));
      }
    }
  } catch (err: any) {
    console.error('[HubSpotWebhook] ensureWebhookSubscriptions error:', err?.message);
  }
}
