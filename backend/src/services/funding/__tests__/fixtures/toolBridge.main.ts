// eslint-disable-next-line
// FROZEN COPY of origin/main toolBridge.ts (before ENG-2113), used only by toolBridge.ledgerDifferential.test.ts as the reference for the ledger. Do not edit.
// @ts-nocheck
/**
 * ENG-2113 (B2): the harness-agnostic core of the tool bridge. A `claude -p` session
 * (or any other harness) reaches Emma's tools only through `listTools` and `callTool`,
 * and only with the run's own token.
 *
 * A "run" here is one kept-open harness session: its MCP config, and so its token, is
 * fixed when the process is spawned and lives across that conversation's turns.
 *
 * Under `claude -p` the CLI owns the agent loop, so the controls Emma's loop enforces
 * around tool dispatch have to live here instead:
 *
 *  - The model sees exactly the run's filtered tool list, and a call is checked against
 *    that list again when it executes, not only when it was listed.
 *  - A result that asks for the user's confirmation halts the conversation. Several
 *    tools hand the model the very token needed to confirm (campaign launches, Google
 *    Ads overrides, image edits) and rely on Emma's loop ending the turn so a human
 *    replies first. Without this halt the model could preview and confirm in one turn.
 *    The halt belongs to the session, not the run, so reopening or replacing a run
 *    cannot lift it; only a new turn from the user (`beginTurn` / `clearHalt`) can.
 *    Each halt is handed to `persistHalt` BEFORE its call is answered, so no later
 *    write can start while a confirmation is outstanding but not yet durable. Calls
 *    the stream announced as part of the same model message as the first halt are
 *    still admitted (one batched confirmation, as in Emma's own loop); nothing else is.
 *  - Tools not known to be read-only run one at a time per SESSION, in arrival order.
 *  - A write never runs twice by accident: an identical call that arrives while the
 *    first is still executing (the model retrying after the CLI's tool timeout) joins
 *    it, and for externally visible effects an identical call after completion in the
 *    same turn gets the original outcome back.
 *  - Emma's dispatcher collapses an identical call repeated within one model message.
 *    A harness delivers that message's calls one by one, so the caller reports the
 *    stream's tool-use events (`noteToolUse` / `noteToolResult`) and the repeat is
 *    collapsed here.
 *  - Stop: `cancelSession` refuses everything not yet started and closes the session's
 *    runs. A call already executing finishes, as it does in Emma's own loop.
 *  - Every call leaves a record (ledger), taken by the caller with `takeLedger`.
 *
 * What a tool is, how it executes and what counts as read-only are injected, so this
 * file has no dependency on agentModeService and no production caller yet (ENG-2113
 * wires it in). The executor is expected to bound its own run time; closing a run
 * releases anything waiting on it but cannot cancel a call already executing.
 */

import { randomUUID } from "crypto";
import { RunToolTokenStore, type RunToolTokenClaims, type RunToolTokenRejection } from "../../runToolToken";

export interface BridgeTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface BridgeListedTool extends BridgeTool {
  /** True only for tools that never change state whatever their arguments. A harness may run these concurrently. */
  readOnly: boolean;
}

export interface BridgeToolCall {
  name: string;
  args: Record<string, unknown>;
  /** The harness's own id for this call, when it supplies one. Identifies the call's model message for duplicate collapsing. */
  callId?: string;
}

export interface BridgeCallOptions {
  /** Aborts when the harness drops the request. The call keeps running; the ledger notes it. */
  signal?: AbortSignal;
}

export interface BridgeImage {
  mimeType: string;
  /** Base64, no data-URL prefix. */
  data: string;
}

export interface BridgeExecuteOutcome {
  content: string;
  /** Images the tool returned for the model to look at (a screenshot). */
  images?: BridgeImage[];
  isError: boolean;
  /** The tool did not act and is waiting for the user to confirm. Halts the session. */
  requiresConfirmation: boolean;
  /** The run's tool list may have changed (a skill was installed). */
  toolsChanged: boolean;
  /** The minimal tool result Emma's ledger keeps. Backend-only: it can carry approval tokens and Meta digests. */
  result?: unknown;
  /** Short, non-sensitive description of a failure. */
  error?: string;
  /** Flags the halt handler needs (unattended, delegated, shared). */
  context?: Record<string, boolean>;
}

export interface BridgeCallResult {
  content: string;
  images?: BridgeImage[];
  isError: boolean;
}

/** What `execute` is told about the call besides the call itself. */
export interface BridgeExecuteContext {
  /** Aborted when the session is stopped, the run is revoked or the run closes. Nothing is required to honor it. */
  signal: AbortSignal;
}

export type BridgeRecordKind = "executed" | "collapsed" | "joined" | "refused" | "failed";

/** One bridge call, kept for the caller to persist as Emma's loop persists its own tool calls. Backend-only. */
export interface BridgeCallRecord {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  kind: BridgeRecordKind;
  isError: boolean;
  /** What the tool really returned, as Emma's loop would persist it (images omitted). Backend-only: it can carry approval tokens. */
  toolMessageContent: string;
  /**
   * What the model was actually handed, present only when it differs from `toolMessageContent` (a halted preview answered with
   * TURN_ENDED / PERSIST_FAILED). Anything that puts this call back into chat history must use `answeredContent ?? toolMessageContent`.
   */
  answeredContent?: string;
  /** For a `collapsed` call: the id of the identical call that was already handled. */
  duplicateOfId?: string;
  /** The minimal tool result (executed calls only). */
  result?: unknown;
  error?: string;
  groupId?: string;
  groupIndex?: number;
  /** Position of the group in the stream, for ordering. */
  groupOrder?: number;
  arrivalSeq: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  /** The harness dropped the request while the call was running. */
  abortedByClient?: boolean;
  /** The run was revoked or closed while the call was executing. */
  revokedDuringCall?: boolean;
  /** The session was stopped while the call was executing. */
  cancelledDuringCall?: boolean;
  /** The call outlived its hold limit; its outcome is not known to the model. */
  heldPastLimit?: boolean;
  /** The result asked for confirmation but belongs to an earlier turn, so it was not latched or persisted. */
  staleHalt?: boolean;
  /** The call finished after its run had closed. */
  late?: boolean;
}

/** A call whose result asked for the user's confirmation. */
export interface BridgeHalt {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  groupId?: string;
  groupIndex?: number;
  /** The minimal result (in-process only: never to a browser). */
  result: unknown;
  toolMessageContent: string;
  context: Record<string, boolean>;
  epoch: number;
  haltedAt: number;
  /** True once `persistHalt` completed; false after it failed or timed out; absent when nothing persists. */
  persisted?: boolean;
}

export interface ToolBridgeDeps {
  /** The run's current filtered tool list: what Emma's own loop would offer the model right now. */
  resolveTools(run: RunToolTokenClaims): Promise<BridgeTool[]>;
  isReadOnly(toolName: string): boolean;
  execute(run: RunToolTokenClaims, call: BridgeToolCall, ctx?: BridgeExecuteContext): Promise<BridgeExecuteOutcome>;
  /** Called once when a run closes. A call may still be executing for that run. */
  releaseRun?(runId: string): void;
  /** False for tools whose identical repeat in one model message must still run. Defaults to true. */
  isDedupable?(toolName: string): boolean;
  /**
   * Makes a halt durable. Awaited, with the session's write slot held, before the halting
   * call is answered. Idempotent on (sessionId, epoch, callId): a call may be retried or
   * land late. Throwing or exceeding the timeout answers the call with a fixed error.
   */
  persistHalt?(halt: BridgeHalt, run: RunToolTokenClaims, signal: AbortSignal): Promise<void>;
  /**
   * True for calls whose identical repeat, after completion within one turn, must return
   * the original outcome rather than run again (externally visible or irreversible
   * effects). Evaluated with the call's real arguments. Defaults to false.
   */
  isStrictEffect?(toolName: string, args: Record<string, unknown>): boolean;
  /**
   * Whether the run's funding and connection are still valid right now. False means
   * revoked or disabled: the run is closed. Throwing means unknown: the call is refused
   * and the run stays open. Awaited last before the executor.
   */
  isLive?(run: RunToolTokenClaims, kind: { write: boolean }): Promise<boolean>;
}

export interface ToolBridgeOptions {
  /** How long the executing call may hold the session's write slot. Default 15 minutes. */
  callHoldLimitMs?: number;
  /** How long `persistHalt` may take. Default 10 seconds. */
  persistTimeoutMs?: number;
  /** How long after the first halt a same-message sibling may still be admitted. Default 120 seconds. */
  haltAdmissionWindowMs?: number;
  /** How long `isLive` may take. Default 5 seconds. */
  liveTimeoutMs?: number;
  /** How long a positive `isLive` answer is reused for read-only calls. Default 5 seconds. Never used for writes. */
  readLiveCacheMs?: number;
  /** How long a completed strict-effect outcome is kept for repeats. Default 10 minutes. */
  completedRepeatTtlMs?: number;
}

export interface OpenRunOptions {
  /**
   * Fires when the harness must re-read the tool list. The call that changed the list
   * is not answered until this settles, so the harness can have the new tools before
   * the model's next step. Must bound its own wait.
   */
  onToolsChanged?: () => void | Promise<void>;
  /**
   * Fires when a result halts the session, so the caller can persist it. `fallbackNeeded`
   * is true when `persistHalt` failed: the caller must get the confirmation to the user
   * some other way (a plain prompt message).
   */
  onHalted?: (info: { fallbackNeeded: boolean }) => void;
  /** Set when the session was already waiting on a confirmation before this run opened. */
  halted?: boolean;
  /**
   * How long a call waits to learn which model message it belongs to. The harness
   * reports that on a different channel from the call itself, so the call can arrive
   * first. Leave unset when nothing reports tool-use events: no wait, no collapsing.
   */
  callGroupWaitMs?: number;
}

export class ToolBridgeAuthError extends Error {
  constructor(public readonly reason: RunToolTokenRejection) {
    super(`tool bridge: token rejected (${reason})`);
    this.name = "ToolBridgeAuthError";
  }
}

/** The tool list could not be produced. Carries no detail from the underlying failure. */
export class ToolBridgeUnavailableError extends Error {
  constructor() {
    super("tool bridge: tool list unavailable");
    this.name = "ToolBridgeUnavailableError";
  }
}

export interface DrainResult {
  settled: boolean;
  stillRunning: number;
}

export interface CloseAndDrainResult extends DrainResult {
  ledger: BridgeCallRecord[];
  ledgerTruncated: number;
  halts: BridgeHalt[];
  /** Id of the run's ledger; calls that finish later are added to it (`takeLedgerByGeneration`). */
  generation: string;
}

export interface SessionStatus {
  halted: boolean;
  cancelled: boolean;
  epoch: number;
  turnActive: boolean;
  /** A call outlived its hold limit or its run closed under it: the next write needs the user's explicit confirmation. */
  unknownOutcome: boolean;
  refusedWhileHalted: number;
}

interface Announced {
  groupId: string;
  groupIndex: number;
  groupOrder: number;
  /** Present only for calls reported through `noteToolUse`. */
  name?: string;
  inputKey?: string;
}

interface Ledger {
  generation: string;
  runId: string;
  records: BridgeCallRecord[];
  bytes: number;
  truncated: number;
  closedAtMs?: number;
  /** When the last record landed (a late one extends the retention). */
  lastRecordAtMs?: number;
  /** Calls of this run generation still in the bridge. */
  pending: number;
}

interface CallCtx {
  state: RunState;
  session: SessionState;
  call: BridgeToolCall;
  toolCallId: string;
  epoch: number;
  arrivalSeq: number;
  startedAt: number;
  executing: boolean;
  /** The executor was invoked (so an effect may exist). */
  started: boolean;
  /** The hold limit passed before the executor was invoked: the call must be refused, not run late. */
  abandoned: boolean;
  /** Frees the session's write slot early (the run closed under the call). */
  releaseSlot?: () => void;
  abort: AbortController;
  abortedByClient: boolean;
  revokedDuringCall: boolean;
  cancelledDuringCall: boolean;
  heldPastLimit: boolean;
  write: boolean;
}

interface Exec {
  result: BridgeCallResult;
  /** A successful, non-halt, non-collapsed outcome: safe to hand to a joiner or a repeat. */
  shareable: boolean;
}

interface InFlight {
  callId: string;
  /** Settles when the call finishes OR outlives its hold limit (then `done` is false). */
  settled: Promise<{ done: boolean; exec?: Exec }>;
}

interface Completed {
  result: BridgeCallResult;
  atMs: number;
  bytes: number;
}

interface HaltLatch {
  epoch: number;
  groupId?: string;
  firstHaltAtMs: number;
  /** Call ids already admitted through the latch. */
  consumed: Set<string>;
  refused: number;
}

interface SessionState {
  key: string;
  userId: string;
  sessionId: string;
  epoch: number;
  turnActive: boolean;
  cancelled: boolean;
  halt: HaltLatch | null;
  halts: BridgeHalt[];
  haltsDropped: number;
  /** Tail of the queue that serializes calls to tools not known to be read-only. */
  serialTail: Promise<void>;
  inFlight: Map<string, InFlight>;
  completed: Map<string, Completed>;
  completedBytes: number;
  unknownOutcome: boolean;
  /** Set by a late event from an earlier turn; reported by the next `beginTurn`, never blocks the current turn. */
  carriedUnknown: boolean;
  runIds: Set<string>;
  touchedAtMs: number;
}

interface RunState {
  claims: RunToolTokenClaims;
  generation: string;
  session: SessionState;
  ledger: Ledger;
  toolsPromise: Promise<Map<string, BridgeListedTool>> | null;
  /** Bumped whenever the list is invalidated, so a lookup that was already in flight is not trusted. */
  toolsGeneration: number;
  closed: boolean;
  /** Refusing new calls while the run drains. */
  draining: boolean;
  /** One entry per call still awaiting a result; closing the run settles them all. */
  waiters: Set<() => void>;
  /** Calls whose executor is running, so a stop or revoke can flag them. */
  running: Set<CallCtx>;
  /** Every call that has entered the bridge and not yet finished. */
  pending: Set<Promise<unknown>>;
  onToolsChanged?: OpenRunOptions["onToolsChanged"];
  onHalted?: OpenRunOptions["onHalted"];
  callGroupWaitMs: number;
  callSeq: number;
  /** Harness call id -> where the stream put it. */
  announced: Map<string, Announced>;
  callGroupWaiters: Map<string, Set<() => void>>;
  groupCursor: { id: string; messageId?: string; size: number; order: number; lastWasResult: boolean } | null;
  groupOrderSeq: number;
  /** Per model message: dedupe key -> the call id that is handling it. */
  seenByGroup: Map<string, Map<string, string>>;
  liveOkUntilMs: number;
  /** Call ids already answered, for `pendingInGroup`. */
  answered: Set<string>;
}

const HALTED_MESSAGE =
  "This conversation is waiting for the user to confirm an earlier action. No tool can run until the user replies. " +
  "Stop here and ask the user to confirm.";
const RUN_ENDED_MESSAGE = "This run has ended.";
const LIST_UNAVAILABLE_MESSAGE = "The tool list is unavailable right now, so no tool can run.";
const CANCELLED_MESSAGE = "The user stopped this turn.";
const TURN_ENDED_MESSAGE = "That turn has ended; this call was not run.";
const PERSIST_FAILED_MESSAGE =
  "The confirmation request could not be saved. Stop here and tell the user an action is waiting for their confirmation.";
const LIVE_UNAVAILABLE_MESSAGE = "The connection could not be verified right now, so this call was not run. Try again shortly.";
const NOT_LIVE_MESSAGE = "This connection is no longer available, so no tool can run.";
const JOIN_FAILED_MESSAGE =
  "An identical call was already in progress and did not complete, so this one was not run. Do not repeat it automatically; tell the user and ask how to proceed.";
const UNKNOWN_OUTCOME_MESSAGE =
  "An identical call is still running and its outcome is not known. Do not repeat it; tell the user and ask how to proceed.";
const UNKNOWN_BLOCK_MESSAGE =
  "An earlier action in this turn did not finish and its outcome is not known, so no further changes can be made until the user confirms. " +
  "Tell the user what was attempted and ask how to proceed.";
const TOO_MANY_CALLS_MESSAGE = "Too many tool calls are in progress. Wait for them to finish.";
const REPEAT_NOTE =
  "This identical call already completed earlier in this turn; its original result is returned and it was not run again.\n";

const MAX_LIST_READS_PER_CALL = 3;
const MAX_TRACKED_CALL_IDS = 512;
const MAX_TRACKED_GROUPS = 16;
const MAX_GROUP_SIZE = 64;
const MAX_IN_FLIGHT_PER_RUN = 16;
const MAX_GROUP_WAITERS_PER_RUN = 64;
const MAX_GROUP_WAITERS_PER_CALL = 4;
const MAX_HALTS_PER_SESSION = 64;
const MAX_ADMISSIONS_PER_LATCH = 64;
const MAX_LEDGER_RECORDS = 512;
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_CONTENT_BYTES = 64 * 1024;
const MAX_COMPLETED_ENTRIES = 32;
const MAX_COMPLETED_BYTES = 512 * 1024;
const MAX_SESSIONS_TRACKED = 2048;
const LATE_RETENTION_MS = 5 * 60 * 1000;
/** A closed run's ledger is kept at most this long while calls are still pending in it (the hold limit is 15 minutes). */
const MAX_LATE_HOLD_MS = 2 * 60 * 60 * 1000;
const ABANDONED_SESSION_MS = 24 * 60 * 60 * 1000;

export class ToolBridge {
  private readonly runs = new Map<string, RunState>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly ledgers = new Map<string, Ledger>();
  private readonly lastGenerationByRun = new Map<string, string>();
  /** Executor calls in progress per run id, across run generations. */
  private readonly execCount = new Map<string, number>();
  /** Run ids whose executor state is released when their last executing call finishes. */
  private readonly releaseAfter = new Set<string>();
  private readonly holdLimitMs: number;
  private readonly persistTimeoutMs: number;
  private readonly admissionWindowMs: number;
  private readonly liveTimeoutMs: number;
  private readonly readLiveCacheMs: number;
  private readonly repeatTtlMs: number;

  constructor(
    private readonly deps: ToolBridgeDeps,
    private readonly tokens: RunToolTokenStore = new RunToolTokenStore(),
    opts: ToolBridgeOptions = {},
  ) {
    this.holdLimitMs = opts.callHoldLimitMs ?? 15 * 60 * 1000;
    this.persistTimeoutMs = opts.persistTimeoutMs ?? 10_000;
    this.admissionWindowMs = opts.haltAdmissionWindowMs ?? 120_000;
    this.liveTimeoutMs = opts.liveTimeoutMs ?? 5_000;
    this.readLiveCacheMs = opts.readLiveCacheMs ?? 5_000;
    this.repeatTtlMs = opts.completedRepeatTtlMs ?? 10 * 60 * 1000;
  }

  // ─── Runs ───────────────────────────────────────────────────────────────────

  /**
   * Opens a run and returns its token. A run already open under this id is closed first.
   * Throws if the id is open for a different user.
   */
  openRun(claims: RunToolTokenClaims, opts: OpenRunOptions = {}): string {
    if (claims.connectionId && !this.deps.isLive) {
      // Fail closed: a connection-funded run without a liveness check would keep writing after a revoke or the kill switch.
      throw new Error("tool bridge: a connection-funded run needs a liveness check");
    }
    const existing = this.runs.get(claims.runId);
    if (existing && (existing.claims.userId !== claims.userId || existing.claims.sessionId !== claims.sessionId)) {
      throw new Error("tool bridge: run id is already open for another session");
    }
    // The executor's state for this id was set up by the caller just before this, so
    // replacing a run that is still open must not release it.
    this.endRun(claims.runId, false);
    const session = this.sessionFor(claims.userId, claims.sessionId);
    if (opts.halted && !session.halt) {
      session.halt = { epoch: session.epoch, firstHaltAtMs: Date.now(), consumed: new Set(), refused: 0 };
    }
    const generation = randomUUID();
    const ledger: Ledger = { generation, runId: claims.runId, records: [], bytes: 0, truncated: 0, pending: 0 };
    this.ledgers.set(generation, ledger);
    this.lastGenerationByRun.set(claims.runId, generation);
    session.runIds.add(claims.runId);
    this.runs.set(claims.runId, {
      claims: { ...claims },
      generation,
      session,
      ledger,
      toolsPromise: null,
      toolsGeneration: 0,
      closed: false,
      draining: false,
      waiters: new Set(),
      running: new Set(),
      pending: new Set(),
      onToolsChanged: opts.onToolsChanged,
      onHalted: opts.onHalted,
      callGroupWaitMs: Math.max(0, opts.callGroupWaitMs ?? 0),
      callSeq: 0,
      announced: new Map(),
      callGroupWaiters: new Map(),
      groupCursor: null,
      groupOrderSeq: 0,
      seenByGroup: new Map(),
      liveOkUntilMs: 0,
      answered: new Set(),
    });
    return this.tokens.mint(claims);
  }

  /** Ends the run: the token stops working and everything waiting on the run is refused. */
  closeRun(runId: string): void {
    this.endRun(runId, true);
  }

  /**
   * Refuses new calls, waits up to `timeoutMs` for the calls already in the bridge, takes
   * the run's ledger and halts, then closes the run. A call that outlasts the wait keeps
   * running and its record lands in the same ledger (`takeLedgerByGeneration`).
   */
  async closeRunAndDrain(runId: string, timeoutMs: number): Promise<CloseAndDrainResult | null> {
    const state = this.runs.get(runId);
    if (!state) return null;
    const drained = await this.drain(runId, timeoutMs);
    const halts = this.snapshotHalts(state.session);
    const ledger = this.snapshotLedger(state.ledger);
    const generation = state.generation;
    this.endRun(runId, true, state);
    return { ...drained, ledger: ledger.records, ledgerTruncated: ledger.truncated, halts, generation };
  }

  /** Stops accepting calls for the run and waits for those already in the bridge. */
  async drain(runId: string, timeoutMs: number): Promise<DrainResult> {
    const state = this.runs.get(runId);
    if (!state) return { settled: true, stillRunning: 0 };
    state.draining = true;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (state.pending.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        void Promise.race([...state.pending]).then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          () => {
            clearTimeout(timer);
            resolve();
          },
        );
      });
    }
    return { settled: state.pending.size === 0, stillRunning: state.pending.size };
  }

  private safeRelease(runId: string): void {
    this.releaseAfter.delete(runId);
    try {
      this.deps.releaseRun?.(runId);
    } catch (err) {
      console.error("[tool-bridge] releaseRun failed (swallowed):", err instanceof Error ? err.message : String(err));
    }
  }

  /** An outcome we cannot know belongs to the turn the call started in; a late event never poisons a newer turn. */
  private markUnknown(ctx: CallCtx): void {
    if (ctx.epoch === ctx.session.epoch) ctx.session.unknownOutcome = true;
    else ctx.session.carriedUnknown = true;
  }

  /** `expected`: close only if this exact run is still the one open under the id (a replacement must survive a stale close). */
  private endRun(runId: string, releaseExecutor: boolean, expected?: RunState): void {
    const state = this.runs.get(runId);
    if (expected && state !== expected) return;
    this.tokens.revokeRun(runId);
    if (!state) return;
    state.closed = true;
    this.runs.delete(runId);
    state.session.runIds.delete(runId);
    state.ledger.closedAtMs = Date.now();
    // A write still executing under a closing run: its outcome may never reach the model.
    for (const ctx of state.running) {
      if (ctx.write) this.markUnknown(ctx);
      ctx.revokedDuringCall = true;
      ctx.abort.abort();
      ctx.releaseSlot?.(); // the call keeps running, but it no longer holds up the session's next writes
    }
    for (const release of [...state.waiters]) release();
    state.waiters.clear();
    for (const waiters of state.callGroupWaiters.values()) for (const wake of [...waiters]) wake();
    if (releaseExecutor) {
      // The executor's per-run state is needed until the calls still executing (of any generation) have finished.
      if ((this.execCount.get(runId) ?? 0) > 0) this.releaseAfter.add(runId);
      else this.safeRelease(runId);
    }
    if (state.session.runIds.size === 0) this.clearCompleted(state.session);
    this.pruneLedgers();
  }

  /**
   * Closes every run bound to `connectionId`, and returns their ids so the caller can
   * stop the host turns. Only reaches runs in this process; a revoke handled elsewhere
   * is caught by the per-write `isLive` check.
   */
  revokeConnection(connectionId: string): string[] {
    const ids: string[] = [];
    for (const [runId, state] of [...this.runs]) {
      if (state.claims.connectionId === connectionId) {
        ids.push(runId);
        this.endRun(runId, true);
      }
    }
    return ids;
  }

  // ─── Turns, halts, stop ─────────────────────────────────────────────────────

  /**
   * Must be called on every user message, before the turn's first call. Lifts the
   * session's halt, ends any earlier stop, starts a new epoch (calls from the old one are
   * refused) and forgets the previous turn's completed calls. Returns whether the
   * previous turn left an unknown outcome behind.
   */
  beginTurn(userId: string, sessionId: string): { previousUnknownOutcome: boolean } {
    const session = this.sessionFor(userId, sessionId);
    const previousUnknownOutcome = session.unknownOutcome || session.carriedUnknown;
    session.epoch++;
    session.halt = null;
    session.halts = [];
    session.haltsDropped = 0;
    session.cancelled = false;
    session.turnActive = true;
    session.unknownOutcome = false;
    session.carriedUnknown = false;
    this.clearCompleted(session);
    return { previousUnknownOutcome };
  }

  /**
   * A turn that never reached the model (stopped, or refused by the host before it ran) must not use up the warning `beginTurn` reported: the
   * action it warns about is still unaccounted for, and the next turn has to hear it. Safe to call for any session.
   */
  rearmUnknownOutcome(userId: string, sessionId: string): void {
    this.sessionFor(userId, sessionId).carriedUnknown = true;
  }

  /**
   * The user pressed Stop. A no-op unless a turn is active (a stale Stop cannot poison
   * the next turn). Refuses every call not yet started, flags the one executing, closes
   * the session's runs and revokes their tokens. Never touches the halt latch or the
   * halts: a confirmation already pending stays pending. The caller must also end the
   * host turn (gracefully); HTTP cannot tell that the CLI is gone.
   */
  cancelSession(userId: string, sessionId: string): { cancelled: boolean; runIds: string[] } {
    const session = this.sessions.get(sessionKey(userId, sessionId));
    if (!session || !session.turnActive) return { cancelled: false, runIds: [] };
    session.cancelled = true;
    session.turnActive = false;
    const runIds = [...session.runIds];
    for (const runId of runIds) {
      const state = this.runs.get(runId);
      if (!state) continue;
      for (const ctx of state.running) {
        ctx.cancelledDuringCall = true;
        ctx.abort.abort();
      }
      this.endRun(runId, true);
    }
    return { cancelled: true, runIds };
  }

  /** Lifts a session's confirmation halt. Only a new turn from the user may trigger this. Prefer `beginTurn`. */
  clearHalt(sessionId: string, userId?: string): void {
    const matches = [...this.sessions.values()].filter((s) => s.sessionId === sessionId && (userId === undefined || s.userId === userId));
    // Without a user id the session id must be unambiguous; otherwise leave every halt in place (the safe direction).
    if (matches.length !== 1) return;
    this.beginTurn(matches[0].userId, matches[0].sessionId);
  }

  isHalted(sessionId: string, userId?: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.sessionId === sessionId && (userId === undefined || session.userId === userId) && session.halt) return true;
    }
    return false;
  }

  sessionStatus(userId: string, sessionId: string): SessionStatus | null {
    const session = this.sessions.get(sessionKey(userId, sessionId));
    if (!session) return null;
    return {
      halted: session.halt !== null,
      cancelled: session.cancelled,
      epoch: session.epoch,
      turnActive: session.turnActive,
      unknownOutcome: session.unknownOutcome || session.carriedUnknown,
      refusedWhileHalted: session.halt?.refused ?? 0,
    };
  }

  /** The session's halts in the order they happened, as copies. PR C classifies them and builds the confirmation. */
  takeHalts(userId: string, sessionId: string): BridgeHalt[] {
    const session = this.sessions.get(sessionKey(userId, sessionId));
    return session ? this.snapshotHalts(session) : [];
  }

  /** Calls the stream announced in `groupId` that have not been answered yet (including ones that have not reached the bridge). */
  pendingInGroup(runId: string, groupId: string): number {
    const state = this.runs.get(runId);
    if (!state) return 0;
    let count = 0;
    for (const [callId, announced] of state.announced) if (announced.groupId === groupId && !state.answered.has(callId)) count++;
    return count;
  }

  // ─── Ledger ─────────────────────────────────────────────────────────────────

  /** The run's call records in stream order (group, then position in the group), as copies. `clear` empties the ledger. */
  takeLedger(runId: string, opts: { clear?: boolean } = {}): { records: BridgeCallRecord[]; truncated: number } {
    const generation = this.runs.get(runId)?.generation ?? this.lastGenerationByRun.get(runId);
    const ledger = generation ? this.ledgers.get(generation) : undefined;
    if (!ledger) return { records: [], truncated: 0 };
    const snapshot = this.snapshotLedger(ledger);
    // A run that spans many turns must be taken with `clear` at each turn's end, or it fills up and starts dropping records.
    if (opts.clear) {
      ledger.records = [];
      ledger.bytes = 0;
      ledger.truncated = 0;
    }
    return snapshot;
  }

  /** Records of a closed run, including calls that finished after it closed. Removes the ledger. */
  takeLedgerByGeneration(generation: string): { records: BridgeCallRecord[]; truncated: number } {
    this.pruneLedgers();
    const ledger = this.ledgers.get(generation);
    if (!ledger || ledger.closedAtMs === undefined) return { records: [], truncated: 0 }; // an open run's ledger is taken with takeLedger
    const snapshot = this.snapshotLedger(ledger);
    if (ledger.pending > 0) {
      // Calls are still running: keep the ledger so their records can be taken when they land.
      ledger.records = [];
      ledger.bytes = 0;
      ledger.truncated = 0;
    } else {
      this.ledgers.delete(generation);
    }
    return snapshot;
  }

  generationOf(runId: string): string | undefined {
    return this.runs.get(runId)?.generation ?? this.lastGenerationByRun.get(runId);
  }

  // ─── Stream events ──────────────────────────────────────────────────────────

  /**
   * Records which model message a harness call id belongs to. Comes from the harness's
   * own event stream, never from the model or the MCP request, so a session cannot
   * use it to dodge collapsing. Prefer `noteToolUse`, which also carries what the call
   * is, so a sibling of a halting call can be admitted.
   */
  noteCallGroup(runId: string, callId: string, groupId: string): void {
    const state = this.runs.get(runId);
    if (!state || !callId || !groupId) return;
    if (state.announced.has(callId)) return;
    state.announced.set(callId, { groupId, groupIndex: 0, groupOrder: state.groupOrderSeq++ });
    this.afterAnnounce(state, callId);
  }

  /**
   * A tool-use event from the harness's stream. Consecutive tool-use events with no tool
   * result between them (and the same `messageId`, when both have one) form one group,
   * which is how the CLI behaves: it runs every tool-use of a message before it calls the
   * model again. Any disagreement splits the group, which is the safe direction.
   */
  noteToolUse(runId: string, callId: string, name: string, input: unknown, messageId?: string): void {
    const state = this.runs.get(runId);
    if (!state || !callId || typeof name !== "string") return;
    if (state.announced.has(callId)) return; // a repeated event neither moves the call nor starts a group
    let cursor = state.groupCursor;
    const sameMessage = cursor !== null && (cursor.messageId ?? "") === (messageId ?? "");
    if (!cursor || cursor.lastWasResult || !sameMessage || cursor.size >= MAX_GROUP_SIZE) {
      cursor = { id: `${state.generation}:g${state.groupOrderSeq + 1}:${messageId ?? randomUUID().slice(0, 8)}`, messageId, size: 0, order: state.groupOrderSeq++, lastWasResult: false };
      state.groupCursor = cursor;
    }
    state.announced.set(callId, {
      groupId: cursor.id,
      groupIndex: cursor.size++,
      groupOrder: cursor.order,
      name,
      inputKey: stableStringify(input ?? {}),
    });
    this.afterAnnounce(state, callId);
  }

  /** A tool result went back to the model (any call, including ones the bridge never saw). Starts a new group. */
  noteToolResult(runId: string, _callId?: string): void {
    const state = this.runs.get(runId);
    if (state?.groupCursor) state.groupCursor.lastWasResult = true;
  }

  private afterAnnounce(state: RunState, callId: string): void {
    trimOldest(state.announced, MAX_TRACKED_CALL_IDS);
    const waiters = state.callGroupWaiters.get(callId);
    if (waiters) {
      state.callGroupWaiters.delete(callId);
      for (const wake of waiters) wake();
    }
  }

  // ─── Calls ──────────────────────────────────────────────────────────────────

  /** Checks a token without doing anything else. Throws ToolBridgeAuthError when it is not valid for the run. */
  verify(token: string | undefined | null, expectedRunId?: string): RunToolTokenClaims {
    return { ...this.authenticate(token, expectedRunId).claims };
  }

  async listTools(token: string | undefined | null, expectedRunId?: string): Promise<BridgeListedTool[]> {
    const state = this.authenticate(token, expectedRunId);
    const live = await this.checkLive(state, false);
    if (live === "revoked") throw new ToolBridgeAuthError("unknown");
    if (live === "unknown") throw new ToolBridgeUnavailableError();
    try {
      return [...(await this.currentTools(state)).values()].map((tool) => ({ ...tool }));
    } catch {
      throw new ToolBridgeUnavailableError();
    }
  }

  async callTool(
    token: string | undefined | null,
    call: BridgeToolCall,
    expectedRunId?: string,
    opts: BridgeCallOptions = {},
  ): Promise<BridgeCallResult> {
    const state = this.authenticate(token, expectedRunId);
    if (!call || typeof call.name !== "string" || !isPlainObject(call.args)) {
      return refusal("A tool call needs a tool name and an object of arguments.");
    }
    const session = state.session;
    const ctx: CallCtx = {
      state,
      session,
      call,
      toolCallId: call.callId || `bridge_${state.claims.runId}_${state.callSeq + 1}`,
      epoch: session.epoch,
      arrivalSeq: ++state.callSeq,
      startedAt: Date.now(),
      executing: false,
      started: false,
      abandoned: false,
      abort: new AbortController(),
      abortedByClient: false,
      revokedDuringCall: false,
      cancelledDuringCall: false,
      heldPastLimit: false,
      write: !this.isReadOnly(call.name),
    };
    if (opts.signal) {
      const flag = () => {
        ctx.abortedByClient = true;
      };
      if (opts.signal.aborted) flag();
      else opts.signal.addEventListener("abort", flag, { once: true });
    }

    // The whole call, from here on, is tracked so a drain can wait for it.
    const work = this.admitAndRun(ctx);
    state.pending.add(work);
    state.ledger.pending++;
    const answered = () => {
      state.pending.delete(work);
      state.ledger.pending--;
      state.answered.add(ctx.toolCallId);
      while (state.answered.size > MAX_TRACKED_CALL_IDS * 2) state.answered.delete(state.answered.values().next().value as string);
    };
    void work.then(answered, answered);
    // Closing the run releases the caller even if an earlier call never settles.
    return new Promise<BridgeCallResult>((resolve) => {
      // Not recorded here: the work itself records its own outcome when it ends.
      const release = () => resolve(refusal(RUN_ENDED_MESSAGE));
      state.waiters.add(release);
      void work.then((settled) => {
        state.waiters.delete(release);
        resolve(settled);
      });
    });
  }

  private authenticate(token: string | undefined | null, expectedRunId?: string): RunState {
    const verified = this.tokens.verify(token, expectedRunId);
    if (!verified.ok) throw new ToolBridgeAuthError(verified.reason);
    const state = this.runs.get(verified.claims.runId);
    if (!state) throw new ToolBridgeAuthError("unknown");
    return state;
  }

  /** Never rejects. Everything decided before the call joins the write queue. */
  private async admitAndRun(ctx: CallCtx): Promise<BridgeCallResult> {
    const { state, session, call } = ctx;
    try {
      if (state.draining) return this.refused(ctx, RUN_ENDED_MESSAGE);
      if (session.cancelled) return this.refused(ctx, CANCELLED_MESSAGE);
      if (state.pending.size >= MAX_IN_FLIGHT_PER_RUN) return this.refused(ctx, TOO_MANY_CALLS_MESSAGE);

      let admitted = false;
      const latch = session.halt;
      if (latch) {
        admitted = await this.admitAfterHalt(ctx);
        if (!admitted) {
          latch.refused++;
          return this.refused(ctx, session.epoch !== ctx.epoch ? TURN_ENDED_MESSAGE : HALTED_MESSAGE);
        }
        // Re-checked after the wait for the stream: the world may have changed.
        if (state.closed || session.cancelled || session.epoch !== ctx.epoch) {
          return this.refused(ctx, session.cancelled ? CANCELLED_MESSAGE : state.closed ? RUN_ENDED_MESSAGE : TURN_ENDED_MESSAGE);
        }
      }

      const readOnly = this.isReadOnly(call.name);
      if (readOnly) {
        return (await this.execute(ctx, admitted)).result;
      }

      // Joining and repeats are decided here, synchronously after the checks above and
      // before the call enters the queue: a retry queued behind its own original would
      // run after it and write twice.
      const key = joinKey(session, ctx.epoch, call);
      const running = session.inFlight.get(key);
      if (running) return await this.join(ctx, running);
      const repeat = this.completedRepeat(session, key, call);
      if (repeat) {
        return this.record(ctx, "collapsed", { content: REPEAT_NOTE + repeat.content, isError: repeat.isError, ...(repeat.images?.length ? { images: repeat.images } : {}) });
      }

      if (session.unknownOutcome) return this.refused(ctx, UNKNOWN_BLOCK_MESSAGE);

      let execPromise: Promise<Exec> | undefined;
      let heldResolve!: (v: { done: boolean; exec?: Exec }) => void;
      const settled = new Promise<{ done: boolean; exec?: Exec }>((resolve) => {
        heldResolve = resolve;
      });
      session.inFlight.set(key, { callId: ctx.toolCallId, settled });
      const slot = session.serialTail.then(async () => {
        execPromise = this.execute(ctx, admitted);
        let holdTimer: ReturnType<typeof setTimeout> | undefined;
        const held = new Promise<void>((resolve) => {
          holdTimer = setTimeout(() => {
            if (ctx.started) {
              // The executor was invoked (it may still be running or saving a halt): an effect may exist.
              ctx.heldPastLimit = true;
              this.markUnknown(ctx);
            } else {
              // Stuck before the executor (tool list, liveness): it must not run late, alongside the next write.
              ctx.abandoned = true;
            }
            heldResolve({ done: false });
            resolve();
          }, this.holdLimitMs);
          holdTimer.unref?.();
          ctx.releaseSlot = () => {
            heldResolve({ done: false });
            resolve();
          };
        });
        try {
          await Promise.race([execPromise.then(() => undefined, () => undefined), held]);
        } finally {
          if (holdTimer) clearTimeout(holdTimer);
        }
      });
      session.serialTail = slot.then(
        () => undefined,
        () => undefined,
      );
      await slot;
      // The caller of the original call waits for its own outcome, however long it takes.
      let exec: Exec | undefined;
      try {
        exec = await (execPromise as Promise<Exec>);
      } finally {
        if (session.inFlight.get(key)?.callId === ctx.toolCallId) session.inFlight.delete(key);
        // Joiners are always released, even if the original threw (they then get the fixed "did not finish" answer).
        heldResolve({ done: true, exec });
      }
      this.rememberCompleted(session, key, call, exec);
      return exec.result;
    } catch (err) {
      console.error(
        `[tool-bridge] ${call.name} failed for run ${state.claims.runId}:`,
        err instanceof Error ? err.message : String(err),
      );
      return this.record(ctx, "failed", refusal(`${call.name} failed to run.`));
    }
  }

  /** A retry of a call that is still executing: it gets the original's outcome, never a second execution. */
  private async join(ctx: CallCtx, running: InFlight): Promise<BridgeCallResult> {
    const outcome = await running.settled;
    if (!outcome.done) return this.record(ctx, "joined", refusal(UNKNOWN_OUTCOME_MESSAGE));
    if (!outcome.exec?.shareable) return this.record(ctx, "joined", refusal(JOIN_FAILED_MESSAGE));
    return this.record(ctx, "joined", { ...outcome.exec.result });
  }

  private completedRepeat(session: SessionState, key: string, call: BridgeToolCall): BridgeCallResult | null {
    if (!this.isStrict(call)) return null;
    const entry = session.completed.get(key);
    if (!entry) return null;
    if (Date.now() - entry.atMs > this.repeatTtlMs) {
      this.dropCompleted(session, key);
      return null;
    }
    return entry.result;
  }

  private rememberCompleted(session: SessionState, key: string, call: BridgeToolCall, exec: Exec): void {
    // Any other write that runs afterwards may have changed what a repeat would see.
    session.completed.clear();
    session.completedBytes = 0;
    if (!exec.shareable || !this.isStrict(call) || exec.result.images?.length) return;
    const bytes = Buffer.byteLength(exec.result.content);
    if (bytes > MAX_COMPLETED_BYTES) return;
    session.completed.set(key, { result: { content: exec.result.content, isError: false }, atMs: Date.now(), bytes });
    session.completedBytes += bytes;
    while (session.completed.size > MAX_COMPLETED_ENTRIES || session.completedBytes > MAX_COMPLETED_BYTES) {
      const oldest = session.completed.keys().next();
      if (oldest.done) break;
      this.dropCompleted(session, oldest.value);
    }
  }

  private dropCompleted(session: SessionState, key: string): void {
    const entry = session.completed.get(key);
    if (entry) session.completedBytes -= entry.bytes;
    session.completed.delete(key);
  }

  private clearCompleted(session: SessionState): void {
    session.completed.clear();
    session.completedBytes = 0;
  }

  private isStrict(call: BridgeToolCall): boolean {
    try {
      return this.deps.isStrictEffect ? this.deps.isStrictEffect(call.name, call.args) === true : false;
    } catch {
      return false;
    }
  }

  /**
   * After a halt, a call is admitted only if the stream announced it as part of the
   * SAME model message as the first halt, with the same tool and arguments, it has not
   * been admitted before, and the window since the first halt is still open.
   */
  private async admitAfterHalt(ctx: CallCtx): Promise<boolean> {
    const { state, session, call } = ctx;
    const latch = session.halt;
    if (!latch || !call.callId || !latch.groupId) return false;
    await this.callGroupOf(state, call.callId);
    if (session.halt !== latch) return false;
    return this.admitSync(ctx);
  }

  /** The synchronous half of admission: nothing can change between the checks and the admission. */
  private admitSync(ctx: CallCtx): boolean {
    const { state, session, call } = ctx;
    const latch = session.halt;
    if (!latch || !call.callId || !latch.groupId) return false;
    if (state.closed || session.cancelled || session.epoch !== ctx.epoch) return false;
    const announced = state.announced.get(call.callId);
    if (!announced || announced.groupId !== latch.groupId || announced.name === undefined) return false;
    if (announced.name !== call.name || announced.inputKey !== stableStringify(call.args)) return false;
    if (latch.consumed.has(call.callId) || latch.consumed.size >= MAX_ADMISSIONS_PER_LATCH) return false;
    if (Date.now() - latch.firstHaltAtMs > this.admissionWindowMs) return false;
    latch.consumed.add(call.callId);
    return true;
  }

  private isReadOnly(toolName: string): boolean {
    try {
      return this.deps.isReadOnly(toolName) === true;
    } catch {
      return false;
    }
  }

  private currentTools(state: RunState): Promise<Map<string, BridgeListedTool>> {
    if (!state.toolsPromise) {
      const pending = this.deps.resolveTools(state.claims).then((tools) => {
        const byName = new Map<string, BridgeListedTool>();
        for (const tool of tools) {
          byName.set(tool.name, { ...tool, readOnly: this.isReadOnly(tool.name) });
        }
        return byName;
      });
      state.toolsPromise = pending;
      // A failed lookup must not be cached, or the run could never list tools again.
      pending.catch(() => {
        if (state.toolsPromise === pending) state.toolsPromise = null;
      });
    }
    return state.toolsPromise;
  }

  private callGroupOf(state: RunState, callId: string | undefined): Promise<string | undefined> | string | undefined {
    if (!callId) return undefined;
    const known = state.announced.get(callId)?.groupId;
    if (known || state.callGroupWaitMs <= 0) return known;
    let waiters = state.callGroupWaiters.get(callId);
    let total = 0;
    for (const set of state.callGroupWaiters.values()) total += set.size;
    if (total >= MAX_GROUP_WAITERS_PER_RUN || (waiters?.size ?? 0) >= MAX_GROUP_WAITERS_PER_CALL) return undefined;
    return new Promise((resolve) => {
      if (!waiters) {
        waiters = new Set();
        state.callGroupWaiters.set(callId, waiters);
      }
      const set = waiters;
      const settle = () => {
        clearTimeout(timer);
        set.delete(settle);
        if (set.size === 0 && state.callGroupWaiters.get(callId) === set) state.callGroupWaiters.delete(callId);
        resolve(state.announced.get(callId)?.groupId);
      };
      const timer = setTimeout(settle, state.callGroupWaitMs);
      set.add(settle);
    });
  }

  private isDedupable(toolName: string): boolean {
    try {
      return this.deps.isDedupable ? this.deps.isDedupable(toolName) !== false : true;
    } catch {
      return true;
    }
  }

  /** `unknown` = could not tell; the run stays open. `revoked` = definitely gone; the run is closed. */
  private async checkLive(state: RunState, write: boolean): Promise<"live" | "revoked" | "unknown"> {
    if (!this.deps.isLive) return "live";
    if (!write && Date.now() < state.liveOkUntilMs) return "live";
    let answer: boolean;
    try {
      answer = await withTimeout(Promise.resolve(this.deps.isLive(state.claims, { write })), this.liveTimeoutMs);
    } catch {
      return "unknown";
    }
    if (answer !== true) {
      this.endRun(state.claims.runId, true, state);
      return "revoked";
    }
    if (!write) state.liveOkUntilMs = Date.now() + this.readLiveCacheMs;
    return "live";
  }

  /** Never rejects. Every check that must hold at the moment of execution is made here. */
  private async execute(ctx: CallCtx, admitted: boolean): Promise<Exec> {
    const { state, session, call } = ctx;
    const write = !this.isReadOnly(call.name);
    const group = await this.callGroupOf(state, call.callId);
    let tools: Map<string, BridgeListedTool> | undefined;
    try {
      // A list that was invalidated while this call awaited it is read again.
      for (let reads = 0; reads < MAX_LIST_READS_PER_CALL; reads++) {
        const generation = state.toolsGeneration;
        const current = await this.currentTools(state);
        if (generation === state.toolsGeneration) {
          tools = current;
          break;
        }
      }
    } catch {
      return this.exec(ctx, "refused", refusal(LIST_UNAVAILABLE_MESSAGE));
    }
    if (!tools) return this.exec(ctx, "refused", refusal(LIST_UNAVAILABLE_MESSAGE));

    // The last await before the executor: a revoke or disable is seen here. No positive
    // cache for writes.
    const live = await this.checkLive(state, write);
    if (live === "revoked") return this.exec(ctx, "refused", refusal(NOT_LIVE_MESSAGE));
    if (live === "unknown") return this.exec(ctx, "refused", refusal(LIVE_UNAVAILABLE_MESSAGE));

    // Checked after the last await above, with nothing async before the executor is
    // invoked, so a halt, stop, close or list change that lands while this call was
    // waiting still stops it.
    if (session.cancelled) return this.exec(ctx, "refused", refusal(CANCELLED_MESSAGE));
    if (state.closed) return this.exec(ctx, "refused", refusal(RUN_ENDED_MESSAGE));
    if (session.epoch !== ctx.epoch) return this.exec(ctx, "refused", refusal(TURN_ENDED_MESSAGE));
    if (ctx.abandoned) return this.exec(ctx, "refused", refusal(LIST_UNAVAILABLE_MESSAGE));
    // A write that was already queued when an outcome became unknown must not run past the block.
    if (write && session.unknownOutcome) return this.exec(ctx, "refused", refusal(UNKNOWN_BLOCK_MESSAGE));
    // A sibling that was queued before the halt landed gets the same admission as one that arrives after it.
    if (session.halt && !admitted && !this.admitSync(ctx)) return this.exec(ctx, "refused", refusal(HALTED_MESSAGE));
    if (!tools.has(call.name)) return this.exec(ctx, "refused", refusal(`${call.name} is not available in this run.`));

    if (group && call.callId && this.isDedupable(call.name)) {
      let seen = state.seenByGroup.get(group);
      if (!seen) {
        seen = new Map();
        state.seenByGroup.set(group, seen);
        trimOldest(state.seenByGroup, MAX_TRACKED_GROUPS);
      }
      const key = `${call.name}:${stableStringify(call.args)}`;
      const handledBy = seen.get(key);
      if (handledBy && handledBy !== call.callId) {
        // Same wording Emma's dispatcher gives a collapsed call. Not an error: the work is being done once.
        return this.exec(ctx, "collapsed", {
          content:
            `This call was collapsed: an identical ${call.name} call with the same arguments ` +
            `was already handled by tool_call_id ${handledBy}. Use that completed tool result — do not repeat this call.`,
          isError: false,
        }, { duplicateOfId: handledBy });
      }
      seen.set(key, call.callId);
    }

    let outcome: BridgeExecuteOutcome;
    ctx.executing = true;
    ctx.started = true;
    state.running.add(ctx);
    this.execCount.set(state.claims.runId, (this.execCount.get(state.claims.runId) ?? 0) + 1);
    try {
      outcome = await this.deps.execute(state.claims, call, { signal: ctx.abort.signal });
      if (!outcome || typeof outcome.content !== "string") throw new Error("executor returned no result");
    } catch (err) {
      console.error(
        `[tool-bridge] ${call.name} failed for run ${state.claims.runId}:`,
        err instanceof Error ? err.message : String(err),
      );
      return this.exec(ctx, "failed", refusal(`${call.name} failed to run.`), { error: "executor failed" });
    } finally {
      ctx.executing = false;
      state.running.delete(ctx);
      const runId = state.claims.runId;
      const left = (this.execCount.get(runId) ?? 1) - 1;
      if (left > 0) this.execCount.set(runId, left);
      else this.execCount.delete(runId);
      // Not if the id was reopened meanwhile: the executor's state now belongs to the new run (released when that one closes).
      if (left <= 0 && this.releaseAfter.has(runId) && !this.runs.has(runId)) this.safeRelease(runId);
    }

    let result: BridgeCallResult = {
      content: outcome.content,
      isError: outcome.isError === true,
      ...(outcome.images?.length ? { images: outcome.images } : {}),
    };
    const actual = result;
    let shareable = !result.isError && !outcome.requiresConfirmation;
    let staleHalt = false;

    if (outcome.requiresConfirmation) {
      const halted = await this.latchAndPersist(ctx, outcome, group);
      staleHalt = halted.stale;
      if (halted.stale) {
        // The turn this preview belongs to is over, so nothing latched and nothing will ask the user: the model must not
        // be handed the text (it can carry the approval token). The ledger keeps what the tool really returned.
        result = refusal(TURN_ENDED_MESSAGE);
        shareable = false;
      } else if (halted.failedAnswer) {
        result = halted.failedAnswer;
        shareable = false;
      }
    }

    if (outcome.toolsChanged) {
      state.toolsPromise = null;
      state.toolsGeneration++;
      if (!state.closed && state.onToolsChanged) {
        try {
          await state.onToolsChanged();
        } catch (err) {
          console.error("[tool-bridge] onToolsChanged failed (swallowed):", err instanceof Error ? err.message : String(err));
        }
      }
    }
    // A new turn may have begun while the halt was being saved or the tool list refreshed: the text (it can carry the
    // approval token) must not reach the model of a turn that no longer has a halt to answer to.
    if (outcome.requiresConfirmation && !staleHalt && session.epoch !== ctx.epoch) {
      staleHalt = true;
      result = refusal(TURN_ENDED_MESSAGE);
      shareable = false;
    }
    return this.exec(ctx, "executed", result, { outcome, staleHalt, shareable, recordAs: actual });
  }

  /**
   * Latches the session (synchronously), then makes the halt durable while the caller
   * still holds the write slot. A halt from an earlier epoch is recorded in the ledger
   * only. Never throws.
   */
  private async latchAndPersist(
    ctx: CallCtx,
    outcome: BridgeExecuteOutcome,
    group: string | undefined,
  ): Promise<{ stale: boolean; failedAnswer?: BridgeCallResult }> {
    const { state, session, call } = ctx;
    // Latched even if the run closed while the tool was executing: the confirmation is
    // still outstanding for the session.
    if (session.epoch !== ctx.epoch) return { stale: true };
    const announced = call.callId ? state.announced.get(call.callId) : undefined;
    if (!session.halt) {
      session.halt = { epoch: session.epoch, groupId: group, firstHaltAtMs: Date.now(), consumed: new Set(), refused: 0 };
    }
    // A halting call's id can never be admitted again: a replay would run the preview a second time.
    session.halt.consumed.add(ctx.toolCallId);
    const halt: BridgeHalt = {
      callId: ctx.toolCallId,
      name: call.name,
      args: deepCopy(call.args),
      ...(group ? { groupId: group } : {}),
      ...(announced ? { groupIndex: announced.groupIndex } : {}),
      result: deepCopy(outcome.result ?? null),
      toolMessageContent: capText(outcome.content, MAX_RECORD_CONTENT_BYTES),
      context: { ...(outcome.context ?? {}) },
      epoch: ctx.epoch,
      haltedAt: Date.now(),
    };
    if (session.halts.length < MAX_HALTS_PER_SESSION) session.halts.push(halt);
    else session.haltsDropped++;

    if (!this.deps.persistHalt) {
      notify(state.onHalted, { fallbackNeeded: false });
      return { stale: false };
    }
    const controller = new AbortController();
    try {
      const persisting = Promise.resolve(this.deps.persistHalt(deepCopy(halt), { ...state.claims }, controller.signal));
      persisting.catch(() => undefined); // an abandoned persist must not become an unhandled rejection
      await withTimeout(persisting, this.persistTimeoutMs);
      halt.persisted = true;
      notify(state.onHalted, { fallbackNeeded: false });
      return { stale: false };
    } catch {
      controller.abort();
      halt.persisted = false;
      notify(state.onHalted, { fallbackNeeded: true });
      return { stale: false, failedAnswer: refusal(PERSIST_FAILED_MESSAGE) };
    }
  }

  // ─── Records ────────────────────────────────────────────────────────────────

  private refused(ctx: CallCtx, message: string): BridgeCallResult {
    return this.record(ctx, "refused", refusal(message));
  }

  private exec(
    ctx: CallCtx,
    kind: BridgeRecordKind,
    result: BridgeCallResult,
    extra: { outcome?: BridgeExecuteOutcome; error?: string; staleHalt?: boolean; shareable?: boolean; recordAs?: BridgeCallResult; duplicateOfId?: string } = {},
  ): Exec {
    this.record(ctx, kind, result, extra);
    return { result, shareable: extra.shareable === true && kind === "executed" };
  }

  /** Adds the call to its run's ledger, even if the run has closed since. Returns the result for convenience. */
  private record(
    ctx: CallCtx,
    kind: BridgeRecordKind,
    result: BridgeCallResult,
    extra: { outcome?: BridgeExecuteOutcome; error?: string; staleHalt?: boolean; recordAs?: BridgeCallResult; duplicateOfId?: string } = {},
  ): BridgeCallResult {
    const { state, call } = ctx;
    const returned = result;
    if (extra.recordAs) result = extra.recordAs; // the ledger keeps what the tool really returned
    const ledger = state.ledger;
    const announced = call.callId ? state.announced.get(call.callId) : undefined;
    const endedAt = Date.now();
    ledger.lastRecordAtMs = endedAt;
    const content = capText(result.content, MAX_RECORD_CONTENT_BYTES);
    const answered = returned === result ? content : capText(returned.content, MAX_RECORD_CONTENT_BYTES);
    const entry: BridgeCallRecord = {
      toolCallId: ctx.toolCallId,
      name: call.name,
      args: deepCopy(call.args),
      kind,
      isError: result.isError,
      toolMessageContent: content,
      ...(answered !== content ? { answeredContent: answered } : {}),
      ...(extra.duplicateOfId ? { duplicateOfId: extra.duplicateOfId } : {}),
      ...(extra.outcome?.result !== undefined ? { result: deepCopy(extra.outcome.result) } : {}),
      ...((extra.error ?? extra.outcome?.error) ? { error: extra.error ?? extra.outcome?.error } : {}),
      ...(announced ? { groupId: announced.groupId, groupIndex: announced.groupIndex, groupOrder: announced.groupOrder } : {}),
      arrivalSeq: ctx.arrivalSeq,
      startedAt: ctx.startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - ctx.startedAt),
      ...(ctx.abortedByClient ? { abortedByClient: true } : {}),
      ...(ctx.revokedDuringCall ? { revokedDuringCall: true } : {}),
      ...(ctx.cancelledDuringCall ? { cancelledDuringCall: true } : {}),
      ...(ctx.heldPastLimit ? { heldPastLimit: true } : {}),
      ...(extra.staleHalt ? { staleHalt: true } : {}),
      ...(state.closed ? { late: true } : {}),
    };
    try {
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (ledger.records.length >= MAX_LEDGER_RECORDS || ledger.bytes + size > MAX_LEDGER_BYTES) {
        ledger.truncated++;
      } else {
        ledger.records.push(entry);
        ledger.bytes += size;
      }
    } catch {
      ledger.truncated++; // an unserializable result must never break the call it describes
    }
    return returned;
  }

  private snapshotLedger(ledger: Ledger): { records: BridgeCallRecord[]; truncated: number } {
    const records = deepCopy(ledger.records).sort((a, b) => {
      const ag = a.groupOrder;
      const bg = b.groupOrder;
      if (ag !== undefined && bg !== undefined) return ag !== bg ? ag - bg : (a.groupIndex ?? 0) - (b.groupIndex ?? 0) || a.arrivalSeq - b.arrivalSeq;
      if (ag !== undefined) return -1; // announced calls come before ones the stream never mentioned
      if (bg !== undefined) return 1;
      return a.arrivalSeq - b.arrivalSeq;
    });
    return { records, truncated: ledger.truncated };
  }

  private snapshotHalts(session: SessionState): BridgeHalt[] {
    return deepCopy(session.halts).sort(
      (a, b) => (a.groupIndex ?? Number.MAX_SAFE_INTEGER) - (b.groupIndex ?? Number.MAX_SAFE_INTEGER) || a.haltedAt - b.haltedAt,
    );
  }

  private pruneLedgers(): void {
    const now = Date.now();
    for (const [generation, ledger] of this.ledgers) {
      if (ledger.closedAtMs === undefined) continue;
      const age = now - ledger.closedAtMs;
      const idle = now - Math.max(ledger.closedAtMs, ledger.lastRecordAtMs ?? 0);
      // Kept while calls are still pending in it: a write finishing late must never be invisible.
      if ((ledger.pending <= 0 && idle > LATE_RETENTION_MS) || age > MAX_LATE_HOLD_MS) {
        this.ledgers.delete(generation);
        if (this.lastGenerationByRun.get(ledger.runId) === generation) this.lastGenerationByRun.delete(ledger.runId);
      }
    }
  }

  private sessionFor(userId: string, sessionId: string): SessionState {
    const key = sessionKey(userId, sessionId);
    let session = this.sessions.get(key);
    if (session) session.touchedAtMs = Date.now();
    if (!session) {
      session = {
        key,
        userId,
        sessionId,
        epoch: 0,
        turnActive: false,
        cancelled: false,
        halt: null,
        halts: [],
        haltsDropped: 0,
        serialTail: Promise.resolve(),
        inFlight: new Map(),
        completed: new Map(),
        completedBytes: 0,
        unknownOutcome: false,
        carriedUnknown: false,
        runIds: new Set(),
        touchedAtMs: Date.now(),
      };
      this.sessions.set(key, session);
      this.trimSessions();
    }
    return session;
  }

  /** Forgets idle sessions that carry nothing (no run, no halt, no pending call) once there are too many. */
  private trimSessions(): void {
    if (this.sessions.size <= MAX_SESSIONS_TRACKED) return;
    for (const [key, session] of this.sessions) {
      if (this.sessions.size <= MAX_SESSIONS_TRACKED) return;
      if (session.runIds.size > 0 || session.inFlight.size > 0) continue;
      const carries = session.halt !== null || session.unknownOutcome;
      // A halted session with no run is already persisted through persistHalt; it is forgotten after a day.
      if (!carries || Date.now() - session.touchedAtMs > ABANDONED_SESSION_MS) this.sessions.delete(key);
    }
  }
}

function sessionKey(userId: string, sessionId: string): string {
  return `${userId}\u0000${sessionId}`;
}

function joinKey(session: SessionState, epoch: number, call: BridgeToolCall): string {
  return `${session.key}\u0000${epoch}\u0000${call.name}\u0000${stableStringify(call.args)}`;
}

function notify<T>(callback: ((info: T) => void) | undefined, info: T): void {
  if (!callback) return;
  try {
    callback(info);
  } catch (err) {
    console.error("[tool-bridge] onHalted failed (swallowed):", err instanceof Error ? err.message : String(err));
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function trimOldest<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

function capText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  return `${Buffer.from(text).subarray(0, maxBytes).toString()}\n[truncated in the bridge ledger]`;
}

function deepCopy<T>(value: T): T {
  if (value === undefined || value === null) return value;
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      return value;
    }
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

function refusal(message: string): BridgeCallResult {
  return { content: message, isError: true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
