/**
 * ENG-1948: one listing decision for evaluation_workspace, shared by both Agent Mode
 * tool-list paths. When the principal is never offered the tool, drop it from the
 * model-facing tool list AND from the dispatch allow-list so the two cannot disagree.
 * Execute-time EvaluationDenied checks stay in place as defence in depth.
 */
export const EVALUATION_WORKSPACE_TOOL = 'evaluation_workspace';

export function applyEvaluationWorkspaceListing<T extends { function?: { name?: string } }>(
  tools: T[],
  allowedToolNames: Set<string> | undefined,
  offered: boolean,
): T[] {
  if (offered) return tools;
  allowedToolNames?.delete(EVALUATION_WORKSPACE_TOOL);
  return tools.filter((t) => t.function?.name !== EVALUATION_WORKSPACE_TOOL);
}
