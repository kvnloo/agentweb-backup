/**
 * Tool Categories Configuration
 * 
 * Maps tool names to categories and defines intent patterns for
 * automatic category detection from user messages.
 * 
 * CONSOLIDATED: This file now uses DERIVED data from tool definitions
 * instead of manually-maintained constants.
 */

import { ToolCategory } from './ToolDefinition';
import { detectCategoriesWithFuzzyMatching } from './FuzzyMatcher';

// Import derived data from the single source of truth
import {
  DERIVED_TOOL_CATEGORIES,
  DERIVED_CATEGORY_INTENT_PATTERNS
} from '../definitions';

/**
 * Tool category mappings - which tools belong to which category
 * NOW DERIVED from tool definitions (no manual maintenance needed)
 * 
 * @deprecated Use DERIVED_TOOL_CATEGORIES directly from definitions
 */
export const TOOL_CATEGORIES: Record<ToolCategory, string[]> = DERIVED_TOOL_CATEGORIES;

/**
 * Intent patterns for detecting category from user message
 * NOW DERIVED from category configs (no manual maintenance needed)
 * 
 * @deprecated Use DERIVED_CATEGORY_INTENT_PATTERNS directly from definitions
 */
export const CATEGORY_INTENT_PATTERNS: Record<ToolCategory, RegExp[]> = DERIVED_CATEGORY_INTENT_PATTERNS;

/**
 * Get category for a tool name
 */
export function getCategoryForTool(toolName: string): ToolCategory | undefined {
  for (const [category, tools] of Object.entries(TOOL_CATEGORIES)) {
    if (tools.includes(toolName)) {
      return category as ToolCategory;
    }
  }
  return undefined;
}

/**
 * Get all tools in a category
 */
export function getToolsInCategory(category: ToolCategory): string[] {
  return TOOL_CATEGORIES[category] || [];
}

/**
 * Detect categories from a user message based on intent patterns
 * Uses regex first (fast), then falls back to fuzzy matching (typo-tolerant)
 */
export function detectCategoriesFromMessage(message: string): ToolCategory[] {
  const detected: ToolCategory[] = [];
  
  // First pass: Regex matching (fast, exact)
  for (const [category, patterns] of Object.entries(CATEGORY_INTENT_PATTERNS)) {
    if (patterns.some(pattern => pattern.test(message))) {
      detected.push(category as ToolCategory);
    }
  }
  
  // Second pass: Fuzzy matching for typo tolerance (if nothing found or to supplement)
  const fuzzyCategories = detectCategoriesWithFuzzyMatching(message);
  for (const category of fuzzyCategories) {
    if (!detected.includes(category as ToolCategory)) {
      detected.push(category as ToolCategory);
    }
  }
  
  return detected;
}
