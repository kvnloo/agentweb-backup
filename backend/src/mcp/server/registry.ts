
export interface McpToolHandler {
  name: string;
  definition: any;
  execute: (args: any, context?: any) => Promise<any>;
  /** When true, the tool is available to Emma internally but hidden from external MCP clients. */
  internal?: boolean;
}

export class McpToolRegistry {
  private tools: Map<string, McpToolHandler> = new Map();

  register(handler: McpToolHandler) {
    this.tools.set(handler.name, handler);
  }

  /** Definitions exposed to external MCP clients (excludes internal-only tools). */
  getToolDefinitions() {
    return Array.from(this.tools.values())
      .filter(t => !t.internal)
      .map(t => t.definition);
  }

  /** All tool definitions including internal-only (for Emma's internal registry). */
  getAllToolDefinitions() {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  getToolNames() {
    return Array.from(this.tools.keys());
  }

  getTool(name: string) {
    return this.tools.get(name);
  }

  /** All tool handlers including internal-only (for Emma's internal registry). */
  getAllTools() {
    return Array.from(this.tools.values());
  }

  async execute(name: string, args: any, context?: any) {
    const handler = this.tools.get(name);
    if (!handler) {
      throw new Error(`Tool ${name} not found`);
    }
    return await handler.execute(args, context);
  }
}

export const mcpToolRegistry = new McpToolRegistry();
