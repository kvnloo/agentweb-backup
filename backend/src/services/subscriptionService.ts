import { settingsService } from "./settingsService";
import { userDb } from "./db";
import { CUSTOMER_PORTAL_PAGES } from "./customerPortalPages";
import { skillService } from "./skillService";

export interface SubscriptionType {
  name: string;
  allowedPages: string[]; // Array of page paths (e.g., ["/marketing/research", "/marketing/blog"]) or ["*"] for all
  allowedSkills: string[]; // Array of skill IDs (e.g., ["skill-uuid-1", "skill-uuid-2"]) or ["*"] for all
  allowedFunctionCalls?: string[]; // Deprecated — kept for on-read migration from old configs
}

// Default pages that are always available regardless of subscription type
// These match the routes in customer-portal/src/App.tsx
const DEFAULT_PAGES = [
  "/", // Agent Mode home
  "/agent-mode", // Agent Mode
  "/settings", // Settings page
  "/guide", // User Guide
];

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
 * Get allowed skill IDs for a user based on their subscription type
 * Returns the actual list of skill IDs or ["*"] for all
 */
export async function getAllowedSkills(userId: string): Promise<string[]> {
  try {
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
 * Get all available customer portal pages
 */
export function getAllAvailablePages(): string[] {
  // Include default pages plus all customer portal pages
  const defaultPages = ["/", "/agent-mode", "/settings", "/guide"];
  const customerPages = CUSTOMER_PORTAL_PAGES.map((page) => page.path);
  return [...defaultPages, ...customerPages];
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
