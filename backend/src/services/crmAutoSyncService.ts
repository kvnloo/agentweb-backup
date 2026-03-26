import { crmDb } from "./db";
import { settingsService } from "./settingsService";

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
      },
    };

    await crmDb.batchCreateLeads(parsed.listId, [lead]);
  } catch (error) {
    console.error("[crmAutoSync] Failed to sync new user to lead list:", error);
  }
}
