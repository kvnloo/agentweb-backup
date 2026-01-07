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
 * Tool categories for intent-based loading
 */
export type ToolCategory = 
  | 'core'
  | 'content'
  | 'research'
  | 'crm'
  | 'gtm'
  | 'analytics'
  | 'automation'
  | 'books'
  | 'templates';


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
