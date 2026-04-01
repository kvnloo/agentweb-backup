import { userDb, crmDb } from '../services/db';
import { settingsService } from '../services/settingsService';

const getCrmSyncSettingName = (source: string) => `admin_crm_sync_${source}`;
const parseCrmSyncSetting = (rawValue?: string | null) => {
    if (!rawValue) return null;
    try {
        const parsed = JSON.parse(rawValue);
        if (!parsed || typeof parsed !== 'object' || typeof parsed.listId !== 'string') return null;
        return parsed.listId.trim() ? parsed : null;
    } catch {
        return null;
    }
};

/**
 * Runs the daily Activation User Analysis.
 * 1. Updates CRM with activation fields (daily).
 * 2. Sends nudge emails for users stuck in needs_first_session or needs_brand_setup (weekly on Mondays).
 */
export async function runActivationAnalysis() {
    console.log("[ActivationCron] Starting execution...");
    try {
        const allUsers = await userDb.getAllUsers();
        console.log(`[ActivationCron] Found ${allUsers.length} users to analyze`);

        // chatSessionCount is already computed by userDb.getAllUsers() via UserIdIndex GSI
        const metrics = allUsers.map((u: any) => {
            const chatSessionCount = u.chatSessionCount ?? 0;
            const brandGuidelinesCompleted = !!u.brandGuidelines;
            const brandGuidelinesCreatedAt = u.brandGuidelines?.createdAt || "";
            const lastActiveDateRaw = u.lastLoginTime || u.lastActiveAt || u.createdAt;
            const lastActiveDateParsed = new Date(lastActiveDateRaw);
            const lastActiveDate = isNaN(lastActiveDateParsed.getTime())
                ? new Date().toISOString().split('T')[0]
                : lastActiveDateParsed.toISOString().split('T')[0];

            return {
                userId: u.userId,
                email: u.email,
                customFields: {
                    chatSessionCount,
                    brandGuidelinesCompleted: brandGuidelinesCompleted ? "true" : "false",
                    brandGuidelinesCreatedAt,
                    lastActiveDate,
                }
            };
        });

        // 1. Update CRM
        const syncSettingRaw = await settingsService.getSetting(getCrmSyncSettingName('users'));
        const parsed = parseCrmSyncSetting(syncSettingRaw?.settingValue);

        if (parsed?.listId && metrics.length > 0) {
            const leadList = await crmDb.getLeadListById(parsed.listId);
            if (!leadList || leadList.publicAccessEnabled !== true) {
                console.log("[ActivationCron] Lead list not found or public access not enabled — skipping CRM update.");
                console.log("[ActivationCron] Execution completed successfully.");
                return;
            }
            // Map back to the format crmDb expects for leads
            const leadsToUpdate = metrics.map(m => ({ email: m.email, customFields: m.customFields }));
            const crmResult = await crmDb.batchCreateLeads(parsed.listId, leadsToUpdate);
            console.log(`[ActivationCron] CRM Update complete: ${crmResult.mergedCount} merged, ${crmResult.newCount} new, ${crmResult.errorCount} errors`);
        } else {
            console.log("[ActivationCron] CRM Sync disabled or no list ID configured for users.");
        }

        console.log("[ActivationCron] Execution completed successfully.");
    } catch (error) {
        console.error("[ActivationCron] CRITICAL ERROR during execution:", error);
    }
}
