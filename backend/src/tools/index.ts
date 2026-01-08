/**
 * Tools Module
 * 
 * Central entry point for the tools system.
 * Provides tool registry, executor, selector, and all definitions.
 */

// Export types
export * from './types';

// Export registry
export { ToolRegistry, toolRegistry } from './ToolRegistry';
export { ServiceRegistry, serviceRegistry, createServiceProvider } from './ServiceRegistry';

// Export executor
export { 
  ToolExecutor, 
  toolExecutor,
  ToolNotFoundError,
  ToolExecutionError,
  ExecuteOptions,
  ExecutionMetrics,
  ExecutionCallback
} from './ToolExecutor';

// Export selector
export { ToolSelector, ToolSelectionOptions, createToolSelector } from './ToolSelector';

// Export handler factory
export {
  createDelegatingHandler,
  createSimpleHandler,
  createHandlers,
  defaultFormatResult,
  HandlerConfig,
  SimpleHandlerConfig,
  ToolServiceProvider
} from './HandlerFactory';

// Export handlers
export { allHandlerConfigs, getSpecialHandlers } from './handlers';

// Export definitions and derived data
export {
  allToolDefinitions,
  registerAllTools,
  getToolCountByCategory,
  validateAllTools,
  coreTools,
  contentTools,
  researchTools,
  crmTools,
  gtmTools,
  analyticsTools,
  automationTools,
  bookTools,
  templateTools,
  // Derived data (single source of truth)
  DERIVED_TOOL_CATEGORIES,
  DERIVED_CATEGORY_KEYWORDS,
  DERIVED_CATEGORY_INTENT_PATTERNS,
  DERIVED_HANDLER_CONFIGS
} from './definitions';

// Re-export commonly used types for convenience
export type { ToolDefinition, ToolCategory, OpenAITool } from './types';
export type { ToolHandler, ToolContext, ToolResult } from './types';
