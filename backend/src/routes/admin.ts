import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import axios from "axios";
import { authenticateToken } from "../middleware/auth";
import { isAdmin } from "../middleware/admin";
import { userDb, taskDb, subscriberDb, crmDb, orgDb } from "../services/db";
import { linkedInOutreachService } from "../services/linkedInOutreachService";
import { deleteAccountById } from "../services/connectedAccountsDb";
import { waitlistDb } from "../services/waitlistDb";
import { emailService } from "../services/emailService";
import { resendService } from "../services/resendService";
import { sendGTMPlanUpdateNotifications, sendPhaseStatusReport, sendPlanStatusReport } from "../services/gtmPlanNotificationService";
import { notifySlackWorkItemCompleted } from "../services/gtmPlanService";
import { chatbotDb, ChatSession } from "../services/chatbotService";
import { scoreSessionIfNeeded, scoreSessionWithJudgeIfNeeded, ScoringJudge } from "../services/sessionScoringService";
import { DynamoDB } from "aws-sdk";
import { workflowDb } from "../services/workflowDb";
import { paginatedScan } from "../utils/dynamoPagination";
import { settingsService } from "../services/settingsService";
import { encryptPassword } from "../utils/crypto";
import { grantTokenBonus, getUserTokenUsage, getUserTokenAllowance } from "../services/tokenUsageService";
import { getRevenueMetrics } from "../services/revenueService";
import { getBusinessFunnelMetrics } from "../services/businessFunnelService";
import { resyncAllSubscriptionAmounts, syncSubscriptionFromStripe } from "../services/stripeService";
import { syncNewUserToLeadList, syncUserUpdateToLeadList } from "../services/crmAutoSyncService";
import { getActivationFields } from "../cron/activationAnalysisCron";
import multer from "multer";
import { MAX_FILE_SIZE } from "../config";
import { validateEmail } from "../utils/validation";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});
const CRM_SYNC_SOURCES = new Set(["users", "waitlist"]);
const CRM_SYNC_SETTING_PREFIX = "admin_crm_sync_";

interface CrmSyncSetting {
  listId: string;
  lastSyncAt?: string;
  autoSync?: boolean;
}

const parseCrmSyncSetting = (rawValue?: string | null): CrmSyncSetting | null => {
  if (!rawValue) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== "object" || typeof parsed.listId !== "string") {
      return null;
    }
    const setting: CrmSyncSetting = {
      listId: parsed.listId.trim(),
    };
    if (parsed.lastSyncAt && typeof parsed.lastSyncAt === "string") {
      setting.lastSyncAt = parsed.lastSyncAt;
    }
    if (typeof parsed.autoSync === "boolean") {
      setting.autoSync = parsed.autoSync;
    }
    return setting.listId ? setting : null;
  } catch (error) {
    return null;
  }
};

const getCrmSyncSettingName = (source: string) => `${CRM_SYNC_SETTING_PREFIX}${source}`;

const splitName = (fullName?: string | null): { firstName?: string; lastName?: string } => {
  if (!fullName || typeof fullName !== "string") {
    return {};
  }
  const normalized = fullName.trim();
  if (!normalized) {
    return {};
  }
  const parts = normalized.split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0] };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
};

const isAfterLastSync = (recordTime: string | undefined, lastSyncAt: string | undefined): boolean => {
  if (!lastSyncAt) {
    return true;
  }
  if (!recordTime) {
    return true;
  }
  const recordMs = new Date(recordTime).getTime();
  const lastSyncMs = new Date(lastSyncAt).getTime();
  if (Number.isNaN(recordMs) || Number.isNaN(lastSyncMs)) {
    return true;
  }
  return recordMs > lastSyncMs;
};

// Apply authentication and admin middleware to all routes
router.use(authenticateToken);
router.use(isAdmin);

// Get all Unipile (LinkedIn outreach) accounts across all users (with live status + orphan detection)
router.get("/unipile-accounts", async (req, res) => {
  try {
    // 1. Build the DB-side list
    const users = await userDb.getAllUsers();
    const dbAccounts: any[] = [];
    for (const user of users) {
      const userAccounts = (user as any).connected_accounts || [];
      for (const acc of userAccounts) {
        if (acc.platform === 'unipile') {
          dbAccounts.push({
            account_id: acc.account_id,
            account_name: acc.account_name,
            user_email: (user as any).email,
            user_id: (user as any).userId,
            created_at: acc.created_at,
            updated_at: acc.updated_at,
          });
        }
      }
    }

    // 2. Fetch ALL accounts currently registered in Unipile
    let allUnipileAccounts: Array<{ id: string; name: string; type: string; created_at?: string }> = [];
    try {
      allUnipileAccounts = await linkedInOutreachService.getAllUnipileAccounts();
    } catch (unipileErr) {
      console.warn("[Admin] Failed to fetch all Unipile accounts:", unipileErr);
    }

    // 3. Fetch live status for DB accounts
    const dbAccountIds = dbAccounts.map((a) => a.account_id);
    let statusMap = new Map<string, string>();
    if (dbAccountIds.length > 0) {
      try {
        statusMap = await linkedInOutreachService.getStatusesForAccounts(dbAccountIds);
      } catch (statusErr) {
        console.warn("[Admin] Failed to fetch Unipile statuses:", statusErr);
      }
    }

    const accountsWithStatus = dbAccounts.map((a) => ({
      ...a,
      unipile_status: statusMap.get(a.account_id) ?? 'UNKNOWN',
      is_orphan: false,
    }));

    // 4. Detect orphans: in Unipile but NOT in our DB
    const dbAccountIdSet = new Set(dbAccountIds);
    const orphans = allUnipileAccounts
      .filter((u) => !dbAccountIdSet.has(u.id))
      .map((u) => ({
        account_id: u.id,
        account_name: u.name,
        user_email: null,
        user_id: null,
        created_at: u.created_at ?? null,
        updated_at: null,
        unipile_status: 'ORPHAN',
        is_orphan: true,
      }));

    res.json({ accounts: [...accountsWithStatus, ...orphans] });
  } catch (error) {
    console.error("Error fetching Unipile accounts:", error);
    res.status(500).json({ message: "Failed to fetch Unipile accounts" });
  }
});

// Force-delete a Unipile account (removes from Unipile API and, if present, from DB)
router.delete("/unipile-accounts/:accountId", async (req, res) => {
  const { accountId } = req.params;
  const { userId } = req.query as { userId?: string };
  try {
    try {
      await linkedInOutreachService.deleteAccount(accountId);
    } catch (unipileErr: any) {
      console.warn(`[Admin] Unipile API delete failed for ${accountId}:`, unipileErr?.message);
    }
    // Only touch the DB record if we have a userId (orphans don't have one)
    if (userId) {
      await deleteAccountById(userId, 'unipile', accountId);
    }
    res.json({ success: true });
  } catch (error) {
    console.error("Error force-deleting Unipile account:", error);
    res.status(500).json({ message: "Failed to delete Unipile account" });
  }
});

// Get CRM sync configuration for admin Users/Waitlist sync
router.get("/crm-sync/:source", async (req, res) => {
  try {
    const { source } = req.params;
    if (!CRM_SYNC_SOURCES.has(source)) {
      return res.status(400).json({ message: "source must be users or waitlist" });
    }

    const settingName = getCrmSyncSettingName(source);
    const setting = await settingsService.getSetting(settingName);
    const parsed = parseCrmSyncSetting(setting?.settingValue);

    if (!parsed) {
      return res.json({
        source,
        listId: "",
        lastSyncAt: null,
        autoSync: false,
      });
    }

    return res.json({
      source,
      listId: parsed.listId,
      lastSyncAt: parsed.lastSyncAt || null,
      autoSync: parsed.autoSync || false,
    });
  } catch (error) {
    console.error("Error getting CRM sync setting:", error);
    return res.status(500).json({ message: "Error fetching CRM sync setting" });
  }
});

// Save CRM sync configuration for admin Users/Waitlist sync
router.put("/crm-sync/:source", async (req, res) => {
  try {
    const { source } = req.params;
    const { listId, autoSync } = req.body;

    if (!CRM_SYNC_SOURCES.has(source)) {
      return res.status(400).json({ message: "source must be users or waitlist" });
    }
    if (!listId || typeof listId !== "string" || !listId.trim()) {
      return res.status(400).json({ message: "listId is required" });
    }

    const normalizedListId = listId.trim();
    const existingList = await crmDb.getLeadListById(normalizedListId);
    if (!existingList) {
      return res.status(404).json({ message: "Lead list not found" });
    }

    const settingName = getCrmSyncSettingName(source);
    const existingSetting = await settingsService.getSetting(settingName);
    const parsedExisting = parseCrmSyncSetting(existingSetting?.settingValue);
    const nextSetting: CrmSyncSetting = {
      listId: normalizedListId,
      lastSyncAt: parsedExisting?.lastSyncAt,
    };
    if (typeof autoSync === "boolean") {
      nextSetting.autoSync = autoSync;
    } else if (parsedExisting?.autoSync !== undefined) {
      nextSetting.autoSync = parsedExisting.autoSync;
    }

    await settingsService.setSetting(
      settingName,
      JSON.stringify(nextSetting),
      `Admin CRM sync setting for ${source}`,
      req.user?.email || "admin"
    );

    return res.json({
      success: true,
      source,
      listId: nextSetting.listId,
      lastSyncAt: nextSetting.lastSyncAt || null,
      autoSync: nextSetting.autoSync || false,
    });
  } catch (error) {
    console.error("Error saving CRM sync setting:", error);
    return res.status(500).json({ message: "Error saving CRM sync setting" });
  }
});

// Start CRM sync for users or waitlist using configured lead list ID
router.post("/crm-sync/:source/start", async (req, res) => {
  try {
    const { source } = req.params;
    const forceFullSync = req.body?.forceFullSync === true;

    if (!CRM_SYNC_SOURCES.has(source)) {
      return res.status(400).json({ message: "source must be users or waitlist" });
    }

    const settingName = getCrmSyncSettingName(source);
    const setting = await settingsService.getSetting(settingName);
    const parsed = parseCrmSyncSetting(setting?.settingValue);
    if (!parsed?.listId) {
      return res.status(400).json({ message: "Please configure lead list ID first" });
    }

    const leadList = await crmDb.getLeadListById(parsed.listId);
    if (!leadList) {
      return res.status(404).json({ message: "Configured lead list not found" });
    }
    if (leadList.publicAccessEnabled !== true) {
      return res.status(400).json({
        message: "Configured lead list API integration is not enabled. Enable Public Access in CRM first.",
      });
    }

    let leads: Array<{
      email?: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
      company?: string;
      title?: string;
      notes?: string;
      customFields?: Record<string, any>;
    }> = [];
    const previousLastSyncAt = parsed.lastSyncAt;

    if (source === "users") {
      const users = await userDb.getAllUsers();
      const filteredUsers = users.filter((user: any) => {
        if (!user?.email) {
          return false;
        }
        if (forceFullSync) {
          return true;
        }
        return isAfterLastSync(user.createdAt, previousLastSyncAt);
      });

      // chatSessionCount is already computed by userDb.getAllUsers() via UserIdIndex GSI
      leads = filteredUsers.map((user: any) => {
        const nameFromRecord = user.fullName || user.displayName || user.name || "";
        const parsedName = splitName(nameFromRecord);
        const activationFields = getActivationFields(user);

        return {
          email: String(user.email || "").toLowerCase(),
          firstName: parsedName.firstName,
          lastName: parsedName.lastName,
          notes: user.supportNote || "",
          customFields: {
            source: "admin_users",
            userId: user.userId || "",
            roles: Array.isArray(user.roles) ? user.roles.join(",") : "",
            isAdmin: user.isAdmin ? "yes" : "no",
            isActive: user.isActive === false ? "no" : "yes",
            createdAt: user.createdAt || "",
            lastLoginTime: user.lastLoginTime || "",
            stripe_customer_id: user.stripe_customer_id || "",
            adAccount: user.adAccount || "",
            emailDomain: user.emailDomain || "",
            slackChannel: user.slackChannel || "",
            subscriptionType: user.subscriptionType || "",
            ...activationFields,
          },
        };
      });
    } else {
      const waitlistEntries: any[] = [];
      let lastEvaluatedKey: any = undefined;
      do {
        const result = await waitlistDb.list(lastEvaluatedKey);
        waitlistEntries.push(...(result.items || []));
        lastEvaluatedKey = result.lastEvaluatedKey;
      } while (lastEvaluatedKey);

      const filteredEntries = waitlistEntries.filter((entry: any) => {
        if (!entry?.email) {
          return false;
        }
        if (forceFullSync) {
          return true;
        }
        const createdTime = entry.joinedAt || entry.createdAt;
        return isAfterLastSync(createdTime, previousLastSyncAt);
      });

      leads = filteredEntries.map((entry: any) => {
        const parsedName = splitName(entry.fullName || "");
        return {
          email: String(entry.email || "").toLowerCase(),
          firstName: parsedName.firstName,
          lastName: parsedName.lastName,
          phone: entry.phoneNumber || "",
          company: entry.companyName || "",
          notes: entry.useCaseDescription || "",
          customFields: {
            source: "admin_waitlist",
            status: entry.status || "pending",
            joinedAt: entry.joinedAt || "",
            invitedAt: entry.invitedAt || "",
            requestReport: entry.requestReport === true ? "yes" : "no",
            supportNote: entry.supportNote || "",
            stripe_customer_id: entry.stripe_customer_id || "",
            monthlyMarketingSpend: entry.monthlyMarketingSpend || "",
            businessArea: entry.businessArea || "",
            marketingChannels: Array.isArray(entry.marketingChannels) ? entry.marketingChannels.join(",") : "",
            useCaseCategories: Array.isArray(entry.useCaseCategories) ? entry.useCaseCategories.join(",") : "",
          },
        };
      });
    }

    const syncStartedAt = new Date().toISOString();
    const results = leads.length > 0
      ? await crmDb.batchCreateLeads(parsed.listId, leads)
      : { successCount: 0, newCount: 0, mergedCount: 0, errorCount: 0, errors: [] as string[] };

    let updatedLastSyncAt: string | null = parsed.lastSyncAt || null;
    if (results.errorCount === 0) {
      updatedLastSyncAt = syncStartedAt;
      const nextSetting: CrmSyncSetting = {
        listId: parsed.listId,
        lastSyncAt: updatedLastSyncAt,
        autoSync: parsed.autoSync, // preserve autoSync flag across syncs
      };
      await settingsService.setSetting(
        settingName,
        JSON.stringify(nextSetting),
        `Admin CRM sync setting for ${source}`,
        req.user?.email || "admin"
      );
    }

    return res.json({
      success: true,
      source,
      listId: parsed.listId,
      forceFullSync,
      previousLastSyncAt: previousLastSyncAt || null,
      lastSyncAt: updatedLastSyncAt,
      attemptedCount: leads.length,
      successCount: results.successCount,
      newCount: results.newCount,
      mergedCount: results.mergedCount,
      errorCount: results.errorCount,
      errors: results.errors,
      message:
        results.errorCount === 0
          ? `Synced ${results.successCount} record(s) from ${source}.`
          : `Sync completed with ${results.errorCount} error(s). Last sync time was not updated.`,
    });
  } catch (error: any) {
    console.error("Error running CRM sync:", error);
    return res.status(500).json({ message: error.message || "Error running CRM sync" });
  }
});

// Get all users
router.get("/users", async (req, res) => {
  try {
    const hideBotLike = req.query.hideBotLike !== "false";
    const users = await userDb.getAllUsers(hideBotLike);
    // Transform: replace encrypted secrets map with just key names for the frontend
    const sanitized = users.map((user: any) => {
      const { secrets, ...rest } = user;
      return {
        ...rest,
        secretNames: secrets ? Object.keys(secrets) : [],
      };
    });

    // Batch-fetch org names for users who belong to an org
    const orgIds = [...new Set(sanitized.filter((u: any) => u.orgId).map((u: any) => u.orgId as string))];
    const orgMap: Record<string, string> = {};
    await Promise.all(
      orgIds.map(async (orgId) => {
        const org = await orgDb.getOrgById(orgId).catch(() => null);
        if (org) orgMap[orgId] = org.name;
      })
    );
    for (const user of sanitized) {
      if (user.orgId && orgMap[user.orgId]) {
        user.orgName = orgMap[user.orgId];
      }
    }

    // Batch-fetch Clarity replay session URLs for all users
    const replayResults = await Promise.all(
      sanitized.map((user: any) =>
        settingsService.getSetting(`replay_sessions_${user.userId}`).catch(() => null)
      )
    );
    for (let i = 0; i < sanitized.length; i++) {
      const setting = replayResults[i];
      if (setting?.settingValue) {
        try {
          const parsed = JSON.parse(setting.settingValue);
          sanitized[i].replayUrl = parsed.replayUrl;
        } catch {
          // skip malformed setting
        }
      }
    }

    res.json(sanitized);
  } catch (error) {
    console.error("Error getting users:", error);
    res.status(500).json({ message: "Error fetching users" });
  }
});

/**
 * GET /admin/onboarding/users
 *
 * Admin onboarding inspector — surfaces per-user onboarding state in a
 * compact list. Filters to users who actually started onboarding (have
 * a `goal` field set) and projects only the onboarding-relevant fields
 * so the payload stays small even with hundreds of users.
 *
 * For each user we return identity, per-step status + timing,
 * artifact counts, the unified-gallery sessionId, and the last 10
 * onboarding events. The FE renders a table; click a row to expand
 * the events log + delegate-as-user link.
 */
router.get("/onboarding/users", async (_req, res) => {
  try {
    const users = await userDb.getAllUsers(true);

    const onboardingUsers = users
      .filter((u: any) => typeof u.goal === "string" && u.goal.trim().length > 0)
      .map((u: any) => {
        const stages: Record<string, any> = {};
        for (const step of [
          "brandBuild",
          "icp",
          "competitor",
          "creativeDir",
          "adImage",
          "adCopy",
        ]) {
          stages[step] = {
            status: u[`${step}Status`] ?? null,
            startedAt: u[`${step}StartedAt`] ?? null,
            completedAt: u[`${step}CompletedAt`] ?? null,
            durationMs: u[`${step}DurationMs`] ?? null,
            error: u[`${step}Error`] ?? null,
          };
        }

        const counts = {
          icps: Array.isArray(u.icpResult) ? u.icpResult.length : 0,
          competitors: Array.isArray(u.competitorResult?.competitors)
            ? u.competitorResult.competitors.length
            : 0,
          adImages: Array.isArray(u.adImageResult?.variants)
            ? u.adImageResult.variants.length
            : 0,
          adCopies: Array.isArray(u.adCopyResult?.variants)
            ? u.adCopyResult.variants.length
            : 0,
        };

        const events = Array.isArray(u.onboardingEvents)
          ? u.onboardingEvents.slice(-10).map((e: any) => ({
              ts: e?.ts ?? null,
              event: e?.event ?? "(unknown)",
              data: e?.data ?? null,
            }))
          : [];

        const firstTouch = u.firstTouch || {};
        const utm = firstTouch.utm || {};

        return {
          userId: u.userId,
          email: u.email,
          createdAt: u.createdAt,
          companyName: u.companyName ?? null,
          companyUrl: u.productDomain ?? null,
          goal: u.goal,
          onboardingStage: u.onboardingStage ?? null,
          stages,
          counts,
          adImageChatSessionId: u.adImageChatSessionId ?? null,
          attribution: {
            utmSource: utm.source ?? null,
            utmMedium: utm.medium ?? null,
            utmCampaign: utm.campaign ?? null,
            referrer: firstTouch.referrer ?? null,
            landingUrl: firstTouch.landingUrl ?? null,
          },
          events,
          lastEventAt:
            events.length > 0 ? events[events.length - 1].ts : u.createdAt,
        };
      })
      .sort((a: any, b: any) => {
        const ta = a.lastEventAt ? new Date(a.lastEventAt).getTime() : 0;
        const tb = b.lastEventAt ? new Date(b.lastEventAt).getTime() : 0;
        return tb - ta;
      });

    res.json({ users: onboardingUsers });
  } catch (error) {
    console.error("Error fetching onboarding users:", error);
    res.status(500).json({ message: "Error fetching onboarding users" });
  }
});

// Lookup user ID by email (used by Emma tools) — must be before /:userId to avoid param collision
router.get("/users/lookup", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email || typeof email !== "string") {
      return res.status(400).json({ message: "email query parameter is required" });
    }
    const user = await userDb.getUserByEmail(email.toLowerCase().trim());
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ userId: user.userId, email: user.email });
  } catch (error) {
    console.error("Error looking up user by email:", error);
    res.status(500).json({ message: "Error looking up user" });
  }
});

// Get a single user by ID
router.get("/users/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await userDb.getUserById(userId);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Strip encrypted secret values, expose only key names
    const { secrets, ...rest } = user as any;
    res.json({
      ...rest,
      secretNames: secrets ? Object.keys(secrets) : [],
    });
  } catch (error) {
    console.error("Error getting user:", error);
    res.status(500).json({ message: "Error fetching user" });
  }
});

// Deactivate user
router.post("/users/:userId/deactivate", async (req, res) => {
  try {
    const { userId } = req.params;

    // Check if user exists and is not already deactivated
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.isAdmin) {
      return res.status(403).json({ message: "Cannot deactivate admin users" });
    }

    if (user.isActive === false) {
      return res.status(400).json({ message: "User is already deactivated" });
    }

    const updatedUser = await userDb.deactivateUser(userId);
    syncUserUpdateToLeadList(user.email, { isActive: false });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error deactivating user:", error);
    res.status(500).json({ message: "Error deactivating user" });
  }
});

// Reactivate user
router.post("/users/:userId/reactivate", async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.isActive !== false) {
      return res.status(400).json({ message: "User is already active" });
    }

    const updatedUser = await userDb.reactivateUser(userId);
    syncUserUpdateToLeadList(user.email, { isActive: true });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error reactivating user:", error);
    res.status(500).json({ message: "Error reactivating user" });
  }
});

// Update user support note
router.put("/users/:userId/support-note", async (req, res) => {
  try {
    const { userId } = req.params;
    const { supportNote } = req.body;

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update the user's support note
    const updatedUser = await userDb.updateUser(userId, { supportNote });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user support note:", error);
    res.status(500).json({ message: "Error updating support note" });
  }
});

// Update user display name
router.put("/users/:userId/name", async (req, res) => {
  try {
    const { userId } = req.params;
    const { displayName } = req.body;

    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const updatedUser = await userDb.updateUser(userId, {
      displayName: displayName || null,
    });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user display name:", error);
    res.status(500).json({ message: "Error updating user display name" });
  }
});

// --- User Notes (stored in AW-Settings as usernote_<userId>) ---
const USER_NOTES_MAX = 50;

export interface UserNote {
  id: string;
  content: string;
  timestamp: string;
  authorEmail: string;
}

// GET /api/admin/users/:userId/notes — list all notes, newest first
router.get("/users/:userId/notes", async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const setting = await settingsService.getSetting(`usernote_${userId}`);
    const notes: UserNote[] = setting ? JSON.parse(setting.settingValue) : [];
    // Return newest first
    notes.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    res.json({ notes });
  } catch (error) {
    console.error("Error getting user notes:", error);
    res.status(500).json({ message: "Error getting user notes" });
  }
});

// POST /api/admin/users/:userId/notes — add a note
router.post("/users/:userId/notes", async (req, res) => {
  try {
    const { userId } = req.params;
    const { content } = req.body;
    if (!content || typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ message: "content is required" });
    }

    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const setting = await settingsService.getSetting(`usernote_${userId}`);
    let notes: UserNote[] = setting ? JSON.parse(setting.settingValue) : [];

    const newNote: UserNote = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      content: content.trim(),
      timestamp: new Date().toISOString(),
      authorEmail: (req as any).user?.email || "admin",
    };

    notes.push(newNote);

    // Cap at 50; drop the oldest if over
    if (notes.length > USER_NOTES_MAX) {
      notes.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const dropped = notes.length - USER_NOTES_MAX;
      notes = notes.slice(dropped);
    }

    await settingsService.setSetting(
      `usernote_${userId}`,
      JSON.stringify(notes),
      `User notes for ${user.email}`,
      (req as any).user?.email || "admin"
    );

    // Return newest first
    notes.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    res.json({ notes, warning: notes.length === USER_NOTES_MAX ? `Limit of ${USER_NOTES_MAX} notes reached. Oldest note was removed.` : undefined });
  } catch (error) {
    console.error("Error adding user note:", error);
    res.status(500).json({ message: "Error adding user note" });
  }
});

// DELETE /api/admin/users/:userId/notes/:noteId — delete a specific note
router.delete("/users/:userId/notes/:noteId", async (req, res) => {
  try {
    const { userId, noteId } = req.params;
    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const setting = await settingsService.getSetting(`usernote_${userId}`);
    let notes: UserNote[] = setting ? JSON.parse(setting.settingValue) : [];

    const before = notes.length;
    notes = notes.filter((n) => n.id !== noteId);
    if (notes.length === before) {
      return res.status(404).json({ message: "Note not found" });
    }

    await settingsService.setSetting(
      `usernote_${userId}`,
      JSON.stringify(notes),
      `User notes for ${user.email}`,
      (req as any).user?.email || "admin"
    );

    notes.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    res.json({ notes });
  } catch (error) {
    console.error("Error deleting user note:", error);
    res.status(500).json({ message: "Error deleting user note" });
  }
});

// Update user Stripe Customer ID
router.put("/users/:userId/stripe-customer-id", async (req, res) => {
  try {
    const { userId } = req.params;
    const { stripeCustomerId } = req.body;

    if (stripeCustomerId === undefined || stripeCustomerId === null) {
      return res.status(400).json({ message: "stripeCustomerId is required" });
    }

    // Allow empty string to clear, but validate format if non-empty
    if (stripeCustomerId !== "" && !stripeCustomerId.startsWith("cus_")) {
      return res.status(400).json({ message: 'Invalid Stripe Customer ID format. Must start with "cus_"' });
    }

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update the user's Stripe Customer ID
    const updatedUser = await userDb.updateUser(userId, { stripe_customer_id: stripeCustomerId });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating Stripe Customer ID:", error);
    res.status(500).json({ message: "Error updating Stripe Customer ID" });
  }
});

// Update user ad account
router.put("/users/:userId/ad-account", async (req, res) => {
  try {
    const { userId } = req.params;
    const { adAccount } = req.body;

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update the user's ad account
    const updatedUser = await userDb.updateUser(userId, { adAccount });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user ad account:", error);
    res.status(500).json({ message: "Error updating ad account" });
  }
});

// Update user email sender configuration
router.put("/users/:userId/email-sender", async (req, res) => {
  try {
    const { userId } = req.params;
    const { emailDomain, defaultSenderUsername, fromName } = req.body;

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update the user's email sender configuration
    const updatedUser = await userDb.updateUser(userId, {
      emailDomain,
      defaultSenderUsername,
      fromName
    });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user email sender:", error);
    res.status(500).json({ message: "Error updating email sender" });
  }
});

// Get Slack channel info by ID (for admin double-check)
router.get("/slack/channel-info", async (req, res) => {
  try {
    const { channelId } = req.query;
    if (!channelId || typeof channelId !== "string") {
      return res.status(400).json({ message: "channelId query param required" });
    }
    const { getSlackChannelInfo } = await import("../services/slackService");
    const info = await getSlackChannelInfo(channelId.trim());
    if (!info) {
      return res.status(404).json({ message: "Channel not found or bot not a member" });
    }
    res.json(info);
  } catch (error: any) {
    console.error("Error fetching Slack channel info:", error);
    res.status(500).json({ message: "Error fetching channel info", details: error.message });
  }
});

// Update user slack channels (accepts an array)
router.put("/users/:userId/slack-channel", async (req, res) => {
  try {
    const { userId } = req.params;
    const { slackChannels } = req.body;

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Validate: must be an array of non-empty strings (or null/empty to clear)
    const channels: string[] = Array.isArray(slackChannels)
      ? slackChannels.map((c: any) => String(c).trim()).filter(Boolean)
      : [];

    const { settingsService } = await import('../services/settingsService');
    // Invalidate by userId (old assignments) AND by channel ID (channels that may be cached under a different user)
    const oldChannels: string[] = (user.slackChannels ?? []).concat(user.slackChannel ? [user.slackChannel] : []);
    await settingsService.invalidateSlackChannelMappings(userId, [...new Set([...oldChannels, ...channels])]);

    const updatedUser = await userDb.updateUser(userId, {
      slackChannels: channels.length > 0 ? channels : (null as any),
    });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user slack channels:", error);
    res.status(500).json({ message: "Error updating slack channels" });
  }
});

// Get user secret names (keys only, not values)
router.get("/users/:userId/secrets", async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ secretNames: Object.keys(user.secrets || {}) });
  } catch (error) {
    console.error("Error getting user secrets:", error);
    res.status(500).json({ message: "Error getting user secrets" });
  }
});

// Update user secrets (encrypt values at rest)
router.put("/users/:userId/secrets", async (req, res) => {
  try {
    const { userId } = req.params;
    const { secrets } = req.body;

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Validate secrets is an object
    if (secrets && typeof secrets !== "object") {
      return res.status(400).json({ message: "secrets must be an object" });
    }

    // Validate key names (alphanumeric + underscores only)
    const keyRegex = /^[a-zA-Z0-9_]+$/;
    for (const key of Object.keys(secrets || {})) {
      if (!keyRegex.test(key)) {
        return res.status(400).json({
          message: `Invalid secret name: "${key}". Only alphanumeric characters and underscores are allowed.`
        });
      }
    }

    // Build encrypted secrets map
    // If value is empty string, keep the existing encrypted value
    const existingSecrets = user.secrets || {};
    const encryptedSecrets: Record<string, string> = {};

    for (const [key, value] of Object.entries(secrets || {})) {
      if (typeof value === "string" && value.length > 0) {
        // New value provided — encrypt it
        encryptedSecrets[key] = encryptPassword(value, userId);
      } else if (key in existingSecrets) {
        // Empty value for existing key — keep existing encrypted value
        encryptedSecrets[key] = existingSecrets[key];
      }
      // If value is empty and key doesn't exist, skip (effectively removes it)
    }

    const updatedUser = await userDb.updateUser(userId, { secrets: encryptedSecrets });
    res.json({ secretNames: Object.keys(updatedUser.secrets || {}) });
  } catch (error) {
    console.error("Error updating user secrets:", error);
    res.status(500).json({ message: "Error updating user secrets" });
  }
});

// Update user SEO domains (kept for backward compatibility)
router.put("/users/:userId/seo-domains", async (req, res) => {
  try {
    const { userId } = req.params;
    const { seoDomains } = req.body;

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Validate seoDomains is an array
    if (seoDomains && !Array.isArray(seoDomains)) {
      return res.status(400).json({ message: "seoDomains must be an array" });
    }

    // Validate each domain format
    if (seoDomains) {
      const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}$/;
      for (const domain of seoDomains) {
        if (typeof domain !== 'string' || !domainRegex.test(domain.trim())) {
          return res.status(400).json({
            message: `Invalid domain format: ${domain}. Please use format like example.com`
          });
        }
      }
    }

    // Update the user's SEO domains
    const updatedUser = await userDb.updateUser(userId, {
      seoDomains: seoDomains || []
    });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user SEO domains:", error);
    res.status(500).json({ message: "Error updating SEO domains" });
  }
});

// Update user SEO/AEO configuration (SEO domains, Google Analytics, and Clarity)
router.put("/users/:userId/seo-aeo", async (req, res) => {
  try {
    const { userId } = req.params;
    const {
      seoDomains,
      googleAnalyticsPropertyId,  // Legacy single value (kept for backward compatibility)
      googleAnalyticsProperties,  // New array format
      gaFilteredDomains,
      clarityProjectId,  // Legacy single value (kept for backward compatibility)
      clarityProjects,  // New array format
      productDomain
    } = req.body;

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Validate seoDomains is an array if provided
    if (seoDomains !== undefined) {
      if (!Array.isArray(seoDomains)) {
        return res.status(400).json({ message: "seoDomains must be an array" });
      }

      // Validate each domain format (allow both domain and URL-prefix formats)
      // Domain property: example.com
      // URL-prefix property: https://example.com or https://example.com/
      const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}$/;
      const urlPrefixRegex = /^https?:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}\/?$/;

      for (const domain of seoDomains) {
        const trimmedDomain = domain.trim();
        if (typeof domain !== 'string' || (!domainRegex.test(trimmedDomain) && !urlPrefixRegex.test(trimmedDomain))) {
          return res.status(400).json({
            message: `Invalid domain format: ${domain}. Use 'example.com' for domain properties or 'https://example.com' or 'https://example.com/' for URL-prefix properties`
          });
        }
      }
    }

    // Validate gaFilteredDomains is an array if provided
    if (gaFilteredDomains !== undefined) {
      if (!Array.isArray(gaFilteredDomains)) {
        return res.status(400).json({ message: "gaFilteredDomains must be an array" });
      }

      // Validate each domain format (allow localhost and standard domains)
      const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}$/;
      for (const domain of gaFilteredDomains) {
        if (typeof domain !== 'string') {
          return res.status(400).json({
            message: `Invalid filtered domain format: ${domain}. Must be a string`
          });
        }

        const trimmedDomain = domain.trim();

        // Allow localhost and IP addresses (common for filtering local/dev traffic)
        const isLocalhost = trimmedDomain === 'localhost' || trimmedDomain.startsWith('localhost:');
        const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(trimmedDomain);

        if (!isLocalhost && !isIpAddress && !domainRegex.test(trimmedDomain)) {
          return res.status(400).json({
            message: `Invalid filtered domain format: ${domain}. Please use format like app.example.com, localhost, or an IP address`
          });
        }
      }
    }

    // Validate Google Analytics Property ID format if provided (legacy single value)
    // Note: The API uses Property ID (numeric), not Measurement ID (G-XXXXXXXXXX)
    if (googleAnalyticsPropertyId !== undefined && googleAnalyticsPropertyId !== null && googleAnalyticsPropertyId !== "") {
      // GA4 Property ID is numeric (e.g., 123456789)
      const gaIdRegex = /^\d+$/;
      const trimmedId = googleAnalyticsPropertyId.trim();
      if (typeof googleAnalyticsPropertyId !== 'string' || !gaIdRegex.test(trimmedId)) {
        return res.status(400).json({
          message: `Invalid Google Analytics Property ID format: ${googleAnalyticsPropertyId}. Please enter the numeric Property ID (e.g., 123456789). You can find this in GA4 Admin > Property Settings.`
        });
      }
    }

    // Validate Google Analytics Properties array (new format)
    if (googleAnalyticsProperties !== undefined) {
      if (!Array.isArray(googleAnalyticsProperties)) {
        return res.status(400).json({ message: "googleAnalyticsProperties must be an array" });
      }

      const gaIdRegex = /^\d+$/;
      const seenPropertyIds = new Set<string>();

      for (const property of googleAnalyticsProperties) {
        // Validate structure
        if (!property || typeof property !== 'object' || !property.propertyId || !property.label) {
          return res.status(400).json({
            message: "Each GA4 property must have 'propertyId' and 'label' fields"
          });
        }

        // Validate property ID format
        const trimmedId = property.propertyId.trim();
        if (typeof property.propertyId !== 'string' || !gaIdRegex.test(trimmedId)) {
          return res.status(400).json({
            message: `Invalid Google Analytics Property ID format: ${property.propertyId}. Please enter the numeric Property ID (e.g., 123456789).`
          });
        }

        // Validate label
        if (typeof property.label !== 'string' || property.label.trim().length === 0) {
          return res.status(400).json({
            message: "Each GA4 property must have a non-empty label"
          });
        }

        if (property.label.trim().length > 100) {
          return res.status(400).json({
            message: `GA4 property label too long: ${property.label}. Maximum 100 characters.`
          });
        }

        // Check for duplicate property IDs
        if (seenPropertyIds.has(trimmedId)) {
          return res.status(400).json({
            message: `Duplicate Google Analytics Property ID: ${trimmedId}`
          });
        }
        seenPropertyIds.add(trimmedId);
      }
    }

    if (clarityProjectId !== undefined && clarityProjectId !== null && clarityProjectId !== "") {
      const clarityIdRegex = /^[a-zA-Z0-9_-]{6,32}$/;
      const trimmedId = clarityProjectId.trim();
      if (typeof clarityProjectId !== 'string' || !clarityIdRegex.test(trimmedId)) {
        return res.status(400).json({
          message: `Invalid Microsoft Clarity Project ID format: ${clarityProjectId}. Please enter the project ID (e.g., ul13e4f7fe). You can find this in Clarity project settings.`
        });
      }
    }

    // Validate Clarity Projects array (new format)
    if (clarityProjects !== undefined) {
      if (!Array.isArray(clarityProjects)) {
        return res.status(400).json({ message: "clarityProjects must be an array" });
      }

      const clarityIdRegex = /^[a-zA-Z0-9_-]{6,32}$/;
      const seenProjectIds = new Set<string>();

      for (const project of clarityProjects) {
        // Validate structure
        if (!project || typeof project !== 'object' || !project.projectId || !project.label) {
          return res.status(400).json({
            message: "Each Clarity project must have 'projectId' and 'label' fields"
          });
        }

        // Validate project ID format
        const trimmedId = project.projectId.trim();
        if (typeof project.projectId !== 'string' || !clarityIdRegex.test(trimmedId)) {
          return res.status(400).json({
            message: `Invalid Microsoft Clarity Project ID format: ${project.projectId}. Please enter the project ID (e.g., ul13e4f7fe).`
          });
        }

        // Validate label
        if (typeof project.label !== 'string' || project.label.trim().length === 0) {
          return res.status(400).json({
            message: "Each Clarity project must have a non-empty label"
          });
        }

        if (project.label.trim().length > 100) {
          return res.status(400).json({
            message: `Clarity project label too long: ${project.label}. Maximum 100 characters.`
          });
        }

        // Check for duplicate project IDs
        if (seenProjectIds.has(trimmedId)) {
          return res.status(400).json({
            message: `Duplicate Microsoft Clarity Project ID: ${trimmedId}`
          });
        }
        seenProjectIds.add(trimmedId);
      }
    }

    // Validate productDomain format if provided
    if (productDomain !== undefined && productDomain !== null && productDomain !== "") {
      const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}$/;
      const trimmedDomain = productDomain.trim();
      if (typeof productDomain !== 'string' || !domainRegex.test(trimmedDomain)) {
        return res.status(400).json({
          message: `Invalid product domain format: ${productDomain}. Please use format like app.example.com`
        });
      }
    }

    // Build update object with only provided fields
    const updateData: any = {};
    if (seoDomains !== undefined) {
      console.log('[SEO/AEO Update] Saving seoDomains:', JSON.stringify(seoDomains));
      updateData.seoDomains = seoDomains;
    }
    if (googleAnalyticsPropertyId !== undefined) {
      updateData.googleAnalyticsPropertyId = googleAnalyticsPropertyId?.trim() || null;
    }
    if (googleAnalyticsProperties !== undefined) {
      updateData.googleAnalyticsProperties = googleAnalyticsProperties.map((p: any) => ({
        propertyId: p.propertyId.trim(),
        label: p.label.trim()
      }));
    }
    if (gaFilteredDomains !== undefined) {
      updateData.gaFilteredDomains = gaFilteredDomains;
    }
    if (clarityProjectId !== undefined) {
      updateData.clarityProjectId = clarityProjectId?.trim() || null;
    }
    if (clarityProjects !== undefined) {
      updateData.clarityProjects = clarityProjects.map((p: any) => ({
        projectId: p.projectId.trim(),
        label: p.label.trim()
      }));
    }
    if (productDomain !== undefined) {
      updateData.productDomain = productDomain?.trim() || null;
    }

    // Update the user's SEO/AEO configuration
    const updatedUser = await userDb.updateUser(userId, updateData);
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user SEO/AEO configuration:", error);
    res.status(500).json({ message: "Error updating SEO/AEO configuration" });
  }
});

// List all folders accessible to the Google Drive service account
router.get("/google-drive-folders", async (req, res) => {
  try {
    const { getSecret } = await import("../utils/secretsManager");
    const { google } = await import("googleapis");

    const environment = process.env.NODE_ENV || "development";
    const secretName = environment === "production"
      ? "prod/AgentWeb/Google/Share"
      : "dev/AgentWeb/Google/Share";

    const secretString = await getSecret(secretName);
    const credentials = JSON.parse(secretString);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });

    const drive = google.drive({ version: "v3", auth });

    // List all folders shared with the service account
    const response = await drive.files.list({
      q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: "files(id, name)",
      orderBy: "name",
      pageSize: 100,
    });

    const folders = (response.data.files || []).map((f) => ({
      folderId: f.id,
      name: f.name,
    }));

    res.json({ folders });
  } catch (error) {
    console.error("Error listing Google Drive folders:", error);
    res.status(500).json({ message: "Failed to list Google Drive folders" });
  }
});

// Update user Google Drive shared folders
router.put("/users/:userId/google-drive-folders", async (req, res) => {
  try {
    const { userId } = req.params;
    const { googleDriveFolders } = req.body;

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Validate googleDriveFolders is an array
    if (!Array.isArray(googleDriveFolders)) {
      return res.status(400).json({ message: "googleDriveFolders must be an array" });
    }

    // Validate each entry has folderId and name
    for (const folder of googleDriveFolders) {
      if (!folder.folderId || typeof folder.folderId !== 'string' || !folder.folderId.trim()) {
        return res.status(400).json({ message: "Each folder must have a non-empty folderId string" });
      }
      if (!folder.name || typeof folder.name !== 'string' || !folder.name.trim()) {
        return res.status(400).json({ message: "Each folder must have a non-empty name string" });
      }
    }

    // Sanitize entries
    const sanitizedFolders = googleDriveFolders.map((f: { folderId: string; name: string }) => ({
      folderId: f.folderId.trim(),
      name: f.name.trim(),
    }));

    const updatedUser = await userDb.updateUser(userId, { googleDriveFolders: sanitizedFolders });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user Google Drive folders:", error);
    res.status(500).json({ message: "Error updating Google Drive folders" });
  }
});

// Update user CMS Type
router.put("/users/:userId/cms-type", async (req, res) => {
  try {
    const { userId } = req.params;
    const { cmsType } = req.body;

    // Validate cmsType
    if (cmsType && cmsType !== "Basehub" && cmsType !== "Webflow" && cmsType !== "WordPress") {
      return res.status(400).json({ message: "cmsType must be 'Basehub', 'Webflow', or 'WordPress'" });
    }

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update the user's CMS Type
    // Preserve null to allow clearing the field, convert empty string to null, otherwise use the value or undefined
    const cmsTypeValue = cmsType === null || cmsType === "" ? null : (cmsType || undefined);
    const updatedUser = await userDb.updateUser(userId, {
      cmsType: cmsTypeValue
    });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user CMS Type:", error);
    res.status(500).json({ message: "Error updating CMS Type" });
  }
});

// Update user primary email (delete-and-recreate — old record tombstoned with deleted_ prefix)
router.put("/users/:userId/email", async (req, res) => {
  try {
    const { userId } = req.params;
    const { newEmail } = req.body;

    if (!newEmail || typeof newEmail !== "string") {
      return res.status(400).json({ message: "newEmail is required" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail.trim())) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    const result = await userDb.updateUserEmail(userId, newEmail.trim());
    if (!result.success) {
      return res.status(400).json({ message: result.message });
    }

    res.json(result.user);
  } catch (error) {
    console.error("Error updating user email:", error);
    res.status(500).json({ message: "Error updating user email" });
  }
});

// Update user password
router.put("/users/:userId/password", async (req, res) => {
  try {
    const { userId } = req.params;
    const { password } = req.body;

    // Validate password
    if (!password || password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters long" });
    }

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Hash the new password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Update the user's password
    const updatedUser = await userDb.updateUser(userId, { password: hashedPassword });
    res.json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Error updating user password:", error);
    res.status(500).json({ message: "Error updating password" });
  }
});

// Create user from waitlist entry
router.post("/waitlist/:email/create-user", async (req, res) => {
  try {
    const { email } = req.params;
    const { roles = ["customer"] } = req.body;

    // Check if user already exists
    const existingUser = await userDb.getUserByEmail(email);
    if (existingUser) {
      // Allow free users to be created (upgraded to customer)
      if (existingUser.roles && existingUser.roles.some((role: string) => role !== 'free')) {
        return res.status(400).json({ message: "User already exists" });
      }
    }

    // Get waitlist entry
    const waitlistEntry = await waitlistDb.getByEmail(email);
    if (!waitlistEntry) {
      return res.status(404).json({ message: "Waitlist entry not found" });
    }

    let resultUser;
    let temporaryPassword;

    if (existingUser) {
      // Update existing free user with new roles and copy stripe_customer_id if missing
      const updatedRoles = [...(existingUser.roles || []), ...roles];
      const updatePayload: any = { roles: updatedRoles };
      if (waitlistEntry.stripe_customer_id && !existingUser.stripe_customer_id) {
        updatePayload.stripe_customer_id = waitlistEntry.stripe_customer_id;
      }
      await userDb.updateUser(existingUser.userId, updatePayload);
      resultUser = {
        userId: existingUser.userId,
        email: existingUser.email,
        displayName: existingUser.displayName,
        roles: updatedRoles
      };

      // Send welcome email without password for existing user upgrade
      await emailService.sendWelcomeEmail(email);
    } else {
      // Create new user with waitlist data
      const generateRandomPassword = (length: number = 12) => {
        const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
        let password = '';
        for (let i = 0; i < length; i++) {
          password += charset.charAt(Math.floor(Math.random() * charset.length));
        }
        return password;
      };

      temporaryPassword = generateRandomPassword(16);
      const hashedPassword = await bcrypt.hash(temporaryPassword, 10);

      const userId = require('uuid').v4();
      const newUser = await userDb.createUser(
        email,
        userId,
        hashedPassword,
        false, // isOAuthUser
        false, // isAdmin
        roles,
        waitlistEntry.fullName || email.split("@")[0], // displayName
        undefined, // googleId
        waitlistEntry.stripe_customer_id, // from waitlist
        waitlistEntry.companyName, // from waitlist
        waitlistEntry.useCaseCategories // from waitlist
      );

      if (!newUser) {
        return res.status(500).json({ message: "Failed to create user" });
      }

      resultUser = newUser;

      // Auto-sync new user to CRM lead list (fire-and-forget)
      syncNewUserToLeadList({
        userId,
        email,
        fullName: waitlistEntry.fullName,
        roles,
        isAdmin: false,
        createdAt: new Date().toISOString(),
        stripe_customer_id: waitlistEntry.stripe_customer_id,
        subscriptionType: "Free",
      }).catch(() => { });


      // Send welcome email with temporary password for new user
      await emailService.sendWelcomeEmail(email, temporaryPassword);
    }

    // Update waitlist status to completed
    await waitlistDb.updateStatus(email, 'completed');

    res.json({
      message: "User created successfully",
      user: {
        userId: resultUser.userId,
        email: resultUser.email,
        displayName: resultUser.displayName,
        roles: resultUser.roles
      },
      ...(temporaryPassword && { temporaryPassword })
    });
  } catch (error) {
    console.error("Error creating user from waitlist:", error);
    res.status(500).json({ message: "Error creating user" });
  }
});

// Create delegate access token for customer portal
router.post("/users/:userId/delegate-access", async (req, res) => {
  try {
    const { userId } = req.params;
    const adminReq = req as any; // Should have admin user from middleware

    // Check if user exists
    const targetUser = await userDb.getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    // Ensure target user has customer role
    if (!targetUser.roles || !targetUser.roles.includes("customer")) {
      return res.status(400).json({
        message: "User does not have customer portal access"
      });
    }

    // Create delegation token
    const delegatePayload = {
      userId: targetUser.userId, // This will be the active user in the token
      email: targetUser.email,
      roles: targetUser.roles,
      isAdmin: false, // Target user permissions
      delegateAccess: {
        adminUserId: adminReq.user.userId,
        adminEmail: adminReq.user.email,
        targetUserId: targetUser.userId,
        targetEmail: targetUser.email
      }
    };

    const delegateToken = jwt.sign(
      delegatePayload,
      process.env.JWT_SECRET || "your-secret-key",
      { expiresIn: "90d" } // Delegate tokens expire in 90 days for security
    );

    // Return the delegate token and customer portal URL
    const customerPortalUrl = process.env.CUSTOMER_FRONTEND_URL || "http://localhost:5174";

    res.json({
      delegateToken,
      customerPortalUrl: `${customerPortalUrl}/oauth-callback?token=${delegateToken}`,
      expiresIn: "90d"
    });
  } catch (error) {
    console.error("Error creating delegate access:", error);
    res.status(500).json({ message: "Error creating delegate access" });
  }
});

// Get waitlist entries
router.get("/waitlist", async (req, res) => {
  try {
    const { lastEvaluatedKey } = req.query;
    const result = await waitlistDb.list(lastEvaluatedKey as any);
    res.json(result);
  } catch (error) {
    console.error("Error getting waitlist:", error);
    res.status(500).json({ message: "Error fetching waitlist" });
  }
});

// Update waitlist entry status
router.put("/waitlist/:email/status", async (req, res) => {
  try {
    const { email } = req.params;
    const { status } = req.body;

    if (!email || !status) {
      return res.status(400).json({ message: "Email and status are required" });
    }

    // Check if user already exists
    const existingUser = await userDb.getUserByEmail(email);
    if (existingUser) {
      // Allow free users to be updated
      if (existingUser.roles && existingUser.roles.some((role: string) => role !== 'free')) {
        return res.status(400).json({ message: "User already exists" });
      }
    }

    // Update invitedAt timestamp for invited users
    let invitedAt;
    if (status === "invited") {
      invitedAt = new Date().toISOString();
    }

    const entry = await waitlistDb.updateStatus(email, status, invitedAt);

    // Send invitation email if status is 'invited'
    if (status === "invited") {
      try {
        // Check if user already exists to determine email type
        const existingUser = await userDb.getUserByEmail(email);
        if (existingUser) {
          // Add customer role to existing free users so they can access customer portal
          if (existingUser.roles && existingUser.roles.includes('free') && !existingUser.roles.includes('customer')) {
            const updatedRoles = [...existingUser.roles, 'customer'];
            await userDb.updateUser(existingUser.userId, { roles: updatedRoles });
            syncUserUpdateToLeadList(existingUser.email, { roles: updatedRoles });
          }
          await emailService.sendWelcomeEmail(email); // No password = upgrade email
        } else {
          await emailService.sendInvitation(email);
        }
      } catch (emailError) {
        console.error("Error sending invitation email:", emailError);
        // Revert the status update
        await waitlistDb.updateStatus(email, "pending");
        return res
          .status(500)
          .json({ message: "Failed to send invitation email" });
      }
    }

    res.json(entry);
  } catch (error) {
    console.error("Error updating waitlist status:", error);
    res.status(500).json({ message: "Error updating waitlist status" });
  }
});

// Update waitlist entry - general endpoint for updating any waitlist fields
router.put("/waitlist/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const updates = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // Check if waitlist entry exists
    const entry = await waitlistDb.getByEmail(email);
    if (!entry) {
      return res.status(404).json({ message: "Waitlist entry not found" });
    }

    // Use the updateDetails method which handles partial updates
    const updatedEntry = await waitlistDb.updateDetails(email, updates);
    res.json(updatedEntry);
  } catch (error) {
    console.error("Error updating waitlist entry:", error);
    res.status(500).json({ message: "Error updating waitlist entry" });
  }
});

// Update waitlist entry support note
router.put("/waitlist/:email/support-note", async (req, res) => {
  try {
    const { email } = req.params;
    const { supportNote } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // supportNote can be an empty string, so we don't check for its existence specifically, just that the body field is present.
    if (typeof supportNote === "undefined") {
      return res
        .status(400)
        .json({ message: "supportNote field is required in the body" });
    }

    const entry = await waitlistDb.updateSupportNote(email, supportNote);
    if (!entry) {
      return res
        .status(404)
        .json({ message: "Waitlist entry not found or failed to update" });
    }

    res.json(entry);
  } catch (error) {
    console.error("Error updating waitlist support note:", error);
    res.status(500).json({ message: "Error updating support note" });
  }
});

// Delete waitlist entry
router.delete("/waitlist/:email", async (req, res) => {
  try {
    const { email } = req.params;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // Optional: Check if entry exists before attempting delete, though DynamoDB delete is idempotent
    const existingEntry = await waitlistDb.getByEmail(email);
    if (!existingEntry) {
      return res.status(404).json({ message: "Waitlist entry not found" });
    }

    const result = await waitlistDb.deleteByEmail(email);

    if (result.success) {
      res
        .status(200)
        .json({ message: `Waitlist entry for ${email} deleted successfully` });
    } else {
      // Use the message from deleteByEmail if available, otherwise a generic one
      res
        .status(500)
        .json({ message: result.message || "Failed to delete waitlist entry" });
    }
  } catch (error) {
    console.error("Error deleting waitlist entry:", error);
    // Check if error is an object and has a message property
    const errorMessage =
      typeof error === "object" && error !== null && "message" in error
        ? (error as { message: string }).message
        : "Internal server error";
    res
      .status(500)
      .json({ message: "Error deleting waitlist entry", error: errorMessage });
  }
});

// Resend invitation email
router.post("/waitlist/resend-invitation", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // Check if waitlist entry exists and has invited status
    const entry = await waitlistDb.getByEmail(email);

    if (!entry) {
      return res.status(404).json({ message: "Waitlist entry not found" });
    }

    if (entry.status !== "invited") {
      return res.status(400).json({ message: "User has not been invited yet" });
    }

    // Check if user already exists (allow free users to be resent invitations)
    const existingUser = await userDb.getUserByEmail(email);
    if (existingUser && !existingUser.roles.includes('free')) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Update the invitedAt timestamp
    const invitedAt = new Date().toISOString();
    await waitlistDb.updateStatus(email, "invited", invitedAt);

    // Send the invitation email
    try {
      // Check if user already exists to determine email type
      const existingUser = await userDb.getUserByEmail(email);
      if (existingUser) {
        // Add customer role to existing free users so they can access customer portal
        if (existingUser.roles && existingUser.roles.includes('free') && !existingUser.roles.includes('customer')) {
          const updatedRoles = [...existingUser.roles, 'customer'];
          await userDb.updateUser(existingUser.userId, { roles: updatedRoles });
        }
        await emailService.sendWelcomeEmail(email); // No password = upgrade email
      } else {
        await emailService.sendInvitation(email);
      }
    } catch (emailError) {
      console.error("Error sending invitation email:", emailError);
      return res
        .status(500)
        .json({ message: "Failed to send invitation email" });
    }

    res.json({ message: "Invitation email resent successfully" });
  } catch (error) {
    console.error("Error resending invitation email:", error);
    res.status(500).json({ message: "Error resending invitation email" });
  }
});

// Manually add someone to waitlist
router.post("/waitlist/invite", async (req, res) => {
  try {
    const {
      email,
      fullName,
      phoneNumber,
      companyName,
      useCaseCategories,
      useCaseDescription,
      requestReport,
      supportNote,
      monthlyMarketingSpend,
      businessArea,
      stripe_customer_id,
      sendInvitation = true,
      marketingChannels,
    } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // Check if email already exists in waitlist
    const existingEntry = await waitlistDb.getByEmail(email);
    if (existingEntry) {
      return res
        .status(409)
        .json({ message: "Email already exists in waitlist" });
    }

    // Check if user already exists
    const existingUser = await userDb.getUserByEmail(email);
    if (existingUser) {
      // Allow free users to be added to waitlist even if they already exist
      if (!existingUser.roles.includes('free')) {
        return res.status(409).json({ message: "User already exists" });
      }
    }

    // Create waitlist entry
    const now = new Date().toISOString();
    const waitlistData = {
      email: email.toLowerCase(),
      joinedAt: now,
      status: sendInvitation ? "invited" : "pending",
      invitedAt: sendInvitation ? now : undefined,
      fullName: fullName || "",
      phoneNumber: phoneNumber || "",
      companyName: companyName || "",
      useCaseCategories: useCaseCategories || [],
      useCaseDescription: useCaseDescription || "",
      requestReport: requestReport || false,
      supportNote: supportNote || "Manually added by admin",
      monthlyMarketingSpend: monthlyMarketingSpend || "",
      businessArea: businessArea || "",
      stripe_customer_id: stripe_customer_id || "",
      marketingChannels: marketingChannels || [],
    };

    const entry = await waitlistDb.add(waitlistData);

    // Send invitation email if requested
    if (sendInvitation) {
      try {
        // Use welcome email for existing users, invitation email for new users
        if (existingUser) {
          // Add customer role to existing free users so they can access customer portal
          if (existingUser.roles && existingUser.roles.includes('free') && !existingUser.roles.includes('customer')) {
            const updatedRoles = [...existingUser.roles, 'customer'];
            await userDb.updateUser(existingUser.userId, { roles: updatedRoles });
            syncUserUpdateToLeadList(existingUser.email, { roles: updatedRoles });
          }
          await emailService.sendWelcomeEmail(email); // No password = upgrade email
        } else {
          await emailService.sendInvitation(email);
        }
      } catch (emailError) {
        console.error("Error sending invitation email:", emailError);
        // Optionally delete the entry or update status back to pending
        await waitlistDb.updateStatus(email, "pending");
        return res.status(500).json({
          message: "Waitlist entry created but failed to send invitation email",
          entry,
        });
      }
    }

    res.status(201).json(entry);
  } catch (error) {
    console.error("Error manually adding to waitlist:", error);
    res.status(500).json({ message: "Failed to add to waitlist" });
  }
});

// Get all tasks
router.get("/tasks", async (req, res) => {
  try {
    const tasks = await taskDb.getAllTasks();

    // Get latest execution for each task
    const tasksWithLatestExecution = await Promise.all(
      (tasks || []).map(async (task) => {
        const executions = await taskDb.getTaskExecutions(task.taskId);
        const latestExecution =
          executions && executions.length > 0 ? executions[0] : null;

        // Count completed and total runs
        const totalRuns = executions ? executions.length : 0;
        const completedRuns = executions
          ? executions.filter((exec) => exec.status === "completed").length
          : 0;

        return {
          ...task,
          latestRunStatus: latestExecution ? latestExecution.status : "none",
          latestRunTime: latestExecution ? latestExecution.startTime : null,
          completedRuns,
          totalRuns,
        };
      })
    );

    res.json(tasksWithLatestExecution);
  } catch (error) {
    console.error("Error getting tasks:", error);
    res.status(500).json({ message: "Error fetching tasks" });
  }
});

// Get task analytics
router.get("/analytics/tasks", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const analytics = await taskDb.getTaskAnalytics(
      startDate as string,
      endDate as string
    );
    res.json(analytics);
  } catch (error) {
    console.error("Error getting task analytics:", error);
    res.status(500).json({ message: "Error fetching task analytics" });
  }
});

// Get user analytics
router.get("/analytics/users", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const analytics = await userDb.getUserAnalytics(
      startDate as string,
      endDate as string
    );
    res.json(analytics);
  } catch (error) {
    console.error("Error getting user analytics:", error);
    res.status(500).json({ message: "Error fetching user analytics" });
  }
});

// Get Agent Mode analytics
router.get("/analytics/agent-mode", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Get all sessions
    const allSessions = await chatbotDb.getAllSessions();

    // Filter for Agent Mode sessions only
    const agentSessions = allSessions.filter(
      (session) => session.portalType === "agent" && !session.archived
    );

    // Fetch lightweight message stats in parallel for all agent sessions
    const messageStatsPromise = Promise.all(
      agentSessions.map((session) =>
        chatbotDb.getMessageStats(session.sessionId).catch(() => null)
      )
    );

    // Parse date range
    const start = startDate ? new Date(startDate as string) : null;
    const end = endDate ? new Date(endDate as string) : null;

    // Helper to check if date is in range
    const isInRange = (dateStr: string) => {
      if (!start && !end) return true;
      const date = new Date(dateStr);
      if (start && date < start) return false;
      if (end) {
        const endDate = new Date(end);
        endDate.setHours(23, 59, 59, 999); // Include entire end date
        if (date > endDate) return false;
      }
      return true;
    };

    // Calculate metrics
    const totalSessions = agentSessions.length;
    const newSessions = agentSessions.filter((s) => isInRange(s.createdAt)).length;

    // Separate scheduled and non-scheduled sessions
    const scheduledSessions = agentSessions.filter((s) => s.sessionType === "scheduled");
    const nonScheduledSessions = agentSessions.filter((s) => s.sessionType !== "scheduled");
    const totalScheduledSessions = scheduledSessions.length;
    const totalNonScheduledSessions = nonScheduledSessions.length;
    const newScheduledSessions = scheduledSessions.filter((s) => isInRange(s.createdAt)).length;
    const newNonScheduledSessions = nonScheduledSessions.filter((s) => isInRange(s.createdAt)).length;

    // Session types breakdown
    const sessionTypes: Record<string, number> = {};
    const sessionTypesInRange: Record<string, number> = {};

    agentSessions.forEach((session) => {
      const type = session.sessionType || "regular";
      sessionTypes[type] = (sessionTypes[type] || 0) + 1;
      if (isInRange(session.createdAt)) {
        sessionTypesInRange[type] = (sessionTypesInRange[type] || 0) + 1;
      }
    });

    // Helper function to check if user is anonymous
    const isAnonymousUser = (userId: string) => userId.startsWith('anon_');

    // Separate actual users and anonymous users
    const actualUserSessions = agentSessions.filter((s) => !isAnonymousUser(s.userId));
    const anonymousUserSessions = agentSessions.filter((s) => isAnonymousUser(s.userId));

    // Unique users - all time (actual users only)
    const uniqueUsers = new Set(actualUserSessions.map((s) => s.userId));
    const uniqueAnonymousUsers = new Set(anonymousUserSessions.map((s) => s.userId));

    // Sessions in date range (agent sessions only, no messages needed)
    const sessionsInRange = agentSessions.filter((s) => isInRange(s.createdAt));
    const actualSessionsInRange = actualUserSessions.filter((s) => isInRange(s.createdAt));
    const anonymousSessionsInRange = anonymousUserSessions.filter((s) => isInRange(s.createdAt));

    // Active users (users who used Agent Mode at least once during the period)
    const activeUsers = new Set(actualSessionsInRange.map((s) => s.userId));
    const activeAnonymousUsers = new Set(anonymousSessionsInRange.map((s) => s.userId));

    // Sessions before the date range (to identify returning users)
    const sessionsBeforeRange = actualUserSessions.filter((s) => {
      if (!start) return false;
      const date = new Date(s.createdAt);
      return date < start;
    });
    const usersBeforeRange = new Set(sessionsBeforeRange.map((s) => s.userId));

    // New users (users who used Agent Mode for the first time during the period)
    const newUsers = new Set(
      actualSessionsInRange
        .filter((s) => !usersBeforeRange.has(s.userId))
        .map((s) => s.userId)
    );

    // Returning users (users who used Agent Mode before the period and also during the period)
    const returningUsers = new Set(
      Array.from(activeUsers).filter((userId) => usersBeforeRange.has(userId))
    );

    // Calculate sessions per user metrics (only for actual users)
    const sessionsPerUser: Record<string, number> = {};
    actualSessionsInRange.forEach((session) => {
      sessionsPerUser[session.userId] = (sessionsPerUser[session.userId] || 0) + 1;
    });
    const averageSessionsPerActiveUser =
      activeUsers.size > 0
        ? actualSessionsInRange.length / activeUsers.size
        : 0;

    // Total unique users in range (for backward compatibility)
    const uniqueUsersInRange = activeUsers;

    const messageStatsResults = await messageStatsPromise;

    // Aggregate message statistics from lightweight stats
    let totalMessages = 0;
    let messagesInRange = 0;
    const messagesByRole: Record<string, number> = { user: 0, assistant: 0, system: 0, tool: 0 };
    let messagesWithAttachments = 0;
    let messagesWithToolCalls = 0;
    let successfulToolCalls = 0;
    let failedToolCalls = 0;
    let totalTokens = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let messagesWithTokenData = 0;

    messageStatsResults.forEach((stats, i) => {
      if (!stats) return;
      totalMessages += stats.totalMessages;
      if (isInRange(agentSessions[i].createdAt)) {
        messagesInRange += stats.totalMessages;
      }
      for (const [role, count] of Object.entries(stats.messagesByRole)) {
        if (messagesByRole[role] !== undefined) {
          messagesByRole[role] += count;
        }
      }
      messagesWithAttachments += stats.messagesWithAttachments;
      messagesWithToolCalls += stats.messagesWithToolCalls;
      successfulToolCalls += stats.successfulToolCalls;
      failedToolCalls += stats.failedToolCalls;
      totalTokens += stats.totalTokens;
      totalPromptTokens += stats.totalPromptTokens;
      totalCompletionTokens += stats.totalCompletionTokens;
      messagesWithTokenData += stats.messagesWithTokenData;
    });

    const averageMessagesPerSession =
      totalSessions > 0 ? totalMessages / totalSessions : 0;
    const averageMessagesPerActiveUser =
      activeUsers.size > 0 ? messagesInRange / activeUsers.size : 0;

    const averageTokensPerMessage =
      messagesWithTokenData > 0 ? totalTokens / messagesWithTokenData : 0;

    // Sessions with work plans
    const sessionsWithWorkPlans = agentSessions.filter(
      (s) => s.workPlan !== undefined
    ).length;
    const newSessionsWithWorkPlans = agentSessions.filter(
      (s) => s.workPlan !== undefined && isInRange(s.createdAt)
    ).length;

    // Shared sessions
    const sharedSessions = agentSessions.filter(
      (s) => s.shareMetadata?.isShared || s.interactiveShareMetadata?.isActive
    ).length;

    // Tool calls statistics
    const totalToolCalls = agentSessions.reduce((sum, s) => {
      if (!s.calledFunctions) return sum;
      return sum + Object.values(s.calledFunctions).reduce((a, b) => a + b, 0);
    }, 0);

    // Tool calls in date range
    const toolCallsInRange = sessionsInRange.reduce((sum, s) => {
      if (!s.calledFunctions) return sum;
      return sum + Object.values(s.calledFunctions).reduce((a, b) => a + b, 0);
    }, 0);

    const averageToolCallsPerSession =
      totalSessions > 0 ? totalToolCalls / totalSessions : 0;
    const averageToolCallsPerActiveUser =
      activeUsers.size > 0 ? toolCallsInRange / activeUsers.size : 0;

    // Sessions with tool calls
    const sessionsWithToolCalls = agentSessions.filter((s) => {
      if (s.calledFunctions && Object.keys(s.calledFunctions).length > 0) {
        return Object.values(s.calledFunctions).some((count) => count > 0);
      }
      return false;
    }).length;

    const sessionsWithToolCallsInRange = sessionsInRange.filter((s) => {
      if (s.calledFunctions && Object.keys(s.calledFunctions).length > 0) {
        return Object.values(s.calledFunctions).some((count) => count > 0);
      }
      return false;
    }).length;

    // Tool calls by function name (breakdown)
    const toolCallsByFunction: Record<string, number> = {};
    const toolCallsByFunctionInRange: Record<string, number> = {};

    agentSessions.forEach((session) => {
      if (session.calledFunctions) {
        Object.entries(session.calledFunctions).forEach(([functionName, count]) => {
          toolCallsByFunction[functionName] = (toolCallsByFunction[functionName] || 0) + count;

          if (isInRange(session.createdAt)) {
            toolCallsByFunctionInRange[functionName] = (toolCallsByFunctionInRange[functionName] || 0) + count;
          }
        });
      }
    });

    // Failed tool calls by function name (breakdown)
    const failedToolCallsByFunction: Record<string, number> = {};
    const failedToolCallsByFunctionInRange: Record<string, number> = {};

    agentSessions.forEach((session) => {
      if (session.failedFunctions) {
        Object.entries(session.failedFunctions).forEach(([functionName, count]) => {
          failedToolCallsByFunction[functionName] = (failedToolCallsByFunction[functionName] || 0) + count;

          if (isInRange(session.createdAt)) {
            failedToolCallsByFunctionInRange[functionName] = (failedToolCallsByFunctionInRange[functionName] || 0) + count;
          }
        });
      }
    });

    // Build tool call details with success and failure counts
    const allToolNames = new Set([
      ...Object.keys(toolCallsByFunction),
      ...Object.keys(failedToolCallsByFunction),
    ]);
    const toolCallDetails = Array.from(allToolNames).map((name) => ({
      name,
      total: (toolCallsByFunction[name] || 0) + (failedToolCallsByFunction[name] || 0),
      success: toolCallsByFunction[name] || 0,
      failure: failedToolCallsByFunction[name] || 0,
    })).sort((a, b) => b.total - a.total);

    const allToolNamesInRange = new Set([
      ...Object.keys(toolCallsByFunctionInRange),
      ...Object.keys(failedToolCallsByFunctionInRange),
    ]);
    const toolCallDetailsInRange = Array.from(allToolNamesInRange).map((name) => ({
      name,
      total: (toolCallsByFunctionInRange[name] || 0) + (failedToolCallsByFunctionInRange[name] || 0),
      success: toolCallsByFunctionInRange[name] || 0,
      failure: failedToolCallsByFunctionInRange[name] || 0,
    })).sort((a, b) => b.total - a.total);

    // Get top tools (sorted by usage)
    const topTools = Object.entries(toolCallsByFunction)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    const topToolsInRange = Object.entries(toolCallsByFunctionInRange)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    // Daily growth data for chart - separate Scheduled and Non-Scheduled sessions
    const dailyGrowthScheduled: Record<string, number> = {};
    const dailyGrowthNonScheduled: Record<string, number> = {};

    agentSessions.forEach((session) => {
      if (isInRange(session.createdAt)) {
        const dateKey = new Date(session.createdAt).toISOString().split("T")[0];
        const isScheduled = session.sessionType === "scheduled";

        if (isScheduled) {
          dailyGrowthScheduled[dateKey] = (dailyGrowthScheduled[dateKey] || 0) + 1;
        } else {
          dailyGrowthNonScheduled[dateKey] = (dailyGrowthNonScheduled[dateKey] || 0) + 1;
        }
      }
    });

    // Get all unique dates from both
    const allDates = new Set([
      ...Object.keys(dailyGrowthScheduled),
      ...Object.keys(dailyGrowthNonScheduled)
    ]);

    // Sort daily growth by date and combine
    const sortedDailyGrowth = Array.from(allDates)
      .sort((a, b) => a.localeCompare(b))
      .map((date) => ({
        date,
        scheduled: dailyGrowthScheduled[date] || 0,
        nonScheduled: dailyGrowthNonScheduled[date] || 0,
      }));

    res.json({
      totalSessions,
      newSessions,
      totalScheduledSessions,
      totalNonScheduledSessions,
      newScheduledSessions,
      newNonScheduledSessions,
      totalUsers: uniqueUsers.size,
      activeUsers: activeUsers.size,
      newUsers: newUsers.size,
      returningUsers: returningUsers.size,
      totalAnonymousUsers: uniqueAnonymousUsers.size,
      activeAnonymousUsers: activeAnonymousUsers.size,
      averageSessionsPerActiveUser: Math.round(averageSessionsPerActiveUser * 10) / 10,
      sessionTypes,
      sessionTypesInRange,
      totalMessages,
      messagesInRange,
      averageMessagesPerSession: Math.round(averageMessagesPerSession * 10) / 10,
      averageMessagesPerActiveUser: Math.round(averageMessagesPerActiveUser * 10) / 10,
      messagesByRole,
      messagesWithAttachments,
      messagesWithToolCalls,
      successfulToolCalls,
      failedToolCalls,
      totalTokens,
      totalPromptTokens,
      totalCompletionTokens,
      averageTokensPerMessage: Math.round(averageTokensPerMessage * 10) / 10,
      sessionsWithWorkPlans,
      newSessionsWithWorkPlans,
      sharedSessions,
      totalToolCalls,
      toolCallsInRange,
      averageToolCallsPerSession: Math.round(averageToolCallsPerSession * 10) / 10,
      averageToolCallsPerActiveUser: Math.round(averageToolCallsPerActiveUser * 10) / 10,
      sessionsWithToolCalls,
      sessionsWithToolCallsInRange,
      toolCallsByFunction,
      toolCallsByFunctionInRange,
      topTools,
      topToolsInRange,
      toolCallDetails,
      toolCallDetailsInRange,
      dailyGrowth: sortedDailyGrowth,
    });
  } catch (error) {
    console.error("Error getting Agent Mode analytics:", error);
    res.status(500).json({ message: "Error fetching Agent Mode analytics" });
  }
});

// Get single task details
router.get("/tasks/:id", async (req, res) => {
  try {
    const taskId = req.params.id;
    const task = await taskDb.getTaskById(taskId);

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    res.json(task);
  } catch (error) {
    console.error("Error getting task:", error);
    res.status(500).json({ message: "Error fetching task" });
  }
});

// Get task executions
router.get("/tasks/:id/executions", async (req, res) => {
  try {
    const taskId = req.params.id;
    const task = await taskDb.getTaskById(taskId);

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    const executions = await taskDb.getTaskExecutions(taskId);
    res.json(executions);
  } catch (error) {
    console.error("Error getting task executions:", error);
    res.status(500).json({ message: "Error fetching task executions" });
  }
});

// Get task subscribers
router.get("/tasks/:taskId/subscribers", async (req, res) => {
  try {
    const { taskId } = req.params;
    const subscribers = await subscriberDb.getTaskSubscribers(taskId);
    res.json(subscribers);
  } catch (error: any) {
    console.error("Error getting task subscribers:", error);
    res.status(500).json({ message: error.message });
  }
});

// Add subscriber to task
router.post("/tasks/:taskId/subscribers", async (req, res) => {
  try {
    const { taskId } = req.params;
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const subscriber = await subscriberDb.addSubscriber(taskId, email);
    res.status(201).json(subscriber);
  } catch (error: any) {
    console.error("Error adding subscriber:", error);
    if (error.message.includes('already subscribed')) {
      res.status(409).json({ message: error.message });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
});

// Remove subscriber from task
router.delete("/tasks/:taskId/subscribers/:email", async (req, res) => {
  try {
    const { taskId, email } = req.params;
    await subscriberDb.removeSubscriber(taskId, email);
    res.status(204).send();
  } catch (error: any) {
    console.error("Error removing subscriber:", error);
    res.status(500).json({ message: error.message });
  }
});

// Helper function to generate announcement email HTML
const generateAnnouncementEmailHtml = (title: string, message: string, isTest: boolean = false) => {
  const testBanner = isTest ? `
    <div style="background-color: #ff9800; color: white; padding: 10px; text-align: center; font-weight: bold; margin-bottom: 20px;">
      🧪 TEST EMAIL - This is a test announcement
    </div>
  ` : '';

  return `<!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .header {
            background-color: #1976d2;
            color: white;
            padding: 20px;
            text-align: center;
            border-radius: 4px 4px 0 0;
          }
          .content {
            padding: 20px;
            background: #fff;
            border: 1px solid #ddd;
            border-radius: 0 0 4px 4px;
          }
          .content p {
            margin: 0 0 1em 0;
          }
          .content p:last-child {
            margin-bottom: 0;
          }
          .footer {
            text-align: center;
            margin-top: 20px;
            color: #666;
            font-size: 0.9em;
          }
        </style>
      </head>
      <body>
        ${testBanner}
        <div class="header">
          <h2 style="margin:0;padding:0;font-size:24px;">${title}</h2>
        </div>
        <div class="content">
          ${message}
        </div>
        <div class="footer">
          <p>This is an official announcement from AgentWeb</p>
          <p>If you have any questions, please contact our support team at support@agentweb.pro</p>
        </div>
      </body>
    </html>`;
};

// Send announcement to all users
router.post("/announcements/send", async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!message || !title) {
      return res
        .status(400)
        .json({ message: "Title and message are required" });
    }

    // Get all active users
    const users = await userDb.getAllUsers();
    const activeEmails = users
      .filter((user) => user.isActive !== false) // Filter out deactivated users
      .map((user) => user.email)
      .filter(Boolean);

    // Track successful and failed emails
    const results = {
      total: activeEmails.length,
      successful: 0,
      failed: 0,
      failedEmails: [] as string[],
    };

    // Send announcement email to all active users using Resend
    // Process sequentially to respect rate limits and handle errors properly
    const plainTextMessage = message
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .trim();

    for (const email of activeEmails) {
      try {
        const result = await resendService.sendSystemEmail({
          to: email,
          subject: title,
          text: plainTextMessage,
          html: message, // HTML version - use message directly without wrapper
        });

        // Check if email was sent successfully (resendService returns null on failure)
        if (result && result.id) {
          results.successful++;
          console.log(`✅ Announcement sent successfully to ${email} (ID: ${result.id})`);
        } else {
          // resendService.sendEmail returns null after all retries failed
          results.failed++;
          results.failedEmails.push(email);
          console.error(`❌ Failed to send announcement to ${email} after retries`);
        }
      } catch (error: any) {
        console.error(`❌ Error sending announcement to ${email}:`, error.message || error);
        results.failed++;
        results.failedEmails.push(email);
      }
    }

    // Return detailed results
    res.json({
      message: `Announcement sent to ${results.successful} out of ${results.total} active users`,
      details: {
        total: results.total,
        successful: results.successful,
        failed: results.failed,
        failedEmails: results.failedEmails,
      },
    });
  } catch (error) {
    console.error("Error sending announcement:", error);
    res.status(500).json({ message: "Error sending announcement" });
  }
});

// Send test announcement to specified recipients
router.post("/announcements/test", async (req, res) => {
  try {
    const { title, message, recipients } = req.body;
    if (!message || !title) {
      return res
        .status(400)
        .json({ message: "Title and message are required" });
    }
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res
        .status(400)
        .json({ message: "At least one recipient email is required" });
    }

    // Validate email addresses
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const validEmails = recipients.filter((email: string) => emailRegex.test(email.trim()));
    const invalidEmails = recipients.filter((email: string) => !emailRegex.test(email.trim()));

    if (validEmails.length === 0) {
      return res
        .status(400)
        .json({ message: "No valid email addresses provided" });
    }

    // Track successful and failed emails
    const results = {
      total: validEmails.length,
      successful: 0,
      failed: 0,
      failedEmails: [] as string[],
      invalidEmails: invalidEmails,
    };

    // Send test announcement email to specified recipients using Resend
    // Process sequentially to respect rate limits and handle errors properly
    const plainTextMessage = message
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .trim();
    const testBanner = `<div style="background-color: #ff9800; color: white; padding: 10px; text-align: center; font-weight: bold; margin-bottom: 20px;">🧪 TEST EMAIL - This is a test announcement</div>`;
    const testMessage = testBanner + message;

    for (const email of validEmails) {
      try {
        const result = await resendService.sendSystemEmail({
          to: email.trim(),
          subject: `[TEST] ${title}`,
          text: plainTextMessage,
          html: testMessage, // HTML version - use message directly with test banner prepended
        });

        // Check if email was sent successfully (resendService returns null on failure)
        if (result && result.id) {
          results.successful++;
          console.log(`✅ Test announcement sent successfully to ${email} (ID: ${result.id})`);
        } else {
          // resendService.sendEmail returns null after all retries failed
          results.failed++;
          results.failedEmails.push(email);
          console.error(`❌ Failed to send test announcement to ${email} after retries`);
        }
      } catch (error: any) {
        console.error(`❌ Error sending test announcement to ${email}:`, error.message || error);
        results.failed++;
        results.failedEmails.push(email);
      }
    }

    // Return detailed results
    res.json({
      message: `Test announcement sent to ${results.successful} out of ${results.total} recipients`,
      details: {
        total: results.total,
        successful: results.successful,
        failed: results.failed,
        failedEmails: results.failedEmails,
        invalidEmails: results.invalidEmails,
      },
    });
  } catch (error) {
    console.error("Error sending test announcement:", error);
    res.status(500).json({ message: "Error sending test announcement" });
  }
});

// Load announcement content from HTML URL
router.post("/announcements/load-from-url", async (req, res) => {
  const { url } = req.body;

  try {
    if (!url || typeof url !== "string") {
      return res
        .status(400)
        .json({ message: "URL is required and must be a string" });
    }

    // Validate URL format
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return res
        .status(400)
        .json({ message: "Invalid URL format. Must be HTTP or HTTPS." });
    }

    console.log(`🔽 Fetching HTML content from: ${url}`);

    // Fetch the HTML content
    const response = await axios.get(url, {
      timeout: 15000, // 15 seconds timeout
      responseType: "text",
      headers: {
        "User-Agent": "AgentWeb-Backend/1.0",
      },
    });

    const html = response.data as string;
    console.log(`✅ Successfully fetched HTML, length: ${html.length}`);

    // Extract title from <title> tag
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    let extractedTitle = titleMatch ? titleMatch[1].trim() : "";

    // If no title found, try to get from h1 tag
    if (!extractedTitle) {
      const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      extractedTitle = h1Match ? h1Match[1].trim() : "Announcement";
    }

    // Decode HTML entities in title
    extractedTitle = extractedTitle
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");

    let bodyContent = "";

    // If this is a complete HTML email document, preserve it as-is (only strip scripts).
    // Stripping <style> or collapsing whitespace destroys email formatting.
    const isFullHtmlDocument = /<html[\s>]/i.test(html);
    if (isFullHtmlDocument) {
      bodyContent = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");
    } else {
      // For plain HTML fragments, extract body content and clean up
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      bodyContent = bodyMatch ? bodyMatch[1] : html;

      bodyContent = bodyContent
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");

      const mainContentSelectors = [
        /<main[^>]*>([\s\S]*?)<\/main>/i,
        /<article[^>]*>([\s\S]*?)<\/article>/i,
        /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
        /<div[^>]*id="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      ];
      for (const selector of mainContentSelectors) {
        const match = bodyContent.match(selector);
        if (match && match[1].trim().length > 50) {
          bodyContent = match[1];
          break;
        }
      }

      bodyContent = bodyContent
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\s+/g, " ")
        .replace(/>\s+</g, "><")
        .trim();
    }

    if (bodyContent.length > 200000) {
      bodyContent = bodyContent.substring(0, 200000);
    }

    return res.json({
      success: true,
      title: extractedTitle,
      message: bodyContent,
    });
  } catch (error: any) {
    console.error(`❌ Error loading HTML from URL: ${url}`, error.message);

    let errorMessage = "Failed to load HTML content";
    let statusCode = 500;

    if (error.response) {
      statusCode = error.response.status;
      errorMessage = `HTTP ${error.response.status}: ${error.response.statusText}`;
    } else if (error.code === "ENOTFOUND") {
      statusCode = 404;
      errorMessage = "URL not found or unreachable";
    } else if (error.code === "ETIMEDOUT") {
      statusCode = 408;
      errorMessage = "Request timeout while fetching HTML";
    } else if (error.code === "ECONNREFUSED") {
      statusCode = 503;
      errorMessage = "Connection refused";
    }

    return res.status(statusCode).json({
      success: false,
      message: errorMessage,
      error: error.message,
    });
  }
});

// Add the chat sessions route
router.get("/chat-sessions", async (req, res) => {
  try {
    const sessionIdSearch = typeof req.query.sessionId === "string" && req.query.sessionId.trim()
      ? req.query.sessionId.trim()
      : undefined;

    // Fast-path: direct lookup by session ID
    if (sessionIdSearch) {
      const session = await chatbotDb.getChatSession(sessionIdSearch);
      const results = session &&
        Array.isArray(session.messages) &&
        session.messages.some((msg: any) => msg.role === "user")
        ? [session]
        : [];
      return res.json({ sessions: results, nextCursor: null });
    }

    // Filter by user (userId or userEmail)
    const userIdParam = typeof req.query.userId === "string" && req.query.userId.trim()
      ? req.query.userId.trim()
      : undefined;
    const userEmailParam = typeof req.query.userEmail === "string" && req.query.userEmail.trim()
      ? req.query.userEmail.trim().toLowerCase()
      : undefined;

    let filterUserId: string | undefined;
    if (userIdParam) {
      filterUserId = userIdParam;
    } else if (userEmailParam) {
      const user = await userDb.getUserByEmail(userEmailParam);
      if (!user) {
        return res.json({ sessions: [], nextCursor: null });
      }
      filterUserId = user.userId;
    }

    if (filterUserId) {
      const rawLimit = Number(req.query.limit);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 30;

      // Decode offset from cursor (offset-based pagination since results are sorted in memory)
      let offset = 0;
      const cursorParam = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
      if (cursorParam) {
        try {
          const decoded = JSON.parse(Buffer.from(cursorParam, "base64").toString("utf8"));
          if (typeof decoded.offset === "number") offset = decoded.offset;
        } catch {
          return res.status(400).json({ message: "Invalid cursor" });
        }
      }

      // Fetch all sessions for user (metadata only), sort by updatedAt desc
      const allSessions = await chatbotDb.getSessionsWithoutMessages(filterUserId);
      allSessions.sort((a, b) =>
        new Date((b as any).updatedAt).getTime() - new Date((a as any).updatedAt).getTime()
      );

      const page = allSessions.slice(offset, offset + limit);

      // Hydrate messages for this page only
      const sessionsWithMessages = await Promise.all(
        page.map(async (session) => {
          try {
            return (await chatbotDb.getChatSession(session.sessionId)) ?? session;
          } catch {
            return session;
          }
        })
      );

      const nonEmptySessions = sessionsWithMessages.filter((session: any) =>
        Array.isArray(session.messages) &&
        session.messages.some((msg: any) => msg.role === "user")
      );

      const nextOffset = offset + limit;
      const nextCursor = nextOffset < allSessions.length
        ? Buffer.from(JSON.stringify({ offset: nextOffset })).toString("base64")
        : null;

      return res.json({ sessions: nonEmptySessions, nextCursor });
    }

    const startTime = typeof req.query.startTime === "string" ? req.query.startTime : undefined;
    const endTime = typeof req.query.endTime === "string" ? req.query.endTime : undefined;
    const timeRange = startTime && endTime ? { startTime, endTime } : undefined;
    const syncMode = req.query.sync === "true" || req.query.sync === "1";

    // Allow higher limit when time-range is specified (matching old chat-history behavior)
    const maxLimit = timeRange ? 1000 : 100;
    const defaultLimit = timeRange ? 100 : 30;
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), maxLimit) : defaultLimit;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    let lastEvaluatedKey: DynamoDB.DocumentClient.Key | undefined;

    if (cursor) {
      try {
        lastEvaluatedKey = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
      } catch (error) {
        return res.status(400).json({ message: "Invalid cursor" });
      }
    }

    const { sessions, lastEvaluatedKey: nextKey } = await chatbotDb.getRecentSessionsPage(
      limit,
      lastEvaluatedKey,
      timeRange
    );

    // Load messages from the messages table for each session
    const sessionsWithMessages = await Promise.all(
      sessions.map(async (session) => {
        try {
          const sessionWithMessages = await chatbotDb.getChatSession(session.sessionId);
          return sessionWithMessages ?? session;
        } catch (error) {
          console.error(`Error loading messages for session ${session.sessionId}:`, error);
          return session;
        }
      })
    );

    // Sync mode: batch-score sessions that need it (default + all judges)
    if (syncMode) {
      // Load all configured judges
      let judges: ScoringJudge[] = [];
      try {
        const setting = await settingsService.getSetting("scoring-judges");
        if (setting?.settingValue) {
          judges = JSON.parse(setting.settingValue);
        }
      } catch (error) {
        console.error("Error loading scoring judges for sync mode:", error);
      }

      for (const session of sessionsWithMessages) {
        const s = session as any;
        try {
          await scoreSessionIfNeeded(s);
        } catch (error) {
          console.error(`Error scoring session ${s.sessionId}:`, error);
        }

        for (const judge of judges) {
          try {
            await scoreSessionWithJudgeIfNeeded(s, judge);
          } catch (error) {
            console.error(`Error scoring session ${s.sessionId} with judge ${judge.id}:`, error);
          }
        }
      }

      // Re-fetch sessions so response includes newly generated scores (both default and judge)
      for (let i = 0; i < sessionsWithMessages.length; i++) {
        try {
          const refreshed = await chatbotDb.getChatSession((sessionsWithMessages[i] as any).sessionId);
          if (refreshed) sessionsWithMessages[i] = refreshed;
        } catch (error) {
          // Keep original session data on refresh failure
        }
      }
    }

    const nextCursor = nextKey
      ? Buffer.from(JSON.stringify(nextKey)).toString("base64")
      : null;

    // Filter out sessions that have no user messages (not real sessions)
    const nonEmptySessions = sessionsWithMessages.filter((session: any) =>
      Array.isArray(session.messages) &&
      session.messages.some((msg: any) => msg.role === "user")
    );

    res.json({ sessions: nonEmptySessions, nextCursor });
  } catch (error) {
    console.error("Error fetching chat sessions:", error);
    res.status(500).json({ message: "Failed to fetch chat sessions" });
  }
});

// Add a route to update user role
router.put("/users/:userId/role", async (req, res) => {
  try {
    const { userId } = req.params;
    const { roles } = req.body; // Expect an array of roles

    // Validate roles
    const validRolesSet = new Set(["partner", "customer", "free"]);

    if (!Array.isArray(roles) || roles.some((r) => !validRolesSet.has(r))) {
      return res.status(400).json({
        message:
          "Invalid roles. Must be an array containing only: partner, customer, free",
      });
    }

    // If roles array is empty, default to ['partner'] or handle as an error, based on desired logic.
    // For now, let's assume an empty array means removing all specific portal access, which might not be desired.
    // A common default might be ['partner'] if the array is empty, or the frontend should ensure it's not empty.
    // Let's proceed assuming frontend sends at least one valid role if user should have access.
    // If roles is empty, it implies no specific portal access. This is a valid state.

    // Get the user to ensure they exist (optional, updateUser will also check)
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update user in DynamoDB
    await userDb.updateUser(userId, {
      roles, // Pass the array of roles
    });

    res.status(200).json({ message: "User roles updated successfully" });
  } catch (error) {
    console.error("Error updating user roles:", error);
    res.status(500).json({ message: "Error updating user roles" });
  }
});

// Admin delete a configuration (typically a publicly shared one)
router.delete("/configs/:configId", async (req, res) => {
  const { configId } = req.params;
  const dynamodb = new DynamoDB.DocumentClient(); // Ensure dynamodb client is available
  const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
  const tableName = `${TABLE_PREFIX}AW-Configs`;

  try {
    // Step 1: Find the config by configId to get its owner (userId)
    const queryParams = {
      TableName: tableName,
      IndexName: "ConfigIdIndex", // Assuming GSI on configId
      KeyConditionExpression: "configId = :configId",
      ExpressionAttributeValues: {
        ":configId": configId,
      },
    };

    const queryResult = await dynamodb.query(queryParams).promise();

    if (!queryResult.Items || queryResult.Items.length === 0) {
      return res.status(404).json({ message: "Configuration not found" });
    }

    const configToDelete = queryResult.Items[0];
    const ownerUserId = configToDelete.userId;

    // Optional: Check if it's actually a public config if desired
    // if (!configToDelete.shareWithEveryone) {
    //   return res.status(403).json({ message: 'Configuration is not publicly shared. Admin can only delete public configs via this route.' });
    // }

    // Step 2: Delete the config using its primary key (userId, configId)
    await dynamodb
      .delete({
        TableName: tableName,
        Key: {
          userId: ownerUserId, // The actual owner's userId
          configId: configId,
        },
      })
      .promise();

    res.status(204).send();
  } catch (error) {
    console.error(`Error deleting config ${configId} by admin:`, error);
    res
      .status(500)
      .json({ message: "Failed to delete configuration by admin" });
  }
});

// Get chatbot analytics summary
router.get("/analytics/chatbot-summary", async (req, res) => {
  // ... existing code ...
});

// Admin: Delete a user
router.delete("/users/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // It's good practice to check if the user exists before attempting to delete
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Prevent deletion of admin users as an additional safeguard
    if (user.isAdmin) {
      return res
        .status(403)
        .json({ message: "Cannot delete admin users. Deactivate instead." });
    }

    // Perform the deletion
    const deleteResult = await userDb.deleteUserById(userId);

    if (deleteResult.success) {
      res.status(200).json({ message: `User ${userId} deleted successfully.` });
    } else {
      res
        .status(500)
        .json({ message: deleteResult.message || "Failed to delete user." });
    }
  } catch (error) {
    console.error(`Error deleting user ${req.params.userId}:`, error);
    const errorMessage =
      typeof error === "object" && error !== null && "message" in error
        ? (error as { message: string }).message
        : "Internal server error during user deletion";
    res
      .status(500)
      .json({ message: "Error deleting user", error: errorMessage });
  }
});

// Get all workflows
router.get("/workflows", async (req, res) => {
  try {
    const workflows = await workflowDb.getAllWorkflows();

    // Get latest execution for each workflow
    const workflowsWithLatestExecution = await Promise.all(
      (workflows || []).map(async (workflow) => {
        const executions = await workflowDb.getWorkflowExecutions(
          workflow.workflowId
        );
        const latestExecution =
          executions && executions.length > 0 ? executions[0] : null;

        // Count completed and total runs
        const totalRuns = executions ? executions.length : 0;
        const completedRuns = executions
          ? executions.filter((exec) => exec.status === "completed").length
          : 0;

        // Count completed and total tasks
        const totalTasks = latestExecution?.tasks?.length || 0;
        const completedTasks = latestExecution?.tasks
          ? latestExecution.tasks.filter((task) => task.status === "completed")
            .length
          : 0;

        return {
          ...workflow,
          latestRunStatus: latestExecution ? latestExecution.status : "none",
          latestRunTime: latestExecution ? latestExecution.startTime : null,
          completedRuns,
          totalRuns,
          completedTasks,
          totalTasks,
        };
      })
    );

    // Sort workflows by latest run time in descending order
    workflowsWithLatestExecution.sort((a, b) => {
      if (!a.latestRunTime && !b.latestRunTime) return 0;
      if (!a.latestRunTime) return 1;
      if (!b.latestRunTime) return -1;
      return (
        new Date(b.latestRunTime).getTime() -
        new Date(a.latestRunTime).getTime()
      );
    });

    res.json(workflowsWithLatestExecution);
  } catch (error) {
    console.error("Error getting workflows:", error);
    res.status(500).json({ message: "Error fetching workflows" });
  }
});

// Get knowledge base metrics
router.get("/knowledge-base-metrics", async (req, res) => {
  try {
    // Get all tasks
    const tasks = await taskDb.getAllTasks() || [];

    // Calculate overall metrics
    const totalTasks = tasks.length;

    // Handle both string and number knowledgeBaseSize values - only count if size > 0
    const tasksWithKnowledgeBase = tasks.filter(task => {
      const size = typeof task.knowledgeBaseSize === 'string' ? parseInt(task.knowledgeBaseSize) : task.knowledgeBaseSize;
      return size && size > 0;
    }).length;

    const totalKnowledgeBaseSize = tasks.reduce((sum, task) => {
      const size = typeof task.knowledgeBaseSize === 'string' ? parseInt(task.knowledgeBaseSize) : (task.knowledgeBaseSize || 0);
      return sum + size;
    }, 0);

    const averageKnowledgeBaseSize = tasksWithKnowledgeBase > 0 ? totalKnowledgeBaseSize / tasksWithKnowledgeBase : 0;

    // Uploaded files metrics (from knowledgeBaseFiles array)
    const getUploadedFileStats = (task: any) => {
      const files = (task as any).knowledgeBaseFiles || [];
      const count = Array.isArray(files) ? files.length : 0;
      const size = Array.isArray(files)
        ? files.reduce((sum: number, f: any) => sum + (typeof f?.size === 'number' ? f.size : 0), 0)
        : 0;
      return { count, size };
    };

    const totalUploadedFiles = tasks.reduce((sum, task) => sum + getUploadedFileStats(task).count, 0);
    const totalUploadedFilesSize = tasks.reduce((sum, task) => sum + getUploadedFileStats(task).size, 0);
    const tasksWithUploadedFiles = tasks.filter(task => getUploadedFileStats(task).count > 0).length;
    const averageUploadedFilesPerTask = tasksWithUploadedFiles > 0 ? totalUploadedFiles / tasksWithUploadedFiles : 0;
    const averageUploadedFileSizePerTask = tasksWithUploadedFiles > 0 ? totalUploadedFilesSize / tasksWithUploadedFiles : 0;

    // Calculate public knowledge base metrics
    const publicTasks = tasks.filter(task => task.knowledgeBaseType === 'public');
    const publicTasksWithKnowledgeBase = publicTasks.filter(task => {
      const size = typeof task.knowledgeBaseSize === 'string' ? parseInt(task.knowledgeBaseSize) : task.knowledgeBaseSize;
      return size && size > 0;
    }).length;
    const totalPublicKnowledgeBaseSize = publicTasks.reduce((sum, task) => {
      const size = typeof task.knowledgeBaseSize === 'string' ? parseInt(task.knowledgeBaseSize) : (task.knowledgeBaseSize || 0);
      return sum + size;
    }, 0);
    const averagePublicKnowledgeBaseSize = publicTasksWithKnowledgeBase > 0 ? totalPublicKnowledgeBaseSize / publicTasksWithKnowledgeBase : 0;

    const publicUploaded = publicTasks.reduce(
      (acc, task) => {
        const { count, size } = getUploadedFileStats(task);
        acc.count += count;
        acc.size += size;
        if (count > 0) acc.tasksWithFiles += 1;
        return acc;
      },
      { count: 0, size: 0, tasksWithFiles: 0 }
    );
    const averagePublicUploadedFilesPerTask =
      publicUploaded.tasksWithFiles > 0 ? publicUploaded.count / publicUploaded.tasksWithFiles : 0;
    const averagePublicUploadedSizePerTask =
      publicUploaded.tasksWithFiles > 0 ? publicUploaded.size / publicUploaded.tasksWithFiles : 0;

    // Calculate private knowledge base metrics
    const privateTasks = tasks.filter(task => task.knowledgeBaseType === 'private');
    const privateTasksWithKnowledgeBase = privateTasks.filter(task => {
      const size = typeof task.knowledgeBaseSize === 'string' ? parseInt(task.knowledgeBaseSize) : task.knowledgeBaseSize;
      return size && size > 0;
    }).length;
    const totalPrivateKnowledgeBaseSize = privateTasks.reduce((sum, task) => {
      const size = typeof task.knowledgeBaseSize === 'string' ? parseInt(task.knowledgeBaseSize) : (task.knowledgeBaseSize || 0);
      return sum + size;
    }, 0);
    const averagePrivateKnowledgeBaseSize = privateTasksWithKnowledgeBase > 0 ? totalPrivateKnowledgeBaseSize / privateTasksWithKnowledgeBase : 0;

    const privateUploaded = privateTasks.reduce(
      (acc, task) => {
        const { count, size } = getUploadedFileStats(task);
        acc.count += count;
        acc.size += size;
        if (count > 0) acc.tasksWithFiles += 1;
        return acc;
      },
      { count: 0, size: 0, tasksWithFiles: 0 }
    );
    const averagePrivateUploadedFilesPerTask =
      privateUploaded.tasksWithFiles > 0 ? privateUploaded.count / privateUploaded.tasksWithFiles : 0;
    const averagePrivateUploadedSizePerTask =
      privateUploaded.tasksWithFiles > 0 ? privateUploaded.size / privateUploaded.tasksWithFiles : 0;

    // Get tasks with knowledge base details (only those with size > 0)
    const tasksWithDetails = tasks
      .filter(task => {
        const size = typeof task.knowledgeBaseSize === 'string' ? parseInt(task.knowledgeBaseSize) : task.knowledgeBaseSize;
        return size && size > 0;
      })
      .map(task => {
        const size = typeof task.knowledgeBaseSize === 'string' ? parseInt(task.knowledgeBaseSize) : (task.knowledgeBaseSize || 0);
        const { count: uploadedFilesCount, size: uploadedFilesSize } = getUploadedFileStats(task);
        return {
          taskId: task.taskId,
          name: task.name,
          knowledgeBaseSize: size,
          owner: task.userId,
          type: task.knowledgeBaseType || 'private',
          uploadedFilesCount,
          uploadedFilesSize,
        };
      });

    res.json({
      totalTasks,
      tasksWithKnowledgeBase,
      totalKnowledgeBaseSize,
      averageKnowledgeBaseSize,
      uploadedFiles: {
        totalFiles: totalUploadedFiles,
        totalSize: totalUploadedFilesSize,
        tasksWithUploadedFiles,
        averageFilesPerTask: averageUploadedFilesPerTask,
        averageSizePerTask: averageUploadedFileSizePerTask,
      },
      public: {
        tasks: publicTasks.length,
        tasksWithKnowledgeBase: publicTasksWithKnowledgeBase,
        totalSize: totalPublicKnowledgeBaseSize,
        averageSize: averagePublicKnowledgeBaseSize,
        uploadedFiles: {
          totalFiles: publicUploaded.count,
          totalSize: publicUploaded.size,
          tasksWithUploadedFiles: publicUploaded.tasksWithFiles,
          averageFilesPerTask: averagePublicUploadedFilesPerTask,
          averageSizePerTask: averagePublicUploadedSizePerTask,
        },
      },
      private: {
        tasks: privateTasks.length,
        tasksWithKnowledgeBase: privateTasksWithKnowledgeBase,
        totalSize: totalPrivateKnowledgeBaseSize,
        averageSize: averagePrivateKnowledgeBaseSize,
        uploadedFiles: {
          totalFiles: privateUploaded.count,
          totalSize: privateUploaded.size,
          tasksWithUploadedFiles: privateUploaded.tasksWithFiles,
          averageFilesPerTask: averagePrivateUploadedFilesPerTask,
          averageSizePerTask: averagePrivateUploadedSizePerTask,
        },
      },
      tasks: tasksWithDetails
    });
  } catch (error) {
    console.error("Error getting knowledge base metrics:", error);
    res.status(500).json({ message: "Error fetching knowledge base metrics" });
  }
});

// Get GTM analytics (aggregate work item metrics across all plans)
router.get("/analytics/gtm", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const hasDateRange = startDate && endDate;

    const dynamodb = new DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || "us-west-2",
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }),
    });

    const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
    const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

    const plans = await paginatedScan(dynamodb, {
      TableName: TABLE_NAME,
    });

    let totalItems = 0;
    let completedItems = 0;
    let completedItemsInRange = 0;

    for (const plan of plans) {
      const phases = plan.phases || [];
      for (const phase of phases) {
        const items = phase.workItems || [];
        totalItems += items.length;
        for (const item of items) {
          if (item.status === "completed") {
            completedItems++;
            if (hasDateRange) {
              // Use completedAt if available, otherwise infer creation date from item ID
              // ID format: workitem-{timestampMs}-{phaseIdx}-{itemIdx}-{random}
              // Use completedAt if available, otherwise infer creation date from item ID
              // ID format: workitem-{timestampMs}-{phaseIdx}-{itemIdx}-{random}
              let itemDate = item.completedAt;
              if (!itemDate && item.id) {
                const match = item.id.match(/^workitem-(\d+)-/);
                if (match) {
                  itemDate = new Date(parseInt(match[1], 10)).toISOString();
                }
              }
              // Compare date portion only (startDate/endDate are yyyy-MM-dd)
              if (itemDate) {
                const itemDay = itemDate.slice(0, 10);
                if (itemDay >= (startDate as string) && itemDay <= (endDate as string)) {
                  completedItemsInRange++;
                }
              }
            }
          }
        }
      }
    }

    res.json({
      totalItems,
      completedItems,
      completedItemsInRange: hasDateRange ? completedItemsInRange : completedItems,
    });
  } catch (error: any) {
    console.error("Error getting GTM analytics:", error);
    res.status(500).json({ message: "Error fetching GTM analytics" });
  }
});

// CRM analytics endpoint
router.get("/analytics/crm", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const hasDateRange = startDate && endDate;

    const dynamodb = new DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || "us-west-2",
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }),
    });

    const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

    const scanAll = async (tableName: string) => {
      const items: any[] = [];
      let lastKey: any = undefined;
      do {
        const result: any = await dynamodb.scan({
          TableName: tableName,
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        }).promise();
        items.push(...(result.Items || []));
        lastKey = result.LastEvaluatedKey;
      } while (lastKey);
      return items;
    };

    const [leadLists, leads] = await Promise.all([
      scanAll(`${TABLE_PREFIX}AW-LeadLists`),
      scanAll(`${TABLE_PREFIX}AW-Leads`),
    ]);

    const totalLists = leadLists.length;
    const totalLeads = leads.length;
    const totalICPLeads = leads.filter((l) => l.isICP === 1).length;
    const totalEngagedLeads = leads.filter((l) => l.isEngaged === 1).length;

    let newLists = totalLists;
    let newLeads = totalLeads;

    if (hasDateRange) {
      newLists = leadLists.filter((l) => {
        const d = (l.createdAt || "").slice(0, 10);
        return d >= (startDate as string) && d <= (endDate as string);
      }).length;

      newLeads = leads.filter((l) => {
        const d = (l.createdAt || "").slice(0, 10);
        return d >= (startDate as string) && d <= (endDate as string);
      }).length;
    }

    res.json({
      totalLists,
      newLists,
      totalLeads,
      newLeads,
      totalICPLeads,
      totalEngagedLeads,
    });
  } catch (error: any) {
    console.error("Error getting CRM analytics:", error);
    res.status(500).json({ message: "Error fetching CRM analytics" });
  }
});

// Get all GTM plans from all users
router.get("/gtm-plans", async (req, res) => {
  try {
    const dynamodb = new DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || "us-west-2",
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }),
    });

    const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
    const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

    // Scan all GTM plans (admin can see all)
    const plans = await paginatedScan(dynamodb, {
      TableName: TABLE_NAME,
    });

    // Get user information for each plan
    const plansWithUsers = await Promise.all(
      plans.map(async (plan: any) => {
        try {
          const user = await userDb.getUserById(plan.userId);
          return {
            ...plan,
            userEmail: user?.email || undefined,
            userName: user?.name || undefined,
            supportNote: user?.supportNote || undefined,
          };
        } catch (error) {
          return {
            ...plan,
            userEmail: undefined,
            userName: undefined,
            supportNote: undefined,
          };
        }
      })
    );

    res.json({
      success: true,
      data: plansWithUsers,
    });
  } catch (error: any) {
    console.error("Error getting all GTM plans:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching GTM plans",
      error: error?.message || "Internal server error",
    });
  }
});

// Update GTM plan item (work item) - status, notes, PoC (dri)
router.put("/gtm-plans/:planId/phases/:phaseId/work-items/:workItemId", async (req, res) => {
  try {
    const { planId, phaseId, workItemId } = req.params;
    const { status, notes, dri, dueDate, notifications } = req.body;

    const dynamodb = new DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || "us-west-2",
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }),
    });

    const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
    const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

    // Get the existing plan
    const getResult = await dynamodb
      .get({
        TableName: TABLE_NAME,
        Key: {
          planId: planId,
        },
      })
      .promise();

    if (!getResult.Item) {
      return res.status(404).json({
        success: false,
        error: "GTM Plan not found",
      });
    }

    const plan = getResult.Item;
    const phases = plan.phases || [];

    // Find the phase
    const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);
    if (phaseIndex === -1) {
      return res.status(404).json({
        success: false,
        error: "Phase not found",
      });
    }

    const phase = phases[phaseIndex];
    const workItems = phase.workItems || [];

    // Find the work item
    const workItemIndex = workItems.findIndex((item: any) => item.id === workItemId);
    if (workItemIndex === -1) {
      return res.status(404).json({
        success: false,
        error: "Work item not found",
      });
    }

    // Store original item BEFORE updating (for change tracking)
    const originalItem = { ...workItems[workItemIndex] };

    // Update the work item
    const updatedWorkItem = {
      ...workItems[workItemIndex],
      ...(status !== undefined && { status }),
      ...(notes !== undefined && { notes }),
      ...(dri !== undefined && { dri: dri || null }),
      ...(dueDate !== undefined && { dueDate: dueDate && dueDate.trim() !== "" ? dueDate.trim() : null }),
      ...(status === "completed" && originalItem.status !== "completed" && { completedAt: new Date().toISOString() }),
      ...(status !== undefined && status !== "completed" && originalItem.status === "completed" && { completedAt: null }),
    };

    workItems[workItemIndex] = updatedWorkItem;

    // Recalculate phase status based on work items
    const hasWorkItems = workItems.length > 0;
    const allItemsDone = hasWorkItems && workItems.every(
      (item: any) => item.status === "completed" || item.status === "skipped"
    );
    const updatedPhase = {
      ...phase,
      workItems,
      status: allItemsDone ? "completed" : "in_progress",
    };

    phases[phaseIndex] = updatedPhase;

    // Recalculate plan status based on phases
    const hasPhases = phases.length > 0;
    const allPhasesCompleted = hasPhases && phases.every(
      (phase: any) => phase.status === "completed"
    );
    const planStatus = allPhasesCompleted ? "completed" : "in_progress";

    // Check if plan is transitioning to completed
    const wasCompleted = plan.status === "completed";
    const isNowCompleted = planStatus === "completed";
    const justCompleted = !wasCompleted && isNowCompleted;

    const updateExpressions: string[] = [];
    const expressionAttributeNames: { [key: string]: string } = {};
    const expressionAttributeValues: { [key: string]: any } = {};

    updateExpressions.push("#phases = :phases");
    expressionAttributeNames["#phases"] = "phases";
    expressionAttributeValues[":phases"] = phases;

    updateExpressions.push("#status = :status");
    expressionAttributeNames["#status"] = "status";
    expressionAttributeValues[":status"] = planStatus;

    updateExpressions.push("#updatedAt = :updatedAt");
    expressionAttributeNames["#updatedAt"] = "updatedAt";
    expressionAttributeValues[":updatedAt"] = new Date().toISOString();

    if (justCompleted) {
      updateExpressions.push("#completedAt = :completedAt");
      expressionAttributeNames["#completedAt"] = "completedAt";
      expressionAttributeValues[":completedAt"] = new Date().toISOString();
    } else if (wasCompleted && !isNowCompleted) {
      updateExpressions.push("#completedAt = :completedAt");
      expressionAttributeNames["#completedAt"] = "completedAt";
      expressionAttributeValues[":completedAt"] = null;
    }

    const updateParams = {
      TableName: TABLE_NAME,
      Key: {
        planId: planId,
      },
      UpdateExpression: `SET ${updateExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW",
    };

    const result = await dynamodb.update(updateParams).promise();

    // Handle notifications if requested
    if (notifications && (notifications.notifyUser || notifications.notifyItemPoc || notifications.notifyPhasePoc || notifications.notifyPlanPoc)) {
      try {
        const updatedPlan = result.Attributes as any;
        if (updatedPlan) {
          // Track changes for notifications (using originalItem stored before update)
          const changes: { status?: string; notes?: string; dri?: string; dueDate?: string | null } = {};

          if (status !== undefined && status !== originalItem.status) {
            changes.status = status;
          }
          if (notes !== undefined && notes !== originalItem.notes) {
            changes.notes = notes || null;
          }
          if (dri !== undefined && dri !== originalItem.dri) {
            changes.dri = dri || null;
          }
          if (dueDate !== undefined) {
            const newDueDate = dueDate && dueDate.trim() !== "" ? dueDate.trim() : null;
            const oldDueDate = originalItem.dueDate || null;
            if (newDueDate !== oldDueDate) {
              changes.dueDate = newDueDate;
            }
          }

          await sendGTMPlanUpdateNotifications(
            updatedPlan,
            phaseId,
            workItemId,
            changes,
            notifications
          );
        }
      } catch (notificationError: any) {
        console.error("Error sending notifications:", notificationError);
        // Don't fail the request if notifications fail
      }
    }

    // Notify Slack thread if work item was just marked completed
    if (status === "completed" && originalItem.status !== "completed") {
      notifySlackWorkItemCompleted(updatedWorkItem).catch(() => { });
    }

    return res.json({
      success: true,
      data: result.Attributes,
      message: "Work item updated successfully",
    });
  } catch (error: any) {
    console.error("Error updating GTM plan work item:", error);
    res.status(500).json({
      success: false,
      message: "Error updating work item",
      error: error?.message || "Internal server error",
    });
  }
});

// Update GTM plan PoC (dri) or dueDate
router.put("/gtm-plans/:planId", async (req, res) => {
  try {
    const { planId } = req.params;
    const { dri, dueDate } = req.body;

    const dynamodb = new DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || "us-west-2",
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }),
    });

    const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
    const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

    // Get the existing plan
    const getResult = await dynamodb
      .get({
        TableName: TABLE_NAME,
        Key: {
          planId: planId,
        },
      })
      .promise();

    if (!getResult.Item) {
      return res.status(404).json({
        success: false,
        error: "GTM Plan not found",
      });
    }

    const updateExpressions: string[] = [];
    const expressionAttributeNames: { [key: string]: string } = {};
    const expressionAttributeValues: { [key: string]: any } = {};

    if (dri !== undefined) {
      updateExpressions.push("#dri = :dri");
      expressionAttributeNames["#dri"] = "dri";
      expressionAttributeValues[":dri"] = dri || null;
    }

    if (dueDate !== undefined) {
      updateExpressions.push("#dueDate = :dueDate");
      expressionAttributeNames["#dueDate"] = "dueDate";
      expressionAttributeValues[":dueDate"] = dueDate || null;
    }

    updateExpressions.push("#updatedAt = :updatedAt");
    expressionAttributeNames["#updatedAt"] = "updatedAt";
    expressionAttributeValues[":updatedAt"] = new Date().toISOString();

    const updateParams = {
      TableName: TABLE_NAME,
      Key: {
        planId: planId,
      },
      UpdateExpression: `SET ${updateExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW",
    };

    const result = await dynamodb.update(updateParams).promise();

    return res.json({
      success: true,
      data: result.Attributes,
      message: "Plan PoC updated successfully",
    });
  } catch (error: any) {
    console.error("Error updating GTM plan PoC:", error);
    res.status(500).json({
      success: false,
      message: "Error updating plan PoC",
      error: error?.message || "Internal server error",
    });
  }
});

// Update GTM plan phase PoC (dri) or dueDate
router.put("/gtm-plans/:planId/phases/:phaseId", async (req, res) => {
  try {
    const { planId, phaseId } = req.params;
    const { dri, dueDate } = req.body;

    const dynamodb = new DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || "us-west-2",
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }),
    });

    const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
    const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

    // Get the existing plan
    const getResult = await dynamodb
      .get({
        TableName: TABLE_NAME,
        Key: {
          planId: planId,
        },
      })
      .promise();

    if (!getResult.Item) {
      return res.status(404).json({
        success: false,
        error: "GTM Plan not found",
      });
    }

    const plan = getResult.Item;
    const phases = plan.phases || [];

    // Find the phase
    const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);
    if (phaseIndex === -1) {
      return res.status(404).json({
        success: false,
        error: "Phase not found",
      });
    }

    // Update the phase
    const updatedPhase = {
      ...phases[phaseIndex],
      ...(dri !== undefined && { dri: dri || null }),
      ...(dueDate !== undefined && { dueDate: dueDate || null }),
    };

    phases[phaseIndex] = updatedPhase;

    const updateExpressions: string[] = [];
    const expressionAttributeNames: { [key: string]: string } = {};
    const expressionAttributeValues: { [key: string]: any } = {};

    updateExpressions.push("#phases = :phases");
    expressionAttributeNames["#phases"] = "phases";
    expressionAttributeValues[":phases"] = phases;

    updateExpressions.push("#updatedAt = :updatedAt");
    expressionAttributeNames["#updatedAt"] = "updatedAt";
    expressionAttributeValues[":updatedAt"] = new Date().toISOString();

    const updateParams = {
      TableName: TABLE_NAME,
      Key: {
        planId: planId,
      },
      UpdateExpression: `SET ${updateExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW",
    };

    const result = await dynamodb.update(updateParams).promise();

    return res.json({
      success: true,
      data: result.Attributes,
      message: "Phase PoC updated successfully",
    });
  } catch (error: any) {
    console.error("Error updating GTM plan phase PoC:", error);
    res.status(500).json({
      success: false,
      message: "Error updating phase PoC",
      error: error?.message || "Internal server error",
    });
  }
});

// Send phase status report
router.post("/gtm-plans/:planId/phases/:phaseId/send-status-report", async (req, res) => {
  try {
    const { planId, phaseId } = req.params;
    const { notifications, message } = req.body;

    const dynamodb = new DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || "us-west-2",
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }),
    });

    const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
    const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

    // Get the existing plan
    const getResult = await dynamodb
      .get({
        TableName: TABLE_NAME,
        Key: {
          planId: planId,
        },
      })
      .promise();

    if (!getResult.Item) {
      return res.status(404).json({
        success: false,
        error: "GTM Plan not found",
      });
    }

    const plan = getResult.Item;

    // Verify phase exists
    const phase = plan.phases?.find((p: any) => p.id === phaseId);
    if (!phase) {
      return res.status(404).json({
        success: false,
        error: "Phase not found",
      });
    }

    // Send status report
    await sendPhaseStatusReport(
      plan as any,
      phaseId,
      { ...notifications, message },
      process.env.CUSTOMER_FRONTEND_URL
    );

    return res.json({
      success: true,
      message: "Phase status report sent successfully",
    });
  } catch (error: any) {
    console.error("Error sending phase status report:", error);
    res.status(500).json({
      success: false,
      message: "Error sending phase status report",
      error: error?.message || "Internal server error",
    });
  }
});

// Send plan status report
router.post("/gtm-plans/:planId/send-status-report", async (req, res) => {
  try {
    const { planId } = req.params;
    const { notifications, message } = req.body;

    const dynamodb = new DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || "us-west-2",
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }),
    });

    const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
    const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

    // Get the existing plan
    const getResult = await dynamodb
      .get({
        TableName: TABLE_NAME,
        Key: {
          planId: planId,
        },
      })
      .promise();

    if (!getResult.Item) {
      return res.status(404).json({
        success: false,
        error: "GTM Plan not found",
      });
    }

    const plan = getResult.Item;

    // Send status report
    await sendPlanStatusReport(
      plan as any,
      { ...notifications, message },
      process.env.CUSTOMER_FRONTEND_URL
    );

    return res.json({
      success: true,
      message: "Plan status report sent successfully",
    });
  } catch (error: any) {
    console.error("Error sending plan status report:", error);
    res.status(500).json({
      success: false,
      message: "Error sending plan status report",
      error: error?.message || "Internal server error",
    });
  }
});

// Upload attachment to a GTM work item (admin)
router.post("/gtm-plans/:planId/phases/:phaseId/work-items/:workItemId/attachments", upload.single("file"), async (req, res) => {
  try {
    const { planId, phaseId, workItemId } = req.params;
    const file = (req as any).file;

    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const dynamodb = new DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || "us-west-2",
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }),
    });

    const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
    const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

    const getResult = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();
    if (!getResult.Item) {
      return res.status(404).json({ error: "GTM Plan not found" });
    }

    const plan = getResult.Item;
    const phases = plan.phases || [];
    const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);
    if (phaseIndex === -1) {
      return res.status(404).json({ error: "Phase not found" });
    }

    const phase = phases[phaseIndex];
    const workItems = phase.workItems || [];
    const workItemIndex = workItems.findIndex((item: any) => item.id === workItemId);
    if (workItemIndex === -1) {
      return res.status(404).json({ error: "Work item not found" });
    }

    // Upload to S3 using the plan owner's userId
    const { uploadFileToS3 } = await import("../utils/s3Utils");
    const uploadResult = await uploadFileToS3(file.buffer, file.originalname, plan.userId, file.mimetype);
    if (!uploadResult.success) {
      return res.status(500).json({ error: "Failed to upload file to S3" });
    }

    const attachment = {
      id: `att-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      filename: file.originalname,
      size: file.size,
      contentType: file.mimetype,
      url: uploadResult.url,
      uploadedAt: new Date().toISOString(),
    };

    const workItem = workItems[workItemIndex];
    const attachments = workItem.attachments || [];
    attachments.push(attachment);
    workItems[workItemIndex] = { ...workItem, attachments };
    phases[phaseIndex] = { ...phase, workItems };

    await dynamodb.update({
      TableName: TABLE_NAME,
      Key: { planId },
      UpdateExpression: "SET #phases = :phases, #updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#phases": "phases", "#updatedAt": "updatedAt" },
      ExpressionAttributeValues: { ":phases": phases, ":updatedAt": new Date().toISOString() },
    }).promise();

    return res.json({ success: true, data: attachment });
  } catch (error: any) {
    console.error("Error uploading work item attachment (admin):", error);
    return res.status(500).json({ success: false, error: error?.message || "Internal server error" });
  }
});

// Delete an attachment from a GTM work item (admin)
router.delete("/gtm-plans/:planId/phases/:phaseId/work-items/:workItemId/attachments/:attachmentId", async (req, res) => {
  try {
    const { planId, phaseId, workItemId, attachmentId } = req.params;

    const dynamodb = new DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || "us-west-2",
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }),
    });

    const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
    const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

    const getResult = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();
    if (!getResult.Item) {
      return res.status(404).json({ error: "GTM Plan not found" });
    }

    const plan = getResult.Item;
    const phases = plan.phases || [];
    const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);
    if (phaseIndex === -1) {
      return res.status(404).json({ error: "Phase not found" });
    }

    const phase = phases[phaseIndex];
    const workItems = phase.workItems || [];
    const workItemIndex = workItems.findIndex((item: any) => item.id === workItemId);
    if (workItemIndex === -1) {
      return res.status(404).json({ error: "Work item not found" });
    }

    const workItem = workItems[workItemIndex];
    const attachments = workItem.attachments || [];
    const attachmentIndex = attachments.findIndex((a: any) => a.id === attachmentId);
    if (attachmentIndex === -1) {
      return res.status(404).json({ error: "Attachment not found" });
    }

    attachments.splice(attachmentIndex, 1);
    workItems[workItemIndex] = { ...workItem, attachments };
    phases[phaseIndex] = { ...phase, workItems };

    await dynamodb.update({
      TableName: TABLE_NAME,
      Key: { planId },
      UpdateExpression: "SET #phases = :phases, #updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#phases": "phases", "#updatedAt": "updatedAt" },
      ExpressionAttributeValues: { ":phases": phases, ":updatedAt": new Date().toISOString() },
    }).promise();

    return res.json({ success: true, message: "Attachment deleted" });
  } catch (error: any) {
    console.error("Error deleting work item attachment (admin):", error);
    return res.status(500).json({ success: false, error: error?.message || "Internal server error" });
  }
});

// Start an Agent Mode session from a GTM work item (admin)
router.post("/gtm-plans/:planId/phases/:phaseId/work-items/:workItemId/start-session", async (req, res) => {
  try {
    const { planId, phaseId, workItemId } = req.params;

    const dynamodb = new DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || "us-west-2",
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }),
    });

    const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
    const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

    const getResult = await dynamodb
      .get({
        TableName: TABLE_NAME,
        Key: { planId },
      })
      .promise();

    if (!getResult.Item) {
      return res.status(404).json({ error: "GTM Plan not found" });
    }

    const plan = getResult.Item;
    const phases = plan.phases || [];

    const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);
    if (phaseIndex === -1) {
      return res.status(404).json({ error: "Phase not found" });
    }

    const phase = phases[phaseIndex];
    const workItems = phase.workItems || [];
    const workItemIndex = workItems.findIndex((item: any) => item.id === workItemId);
    if (workItemIndex === -1) {
      return res.status(404).json({ error: "Work item not found" });
    }

    const workItem = workItems[workItemIndex];

    if (workItem.status !== "pending") {
      return res.status(400).json({ error: "Only pending work items can be started" });
    }

    // Create Agent Mode session for the plan's owner
    const session = await chatbotDb.createChatSession(
      plan.userId,
      undefined,
      "agent",
      "agent-mode",
      undefined,
      undefined,
      undefined,
      undefined,
      "regular"
    );

    const { agentModeService } = await import('../services/agentModeService');
    const modelToUse = await agentModeService.getDefaultModel();
    await chatbotDb.updateSessionLlmModel(session.sessionId, modelToUse);
    await chatbotDb.updateSessionGtmWorkItem(session.sessionId, { planId, phaseId, workItemId });

    // Build the initial message from work item title + description
    const initialMessage = workItem.description
      ? `${workItem.title}\n\n${workItem.description}`
      : workItem.title;

    // Convert work item attachments to the format expected by generateSessionResponse
    const { presignS3Url } = await import("../utils/s3Utils");
    const workItemAttachments = (workItem.attachments || []).map((att: any) => {
      const presignedUrl = presignS3Url(att.url);
      return {
        url: presignedUrl || att.url,
        filename: att.filename,
        size: att.size,
        mimetype: att.contentType,
        uploadedAt: att.uploadedAt,
      };
    });

    // Fire-and-forget: trigger AI response generation in the background
    // generateSessionResponse syncs GTM work item status via session.gtmWorkItem
    const planUserId = plan.userId;
    const { generateSessionResponse } = await import('../controllers/agentModeController');
    const { io } = await import('../server');
    generateSessionResponse(session.sessionId, initialMessage, planUserId, modelToUse, workItemAttachments.length > 0 ? workItemAttachments : undefined)
      .then(() => {
        console.log(`GTM work item session ${session.sessionId}: AI response generated (admin)`);
        io.to(`user:${planUserId}`).emit("gtm-session-ready", {
          sessionId: session.sessionId,
          workItemId,
          workItemTitle: workItem.title,
        });
      })
      .catch((error) => {
        console.error(`GTM work item session ${session.sessionId}: AI response generation failed (admin):`, error);
        io.to(`user:${planUserId}`).emit("gtm-session-ready", {
          sessionId: session.sessionId,
          workItemId,
          workItemTitle: workItem.title,
          error: true,
        });
      });

    // Update work item
    workItems[workItemIndex] = {
      ...workItem,
      status: "agent_in_progress",
      agentSessionId: session.sessionId,
    };

    phases[phaseIndex] = { ...phase, workItems };

    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { planId },
        UpdateExpression: "SET #phases = :phases, #updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#phases": "phases",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":phases": phases,
          ":updatedAt": new Date().toISOString(),
        },
      })
      .promise();

    return res.json({
      success: true,
      data: {
        sessionId: session.sessionId,
        workItemTitle: workItem.title,
        workItemDescription: workItem.description,
      },
      message: "Agent Mode session started",
    });
  } catch (error: any) {
    console.error("Error starting Agent Mode session from GTM work item (admin):", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Internal server error",
    });
  }
});

// Subscription Types endpoints

// Get all available skills for subscription configuration
router.get("/available-skills", async (req, res) => {
  try {
    const { skillService } = await import('../services/skillService');
    const publishedSkills = await skillService.getPublishedSkills();
    const { agentModeService } = await import('../services/agentModeService');

    const skills = publishedSkills.map((s: any) => ({
      skillId: s.skillId,
      name: s.name,
      description: s.description,
      toolNames: s.toolNames || []
    }));

    // Add virtual __other_skills__ entry
    const unassociatedToolNames = agentModeService.getUnassociatedToolNames(publishedSkills);
    if (unassociatedToolNames.length > 0) {
      skills.push({
        skillId: '__other_skills__',
        name: 'Other Skills',
        description: 'Tools not associated with any published skill',
        toolNames: unassociatedToolNames
      });
    }

    res.json(skills);
  } catch (error) {
    console.error("Error getting available skills:", error);
    res.status(500).json({ message: "Error fetching available skills" });
  }
});

// Get all subscription types
router.get("/subscription-types", async (req, res) => {
  try {
    const setting = await settingsService.getSetting("subscription_types");
    let subscriptionTypes = [];

    if (setting) {
      try {
        subscriptionTypes = JSON.parse(setting.settingValue);
      } catch (error) {
        console.error("Error parsing subscription types:", error);
        subscriptionTypes = [];
      }
    }

    // Import helper functions to expand "*" to actual lists if needed
    const subscriptionService = await import('../services/subscriptionService');
    const allAvailablePages = subscriptionService.getAllAvailablePages();
    const allAvailableSkills = await subscriptionService.getAllAvailableSkills();
    const allAvailableConnectedAccounts = subscriptionService.getAllAvailableConnectedAccounts();

    // If no subscription types exist, return default Basic type with actual lists
    if (subscriptionTypes.length === 0) {
      subscriptionTypes = [{
        name: "Basic",
        allowedPages: allAvailablePages, // All available pages (expanded)
        allowedSkills: allAvailableSkills, // All available skills (expanded)
        allowedConnectedAccounts: allAvailableConnectedAccounts, // All platforms (expanded)
      }];
    }

    // Normalize paths: remove "/marketing" prefix from allowedPages (for backward compatibility)
    // Also expand "*" to actual lists if present (for backward compatibility with old data)
    subscriptionTypes = await Promise.all(subscriptionTypes.map(async (type: any) => {
      // Normalize pages
      let normalizedPages = type.allowedPages.map((page: string) => {
        if (page.startsWith('/marketing/')) {
          return page.replace('/marketing', '');
        }
        return page;
      });

      // Expand "*" to actual list if present (for backward compatibility)
      if (normalizedPages.includes('*')) {
        normalizedPages = allAvailablePages;
      }

      // Handle allowedSkills with backward compatibility
      // If old format (allowedFunctionCalls but no allowedSkills), treat as all skills
      let normalizedSkills = type.allowedSkills || allAvailableSkills;
      if (normalizedSkills.includes('*')) {
        normalizedSkills = allAvailableSkills;
      }

      // Handle allowedConnectedAccounts — default to all if missing or "*"
      let normalizedConnectedAccounts = type.allowedConnectedAccounts || allAvailableConnectedAccounts;
      if (normalizedConnectedAccounts.includes('*')) {
        normalizedConnectedAccounts = allAvailableConnectedAccounts;
      }

      // Pass through hiddenPages as-is (these are never wildcarded)
      const hiddenPages: string[] = Array.isArray(type.hiddenPages) ? type.hiddenPages : [];

      return {
        name: type.name,
        allowedPages: normalizedPages,
        ...(hiddenPages.length > 0 ? { hiddenPages } : {}),
        allowedSkills: normalizedSkills,
        allowedConnectedAccounts: normalizedConnectedAccounts,
        ...(type.monthlyTokenAllowance != null ? { monthlyTokenAllowance: type.monthlyTokenAllowance } : {}),
      };
    }));

    res.json(subscriptionTypes);
  } catch (error) {
    console.error("Error getting subscription types:", error);
    res.status(500).json({ message: "Error fetching subscription types" });
  }
});

// Create or update subscription types
router.post("/subscription-types", async (req, res) => {
  try {
    const { subscriptionTypes } = req.body;

    if (!Array.isArray(subscriptionTypes)) {
      return res.status(400).json({ message: "subscriptionTypes must be an array" });
    }

    // Import helper functions to expand "*" to actual lists
    const subscriptionService = await import('../services/subscriptionService');
    const allAvailablePages = subscriptionService.getAllAvailablePages();
    const allAvailableSkills = await subscriptionService.getAllAvailableSkills();
    const allAvailableConnectedAccounts = subscriptionService.getAllAvailableConnectedAccounts();

    // Validate subscription types structure, normalize paths, and expand "*" to actual lists
    const normalizedTypes = await Promise.all(subscriptionTypes.map(async (type: any) => {
      if (!type.name || typeof type.name !== "string") {
        throw new Error("Each subscription type must have a name");
      }
      if (!Array.isArray(type.allowedPages)) {
        throw new Error("Each subscription type must have allowedPages array");
      }
      if (!Array.isArray(type.allowedSkills)) {
        throw new Error("Each subscription type must have allowedSkills array");
      }

      // Remove "/marketing" prefix from allowedPages if present
      let normalizedPages = type.allowedPages.map((page: string) => {
        if (page.startsWith('/marketing/')) {
          return page.replace('/marketing', '');
        }
        return page;
      });

      // Expand "*" to actual list of pages
      if (normalizedPages.includes('*')) {
        normalizedPages = allAvailablePages;
      }

      // Expand "*" to actual list of skills
      let normalizedSkills = type.allowedSkills;
      if (normalizedSkills.includes('*')) {
        normalizedSkills = allAvailableSkills;
      }

      // Handle allowedConnectedAccounts — default to all if missing or "*"
      let normalizedConnectedAccounts = Array.isArray(type.allowedConnectedAccounts)
        ? type.allowedConnectedAccounts
        : allAvailableConnectedAccounts;
      if (normalizedConnectedAccounts.includes('*')) {
        normalizedConnectedAccounts = allAvailableConnectedAccounts;
      }

      // Parse monthlyTokenAllowance (preserve null for unlimited)
      const parsedAllowance = type.monthlyTokenAllowance != null
        ? Number(type.monthlyTokenAllowance)
        : null;

      // Pass through hiddenPages as-is; validate it's an array of strings
      const hiddenPages: string[] = Array.isArray(type.hiddenPages)
        ? type.hiddenPages.filter((p: any) => typeof p === 'string')
        : [];

      return {
        name: type.name,
        allowedPages: normalizedPages,
        ...(hiddenPages.length > 0 ? { hiddenPages } : {}),
        allowedSkills: normalizedSkills,
        allowedConnectedAccounts: normalizedConnectedAccounts,
        ...(parsedAllowance != null && !isNaN(parsedAllowance) ? { monthlyTokenAllowance: parsedAllowance } : {}),
      };
    }));

    const updatedBy = (req as any).user?.email || "unknown";
    await settingsService.setSetting(
      "subscription_types",
      JSON.stringify(normalizedTypes),
      "Customer portal subscription types configuration",
      updatedBy
    );

    res.json({ success: true, subscriptionTypes: normalizedTypes });
  } catch (error: any) {
    console.error("Error saving subscription types:", error);
    res.status(400).json({ message: error.message || "Error saving subscription types" });
  }
});

// Add or remove a single skill from a subscription type
router.post("/subscription-types/:typeName/skills", async (req, res) => {
  try {
    const { typeName } = req.params;
    const { skillId, action } = req.body; // action: "add" | "remove"

    if (!skillId || typeof skillId !== "string") {
      return res.status(400).json({ message: "skillId is required" });
    }
    if (action !== "add" && action !== "remove") {
      return res.status(400).json({ message: "action must be 'add' or 'remove'" });
    }

    // Load current subscription types
    const setting = await settingsService.getSetting("subscription_types");
    let subscriptionTypes: any[] = [];
    if (setting) {
      try {
        subscriptionTypes = JSON.parse(setting.settingValue);
      } catch {
        subscriptionTypes = [];
      }
    }

    const typeIndex = subscriptionTypes.findIndex((t: any) => t.name === typeName);
    if (typeIndex < 0) {
      return res.status(404).json({ message: `Subscription type "${typeName}" not found` });
    }

    const subType = subscriptionTypes[typeIndex];
    let allowedSkills: string[] = subType.allowedSkills || [];

    // If wildcard, expand to actual skill list first
    if (allowedSkills.includes("*")) {
      const subscriptionService = await import('../services/subscriptionService');
      allowedSkills = await subscriptionService.getAllAvailableSkills();
    }

    if (action === "add") {
      if (!allowedSkills.includes(skillId)) {
        allowedSkills = [...allowedSkills, skillId];
      }
    } else {
      allowedSkills = allowedSkills.filter((id: string) => id !== skillId);
    }

    subscriptionTypes[typeIndex] = { ...subType, allowedSkills };

    const updatedBy = (req as any).user?.email || "unknown";
    await settingsService.setSetting(
      "subscription_types",
      JSON.stringify(subscriptionTypes),
      "Customer portal subscription types configuration",
      updatedBy
    );

    res.json({ success: true, subscriptionType: subscriptionTypes[typeIndex] });
  } catch (error: any) {
    console.error("Error updating subscription type skill:", error);
    res.status(500).json({ message: error.message || "Error updating subscription type skill" });
  }
});

// Get public (anonymous user) allowed skills
router.get("/public-skills", async (req, res) => {
  try {
    const setting = await settingsService.getSetting("public_allowed_skills");
    let allowedSkills: string[] = [];
    if (setting) {
      try {
        const parsed = JSON.parse(setting.settingValue);
        if (Array.isArray(parsed)) {
          allowedSkills = parsed;
        }
      } catch { /* use default */ }
    }
    res.json({ allowedSkills });
  } catch (error: any) {
    console.error("Error getting public skills:", error);
    res.status(500).json({ message: error.message || "Error getting public skills" });
  }
});

// Toggle a skill for public (anonymous) access
router.post("/public-skills", async (req, res) => {
  try {
    const { skillId, action } = req.body; // action: "add" | "remove"

    if (!skillId || typeof skillId !== "string") {
      return res.status(400).json({ message: "skillId is required" });
    }
    if (action !== "add" && action !== "remove") {
      return res.status(400).json({ message: "action must be 'add' or 'remove'" });
    }

    // Load current public skills
    const setting = await settingsService.getSetting("public_allowed_skills");
    let allowedSkills: string[] = [];
    if (setting) {
      try {
        allowedSkills = JSON.parse(setting.settingValue);
      } catch {
        allowedSkills = [];
      }
    }

    // If wildcard, expand to actual skill list first
    if (allowedSkills.includes("*")) {
      const subscriptionService = await import('../services/subscriptionService');
      allowedSkills = await subscriptionService.getAllAvailableSkills();
    }

    if (action === "add") {
      if (!allowedSkills.includes(skillId)) {
        allowedSkills = [...allowedSkills, skillId];
      }
    } else {
      allowedSkills = allowedSkills.filter((id: string) => id !== skillId);
    }

    const updatedBy = (req as any).user?.email || "unknown";
    await settingsService.setSetting(
      "public_allowed_skills",
      JSON.stringify(allowedSkills),
      "Skills available to public/anonymous users",
      updatedBy
    );

    res.json({ success: true, allowedSkills });
  } catch (error: any) {
    console.error("Error updating public skills:", error);
    res.status(500).json({ message: error.message || "Error updating public skills" });
  }
});

// Update user subscription type
router.put("/users/:userId/subscription-type", async (req, res) => {
  try {
    const { userId } = req.params;
    const { subscriptionType } = req.body;

    if (!subscriptionType || typeof subscriptionType !== "string") {
      return res.status(400).json({ message: "subscriptionType is required and must be a string" });
    }

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Verify subscription type exists
    const setting = await settingsService.getSetting("subscription_types");
    let subscriptionTypes = [];

    if (setting) {
      try {
        subscriptionTypes = JSON.parse(setting.settingValue);
      } catch (error) {
        console.error("Error parsing subscription types:", error);
      }
    }

    // If no subscription types defined, allow "Basic" as default
    if (subscriptionTypes.length === 0 && subscriptionType !== "Basic") {
      return res.status(400).json({ message: "Subscription type not found. Only 'Basic' is available." });
    }

    // Check if subscription type exists (unless it's Basic and no types are defined)
    if (subscriptionTypes.length > 0) {
      const typeExists = subscriptionTypes.some((type: any) => type.name === subscriptionType);
      if (!typeExists) {
        return res.status(400).json({ message: "Subscription type not found" });
      }
    }

    // Update the user's subscription type
    const updatedUser = await userDb.updateUser(userId, { subscriptionType });
    syncUserUpdateToLeadList(user.email, { subscriptionType });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user subscription type:", error);
    res.status(500).json({ message: "Error updating subscription type" });
  }
});

// Grant token bonus to a user
router.post("/users/:userId/token-bonus", async (req, res) => {
  try {
    const { userId } = req.params;
    const { bonusTokens } = req.body;

    if (typeof bonusTokens !== "number" || bonusTokens <= 0) {
      return res.status(400).json({ message: "bonusTokens must be a positive number" });
    }

    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    await grantTokenBonus(userId, bonusTokens);
    const updatedUser = await userDb.getUserById(userId);
    res.json(updatedUser);
  } catch (error) {
    console.error("Error granting token bonus:", error);
    res.status(500).json({ message: "Error granting token bonus" });
  }
});

// Send team introduction email to a user
router.post("/users/:userId/send-intro-email", async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    await emailService.sendTeamIntroductionEmail(user.email, user.displayName);
    const sentAt = new Date().toISOString();
    const updatedUser = await userDb.updateUser(userId, { introductionEmailSent: sentAt });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error sending team introduction email:", error);
    res.status(500).json({ message: "Error sending team introduction email" });
  }
});

// Get token usage for a specific user
router.get("/users/:userId/token-usage", async (req, res) => {
  try {
    const { userId } = req.params;
    const usage = await getUserTokenUsage(userId);
    const { allowance, bonus, effectiveAllowance } = await getUserTokenAllowance(userId);
    res.json({ ...usage, allowance, effectiveAllowance });
  } catch (error) {
    console.error("Error getting user token usage:", error);
    res.status(500).json({ message: "Error getting token usage" });
  }
});

// Get GTM common items (categories with items)
router.get("/gtm-common-items", async (req, res) => {
  try {
    const setting = await settingsService.getSetting("gtm_common_items");
    const categories = setting?.settingValue ? JSON.parse(setting.settingValue) : [];
    return res.json({ success: true, data: categories });
  } catch (error) {
    console.error("Error fetching GTM common items:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch GTM common items" });
  }
});

// Save GTM common items (full replacement)
router.put("/gtm-common-items", async (req, res) => {
  try {
    const { categories } = req.body;

    if (!Array.isArray(categories)) {
      return res.status(400).json({ success: false, error: "categories must be an array" });
    }

    // Validate each category has a name and each item has a title
    for (const category of categories) {
      if (!category.name || typeof category.name !== "string" || !category.name.trim()) {
        return res.status(400).json({ success: false, error: "Each category must have a name" });
      }
      if (Array.isArray(category.items)) {
        for (const item of category.items) {
          if (!item.title || typeof item.title !== "string" || !item.title.trim()) {
            return res.status(400).json({ success: false, error: "Each item must have a title" });
          }
        }
      }
    }

    const adminEmail = req.user?.email || "admin";
    await settingsService.setSetting(
      "gtm_common_items",
      JSON.stringify(categories),
      "GTM common work items by category",
      adminEmail
    );

    return res.json({ success: true, data: categories });
  } catch (error) {
    console.error("Error saving GTM common items:", error);
    return res.status(500).json({ success: false, error: "Failed to save GTM common items" });
  }
});

// --- Result Endpoint Config CRUD ---

router.get("/result-endpoints", async (req, res) => {
  try {
    const { getResultEndpointConfigs } = await import("../controllers/resultEndpointController");
    const configs = await getResultEndpointConfigs();
    return res.json({ success: true, data: configs });
  } catch (error) {
    console.error("Error fetching result endpoint configs:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch result endpoint configs" });
  }
});

router.post("/result-endpoints", async (req, res) => {
  try {
    const { name, resultTitle, prompt, outputFormat, reviewerEmail, skipReview, llmModel, requiredSkills, waitingContent } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ success: false, error: "name is required" });
    }
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ success: false, error: "prompt is required" });
    }
    if (!outputFormat || !["html", "image", "video"].includes(outputFormat)) {
      return res.status(400).json({ success: false, error: "outputFormat must be html, image, or video" });
    }
    if (!reviewerEmail || typeof reviewerEmail !== "string" || !reviewerEmail.trim()) {
      return res.status(400).json({ success: false, error: "reviewerEmail is required" });
    }

    const { getResultEndpointConfigs, saveResultEndpointConfigs } = await import("../controllers/resultEndpointController");
    const configs = await getResultEndpointConfigs();

    const existingIndex = configs.findIndex(c => c.name === name.trim());
    // Build waitingContent if provided
    let parsedWaitingContent: { type: 'youtube' | 'url' | 'html'; value: string; title?: string } | undefined;
    if (waitingContent && waitingContent.type && waitingContent.value) {
      const validTypes = ['youtube', 'url', 'html'];
      if (!validTypes.includes(waitingContent.type)) {
        return res.status(400).json({ success: false, error: "waitingContent.type must be youtube, url, or html" });
      }
      parsedWaitingContent = {
        type: waitingContent.type,
        value: waitingContent.value,
        title: waitingContent.title || undefined,
      };
    }

    const newConfig = {
      name: name.trim(),
      resultTitle: resultTitle?.trim() || undefined,
      prompt: prompt.trim(),
      outputFormat,
      reviewerEmail: reviewerEmail.trim(),
      skipReview: !!skipReview,
      llmModel: llmModel || undefined,
      requiredSkills: requiredSkills || undefined,
      waitingContent: parsedWaitingContent,
    };

    if (existingIndex >= 0) {
      configs[existingIndex] = newConfig;
    } else {
      configs.push(newConfig);
    }

    const adminEmail = req.user?.email || "admin";
    await saveResultEndpointConfigs(configs, adminEmail);

    return res.json({ success: true, data: newConfig });
  } catch (error) {
    console.error("Error saving result endpoint config:", error);
    return res.status(500).json({ success: false, error: "Failed to save result endpoint config" });
  }
});

router.delete("/result-endpoints/:name", async (req, res) => {
  try {
    const { name } = req.params;

    const { getResultEndpointConfigs, saveResultEndpointConfigs } = await import("../controllers/resultEndpointController");
    const configs = await getResultEndpointConfigs();
    const filtered = configs.filter(c => c.name !== name);

    if (filtered.length === configs.length) {
      return res.status(404).json({ success: false, error: `Result endpoint "${name}" not found` });
    }

    const adminEmail = req.user?.email || "admin";
    await saveResultEndpointConfigs(filtered, adminEmail);

    return res.json({ success: true, message: `Result endpoint "${name}" deleted` });
  } catch (error) {
    console.error("Error deleting result endpoint config:", error);
    return res.status(500).json({ success: false, error: "Failed to delete result endpoint config" });
  }
});

// Score chat sessions for satisfaction
router.post("/chat-sessions/score", async (req, res) => {
  try {
    const { sessionIds } = req.body;

    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      return res.status(400).json({ message: "sessionIds must be a non-empty array" });
    }
    if (sessionIds.length > 5) {
      return res.status(400).json({ message: "Maximum 5 sessionIds per request" });
    }

    const results = await Promise.allSettled(
      sessionIds.map(async (sessionId: string) => {
        const session = await chatbotDb.getChatSession(sessionId);
        if (!session) return { sessionId, score: null };
        const score = await scoreSessionIfNeeded(session);
        return { sessionId, score };
      })
    );

    const scores: Record<string, any> = {};
    const failed: string[] = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        scores[result.value.sessionId] = result.value.score;
      } else {
        failed.push(sessionIds[i]);
      }
    });

    res.json({ scores, failed });
  } catch (error: any) {
    console.error("Error scoring chat sessions:", error);
    res.status(500).json({ message: "Failed to score chat sessions" });
  }
});

// Admin override satisfaction score
router.put("/chat-sessions/:sessionId/score", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { score, reason } = req.body;

    if (typeof score !== "number" || score < 1 || score > 5 || !Number.isInteger(score)) {
      return res.status(400).json({ message: "score must be an integer between 1 and 5" });
    }

    const session = await chatbotDb.getChatSession(sessionId);
    if (!session) {
      return res.status(404).json({ message: "Session not found" });
    }

    const satisfactionScore = {
      score,
      reason: reason || "Admin override",
      evaluatedAt: new Date().toISOString(),
      evaluatedMessageIndex: session.messageCount ?? session.messages?.length ?? 0,
      adminOverride: true as const,
    };

    await chatbotDb.updateSessionSatisfactionScore(sessionId, satisfactionScore);

    res.json({ satisfactionScore });
  } catch (error: any) {
    console.error("Error overriding satisfaction score:", error);
    res.status(500).json({ message: "Failed to update satisfaction score" });
  }
});

// Score sessions with a custom judge
router.post("/chat-sessions/judge-score", async (req, res) => {
  try {
    const { sessionIds, judgeId } = req.body;

    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      return res.status(400).json({ message: "sessionIds must be a non-empty array" });
    }
    if (sessionIds.length > 5) {
      return res.status(400).json({ message: "Maximum 5 sessionIds per request" });
    }
    if (!judgeId || typeof judgeId !== "string") {
      return res.status(400).json({ message: "judgeId is required" });
    }

    // Fetch judge config from settings
    const setting = await settingsService.getSetting("scoring-judges");
    if (!setting || !setting.settingValue) {
      return res.status(404).json({ message: "No scoring judges configured" });
    }

    let judges: ScoringJudge[];
    try {
      judges = JSON.parse(setting.settingValue);
    } catch {
      return res.status(500).json({ message: "Invalid scoring judges configuration" });
    }

    const judge = judges.find((j) => j.id === judgeId);
    if (!judge) {
      return res.status(404).json({ message: "Judge not found" });
    }

    const results = await Promise.allSettled(
      sessionIds.map(async (sessionId: string) => {
        const session = await chatbotDb.getChatSession(sessionId);
        if (!session) return { sessionId, score: null };
        const score = await scoreSessionWithJudgeIfNeeded(session, judge);
        return { sessionId, score };
      })
    );

    const scores: Record<string, any> = {};
    const failed: string[] = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        scores[result.value.sessionId] = result.value.score;
      } else {
        failed.push(sessionIds[i]);
      }
    });

    res.json({ scores, failed });
  } catch (error: any) {
    console.error("Error scoring chat sessions with judge:", error);
    res.status(500).json({ message: "Failed to score chat sessions with judge" });
  }
});

// Get alert email lists (oncall + product issue)
router.get("/alert-emails", async (req, res) => {
  try {
    const [oncallEmails, productIssueEmails] = await Promise.all([
      settingsService.getJsonArraySetting("oncall_emails", ["ruiw@agentweb.pro"]),
      settingsService.getJsonArraySetting("product_issue_emails", ["founders@agentweb.pro"]),
    ]);
    res.json({ oncallEmails, productIssueEmails });
  } catch (error: any) {
    console.error("Error getting alert emails:", error);
    res.status(500).json({ message: "Failed to get alert emails" });
  }
});

// Update alert email lists
router.put("/alert-emails", async (req, res) => {
  try {
    const { oncallEmails, productIssueEmails } = req.body;
    const updatedBy = (req as any).user?.email || "unknown";

    if (!Array.isArray(oncallEmails) || !Array.isArray(productIssueEmails)) {
      return res.status(400).json({ message: "oncallEmails and productIssueEmails must be arrays" });
    }

    const allEmails = [...oncallEmails, ...productIssueEmails];
    const invalid = allEmails.filter((e) => typeof e !== "string" || !validateEmail(e));
    if (invalid.length > 0) {
      return res.status(400).json({ message: `Invalid email addresses: ${invalid.join(", ")}` });
    }

    await Promise.all([
      settingsService.setSetting(
        "oncall_emails",
        JSON.stringify(oncallEmails),
        "Oncall alert email recipients",
        updatedBy
      ),
      settingsService.setSetting(
        "product_issue_emails",
        JSON.stringify(productIssueEmails),
        "Product issue / help message email recipients",
        updatedBy
      ),
    ]);

    res.json({ success: true });
  } catch (error: any) {
    console.error("Error updating alert emails:", error);
    res.status(500).json({ message: "Failed to update alert emails" });
  }
});

// ─── Revenue Metrics ─────────────────────────────────────────────────────

router.get("/revenue-metrics", async (req, res) => {
  try {
    const months = parseInt(req.query.months as string) || 24;
    const data = await getRevenueMetrics(Math.min(months, 48));
    res.json(data);
  } catch (error: any) {
    console.error("Error fetching revenue metrics:", error.message);
    res.status(500).json({ message: "Failed to fetch revenue metrics" });
  }
});

// ─── Business Funnel Metrics ─────────────────────────────────────────────

router.get("/funnel-metrics", async (req, res) => {
  try {
    const period = (req.query.period as string) || "30d";
    const channel = (req.query.channel as string) || undefined;
    const data = await getBusinessFunnelMetrics(period, channel);
    res.json(data);
  } catch (error: any) {
    console.error("Error fetching funnel metrics:", error.message);
    res.status(500).json({ message: "Failed to fetch funnel metrics" });
  }
});

// ─── User Activities ──────────────────────────────────────────────────────────

router.get("/users/:userId/activities", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const sessions = await userDb.getUserChatSessions(userId, 30);
    res.json({ sessions });
  } catch (error: any) {
    console.error("Error fetching user activities:", error.message);
    res.status(500).json({ message: "Failed to fetch user activities" });
  }
});

// ─── Sync Stripe subscription status for a single user ───────────────────────

router.post("/users/:userId/sync-stripe", async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    if (!user.stripe_customer_id) {
      return res.status(400).json({ message: "User has no Stripe Customer ID" });
    }
    const updates = await syncSubscriptionFromStripe(userId, user.stripe_customer_id);
    const updatedUser = await userDb.getUserById(userId);
    res.json({ updates, user: updatedUser });
  } catch (error: any) {
    console.error("Error syncing Stripe subscription:", error.message);
    res.status(500).json({ message: "Failed to sync Stripe subscription" });
  }
});

// ─── Resync Subscription Amounts ─────────────────────────────────────────────

router.post("/resync-subscription-amounts", async (req, res) => {
  try {
    const result = await resyncAllSubscriptionAmounts();
    res.json(result);
  } catch (error: any) {
    console.error("Error resyncing subscription amounts:", error.message);
    res.status(500).json({ message: "Failed to resync subscription amounts" });
  }
});

// ── Skill Assignment Admin Routes ─────────────────────────────────────────────

// GET /api/admin/skills/:skillId/assignments — list assignments for a skill
router.get("/skills/:skillId/assignments", async (req, res) => {
  try {
    const { skillAssignmentDb } = await import('../services/skillAssignmentDb');
    const assignments = await skillAssignmentDb.getAssignmentsBySkill(req.params.skillId);
    res.json(assignments);
  } catch (error: any) {
    console.error("Error fetching skill assignments:", error.message);
    res.status(500).json({ message: "Failed to fetch skill assignments" });
  }
});

// Shared validation constants for skill assignment routes
const VALID_ASSIGNMENT_STATUSES = ['active', 'paused', 'completed', 'error'];
const VALID_SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly', 'custom'];

// POST /api/admin/skills/:skillId/assignments — create a new assignment
router.post("/skills/:skillId/assignments", async (req, res) => {
  try {
    const { skillAssignmentDb } = await import('../services/skillAssignmentDb');
    const { userId, status, schedule, nextRunTime, config } = req.body;

    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }

    const effectiveStatus = status || 'active';
    if (!VALID_ASSIGNMENT_STATUSES.includes(effectiveStatus)) {
      return res.status(400).json({ message: `Invalid status: ${effectiveStatus}. Must be one of: ${VALID_ASSIGNMENT_STATUSES.join(', ')}` });
    }

    if (schedule && schedule.frequency && !VALID_SCHEDULE_FREQUENCIES.includes(schedule.frequency)) {
      return res.status(400).json({ message: `Invalid schedule frequency: ${schedule.frequency}. Must be one of: ${VALID_SCHEDULE_FREQUENCIES.join(', ')}` });
    }

    if (nextRunTime && isNaN(Date.parse(nextRunTime))) {
      return res.status(400).json({ message: "Invalid nextRunTime: must be a valid ISO date string" });
    }

    // Check for duplicate assignment (same user + same skill)
    const existing = await skillAssignmentDb.getAssignmentsBySkill(req.params.skillId);
    if (existing.some((a: any) => a.userId === userId)) {
      return res.status(409).json({ message: "User is already assigned to this skill" });
    }

    const assignment = await skillAssignmentDb.createAssignment({
      skillId: req.params.skillId,
      userId,
      status: effectiveStatus,
      schedule,
      nextRunTime,
      config,
    });
    res.status(201).json(assignment);
  } catch (error: any) {
    console.error("Error creating skill assignment:", error.message);
    if (error.message?.includes('required') || error.message?.includes('Invalid')) {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: "Failed to create skill assignment" });
  }
});

// PUT /api/admin/skill-assignments/:assignmentId — update an assignment
router.put("/skill-assignments/:assignmentId", async (req, res) => {
  try {
    const { skillAssignmentDb } = await import('../services/skillAssignmentDb');
    const { status, schedule, nextRunTime, config } = req.body;

    if (status !== undefined && !VALID_ASSIGNMENT_STATUSES.includes(status)) {
      return res.status(400).json({ message: `Invalid status: ${status}. Must be one of: ${VALID_ASSIGNMENT_STATUSES.join(', ')}` });
    }

    if (schedule && schedule.frequency && !VALID_SCHEDULE_FREQUENCIES.includes(schedule.frequency)) {
      return res.status(400).json({ message: `Invalid schedule frequency: ${schedule.frequency}. Must be one of: ${VALID_SCHEDULE_FREQUENCIES.join(', ')}` });
    }

    if (nextRunTime !== undefined && nextRunTime !== null && isNaN(Date.parse(nextRunTime))) {
      return res.status(400).json({ message: "Invalid nextRunTime: must be a valid ISO date string" });
    }

    const existing = await skillAssignmentDb.getAssignment(req.params.assignmentId);
    if (!existing) {
      return res.status(404).json({ message: "Assignment not found" });
    }

    const updated = await skillAssignmentDb.updateAssignment(req.params.assignmentId, {
      ...(status !== undefined && { status }),
      ...(schedule !== undefined && { schedule }),
      ...(nextRunTime !== undefined && { nextRunTime }),
      ...(config !== undefined && { config }),
    });
    res.json(updated);
  } catch (error: any) {
    console.error("Error updating skill assignment:", error.message);
    if (error.message?.includes('Invalid')) {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: "Failed to update skill assignment" });
  }
});

// DELETE /api/admin/skill-assignments/:assignmentId — delete an assignment
router.delete("/skill-assignments/:assignmentId", async (req, res) => {
  try {
    const { skillAssignmentDb } = await import('../services/skillAssignmentDb');

    const existing = await skillAssignmentDb.getAssignment(req.params.assignmentId);
    if (!existing) {
      return res.status(404).json({ message: "Assignment not found" });
    }

    await skillAssignmentDb.deleteAssignment(req.params.assignmentId);
    res.json({ message: "Assignment deleted" });
  } catch (error: any) {
    console.error("Error deleting skill assignment:", error.message);
    res.status(500).json({ message: "Failed to delete skill assignment" });
  }
});

export default router;
