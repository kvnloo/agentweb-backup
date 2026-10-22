/**
 * ENG-669 PR-C: the AgentWeb Model (`agentweb-model`) is a router: AgentWeb picks the concrete model per chat turn.
 * GET /api/agent-mode/public/llm-models lists it (for the work-plan step-model picker, where a pin routes per turn),
 * but it can never run where a single concrete model is needed: a benchmark run (it calls the model directly) or a
 * configured default model (the default stands in when nothing was chosen). Those pickers drop it.
 */
export const AGENTWEB_MODEL_ID = 'agentweb-model';

/** The list without the AgentWeb Model, whether entries are ids or catalog objects ({ id }). */
export function withoutAgentWebModel<T>(models: readonly T[]): T[] {
  return models.filter((model) => {
    const id = typeof model === 'string' ? model : (model as { id?: unknown } | null)?.id;
    return id !== AGENTWEB_MODEL_ID;
  });
}
