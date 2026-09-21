/**
 * Anonymous-session access control for account-scoped tools (ENG-822).
 *
 * Shared by BOTH registries on purpose. Emma has two:
 *
 *   - `mcp/server/registry.ts` (`McpToolRegistry`) — where Emma's tools are
 *     declared, and what external MCP clients call.
 *   - `mcp/client/toolRegistry.ts` (`ToolRegistry`) — what a live Emma session
 *     actually dispatches through. `agentModeService.registerTools()` copies
 *     each handler into it.
 *
 * Putting the guard in only one of them is how this fix was first written, and
 * it was inert: the copy carries `{name, definition, execute}`, so any metadata
 * added to the declaration is dropped before the live path ever sees it. A
 * guard that is not on the path the user's request takes protects nobody.
 *
 * Keeping the predicate and the refusal here means the two registries cannot
 * drift into disagreeing about what "anonymous" means or what the user is told.
 */

/**
 * Anonymous visitors are identified only by an `anon_` userId prefix — the
 * session `type` is still `regular`, which is why tool selection never gated on
 * it. A missing id is treated as anonymous too: it cannot identify an account
 * either, so it fails closed.
 */
export function isAnonymousUserId(userId: unknown): boolean {
  return typeof userId !== 'string' || userId.length === 0 || userId.startsWith('anon_');
}

export const ANONYMOUS_REFUSAL_REASON = 'anonymous_session_account_scoped_tool';

export interface AnonymousToolRefusal {
  /**
   * Marks the call as DEFERRED — skipped without executing — rather than failed.
   * Deliberately NOT `success: false`: `utils/toolResultError.ts` converts any
   * `success:false` result into an Error, which would file this by-design
   * refusal as `agent_tool_failed`, inflate the reliability ratio, and feed the
   * failure-cluster policy. It is the same reasoning `toolDeferred` and
   * `toolPartialFailure` already encode — a call that did not run is neither a
   * success nor a bug.
   */
  deferred: true;
  reason: string;
  retryable: false;
  message: string;
}

/**
 * The refusal an anonymous caller gets instead of a raw `User not found`.
 *
 * `retryable: false` is load-bearing rather than decorative: both sessions in
 * the original telemetry called the tool twice, so the visitor waited through
 * two dead calls. The refusal has to read as terminal, not transient.
 */
export function buildAnonymousToolRefusal(toolName: string): AnonymousToolRefusal {
  return {
    deferred: true,
    reason: ANONYMOUS_REFUSAL_REASON,
    retryable: false,
    message:
      `Sign in to use ${toolName} — it reads information saved to a specific account, ` +
      `and this session is not signed in. Answer from what is already in the conversation, ` +
      `or invite the visitor to sign in. Do not call this tool again in this session.`,
  };
}
