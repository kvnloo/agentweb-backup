import {
  EVT_DECISION,
  EVT_RUN_COMPLETED,
  EVT_RUN_FAILED,
  EVT_RUN_STARTED,
  EVT_TOOL_FAILED,
  EVT_TOOL_INVOKED,
  EVT_TOOL_SUCCEEDED,
} from '../loops/instances/agent-mode/eventTypes';

export interface AgentRunEventRow {
  eventType: string;
  subjectId: string;
  ts: string;
  dimensions?: Record<string, string | number | boolean | null>;
}

export interface AgentRunDecisionSummary {
  ts: string;
  iteration?: number;
  toolNames: string[];
  toolArgKeys?: string;
  toolArgsPreview?: string;
  decisionExplanation?: string;
  explanationSource?: string;
}

export interface AgentRunToolOutcomeSummary {
  ts: string;
  eventType: typeof EVT_TOOL_INVOKED | typeof EVT_TOOL_SUCCEEDED | typeof EVT_TOOL_FAILED;
  iteration?: number;
  toolName?: string;
  durationMs?: number;
  errorClass?: string;
  errorMessage?: string;
}

export interface AgentRunSummary {
  runId: string;
  sessionId?: string;
  userId?: string;
  llmModel?: string;
  sessionType?: string;
  startedAt?: string;
  completedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  toolCalls: number;
  failedToolCalls: number;
  decisions: AgentRunDecisionSummary[];
  outcomes: AgentRunToolOutcomeSummary[];
  events: AgentRunEventRow[];
}

export function buildAgentRunSummaries(rows: AgentRunEventRow[]): AgentRunSummary[] {
  const byRun = new Map<string, AgentRunEventRow[]>();
  for (const row of rows) {
    if (!row.subjectId) continue;
    const bucket = byRun.get(row.subjectId) ?? [];
    bucket.push(row);
    byRun.set(row.subjectId, bucket);
  }

  return [...byRun.entries()]
    .map(([runId, events]) => buildOneRunSummary(runId, events))
    .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
}

function buildOneRunSummary(runId: string, events: AgentRunEventRow[]): AgentRunSummary {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  const runStarted = sorted.find((e) => e.eventType === EVT_RUN_STARTED);
  const runCompleted = [...sorted].reverse().find((e) => e.eventType === EVT_RUN_COMPLETED);
  const runFailed = [...sorted].reverse().find((e) => e.eventType === EVT_RUN_FAILED);
  const firstWithDims = sorted.find((e) => e.dimensions?.sessionId || e.dimensions?.userId || e.dimensions?.llmModel);
  const terminal = runFailed ?? runCompleted;

  const decisions: AgentRunDecisionSummary[] = sorted
    .filter((e) => e.eventType === EVT_DECISION)
    .map((e) => ({
      ts: e.ts,
      iteration: asNumber(e.dimensions?.iteration),
      toolNames: splitToolNames(e.dimensions?.toolNames),
      toolArgKeys: asString(e.dimensions?.toolArgKeys),
      toolArgsPreview: asString(e.dimensions?.toolArgsPreview),
      decisionExplanation: asString(e.dimensions?.decisionExplanation),
      explanationSource: asString(e.dimensions?.explanationSource),
    }));

  const outcomes: AgentRunToolOutcomeSummary[] = sorted
    .filter((e) =>
      e.eventType === EVT_TOOL_INVOKED ||
      e.eventType === EVT_TOOL_SUCCEEDED ||
      e.eventType === EVT_TOOL_FAILED
    )
    .map((e) => ({
      ts: e.ts,
      eventType: e.eventType as AgentRunToolOutcomeSummary['eventType'],
      iteration: asNumber(e.dimensions?.iteration),
      toolName: asString(e.dimensions?.toolName),
      durationMs: asNumber(e.dimensions?.durationMs),
      errorClass: asString(e.dimensions?.errorClass),
      errorMessage: asString(e.dimensions?.errorMessage),
    }));

  return {
    runId,
    sessionId: asString(firstWithDims?.dimensions?.sessionId),
    userId: asString(runStarted?.dimensions?.userId ?? firstWithDims?.dimensions?.userId),
    llmModel: asString(runStarted?.dimensions?.llmModel ?? firstWithDims?.dimensions?.llmModel),
    sessionType: asString(runStarted?.dimensions?.sessionType),
    startedAt: runStarted?.ts ?? sorted[0]?.ts,
    completedAt: terminal?.ts,
    status: runFailed ? 'failed' : runCompleted ? 'completed' : runStarted ? 'running' : 'unknown',
    toolCalls: asNumber(terminal?.dimensions?.toolCalls) ?? outcomes.filter((o) => o.eventType === EVT_TOOL_INVOKED).length,
    failedToolCalls: asNumber(terminal?.dimensions?.failedToolCalls) ?? outcomes.filter((o) => o.eventType === EVT_TOOL_FAILED).length,
    decisions,
    outcomes,
    events: sorted,
  };
}

function splitToolNames(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return [];
  return value.split(',').map((name) => name.trim()).filter(Boolean);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
