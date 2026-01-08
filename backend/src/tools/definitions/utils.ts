/**
 * Tool Definition Utilities
 * 
 * Functions to derive aggregated data from unified tool definitions.
 * These replace manually-maintained constants like TOOL_CATEGORIES and CATEGORY_KEYWORDS.
 */

import { ToolDefinition, ToolCategory } from '../types';
import { CategoryConfig } from '../types/CategoryConfig';
import { SimpleHandlerConfig } from '../HandlerFactory';

/**
 * All category configs (populated by category modules)
 */
const categoryConfigs: Map<ToolCategory, CategoryConfig> = new Map();

/**
 * Register a category config
 */
export function registerCategoryConfig(config: CategoryConfig): void {
  categoryConfigs.set(config.name, config);
}

/**
 * Get all registered category configs
 */
export function getAllCategoryConfigs(): CategoryConfig[] {
  return Array.from(categoryConfigs.values());
}

/**
 * Get a specific category config
 */
export function getCategoryConfig(category: ToolCategory): CategoryConfig | undefined {
  return categoryConfigs.get(category);
}

/**
 * Derive TOOL_CATEGORIES from tool definitions
 * Maps category -> array of tool names
 */
export function deriveToolCategories(
  tools: ToolDefinition[]
): Record<ToolCategory, string[]> {
  const categories: Record<string, string[]> = {};
  
  for (const tool of tools) {
    if (!categories[tool.category]) {
      categories[tool.category] = [];
    }
    categories[tool.category].push(tool.name);
  }
  
  return categories as Record<ToolCategory, string[]>;
}

/**
 * Derive CATEGORY_KEYWORDS from tool definitions and category configs
 * Combines category-level keywords with tool-level intentKeywords
 */
export function deriveCategoryKeywords(
  tools: ToolDefinition[]
): Record<string, string[]> {
  const keywords: Record<string, Set<string>> = {};
  
  // First, add keywords from category configs
  for (const config of categoryConfigs.values()) {
    keywords[config.name] = new Set(config.categoryKeywords);
  }
  
  // Then, add keywords from individual tools
  for (const tool of tools) {
    if (!keywords[tool.category]) {
      keywords[tool.category] = new Set();
    }
    
    if (tool.intentKeywords) {
      for (const keyword of tool.intentKeywords) {
        keywords[tool.category].add(keyword);
      }
    }
  }
  
  // Convert Sets to arrays
  const result: Record<string, string[]> = {};
  for (const [category, keywordSet] of Object.entries(keywords)) {
    result[category] = Array.from(keywordSet);
  }
  
  return result;
}

/**
 * Derive CATEGORY_INTENT_PATTERNS from category configs
 */
export function deriveCategoryIntentPatterns(): Record<ToolCategory, RegExp[]> {
  const patterns: Record<string, RegExp[]> = {};
  
  for (const config of categoryConfigs.values()) {
    patterns[config.name] = config.intentPatterns;
  }
  
  return patterns as Record<ToolCategory, RegExp[]>;
}

/**
 * Derive handler configs from tool definitions
 * Generates SimpleHandlerConfig[] compatible with existing ToolExecutor
 */
export function deriveHandlerConfigs(
  tools: ToolDefinition[]
): SimpleHandlerConfig[] {
  const configs: SimpleHandlerConfig[] = [];
  
  for (const tool of tools) {
    // Skip tools without handler config or with special handlers
    if (!tool.handler || tool.handler.specialHandler) {
      continue;
    }
    
    const handlerConfig = toSimpleHandlerConfig(tool);
    if (handlerConfig) {
      configs.push(handlerConfig);
    }
  }
  
  return configs;
}

/**
 * Convert a unified ToolDefinition to SimpleHandlerConfig
 * Maintains backward compatibility with existing ToolExecutor
 */
export function toSimpleHandlerConfig(tool: ToolDefinition): SimpleHandlerConfig | null {
  const { handler, schema } = tool;
  
  if (!handler?.methodName) {
    return null;
  }
  
  let argOrder: string[];
  
  if (handler.customArgOrder) {
    // Use explicit custom ordering
    argOrder = handler.customArgOrder;
  } else {
    // Derive from schema properties + context args
    const schemaArgs = Object.keys(schema.parameters.properties || {})
      .map(key => `args.${key}`);
    
    const contextArgs = (handler.contextArgs || [])
      .map(arg => `context.${arg}`);
    
    argOrder = [...schemaArgs, ...contextArgs];
  }
  
  return {
    name: tool.name,
    serviceName: handler.serviceName,
    methodName: handler.methodName,
    argOrder
  };
}

/**
 * Validate that all tools have required handler configs
 * Useful for migration validation
 */
export function validateToolDefinitions(tools: ToolDefinition[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  
  for (const tool of tools) {
    // Check for handler config (will be required after migration)
    if (!tool.handler) {
      errors.push(`Tool '${tool.name}' missing handler config`);
    } else if (!tool.handler.methodName) {
      errors.push(`Tool '${tool.name}' missing handler.methodName`);
    }
    
    // Check for duplicate tool names
    const duplicates = tools.filter(t => t.name === tool.name);
    if (duplicates.length > 1) {
      errors.push(`Duplicate tool name: '${tool.name}'`);
    }
    
    // Validate required params are in properties
    const required = tool.schema.parameters.required || [];
    const properties = Object.keys(tool.schema.parameters.properties || {});
    for (const req of required) {
      if (!properties.includes(req)) {
        errors.push(`Tool '${tool.name}': required param '${req}' not in properties`);
      }
    }
  }
  
  // Deduplicate errors
  const uniqueErrors = [...new Set(errors)];
  
  return {
    valid: uniqueErrors.length === 0,
    errors: uniqueErrors
  };
}
