/**
 * Tool Handler Types
 * 
 * Defines the interface for tool execution handlers.
 * Each tool has a corresponding handler that implements the execution logic.
 */

/**
 * Context passed to tool handlers during execution
 */
export interface ToolContext {
  /** User ID for authorization and data access */
  userId: string;
  
  /** Chat session ID for context */
  sessionId: string;
  
  /** LLM model being used */
  llmModel: string;
  
  /** Whether to return mock data instead of executing */
  mockMode: boolean;
}

/**
 * Result returned from tool execution
 */
export interface ToolResult<T = unknown> {
  /** Whether the tool executed successfully */
  success: boolean;
  
  /** Result data from the tool */
  data?: T;
  
  /** Formatted content for LLM consumption */
  formattedContent?: string;
  
  /** Error message if failed */
  error?: string;
}

/**
 * Tool handler interface - implements the execution logic for a tool
 */
export interface ToolHandler<TArgs = unknown, TResult = unknown> {
  /** Tool name this handler is for */
  name: string;
  
  /**
   * Execute the tool with given arguments
   * @param args - Parsed arguments from LLM
   * @param context - Execution context
   */
  execute(args: TArgs, context: ToolContext): Promise<TResult>;
  
  /**
   * Format the result for LLM consumption
   * @param result - Raw result from execution
   */
  formatResult?(result: TResult): string;
  
  /**
   * Get mock result for testing
   * @param args - Arguments to mock against
   */
  getMockResult?(args: TArgs): TResult;
}

/**
 * Abstract base class for tool handlers with common functionality
 */
export abstract class BaseToolHandler<TArgs = unknown, TResult = unknown> 
  implements ToolHandler<TArgs, TResult> {
  
  abstract name: string;
  
  abstract execute(args: TArgs, context: ToolContext): Promise<TResult>;
  
  formatResult(result: TResult): string {
    return JSON.stringify(result, null, 2);
  }
  
  getMockResult?(args: TArgs): TResult;
}
