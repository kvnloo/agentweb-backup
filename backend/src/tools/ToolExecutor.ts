/**
 * Tool Executor
 * 
 * Executes tools using a strategy pattern. Each tool has a registered handler
 * that implements the execution logic. This replaces the large switch statement
 * in agentModeService.ts.
 */

import { ToolHandler, ToolContext, ToolResult } from './types';

/**
 * Error thrown when a tool is not found
 */
export class ToolNotFoundError extends Error {
  constructor(public toolName: string) {
    super(`Unknown tool: ${toolName}`);
    this.name = 'ToolNotFoundError';
  }
}

/**
 * Error thrown when tool execution fails
 */
export class ToolExecutionError extends Error {
  constructor(
    public toolName: string,
    public originalError: Error,
    public args?: unknown
  ) {
    super(`Tool '${toolName}' failed: ${originalError.message}`);
    this.name = 'ToolExecutionError';
  }
}

/**
 * Options for tool execution
 */
export interface ExecuteOptions {
  /** Timeout in milliseconds (default: 5 minutes) */
  timeout?: number;
  
  /** Whether to log execution details */
  verbose?: boolean;
}

/**
 * Execution metrics for observability
 */
export interface ExecutionMetrics {
  toolName: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  success: boolean;
  error?: string;
  mockMode: boolean;
}

/**
 * Callback for execution events
 */
export type ExecutionCallback = (metrics: ExecutionMetrics) => void;

/**
 * Tool Executor - manages tool handlers and executes tools
 */
export class ToolExecutor {
  private handlers = new Map<string, ToolHandler>();
  private executionCallbacks: ExecutionCallback[] = [];
  
  /**
   * Register a tool handler
   */
  register<TArgs = unknown, TResult = unknown>(
    handler: ToolHandler<TArgs, TResult>
  ): void {
    if (this.handlers.has(handler.name)) {
      console.warn(`ToolExecutor: Handler for '${handler.name}' already registered, overwriting.`);
    }
    this.handlers.set(handler.name, handler as ToolHandler);
  }

  /**
   * Register multiple handlers at once
   */
  registerAll(handlers: ToolHandler[]): void {
    for (const handler of handlers) {
      this.register(handler);
    }
  }

  /**
   * Register a simple function as a handler
   */
  registerFunction<TArgs = unknown, TResult = unknown>(
    name: string,
    executeFn: (args: TArgs, context: ToolContext) => Promise<TResult>,
    options?: {
      formatResult?: (result: TResult) => string;
      getMockResult?: (args: TArgs) => TResult;
    }
  ): void {
    this.register({
      name,
      execute: executeFn,
      formatResult: options?.formatResult,
      getMockResult: options?.getMockResult
    } as ToolHandler<TArgs, TResult>);
  }

  /**
   * Check if a handler exists for a tool
   */
  has(toolName: string): boolean {
    return this.handlers.has(toolName);
  }

  /**
   * Get a registered handler
   */
  get(toolName: string): ToolHandler | undefined {
    return this.handlers.get(toolName);
  }

  /**
   * Get all registered tool names
   */
  getRegisteredTools(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Add execution callback for observability
   */
  onExecution(callback: ExecutionCallback): void {
    this.executionCallbacks.push(callback);
  }

  /**
   * Execute a tool
   */
  async execute<TResult = unknown>(
    toolName: string,
    args: unknown,
    context: ToolContext,
    options?: ExecuteOptions
  ): Promise<ToolResult<TResult>> {
    const startTime = new Date();
    const { timeout = 3600000, verbose = false } = options || {}; // 1 hour timeout

    const handler = this.handlers.get(toolName);
    if (!handler) {
      throw new ToolNotFoundError(toolName);
    }

    if (verbose) {
      const argsStr = JSON.stringify(args, null, 2);
      const truncatedArgs = argsStr.length > 500 ? argsStr.substring(0, 500) + '...' : argsStr;
      console.log(`ToolExecutor: Executing '${toolName}' with args:`, truncatedArgs);
    }

    try {
      // Return mock data if in mock mode
      if (context.mockMode && handler.getMockResult) {
        const mockResult = handler.getMockResult(args);
        this.emitMetrics(toolName, startTime, true, context.mockMode);
        
        return {
          success: true,
          data: mockResult as TResult,
          formattedContent: handler.formatResult 
            ? handler.formatResult(mockResult) 
            : JSON.stringify(mockResult)
        };
      }

      // Execute with timeout
      const result = await this.executeWithTimeout(
        handler.execute(args, context),
        timeout,
        toolName
      );

      const formattedContent = handler.formatResult 
        ? handler.formatResult(result) 
        : (typeof result === 'string' ? result : JSON.stringify(result));

      this.emitMetrics(toolName, startTime, true, context.mockMode);

      return {
        success: true,
        data: result as TResult,
        formattedContent
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      
      this.emitMetrics(toolName, startTime, false, context.mockMode, err.message);
      
      if (verbose) {
        console.error(`ToolExecutor: Error executing '${toolName}':`, err);
      }

      throw new ToolExecutionError(toolName, err, args);
    }
  }

  /**
   * Execute with timeout
   * Clears the timer in finally block to prevent memory leaks
   */
  private async executeWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    toolName: string
  ): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Tool '${toolName}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  }

  /**
   * Emit execution metrics to callbacks
   */
  private emitMetrics(
    toolName: string,
    startTime: Date,
    success: boolean,
    mockMode: boolean,
    error?: string
  ): void {
    const endTime = new Date();
    const metrics: ExecutionMetrics = {
      toolName,
      startTime,
      endTime,
      durationMs: endTime.getTime() - startTime.getTime(),
      success,
      mockMode,
      error
    };

    for (const callback of this.executionCallbacks) {
      try {
        callback(metrics);
      } catch (e) {
        console.error('ToolExecutor: Error in execution callback:', e);
      }
    }
  }

  /**
   * Clear all registered handlers (useful for testing)
   */
  clear(): void {
    this.handlers.clear();
  }
}

// Singleton instance
export const toolExecutor = new ToolExecutor();
