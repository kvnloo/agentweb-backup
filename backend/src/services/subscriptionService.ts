import { settingsService } from "./settingsService";
import { userDb, orgDb } from "./db";
import { CUSTOMER_PORTAL_PAGES } from "./customerPortalPages";
import { skillService } from "./skillService";

export interface SubscriptionType {
  name: string;
  allowedPages: string[]; // Array of page paths (e.g., ["/marketing/research", "/marketing/blog"]) or ["*"] for all
  hiddenPages?: string[]; // Array of page paths to hide entirely (not shown as locked); subset of pages not in allowedPages
  allowedSkills: string[]; // Array of skill IDs (e.g., ["skill-uuid-1", "skill-uuid-2"]) or ["*"] for all
  allowedConnectedAccounts?: string[]; // Array of platform types (e.g., ["linkedin", "gmail"]) or ["*"] for all; undefined = all
  allowedFunctionCalls?: string[]; // Deprecated — kept for on-read migration from old configs
  monthlyTokenAllowance?: number | null; // Monthly token limit; null/undefined = unlimited
  monthlyExtraCostAllowance?: number | null; // Monthly extra API cost limit in USD (enrichment, etc.); null/undefined = unlimited
}

// Default pages that are always available regardless of subscription type
// These match the routes in customer-portal/src/App.tsx
export const DEFAULT_PAGES = [
  "/", // Agent Mode home
  "/agent-mode", // Agent Mode
  "/settings", // Settings page
  "/guide", // User Guide
];

// ─── Tier Fallback ──────────────────────────────────────────────────────
// The canonical tier definitions now live in DynamoDB (admin-managed via
// the "subscription_types" setting).  getSubscriptionTypeConfig() reads
// them.  The constant below is only used as a last-resort fallback when
// the DB config cannot be reached (e.g. during initial bootstrap).

const FREE_TIER_FALLBACK: SubscriptionType = {
  name: "Free",
  allowedPages: [...DEFAULT_PAGES],
  allowedSkills: [], // No premium skills on Free tier
};

/**
 * Get tier configuration by name — reads from DynamoDB first, falls back
 * to a minimal Free config if the DB is unreachable or the tier is not
 * defined.  Replaces the old hardcoded TIER_CONFIGS / getDefaultTierConfig.
 */
export async function getTierConfig(tierName: string): Promise<SubscriptionType | null> {
  const dbConfig = await getSubscriptionTypeConfig(tierName);
  if (dbConfig) return dbConfig;

  // Graceful fallback: only Free tier has a built-in fallback
  if (tierName === "Free") return { ...FREE_TIER_FALLBACK };

  return null;
}

/**
 * Get subscription type for a user (defaults to "Free" if not set)
 */
export async function getUserSubscriptionType(userId: string): Promise<string> {
  try {
    const user = await userDb.getUserById(userId);
    // Org members inherit the org owner's tier dynamically — the org's effective
    // tier is whatever the owner currently holds (orgs carry no tier field).
    // Resolving at read time (instead of snapshotting the owner's tier onto the
    // member on invite-accept) keeps members in sync when the owner up/downgrades
    // and automatically revokes access the moment they leave the org (orgId/
    // orgRole are cleared on leave/remove). This is the ENG-288 root cause: the
    // /me endpoint already resolved a member's tier from the owner, but the
    // member-id call sites (agent mode, Emma) read the member's own record.
    // A member riding their own active/trialing Stripe subscription is not
    // riding the org's — accepting an invite touches no billing state (see
    // routes/org.ts accept-invite), so a member can independently pay for a
    // tier that differs from their owner's. Only resolve to the owner when
    // the member has no live subscription of their own; otherwise their own
    // tier governs (matches the "active"/"trialing" = entitling convention
    // already used throughout stripeService.ts).
    const hasOwnActiveSubscription =
      user?.subscription_status === "active" || user?.subscription_status === "trialing";
    if (user?.orgId && user.orgRole === "member" && !hasOwnActiveSubscription && orgDb?.getOrgById) {
      // Isolated from the outer catch: a transient failure resolving the org
      // (network blip, throttling) must fall back to the user's own already-
      // fetched tier, not the hard "Free" default — we have real user data in
      // hand at this point, discarding it on an unrelated lookup failure would
      // wrongly downgrade a paying member for the duration of the blip.
      try {
        const org = await orgDb.getOrgById(user.orgId);
        if (org?.ownerUserId && org.ownerUserId !== userId) {
          // Reads the owner's raw stored field directly, not resolved
          // recursively through this same function — the owner's
          // subscriptionType is the canonical source of truth for what the
          // org pays for (kept in sync by Stripe webhooks / admin panel
          // writes, not by this resolution logic), and an org owner can't
          // themselves be a member of another org (see routes/org.ts create),
          // so there is no owner-of-owner chain to walk. A stale owner field
          // (e.g. their own Stripe sub canceled but subscriptionType wasn't
          // updated) would propagate as-is — an accepted limitation of the
          // current data model, not something this function can detect.
          const owner = await userDb.getUserById(org.ownerUserId);
          return owner?.subscriptionType || "Free";
        }
      } catch (orgLookupError) {
        console.error("Error resolving org owner for subscription type:", orgLookupError);
      }
    }
    return user?.subscriptionType || "Free";
  } catch (error) {
    console.error("Error getting user subscription type:", error);
    return "Free";
  }
}

/**
 * Get subscription type configuration
 */
export async function getSubscriptionTypeConfig(
  subscriptionTypeName: string
): Promise<SubscriptionType | null> {
  try {
    const setting = await settingsService.getSetting("subscription_types");
    let subscriptionTypes: SubscriptionType[] = [];

    if (setting) {
      try {
        subscriptionTypes = JSON.parse(setting.settingValue);
      } catch (error) {
        console.error("Error parsing subscription types:", error);
        return null;
      }
    }

    // If no subscription types defined, return built-in fallbacks
    if (subscriptionTypes.length === 0) {
      if (subscriptionTypeName === "Free") {
        return { ...FREE_TIER_FALLBACK };
      }
      // Legacy: users stored as "Basic" before tier system was introduced get full access
      if (subscriptionTypeName === "Basic") {
        return {
          name: "Basic",
          allowedPages: getAllAvailablePages(),
          allowedSkills: ["*"],
        };
      }
      return null;
    }

    const subscriptionType = subscriptionTypes.find(
      (type: any) => type.name === subscriptionTypeName
    );

    if (!subscriptionType) {
      return null;
    }

    // Backward compatibility: if config has allowedFunctionCalls but no allowedSkills,
    // treat as all skills allowed (wildcard)
    const allowedSkills = subscriptionType.allowedSkills || ["*"];

    // Normalize paths: remove "/marketing" prefix from allowedPages
    return {
      ...subscriptionType,
      allowedSkills,
      allowedPages: subscriptionType.allowedPages.map((page: string) => {
        if (page.startsWith('/marketing/')) {
          return page.replace('/marketing', '');
        }
        return page;
      })
    };
  } catch (error) {
    console.error("Error getting subscription type config:", error);
    return null;
  }
}


/**
 * ENG-173 publish guardrail: determine whether a skill is reachable by any user.
 *
 * A published skill is invisible to a non-wildcard user unless its skillId appears
 * in that user's subscription tier's `allowedSkills` — so a skill published without
 * being added to any tier's allow-list is entitled to nobody. This reads the same
 * `subscription_types` setting the runtime filter uses and reports which tiers (if any)
 * allow the skill. Fails OPEN (reachable=true) when no tier config exists, mirroring
 * getAllowedSkills' default-allow behavior so absent config never raises a false alarm.
 */
export async function findTiersAllowingSkill(
  skillId: string
): Promise<{ reachable: boolean; allowingTiers: string[]; totalTiers: number }> {
  try {
    const setting = await settingsService.getSetting("subscription_types");
    if (!setting) {
      return { reachable: true, allowingTiers: [], totalTiers: 0 };
    }

    let tiers: SubscriptionType[] = [];
    try {
      tiers = JSON.parse(setting.settingValue);
    } catch (error) {
      console.error("Error parsing subscription types:", error);
      return { reachable: true, allowingTiers: [], totalTiers: 0 };
    }

    if (tiers.length === 0) {
      return { reachable: true, allowingTiers: [], totalTiers: 0 };
    }

    const allowingTiers = tiers
      .filter((tier: any) => {
        // Backward compat: a tier without allowedSkills is treated as wildcard.
        const allowedSkills: string[] = tier.allowedSkills || ["*"];
        return allowedSkills.includes("*") || allowedSkills.includes(skillId);
      })
      .map((tier: any) => tier.name);

    return {
      reachable: allowingTiers.length > 0,
      allowingTiers,
      totalTiers: tiers.length,
    };
  } catch (error) {
    console.error("Error checking tiers for skill:", error);
    return { reachable: true, allowingTiers: [], totalTiers: 0 };
  }
}

/**
 * Get all available function calls from agent mode service
 */
export async function getAllAvailableFunctionCalls(): Promise<string[]> {
  try {
    const { agentModeService } = await import("./agentModeService");
    const tools = agentModeService.getAvailableTools();
    return tools
      .filter((tool: any) => tool?.type === "function" && tool?.function?.name)
      .map((tool: any) => tool.function?.name)
      .filter((name: string) => name); // Filter out undefined/null
  } catch (error) {
    console.error("Error getting all available function calls:", error);
    return [];
  }
}

/**
 * Get all available skills (published skill IDs + __other_skills__ virtual entry)
 * Used by admin UI to populate skill selection checkboxes
 */
export async function getAllAvailableSkills(): Promise<string[]> {
  try {
    const publishedSkills = await skillService.getPublishedSkills();
    const skillIds = publishedSkills.map((s) => s.skillId);
    return [...skillIds, "__other_skills__"];
  } catch (error) {
    console.error("Error getting all available skills:", error);
    return [];
  }
}

/**
 * Get allowed skill IDs for a user based on their subscription type.
 * Anonymous users (anon_*) use the public allowed skills config.
 * Returns the actual list of skill IDs or ["*"] for all.
 */
export async function getAllowedSkills(userId: string): Promise<string[]> {
  try {
    // Anonymous/public users use the public skills config
    if (userId.startsWith("anon_")) {
      return getPublicAllowedSkills();
    }

    const subscriptionTypeName = await getUserSubscriptionType(userId);
    const subscriptionType = await getSubscriptionTypeConfig(subscriptionTypeName);

    if (!subscriptionType) {
      // If subscription type not found, return wildcard for all
      return ["*"];
    }

    // If all skills are allowed, return wildcard
    if (
      subscriptionType.allowedSkills.includes("*") ||
      subscriptionType.allowedSkills.length === 0
    ) {
      return ["*"];
    }

    return subscriptionType.allowedSkills;
  } catch (error) {
    console.error("Error getting allowed skills:", error);
    // Default to allowing all skills on error
    return ["*"];
  }
}

/**
 * Resolve skill IDs to their constituent tool names
 * For __other_skills__, returns tools not associated with any published skill
 * Returns ["*"] if input contains "*"
 */
export async function resolveSkillsToToolNames(skillIds: string[]): Promise<string[]> {
  try {
    if (skillIds.includes("*")) {
      return ["*"];
    }

    const publishedSkills = await skillService.getPublishedSkills();
    const toolNames = new Set<string>();

    for (const skillId of skillIds) {
      if (skillId === "__other_skills__") {
        // Get tools not associated with any published skill
        const { agentModeService } = await import("./agentModeService");
        const unassociatedTools = agentModeService.getUnassociatedToolNames(publishedSkills);
        unassociatedTools.forEach((name: string) => toolNames.add(name));
      } else {
        const skill = publishedSkills.find((s) => s.skillId === skillId);
        if (skill?.toolNames) {
          skill.toolNames.forEach((t: string) => toolNames.add(t));
        }
      }
    }

    return Array.from(toolNames);
  } catch (error) {
    console.error("Error resolving skills to tool names:", error);
    return ["*"];
  }
}

/**
 * Get allowed skill IDs for public/anonymous users.
 * Reads from the "public_allowed_skills" setting.
 * Returns ["*"] (all skills) if no setting exists.
 */
export async function getPublicAllowedSkills(): Promise<string[]> {
  try {
    const setting = await settingsService.getSetting("public_allowed_skills");
    if (setting) {
      const skills = JSON.parse(setting.settingValue);
      if (Array.isArray(skills)) {
        return skills;
      }
    }
    // Default: no skills available to public
    return [];
  } catch (error) {
    console.error("Error getting public allowed skills:", error);
    return [];
  }
}

/**
 * All connected account platform types that can be gated per subscription.
 * "instagram" is a separate UI entry even though it uses the "meta" OAuth flow.
 */
export function getAllAvailableConnectedAccounts(): string[] {
  return ['linkedin', 'unipile', 'meta', 'gmail', 'outlook', 'youtube', 'fathom', 'instagram', 'twitter', 'hubspot', 'attio', 'google_ads', 'google_drive'];
}

/**
 * Get allowed connected account platforms for a user based on their subscription type.
 * Returns the actual list of platform strings.
 */
export async function getAllowedConnectedAccounts(userId: string): Promise<string[]> {
  try {
    const subscriptionTypeName = await getUserSubscriptionType(userId);
    const subscriptionType = await getSubscriptionTypeConfig(subscriptionTypeName);

    if (!subscriptionType) {
      return getAllAvailableConnectedAccounts();
    }

    const allowed = subscriptionType.allowedConnectedAccounts;
    if (!allowed || allowed.includes('*') || allowed.length === 0) {
      return getAllAvailableConnectedAccounts();
    }

    return allowed;
  } catch (error) {
    console.error('Error getting allowed connected accounts:', error);
    return getAllAvailableConnectedAccounts();
  }
}

/**
 * Get all available customer portal pages
 */
export function getAllAvailablePages(): string[] {
  // Include default pages plus all customer portal pages
  const defaultPages = ["/", "/agent-mode", "/settings", "/guide"];
  const customerPages = CUSTOMER_PORTAL_PAGES.map((page) => page.path);
  return [...defaultPages, ...customerPages];
}

/**
 * Get hidden pages for a user based on their subscription type.
 * Hidden pages are not shown at all in the sidebar (not even as locked/upgrade prompts).
 */
export async function getHiddenPages(userId: string): Promise<string[]> {
  try {
    const subscriptionTypeName = await getUserSubscriptionType(userId);
    const subscriptionType = await getSubscriptionTypeConfig(subscriptionTypeName);

    if (!subscriptionType || !subscriptionType.hiddenPages) {
      return [];
    }

    return subscriptionType.hiddenPages;
  } catch (error) {
    console.error("Error getting hidden pages:", error);
    return [];
  }
}

/**
 * Get allowed function calls for a user based on their subscription type.
 * Bridge function: resolves the user's allowed skills to individual tool names.
 * Keeps the same signature so existing callers (agentModeController.ts scheduled chat,
 * function-calls endpoint) continue to work unchanged.
 */
export async function getAllowedFunctionCalls(
  userId: string
): Promise<string[]> {
  try {
    const allowedSkillIds = await getAllowedSkills(userId);
    return resolveSkillsToToolNames(allowedSkillIds);
  } catch (error) {
    console.error("Error getting allowed function calls:", error);
    // Default to allowing all functions on error
    return ["*"];
  }
}

/**
 * Get allowed pages for a user based on their subscription type
 * Returns the actual list of pages (expands "*" to all available)
 */
export async function getAllowedPages(userId: string): Promise<string[]> {
  try {
    const subscriptionTypeName = await getUserSubscriptionType(userId);
    const subscriptionType = await getSubscriptionTypeConfig(subscriptionTypeName);

    if (!subscriptionType) {
      // If subscription type not found, return all available pages
      return getAllAvailablePages();
    }

    // If all pages are allowed, return all available pages
    if (
      subscriptionType.allowedPages.includes("*") ||
      subscriptionType.allowedPages.length === 0
    ) {
      return getAllAvailablePages();
    }

    // Return normalized pages (remove "/marketing" prefix if present)
    return subscriptionType.allowedPages.map((page: string) => {
      if (page.startsWith('/marketing/')) {
        return page.replace('/marketing', '');
      }
      return page;
    });
  } catch (error) {
    console.error("Error getting allowed pages:", error);
    // Default to allowing all pages on error
    return getAllAvailablePages();
  }
}

/**
 * Filter function calls based on subscription type
 */
export function filterFunctionCalls(
  allFunctionCalls: any[],
  allowedFunctionCalls: string[]
): any[] {
  // If wildcard is present, return all tools
  if (allowedFunctionCalls.includes("*")) {
    return allFunctionCalls;
  }

  // Filter function calls
  return allFunctionCalls.filter((tool) => {
    if (tool.type !== "function") return true;
    const functionName = tool.function?.name;
    if (!functionName) return true;
    return allowedFunctionCalls.includes(functionName);
  });
}
