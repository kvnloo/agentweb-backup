/**
 * Tool Definitions Index
 * 
 * Barrel export for all tool definitions and registration helper.
 * 
 * This is the SINGLE SOURCE OF TRUTH for:
 * - All tool definitions
 * - Category configurations
 * - Derived data (tool categories, keywords, handler configs)
 */

import { ToolDefinition, ToolCategory } from '../types';
import { ToolRegistry } from '../ToolRegistry';

// Import utility functions
import {
  deriveToolCategories,
  deriveCategoryKeywords,
  deriveCategoryIntentPatterns,
  deriveHandlerConfigs,
  getAllCategoryConfigs,
  validateToolDefinitions
} from './utils';

// Import all tool definition modules (they self-register their category configs)
import { coreTools, coreCategory } from './coreTools';
import { contentTools, contentCategory } from './contentTools';
import { researchTools, researchCategory } from './researchTools';
import { crmTools, crmCategory } from './crmTools';
import { gtmTools, gtmCategory } from './gtmTools';
import { analyticsTools, analyticsCategory } from './analyticsTools';
import { automationTools, automationCategory } from './automationTools';
import { bookTools, booksCategory } from './bookTools';
import { templateTools, templatesCategory } from './templateTools';

// Re-export all tool definitions
export {
  coreTools,
  contentTools,
  researchTools,
  crmTools,
  gtmTools,
  analyticsTools,
  automationTools,
  bookTools,
  templateTools
};

// Re-export category configs
export {
  coreCategory,
  contentCategory,
  researchCategory,
  crmCategory,
  gtmCategory,
  analyticsCategory,
  automationCategory,
  booksCategory,
  templatesCategory
};

/**
 * All tool definitions combined
 */
export const allToolDefinitions: ToolDefinition[] = [
  ...coreTools,
  ...contentTools,
  ...researchTools,
  ...crmTools,
  ...gtmTools,
  ...analyticsTools,
  ...automationTools,
  ...bookTools,
  ...templateTools
];

/**
 * All category configs
 */
export const allCategoryConfigs = getAllCategoryConfigs();

/**
 * DERIVED: Tool categories mapping (replaces manually-maintained TOOL_CATEGORIES)
 * Maps category name -> array of tool names
 */
export const DERIVED_TOOL_CATEGORIES = deriveToolCategories(allToolDefinitions);

/**
 * DERIVED: Category keywords (replaces manually-maintained CATEGORY_KEYWORDS)
 * Combines category-level keywords with tool-level intentKeywords
 */
export const DERIVED_CATEGORY_KEYWORDS = deriveCategoryKeywords(allToolDefinitions);

/**
 * DERIVED: Category intent patterns (replaces manually-maintained CATEGORY_INTENT_PATTERNS)
 */
export const DERIVED_CATEGORY_INTENT_PATTERNS = deriveCategoryIntentPatterns();

/**
 * DERIVED: Handler configs (replaces manually-maintained configs in handlers/configs.ts)
 * Only includes tools with simple handlers (not special handlers)
 */
export const DERIVED_HANDLER_CONFIGS = deriveHandlerConfigs(allToolDefinitions);

/**
 * Register all tools with a registry
 */
export function registerAllTools(registry: ToolRegistry): void {
  registry.registerAll(allToolDefinitions);
}

/**
 * Get tool count by category
 */
export function getToolCountByCategory(): Record<string, number> {
  return {
    core: coreTools.length,
    content: contentTools.length,
    research: researchTools.length,
    crm: crmTools.length,
    gtm: gtmTools.length,
    analytics: analyticsTools.length,
    automation: automationTools.length,
    books: bookTools.length,
    templates: templateTools.length,
    total: allToolDefinitions.length
  };
}

/**
 * Validate all tool definitions
 * Call this during startup to catch configuration errors early
 */
export function validateAllTools(): { valid: boolean; errors: string[] } {
  return validateToolDefinitions(allToolDefinitions);
}

// Re-export utility functions
export {
  deriveToolCategories,
  deriveCategoryKeywords,
  deriveCategoryIntentPatterns,
  deriveHandlerConfigs,
  validateToolDefinitions
} from './utils';
