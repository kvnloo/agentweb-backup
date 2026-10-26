/**
 * Read-only loader for the agent graders (ENG-2137).
 *
 * Turns raw DynamoDB items into the inputs agentGraders.ts grades: the session's work plan
 * (AW-ChatSessions), its tool ledger and final reply (AW-ChatMessages), its agent-mode loop
 * events (Dev-AW-LoopEvents) and its spend (AW-SpendEvents). The only I/O goes through
 * `ReadOnlyDocReader`, which exposes query and scan and nothing else, so the loader cannot write.
 * The normalizers below it are pure and exported for tests.
 */

import { isRunFailurePlaceholder, type ResumeMessage } from '../../services/agentMode/core/resumePlan';
import { branchOwnMessages } from '../../services/agentMode/chatBranching';
import type { AgentLoopEvent, GraderTurn, GraderWorkPlan, LedgerCall, SessionForGrading, SessionSpend } from './agentGraders';

export type DocItem = Record<string, unknown>;

export interface ReadRequest {
  TableName: string;
  IndexName?: string;
  KeyConditionExpression?: string;
  FilterExpression?: string;
  ProjectionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
  ExclusiveStartKey?: DocItem;
  Limit?: number;
}

export interface ReadPage {
  Items?: DocItem[];
  LastEvaluatedKey?: DocItem;
}

/** DocumentClient reads only: the loader has no way to put, update or delete. */
export interface ReadOnlyDocReader {
  query(request: ReadRequest): Promise<ReadPage>;
  scan(request: ReadRequest): Promise<ReadPage>;
}

export interface GraderTables {
  sessions: string;
  messages: string;
  loopEvents: string;
  spendEvents: string;
}

/**
 * What the spend read found for a session: settled rows carrying its id (`attributed`), none
 * (`none`), or more rows for its billing subject than the bounded read allows (`truncated`: the
 * cost is unknown, never a partial sum).
 */
export type SpendStatus = 'attributed' | 'none' | 'truncated';

export interface LoadedSession {
  session: SessionForGrading;
  /** The model that ran the session (see sessionModel). */
  model: string;
  spend?: SessionSpend;
  /** Set only when spend was read. */
  spendStatus?: SpendStatus;
  /**
   * ENG-2648: a branch nobody continued (or the hidden leftover of a failed branch copy): every row is a copy
   * of turns that ran in its source, so it has nothing of its own to grade. Samplers skip it.
   */
  branchCopyOnly?: true;
}

// ---------------------------------------------------------------------------
// Pure normalizers
// ---------------------------------------------------------------------------

function rec(v: unknown): DocItem | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as DocItem) : undefined;
}

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function numOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function stringList(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

/** `AW-ChatSessions.workPlan` → the fields the task-success grader reads. */
export function toGraderWorkPlan(raw: unknown): GraderWorkPlan | undefined {
  const plan = rec(raw);
  if (!plan || !Array.isArray(plan.steps)) return undefined;
  return {
    title: strOf(plan.title),
    steps: plan.steps.flatMap((s) => {
      const step = rec(s);
      if (!step) return [];
      return [{
        stepCount: numOf(step.stepCount),
        status: strOf(step.status) ?? 'pending',
        requiredFunctionCalls: stringList(step.requiredFunctionCalls),
      }];
    }),
    pendingRequiredFunctionCalls: stringList(plan.pendingRequiredFunctionCalls),
  };
}

/** AW-ChatMessages rows (`{ sessionId, messageIndex, message }`) → messages in order. */
export function orderedMessages(rows: readonly DocItem[]): ResumeMessage[] {
  return [...rows]
    .sort((a, b) => (numOf(a.messageIndex) ?? 0) - (numOf(b.messageIndex) ?? 0))
    .flatMap((row) => {
      const m = rec(row.message);
      return m && typeof m.role === 'string' ? [m as unknown as ResumeMessage] : [];
    });
}

function parseJsonObject(content: unknown): unknown {
  if (typeof content !== 'string') return undefined;
  const text = content.trim();
  if (!text.startsWith('{')) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The session's tool ledger in call order, from each assistant turn's `metadata.toolCalls`
 * (`{ id, name, arguments, result, error }`). `result` there is the minimised result; the full
 * output the model saw is the matching `tool` message, attached as `output` when it is JSON.
 * Refused duplicates (`duplicateOf`) never executed and are skipped.
 */
export function toLedger(messages: readonly ResumeMessage[]): LedgerCall[] {
  const outputs = new Map<string, unknown>();
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id) outputs.set(m.tool_call_id, parseJsonObject(m.content));
  }
  const seen = new Set<string>();
  const ledger: LedgerCall[] = [];
  for (const m of messages) {
    const calls = m.metadata?.toolCalls;
    if (!Array.isArray(calls)) continue;
    for (const raw of calls) {
      const call = rec(raw);
      const toolName = strOf(call?.name);
      if (!call || !toolName || call.duplicateOf) continue;
      const id = strOf(call.id);
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const output = id ? outputs.get(id) : undefined;
      ledger.push({
        ...(id ? { id } : {}),
        toolName,
        args: rec(call.arguments) ?? {},
        status: strOf(call.error) ? 'error' : 'success',
        ...(call.result !== undefined ? { result: call.result } : {}),
        ...(output !== undefined ? { output } : {}),
      });
    }
  }
  return ledger;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => strOf(rec(part)?.text) ?? '').join('');
}

/** Text of the last assistant turn that has text and is not a crash placeholder. */
export function finalReplyOf(messages: readonly ResumeMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || isRunFailurePlaceholder(m)) continue;
    const text = textOf(m.content).trim();
    if (text) return text;
  }
  return undefined;
}

/**
 * `{id, name}` of every tool call an assistant turn made, from whichever shape is present:
 * the OpenAI-style top-level `tool_calls` (`{id, function: {name}}`) or the persister's own
 * `metadata.toolCalls` (`{id, name, arguments, result, error}` — see toLedger above).
 */
function toolCallIdsAndNames(m: ResumeMessage): Array<{ id?: string; name?: string }> {
  const fromMeta = Array.isArray(m.metadata?.toolCalls) ? m.metadata.toolCalls : [];
  const fromTop = Array.isArray(m.tool_calls) ? m.tool_calls : [];
  return [...fromMeta, ...fromTop].map((raw) => {
    const call = rec(raw);
    return { id: strOf(call?.id), name: strOf(call?.name) ?? strOf(rec(call?.function)?.name) };
  });
}

/**
 * Every assistant tool_call id → its name, across the whole session. A `tool` message's own
 * `name` field is missing on some stored rows (ChatMessage.name is optional); the id it answers
 * (`tool_call_id`) still resolves the name from the assistant turn that made the call.
 */
function toolNamesById(messages: readonly ResumeMessage[]): Map<string, string> {
  const byId = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const { id, name } of toolCallIdsAndNames(m)) {
      if (id && name && !byId.has(id)) byId.set(id, name);
    }
  }
  return byId;
}

/**
 * One GraderTurn per user message: its text, the tools that ran before the next user message
 * (tool-result messages), and the last assistant text in between that is not a crash placeholder.
 */
export function toTurns(messages: readonly ResumeMessage[]): GraderTurn[] {
  const namesById = toolNamesById(messages);
  const turns: GraderTurn[] = [];
  let current: GraderTurn | undefined;
  for (const m of messages) {
    if (m.role === 'user') {
      current = { userText: textOf(m.content), toolNames: [] };
      turns.push(current);
    } else if (!current) {
      continue;
    } else if (m.role === 'tool') {
      const name = strOf(rec(m)?.name) ?? (m.tool_call_id ? namesById.get(m.tool_call_id) : undefined);
      if (name) current.toolNames.push(name);
    } else if (m.role === 'assistant' && !isRunFailurePlaceholder(m)) {
      const text = textOf(m.content).trim();
      if (text) current.replyText = text;
    }
  }
  return turns;
}

/** Same rule as sessionScoringService.endsWithRunFailurePlaceholder: the last non-system turn. */
export function endsWithRunFailurePlaceholder(messages: readonly ResumeMessage[]): boolean {
  const nonSystem = messages.filter((m) => m.role !== 'system');
  const last = nonSystem[nonSystem.length - 1];
  return !!last && isRunFailurePlaceholder(last);
}

/** Dev-AW-LoopEvents agent-mode rows → events keyed by the sessionId dimension. */
export function groupEventsBySession(rows: readonly DocItem[]): Map<string, AgentLoopEvent[]> {
  const bySession = new Map<string, AgentLoopEvent[]>();
  for (const row of rows) {
    const dimensions = rec(row.dimensions) ?? {};
    const sessionId = strOf(dimensions.sessionId);
    const eventType = strOf(row.eventType);
    const runId = strOf(row.subjectId);
    const ts = strOf(row.ts);
    if (!sessionId || !eventType || !runId || !ts) continue;
    const flat: AgentLoopEvent['dimensions'] = {};
    for (const [k, v] of Object.entries(dimensions)) {
      if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') flat[k] = v;
    }
    const list = bySession.get(sessionId) ?? [];
    list.push({ eventType, runId, ts, dimensions: flat });
    bySession.set(sessionId, list);
  }
  for (const list of bySession.values()) list.sort((a, b) => a.ts.localeCompare(b.ts));
  return bySession;
}

export interface SpendRollup extends SessionSpend {
  /** costMicroUsd per `operation` (the model id for LLM rows). */
  costByOperation: Record<string, number>;
}

/** Settled AW-SpendEvents rows with `references.sessionId` → spend per session. */
export function spendBySession(rows: readonly DocItem[]): Map<string, SpendRollup> {
  const out = new Map<string, SpendRollup>();
  for (const row of rows) {
    const sessionId = strOf(rec(row.references)?.sessionId);
    if (!sessionId || row.lifecycle !== 'settled') continue;
    const cost = numOf(row.costMicroUsd) ?? 0;
    const entry = out.get(sessionId) ?? { costMicroUsd: 0, tokens: 0, costByOperation: {} };
    entry.costMicroUsd += cost;
    if (row.unit === 'llm_token') entry.tokens += numOf(row.quantity) ?? 0;
    const op = strOf(row.operation);
    if (op) entry.costByOperation[op] = (entry.costByOperation[op] ?? 0) + cost;
    out.set(sessionId, entry);
  }
  return out;
}

function mostCommon(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  for (const [v, n] of counts) if (!best || n > (counts.get(best) ?? 0)) best = v;
  return best;
}

/**
 * The model that ran the session: the most common end-of-run model on `agent_run_verdict`
 * (ENG-1210 AC14 dimension), else the requested model on `agent_run_started`, else the
 * operation with the most spend. The session's own `llmModel` is the picker, not the runner
 * (ENG-892), so it is not used.
 */
export function sessionModel(events: readonly AgentLoopEvent[], spend?: SpendRollup): string {
  const modelsOf = (type: string) => events.flatMap((e) => {
    const m = e.eventType === type ? strOf(e.dimensions.llmModel) : undefined;
    return m ? [m] : [];
  });
  const fromVerdicts = mostCommon(modelsOf('agent_run_verdict'));
  if (fromVerdicts) return fromVerdicts;
  const fromStarts = mostCommon(modelsOf('agent_run_started'));
  if (fromStarts) return fromStarts;
  const ops = Object.entries(spend?.costByOperation ?? {}).sort((a, b) => b[1] - a[1]);
  return ops[0]?.[0] ?? 'unknown';
}

export function buildLoadedSession(
  sessionItem: DocItem,
  messageRows: readonly DocItem[],
  events: readonly AgentLoopEvent[],
  spend: SpendRollup | undefined,
): LoadedSession {
  const allMessages = orderedMessages(messageRows);
  // ENG-2648: a branch's TURNS are its own only (its copied turns ran, and are graded, in its source): turn
  // count, per-turn adherence, the final reply and the crash check read `messages`. The tool ledger stays the
  // whole history's — groundedness checks a reply against every call it may report, copied ones included.
  const messages = branchOwnMessages(allMessages);
  const branchCopyOnly = messages.length === 0 && allMessages.length > 0;
  const workPlan = toGraderWorkPlan(sessionItem.workPlan);
  const finalReply = finalReplyOf(messages);
  return {
    ...(branchCopyOnly ? { branchCopyOnly: true as const } : {}),
    session: {
      sessionId: String(sessionItem.sessionId),
      ...(workPlan ? { workPlan } : {}),
      ledger: toLedger(allMessages),
      events: [...events],
      endsWithRunFailurePlaceholder: endsWithRunFailurePlaceholder(messages),
      ...(finalReply ? { finalReply } : {}),
      userTurns: messages.filter((m) => m.role === 'user').length,
      turns: toTurns(messages),
    },
    model: sessionModel(events, spend),
    ...(spend ? { spend: { costMicroUsd: spend.costMicroUsd, tokens: spend.tokens } } : {}),
  };
}

// ---------------------------------------------------------------------------
// I/O (read-only)
// ---------------------------------------------------------------------------

async function readAll(reader: ReadOnlyDocReader, op: 'query' | 'scan', request: ReadRequest): Promise<DocItem[]> {
  const items: DocItem[] = [];
  let start: DocItem | undefined;
  do {
    const page = await reader[op]({ ...request, ...(start ? { ExclusiveStartKey: start } : {}) });
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start);
  return items;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface LoadOptions {
  /** ISO lower bound on the session's updatedAt. */
  from: string;
  /** ISO upper bound on the session's updatedAt. */
  to: string;
  /** Grade at most this many sessions (most recently updated first). */
  limit?: number;
  /** Parallel AW-ChatMessages queries. */
  concurrency?: number;
}

const MAX_EVENT_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/** AW-ChatSessions attributes the graders and the online sampler read (no message text). */
export const SESSION_PROJECTION = 'sessionId, userId, createdAt, updatedAt, workPlan, portalType, sessionType';

/**
 * Every session whose `updatedAt` is in [from, to], via the time-ordered AdminUpdatedAtIndex
 * (a query, never a scan). Items carry SESSION_PROJECTION only.
 */
export async function listSessionsUpdatedBetween(
  reader: ReadOnlyDocReader,
  sessionsTable: string,
  window: { from: string; to: string },
): Promise<DocItem[]> {
  return readAll(reader, 'query', {
    TableName: sessionsTable,
    IndexName: 'AdminUpdatedAtIndex',
    KeyConditionExpression: 'adminListPartition = :p AND updatedAt BETWEEN :from AND :to',
    ProjectionExpression: SESSION_PROJECTION,
    ExpressionAttributeValues: { ':p': 'all', ':from': window.from, ':to': window.to },
  });
}

export interface LoadItemsOptions {
  /** ISO lower bound of the window the sessions were picked from. */
  from: string;
  /** ISO upper bound of that window. */
  to: string;
  /** Parallel AW-ChatMessages queries. */
  concurrency?: number;
  /**
   * Read AW-SpendEvents for cost per success. That table has no session index: without
   * `spendQuery` this is a scan (offline scripts only); with it, a bounded query per billing user.
   */
  includeSpend: boolean;
  spendQuery?: BoundedSpendQuery;
}

/**
 * The online sampler's spend read (ENG-2196): one query per billing subject on the
 * billingUserId + occurredAt index, stopping one row past `maxEventsPerBillingUser`.
 */
export interface BoundedSpendQuery {
  indexName: string;
  /** The billing subject of a session's user: an org member's spend lands on the org's billing root. */
  billingUserOf: (userId: string) => Promise<string>;
  maxEventsPerBillingUser: number;
}

const SPEND_PROJECTION = {
  ProjectionExpression: '#refs, costMicroUsd, quantity, #unit, operation, lifecycle',
  ExpressionAttributeNames: { '#refs': 'references', '#unit': 'unit' },
};

/**
 * Spend rows of the sessions' billing subjects in [from, to], and the sessions whose billing
 * subject is unresolved or overflowed the bound — either way, `spendStatus` must read
 * `truncated` (spend unknown), never `none` (confirmed no spend). A session with no `userId`, or
 * whose `billingUserOf` lookup fails, has not been checked at all: querying under the raw
 * `userId` as a fallback would misattribute an org member's spend to a billing subject nothing
 * was ever charged to, and silently reporting `none` would read as "we checked and there was no
 * spend" when the truth is "we never found out" (ENG-2196 CodeRabbit).
 */
async function readSpendBounded(
  reader: ReadOnlyDocReader,
  table: string,
  sessionItems: readonly DocItem[],
  window: { from: string; to: string },
  q: BoundedSpendQuery,
): Promise<{ rows: DocItem[]; truncated: Set<string> }> {
  const sessionsByBilling = new Map<string, string[]>();
  const billingOf = new Map<string, string>();
  const unresolved = new Set<string>();
  for (const item of sessionItems) {
    const userId = strOf(item.userId);
    if (!userId) {
      unresolved.add(String(item.sessionId));
      continue;
    }
    let billing = billingOf.get(userId);
    if (billing === undefined) {
      billing = await q.billingUserOf(userId).catch(() => '');
      billingOf.set(userId, billing);
    }
    if (!billing) {
      unresolved.add(String(item.sessionId));
      continue;
    }
    const list = sessionsByBilling.get(billing) ?? [];
    list.push(String(item.sessionId));
    sessionsByBilling.set(billing, list);
  }
  const rows: DocItem[] = [];
  const truncated = new Set<string>(unresolved);
  for (const [billingUserId, sessionIds] of sessionsByBilling) {
    const got: DocItem[] = [];
    let start: DocItem | undefined;
    do {
      const page = await reader.query({
        TableName: table,
        IndexName: q.indexName,
        KeyConditionExpression: 'billingUserId = :u AND occurredAt BETWEEN :from AND :to',
        ...SPEND_PROJECTION,
        ExpressionAttributeValues: { ':u': billingUserId, ':from': window.from, ':to': `${window.to}￿` },
        Limit: q.maxEventsPerBillingUser - got.length + 1,
        ...(start ? { ExclusiveStartKey: start } : {}),
      });
      got.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start && got.length <= q.maxEventsPerBillingUser);
    if (got.length > q.maxEventsPerBillingUser) sessionIds.forEach((id) => truncated.add(id));
    else rows.push(...got);
  }
  return { rows, truncated };
}

/**
 * Load the given AW-ChatSessions items with their messages, loop events and (optionally) spend.
 * Loop events are read from the earliest session's createdAt (at most 14 days before `from`) so
 * a session that started before the window keeps its early runs.
 */
export async function loadSessionItems(
  reader: ReadOnlyDocReader,
  tables: GraderTables,
  sessionItems: readonly DocItem[],
  options: LoadItemsOptions,
): Promise<LoadedSession[]> {
  if (sessionItems.length === 0) return [];

  const floor = new Date(Date.parse(options.from) - MAX_EVENT_LOOKBACK_MS).toISOString();
  const earliest = sessionItems.reduce((min, s) => {
    const created = strOf(s.createdAt);
    return created && created < min ? created : min;
  }, options.from);
  const eventsFrom = earliest < floor ? floor : earliest;
  const [eventRows, spendRead] = await Promise.all([
    readAll(reader, 'query', {
      TableName: tables.loopEvents,
      KeyConditionExpression: 'loopId = :l AND tsSession BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':l': 'agent-mode', ':from': eventsFrom, ':to': `${options.to}￿` },
    }),
    !options.includeSpend
      ? Promise.resolve({ rows: [], truncated: new Set<string>() })
      : options.spendQuery
        ? readSpendBounded(reader, tables.spendEvents, sessionItems, { from: eventsFrom, to: options.to }, options.spendQuery)
        : readAll(reader, 'scan', {
          TableName: tables.spendEvents,
          FilterExpression: 'occurredAt BETWEEN :from AND :to AND attribute_exists(#refs.sessionId)',
          ...SPEND_PROJECTION,
          ExpressionAttributeValues: { ':from': eventsFrom, ':to': `${options.to}￿` },
        }).then((rows) => ({ rows, truncated: new Set<string>() })),
  ]);
  const events = groupEventsBySession(eventRows);
  const spend = spendBySession(spendRead.rows);

  return mapLimit(sessionItems, options.concurrency ?? 4, async (item) => {
    const sessionId = String(item.sessionId);
    const messageRows = await readAll(reader, 'query', {
      TableName: tables.messages,
      KeyConditionExpression: 'sessionId = :s',
      ExpressionAttributeValues: { ':s': sessionId },
    });
    const truncated = spendRead.truncated.has(sessionId);
    const loaded = buildLoadedSession(item, messageRows, events.get(sessionId) ?? [], truncated ? undefined : spend.get(sessionId));
    if (!options.includeSpend) return loaded;
    return { ...loaded, spendStatus: truncated ? 'truncated' : loaded.spend ? 'attributed' : 'none' };
  });
}

export interface LoadOptions {
  /** ISO lower bound on the session's updatedAt. */
  from: string;
  /** ISO upper bound on the session's updatedAt. */
  to: string;
  /** Grade at most this many sessions (most recently updated first). */
  limit?: number;
  /** Parallel AW-ChatMessages queries. */
  concurrency?: number;
}

/** Load every session updated in [from, to] with its messages, loop events and spend. */
export async function loadSessionsForGrading(
  reader: ReadOnlyDocReader,
  tables: GraderTables,
  options: LoadOptions,
): Promise<LoadedSession[]> {
  let sessionItems = await listSessionsUpdatedBetween(reader, tables.sessions, options);
  sessionItems.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  if (options.limit != null) sessionItems = sessionItems.slice(0, options.limit);
  return loadSessionItems(reader, tables, sessionItems, {
    from: options.from,
    to: options.to,
    concurrency: options.concurrency,
    includeSpend: true,
  });
}
