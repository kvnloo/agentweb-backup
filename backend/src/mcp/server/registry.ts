import { enforceEvaluationTool } from '../../services/evaluationPolicy';
import { isAnonymousUserId, buildAnonymousToolRefusal } from '../anonymousToolAccess';
import { refuseUnauthorizedScheduledPublish, attachPublishRevalidation } from '../../utils/scheduledPublishConsentGuard';

export interface McpToolHandler {
  name: string;
  /**
   * `definition.inputSchema.properties` names are load-bearing beyond this tool's
   * own handler: `validateAndRepairToolArgs` (agentToolGatewayService.ts, ENG-1668)
   * silently hoists fields out of a stray wrapper object the model might invent
   * (e.g. `params: { your_field: ... }`) whenever the wrapper key is a generic name
   * like `params`/`args`/`data`/`config` (see LIKELY_WRAPPER_KEY_NAMES there) AND the
   * nested key matches one of YOUR schema's property names that's still empty. This
   * runs for every tool, not just the one it was built for — if your schema reuses a
   * very common field name, a stray wrapper on an unrelated tool call could in
   * principle land a value in your field. It never overwrites a value you already
   * set, and only fires for those generic wrapper-like key names, but if that ever
   * matters for your tool, read agentToolGatewayService.ts's validateAndRepairToolArgs
   * before assuming a nested-looking argument was ignored.
   */
  definition: any;
  execute: (args: any, context?: any) => Promise<any>;
  /**
   * When true, the tool is hidden from external MCP clients' `tools/list`.
   *
   * Hiding only — a client that knows the name can still call it. That is
   * deliberate for the cost-driven tools (the searches, `save_file`):
   * ENG-973 meters the `/api/emma/*` routes they self-call, so naming one
   * buys no free spend. `generate_image` is listed for external MCP
   * (metered on `/api/emma/generate-image`). Where the damage would be the
   * *action* rather than the cost, use `internalOnly` instead.
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
  /**
   * ENG-1276 follow-up — declares that EVERY call to this tool, for ANY
   * arguments, has no external side effect (nothing published, sent, or
   * written to a customer's live account/CRM — pure read/compute/research).
   * Consulted by the scheduled-run conditional-skip veto and the ENG-1297
   * read-only press circuit breaker (`isReadOnlyToolName` in
   * utils/toolWriteClassification.ts) so a schedule's "check
   * something first" step doesn't get misclassified as a write just because
   * its name doesn't lead with get/read/list/... — the exact bug that broke
   * perform_data_analysis (ENG-1276).
   *
   * Leave unset (defaults to write) for any tool that bundles a write action
   * under SOME arguments — e.g. twitter_manage_post (post_thread writes,
   * get_tweet_metrics doesn't) or call_google_ads_api (LIST reads, CREATE/
   * UPDATE write). A whole-tool boolean cannot express "read-only for THESE
   * arguments only"; only set this when no possible call writes anything.
   */
  readOnly?: boolean;
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
    await enforceEvaluationTool(context?.userId, name);
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
    const publishRefusal = await refuseUnauthorizedScheduledPublish(name, context, undefined, args);
    if (publishRefusal) {
      console.warn(`ENG-827: refused ${name} in session ${context?.sessionId} — publish consent not live.`);
      return publishRefusal;
    }

    // A publishing handler may do minutes of work (media download, video upload)
    // between being admitted here and actually committing the post, so admission
    // alone is not enough — hand it a re-validation to run at its last moment.
    return await handler.execute(args, attachPublishRevalidation(name, context, args));
  }
}

export const mcpToolRegistry = new McpToolRegistry();
