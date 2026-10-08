/**
 * ENG-112: branch a chat from a message ("Branch from here").
 *
 * POST /api/agent-mode/session/:id/branch {messageIndex, llmModel?, idempotencyKey?}
 *
 * A branch is an ORDINARY new session (created through ChatbotDB.createChatSession from an
 * allowlist) whose history is the source's rows [0..k], appended through the ordinary
 * addMessagesToSession path. It adds NO session field, index or table. Provenance is one
 * free-form key, `branchOrigin`, on the metadata of row 0 (the stored system prompt):
 *
 *  - row 0 is never sent to the model (AgentModeService.buildMarketingContext starts its slice
 *    at index 1), model comparison only reads user/assistant rows, and ChatMessageItem renders no
 *    bubble for role 'system', so the marker is invisible to the model and the transcript;
 *  - a separate provenance ROW is deliberately not used: a second system row would land in the
 *    model's context (index 1) and shift every "message 0 is the system prompt" assumption.
 *
 * Pure logic with injected dependencies (same shape as modelComparison.ts); the controller only
 * supplies the real dependencies. Nothing here imports the 15k-line agentModeController.
 */
import type { ChatMessage, ChatSession } from '../chatbotService';
import { computeAdminTaintedTurns, filterMessagesForClient } from '../../utils/adminOnlyMessageFilter';

/** AW-Settings row. Only the exact value "true" enables the feature; default OFF. */
export const CHAT_BRANCHING_ENABLED_SETTING = 'chat_branching_enabled';

/** A branch must leave room for the next turn (user + system/tool/assistant rows) under the session cap. */
export const BRANCH_MIN_HEADROOM_MESSAGES = 10;
export const BRANCH_TITLE_SUFFIX = ' (branch)';

const MAX_TITLE_CHARS = 120;
const MAX_MODEL_ID_CHARS = 200;
const MAX_IDEMPOTENCY_KEY_CHARS = 256;
const DEFAULT_PAGE_IDENTIFIER = 'agent-mode';
const SKILL_PAGE_IDENTIFIER_RE = /^skill-[A-Za-z0-9_-]{1,100}$/;
const APPEND_ATTEMPTS = 3;
const RECENT_BRANCH_TTL_MS = 10 * 60 * 1000;
const RECENT_BRANCH_MAX = 500;
const CLEANUP_ATTEMPTS = 3;
const RATE_WINDOW_MS = 60 * 60 * 1000;

/** AW-Settings row: max branches one user may create per rolling hour. Absent/invalid => default; 0 => unlimited. */
export const CHAT_BRANCHING_MAX_PER_HOUR_SETTING = 'chat_branching_max_per_hour';
export const DEFAULT_MAX_BRANCHES_PER_HOUR = 30;

export function parseBranchRateLimit(value: unknown): number {
  const text = String(value ?? '').trim();
  if (!/^\d{1,9}$/.test(text)) return DEFAULT_MAX_BRANCHES_PER_HOUR;
  return Number(text);
}

/**
 * Strict kill-switch: ONLY the exact string "true" enables branching. No trim, no case folding
 * ("TRUE", "True", " true " are all OFF), so "set it to anything but true" is a reliable rollback.
 * Shared by the endpoint gate and the portal capability hint (getModelOptions).
 */
export function isChatBranchingSettingEnabled(value: unknown): boolean {
  return value === 'true';
}

const MAX_SESSION_ID_CHARS = 256;
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Session ids are uuids; accept the uuid alphabet (and any legacy id of it) up to 256 chars, like model compare's sessionId bound. */
export function isAcceptableSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SESSION_ID_CHARS && SESSION_ID_RE.test(value);
}

export interface BranchOrigin {
  sourceSessionId: string;
  sourceTitle?: string;
  /** RAW row index in the source (what the client sent), not a position in the filtered view. */
  sourceMessageIndex: number;
  branchedAt: string;
}

/** The provenance of a branch, read from row 0 of its history. */
export function readBranchOrigin(messages: readonly ChatMessage[] | undefined): BranchOrigin | null {
  const origin = (messages?.[0]?.metadata as { branchOrigin?: unknown } | undefined)?.branchOrigin;
  if (!origin || typeof origin !== 'object') return null;
  const o = origin as Partial<BranchOrigin>;
  if (typeof o.sourceSessionId !== 'string' || typeof o.sourceMessageIndex !== 'number') return null;
  return o as BranchOrigin;
}

export interface ServiceOutcome<T = unknown> {
  status: number;
  body: T;
}

export interface BranchUser {
  userId: string;
  /** Informational only: branching requires the requester to OWN the session (admins act via delegation). */
  isAdmin?: boolean;
}

type DelegateInfo = NonNullable<ChatSession['delegateInfo']>;
type PolicyDecision = NonNullable<ChatSession['llmUsagePolicyDecision']>;

export type ModelResolution =
  | { ok: true; model: string; policy?: PolicyDecision }
  | { ok: false; outcome: ServiceOutcome };

export type IdempotencyClaimResult = { claimed: true } | { claimed: false; sessionId?: string };

export interface BranchDeps {
  isAcceptingWork(): boolean;
  isFeatureEnabled(): Promise<boolean>;
  getSession(sessionId: string, options?: { consistentRead?: boolean }): Promise<ChatSession | null>;
  tryClaim(sessionId: string): boolean;
  release(sessionId: string): void;
  /** Cross-instance submit lock (the AGENT_RUN_STORE lane createSession uses). Absent when the store is off. */
  claimIdempotency?(userId: string, scope: string): Promise<IdempotencyClaimResult>;
  recordIdempotencySessionId?(userId: string, scope: string, sessionId: string): Promise<void>;
  releaseIdempotency?(userId: string, scope: string): Promise<void>;
  /** Entitlement + usage-policy decision for the branch owner. Throws nothing: failures are an outcome. */
  resolveModel(input: { userId: string; requestedModel?: string; explicit: boolean }): Promise<ModelResolution>;
  createSession(args: {
    userId: string;
    portalType: 'agent';
    pageIdentifier: string;
    selectedStartupId?: string;
    delegateInfo?: DelegateInfo;
    initialState: Partial<Pick<ChatSession, 'llmModel' | 'associatedSkills' | 'archived'>>;
  }): Promise<ChatSession>;
  setModel(sessionId: string, model: string, policy: PolicyDecision): Promise<unknown>;
  setTitle(sessionId: string, title: string): Promise<unknown>;
  appendMessages(sessionId: string, messages: ChatMessage[]): Promise<unknown>;
  /**
   * Reveal a verified branch: REMOVES the `archived` attribute (an ordinary session has none). Rejects
   * with `code: 'ConditionalCheckFailedException'` when the session no longer exists.
   */
  unarchiveSession(sessionId: string): Promise<void>;
  /** Max branches per user per rolling hour (already cached/defaulted by the caller). 0 = unlimited. */
  getMaxBranchesPerHour(): Promise<number>;
  /** Backoff between cleanup retries. Defaults to setTimeout. */
  sleep?(ms: number): Promise<void>;
  adminToolNames: Iterable<string>;
  maxSessionMessages: number;
  now(): number;
  log(message: string, fields?: Record<string, unknown>): void;
}

export interface BranchInput {
  user: BranchUser;
  /** A real admin, or an admin acting through delegation: may see admin-tainted turns. */
  viewerIsAdmin: boolean;
  sessionId: string;
  body: unknown;
  delegateInfo?: DelegateInfo;
}

// ---------------------------------------------------------------------------
function fail(status: number, error: string, code: string, extra: Record<string, unknown> = {}): ServiceOutcome {
  return { status, body: { error, code, ...extra } };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

interface ParsedBranchRequest {
  messageIndex: number;
  llmModel?: string;
  idempotencyKey?: string;
}

function parseBody(body: unknown): { ok: true; value: ParsedBranchRequest } | { ok: false; outcome: ServiceOutcome } {
  const bad = (msg: string) => ({ ok: false as const, outcome: fail(400, msg, 'invalid_request') });
  if (!isPlainObject(body)) return bad('Request body must be a JSON object');
  const { messageIndex, llmModel, idempotencyKey } = body;
  if (typeof messageIndex !== 'number' || !Number.isInteger(messageIndex) || messageIndex < 0) {
    return bad('messageIndex must be a non-negative integer');
  }
  let model: string | undefined;
  if (llmModel !== undefined && llmModel !== null) {
    if (typeof llmModel !== 'string') return bad('llmModel must be a string');
    model = llmModel.trim() || undefined;
    if (model && model.length > MAX_MODEL_ID_CHARS) return bad('llmModel is too long');
  }
  let key: string | undefined;
  if (idempotencyKey !== undefined && idempotencyKey !== null) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARS) {
      return bad('idempotencyKey must be a string of at most 256 characters');
    }
    key = idempotencyKey.length > 0 ? idempotencyKey : undefined;
  }
  return { ok: true, value: { messageIndex, llmModel: model, idempotencyKey: key } };
}

/**
 * Only plain interactive agent-mode chats are branchable. Every other type carries session-level
 * state that a branch deliberately does NOT copy (work plan, schedule link and publish admission,
 * result-endpoint / email / slack bindings, generation surfaces), so branching one would produce a
 * half-state session. Refusing is safer than guessing which part to keep.
 */
function ineligible(source: ChatSession): ServiceOutcome | null {
  if (source.archived === true) return fail(404, 'Session not found', 'session_not_found');
  const type = source.sessionType ?? 'regular';
  const portal = source.portalType ?? 'agent';
  if (type !== 'regular' || portal !== 'agent') {
    return fail(400, 'This kind of session cannot be branched', 'session_not_branchable');
  }
  return null;
}

/** Position-stamped copy of the history: messages read from a legacy inline migration carry no messageIndex. */
function withIndexes(history: readonly ChatMessage[]): ChatMessage[] {
  return history.map((m, i) => (typeof m.messageIndex === 'number' ? m : { ...m, messageIndex: i }));
}

export type PrefixPlan = { ok: true; endInclusive: number } | { ok: false; outcome: ServiceOutcome };

/**
 * Resolve the client's index (the RAW `messageIndex` of a message it can see) to the prefix to copy.
 *
 *  - must exist, must be visible to this viewer (so a hidden tool row or an admin-redacted turn
 *    cannot be named), and must be an assistant message that is not an error/failure placeholder;
 *  - extended over the tool-result rows that immediately follow it (they belong to that message);
 *  - when the message sits in an admin-tainted turn (only an admin can name one), extended to the
 *    end of the turn so the admin tool-result row travels with it and the customer-facing filter
 *    still redacts the narration AND the prompt. Truncating mid-turn would leave them untainted.
 */
export function planBranchPrefix(
  history: readonly ChatMessage[],
  messageIndex: number,
  ctx: { viewerIsAdmin: boolean; adminToolNames: Iterable<string>; maxSessionMessages: number },
): PrefixPlan {
  const rows = withIndexes(history);
  const pos = rows.findIndex((m) => m.messageIndex === messageIndex);
  if (pos < 0) return { ok: false, outcome: fail(400, 'messageIndex does not exist in this session', 'message_index_out_of_range') };

  const adminToolNames = new Set<string>(ctx.adminToolNames);
  const visible = new Set(
    filterMessagesForClient(rows, { viewerIsAdmin: ctx.viewerIsAdmin, adminToolNames }).map((m: ChatMessage) => m.messageIndex),
  );
  if (!visible.has(messageIndex)) {
    return { ok: false, outcome: fail(400, 'That message is not a visible chat message', 'message_not_visible') };
  }
  const target = rows[pos];
  const meta = target.metadata;
  if (target.role !== 'assistant' || meta?.isErrorMessage || meta?.isRunFailureNotice) {
    return { ok: false, outcome: fail(400, 'Only an assistant reply can be branched from', 'message_not_branchable') };
  }

  // A reply with no question before it cannot seed a branch: the branch's first-turn logic (title,
  // "first user message" detection) would misfire on a history that starts assistant-first.
  if (!rows.slice(0, pos).some((m) => m.role === 'user')) {
    return { ok: false, outcome: fail(400, 'There is no question before that reply to branch from', 'no_user_message') };
  }

  let end = pos;
  while (end + 1 < rows.length && rows[end + 1].role === 'tool') end++;
  if (computeAdminTaintedTurns(rows, false, adminToolNames)[pos]) {
    while (end + 1 < rows.length && rows[end + 1].role !== 'user') end++;
  }

  if (end + 1 + BRANCH_MIN_HEADROOM_MESSAGES > ctx.maxSessionMessages) {
    return {
      ok: false,
      outcome: fail(400, 'This conversation is too long to branch from that point. Branch from an earlier message.', 'branch_too_large', {
        maxMessages: ctx.maxSessionMessages - BRANCH_MIN_HEADROOM_MESSAGES,
      }),
    };
  }
  return { ok: true, endInclusive: end };
}

/**
 * The rows a branch is written from. Strips what must NOT be re-counted or re-attributed:
 * `usage` (addMessagesToSession runs incrementTokenUsage, so a copied usage block would bill the
 * branch for turns it never ran), `metadata.feedback` (the source's like/dislike), the continuation-trigger flags (see stripContinuationTriggers), `clientId`
 * (the source's optimistic-render key) and the stale `messageIndex` (reassigned densely on write).
 * Everything else, including hidden tool rows and the tool ledger, is copied verbatim.
 */
/**
 * Copy of the message with every flag that makes a READ of the session start work removed.
 * getSession re-fires scheduleAutoMediaContinuation (a billed generation) for an owner view whose
 * tail is an unresolved media deferral younger than an hour (hasUnresolvedMediaDeferral): the
 * `mediaBudgetDeferred` marker on a tool/assistant row, or a deferred `media_generation_time_budget`
 * call in an assistant's `toolCalls` ledger. Copied verbatim, the portal's immediate navigation to a
 * fresh branch would spend the user's credits on a continuation they never asked for. The visible
 * text and the rest of the ledger are untouched.
 */
function stripContinuationTriggers(m: ChatMessage): ChatMessage {
  const meta = m.metadata as (Record<string, any> & { toolCalls?: any[] }) | undefined | null;
  if (!meta) return m;
  const { mediaBudgetDeferred: _d, ...metadata } = meta;
  if (Array.isArray(metadata.toolCalls)) {
    metadata.toolCalls = metadata.toolCalls.map((tc: any) => {
      if (tc?.result?.deferred === true && tc.result.reason === 'media_generation_time_budget') {
        const { deferred: _x, ...result } = tc.result;
        return { ...tc, result };
      }
      return tc;
    });
  }
  return { ...m, metadata } as ChatMessage;
}

export function buildBranchRows(
  history: readonly ChatMessage[],
  endInclusive: number,
  origin: BranchOrigin,
  nowIso: string,
): ChatMessage[] {
  const rows = withIndexes(history).slice(0, endInclusive + 1).map((m) => {
    const { messageIndex: _i, usage: _u, clientId: _c, ...rest } = m as ChatMessage & { clientId?: string };
    if (!rest.metadata) return rest as ChatMessage;
    const { feedback: _f, ...metadata } = rest.metadata;
    return stripContinuationTriggers({ ...rest, metadata } as ChatMessage);
  });
  const first = rows[0];
  rows[0] = {
    ...first,
    metadata: {
      ...(first.metadata ?? {}),
      timestamp: first.metadata?.timestamp ?? first.timestamp ?? nowIso,
      branchOrigin: origin,
    } as ChatMessage['metadata'],
  };
  return rows;
}

function branchTitle(source: ChatSession): string {
  let base = (source.title ?? '').trim() || 'Chat';
  // Branching a branch must not stack the suffix ("X (branch) (branch)").
  if (base.endsWith(BRANCH_TITLE_SUFFIX) && base.length > BRANCH_TITLE_SUFFIX.length) base = base.slice(0, -BRANCH_TITLE_SUFFIX.length).trimEnd() || 'Chat';
  return `${base.slice(0, MAX_TITLE_CHARS - BRANCH_TITLE_SUFFIX.length)}${BRANCH_TITLE_SUFFIX}`;
}

/** Schedule-derived (`Scheduled: …|scheduleId:`) and Slack-derived identifiers are not carried: allowlist only. */
function branchPageIdentifier(source: ChatSession): string {
  const id = source.pageIdentifier;
  return typeof id === 'string' && (id === DEFAULT_PAGE_IDENTIFIER || SKILL_PAGE_IDENTIFIER_RE.test(id)) ? id : DEFAULT_PAGE_IDENTIFIER;
}

// ---------------------------------------------------------------------------
// Idempotency. Layer 1 (this file): in-process in-flight set + short-lived completed map, so the
// guarantee holds with AGENT_RUN_STORE off (one instance). Layer 2 (deps.claimIdempotency): the same
// cross-instance submit lock createSession uses, when the run store is enabled.
// ---------------------------------------------------------------------------
const inflightKeys = new Map<string, Promise<ServiceOutcome>>();
const recentBranches = new Map<string, { sessionId: string; at: number }>();

const branchWindows = new Map<string, number[]>();

export function __resetBranchIdempotencyForTests(): void {
  inflightKeys.clear();
  recentBranches.clear();
  branchWindows.clear();
  rateCallCount = 0;
}
export const __branchWindowUsersForTests = (): number => branchWindows.size;

/** Every this-many cap checks, users whose whole window has expired are dropped from the map. */
export const RATE_SWEEP_EVERY = 50;
let rateCallCount = 0;

function sweepExpiredWindows(now: number): void {
  for (const [userId, list] of branchWindows) {
    if (list.length === 0 || list.every((t) => now - t >= RATE_WINDOW_MS)) branchWindows.delete(userId);
  }
}

interface RateSlot { userId: string; at: number }

/** Sliding window per user (in-memory, per instance). Returns null when the user is over the cap. */
async function takeRateSlot(deps: BranchDeps, userId: string): Promise<RateSlot | null | 'unlimited'> {
  let max = DEFAULT_MAX_BRANCHES_PER_HOUR;
  try {
    const configured = await deps.getMaxBranchesPerHour();
    if (Number.isInteger(configured) && configured >= 0) max = configured;
  } catch {
    // a settings outage must not block branching: use the default
  }
  const now = deps.now();
  if (++rateCallCount % RATE_SWEEP_EVERY === 0) sweepExpiredWindows(now);
  if (max === 0) return 'unlimited';
  const recent = (branchWindows.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= max) {
    if (recent.length === 0) branchWindows.delete(userId);
    else branchWindows.set(userId, recent);
    return null;
  }
  recent.push(now);
  branchWindows.set(userId, recent);
  return { userId, at: now };
}

function refundRateSlot(slot: RateSlot): void {
  const list = branchWindows.get(slot.userId);
  if (!list) return;
  const i = list.indexOf(slot.at);
  if (i >= 0) list.splice(i, 1);
  if (list.length === 0) branchWindows.delete(slot.userId);
}

const isSessionVanished = (error: unknown): boolean => (error as { code?: string } | null)?.code === 'ConditionalCheckFailedException';

async function retryCleanup(deps: BranchDeps, op: () => Promise<void>): Promise<unknown | undefined> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: unknown;
  for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt++) {
    try {
      await op();
      return undefined;
    } catch (error) {
      last = error ?? new Error('unknown');
      if (isSessionVanished(error)) break; // retrying cannot bring a deleted row back
      if (attempt < CLEANUP_ATTEMPTS) await sleep(100 * attempt);
    }
  }
  return last;
}

function rememberBranch(localKey: string, sessionId: string, now: number): void {
  for (const [k, v] of recentBranches) {
    if (now - v.at > RECENT_BRANCH_TTL_MS || recentBranches.size >= RECENT_BRANCH_MAX) recentBranches.delete(k);
    else break; // Map iterates in insertion order: the rest are newer
  }
  recentBranches.set(localKey, { sessionId, at: now });
}

function summarize(session: ChatSession, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const origin = readBranchOrigin(session.messages);
  return {
    sessionId: session.sessionId,
    title: session.title,
    llmModel: session.llmModel,
    messageCount: session.messageCount ?? session.messages?.length ?? 0,
    sourceSessionId: origin?.sourceSessionId,
    branchOrigin: origin,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
interface BranchRunContext { createdId?: string }

export async function branchChatSession(deps: BranchDeps, input: BranchInput): Promise<ServiceOutcome> {
  const ctx: BranchRunContext = {};
  try {
    return await branchInner(deps, input, ctx);
  } catch (error) {
    // Once a session exists every failure line names it, so an operator can find an orphan.
    deps.log('ChatBranching: unexpected failure', { ...(ctx.createdId ? { sessionId: ctx.createdId } : {}), errorClass: (error as Error)?.name, message: String((error as Error)?.message ?? '').slice(0, 200) });
    return fail(500, 'Failed to branch this chat', 'branch_failed');
  }
}

async function branchInner(deps: BranchDeps, input: BranchInput, ctx: BranchRunContext): Promise<ServiceOutcome> {
  if (!deps.isAcceptingWork()) return { status: 503, body: { message: 'Instance draining — retry on new instance' } };
  if (!(await deps.isFeatureEnabled())) return fail(404, 'Not found', 'chat_branching_disabled');

  const parsed = parseBody(input.body);
  if (!parsed.ok) return parsed.outcome;
  const req = parsed.value;

  // Before ANY storage call: a garbage / oversized id must not reach DynamoDB (it would surface as a 500).
  if (!isAcceptableSessionId(input.sessionId)) return fail(400, 'Invalid session id', 'invalid_session_id');

  const source = await deps.getSession(input.sessionId);
  if (!source) return fail(404, 'Session not found', 'session_not_found');
  // OWNER only. A non-delegated admin writing a new session into a customer's account would leave no
  // trace of who did it; a delegated admin arrives with req.user = the target, so that case passes.
  if (source.userId !== input.user.userId) return fail(403, 'Unauthorized access to session', 'forbidden');
  const refused = ineligible(source);
  if (refused) return refused;

  // The scope names everything that shapes the result, so one key can never be replayed onto a
  // branch from a different message or model.
  // JSON-encoded so no value (a model id or key containing the old `|` delimiter) can masquerade as another.
  const scope = req.idempotencyKey
    ? JSON.stringify(['branch', input.sessionId, req.messageIndex, req.llmModel ?? '', req.idempotencyKey])
    : undefined;
  const localKey = scope ? JSON.stringify([input.user.userId, scope]) : undefined;
  let runStoreHeld = false;

  const replay = async (sessionId: string): Promise<ServiceOutcome | null> => {
    const existing = await deps.getSession(sessionId, { consistentRead: true });
    const origin = existing ? readBranchOrigin(existing.messages) : null;
    if (
      existing && existing.userId === source.userId && existing.archived !== true
      && origin?.sourceSessionId === input.sessionId && origin.sourceMessageIndex === req.messageIndex
    ) {
      return { status: 200, body: summarize(existing, { idempotentReplay: true }) };
    }
    return null;
  };
  const inFlight = () => fail(409, 'This request was already submitted and is still being processed. Please retry in a moment.', 'DUPLICATE_SUBMIT');

  if (localKey) {
    // A second request with the same key does not fail: it WAITS for the first and answers with the
    // same branch as a replay. (Nothing awaits between the last check below and inflightKeys.set, so
    // exactly one caller owns the key.)
    for (;;) {
      const pending = inflightKeys.get(localKey);
      if (pending) {
        const first = await pending;
        if (first.status === 201) {
          const again = await replay((first.body as { sessionId: string }).sessionId);
          if (again) return again;
        }
        continue; // the first attempt failed (its key is released) or did not match: take a turn of our own
      }
      const done = recentBranches.get(localKey);
      if (done && deps.now() - done.at <= RECENT_BRANCH_TTL_MS) {
        const again = await replay(done.sessionId);
        if (again) return again;
        if (inflightKeys.has(localKey)) continue; // someone else took the key while we were reading
        recentBranches.delete(localKey);
      }
      break;
    }
  }

  const sourceRead: ChatSession = source;
  let settle: ((outcome: ServiceOutcome) => void) | undefined;
  if (localKey) inflightKeys.set(localKey, new Promise<ServiceOutcome>((resolve) => { settle = resolve; }));
  let outcome: ServiceOutcome = fail(500, 'Failed to branch this chat', 'branch_failed'); // what waiters see if we throw

  try {
    outcome = await runOwned();
    return outcome;
  } finally {
    if (localKey) {
      inflightKeys.delete(localKey); // before settling: a woken waiter must find the key free
      settle?.(outcome);
    }
  }

  async function runOwned(): Promise<ServiceOutcome> {
    const ownedSource: ChatSession = sourceRead;
    try {
      if (scope && deps.claimIdempotency) {
        const claim = await deps.claimIdempotency(input.user.userId, scope);
        if (!claim.claimed) {
          const again = claim.sessionId ? await replay(claim.sessionId) : null;
          return again ?? inFlight();
        }
        runStoreHeld = true;
      }

      const created = await createBranch(deps, input, req, ownedSource, ctx);

      if (created.status === 201 && scope && localKey) {
        const newId = (created.body as { sessionId: string }).sessionId;
        // The branch is visible now: from here on the claim must never be released (a retry would
        // make a duplicate) and a bookkeeping failure must not turn this success into a 500.
        // If the stamp (recordIdempotencySessionId) fails it is only logged: same-instance retries
        // still replay via the in-process record (200, same branch). With the run store ON, a retry
        // that lands on ANOTHER instance finds the claim without a session id and answers 409
        // DUPLICATE_SUBMIT until the claim TTL (IDEM_TTL_INTERACTIVE_S) expires; the branch itself is
        // intact and visible. The run store is OFF in production today (AGENT_RUN_STORE unset), so
        // this path is currently not reachable there.
        const hadRunStore = runStoreHeld;
        runStoreHeld = false;
        try {
          rememberBranch(localKey, newId, deps.now());
          if (hadRunStore && deps.recordIdempotencySessionId) await deps.recordIdempotencySessionId(input.user.userId, scope, newId);
        } catch (error) {
          deps.log('ChatBranching: branch created but idempotency bookkeeping failed; returning success', {
            sessionId: newId, errorClass: (error as Error)?.name, message: String((error as Error)?.message ?? '').slice(0, 200),
          });
        }
      }
      return created;
    } finally {
      if (runStoreHeld && scope && deps.releaseIdempotency) await deps.releaseIdempotency(input.user.userId, scope);
    }
  }
}

async function appendWithRetry(deps: BranchDeps, sessionId: string, rows: ChatMessage[]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await deps.appendMessages(sessionId, rows);
      return;
    } catch (error) {
      // addMessagesToSession reads the session first with an eventually consistent get; a session
      // created a moment ago can briefly not exist. Nothing was written in that case, so retry.
      const notYetReadable = (error as Error)?.message === 'Session not found';
      if (!notYetReadable || attempt >= APPEND_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
}

async function createBranch(
  deps: BranchDeps,
  input: BranchInput,
  req: ParsedBranchRequest,
  firstRead: ChatSession,
  ctx: BranchRunContext,
): Promise<ServiceOutcome> {
  // 1. Decide the model for the BRANCH OWNER before anything is written (entitlements, usage policy).
  const resolved = await deps.resolveModel({
    userId: firstRead.userId,
    requestedModel: req.llmModel ?? firstRead.llmModel,
    explicit: req.llmModel !== undefined,
  });
  if (!resolved.ok) return resolved.outcome;

  // 2. Hold the SOURCE's generation lock for the whole read+copy so a running turn cannot tear the
  //    copy and none can start while it runs. Never release a lock we did not take.
  if (!deps.tryClaim(input.sessionId)) {
    return fail(409, 'A response is already being generated for this session. Please wait.', 'SESSION_BUSY', {
      message: 'A response is already being generated for this session. Please wait.',
    });
  }
  let createdId: string | undefined;
  let slot: RateSlot | null | 'unlimited' = null;
  try {
    // Per-user cap: counted only now that the request validated and holds the lock; handed back in
    // `finally` unless a session was actually created.
    slot = await takeRateSlot(deps, input.user.userId);
    if (slot === null) {
      const message = 'Too many branches were created recently. Please try again in a little while.';
      return fail(429, message, 'TOO_MANY_BRANCHES', { message });
    }

    // 3. Re-read under the lock (consistent): the pre-lock copy may be stale.
    const source = await deps.getSession(input.sessionId, { consistentRead: true });
    if (!source) return fail(404, 'Session not found', 'session_not_found');
    if (source.userId !== firstRead.userId) return fail(403, 'Unauthorized access to session', 'forbidden');
    const refused = ineligible(source);
    if (refused) return refused;

    const history = source.messages ?? [];
    const plan = planBranchPrefix(history, req.messageIndex, {
      viewerIsAdmin: input.viewerIsAdmin,
      adminToolNames: deps.adminToolNames,
      maxSessionMessages: deps.maxSessionMessages,
    });
    if (!plan.ok) return plan.outcome;

    const nowIso = new Date(deps.now()).toISOString();
    const origin: BranchOrigin = {
      sourceSessionId: source.sessionId,
      ...(source.title ? { sourceTitle: source.title.slice(0, MAX_TITLE_CHARS) } : {}),
      sourceMessageIndex: req.messageIndex,
      branchedAt: nowIso,
    };
    const rows = buildBranchRows(history, plan.endInclusive, origin, nowIso);

    // 4. A normal new session from an ALLOWLIST. Nothing else on the source is read into it. It is BORN
    //    archived (hidden): until the copy is verified it must not show in any list, and a process
    //    death mid-copy leaves a hidden session, never an empty visible one. There is no
    //    create-then-hide window.
    const created = await deps.createSession({
      userId: source.userId,
      portalType: 'agent',
      pageIdentifier: branchPageIdentifier(source),
      selectedStartupId: source.selectedStartupId,
      delegateInfo: input.delegateInfo,
      initialState: {
        llmModel: resolved.model,
        archived: true,
        ...(Array.isArray(source.associatedSkills) ? { associatedSkills: [...source.associatedSkills] } : {}),
      },
    });
    createdId = created.sessionId;
    ctx.createdId = createdId;
    deps.log('ChatBranching: branch session created (hidden until verified)', {
      sessionId: createdId, sourceSessionId: source.sessionId, userId: source.userId,
    });
    if (resolved.policy) await deps.setModel(createdId, resolved.model, resolved.policy);
    const title = branchTitle(source);
    await deps.setTitle(createdId, title);

    // 5. The ordinary append path (keyed mutex, dense indices, messageCount), then PROVE it landed:
    //    addMessagesToMessagesTable logs and swallows batch items still unprocessed after its retries.
    await appendWithRetry(deps, createdId, rows);
    const saved = await deps.getSession(createdId, { consistentRead: true });
    const savedRows = saved?.messages ?? [];
    const dense = savedRows.length === rows.length && savedRows.every((m, i) => m.messageIndex === i);
    if (!saved || !dense || saved.messageCount !== rows.length || readBranchOrigin(savedRows)?.sourceSessionId !== source.sessionId) {
      throw new Error(`branch verification failed: expected ${rows.length} rows, found ${savedRows.length} (messageCount ${saved?.messageCount})`);
    }

    // 6. Verified: reveal it. If this keeps failing the branch simply stays hidden (safe) and the
    //    request reports failure; the id is logged so it can be revealed or removed by hand.
    const revealError = await retryCleanup(deps, () => deps.unarchiveSession(createdId!));
    if (revealError !== undefined) {
      deps.log(
        isSessionVanished(revealError)
          ? 'ChatBranching: branch session vanished before it could be revealed'
          : 'ChatBranching: verified branch could not be revealed; it stays hidden',
        { sessionId: createdId, errorClass: (revealError as Error)?.name },
      );
      throw revealError;
    }
    return { status: 201, body: summarize(saved) };
  } finally {
    // A request that created nothing must not use up the user's allowance.
    if (slot && slot !== 'unlimited' && !createdId) refundRateSlot(slot);
    deps.release(input.sessionId);
  }
}
