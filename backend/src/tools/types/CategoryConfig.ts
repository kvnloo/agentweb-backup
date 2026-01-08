/**
 * Category Configuration Type
 * 
 * Defines the structure for category-level configuration including
 * intent patterns and keywords for category detection.
 */

import { ToolCategory } from './ToolDefinition';

/**
 * Configuration for a tool category
 * Used for intent detection and category-based tool loading
 */
export interface CategoryConfig {
  /** Category identifier */
  name: ToolCategory;
  
  /** 
   * Regex patterns for intent detection.
   * If any pattern matches the user message, this category is considered relevant.
   */
  intentPatterns: RegExp[];
  
  /**
   * Keywords for fuzzy matching.
   * Used as fallback when regex patterns don't match (handles typos).
   */
  categoryKeywords: string[];
}

/**
 * Complete category definition including config and tools
 */
export interface CategoryDefinition {
  config: CategoryConfig;
  tools: import('./ToolDefinition').ToolDefinition[];
}
