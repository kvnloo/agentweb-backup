
export interface McpToolHandler {
  name: string;
  definition: any;
  execute: (args: any, context?: any) => Promise<any>;
  /** When true, the tool is available to Emma internally but hidden from external MCP clients. */
  internal?: boolean;
  /**
   * When true, the tool reads or writes data belonging to a persisted user
   * account, so it cannot work in an anonymous session (ENG-822). Anonymous
   * visitors carry an `anon_<uuid>` userId that no user record matches, so the
   * handler's lookup fails and the visitor sees a raw `User not found` — a
   * database-sounding error about their own existence, on what is usually their
   * first contact with the product.
   */
  requiresUserAccount?: boolean;
}

/** Anonymous visitors are identified only by an `anon_` userId prefix — the session type is still `regular`. */
export function isAnonymousUserId(userId: unknown): boolean {
  return typeof userId !== 'string' || userId.length === 0 || userId.startsWith('anon_');
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

    // ENG-822: refuse account-scoped tools in an anonymous session BEFORE the
    // handler runs. Catching the downstream lookup failure would still burn the
    // round trip and still surface as an error; this turns a broken-looking
    // failure into an instruction the visitor can act on.
    //
    // One check here rather than a per-handler list, because the gate that has
    // to be remembered for each new tool is the gate that silently rots.
    if (handler.requiresUserAccount && isAnonymousUserId(context?.userId)) {
      return {
        success: false,
        // `retryable: false` is load-bearing: both observed sessions called the
        // tool twice, so the visitor waited through two dead calls. The refusal
        // has to read as terminal rather than transient.
        retryable: false,
        message:
          `Sign in to use ${name} — it reads information saved to a specific account, ` +
          `and this session is not signed in. Answer from what is already in the conversation, ` +
          `or invite the visitor to sign in. Do not call this tool again in this session.`,
      };
    }

    return await handler.execute(args, context);
  }
}

export const mcpToolRegistry = new McpToolRegistry();
