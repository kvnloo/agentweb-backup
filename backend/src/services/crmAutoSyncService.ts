import { crmDb } from "./db";
import { settingsService } from "./settingsService";
import { mergeCustomFields } from '../utils/customFieldsGuard';

export interface UserCrmUpdateFields {
  subscriptionType?: string;
  subscription_status?: string;
  stripe_customer_id?: string;
  roles?: string[];
  isAdmin?: boolean;
  isActive?: boolean;
}

const CRM_SYNC_SETTING_KEY = "admin_crm_sync_users";

interface CrmSyncSetting {
  listId: string;
  lastSyncAt?: string;
  autoSync?: boolean;
}

const parseSetting = (rawValue?: string | null): CrmSyncSetting | null => {
  if (!rawValue) return null;
  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== "object" || typeof parsed.listId !== "string") return null;
    return parsed.listId.trim() ? parsed : null;
  } catch {
    return null;
  }
};

const splitName = (fullName?: string | null): { firstName?: string; lastName?: string } => {
  if (!fullName || typeof fullName !== "string") return {};
  const parts = fullName.trim().split(/\s+/);
  if (!parts[0]) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
};

/**
 * Sync a single user to the CRM lead list if auto-sync is enabled.
 * Fire-and-forget — errors are logged but never thrown to avoid breaking registration.
 */
export async function syncNewUserToLeadList(user: {
  userId: string;
  email: string;
  fullName?: string;
  displayName?: string;
  name?: string;
  roles?: string[];
  isAdmin?: boolean;
  isActive?: boolean;
  createdAt?: string;
  stripe_customer_id?: string;
  subscriptionType?: string;
  attribution?: import("../types/attribution").AttributionTouch;
}): Promise<void> {
  try {
    const setting = await settingsService.getSetting(CRM_SYNC_SETTING_KEY);
    const parsed = parseSetting(setting?.settingValue);

    if (!parsed?.listId || !parsed.autoSync) return;

    const leadList = await crmDb.getLeadListById(parsed.listId);
    if (!leadList || leadList.publicAccessEnabled !== true) return;

    const nameFromRecord = user.fullName || user.displayName || user.name || "";
    const parsedName = splitName(nameFromRecord);

    const lead = {
      email: String(user.email || "").toLowerCase(),
      firstName: parsedName.firstName,
      lastName: parsedName.lastName,
      customFields: {
        source: "admin_users",
        userId: user.userId || "",
        roles: Array.isArray(user.roles) ? user.roles.join(",") : "",
        isAdmin: user.isAdmin ? "yes" : "no",
        isActive: user.isActive === false ? "no" : "yes",
        createdAt: user.createdAt || new Date().toISOString(),
        stripe_customer_id: user.stripe_customer_id || "",
        subscriptionType: user.subscriptionType || "",

        // Default activation fields for a newly registered user
        chatSessionCount: 0,
        brandGuidelinesCompletedAt: "",
        lastActiveDate: (user.createdAt || new Date().toISOString()).split('T')[0],

        // Attribution — flattened so each field is queryable/filterable in the CRM
        ...(user.attribution?.utm?.source && { utm_source: user.attribution.utm.source }),
        ...(user.attribution?.utm?.medium && { utm_medium: user.attribution.utm.medium }),
        ...(user.attribution?.utm?.campaign && { utm_campaign: user.attribution.utm.campaign }),
        ...(user.attribution?.utm?.content && { utm_content: user.attribution.utm.content }),
        ...(user.attribution?.utm?.term && { utm_term: user.attribution.utm.term }),
        ...(user.attribution?.clickIds?.gclid && { gclid: user.attribution.clickIds.gclid }),
        ...(user.attribution?.clickIds?.fbclid && { fbclid: user.attribution.clickIds.fbclid }),
        ...(user.attribution?.clickIds?.ttclid && { ttclid: user.attribution.clickIds.ttclid }),
        ...(user.attribution?.clickIds?.liFatId && { li_fat_id: user.attribution.clickIds.liFatId }),
        ...(user.attribution?.referrer && { referrer: user.attribution.referrer }),
        ...(user.attribution?.landingUrl && { landing_url: user.attribution.landingUrl }),
        ...(user.attribution?.ref && { ref: user.attribution.ref }),
      },
    };

    await crmDb.batchCreateLeads(parsed.listId, [lead]);
  } catch (error) {
    console.error("[crmAutoSync] Failed to sync new user to lead list:", error);
  }
}

/**
 * Sync changed user fields back to the matching CRM lead record if auto-sync is enabled.
 * Looks up the lead by email using the GSI, then merges only the supplied fields.
 * Fire-and-forget — errors are logged but never thrown.
 */
export async function syncUserUpdateToLeadList(
  email: string,
  updates: UserCrmUpdateFields
): Promise<void> {
  try {
    const setting = await settingsService.getSetting(CRM_SYNC_SETTING_KEY);
    const parsed = parseSetting(setting?.settingValue);

    if (!parsed?.listId || !parsed.autoSync) return;

    const leadList = await crmDb.getLeadListById(parsed.listId);
    if (!leadList || leadList.publicAccessEnabled !== true) return;

    const normalizedEmail = String(email || "").toLowerCase();
    const existingLead = await crmDb.getLeadByEmail(parsed.listId, normalizedEmail);
    if (!existingLead) return;

    // Build the customFields patch — only include fields that were actually supplied
    const customFieldsPatch: Record<string, any> = {};
    if (updates.subscriptionType !== undefined) customFieldsPatch.subscriptionType = updates.subscriptionType;
    if (updates.subscription_status !== undefined) customFieldsPatch.subscription_status = updates.subscription_status;
    if (updates.stripe_customer_id !== undefined) customFieldsPatch.stripe_customer_id = updates.stripe_customer_id;
    if (updates.roles !== undefined) customFieldsPatch.roles = Array.isArray(updates.roles) ? updates.roles.join(",") : updates.roles;
    if (updates.isAdmin !== undefined) customFieldsPatch.isAdmin = updates.isAdmin ? "yes" : "no";
    if (updates.isActive !== undefined) customFieldsPatch.isActive = updates.isActive === false ? "no" : "yes";

    if (Object.keys(customFieldsPatch).length === 0) return;

    await crmDb.updateLead(parsed.listId, existingLead.leadId, {
      customFields: mergeCustomFields(
        existingLead.customFields,
        customFieldsPatch,
        { source: 'crmAutoSync.syncUserUpdate', listId: parsed.listId, leadId: existingLead.leadId },
      ),
    });
  } catch (error) {
    console.error("[crmAutoSync] Failed to sync user update to lead list:", error);
  }
}
