export const AGENT_RUNS_PATH = "/agent-runs";

type AgentRunInspectorFilters = {
  runId?: string;
  sessionId?: string;
  userId?: string;
};

export function buildAgentRunInspectorUrl(filters: AgentRunInspectorFilters = {}): string {
  const params = new URLSearchParams();

  if (filters.runId?.trim()) params.set("runId", filters.runId.trim());
  if (filters.sessionId?.trim()) params.set("sessionId", filters.sessionId.trim());
  if (filters.userId?.trim()) params.set("userId", filters.userId.trim());

  const queryString = params.toString();
  return queryString ? `${AGENT_RUNS_PATH}?${queryString}` : AGENT_RUNS_PATH;
}
