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

export function isChatBranchingSettingEnabled(value: unknown): boolean {
  return String(value ?? '').trim().toLowerCase() === 'true';
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
  isAdmin: boolean;
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
    initialState: Partial<Pick<ChatSession, 'llmModel' | 'associatedSkills'>>;
  }): Promise<ChatSession>;
  setModel(sessionId: string, model: string, policy: PolicyDecision): Promise<unknown>;
  setTitle(sessionId: string, title: string): Promise<unknown>;
  appendMessages(sessionId: string, messages: ChatMessage[]): Promise<unknown>;
  /** Soft-delete (existing mechanism) for a half-built branch. */
  archiveSession(sessionId: string): Promise<void>;
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
 * branch for turns it never ran), `metadata.feedback` (the source's like/dislike), `clientId`
 * (the source's optimistic-render key) and the stale `messageIndex` (reassigned densely on write).
 * Everything else, including hidden tool rows and the tool ledger, is copied verbatim.
 */
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
    return { ...rest, metadata } as ChatMessage;
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
  const base = (source.title ?? '').trim() || 'Chat';
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
const inflightKeys = new Set<string>();
const recentBranches = new Map<string, { sessionId: string; at: number }>();

export function __resetBranchIdempotencyForTests(): void {
  inflightKeys.clear();
  recentBranches.clear();
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
export async function branchChatSession(deps: BranchDeps, input: BranchInput): Promise<ServiceOutcome> {
  try {
    return await branchInner(deps, input);
  } catch (error) {
    deps.log('ChatBranching: unexpected failure', { errorClass: (error as Error)?.name, message: String((error as Error)?.message ?? '').slice(0, 200) });
    return fail(500, 'Failed to branch this chat', 'branch_failed');
  }
}

async function branchInner(deps: BranchDeps, input: BranchInput): Promise<ServiceOutcome> {
  if (!deps.isAcceptingWork()) return { status: 503, body: { message: 'Instance draining — retry on new instance' } };
  if (!(await deps.isFeatureEnabled())) return fail(404, 'Not found', 'chat_branching_disabled');

  const parsed = parseBody(input.body);
  if (!parsed.ok) return parsed.outcome;
  const req = parsed.value;

  const source = await deps.getSession(input.sessionId);
  if (!source) return fail(404, 'Session not found', 'session_not_found');
  if (source.userId !== input.user.userId && !input.user.isAdmin) return fail(403, 'Unauthorized access to session', 'forbidden');
  const refused = ineligible(source);
  if (refused) return refused;

  const scope = req.idempotencyKey ? `branch|${input.sessionId}|${req.idempotencyKey}` : undefined;
  const localKey = scope ? `${input.user.userId}|${scope}` : undefined;
  let runStoreHeld = false;

  const replay = async (sessionId: string): Promise<ServiceOutcome | null> => {
    const existing = await deps.getSession(sessionId, { consistentRead: true });
    if (
      existing && existing.userId === source.userId && existing.archived !== true
      && readBranchOrigin(existing.messages)?.sourceSessionId === input.sessionId
    ) {
      return { status: 200, body: summarize(existing, { idempotentReplay: true }) };
    }
    return null;
  };
  const inFlight = () => fail(409, 'This request was already submitted and is still being processed. Please retry in a moment.', 'DUPLICATE_SUBMIT');

  if (localKey) {
    const done = recentBranches.get(localKey);
    if (done && deps.now() - done.at <= RECENT_BRANCH_TTL_MS) {
      const again = await replay(done.sessionId);
      if (again) return again;
    }
    if (inflightKeys.has(localKey)) return inFlight();
    inflightKeys.add(localKey);
  }

  try {
    if (scope && deps.claimIdempotency) {
      const claim = await deps.claimIdempotency(input.user.userId, scope);
      if (!claim.claimed) {
        const again = claim.sessionId ? await replay(claim.sessionId) : null;
        return again ?? inFlight();
      }
      runStoreHeld = true;
    }

    const outcome = await createBranch(deps, input, req, source);

    if (outcome.status === 201 && scope && localKey) {
      const newId = (outcome.body as { sessionId: string }).sessionId;
      rememberBranch(localKey, newId, deps.now());
      if (runStoreHeld && deps.recordIdempotencySessionId) await deps.recordIdempotencySessionId(input.user.userId, scope, newId);
      runStoreHeld = false; // keep the claim: it now points at the finished branch
    }
    return outcome;
  } finally {
    if (runStoreHeld && scope && deps.releaseIdempotency) await deps.releaseIdempotency(input.user.userId, scope);
    if (localKey) inflightKeys.delete(localKey);
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
  try {
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

    // 4. A normal new session from an ALLOWLIST. Nothing else on the source is read into it.
    const created = await deps.createSession({
      userId: source.userId,
      portalType: 'agent',
      pageIdentifier: branchPageIdentifier(source),
      selectedStartupId: source.selectedStartupId,
      delegateInfo: input.delegateInfo,
      initialState: {
        llmModel: resolved.model,
        ...(Array.isArray(source.associatedSkills) ? { associatedSkills: [...source.associatedSkills] } : {}),
      },
    });
    createdId = created.sessionId;
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
    return { status: 201, body: summarize(saved) };
  } catch (error) {
    if (createdId) {
      try {
        await deps.archiveSession(createdId);
      } catch (cleanupError) {
        deps.log('ChatBranching: failed to archive a half-built branch', { sessionId: createdId, errorClass: (cleanupError as Error)?.name });
      }
    }
    throw error;
  } finally {
    deps.release(input.sessionId);
  }
}
