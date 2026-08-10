import { isAnonymousUserId, buildAnonymousToolRefusal } from '../anonymousToolAccess';
import { refuseUnauthorizedScheduledPublish } from '../../utils/scheduledPublishConsentGuard';

export interface McpToolHandler {
  name: string;
  definition: any;
  execute: (args: any, context?: any) => Promise<any>;
  /**
   * When true, the tool is hidden from external MCP clients' `tools/list`.
   *
   * Hiding only — a client that knows the name can still call it. That is
   * deliberate for the cost-driven tools (image generation, the searches,
   * `save_file`): ENG-973 meters the `/api/emma/*` routes they self-call, so
   * naming one buys no free spend. Where the damage would be the *action*
   * rather than the cost, use `internalOnly` instead.
   */
  internal?: boolean;
  /**
   * When true, the tool is hidden AND refused for external MCP callers at
   * `execute()` (ENG-974).
   *
   * Set on the outbound-action tools — those that send something outward,
   * publish something, or change what Emma can do. Metering is not a
   * sufficient control for these: a cap limits how many emails a stranger
   * sends, not whether they may send any.
   */
  internalOnly?: boolean;
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

export { isAnonymousUserId } from '../anonymousToolAccess';

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

    // ENG-974: refuse outbound-action tools for external MCP callers.
    //
    // Keyed on `context.externalMcp`, NOT on `isInternal`. Emma's own dispatch
    // (agentModeService.ts, `this.toolRegistry.execute(...)`) passes a context of
    // `{ userId, sessionId, llmModel, service }` with neither flag set, so a
    // check of `isInternal !== true` would refuse Emma her own `send_email` and
    // `install_skills`. `externalMcp` is set to true by mcpServerCore for exactly
    // one caller — an external API-key or OAuth client — and in-process callers
    // never set it. security.mcpServer.test.ts pins that invariant so this cannot
    // quietly fail open if the dispatcher changes.
    if (handler.internalOnly && context?.externalMcp === true) {
      throw new Error(
        `Tool ${name} is not available to external clients. It is used by Emma internally.`
      );
    }

    // ENG-822: refuse account-scoped tools in an anonymous session BEFORE the
    // handler runs. Catching the downstream lookup failure would still burn the
    // round trip and still surface as an error; this turns a broken-looking
    // failure into an instruction the visitor can act on.
    //
    // One check here rather than a per-handler list, because the gate that has
    // to be remembered for each new tool is the gate that silently rots.
    if (handler.requiresUserAccount && isAnonymousUserId(context?.userId)) {
      return buildAnonymousToolRefusal(name);
    }

    // ENG-827: an unattended scheduled run may only publish while its owner's
    // consent is live. The runner re-checks between verification attempts, but a
    // single turn is one worker invocation that can run for minutes over many
    // internal tool calls — so a revocation arriving mid-turn would not be seen
    // until after the publish. Checked here, immediately before execution, there
    // is no window left. Same placement rationale as the two refusals above.
    const publishRefusal = await refuseUnauthorizedScheduledPublish(name, context);
    if (publishRefusal) {
      console.warn(`ENG-827: refused ${name} in session ${context?.sessionId} — publish consent not live.`);
      return publishRefusal;
    }

    return await handler.execute(args, context);
  }
}

export const mcpToolRegistry = new McpToolRegistry();
