/**
 * Tool Definition Types
 * 
 * Defines the structure for tool definitions used by the AI agent.
 * Tools are categorized for intent-based loading.
 * 
 * Note: Subscription-based access control is handled via subscriptionService,
 * not through tool definitions. See subscriptionService.ts for details.
 */

/**
 * JSON Schema type (simplified for our use case)
 */
export interface JSONSchemaType {
  type?: string;
  description?: string;
  properties?: Record<string, JSONSchemaType>;
  items?: JSONSchemaType;
  required?: string[];
  enum?: string[];
  default?: any;
  additionalProperties?: boolean | JSONSchemaType;
  [key: string]: any;
}

/**
 * All valid tool categories (SINGLE SOURCE OF TRUTH for TypeScript type)
 * 
 * WHY HERE? TypeScript types are erased at runtime. We need this compile-time
 * constant to provide type safety. The CategoryConfig in each *Tools.ts file
 * must use a name from this array - TypeScript will catch any typos.
 * 
 * WHEN ADDING A NEW CATEGORY:
 * 1. Add the category name here
 * 2. Create definitions/newCategoryTools.ts with CategoryConfig + tools
 * 3. Import in definitions/index.ts
 */
export const TOOL_CATEGORY_NAMES = [
  'core',
  'content',
  'research',
  'crm',
  'gtm',
  'analytics',
  'automation',
  'books',
  'templates'
] as const;

/**
 * Tool category type - automatically derived from TOOL_CATEGORY_NAMES
 */
export type ToolCategory = typeof TOOL_CATEGORY_NAMES[number];


/**
 * Valid context arguments that can be injected into handler calls
 */
export type ContextArg = 'userId' | 'sessionId' | 'llmModel';

/**
 * Handler configuration for tool execution
 * Defines how to map tool arguments to service method calls
 */
export interface ToolHandlerConfig {
  /** Service to delegate to (e.g., 'image', 'blog', 'knowledge_base') */
  serviceName?: string;
  
  /** Method name on the service to call */
  methodName: string;
  
  /** Context fields to inject (e.g., ['userId', 'sessionId']) */
  contextArgs?: ContextArg[];
  
  /** 
   * Custom argument ordering if schema property order is insufficient.
   * If not specified, args are derived from schema.parameters.properties order + contextArgs.
   * Use paths like 'args.topic', 'context.userId', or 'args' for full args object.
   */
  customArgOrder?: string[];
  
  /** Whether this tool uses a special/custom handler instead of simple delegation */
  specialHandler?: boolean;
}

/**
 * Tool definition structure
 */
export interface ToolDefinition {
  /** Unique tool identifier (e.g., 'create_blog_article') */
  name: string;
  
  /** Tool version for tracking changes */
  version: string;
  
  /** Category for intent-based loading */
  category: ToolCategory;
  
  /** Whether this tool is deprecated */
  deprecated?: boolean;
  
  /** Message to show when deprecated tool is used */
  deprecatedMessage?: string;

  /** OpenAI-compatible function schema */
  schema: {
    description: string;
    parameters: JSONSchemaType;
  };

  /** 
   * Handler configuration for tool execution.
   * Defines how to delegate to service methods.
   * Optional during migration - will become required.
   */
  handler?: ToolHandlerConfig;

  /**
   * Keywords for intent detection via fuzzy matching.
   * Used to identify when a user's message relates to this tool's category.
   * Supplements category-level keywords for more specific matching.
   */
  intentKeywords?: string[];
}

/**
 * OpenAI-compatible tool format for API calls
 */
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JSONSchemaType;
  };
}

/**
 * Tool manifest entry - lightweight version for intent classification
 */
export interface ToolManifestEntry {
  name: string;
  description: string;
  category: ToolCategory;
}

/**
 * Convert a ToolDefinition to OpenAI format
 */
export function toOpenAIFormat(tool: ToolDefinition): OpenAITool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.schema.description,
      parameters: tool.schema.parameters
    }
  };
}

/**
 * Convert a ToolDefinition to manifest entry
 */
export function toManifestEntry(tool: ToolDefinition): ToolManifestEntry {
  return {
    name: tool.name,
    description: tool.schema.description,
    category: tool.category
  };
}
