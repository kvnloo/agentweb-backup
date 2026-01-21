import { settingsService } from "./settingsService";
import { userDb } from "./db";
import { CUSTOMER_PORTAL_PAGES } from "./customerPortalPages";

export interface SubscriptionType {
  name: string;
  allowedPages: string[]; // Array of page paths (e.g., ["/marketing/research", "/marketing/blog"]) or ["*"] for all
  allowedFunctionCalls: string[]; // Array of function names (e.g., ["create_task_from_template", "search_web"]) or ["*"] for all
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
          allowedFunctionCalls: await getAllAvailableFunctionCalls(), // All available function calls (expanded)
        };
      }
      return null;
    }

    const subscriptionType = subscriptionTypes.find(
      (type) => type.name === subscriptionTypeName
    );

    if (!subscriptionType) {
      return null;
    }

    // Normalize paths: remove "/marketing" prefix from allowedPages
    return {
      ...subscriptionType,
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
      .filter((tool: any) => tool.type === "function")
      .map((tool: any) => tool.function?.name)
      .filter((name: string) => name); // Filter out undefined/null
  } catch (error) {
    console.error("Error getting all available function calls:", error);
    return [];
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
 * Get allowed function calls for a user based on their subscription type
 * Returns the actual list of function calls or ["*"] for all
 */
export async function getAllowedFunctionCalls(
  userId: string
): Promise<string[]> {
  try {
    const subscriptionTypeName = await getUserSubscriptionType(userId);
    const subscriptionType = await getSubscriptionTypeConfig(subscriptionTypeName);

    if (!subscriptionType) {
      // If subscription type not found, return wildcard for all
      return ["*"];
    }

    // If all functions are allowed, return wildcard
    if (
      subscriptionType.allowedFunctionCalls.includes("*") ||
      subscriptionType.allowedFunctionCalls.length === 0
    ) {
      return ["*"];
    }

    return subscriptionType.allowedFunctionCalls;
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