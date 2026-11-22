/**
 * Post-save routing for the workflow builder (ENG-2401).
 *
 * The builder is mounted at `/workflows/new` (no `:id` param) and
 * `/workflows/:id/edit`. After the first save of a new workflow the user must
 * land on the registered edit route for the saved record. The create API
 * (`POST /api/workflows`) returns the persisted Workflow, whose key is
 * `workflowId`; `id` is accepted as a fallback.
 */
export function isNewWorkflowRoute(id: string | undefined): boolean {
  return !id || id === 'new';
}

export function savedWorkflowEditPath(
  saved: { workflowId?: string; id?: string } | null | undefined,
): string | null {
  const savedId = saved?.workflowId || saved?.id;
  if (!savedId || savedId === 'new') return null;
  return `/workflows/${encodeURIComponent(savedId)}/edit`;
}
