/**
 * Tool Selector
 * 
 * Selects relevant tools based on user message intent and conversation context.
 * Reduces token usage by 50-85% by loading only relevant tool categories.
 * Supports DB-driven subscription filtering via subscriptionService.
 */

import { ToolRegistry } from './ToolRegistry';
import { ToolDefinition, ToolCategory } from './types';
import { detectCategoriesFromMessage } from './types/ToolCategories';
import { getAllowedToolsForUser } from './SubscriptionToolFilter';

/**
 * Options for tool selection (intent-based only)
 * Note: For subscription filtering, use selectToolsForUser with userId
 */
export interface ToolSelectionOptions {
  /** Current user message */
  message: string;
  
  /** Recent conversation history for context */
  sessionHistory?: Array<{ role: string; content: string }>;
  
  /** Maximum number of tools to return */
  maxTools?: number;
  
  /** Additional categories to always include */
  includeCategories?: ToolCategory[];
  
  /** Whether to include deprecated tools */
  includeDeprecated?: boolean;
}

/**
 * Options for DB-driven tool selection
 */
export interface ToolSelectionWithUserOptions {
  /** Current user message */
  message: string;
  
  /** User ID for subscription lookup */
  userId: string;
  
  /** Recent conversation history for context */
  sessionHistory?: Array<{ role: string; content: string }>;
  
  /** Maximum number of tools to return */
  maxTools?: number;
  
  /** Additional categories to always include */
  includeCategories?: ToolCategory[];
  
  /** Whether to include deprecated tools */
  includeDeprecated?: boolean;
}

/**
 * Core tools that are always included in every request
 */
const CORE_TOOLS = [
  'search_web',
  'read_file_content',
  'save_file',
  'describe_image',
  'read_page_source'
];

/**
 * Selects tools based on user intent
 */
export class ToolSelector {
  constructor(private registry: ToolRegistry) {}

  /**
   * Select relevant tools based on message and context (intent-based only)
   * Note: This method does NOT filter by subscription. Use selectToolsForUser for that.
   */
  selectTools(options: ToolSelectionOptions): ToolDefinition[] {
    const {
      message,
      sessionHistory = [],
      maxTools = 25,
      includeCategories = [],
      includeDeprecated = false
    } = options;

    // 1. Start with core tools (always included)
    const toolMap = new Map<string, ToolDefinition>();
    for (const tool of this.registry.getByNames(CORE_TOOLS)) {
      toolMap.set(tool.name, tool);
    }

    // 2. Detect categories from current message (use Set for deduplication)
    const detectedCategories = new Set<ToolCategory>(detectCategoriesFromMessage(message));

    // 3. Also analyze recent conversation for context continuity
    const recentUserMessages = sessionHistory
      .slice(-5) // Last 5 messages
      .filter(m => m.role === 'user')
      .slice(-3); // Last 3 user messages
    
    for (const msg of recentUserMessages) {
      for (const cat of detectCategoriesFromMessage(msg.content)) {
        detectedCategories.add(cat);
      }
    }

    // 4. Add explicitly requested categories
    for (const cat of includeCategories) {
      detectedCategories.add(cat);
    }

    // 5. Load tools for all detected categories
    for (const category of detectedCategories) {
      for (const tool of this.registry.getByCategory(category)) {
        toolMap.set(tool.name, tool);
      }
    }

    // 6. Convert to array
    let tools = Array.from(toolMap.values());

    // 7. Filter deprecated if requested
    if (!includeDeprecated) {
      tools = tools.filter(t => !t.deprecated);
    }

    // 8. Limit to maxTools
    return tools.slice(0, maxTools);
  }

  /**
   * Select relevant tools using DB-driven subscription filtering
   * This is the preferred method - uses subscriptionService to get allowed tools
   */
  async selectToolsForUser(options: ToolSelectionWithUserOptions): Promise<ToolDefinition[]> {
    const {
      message,
      userId,
      sessionHistory = [],
      maxTools = 25,
      includeCategories = [],
      includeDeprecated = false
    } = options;

    // 1. Start with core tools (always included)
    const toolMap = new Map<string, ToolDefinition>();
    for (const tool of this.registry.getByNames(CORE_TOOLS)) {
      toolMap.set(tool.name, tool);
    }

    // 2. Detect categories from current message (use Set for deduplication)
    const detectedCategories = new Set<ToolCategory>(detectCategoriesFromMessage(message));

    // 3. Also analyze recent conversation for context continuity
    const recentUserMessages = sessionHistory
      .slice(-5)
      .filter(m => m.role === 'user')
      .slice(-3);
    
    for (const msg of recentUserMessages) {
      for (const cat of detectCategoriesFromMessage(msg.content)) {
        detectedCategories.add(cat);
      }
    }

    // 4. Add explicitly requested categories
    for (const cat of includeCategories) {
      detectedCategories.add(cat);
    }

    // 5. Load tools for all detected categories
    for (const category of detectedCategories) {
      for (const tool of this.registry.getByCategory(category)) {
        toolMap.set(tool.name, tool);
      }
    }

    // 6. Get allowed tools from DB based on user's subscription
    const allowedTools = await getAllowedToolsForUser(userId);
    
    let tools = Array.from(toolMap.values());
    
    // Filter by allowed tools if restrictions exist
    if (allowedTools.length > 0 && !allowedTools.includes('*')) {
      tools = tools.filter(tool => allowedTools.includes(tool.name));
    }

    // 7. Filter deprecated if requested
    if (!includeDeprecated) {
      tools = tools.filter(t => !t.deprecated);
    }

    // 8. Limit to maxTools
    return tools.slice(0, maxTools);
  }

  /**
   * Get tool categories detected from a message
   */
  getDetectedCategories(message: string): ToolCategory[] {
    return detectCategoriesFromMessage(message);
  }

  /**
   * Estimate token savings compared to sending all tools
   */
  estimateTokenSavings(selectedCount: number, totalCount: number): {
    selectedTools: number;
    totalTools: number;
    savingsPercent: number;
  } {
    const savingsPercent = totalCount > 0 
      ? Math.round((1 - selectedCount / totalCount) * 100)
      : 0;
    
    return {
      selectedTools: selectedCount,
      totalTools: totalCount,
      savingsPercent
    };
  }
}

/**
 * Create a ToolSelector with the given registry
 */
export function createToolSelector(registry: ToolRegistry): ToolSelector {
  return new ToolSelector(registry);
}

