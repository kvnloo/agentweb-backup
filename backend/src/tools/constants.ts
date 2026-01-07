/**
 * Tool System Constants
 * 
 * Extracted magic numbers for maintainability and consistency.
 */

/** Default timeout for tool execution (5 minutes) */
export const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60 * 1000;

/** Cache TTL for subscription tool permissions (5 minutes) */
export const SUBSCRIPTION_CACHE_TTL_MS = 5 * 60 * 1000;

/** Cache cleanup interval (1 minute) */
export const CACHE_CLEANUP_INTERVAL_MS = 60 * 1000;

/** Maximum LLM iterations per request */
export const MAX_LLM_ITERATIONS = 20;
