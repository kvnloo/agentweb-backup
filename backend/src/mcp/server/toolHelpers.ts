/**
 * Shared helpers for MCP tool registrations.
 *
 * Extracted from apiTools.ts (unchanged behaviour) so the workflow-tool layer
 * in workflowTools.ts can reuse them rather than keeping a second copy that
 * drifts.
 */

/** Narrow a tool execution context down to the identity mcpFetch needs. */
export function ctx(context: any) {
  return {
    userId: context?.userId,
    agentUserId: context?.agentUserId,
    isDelegatedAccess: context?.isDelegatedAccess,
    // ENG-827 (Greptile, security): a publishing tool that reaches its platform
    // through a REST self-call checks consent HERE, then hands off — and the slow,
    // irreversible part (video upload, Instagram container) runs on the far side of
    // that boundary, where the in-process re-check hook cannot follow. Identity alone
    // does not let the route rebuild it; the guard is keyed on the SESSION, because
    // that is what carries the run's admission scope. So the session crosses too.
    sessionId: context?.sessionId,
  };
}

/** Wrap a value as an MCP text content result. */
export function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}
