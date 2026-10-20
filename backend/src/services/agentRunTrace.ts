/**
 * Step-by-step trace of one AgentRun for the admin inspector: the ask, the work-plan steps with
 * the tool calls that served each one, every call's arguments and result, and the final reply.
 *
 * Built from the chat rows (AW-ChatSessions.workPlan + AW-ChatMessages), not the spine: the spine
 * has no arguments or results. Read-only and bounded: every text field is capped and redacted
 * (secret-named keys in arguments; credentials, secret key/value pairs and opaque tokens in text),
 * and the model's reasoning and memory telemetry are never included.
 */

import { SECRET_KEY_PATTERN } from '../loops/instances/agent-mode/runRecorder';

export const TRACE_LIMITS = {
  askChars: 4000,
  followUpChars: 1000,
  maxFollowUps: 5,
  stepDescriptionChars: 500,
  stepNotesChars: 1500,
  argsPreviewChars: 200,
  argsJsonChars: 8000,
  resultChars: 6000,
  degradedResultChars: 1500,
  errorChars: 500,
  finalResponseChars: 60_000,
  maxCalls: 200,
  /** Above this many result characters in total, every result is cut to degradedResultChars. */
  resultBudgetChars: 300_000,
} as const;

/** Window slack around the run's start/end, for rows written a moment before or after the spine events. */
const WINDOW_SLACK_MS = 5_000;

/** Tools that manage the plan itself; before the first real work they are setup, not a step. */
const PLAN_SETUP_TOOLS = new Set(['launch_predefined_work_plan', 'manage_predefined_work_plan', 'create_work_plan', 'update_work_plan']);
const STEP_STATUS_TOOL = 'set_work_plan_status';
const CLOSING_STATUSES = new Set(['completed', 'skipped', 'failed']);
const TOOL_ERROR_PREFIX = /^\s*(?:⚠️\s*)?Tool Error\b/i;

export type TraceCallStatus = 'succeeded' | 'failed' | 'no_result';

export interface AgentRunTraceCall {
  id: string;
  index: number;
  name: string;
  argsPreview: string;
  argsJson: string;
  argsTruncated: boolean;
  status: TraceCallStatus;
  durationMs?: number;
  endedAt?: string;
  result?: string;
  resultChars: number;
  resultTruncated: boolean;
  error?: string;
  /** For a failed call: the id of a later call to the same tool that succeeded. */
  recoveredByCallId?: string;
}

export interface AgentRunTraceStep {
  stepCount: number;
  title: string;
  description?: string;
  status: string;
  notes?: string;
  completedAt?: string;
  callIds: string[];
  /** The set_work_plan_status call that closed the step, if one is in the trace. */
  statusCallId?: string;
  /** Closed by a status update with no work of its own since the previous update. */
  closedWithoutCalls: boolean;
}

export interface AgentRunTrace {
  sessionId: string;
  found: boolean;
  ask?: { text: string; truncated: boolean };
  followUpAsks: string[];
  workPlan?: { title?: string; steps: AgentRunTraceStep[] };
  /**
   * 'run' when this run is the session's latest activity. 'session' when the session ran again
   * afterwards: the session keeps only its current plan, so the step titles, notes and statuses
   * may come from a later run. Call attribution is always this run's own.
   */
  workPlanScope?: 'run' | 'session';
  setupCallIds: string[];
  /** Calls after the last step update (or every call, when the session has no work plan). */
  unassignedCallIds: string[];
  calls: AgentRunTraceCall[];
  callsTruncated: boolean;
  resultsDegraded: boolean;
  usage?: { promptTokens: number; completionTokens: number; estimatedCostUsd: number };
  finalResponse?: { html: string; truncated: boolean };
}

export interface TraceSessionRow {
  sessionId?: string;
  workPlan?: {
    title?: string;
    steps?: Array<{ stepCount?: number; title?: string; description?: string; status?: string; notes?: string; completedAt?: string }>;
  };
}

export interface TraceMessageRow {
  messageIndex?: number;
  message?: Record<string, unknown>;
}

interface NormalizedMessage {
  index: number;
  role?: string;
  content: unknown;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  toolCallId?: string;
  metaToolCalls: Array<{ id?: string; duration?: number; error?: unknown }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; estimated_cost?: number };
  ts?: string;
}

export function buildAgentRunTrace(input: {
  sessionId: string;
  session?: TraceSessionRow | null;
  messages: TraceMessageRow[];
  startedAt?: string;
  completedAt?: string;
}): AgentRunTrace {
  const all = [...input.messages]
    .sort((a, b) => (a.messageIndex ?? 0) - (b.messageIndex ?? 0))
    .map(normalizeMessage);
  const inRun = withinRunWindow(all, input.startedAt, input.completedAt);
  const lastInRun = inRun[inRun.length - 1]?.index ?? -1;
  const sessionRanLater = all.some((m) => m.index > lastInRun && m.role !== 'system');

  const userTexts = inRun.filter((m) => m.role === 'user').map((m) => textOf(m.content)).filter((t): t is string => !!t);
  const askText = userTexts[0];
  const followUpAsks = [...new Set(userTexts.slice(1).filter((t) => t !== askText))]
    .slice(0, TRACE_LIMITS.maxFollowUps)
    .map((t) => capRedacted(t, TRACE_LIMITS.followUpChars).text);

  const { calls, rawArgs, truncated: callsTruncated, degraded } = buildCalls(inRun);
  const steps = input.session?.workPlan?.steps?.length ? buildSteps(input.session.workPlan.steps, calls, rawArgs) : undefined;

  const assistantWithText = inRun.filter((m) => m.role === 'assistant' && textOf(m.content));
  const lastReply = assistantWithText[assistantWithText.length - 1];
  const finalText = lastReply ? textOf(lastReply.content) : undefined;

  return {
    sessionId: input.sessionId,
    found: Boolean(input.session || all.length),
    ...(askText ? { ask: capRedacted(askText, TRACE_LIMITS.askChars) } : {}),
    followUpAsks,
    ...(steps ? { workPlan: { title: input.session?.workPlan?.title, steps: steps.steps }, workPlanScope: sessionRanLater ? 'session' : 'run' } : {}),
    setupCallIds: steps?.setupCallIds ?? [],
    unassignedCallIds: steps ? steps.unassignedCallIds : calls.map((c) => c.id),
    calls,
    callsTruncated,
    resultsDegraded: degraded,
    ...usageOf(inRun),
    ...(finalText ? { finalResponse: (({ text, truncated }) => ({ html: text, truncated }))(capRedacted(finalText, TRACE_LIMITS.finalResponseChars)) } : {}),
  };
}

function normalizeMessage(row: TraceMessageRow): NormalizedMessage {
  // Older rows store the message fields on the row itself, with no `message` wrapper.
  const m = (row.message ?? row) as Record<string, any>;
  const metadata = (m.metadata ?? {}) as Record<string, any>;
  const toolCalls = Array.isArray(m.tool_calls)
    ? m.tool_calls
        .map((tc: any) => ({
          id: String(tc?.id ?? ''),
          name: String(tc?.function?.name ?? tc?.name ?? ''),
          arguments: typeof tc?.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc?.function?.arguments ?? {}),
        }))
        .filter((tc: { id: string; name: string }) => tc.id && tc.name)
    : [];
  return {
    index: row.messageIndex ?? 0,
    role: typeof m.role === 'string' ? m.role : undefined,
    content: m.content,
    toolCalls,
    toolCallId: typeof m.tool_call_id === 'string' ? m.tool_call_id : undefined,
    metaToolCalls: Array.isArray(metadata.toolCalls) ? metadata.toolCalls : [],
    usage: m.usage && typeof m.usage === 'object' ? m.usage : undefined,
    ts: firstString(metadata.timestamp, m.timestamp),
  };
}

/**
 * The messages of one run. Assistant rows carry no timestamp, so each row takes the last
 * timestamp seen before it. The run starts at its first user message inside the (slack-widened)
 * start, and ends at its completion plus slack or at the next user message after its completion,
 * whichever comes first, so back-to-back runs a second apart never bleed into each other. Without
 * a run window, or with no timestamps at all, every row is in.
 */
function withinRunWindow(messages: NormalizedMessage[], startedAt?: string, completedAt?: string): NormalizedMessage[] {
  const start = startedAt ? Date.parse(startedAt) - WINDOW_SLACK_MS : NaN;
  const completed = completedAt ? Date.parse(completedAt) : NaN;
  const end = Number.isFinite(completed) ? completed + WINDOW_SLACK_MS : NaN;
  if (!Number.isFinite(start) || !messages.some((m) => m.ts)) return messages;
  const inWindow: NormalizedMessage[] = [];
  let carried: number | undefined;
  for (const m of messages) {
    const own = m.ts ? Date.parse(m.ts) : NaN;
    if (Number.isFinite(own)) carried = own;
    if (carried === undefined || m.role === 'system' || carried < start) continue;
    if (Number.isFinite(end) && carried > end) break;
    if (m.role === 'user' && Number.isFinite(completed) && carried > completed) break;
    inWindow.push(m);
  }
  const firstAsk = inWindow.findIndex((m) => m.role === 'user');
  return firstAsk > 0 ? inWindow.slice(firstAsk) : inWindow;
}

function buildCalls(messages: NormalizedMessage[]): { calls: AgentRunTraceCall[]; rawArgs: Map<string, string>; truncated: boolean; degraded: boolean } {
  // Providers can reuse a tool-call id within a run, so results and timings are paired with calls
  // in message order (first unanswered call with that id), and repeated ids get a #n suffix.
  const issued: Array<{ id: string; name: string; arguments: string; result?: { content: string; ts?: string }; meta?: { duration?: number; error?: unknown } }> = [];
  const pendingResult = new Map<string, number[]>();
  const pendingMeta = new Map<string, number[]>();
  const seen = new Map<string, number>();
  for (const m of messages) {
    for (const tc of m.toolCalls) {
      const n = seen.get(tc.id) ?? 0;
      seen.set(tc.id, n + 1);
      const position = issued.push({ ...tc, id: n ? `${tc.id}#${n + 1}` : tc.id }) - 1;
      pendingResult.set(tc.id, [...(pendingResult.get(tc.id) ?? []), position]);
      pendingMeta.set(tc.id, [...(pendingMeta.get(tc.id) ?? []), position]);
    }
    if (m.role === 'tool' && m.toolCallId) {
      const position = pendingResult.get(m.toolCallId)?.shift();
      if (position !== undefined) issued[position].result = { content: textOf(m.content, false) ?? '', ts: m.ts };
    }
    for (const meta of m.metaToolCalls) {
      const position = meta?.id ? pendingMeta.get(String(meta.id))?.shift() : undefined;
      if (position !== undefined) issued[position].meta = meta;
    }
  }

  const truncated = issued.length > TRACE_LIMITS.maxCalls;
  const totalResultChars = issued.slice(0, TRACE_LIMITS.maxCalls).reduce((n, tc) => n + (tc.result?.content.length ?? 0), 0);
  const degraded = totalResultChars > TRACE_LIMITS.resultBudgetChars;
  const resultCap = degraded ? TRACE_LIMITS.degradedResultChars : TRACE_LIMITS.resultChars;

  const calls: AgentRunTraceCall[] = issued.slice(0, TRACE_LIMITS.maxCalls).map((tc, index) => {
    const result = tc.result;
    const m = tc.meta;
    const metaError = errorText(m?.error);
    const resultIsError = !!result && TOOL_ERROR_PREFIX.test(result.content);
    const status: TraceCallStatus = metaError || resultIsError ? 'failed' : result ? 'succeeded' : 'no_result';
    const args = redactedArgs(tc.arguments);
    const shownResult = result ? capRedacted(result.content, resultCap) : undefined;
    const error = metaError ?? (resultIsError ? reasonOf(result!.content) : undefined);
    return {
      id: tc.id,
      index,
      name: tc.name,
      argsPreview: args.preview,
      argsJson: args.json,
      argsTruncated: args.truncated,
      status,
      ...(typeof m?.duration === 'number' ? { durationMs: m.duration } : {}),
      ...(result?.ts ? { endedAt: result.ts } : {}),
      ...(shownResult ? { result: shownResult.text } : {}),
      resultChars: result?.content.length ?? 0,
      resultTruncated: shownResult?.truncated ?? false,
      ...(error ? { error: capRedacted(error, TRACE_LIMITS.errorChars).text } : {}),
    };
  });

  for (const call of calls) {
    if (call.status !== 'failed') continue;
    const recovery = calls.find((c) => c.index > call.index && c.name === call.name && c.status === 'succeeded');
    if (recovery) call.recoveredByCallId = recovery.id;
  }
  return { calls, rawArgs: new Map(issued.map((tc) => [tc.id, tc.arguments])), truncated, degraded };
}

/**
 * Attributes calls to steps. A successful set_work_plan_status call that marks steps completed /
 * skipped / failed closes a segment: the calls since the previous update, and the update itself,
 * belong to the lowest step it closes. Plan-management calls before any real work are setup;
 * calls after the last update stay unassigned.
 */
function buildSteps(
  rawSteps: NonNullable<NonNullable<TraceSessionRow['workPlan']>['steps']>,
  calls: AgentRunTraceCall[],
  rawArgs: Map<string, string>,
): { steps: AgentRunTraceStep[]; setupCallIds: string[]; unassignedCallIds: string[] } {
  const steps: AgentRunTraceStep[] = rawSteps.map((s, i) => ({
    stepCount: typeof s.stepCount === 'number' ? s.stepCount : i + 1,
    title: s.title?.trim() || `Step ${i + 1}`,
    ...(s.description ? { description: capRedacted(s.description, TRACE_LIMITS.stepDescriptionChars).text } : {}),
    status: s.status || 'pending',
    ...(s.notes ? { notes: capRedacted(s.notes, TRACE_LIMITS.stepNotesChars).text } : {}),
    ...(s.completedAt ? { completedAt: s.completedAt } : {}),
    callIds: [],
    closedWithoutCalls: false,
  }));
  const byCount = new Map(steps.map((s) => [s.stepCount, s]));

  const setupCallIds: string[] = [];
  let segment: string[] = [];
  let workStarted = false;
  for (const call of calls) {
    if (call.name === STEP_STATUS_TOOL) {
      const closed = closedStepCounts(rawArgs.get(call.id) ?? '').filter((n) => byCount.has(n)).sort((a, b) => a - b);
      // An update that closes nothing (in progress, an unknown step, a failed call) is part of the
      // current segment like any other call, so every call in the trace shows in exactly one group.
      if (!closed.length || call.status === 'failed') {
        workStarted = true;
        segment.push(call.id);
        continue;
      }
      const owner = byCount.get(closed[0])!;
      owner.closedWithoutCalls = segment.length === 0;
      owner.callIds.push(...segment, call.id);
      owner.statusCallId = call.id;
      for (const n of closed.slice(1)) {
        const other = byCount.get(n)!;
        other.statusCallId = call.id;
        other.closedWithoutCalls = true;
      }
      segment = [];
      workStarted = true;
      continue;
    }
    if (!workStarted && PLAN_SETUP_TOOLS.has(call.name)) {
      setupCallIds.push(call.id);
      continue;
    }
    workStarted = true;
    segment.push(call.id);
  }
  return { steps, setupCallIds, unassignedCallIds: segment };
}

function closedStepCounts(rawArgs: string): number[] {
  try {
    const parsed = JSON.parse(rawArgs) as { updates?: Array<{ stepCount?: unknown; status?: unknown }> };
    return (parsed.updates ?? [])
      .filter((u) => typeof u.stepCount === 'number' && typeof u.status === 'string' && CLOSING_STATUSES.has(u.status))
      .map((u) => u.stepCount as number);
  } catch {
    return [];
  }
}

function usageOf(messages: NormalizedMessage[]): Pick<AgentRunTrace, 'usage'> {
  let prompt = 0;
  let completion = 0;
  let cost = 0;
  let any = false;
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.usage) continue;
    any = true;
    prompt += num(m.usage.prompt_tokens);
    completion += num(m.usage.completion_tokens);
    cost += num(m.usage.estimated_cost);
  }
  return any ? { usage: { promptTokens: prompt, completionTokens: completion, estimatedCostUsd: Math.round(cost * 1e6) / 1e6 } } : {};
}

/** Arguments as redacted JSON (secret-named keys masked at any depth) plus a one-line preview. */
function redactedArgs(raw: string): { json: string; preview: string; truncated: boolean } {
  let json: string;
  let preview: string;
  try {
    const redacted = JSON.parse(JSON.stringify(JSON.parse(raw || '{}'), (key, value) => (key && isSecretKey(key) ? '[redacted]' : value)));
    json = JSON.stringify(redacted, null, 2);
    preview = redacted && typeof redacted === 'object' && !Array.isArray(redacted)
      ? Object.entries(redacted).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')
      : json;
  } catch {
    json = raw;
    preview = raw;
  }
  const capped = capRedacted(json, TRACE_LIMITS.argsJsonChars);
  return {
    json: capped.text,
    preview: capRedacted(preview.replace(/\s+/g, ' ').trim(), TRACE_LIMITS.argsPreviewChars).text,
    truncated: capped.truncated,
  };
}

const TOKEN_COUNT_KEY = /^(?:max|total|prompt|completion|input|output)[_-]?tokens$/i;
const EXTRA_SECRET_KEY = /cookie|jwt|session[_-]?(?:token|key)|signature|access[_-]?key/i;

function isSecretKey(key: string): boolean {
  return !TOKEN_COUNT_KEY.test(key) && (SECRET_KEY_PATTERN.test(key) || EXTRA_SECRET_KEY.test(key));
}

/** `key=value`, `key: value`, `"key": "value"` and `Header-Name: value` where the key names a secret. */
const SECRET_PAIR =
  /(["']?)([\w-]*(?:token(?!s\b)|secret|password|passwd|api[_-]?key|apikey|authorization|credential|private[_-]?key|cookie|jwt|session[_-]?(?:token|key)|signature|access[_-]?key)[\w-]*)\1(\s*[=:]\s*)(["']?)(?:(?:Bearer|Basic|Token)\s+)?([^\s"'&,;}]+)\4/gi;
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/]+=*/g;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'<>]+:[^\s/@"'<>]+@/gi;
const SECRET_URL_PATHS = /(hooks\.slack\.com\/(?:services|workflows|triggers)\/|discord(?:app)?\.com\/api\/webhooks\/)[^\s"'<>]+/gi;
/** URL paths, UUIDs, and word-like names (short parts joined by _ or -, e.g. Meta_Ads_Perf_Report). */
const READABLE_IDS =
  /https?:\/\/[^\s"'<>?]+|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(?:[A-Za-z0-9]{1,15}[-_]){2,}[A-Za-z0-9]{1,15}\b/gi;
/** 24+ token characters with at least one digit: random secrets have digits, camelCase names do not. */
const OPAQUE_TOKEN = /\b(?=[A-Za-z\-_]*\d)[A-Za-z0-9\-_]{24,}(?:\.[A-Za-z0-9\-_]{10,}){0,2}\b/g;

/**
 * Masks credentials in free text. The explicit passes run first on the raw text (URL user:password,
 * secret-bearing webhook URLs, auth schemes, secret key/value pairs); only then are URL paths,
 * UUIDs and word-like names shielded from the last, heuristic pass that masks long opaque tokens.
 * Without that shield every S3 key, session id and plan title would be masked; shielding before
 * the explicit passes would let `X-Api-Key: <uuid>` or `Bearer pat-<uuid>` through.
 */
export function redactText(text: string): string {
  const explicit = text
    .replace(URL_USERINFO, '$1[REDACTED]@')
    .replace(SECRET_URL_PATHS, '$1[REDACTED]')
    .replace(SECRET_PAIR, '$1$2$1$3$4[REDACTED]$4')
    .replace(AUTH_SCHEME, '$1 [REDACTED]');
  const kept: string[] = [];
  const shielded = explicit.replace(READABLE_IDS, (match) => `\u0000${kept.push(match) - 1}\u0000`);
  return shielded.replace(OPAQUE_TOKEN, '[REDACTED]').replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)] ?? '');
}

/** Cap, redact, cap again: regexes never run over a multi-megabyte result, and a mask never grows the text past the cap. */
function capRedacted(text: string, max: number): { text: string; truncated: boolean } {
  const redacted = redactText(text.length > max + 512 ? text.slice(0, max + 512) : text);
  return { text: redacted.slice(0, max), truncated: text.length > max || redacted.length > max };
}

function reasonOf(content: string): string {
  const match = content.match(/Reason:\s*([\s\S]*)/i);
  return (match ? match[1] : content.replace(TOOL_ERROR_PREFIX, '')).trim();
}

function errorText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return undefined;
}

function textOf(content: unknown, trim = true): string | undefined {
  let text: string | undefined;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((block) => (typeof block === 'string' ? block : typeof (block as any)?.text === 'string' ? (block as any).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (text === undefined) return undefined;
  return trim ? text.trim() || undefined : text;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === 'string' && v.length > 0);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
