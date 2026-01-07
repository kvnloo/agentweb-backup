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

// Export handler configs
export {
  allHandlerConfigs,
  coreHandlerConfigs,
  contentHandlerConfigs,
  researchHandlerConfigs,
  crmHandlerConfigs,
  gtmHandlerConfigs,
  analyticsHandlerConfigs,
  automationHandlerConfigs,
  bookHandlerConfigs,
  templateHandlerConfigs
} from './handlers';

// Export special handlers
export { getSpecialHandlers } from './handlers';

// Export definitions
export {
  allToolDefinitions,
  registerAllTools,
  getToolCountByCategory,
  coreTools,
  contentTools,
  researchTools,
  crmTools,
  gtmTools,
  analyticsTools,
  automationTools,
  bookTools,
  templateTools
} from './definitions';

// Re-export commonly used types for convenience
export type { ToolDefinition, ToolCategory, OpenAITool } from './types';
export type { ToolHandler, ToolContext, ToolResult } from './types';

