/**
 * Tool Registry
 * 
 * Central registry for all tool definitions. Provides methods to:
 * - Register and retrieve tools
 * - Filter tools by category
 * - Convert to OpenAI format for API calls
 * 
 * Note: Subscription-based filtering is handled via subscriptionService,
 * not through this registry. See subscriptionService.ts for details.
 */

import {
  ToolDefinition,
  ToolCategory,
  OpenAITool,
  ToolManifestEntry,
  toOpenAIFormat,
  toManifestEntry
} from './types';

/**
 * Registry for storing and managing tool definitions
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private byCategory = new Map<ToolCategory, Set<string>>();

  /**
   * Register a tool definition
   */
  register(tool: ToolDefinition): void {
    // Validate tool name doesn't exist
    if (this.tools.has(tool.name)) {
      console.warn(`Tool '${tool.name}' already registered, overwriting.`);
    }

    this.tools.set(tool.name, tool);

    // Index by category
    if (!this.byCategory.has(tool.category)) {
      this.byCategory.set(tool.category, new Set());
    }
    this.byCategory.get(tool.category)!.add(tool.name);
  }

  /**
   * Register multiple tools at once
   */
  registerAll(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * Get a tool by name
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Get multiple tools by names
   */
  getByNames(names: string[]): ToolDefinition[] {
    return names
      .map(name => this.tools.get(name))
      .filter((t): t is ToolDefinition => t !== undefined);
  }

  /**
   * Get all tools in a category
   */
  getByCategory(category: ToolCategory): ToolDefinition[] {
    const toolNames = this.byCategory.get(category);
    if (!toolNames) return [];
    
    return Array.from(toolNames)
      .map(name => this.tools.get(name))
      .filter((t): t is ToolDefinition => t !== undefined);
  }

  /**
   * Get all tools in multiple categories
   */
  getByCategories(categories: ToolCategory[]): ToolDefinition[] {
    const uniqueTools = new Map<string, ToolDefinition>();
    
    for (const category of categories) {
      for (const tool of this.getByCategory(category)) {
        uniqueTools.set(tool.name, tool);
      }
    }
    
    return Array.from(uniqueTools.values());
  }


  /**
   * Get all non-deprecated tools
   */
  getActive(): ToolDefinition[] {
    return Array.from(this.tools.values()).filter(t => !t.deprecated);
  }

  /**
   * Get all tools
   */
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool count
   */
  count(): number {
    return this.tools.size;
  }

  /**
   * Check if a tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Convert all tools to OpenAI format
   */
  toOpenAIFormat(): OpenAITool[] {
    return this.getActive().map(toOpenAIFormat);
  }

  /**
   * Convert specified tools to OpenAI format
   */
  toOpenAIFormatFiltered(tools: ToolDefinition[]): OpenAITool[] {
    return tools.filter(t => !t.deprecated).map(toOpenAIFormat);
  }

  /**
   * Get manifest (lightweight listing for intent classification)
   */
  getManifest(): ToolManifestEntry[] {
    return this.getActive().map(toManifestEntry);
  }

  /**
   * Get manifest as a record for quick lookups
   */
  getManifestRecord(): Record<string, string> {
    const manifest: Record<string, string> = {};
    for (const tool of this.getActive()) {
      manifest[tool.name] = tool.schema.description;
    }
    return manifest;
  }

  /**
   * Clear all registered tools (useful for testing)
   */
  clear(): void {
    this.tools.clear();
    this.byCategory.clear();
  }
}

/**
 * Singleton instance of ToolRegistry.
 * 
 * @note In clustered or worker environments, each process/thread has its own
 * singleton instance. Tools registered in one process are NOT shared with others.
 * For cross-process state sharing, consider using Redis or a shared database.
 * 
 * @example
 * ```typescript
 * import { toolRegistry } from './tools';
 * toolRegistry.register(myTool);
 * ```
 */
export const toolRegistry = new ToolRegistry();
