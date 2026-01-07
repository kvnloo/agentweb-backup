/**
 * Subscription Tool Filter
 * 
 * Bridges the subscriptionService with the new ToolRegistry/ToolSelector.
 * Fetches allowed tools from database based on user's subscription tier.
 */

import { getAllowedFunctionCalls, getUserSubscriptionType } from '../services/subscriptionService';
import { ToolDefinition } from './types';

/**
 * Cache for subscription tool permissions
 * Reduces DB calls for frequently accessed data
 */
interface SubscriptionCache {
  allowedTools: string[];
  timestamp: number;
}

const subscriptionCache = new Map<string, SubscriptionCache>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

/**
 * Safe fallback tools when DB lookup fails (core tools only)
 * Security: Prevents granting all tools on error
 */
const FALLBACK_TOOLS_ON_ERROR = [
  'search_web',
  'read_file_content',
  'describe_image',
  'save_file',
  'read_page_source'
];

/**
 * Periodic cache cleanup to prevent memory leaks
 * Removes expired entries every minute
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of subscriptionCache.entries()) {
    if (now - value.timestamp >= CACHE_TTL_MS) {
      subscriptionCache.delete(key);
    }
  }
}, CLEANUP_INTERVAL_MS);

/**
 * Get allowed tools for a user from the database.
 * Uses caching to reduce DB load with automatic cache cleanup.
 * 
 * @param userId - The user ID to get allowed tools for
 * @returns Array of allowed tool names, or fallback core tools on error
 * 
 * @example
 * ```typescript
 * const allowedTools = await getAllowedToolsForUser('user-123');
 * console.log(allowedTools); // ['search_web', 'create_blog_article', ...]
 * ```
 */
export async function getAllowedToolsForUser(userId: string): Promise<string[]> {
  // Check cache first
  const cached = subscriptionCache.get(userId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.allowedTools;
  }

  try {
    // Fetch from subscriptionService (which reads from DB)
    const allowedTools = await getAllowedFunctionCalls(userId);
    
    // Cache the result
    subscriptionCache.set(userId, {
      allowedTools,
      timestamp: Date.now()
    });

    return allowedTools;
  } catch (error) {
    console.error('SubscriptionToolFilter: Error fetching allowed tools:', error);
    // On error, return restrictive fallback (core tools only) for security
    return FALLBACK_TOOLS_ON_ERROR;
  }
}

/**
 * Get user's subscription type name
 */
export async function getUserSubscriptionTier(userId: string): Promise<string> {
  try {
    return await getUserSubscriptionType(userId);
  } catch (error) {
    console.error('SubscriptionToolFilter: Error fetching subscription type:', error);
    return 'Basic';
  }
}

/**
 * Filter tools based on user's subscription (from DB)
 */
export async function filterToolsBySubscription(
  tools: ToolDefinition[],
  userId: string
): Promise<ToolDefinition[]> {
  const allowedTools = await getAllowedToolsForUser(userId);
  
  // If no restrictions (empty array or '*'), return all tools
  if (allowedTools.length === 0 || allowedTools.includes('*')) {
    return tools;
  }

  // Filter tools to only those allowed
  return tools.filter(tool => allowedTools.includes(tool.name));
}

/**
 * Check if a specific tool is allowed for a user
 */
export async function isToolAllowedForUser(
  toolName: string,
  userId: string
): Promise<boolean> {
  const allowedTools = await getAllowedToolsForUser(userId);
  
  // If no restrictions, allow all
  if (allowedTools.length === 0 || allowedTools.includes('*')) {
    return true;
  }

  return allowedTools.includes(toolName);
}

/**
 * Clear cache for a specific user (call when subscription changes)
 */
export function clearSubscriptionCache(userId?: string): void {
  if (userId) {
    subscriptionCache.delete(userId);
  } else {
    subscriptionCache.clear();
  }
}

/**
 * Get cache stats for monitoring
 */
export function getSubscriptionCacheStats(): { size: number; entries: string[] } {
  return {
    size: subscriptionCache.size,
    entries: Array.from(subscriptionCache.keys())
  };
}
