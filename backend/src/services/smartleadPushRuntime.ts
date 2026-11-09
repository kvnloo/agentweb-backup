import { crmDb } from "./db";
import { canDestructiveCrmList } from "./crmAccessControl";
import { resolveSmartlead, reportSmartleadFailure } from "./smartleadConnection";
import { SmartleadPushRunDb } from "./smartleadPushRunDb";
import { SmartleadPushService } from "./smartleadPushService";
import { smartleadMarkerKey } from "./smartleadMarkers";
import { addLeadsToCampaign, deleteCampaignWebhook, findLeadIdByEmail, getCampaign, getCampaignAnalytics, getCampaignEmailAccounts, getCampaignSequences, listCampaigns, listCampaignWebhooks, saveCampaignWebhook, unsubscribeLeadGlobally, updateLeadEmail } from "./smartleadService";
import { getJwtSecret } from "../config/jwt";
import { ensureEventWebhook, publicBaseUrl, type WebhookApi } from "./smartleadEventRegistration";
import { webhookSecret } from "./smartleadWebhookToken";
import { cronJobRegistry } from "../utils/cronJobRegistry";

/**
 * The real dependencies of the Smartlead push (ENG-673), built once per process. Kept apart from smartleadPushService.ts so the service is
 * tested without the database layer.
 *
 * THE KILL SWITCH is the environment variable SMARTLEAD_PUSH_ENABLED: pushing is OFF unless it is exactly "true". It is read on every call,
 * so a running run pauses at its next batch when the value is changed in a process that picks the change up; changing a deployed
 * environment variable means a restart (a runtime toggle is a tracked temporary measure).
 */
/** The real Smartlead webhook calls: one quick retry each (nothing here may hold a push up). */
export const realWebhookApi: WebhookApi = {
  list: (apiKey, campaignId) => listCampaignWebhooks(apiKey, campaignId, { maxRetries: 1 }),
  save: (apiKey, campaignId, input) => saveCampaignWebhook(apiKey, campaignId, input, { maxRetries: 1 }),
  del: (apiKey, campaignId, webhookId) => deleteCampaignWebhook(apiKey, campaignId, webhookId, { maxRetries: 1 }),
};

export const smartleadPushEnabled = (): boolean => process.env.SMARTLEAD_PUSH_ENABLED === "true";

let service: SmartleadPushService | null = null;

export function getSmartleadPushService(): SmartleadPushService {
  if (service) return service;
  service = new SmartleadPushService({
    db: new SmartleadPushRunDb(),
    getList: async listId => ((await crmDb.getLeadListById(listId)) as Record<string, any> | null) ?? null,
    canEdit: (userId, list) => canDestructiveCrmList(userId, list),
    resolveKey: resolveSmartlead,
    reportFailure: reportSmartleadFailure,
    crm: {
      // A hand-built {listId, leadId} is an exclusive start key on the newest-first query (verified on DynamoDB Local).
      readLeads: async (listId, after, limit) => {
        const page = await crmDb.getLeadsByListId(listId, limit, after ? { listId: after.listId, leadId: after.leadId } : undefined);
        return { items: page.items as Record<string, any>[], hasMore: page.hasMore };
      },
      readLeadConsistent: async (listId, leadId) => ((await crmDb.getLeadById(listId, leadId, { consistentRead: true })) as Record<string, any> | null) ?? null,
      writeMarker: async (listId, leadId, key, marker) => {
        await crmDb.setLeadFields(listId, leadId, { system: { [key]: marker } });
      },
    },
    smartlead: {
      listCampaigns: apiKey => listCampaigns(apiKey, { maxRetries: 1 }),
      getCampaign: (apiKey, id) => getCampaign(apiKey, id, { maxRetries: 1 }),
      getCampaignAnalytics: (apiKey, id) => getCampaignAnalytics(apiKey, id, { maxRetries: 1 }),
      getSequences: (apiKey, id) => getCampaignSequences(apiKey, id, { maxRetries: 1 }),
      getMailboxes: (apiKey, id) => getCampaignEmailAccounts(apiKey, id, { maxRetries: 1 }),
      // One retry: a POST that backs off for minutes would outlive the run's 90-second lease, and the lead markers make a resend safe.
      addLeads: (apiKey, id, leads) => addLeadsToCampaign(apiKey, id, leads, { maxRetries: 1 }),
      unsubscribeLead: (apiKey, leadId) => unsubscribeLeadGlobally(apiKey, leadId, { maxRetries: 1 }),
      updateLeadEmail: (apiKey, campaignId, leadId, email) => updateLeadEmail(apiKey, campaignId, leadId, email, { maxRetries: 1 }),
      findLeadId: (apiKey, email) => findLeadIdByEmail(apiKey, email, { maxRetries: 1 }),
    },
    registerEvents: (apiKey, accountId, campaignId) => ensureEventWebhook(realWebhookApi, { apiKey, accountId, campaignId, baseUrl: publicBaseUrl(), secret: webhookSecret() }),
    secret: getJwtSecret(),
    enabled: smartleadPushEnabled,
    now: () => new Date(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    track: (name, job) => cronJobRegistry.track(name, job),
    log: line => console.log(line),
  });
  return service;
}

export { smartleadMarkerKey };
