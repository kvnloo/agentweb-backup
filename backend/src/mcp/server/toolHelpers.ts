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
