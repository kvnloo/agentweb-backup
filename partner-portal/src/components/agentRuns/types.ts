export type RunStatus = 'running' | 'completed' | 'failed' | 'unknown';
export type FlagSeverity = 'info' | 'warning' | 'critical';

export interface AgentRunFlag {
  code: string;
  severity: FlagSeverity;
  message: string;
  evidence?: string;
}

export interface AgentRunDecision {
  ts: string;
  iteration?: number;
  toolNames: string[];
  decisionExplanation?: string;
  toolPolicyFlags?: string;
  toolPolicySummary?: string;
  argsRepairedCount?: number;
  schemaErrorCount?: number;
}

export interface AgentRunOutcome {
  ts: string;
  eventType: string;
  iteration?: number;
  toolName?: string;
  durationMs?: number;
  errorClass?: string;
  errorMessage?: string;
  failureType?: string;
}

export interface AgentRunChatContext {
  found: boolean;
  sessionId: string;
  title?: string;
  messageCount: number;
  firstUserMessage?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  customerPortalUrl?: string;
}

export interface AgentRun {
  runId: string;
  sessionId?: string;
  userId?: string;
  llmModel?: string;
  sessionType?: string;
  startedAt?: string;
  completedAt?: string;
  status: RunStatus;
  toolCalls: number;
  failedToolCalls: number;
  deferredToolCalls?: number;
  durationMs?: number;
  outcomeVerdict?: 'ok' | 'degraded' | 'failed';
  outcomeReasons?: string;
  flags: AgentRunFlag[];
  decisions: AgentRunDecision[];
  outcomes: AgentRunOutcome[];
  chat?: AgentRunChatContext;
}

export interface AgentRunsResponse {
  runs: AgentRun[];
  count: number;
  scannedEvents: number;
  truncated?: boolean;
}

/** GET /api/admin/agent-runs/trace (backend services/agentRunTrace.ts). */
export interface TraceCall {
  id: string;
  index: number;
  name: string;
  argsPreview: string;
  argsJson: string;
  argsTruncated: boolean;
  status: 'succeeded' | 'failed' | 'no_result';
  durationMs?: number;
  endedAt?: string;
  result?: string;
  resultChars: number;
  resultTruncated: boolean;
  error?: string;
  recoveredByCallId?: string;
}

export interface TraceStep {
  stepCount: number;
  title: string;
  description?: string;
  status: string;
  notes?: string;
  completedAt?: string;
  callIds: string[];
  statusCallId?: string;
  /** Closed with no work since the previous update other than status updates. */
  closedWithoutCalls: boolean;
}

export interface AgentRunTrace {
  sessionId: string;
  found: boolean;
  ask?: { text: string; truncated: boolean };
  followUpAsks: string[];
  workPlan?: { title?: string; steps: TraceStep[] };
  /** 'session': the session ran again after this run, so step titles/notes/status may be from a later run. */
  workPlanScope?: 'run' | 'session';
  setupCallIds: string[];
  unassignedCallIds: string[];
  calls: TraceCall[];
  callsTruncated: boolean;
  resultsDegraded: boolean;
  messagesTruncated?: boolean;
  usage?: { promptTokens: number; completionTokens: number; estimatedCostUsd: number };
  finalResponse?: { html: string; truncated: boolean };
}
