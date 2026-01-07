/**
 * Handler Factory
 * 
 * Creates tool handlers that delegate to existing service methods.
 * This provides a bridge between the new ToolExecutor pattern and
 * the existing implementation in agentModeService.
 */

import { ToolHandler, ToolContext } from './types';

/**
 * Service interface that handler factory expects
 * This allows us to gradually migrate methods from agentModeService
 */
export interface ToolServiceProvider {
  // The provider must have methods matching tool names
  [methodName: string]: ((...args: any[]) => Promise<any>) | any;
}

/**
 * Service provider interface (wrapper for ServiceRegistry)
 */
export interface ServiceProvider {
  getService(serviceName: string): any;
  getLegacyService(): any;
}

/**
 * Configuration for creating a handler
 */
export interface HandlerConfig<TArgs = unknown, TResult = unknown> {
  /** Tool name */
  name: string;
  
  /** 
   * Function to extract method arguments from tool args and context
   * Returns an array of arguments to pass to the service method
   */
  extractArgs: (args: TArgs, context: ToolContext) => any[];
  
  /** Optional result formatter */
  formatResult?: (result: TResult) => string;
  
  /** Optional mock result generator */
  getMockResult?: (args: TArgs) => TResult;
}

/**
 * Create a handler that delegates to a service method
 */
export function createDelegatingHandler<TArgs = unknown, TResult = unknown>(
  serviceOrProvider: ToolServiceProvider | ServiceProvider,
  methodName: string,
  config: HandlerConfig<TArgs, TResult>,
  serviceName?: string
): ToolHandler<TArgs, TResult> {
  return {
    name: config.name,
    
    async execute(args: TArgs, context: ToolContext): Promise<TResult> {
      // Resolve the actual service instance
      let service: any = serviceOrProvider;
      
      // If it's a ServiceProvider (has getService), resolve specific service
      if ('getService' in serviceOrProvider) {
        if (serviceName) {
           service = (serviceOrProvider as ServiceProvider).getService(serviceName);
        } else {
           service = (serviceOrProvider as ServiceProvider).getLegacyService();
        }
      }

      const method = service[methodName];
      if (typeof method !== 'function') {
        throw new Error(`Method '${methodName}' not found on service${serviceName ? ` '${serviceName}'` : ''}`);
      }
      
      const methodArgs = config.extractArgs(args, context);
      return method.apply(service, methodArgs);
    },
    
    formatResult: config.formatResult,
    getMockResult: config.getMockResult
  };
}

/**
 * Simple handler config for tools where args map directly to method params
 */
/**
 * Simple handler config for tools where args map directly to method params
 */
export interface SimpleHandlerConfig {
  name: string;
  methodName: string;
  /** Optional service name to target (defaults to legacy service) */
  serviceName?: string;
  /** 
   * Order of args to pass. Each string is a path like 'args.query' or 'context.userId'
   * Special values: 'args' (full args object), 'context' (full context)
   */
  argOrder: string[];
  formatResult?: (result: any) => string;
  getMockResult?: (args: any) => any;
}

/**
 * Get a nested value from an object using dot notation
 */
function getNestedValue(obj: any, path: string): any {
  const parts = path.split('.');
  let current = obj;
  
  for (const part of parts) {
    if (current === undefined || current === null) {
      return undefined;
    }
    current = current[part];
  }
  
  return current;
}

/**
 * Create a simple handler with auto-mapped arguments
 */
export function createSimpleHandler(
  serviceOrProvider: ToolServiceProvider | ServiceProvider,
  config: SimpleHandlerConfig
): ToolHandler {
  return createDelegatingHandler(serviceOrProvider, config.methodName, {
    name: config.name,
    extractArgs: (args, context) => {
      return config.argOrder.map(path => {
        if (path === 'args') return args;
        if (path === 'context') return context;
        if (path.startsWith('args.')) {
          return getNestedValue(args, path.substring(5));
        }
        if (path.startsWith('context.')) {
          return getNestedValue(context, path.substring(8));
        }
        return getNestedValue({ args, context }, path);
      });
    },
    formatResult: config.formatResult,
    getMockResult: config.getMockResult
  }, config.serviceName);
}

/**
 * Batch create handlers from configs
 */
export function createHandlers(
  serviceOrProvider: ToolServiceProvider | ServiceProvider,
  configs: SimpleHandlerConfig[]
): ToolHandler[] {
  return configs.map(config => createSimpleHandler(serviceOrProvider, config));
}

/**
 * Default result formatter - JSON stringify with truncation
 */
export function defaultFormatResult(result: any, maxLength: number = 10000): string {
  const str = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  if (str.length > maxLength) {
    return str.substring(0, maxLength) + '\n... (truncated)';
  }
  return str;
}
