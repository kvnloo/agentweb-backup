/**
 * Tool Categories Configuration
 * 
 * Maps tool names to categories and defines intent patterns for
 * automatic category detection from user messages.
 */

import { ToolCategory } from './ToolDefinition';
import { detectCategoriesWithFuzzyMatching } from './FuzzyMatcher';

/**
 * Tool category mappings - which tools belong to which category
 */
export const TOOL_CATEGORIES: Record<ToolCategory, string[]> = {
  core: [
    'search_web',
    'read_file_content',
    'save_file',
    'describe_image',
    'read_page_source'
  ],
  content: [
    'create_blog_article',
    'publish_blog_article',
    'generate_image',
    'generate_video',
    'create_social_media_posts',
    'post_on_connected_account',
    'remove_c2pa_from_image'
  ],
  research: [
    'search_knowledge_base',
    'list_knowledge_base_files',
    'read_knowledge_base_file',
    'read_knowledge_base_files',
    'perform_deep_research',
    'perform_data_analysis',
    'describe_video'
  ],
  crm: [
    'read_brand_guidelines',
    'update_brand_guidelines',
    'read_market_strategy',
    'update_market_strategy',
    'get_lead_lists',
    'create_lead_list',
    'add_leads_to_list',
    'update_email_draft_for_lead'
  ],
  gtm: [
    'list_gtm_plans',
    'read_gtm_plan',
    'create_gtm_plan'
  ],
  analytics: [
    'get_meta_ads_metrics',
    'get_task_subscriber_metrics',
    'get_task_subscriber_engagement_events',
    'load_connected_account_metrics',
    'list_connected_account_posts',
    'list_connected_accounts'
  ],
  automation: [
    'create_task_from_template',
    'create_task_from_prompt',
    'create_image_task_from_prompt',
    'create_revision',
    'create_work_plan',
    'modify_work_plan',
    'set_work_plan_status'
  ],
  books: [
    'list_books',
    'get_book_details',
    'get_book_content',
    'update_book_content',
    'generate_book_content',
    'create_book',
    'create_book_outline',
    'add_characters'
  ],
  templates: [
    'list_html_templates',
    'create_html_from_template',
    'update_html_file'
  ]
};

/**
 * Intent patterns for detecting category from user message
 * Each category has an array of regex patterns that indicate user intent
 */
export const CATEGORY_INTENT_PATTERNS: Record<ToolCategory, RegExp[]> = {
  core: [
    // Core tools are always included, no pattern needed
  ],
  content: [
    /\b(blog|article|write|writing|post|image|video|creative|social\s*media|generate\s*image|photo|picture|linkedin\s*post|facebook\s*post|tweet|instagram)\b/i
  ],
  research: [
    /\b(search|find|research|analyze|deep\s*research|knowledge|data\s*analysis|look\s*up|investigate)\b/i
  ],
  crm: [
    /\b(lead|leads|brand|branding|strategy|customer|guideline|marketing\s*strategy|target\s*audience|competitor|icp|ideal\s*customer)\b/i
  ],
  gtm: [
    /\b(gtm|go[\s-]to[\s-]market|launch\s*plan|market\s*entry)\b/i
  ],
  analytics: [
    /\b(metrics|performance|ads|campaign|stats|meta\s*ads|facebook\s*ads|analytics|engagement|impressions|clicks|ctr)\b/i
  ],
  automation: [
    /\b(task|template|work\s*plan|schedule|revision|automate|automation|workflow)\b/i
  ],
  books: [
    /\b(book|whitepaper|white\s*paper|chapter|outline|ebook|e-book|publication|manuscript)\b/i
  ],
  templates: [
    /\b(html\s*template|email\s*template|newsletter|update\s*html)\b/i
  ]
};

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

