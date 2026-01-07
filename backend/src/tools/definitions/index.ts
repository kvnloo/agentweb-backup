/**
 * Tool Definitions Index
 * 
 * Barrel export for all tool definitions and registration helper.
 */

import { ToolDefinition } from '../types';
import { ToolRegistry } from '../ToolRegistry';

// Import all tool definition modules
import { coreTools } from './coreTools';
import { contentTools } from './contentTools';
import { researchTools } from './researchTools';
import { crmTools } from './crmTools';
import { gtmTools } from './gtmTools';
import { analyticsTools } from './analyticsTools';
import { automationTools } from './automationTools';
import { bookTools } from './bookTools';
import { templateTools } from './templateTools';

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
