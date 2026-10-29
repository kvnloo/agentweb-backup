import { crmDb } from "./db";
import { leadListAlertService } from "./leadListAlertService";
import { SmartleadPushRunDb } from "./smartleadPushRunDb";
import { SmartleadEventService } from "./smartleadEventService";

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
    now: () => new Date(),
    log: line => console.log(line),
  });
  return service;
}
