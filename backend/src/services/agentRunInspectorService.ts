import {
  EVT_DECISION,
  EVT_RUN_COMPLETED,
  EVT_RUN_FAILED,
  EVT_RUN_STARTED,
  EVT_RUN_VERDICT,
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
  toolPolicyFlags?: string;
  toolPolicySummary?: string;
}

export interface AgentRunToolOutcomeSummary {
  ts: string;
  eventType: typeof EVT_TOOL_INVOKED | typeof EVT_TOOL_SUCCEEDED | typeof EVT_TOOL_FAILED;
  iteration?: number;
  toolName?: string;
  durationMs?: number;
  errorClass?: string;
  errorMessage?: string;
  /** Full args of a FAILED call (capped + redacted at write time) — root-cause material. */
  failedArgsJson?: string;
}

export interface AgentRunChatContext {
  found: boolean;
  sessionId: string;
  title?: string;
  portalType?: string;
  pageIdentifier?: string;
  sessionType?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount: number;
  firstUserMessage?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  customerPortalUrl?: string;
}

export interface AgentRunChatSessionRow {
  sessionId?: string;
  title?: string;
  portalType?: string;
  pageIdentifier?: string;
  sessionType?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
}

export interface AgentRunChatMessageRow {
  messageIndex?: number;
  message?: {
    role?: string;
    content?: unknown;
  };
  role?: string;
  content?: unknown;
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
  durationMs?: number;
  /** Durable outcome verdict from the agent_run_verdict spine event. */
  outcomeVerdict?: 'ok' | 'degraded' | 'failed';
  outcomeReasons?: string;
  flags: AgentRunFlagSummary[];
  decisions: AgentRunDecisionSummary[];
  outcomes: AgentRunToolOutcomeSummary[];
  events: AgentRunEventRow[];
  chat?: AgentRunChatContext;
}

export interface AgentRunFlagSummary {
  code: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  evidence?: string;
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

export function buildAgentRunChatContext(input: {
  sessionId: string;
  session?: AgentRunChatSessionRow | null;
  messages?: AgentRunChatMessageRow[];
  customerPortalBaseUrl?: string;
}): AgentRunChatContext {
  const messages = [...(input.messages ?? [])].sort((a, b) => (a.messageIndex ?? 0) - (b.messageIndex ?? 0));
  const normalized = messages
    .map((row) => {
      const message = row.message ?? row;
      return {
        role: typeof message.role === 'string' ? message.role : undefined,
        content: summarizeMessageContent(message.content),
      };
    })
    .filter((message) => message.role && message.content);

  const userMessages = normalized.filter((message) => message.role === 'user');
  const assistantMessages = normalized.filter((message) => message.role === 'assistant');
  const messageCount = input.session?.messageCount ?? messages.length;
  const baseUrl = trimTrailingSlash(input.customerPortalBaseUrl);

  return {
    found: Boolean(input.session || messages.length),
    sessionId: input.sessionId,
    title: cleanSessionTitle(input.session?.title),
    portalType: input.session?.portalType,
    pageIdentifier: input.session?.pageIdentifier,
    sessionType: input.session?.sessionType,
    createdAt: input.session?.createdAt,
    updatedAt: input.session?.updatedAt,
    messageCount,
    firstUserMessage: userMessages[0]?.content,
    lastUserMessage: userMessages[userMessages.length - 1]?.content,
    lastAssistantMessage: assistantMessages[assistantMessages.length - 1]?.content,
    customerPortalUrl: baseUrl ? `${baseUrl}/agent-mode/${encodeURIComponent(input.sessionId)}` : undefined,
  };
}

function buildOneRunSummary(runId: string, events: AgentRunEventRow[]): AgentRunSummary {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  const runStarted = sorted.find((e) => e.eventType === EVT_RUN_STARTED);
  const runCompleted = [...sorted].reverse().find((e) => e.eventType === EVT_RUN_COMPLETED);
  const runFailed = [...sorted].reverse().find((e) => e.eventType === EVT_RUN_FAILED);
  const firstWithDims = sorted.find((e) => e.dimensions?.sessionId || e.dimensions?.userId || e.dimensions?.llmModel);
  const terminal = runFailed ?? runCompleted;
  const verdictEvent = [...sorted].reverse().find((e) => e.eventType === EVT_RUN_VERDICT);
  const outcomeVerdict = asVerdict(verdictEvent?.dimensions?.verdict);
  const outcomeReasons = asString(verdictEvent?.dimensions?.reasons);

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
      toolPolicyFlags: asString(e.dimensions?.toolPolicyFlags),
      toolPolicySummary: asString(e.dimensions?.toolPolicySummary),
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
      failedArgsJson: asString(e.dimensions?.failedArgsJson),
    }));

  const startedAt = runStarted?.ts ?? sorted[0]?.ts;
  const completedAt = terminal?.ts;
  const toolCalls = asNumber(terminal?.dimensions?.toolCalls) ?? outcomes.filter((o) => o.eventType === EVT_TOOL_INVOKED).length;
  const failedToolCalls = asNumber(terminal?.dimensions?.failedToolCalls) ?? outcomes.filter((o) => o.eventType === EVT_TOOL_FAILED).length;
  const status = runFailed ? 'failed' : runCompleted ? 'completed' : runStarted ? 'running' : 'unknown';
  const durationMs = durationBetween(startedAt, completedAt);

  return {
    runId,
    sessionId: asString(firstWithDims?.dimensions?.sessionId),
    userId: asString(runStarted?.dimensions?.userId ?? firstWithDims?.dimensions?.userId),
    llmModel: asString(runStarted?.dimensions?.llmModel ?? firstWithDims?.dimensions?.llmModel),
    sessionType: asString(runStarted?.dimensions?.sessionType),
    startedAt,
    completedAt,
    status,
    toolCalls,
    failedToolCalls,
    durationMs,
    outcomeVerdict,
    outcomeReasons,
    flags: buildRunFlags({ status, toolCalls, failedToolCalls, durationMs, decisions, outcomes, outcomeVerdict, outcomeReasons }),
    decisions,
    outcomes,
    events: sorted,
  };
}

function buildRunFlags(input: {
  status: AgentRunSummary['status'];
  toolCalls: number;
  failedToolCalls: number;
  durationMs?: number;
  decisions: AgentRunDecisionSummary[];
  outcomes: AgentRunToolOutcomeSummary[];
  outcomeVerdict?: AgentRunSummary['outcomeVerdict'];
  outcomeReasons?: string;
}): AgentRunFlagSummary[] {
  const flags: AgentRunFlagSummary[] = [];

  if (input.outcomeVerdict === 'degraded') {
    flags.push({
      code: 'degraded_run',
      severity: 'warning',
      message: `Run completed but degraded: ${input.outcomeReasons || 'see verdict event'}.`,
    });
  }

  if (input.status === 'failed') {
    flags.push({
      code: 'run_failed',
      severity: 'critical',
      message: 'The AgentRun ended in a failed terminal state.',
    });
  }

  if (input.failedToolCalls > 0) {
    flags.push({
      code: 'failed_tool_calls',
      severity: 'critical',
      message: `${input.failedToolCalls} tool call(s) failed during this run.`,
    });
  }

  if (input.toolCalls >= 12) {
    flags.push({
      code: 'high_tool_volume',
      severity: 'warning',
      message: `This run used ${input.toolCalls} tool calls. Review whether planning or batching can be tightened.`,
    });
  }

  if (input.durationMs != null && input.durationMs >= 90_000) {
    flags.push({
      code: 'long_run',
      severity: input.durationMs >= 180_000 ? 'warning' : 'info',
      message: `This run took ${Math.round(input.durationMs / 1000)} seconds.`,
    });
  }

  for (const [toolName, count] of toolInvocationCounts(input.outcomes)) {
    if (count >= 5) {
      flags.push({
        code: 'repeated_tool',
        severity: 'warning',
        message: `${toolName} was invoked ${count} times in this run.`,
        evidence: toolName,
      });
    }
  }

  for (const decision of input.decisions) {
    for (const policyFlag of parsePolicyFlags(decision.toolPolicyFlags)) {
      if (policyFlag.severity === 'info') continue;
      flags.push({
        code: policyFlag.code,
        severity: policyFlag.severity,
        message: `Tool Gateway flagged ${policyFlag.toolName}: ${policyFlag.code}.`,
        evidence: policyFlag.toolName,
      });
    }
  }

  return dedupeFlags(flags);
}

function toolInvocationCounts(outcomes: AgentRunToolOutcomeSummary[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) {
    if (outcome.eventType !== EVT_TOOL_INVOKED || !outcome.toolName) continue;
    counts.set(outcome.toolName, (counts.get(outcome.toolName) ?? 0) + 1);
  }
  return counts;
}

function parsePolicyFlags(raw: string | undefined): Array<{ toolName: string; code: string; severity: AgentRunFlagSummary['severity'] }> {
  if (!raw) return [];
  return raw.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [toolName = 'unknown', code = 'policy_flag', severity = 'warning'] = entry.split(':');
      return {
        toolName,
        code,
        severity: severity === 'critical' || severity === 'warning' || severity === 'info' ? severity : 'warning',
      };
    });
}

function asVerdict(v: unknown): AgentRunSummary['outcomeVerdict'] {
  return v === 'ok' || v === 'degraded' || v === 'failed' ? v : undefined;
}

function dedupeFlags(flags: AgentRunFlagSummary[]): AgentRunFlagSummary[] {
  const seen = new Set<string>();
  return flags.filter((flag) => {
    const key = `${flag.code}:${flag.severity}:${flag.evidence ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function durationBetween(startedAt: string | undefined, completedAt: string | undefined): number | undefined {
  if (!startedAt || !completedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
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

function cleanSessionTitle(value: string | undefined): string | undefined {
  const title = compactWhitespace(value);
  if (!title || title === 'New Chat Session') return undefined;
  return truncate(title, 140);
}

function summarizeMessageContent(value: unknown): string | undefined {
  if (typeof value === 'string') return truncate(compactWhitespace(value), 360);
  if (Array.isArray(value)) {
    const text = value
      .map((block) => {
        if (typeof block === 'string') return block;
        if (!block || typeof block !== 'object') return '';
        const record = block as Record<string, unknown>;
        if (typeof record.text === 'string') return record.text;
        if (typeof record.content === 'string') return record.content;
        if (typeof record.input === 'string') return record.input;
        return '';
      })
      .filter(Boolean)
      .join(' ');
    return truncate(compactWhitespace(text), 360);
  }
  return undefined;
}

function compactWhitespace(value: string | undefined): string | undefined {
  const compacted = value?.replace(/\s+/g, ' ').trim();
  return compacted || undefined;
}

function truncate(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function trimTrailingSlash(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : undefined;
}
