/**
 * Step-by-step trace of one AgentRun for the admin inspector: the ask, the work-plan steps with
 * the tool calls that served each one, every call's arguments and result, and the final reply.
 *
 * Built from the chat rows (AW-ChatSessions.workPlan + AW-ChatMessages), not the spine: the spine
 * has no arguments or results. Read-only and bounded: every text field is capped and redacted
 * (secret-named keys in arguments; credentials, secret key/value pairs and opaque tokens in text),
 * and the model's reasoning and memory telemetry are never included.
 */

import { cutWithoutSplittingPair } from '../utils/surrogateSafeCut';
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
  timelineUserChars: 1000,
  timelineAgentChars: 800,
  /** Above this many timeline entries, the middle is dropped (the first and last ones are kept). */
  maxTimelineEntries: 400,
  maxCalls: 200,
  /** Above this many result characters in total, every result is cut to degradedResultChars. */
  resultBudgetChars: 300_000,
} as const;

/** Window slack around the run's start/end, for rows written a moment before or after the spine events. */
const WINDOW_SLACK_MS = 5_000;
/**
 * How far before a run's spine start its ask can be stamped: the user message is saved before the
 * job is queued, and queueing, funding and setup can take several seconds.
 */
export const ASK_LOOKBACK_MS = 60_000;

/** Tools that manage the plan itself; before the first real work they are setup, not a step. */
const PLAN_SETUP_TOOLS = new Set(['launch_predefined_work_plan', 'manage_predefined_work_plan', 'create_work_plan', 'update_work_plan']);
const STEP_STATUS_TOOL = 'set_work_plan_status';
const CLOSING_STATUSES = new Set(['completed', 'skipped', 'failed']);
const TOOL_ERROR_PREFIX = /^\s*(?:⚠️\s*)?Tool Error\b/i;
/** set_work_plan_status refusing an update (e.g. "❌ Cannot complete these steps yet") without a Tool Error. */
const STATUS_REFUSED = /^\s*❌/;

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
  /** Closed with no work since the previous update other than status updates. */
  closedWithoutCalls: boolean;
}

/** One entry of the run in order: a user message, an agent message, or a tool call (by id). */
export type TraceTimelineEntry = { kind: 'user' | 'agent'; text: string } | { kind: 'call'; callId: string };

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
  /** Set by the caller that read the messages (routes/agentRuns.ts) when its read cap cut the session. */
  messagesTruncated?: boolean;
  /**
   * Every user and agent message and every call, in order (text capped and redacted). What the
   * labeller reads as the transcript; `followUpAsks` is only the distinct later asks.
   */
  timeline: TraceTimelineEntry[];
  /** How many middle entries were dropped to keep the timeline within maxTimelineEntries. */
  timelineOmitted: number;
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
  /** Start of the session's next run, which bounds a run that has no completion. */
  nextStartedAt?: string;
}): AgentRunTrace {
  const all = [...input.messages]
    .sort((a, b) => (a.messageIndex ?? 0) - (b.messageIndex ?? 0))
    .map(normalizeMessage);
  const { messages: inRun, sessionRanLater } = withinRunWindow(all, input.startedAt, input.completedAt, input.nextStartedAt);

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
    ...buildTimeline(inRun, calls),
    ...usageOf(inRun),
    ...(finalText ? { finalResponse: (({ text, truncated }) => ({ html: text, truncated }))(capRedacted(finalText, TRACE_LIMITS.finalResponseChars)) } : {}),
  };
}

/** A stored row's untyped JSON field as a record; anything else reads as empty. */
const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});

function normalizeMessage(row: TraceMessageRow): NormalizedMessage {
  // Older rows store the message fields on the row itself, with no `message` wrapper.
  const m = asRecord(row.message ?? row);
  const metadata = asRecord(m.metadata);
  const toolCalls = Array.isArray(m.tool_calls)
    ? m.tool_calls
        .map((raw) => {
          const tc = asRecord(raw);
          const fn = asRecord(tc.function);
          return {
            id: String(tc.id ?? ''),
            name: String(fn.name ?? tc.name ?? ''),
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          };
        })
        .filter((tc) => tc.id && tc.name)
    : [];
  return {
    index: row.messageIndex ?? 0,
    role: typeof m.role === 'string' ? m.role : undefined,
    content: m.content,
    toolCalls,
    toolCallId: typeof m.tool_call_id === 'string' ? m.tool_call_id : undefined,
    metaToolCalls: Array.isArray(metadata.toolCalls) ? (metadata.toolCalls as NormalizedMessage['metaToolCalls']) : [],
    usage: m.usage && typeof m.usage === 'object' ? (m.usage as NormalizedMessage['usage']) : undefined,
    ts: firstString(metadata.timestamp, m.timestamp),
  };
}

/** Each row with the last timestamp seen at or before it: assistant rows carry none of their own. */
function carriedTimestamps(messages: NormalizedMessage[]): number[] {
  let carried = NaN;
  return messages.map((m) => {
    const own = m.ts ? Date.parse(m.ts) : NaN;
    if (Number.isFinite(own)) carried = own;
    return carried;
  });
}

/** The run's ask: the last user message stamped in [start - ASK_LOOKBACK_MS, start + slack], after `from`. */
function askPosition(messages: NormalizedMessage[], start: number, from = 0): number {
  let found = -1;
  for (let i = from; i < messages.length; i++) {
    const m = messages[i];
    const own = m.ts ? Date.parse(m.ts) : NaN;
    if (m.role !== 'user' || !Number.isFinite(own)) continue;
    if (own > start + WINDOW_SLACK_MS) break;
    if (own >= start - ASK_LOOKBACK_MS) found = i;
  }
  return found;
}

/**
 * The messages of one run, and whether the session had another run after it.
 *
 * Start: the run's own ask (a user message is saved before its run starts, sometimes many
 * seconds before), else the first row at the slack-widened start. End: the next run's ask when
 * the next run's start is known; else the first user row stamped at or after the completion.
 * Every run, scheduled ones included, opens with a user row; a session's only system row is its
 * first (checked on 40 prod sessions, 2026-10-20), so system rows never mark a run boundary. Every row in between belongs to the run whatever its own timestamp says, so one
 * out-of-order timestamp can't cut a run short. Without a start, or with no timestamps at all,
 * every row is in.
 */
function withinRunWindow(
  messages: NormalizedMessage[],
  startedAt?: string,
  completedAt?: string,
  nextStartedAt?: string,
): { messages: NormalizedMessage[]; sessionRanLater: boolean } {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start) || !messages.some((m) => m.ts)) return { messages, sessionRanLater: false };
  const completed = completedAt ? Date.parse(completedAt) : NaN;
  const nextStart = nextStartedAt ? Date.parse(nextStartedAt) : NaN;
  const carried = carriedTimestamps(messages);

  const ask = askPosition(messages, start);
  let first = ask;
  if (first < 0) first = carried.findIndex((t) => Number.isFinite(t) && t >= start - WINDOW_SLACK_MS);
  if (first < 0) return { messages: [], sessionRanLater: false };

  let stop = messages.length;
  if (Number.isFinite(nextStart)) {
    const nextAsk = askPosition(messages, nextStart, first + 1);
    if (nextAsk > first) stop = nextAsk;
  }
  if (Number.isFinite(completed)) {
    for (let i = first + 1; i < stop; i++) {
      const m = messages[i];
      if (m.role !== 'user') continue;
      // A user row with no timestamp of its own (legacy rows migrated into the table have none)
      // counts as stamped at the last time seen before it.
      const own = m.ts ? Date.parse(m.ts) : NaN;
      const at = Number.isFinite(own) ? own : carried[i];
      if (Number.isFinite(at) && at >= completed) {
        stop = i;
        break;
      }
    }
  }

  const inRun = messages.slice(first, stop).filter((m) => m.role !== 'system');
  const sessionRanLater = messages.slice(stop).some((m) => m.role === 'user');
  return { messages: inRun, sessionRanLater };
}

function buildCalls(messages: NormalizedMessage[]): { calls: AgentRunTraceCall[]; rawArgs: Map<string, string>; truncated: boolean; degraded: boolean } {
  // Providers can reuse a tool-call id within a run, so results and timings are paired with calls
  // in message order (first unanswered call with that id), and repeated ids get a #n suffix.
  const issued: Array<{ id: string; name: string; arguments: string; result?: { content: string; ts?: string }; meta?: { duration?: number; error?: unknown } }> = [];
  const pendingResult = new Map<string, number[]>();
  const pendingMeta = new Map<string, number[]>();
  const used = new Set<string>();
  for (const m of messages) {
    // A tool result answers a call of the latest assistant turn; an unanswered call must not shift
    // later results that reuse its id onto it. Timings come from a run-wide ledger, so they stay queued.
    if (m.toolCalls.length) pendingResult.clear();
    for (const tc of m.toolCalls) {
      let id = tc.id;
      for (let n = 2; used.has(id); n++) id = `${tc.id}#${n}`;
      used.add(id);
      const position = issued.push({ ...tc, id }) - 1;
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
    const resultIsError = !!result && (TOOL_ERROR_PREFIX.test(result.content) || (tc.name === STEP_STATUS_TOOL && STATUS_REFUSED.test(result.content)));
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
 * The run in order. Each assistant message's tool calls map, in order, onto `calls` (built from the
 * same messages in the same order, so the nth issued call is calls[n]); calls past the cap are left
 * out. Over maxTimelineEntries, the middle is dropped and counted.
 */
function buildTimeline(messages: NormalizedMessage[], calls: AgentRunTraceCall[]): { timeline: TraceTimelineEntry[]; timelineOmitted: number } {
  const entries: TraceTimelineEntry[] = [];
  let next = 0;
  for (const m of messages) {
    const text = m.role === 'user' || m.role === 'assistant' ? textOf(m.content) : undefined;
    if (text && m.role === 'user') entries.push({ kind: 'user', text: capRedacted(text, TRACE_LIMITS.timelineUserChars).text });
    if (text && m.role === 'assistant') entries.push({ kind: 'agent', text: capRedacted(text, TRACE_LIMITS.timelineAgentChars).text });
    for (let i = 0; i < m.toolCalls.length; i++) {
      if (next < calls.length) entries.push({ kind: 'call', callId: calls[next].id });
      next += 1;
    }
  }
  const max = TRACE_LIMITS.maxTimelineEntries;
  if (entries.length <= max) return { timeline: entries, timelineOmitted: 0 };
  const head = Math.floor(max * 0.4);
  return { timeline: [...entries.slice(0, head), ...entries.slice(entries.length - (max - head))], timelineOmitted: entries.length - max };
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
  const callById = new Map(calls.map((c) => [c.id, c]));

  const setupCallIds: string[] = [];
  let segment: string[] = [];
  let workStarted = false;
  for (const call of calls) {
    if (call.name === STEP_STATUS_TOOL) {
      const closed = closedStepCounts(rawArgs.get(call.id) ?? '').filter((n) => byCount.has(n)).sort((a, b) => a - b);
      // An update that closes nothing (in progress, an unknown step, a failed call) is part of the
      // current segment like any other call, so every call in the trace shows in exactly one group.
      if (!closed.length || call.status === 'failed') {
        segment.push(call.id);
        continue;
      }
      const owner = byCount.get(closed[0])!;
      owner.closedWithoutCalls = segment.every((id) => callById.get(id)?.name === STEP_STATUS_TOOL);
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
  // NUL brackets the placeholder because it never occurs in the text being redacted.
  // eslint-disable-next-line no-control-regex
  return shielded.replace(OPAQUE_TOKEN, '[REDACTED]').replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)] ?? '');
}

export { cutWithoutSplittingPair } from '../utils/surrogateSafeCut';

/** Cap, redact, cap again: regexes never run over a multi-megabyte result, and a mask never grows the text past the cap. */
function capRedacted(text: string, max: number): { text: string; truncated: boolean } {
  const redacted = redactText(text.length > max + 512 ? cutWithoutSplittingPair(text, max + 512) : text);
  return { text: cutWithoutSplittingPair(redacted, max), truncated: text.length > max || redacted.length > max };
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
      .map((block) => {
        const blockText = asRecord(block).text;
        return typeof block === 'string' ? block : typeof blockText === 'string' ? blockText : '';
      })
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
