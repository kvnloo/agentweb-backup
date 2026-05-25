import { settingsService } from "./settingsService";
import { userDb } from "./db";
import { CUSTOMER_PORTAL_PAGES } from "./customerPortalPages";
import { skillService } from "./skillService";

export interface SubscriptionType {
  name: string;
  allowedPages: string[]; // Array of page paths (e.g., ["/marketing/research", "/marketing/blog"]) or ["*"] for all
  hiddenPages?: string[]; // Array of page paths to hide entirely (not shown as locked); subset of pages not in allowedPages
  allowedSkills: string[]; // Array of skill IDs (e.g., ["skill-uuid-1", "skill-uuid-2"]) or ["*"] for all
  allowedConnectedAccounts?: string[]; // Array of platform types (e.g., ["linkedin", "gmail"]) or ["*"] for all; undefined = all
  allowedFunctionCalls?: string[]; // Deprecated — kept for on-read migration from old configs
  allowedFeatures?: string[]; // e.g., ["custom-domain"] or ["*"] for all
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
 * Get subscription type for a user (defaults to "Basic" if not set)
 */
export async function getUserSubscriptionType(userId: string): Promise<string> {
  try {
    const user = await userDb.getUserById(userId);
    return user?.subscriptionType || "Basic";
  } catch (error) {
    console.error("Error getting user subscription type:", error);
    return "Basic";
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

    // If no subscription types defined, return default Basic type with actual lists
    if (subscriptionTypes.length === 0) {
      if (subscriptionTypeName === "Basic") {
        return {
          name: "Basic",
          allowedPages: getAllAvailablePages(), // All available pages (expanded)
          allowedSkills: ["*"], // All skills allowed by default
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
  return ['linkedin', 'unipile', 'meta', 'gmail', 'youtube', 'fathom', 'instagram', 'hubspot', 'attio'];
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

/**
 * Get allowed feature flags for a user based on their subscription tier.
 * Returns the raw array from tier config; ["*"] means "all features."
 * Defaults to [] when no tier or no allowedFeatures (default-deny).
 */
export async function getAllowedFeatures(userId: string): Promise<string[]> {
  try {
    const tierName = await getUserSubscriptionType(userId);
    const tier = await getSubscriptionTypeConfig(tierName);
    return tier?.allowedFeatures || [];
  } catch (error) {
    console.error("Error getting allowed features:", error);
    return [];
  }
}

/**
 * Check whether a user's subscription tier grants a specific feature flag.
 * Honors the "*" wildcard.
 */
export async function userHasFeature(userId: string, feature: string): Promise<boolean> {
  const features = await getAllowedFeatures(userId);
  return features.includes("*") || features.includes(feature);
}
