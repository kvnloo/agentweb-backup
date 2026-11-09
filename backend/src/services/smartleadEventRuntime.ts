import { crmDb } from "./db";
import { leadListAlertService } from "./leadListAlertService";
import { SmartleadPushRunDb } from "./smartleadPushRunDb";
import { SmartleadEventService } from "./smartleadEventService";
import { eventPoll, type PollResult } from "./smartleadEventPoll";
import { reportSmartleadFailure, resolveSmartlead } from "./smartleadConnection";
import { getCampaign, listCampaignLeadsByEmailStatus, scrubSmartleadSecrets, SmartleadApiError } from "./smartleadService";

/** The real dependencies of the Smartlead event handler (ENG-673, slice 3), built once per process. */
let service: SmartleadEventService | null = null;

export function getSmartleadEventService(): SmartleadEventService {
  if (service) return service;
  const runs = new SmartleadPushRunDb();
  service = new SmartleadEventService({
    findLeadsByEmail: async email => (await crmDb.findAllLeadsByEmail(email)) as Record<string, any>[],
    getRun: async runId => {
      const run = await runs.getRun(runId);
      return run ? { smartleadAccountId: run.smartleadAccountId, campaignId: run.campaignId, campaignName: run.campaignName } : null;
    },
    getList: async listId => ((await crmDb.getLeadListById(listId)) as Record<string, any> | null) ?? null,
    readLeadConsistent: async (listId, leadId) => ((await crmDb.getLeadById(listId, leadId, { consistentRead: true })) as Record<string, any> | null) ?? null,
    addEngagement: async (listId, leadId, engagement, opts) => {
      await crmDb.addLeadEngagement(listId, leadId, engagement, opts);
    },
    setContactStatus: async (listId, leadId, fields) => {
      await crmDb.updateLead(listId, leadId, fields as any);
    },
    notify: async (list, lead, eventType, eventData, createdAt) => {
      await leadListAlertService.notifyLeadListOwnerIfConfigured(list, lead, eventType, eventData, createdAt);
    },
    countContactEvent: async (runId, kind) => {
      await runs.countContactEvent(runId, kind);
    },
    now: () => new Date(),
    log: line => console.log(line),
  });
  return service;
}

/**
 * The hourly poll that backs up the webhook (smartleadEventPoll.ts). Runs whether or not pushing is switched on, like the withdrawal sweep: stopping
 * pushes must never stop opt-outs. Never throws.
 */
export async function pollSmartleadEvents(): Promise<PollResult | null> {
  try {
    return await eventPoll({
      db: new SmartleadPushRunDb(),
      resolveKey: resolveSmartlead,
      reportFailure: reportSmartleadFailure,
      smartlead: {
        // A campaign deleted in Smartlead answers 404 (or an empty 200): either way it is gone, which is not an error.
        campaignStatus: async (apiKey, campaignId) => {
          try {
            return (await getCampaign(apiKey, campaignId, { maxRetries: 1 }))?.status ?? null;
          } catch (error) {
            if (error instanceof SmartleadApiError && error.status === 404) return null;
            throw error;
          }
        },
        listLeads: (apiKey, campaignId, status, offset, limit) => listCampaignLeadsByEmailStatus(apiKey, campaignId, status, { offset, limit, maxRetries: 1 }),
      },
      events: getSmartleadEventService(),
      now: () => new Date(),
      log: line => console.log(line),
    });
  } catch (error) {
    console.error(`[SmartleadPoll] poll error: ${scrubSmartleadSecrets(error instanceof Error ? error.message : String(error))}`);
    return null;
  }
}
