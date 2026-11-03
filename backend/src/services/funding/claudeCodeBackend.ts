/**
 * ENG-2113 PR C: runs ONE interactive chat turn on the user's own Claude plan, in the MAIN process, and returns what Emma's own loop would have
 * returned, so the controller persists and answers it exactly as it does today.
 *
 * Order matters (every step has a test); one try/finally releases everything, always:
 *   1. host client present                      -> else typed stop `host_unavailable` (nothing opened)
 *   2. prepare the turn context (the same code Emma's loop uses), trim old tool results, render ONE prompt; too large -> `context_too_large`
 *   3. executor.registerRun, bridge.openRun (per-turn token), bridge.beginTurn (lifts a halt from a previous turn), executor.beginTurn
 *   4. register the cancel handle, THEN re-check the Stop flag (the controller clears it at the start of a turn; a Stop in the gap sets it again)
 *   5. runHostTurn; every stream event feeds the bridge (grouping, collapsing) and the progress statuses
 *   6. closeRunAndDrain: wait for in-flight tool calls, take the ledger and the halts
 *   7. map: completed -> Emma's message shape; cancelled -> persist the settled tool work, return `cancelled`; unknown outcome -> persist the tool
 *      work and tell the user plainly; a failed result -> typed stop (a dead login also flags the connection for reconnect)
 *
 * Scope of this PR (plain chat): a tool that asks for confirmation ends the turn with a plain "confirm" note (no approval deck, so a Meta write
 * cannot be confirmed yet), nothing is persisted mid-turn (a crash loses the turn's tool messages), no citations, no work-plan retry, no
 * auto-continuations. Those are the next PRs. NEVER falls back to AgentWeb's models: every failure is a typed stop.
 */
import { randomUUID } from "crypto";
import type { ProviderEvent } from "../../loginHost/adapter";
import { LoginHostError, type LoginHostClient } from "./loginHostClient";
import type { HostTurnOptions, HostTurnOutcome } from "./loginHostTurn";
import type { RouteInput } from "../../loginHost/protocol";
import type { BridgeCallOptions, BridgeCallRecord, BridgeCallResult, BridgeHalt, BridgeListedTool, BridgeToolCall, CloseAndDrainResult } from "./toolBridge";
import { buildRelayManifest, manifestCut, manifestLogFields, manifestProblem, type RelayManifest } from "./relayManifest";
import { RESULT_LOST_NOTE, RelayToolDispatcher } from "./relayToolDispatcher";
import { ToolBridgeAuthError } from "./toolBridge";
import { safeText, safeToken } from "./logSafe";
import { ReconnectGuard } from "./reconnectGuard";
import type { RunToolTokenClaims } from "./runToolToken";
import type { PlanRoute } from "./claudeFunding";
import type { ClaudeRunRegistry } from "./claudeRunRegistry";
import { ClaudeRunConflictError } from "./claudeRunRegistry";
import { PromptTooLargeError, appendDirective, renderPromptForCli } from "./claudePromptRenderer";
import { mapLedgerToResponseMessages, type ClaudeTurnUsage } from "./claudeTurnMessages";
import { ClaudeRouteStopError, fromHostFailure, fromResultErrorKind, markTurnToolsRan, turnRanNoTools } from "./claudeRouteErrors";
import type { AttemptUsage } from "./attemptUsageJournal";
import type { RunFunding } from "./runFunding";

export interface ClaudeTurnParams {
  decision: PlanRoute;
  sessionId: string;
  /** The session owner (also the initiator: the allow-list guarantees it). */
  userId: string;
  /** The billing subject of the owner (the org root for an org member). */
  billingUserId?: string;
  messageContent: string;
  sessionHistory: any[];
  /** The registry id, kept everywhere inside Emma. The CLI alias comes from `decision.alias`. */
  llmModel: string;
  isDelegatedAccess?: boolean;
  screenshotUrl?: string;
  excludeTools?: string[];
  /** Epoch ms the controller stamped when the whole-turn cap started. */
  turnStartMs?: number;
  /** Stamps on every assistant message (the AgentWeb Model selection, etc.). */
  stamps?: Record<string, unknown>;
  onProgress?: (progress: { iteration: number; status: string; toolCalls?: any[]; pendingTools?: string[] }) => void;
}

export interface ClaudeTurnResult {
  content: string;
  toolCalls: any[];
  knowledgeBaseQueries: string[];
  sources: string[];
  responseMessages: any[];
  persistedResponseCount: number;
  cancelled?: boolean;
}

export interface ClaudeBackendDeps {
  hostClient(): LoginHostClient | undefined;
  prepareTurnContext(input: {
    messageContent: string;
    sessionHistory: any[];
    userId: string;
    llmModel: string;
    sessionId: string;
    isInteractiveShare: boolean;
    screenshotUrl?: string;
    isDelegatedAccess: boolean;
    publishAuthorizationOverride?: undefined;
    isUnattendedRun: boolean;
  }): Promise<{ messages: any[]; billingUserId?: string }>;
  trimToolMessages(messages: any[]): any[];
  runHostTurn(client: LoginHostClient, req: RouteInput<"turn.run">, opts: HostTurnOptions): Promise<HostTurnOutcome>;
  bridge: {
    openRun(claims: RunToolTokenClaims, opts?: { callGroupWaitMs?: number; onHalted?: (info: { fallbackNeeded: boolean }) => void }): string;
    beginTurn(userId: string, sessionId: string): { previousUnknownOutcome: boolean } | undefined;
    /** Puts back the "an earlier action may not have finished" warning when a turn ended before the model could read it. */
    rearmUnknownOutcome(userId: string, sessionId: string): void;
    noteToolUse(runId: string, callId: string, name: string, input: unknown, messageId?: string): void;
    noteToolResult(runId: string, callId?: string): void;
    closeRunAndDrain(runId: string, timeoutMs: number): Promise<CloseAndDrainResult | null>;
    closeRun(runId: string): void;
    cancelSession(userId: string, sessionId: string): unknown;
    takeHalts(userId: string, sessionId: string): BridgeHalt[];
    /** The run's ledger, still readable after the run was closed (a Stop closes it before the drain). */
    takeLedger(runId: string): { records: BridgeCallRecord[]; truncated: number };
    ranCall?(runId: string, callId: string): boolean;
    generationOf(runId: string): string | undefined;
    takeLedgerByGeneration(generation: string): { records: BridgeCallRecord[]; truncated: number };
    /** The tool relay (protocol 4) calls the bridge in process with the run's internal token: both are needed for it, and without them the HTTP bridge path is used. */
    listTools?(token: string, runId: string): Promise<BridgeListedTool[]>;
    /** Whether the session waits on a confirmation (the relay's halt grouping depends on it, so there is no default). */
    isHalted(sessionId: string, userId?: string): boolean;
    callTool?(token: string, call: BridgeToolCall, runId: string, opts?: BridgeCallOptions): Promise<BridgeCallResult>;
  };
  /**
   * The tool relay is used for a turn iff the worker reports protocol >= 4 AND the version check says `match` AND the bridge can be called in process. Any other
   * answer (older worker, not yet asked, mismatch, no `relay` dependency) runs the turn on the HTTP bridge exactly as before.
   */
  relay?: {
    workerProtocol(): number | undefined;
    protocolStatus(): "match" | "mismatch" | "unknown";
    /** Forget the cached worker protocol and ask the worker again (it contradicted the cache, e.g. refused `tools` after a rollback). */
    invalidateProtocol?(): void;
    /** Whether a worker older than protocol 4 may run turns on the HTTP bridge. Absent or false (the production default) = refused. */
    allowLegacyBridge?(): boolean;
  };
  /** Batched confirmations after a halt (see RelayDispatcherOptions.admitPostHaltSiblings). Default false: the first confirmation ends the turn's tool work. */
  relayAdmitPostHaltSiblings?: boolean;
  /** Consecutive turns that must report a dead login before the connection record is marked (default 2; see reconnectGuard.ts). */
  reconnectSignalsRequired?: number;
  /**
   * Asks the worker whether it agrees the login is dead (the same worker that made the claim: a consistency check, not independent evidence). Default: "needs_reconnect" when `connection.status` says so (independent evidence: the record is marked at
   * once), anything else: the signal must repeat on consecutive turns. Tests replace it.
   */
  confirmDeadLogin?(client: LoginHostClient, connectionId: string): Promise<boolean | "needs_reconnect">;
  /** How long before the turn's deadline no further tool may start (the model is told to write its answer). Default 75 s, never more than half the deadline. */
  softDeadlineLeadMs?: number;
  /** How long a relayed call waits for the stream line that announces it (default 1.5 s; tests shorten it). */
  relayAnnounceWaitMs?: number;
  executor: {
    registerRun(runId: string, ctx: { llmModel: string; isDelegatedAccess?: boolean; excludeTools?: string[]; screenshotUrl?: string; socketEmit?: (room: string, event: string, payload: any) => void; fundingScope?: RunFunding }): void;
    beginTurn(runId: string, turn: { agentRuntimeRunId?: string; priorSearchCallCount?: number }): void;
    releaseRun(runId: string): void;
  };
  registry: ClaudeRunRegistry;
  isCancelled(sessionId: string): boolean;
  /** Saves settled messages when the turn ends without an answer to persist (Stop, timeout, lost connection). */
  persistMessages(sessionId: string, messages: any[]): Promise<void>;
  markNeedsReconnect(connectionId: string, epoch: number, reason: string): Promise<void>;
  writeJournal(row: AttemptUsage): Promise<void>;
  emptyFallbackText: string;
  now(): number;
  newRunId(): string;
  /** Live-refresh events from tools (a CRM or coding-agent change): the same Socket.IO forward the worker path uses. */
  socketEmit?: (room: string, event: string, payload: any) => void;
  /** Cap for the whole turn; the host deadline is what is left of it. Default 600 s (the controller's generation timeout). */
  turnHardCapMs?: number;
  drainTimeoutMs?: number;
  /** Web searches the session already used (the per-session cap): `seedSearchCallCountFromHistory`. Default 0. */
  seedSearchCount?(history: any[]): number;
  /** How long, and how often, to look for a tool call that was still executing when the turn ended. Defaults: the bridge hold limit (15 min), 3 s. */
  lateWatchMaxMs?: number;
  lateWatchPollMs?: number;
}

const GRACE_MS = 20_000;
const MIN_DEADLINE_MS = 30_000;
/** The host may hold a turn up to this long waiting for a free slot before it starts; the deadline is counted from the start of the turn. */
const HOST_BUSY_WAIT_MS = 40_000;
/** The host's own ceiling for a turn deadline. */
const MAX_DEADLINE_MS = 3_600_000;
/** The bridge gives up on a call it is still holding after this long (the longest a late record can still arrive). */
const LATE_WATCH_DEFAULT_MS = 15 * 60_000;
/** The first worker protocol that serves the tool relay. */
export const RELAY_MIN_PROTOCOL = 4;
const SOFT_DEADLINE_LEAD_MS = 75_000;

export type ToolTransportChoice = { kind: "relay" } | { kind: "legacy" } | { kind: "refuse"; cause: "protocol_unknown" | "protocol_mismatch" | "protocol_too_old" | "bridge_not_in_process" };

/**
 * The one decision about a turn's tool transport, made BEFORE anything is opened. Fail closed (B3): the HTTP bridge is used only for a worker KNOWN to speak
 * an older protocol (on production its bridge URL is a zero-tool stub, so a relay-capable worker must never silently get it). Exported so the tests and the
 * pilot's checks state it once.
 *   - status "match" and protocol >= 4, bridge callable in process  -> relay
 *   - status "match" and protocol a known number < 4                -> legacy HTTP bridge ONLY where `allowLegacyBridge()` says so, else refuse
 *   - status "unknown" (not asked yet, or a failed recheck), "mismatch", or a 4+ worker without an in-process bridge -> refuse (typed, retryable stop)
 * A backend built without the `relay` dependency (tests, tools) keeps the legacy path; the production instance always has it.
 */
export function chooseToolTransport(d: Pick<ClaudeBackendDeps, "relay" | "bridge">): ToolTransportChoice {
  const r = d.relay;
  if (!r) return { kind: "legacy" };
  const status = r.protocolStatus();
  const protocol = r.workerProtocol();
  if (status !== "match" || typeof protocol !== "number") return { kind: "refuse", cause: status === "mismatch" ? "protocol_mismatch" : "protocol_unknown" };
  // S2: on production the HTTP bridge is a zero-tool stub, so an older worker (a rollback) must not silently run turns without tools. The legacy path is
  // reachable only where it is explicitly allowed (a test or dev environment whose bridge URL serves real tools).
  if (protocol < RELAY_MIN_PROTOCOL) return r.allowLegacyBridge?.() === true ? { kind: "legacy" } : { kind: "refuse", cause: "protocol_too_old" };
  if (typeof d.bridge.listTools !== "function" || typeof d.bridge.callTool !== "function") return { kind: "refuse", cause: "bridge_not_in_process" };
  return { kind: "relay" };
}

/**
 * Whether an EINVALID answer to a relay `turn.run` means "this worker is older than the cached protocol says" (a rollback). What a protocol 3 worker answers to a
 * `tools` field is its closed schema refusing the unknown key (`body:unrecognized_keys`) and the missing `bridgeToken` (`bridgeToken:invalid_type`); a worker
 * that has no relay says `relay_unsupported`. Every other EINVALID (`tools:<reason>`, `too_large`, a bad field) is the manifest or the request being wrong on a
 * worker that does speak the relay: invalidating the cache for that would make ONE bad manifest refuse every user's turn until the worker answers again.
 */
export function refusedAsOldWorker(detail: string | undefined): boolean {
  return /unrecognized_keys|bridgeToken:invalid_type|relay_unsupported/.test(detail ?? "");
}

/**
 * `CLAUDE_PLAN_ALLOW_LEGACY_BRIDGE`: only the exact string "true" allows the HTTP bridge for a worker older than protocol 4; unset or anything else is off.
 * NEVER in production: the flag is ignored there. On production the HTTP bridge is a zero-tool stub, and a compromised worker that reports "protocol 3" would
 * otherwise be handed a bridge token and the bridge by a flag that leaked into the environment. (Dev and test boxes set it explicitly.)
 */
export function legacyBridgeAllowed(env: Record<string, string | undefined> = process.env): boolean {
  if (env.NODE_ENV === "production") return false;
  return env.CLAUDE_PLAN_ALLOW_LEGACY_BRIDGE === "true";
}

/** True iff `chooseToolTransport` picks the relay. */
export function relayAvailable(d: Pick<ClaudeBackendDeps, "relay" | "bridge">): boolean {
  return chooseToolTransport(d).kind === "relay";
}

/**
 * A call whose result the worker could no longer take ran (or may have) but the model never read the answer: the persisted tool result says so (A1), so the
 * next turn does not repeat it blindly. Only calls that really ran are marked; a refusal executed nothing.
 */
export function annotateLostResults(ledger: BridgeCallRecord[], isLost: (toolCallId: string) => boolean): BridgeCallRecord[] {
  return ledger.map((r) => {
    if ((r.kind !== "executed" && r.kind !== "failed") || !isLost(r.toolCallId)) return r;
    return {
      ...r,
      toolMessageContent: `${r.toolMessageContent}\n${RESULT_LOST_NOTE}`,
      ...(r.answeredContent !== undefined ? { answeredContent: `${r.answeredContent}\n${RESULT_LOST_NOTE}` } : {}),
    };
  });
}

/** Most tokens one count may claim (a worker's `usage` event is hostile input: 1e308 values add up to Infinity). */
export const MAX_TOKEN_COUNT = 1_000_000_000;
export function clampCount(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_TOKEN_COUNT) : 0;
}

const RESULT_ERROR_KINDS = ["usage_limit", "auth_dead", "transient", "device_code_disabled", "refresh_reused", "policy_blocks", "unknown"] as const;
const RESULT_ABORT_REASONS = ["deadline", "interrupted", "lease_lapsed"] as const;

export const OUTCOME_UNKNOWN_NOTE =
  "I lost the connection to your Claude plan while working on this. It may or may not have finished. Please check the results before asking me to repeat anything.";
export const LATE_RESULT_NOTE = "The action above finished after this turn was stopped. Please check the result before asking me to repeat it.";
export const PREVIOUS_UNKNOWN_DIRECTIVE =
  "An action in the previous turn may have run without its result reaching you. Before repeating any action that changes something, check its current state with a read-only tool, or ask the user.";
export const CONFIRMATION_NOTE =
  "That action needs your confirmation before I can go on. Approval cards are not available on your Claude plan yet, so I have stopped here without doing it.";

export class ClaudeCodeBackend {
  constructor(private readonly deps: ClaudeBackendDeps) {
    this.reconnectGuard = new ReconnectGuard(deps.now, deps.reconnectSignalsRequired ?? 2);
  }

  private readonly reconnectGuard: ReconnectGuard;

  private readonly watchers = new Set<Promise<void>>();
  private readonly wakers = new Set<() => void>();
  private flushing = false;

  /** Resolves when no late-result watcher is running (tests). */
  async idle(): Promise<void> {
    while (this.watchers.size > 0) await Promise.allSettled([...this.watchers]);
  }

  /** Shutdown: every watcher looks one last time for late records, saves them, and ends. Resolves when all have. */
  async flush(): Promise<void> {
    this.flushing = true;
    for (const wake of [...this.wakers]) wake();
    await this.idle();
    this.flushing = false;
  }

  /**
   * Every failure leaves here as a typed stop. A raw error (a database blip, a bug) is never shown as-is and never reaches the generic error path that
   * would call the diagnosis agent; the detail goes to the log only.
   */
  async run(p: ClaudeTurnParams): Promise<ClaudeTurnResult> {
    try {
      return await this.runInner(p);
    } catch (err) {
      if (err instanceof ClaudeRouteStopError) throw err;
      console.error("[claude-backend] turn failed:", safeText(err));
      const stop = new ClaudeRouteStopError("turn_failed");
      markTurnToolsRan(stop, !turnRanNoTools(err)); // the raw error carries what the run knew; an unmarked one stays "may have run"
      throw stop;
    }
  }

  private async runInner(p: ClaudeTurnParams): Promise<ClaudeTurnResult> {
    const d = this.deps;
    const client = d.hostClient();
    if (!client) throw noToolsStop("host_unavailable");
    // 1b. the tool transport, decided before anything is opened (fail closed: see chooseToolTransport)
    const transportChoice = chooseToolTransport(d);
    if (transportChoice.kind === "refuse") {
      console.error(`[claude-backend] relay_refused cause=${transportChoice.cause}`);
      throw noToolsStop("host_unavailable");
    }

    // 2. prompt (before anything is opened)
    const ctx = await d.prepareTurnContext({
      messageContent: p.messageContent,
      sessionHistory: p.sessionHistory,
      userId: p.userId,
      llmModel: p.llmModel,
      sessionId: p.sessionId,
      isInteractiveShare: false,
      screenshotUrl: p.screenshotUrl,
      isDelegatedAccess: p.isDelegatedAccess === true,
      publishAuthorizationOverride: undefined,
      isUnattendedRun: false,
    });
    p = { ...p, billingUserId: ctx.billingUserId ?? p.billingUserId };
    let prompt: string;
    try {
      prompt = renderPromptForCli(d.trimToolMessages(ctx.messages)).prompt;
    } catch (err) {
      if (err instanceof PromptTooLargeError) throw noToolsStop("context_too_large");
      throw err;
    }

    // 3. run state
    const runId = d.newRunId();
    const { connectionId, epoch } = p.decision;
    const startedAt = d.now();
    const ac = new AbortController();
    const uses: Array<{ id: string; name: string }> = [];
    const seen: { usage?: ClaudeTurnUsage; confirmationFallback: boolean; stopped: boolean } = { confirmationFallback: false, stopped: false };
    let pendingStop: ClaudeRouteStopError | undefined;
    let rawError: unknown;
    let registered: { release(): void } | undefined;
    let opened = false;
    let everOpened = false;
    let executorRegistered = false;
    let outcome: HostTurnOutcome | undefined;
    let cancelledByUser = false;
    let previousUnknown = false; // the bridge reported (and cleared) an unfinished action from an earlier turn
    let hostStarted = false; //     the host produced at least one event: the model read the prompt
    let dispatcher: RelayToolDispatcher | undefined; // set only on the relay path
    let ledgerShowedCalls = false; // step 6 saw a call record, a call still running, or could not read the ledger (the drain removes it, so remember)
    let turnOver = false; // set when run() is about to return: no progress callback may fire after that

    const progress = (status: string, extra: Record<string, unknown> = {}) => {
      if (seen.stopped || turnOver) return; // nothing is "executing" once the turn was stopped (a failed host call ends the event stream, so no event follows it)
      try {
        p.onProgress?.({ iteration: uses.length, status, ...extra });
      } catch {
        /* progress is best-effort */
      }
    };

    try {
      d.executor.registerRun(runId, { llmModel: p.llmModel, isDelegatedAccess: p.isDelegatedAccess, excludeTools: p.excludeTools, screenshotUrl: p.screenshotUrl, socketEmit: d.socketEmit,
        // The tools' own paid / LLM calls: AgentWeb-funded and attributed to this run (decision 2026-10-23), never the plan's scope. Like a normal AgentWeb
        // turn they follow the user's BYOK setting if one is on.
        fundingScope: { route: "agentweb", fallback: "agentweb", ownerUserId: p.userId, billingUserId: p.billingUserId ?? p.userId, runLabel: `claude_plan:${runId}`, resolvedAt: new Date(startedAt).toISOString() },
      });
      executorRegistered = true;
      const token = d.bridge.openRun(
        { runId, userId: p.userId, sessionId: p.sessionId, connectionId, epoch },
        { callGroupWaitMs: 1_500, onHalted: (info) => void (seen.confirmationFallback ||= info.fallbackNeeded) },
      );
      opened = true;
      everOpened = true;

      // 4. cancel handle FIRST: a refused second turn must not have touched the running turn's session state (`beginTurn` starts a new epoch and
      // lifts halts). Then the Stop re-check.
      try {
        registered = d.registry.register(p.sessionId, p.userId, connectionId, {
          refuseNewCalls: () => void d.bridge.cancelSession(p.userId, p.sessionId),
          abort: () => {
            seen.stopped = true;
            ac.abort();
          },
        });
      } catch (err) {
        if (err instanceof ClaudeRunConflictError) throw new ClaudeRouteStopError("host_busy");
        throw err;
      }
      const began = d.bridge.beginTurn(p.userId, p.sessionId);
      if (began?.previousUnknownOutcome === true) {
        previousUnknown = true;
        prompt = appendDirective(prompt, PREVIOUS_UNKNOWN_DIRECTIVE);
      }
      d.executor.beginTurn(runId, { agentRuntimeRunId: runId, priorSearchCallCount: d.seedSearchCount?.(p.sessionHistory) ?? 0 });

      if (d.isCancelled(p.sessionId)) {
        cancelledByUser = true;
      } else turn: {
        // 5. the turn. On the relay path the manifest is built first (inside the turn's time budget: the deadline is computed after it).
        let transport: { bridgeToken: string } | { tools: RelayManifest["tools"] } = { bridgeToken: token };
        let built: { manifest: RelayManifest } | undefined;
        if (transportChoice.kind === "relay") {
          try {
            built = await this.buildRelay(p, runId, token);
          } catch (err) {
            // A Stop pressed while the tool list is being built closes the run, so the list fails ("turned off", "lookup failed"): that is the Stop, not a
            // connection problem. It takes the same path as a Stop seen before the turn started (nothing ran, no AgentWeb-credits offer, no wrong note).
            if (!(seen.stopped || ac.signal.aborted || d.isCancelled(p.sessionId))) throw err;
            cancelledByUser = true;
            break turn;
          }
          transport = { tools: built.manifest.tools };
        }
        const cap = d.turnHardCapMs ?? 600_000;
        const elapsed = p.turnStartMs ? Math.max(0, d.now() - p.turnStartMs) : 0;
        const deadlineMs = Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, cap - elapsed - GRACE_MS - HOST_BUSY_WAIT_MS));
        progress("thinking");
        try {
          if (built) {
            const lead = Math.min(d.softDeadlineLeadMs ?? SOFT_DEADLINE_LEAD_MS, Math.floor(deadlineMs / 2));
            dispatcher = new RelayToolDispatcher({
              client,
              ids: { connectionId, turnId: runId, epoch }, // this closure is the only source of identity; an event's fields are never read for it
              runId,
              token,
              bridge: { callTool: (t, c, r, o) => d.bridge.callTool!(t, c, r, o), listTools: (t, r) => d.bridge.listTools!(t, r), noteToolUse: (r, c, n, i, m) => d.bridge.noteToolUse(r, c, n, i, m), takeLedger: (r) => d.bridge.takeLedger(r), ...(d.bridge.ranCall ? { ranCall: (r, c) => d.bridge.ranCall!(r, c) } : {}) },
              manifest: { open: built.manifest.open },
              isStopped: () => seen.stopped || ac.signal.aborted,
              softDeadlineAt: d.now() + deadlineMs - lead,
              now: d.now,
              // A16 / SF2: a worker past the call cap or the in-flight limit ends the turn (the host turn is interrupted; what ran is kept and persisted).
              onLimitTripped: () => ac.abort(),
              isHalted: () => d.bridge.isHalted(p.sessionId, p.userId),
              admitPostHaltSiblings: d.relayAdmitPostHaltSiblings === true,
              isHaltingCall: (op) => d.bridge.takeHalts(p.userId, p.sessionId).some((h) => h.callId === op),
              ...(d.relayAnnounceWaitMs !== undefined ? { announceWaitMs: d.relayAnnounceWaitMs } : {}),
              onCall: (phase, name) => {
                if (phase === "start") progress("executing_tools", { pendingTools: [name] });
                else progress("tool_executed");
              },
            });
          }
          const relayMode = dispatcher !== undefined;
          outcome = await d.runHostTurn(
            client,
            {
              connectionId,
              epoch,
              idempotencyKey: `${runId}-t1`,
              turnId: runId,
              prompt,
              model: p.decision.alias,
              ...transport,
              deadlineMs,
              priority: "interactive",
            },
            {
              signal: ac.signal,
              onEvent: (e: ProviderEvent) => {
                hostStarted = true;
                if (e.type === "tool-call") {
                  // The ONLY thing that executes on the relay path, and it never blocks the stream: the dispatcher runs it as its own tracked promise.
                  if (dispatcher && dispatcher.start(e)) uses.push({ id: e.operationId, name: e.name }); // a repeated operation id is neither run nor counted
                } else if (e.type === "tool-use") {
                  if (relayMode) {
                    // Informational only on the relay path: it tells the dispatcher which model message a relayed call belongs to (B1). The stream's ids
                    // are not the worker's operation ids: nothing is executed, registered or reported from it.
                    dispatcher?.noteStreamUse(e.name, e.input);
                    return;
                  }
                  const name = e.name.replace(/^mcp__[A-Za-z0-9_]+?__/, "");
                  uses.push({ id: e.operationId, name });
                  d.bridge.noteToolUse(runId, e.operationId, name, e.input);
                  progress("executing_tools", { pendingTools: [name] });
                } else if (e.type === "tool-result") {
                  if (relayMode) {
                    dispatcher?.noteStreamResult();
                    return;
                  }
                  d.bridge.noteToolResult(runId, e.operationId);
                  progress("tool_executed");
                } else if (e.type === "result") {
                  dispatcher?.noteResult(); // the turn is over: a tool-call that still arrives on the open stream is refused, not run
                } else if (e.type === "usage") {
                  // Worker-supplied counts: finite, but 1e308 + 1e308 is Infinity and would be persisted. Each count is capped.
                  const input = clampCount(e.inputTokens);
                  const out = clampCount(e.outputTokens);
                  seen.usage = {
                    prompt_tokens: input,
                    completion_tokens: out,
                    total_tokens: input + out,
                    cache_read_input_tokens: clampCount(e.cacheReadTokens),
                    cache_creation_input_tokens: clampCount(e.cacheWriteTokens),
                  };
                }
              },
            },
          );
        } catch (err) {
          // A relay turn refused as INVALID at admission: the worker may be older than the cached protocol says (a ROLLBACK to protocol 3 rejects `tools`
          // and the cached "match / 4" would otherwise stay for up to 10 minutes, failing every relay turn). Forget the cached protocol now and fail THIS turn
          // as the retryable "worker unavailable"; nothing ran. The next turn is decided on the fresh answer (unknown, then the real protocol).
          if (dispatcher && err instanceof LoginHostError && err.code === "EINVALID" && !hostStarted && refusedAsOldWorker(err.detail)) {
            console.error("[claude-backend] relay_rejected_by_worker", { detail: safeText(err.detail, 120), session: p.sessionId, run: runId, offered: built?.manifest.tools.length, bytes: built?.manifest.bytes, open: built?.manifest.open.size, protocol: d.relay?.workerProtocol() });
            try {
              d.relay?.invalidateProtocol?.();
            } catch {
              /* best effort */
            }
            pendingStop = new ClaudeRouteStopError("host_unavailable");
            markTurnToolsRan(pendingStop, false);
          } else {
            const stop = fromHostFailure(err);
            if (stop) {
              // Fields the host guarantees safe to log (a code and a short detail chosen by the host; never a path, token or text).
              console.error("[claude-backend] host failure", { code: (err as { code?: string }).code, detail: (err as { detail?: string }).detail, stop: stop.code, session: p.sessionId });
              if (stop.markNeedsReconnect) await withinMs(this.markDeadLogin(client, connectionId, epoch, "host_denied"), MARK_BOUND_MS);
              pendingStop = stop; // tool work that already ran is real: it is drained and persisted below, then this is thrown
            } else {
              rawError = err; // same: persist what ran, then fail (typed, by run())
              ac.abort();
            }
          }
        }
      }

      // 6. wait for in-flight calls, take the ledger. A Stop (or a revoke) closes the bridge run BEFORE this point, and the drain of a closed run
      // answers null: the ledger is then read from where the bridge keeps it, never treated as empty.
      // Relay calls run out of band: they are waited for first (their toolResult posts included), then the bridge run is drained and closed.
      if (dispatcher) {
        await dispatcher.settle(d.drainTimeoutMs ?? 10_000);
        dispatcher.close(); // answer posts still in flight are aborted (their calls are recorded as lost)
      }
      const generation = d.bridge.generationOf(runId);
      const drained = await d.bridge.closeRunAndDrain(runId, d.drainTimeoutMs ?? 10_000);
      opened = false;
      const taken = drained ? undefined : d.bridge.takeLedger(runId);
      let ledger: BridgeCallRecord[] = drained ? drained.ledger : taken!.records;
      const ledgerTruncated = drained ? drained.ledgerTruncated : taken!.truncated; // records cut or dropped to fit the ledger's caps
      // S1: on the relay path every executed call whose answer the worker did NOT accept never reached the model (a post that failed, one still in
      // flight when the drain window ended, or a call that finished after the turn): its persisted result says so.
      if (dispatcher) {
        const delivered = dispatcher.deliveredCallIds();
        ledger = annotateLostResults(ledger, (id) => !delivered.has(id));
      }
      ledgerShowedCalls = ledger.length > 0 || !drained || drained.stillRunning > 0;
      if (!drained || drained.stillRunning > 0) this.watchLate(p, generation, ledger, drained ? drained.stillRunning : undefined, dispatcher !== undefined);

      // 7. map
      if (seen.stopped || cancelledByUser || d.isCancelled(p.sessionId)) {
        await this.persistSettled(p, ledger, ledgerTruncated);
        await this.journal(p, runId, startedAt, "aborted", seen.usage);
        return { content: "Generation was stopped.", toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [], persistedResponseCount: 0, cancelled: true };
      }
      if (rawError !== undefined) {
        await this.persistSettled(p, ledger, ledgerTruncated);
        await this.journal(p, runId, startedAt, "failed", seen.usage);
        throw rawError;
      }
      if (pendingStop) {
        await this.persistSettled(p, ledger, ledgerTruncated);
        await this.journal(p, runId, startedAt, "failed", seen.usage);
        throw pendingStop;
      }
      if (!outcome || outcome.kind === "unknown_outcome") {
        // The turn may have run and its output is lost. What the bridge saw is real; say plainly that the rest is unknown. Never retried.
        const unknown = mapLedgerToResponseMessages({ ledger, finalText: OUTCOME_UNKNOWN_NOTE, llm: p.llmModel, stamps: p.stamps });
        markLedgerTruncated(unknown.responseMessages, ledgerTruncated);
        await this.journal(p, runId, startedAt, "aborted", seen.usage);
        return { content: OUTCOME_UNKNOWN_NOTE, toolCalls: unknown.toolCalls, knowledgeBaseQueries: [], sources: [], responseMessages: unknown.responseMessages, persistedResponseCount: 0 };
      }
      const result = outcome.result;
      if (!result.ok) {
        // Anything the turn did before failing is real: keep it visible, then stop with the typed reason.
        await this.persistSettled(p, ledger, ledgerTruncated);
        await this.journal(p, runId, startedAt, result.aborted ? "aborted" : "failed", seen.usage);
        const stop = fromResultErrorKind(result.errorKind, result.aborted);
        // errorKind and aborted come from the worker: only values of the fixed sets are logged, anything else as `other`.
        console.error("[claude-backend] turn ended not ok", { errorKind: safeToken(result.errorKind, RESULT_ERROR_KINDS), aborted: safeToken(result.aborted, RESULT_ABORT_REASONS), stop: stop.code, session: p.sessionId });
        if (stop.markNeedsReconnect) await withinMs(this.markDeadLogin(client, connectionId, epoch, "turn_auth_dead"), MARK_BOUND_MS);
        throw stop;
      }

      const halts = d.bridge.takeHalts(p.userId, p.sessionId);
      let finalText = result.text;
      if (halts.length > 0 || seen.confirmationFallback) finalText = finalText && finalText.trim() ? `${finalText}\n\n${CONFIRMATION_NOTE}` : CONFIRMATION_NOTE;
      const mapped = mapLedgerToResponseMessages({
        ledger,
        finalText: finalText && finalText.trim() ? finalText : d.emptyFallbackText,
        llm: p.llmModel,
        stamps: p.stamps,
        usage: seen.usage,
      });
      markLedgerTruncated(mapped.responseMessages, ledgerTruncated);
      this.reconnectGuard.reset(connectionId); // a turn worked: "login is dead" signals are not consecutive
      await this.journal(p, runId, startedAt, "succeeded", seen.usage);
      const last = mapped.responseMessages[mapped.responseMessages.length - 1];
      return {
        content: last.content,
        toolCalls: mapped.toolCalls,
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: mapped.responseMessages,
        persistedResponseCount: 0,
      };
    } catch (err) {
      // Whether this failed turn may have run a tool, kept for the "continue on AgentWeb credits" offer: only a turn that is KNOWN to have run none is
      // offered a continue (a message answered twice would repeat its actions). Any ledger record, or a ledger that cannot be read, counts as "ran".
      let ran = true;
      try {
        if (!everOpened) ran = false;
        else {
          const peek = d.bridge.takeLedger(runId);
          ran = ledgerShowedCalls || peek.records.length > 0 || peek.truncated > 0 || uses.length > 0;
        }
      } catch {
        ran = true;
      }
      markTurnToolsRan(err, ran);
      throw err;
    } finally {
      // The warning is only spent once the model could have read it. A Stop before the host ran, an admission refusal or a timeout before the
      // first event leave it unspent: put it back for the next turn.
      if (previousUnknown && !hostStarted && outcome === undefined) {
        try {
          d.bridge.rearmUnknownOutcome(p.userId, p.sessionId);
        } catch {
          /* best effort */
        }
      }
      turnOver = true; // the progress wrapper drops every status after this, including those of calls still running (the dispatcher has no flag of its own)
      registered?.release();
      if (opened) {
        try {
          d.bridge.closeRun(runId);
        } catch {
          /* already closed */
        }
      }
      // Once the bridge run was opened, the bridge releases the executor's state when the run closes AND its last call has finished. Releasing here
      // would pull the state out from under a call that is still executing (a Stop mid-write).
      if (executorRegistered && !everOpened) {
        try {
          d.executor.releaseRun(runId);
        } catch {
          /* already released */
        }
      }
    }
  }

  /**
   * A worker said this connection's login is dead. The user already gets the stop; the RECORD is marked only if the signal repeated on consecutive turns, the
   * worker confirms it on another route, and this connection was not marked in the last minutes (a forged result or admission answer must not take a
   * customer's plan chats away). Never throws.
   */
  private async markDeadLogin(client: LoginHostClient, connectionId: string, epoch: number, reason: string): Promise<void> {
    try {
      const confirm = this.deps.confirmDeadLogin ?? defaultConfirmDeadLogin;
      const evidence = await confirm(client, connectionId);
      if (evidence === "needs_reconnect") {
        // the worker's own status agrees with its signal (a consistency check: it is the same worker): mark now, subject to the cool-down and the breaker
        if (!this.reconnectGuard.noteConfirmed(connectionId)) return;
      } else if (!this.reconnectGuard.note(connectionId)) {
        return; // the status disagrees or says nothing: only a signal that repeats on consecutive turns counts
      }
      await this.deps.markNeedsReconnect(connectionId, epoch, reason);
    } catch {
      /* the 5-minute sweeper is the backstop */
    }
  }

  /**
   * The relay's tool manifest for this turn, from the bridge's current list (which also makes the executor resolve the run's tool access, as the HTTP route's
   * `tools/list` does). Every failure, including a manifest with nothing to offer, is a typed stop: nothing has run yet.
   */
  private async buildRelay(p: ClaudeTurnParams, runId: string, token: string): Promise<{ manifest: RelayManifest }> {
    const d = this.deps;
    // Ids the other relay log lines already carry (the session; the run id is our own), so a refusal can be tied to its turn. Never a description, a schema or an input.
    const ids = { session: p.sessionId, run: runId };
    let open: BridgeListedTool[];
    try {
      open = await d.bridge.listTools!(token, runId);
    } catch (err) {
      const revoked = err instanceof ToolBridgeAuthError;
      console.error(`[claude-backend] relay_refused cause=${revoked ? "revoked_or_disabled" : "lookup_failed"}`, { ...ids, error: safeToken(err instanceof Error ? err.name : typeof err, ["Error", "TypeError", "ToolBridgeAuthError", "RangeError"]) });
      throw noToolsStop(revoked ? "revoked_or_disabled" : "lookup_failed");
    }
    const manifest = buildRelayManifest(open);
    // Never a degraded manifest (B1/B2): if any tool would be left out or any description cut (per-user MCP tools are unbounded in number and shape), the
    // turn is refused and the user told, rather than run with fewer tools than an AgentWeb turn would have. relayManifest.registry.test.ts keeps the
    // built-in registry inside the limits. `tools_too_large_for_plan`: not retryable, nothing has run, AgentWeb credits offered (AgentWeb can run them).
    // The line names the tools that did not fit (sanitized, bounded) and the sizes that mattered, so an operator can fix an admin-configured MCP server.
    if (manifestCut(manifest)) {
      console.error("[claude-backend] relay_manifest_cut", { ...ids, ...manifestLogFields(manifest) });
      throw noToolsStop("tools_too_large_for_plan");
    }
    if (manifest.tools.length === 0 || manifest.open.size === 0) {
      // Fail closed (B3): never fall back to the HTTP bridge on a relay-capable worker. Nothing has run.
      console.error("[claude-backend] relay_refused cause=manifest_empty", { ...ids, ...manifestLogFields(manifest) });
      throw noToolsStop("tools_unavailable_for_plan"); // no tool was cut (that was refused above): the list itself came back empty, so asking again can work
    }
    const problem = manifestProblem(manifest.tools);
    if (problem) {
      console.error("[claude-backend] relay_refused cause=manifest_schema", { ...ids, problem: safeText(problem, 120), ...manifestLogFields(manifest) });
      throw noToolsStop("tools_unavailable_for_plan"); // no tool was cut (refused above): a bug-shaped refusal, retryable and offered like any host-side failure
    }
    // Capacity trends are visible before anything is cut: how close the manifest is to the limits (600 tools, 1 MiB), on every relay turn.
    console.info("[claude-backend] relay_turn_start", { ...ids, protocol: d.relay?.workerProtocol(), ...manifestLogFields(manifest) });
    return { manifest };
  }

  /**
   * A call that was still executing when the turn ended (a Stop mid-write) finishes later and is recorded by the bridge as a late record. Nothing
   * else would ever show it in the chat, so it is looked for, for a bounded time, and saved with a note. Each call is saved once.
   */
  private watchLate(p: ClaudeTurnParams, generation: string | undefined, settled: BridgeCallRecord[], expectedLate: number | undefined, relayed = false): void {
    const d = this.deps;
    if (!generation) return;
    const pollMs = d.lateWatchPollMs ?? 3_000;
    const polls = Math.max(1, Math.ceil((d.lateWatchMaxMs ?? LATE_WATCH_DEFAULT_MS) / pollMs));
    const done = new Set(settled.map((r) => r.toolCallId));
    let saved = 0;
    const sleep = () =>
      new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(t);
          this.wakers.delete(wake);
          resolve();
        };
        const t = setTimeout(wake, pollMs);
        t.unref?.();
        this.wakers.add(wake);
      });
    const task: Promise<void> = (async () => {
      for (let i = 0; i < polls; i++) {
        await sleep();
        // Only a call that really ran is worth showing. A refused / collapsed / joined late record executed nothing.
        let late = d.bridge
          .takeLedgerByGeneration(generation)
          .records.filter((r) => r.late === true && (r.kind === "executed" || r.kind === "failed") && !done.has(r.toolCallId));
        // On the relay path the worker's turn is over by now, so no late result can have reached the model: the persisted result says so.
        if (relayed) late = annotateLostResults(late, () => true);
        if (late.length > 0) {
          for (const r of late) done.add(r.toolCallId);
          saved += late.length;
          const mapped = mapLedgerToResponseMessages({ ledger: late, finalText: LATE_RESULT_NOTE, llm: p.llmModel, stamps: p.stamps });
          const note = mapped.responseMessages[mapped.responseMessages.length - 1];
          note.metadata = { ...note.metadata, kind: "claude-late-result" };
          delete note.metadata.toolCalls;
          await d.persistMessages(p.sessionId, mapped.responseMessages);
        }
        if (this.flushing) break; // shutdown: that was the last look
        if (expectedLate !== undefined && saved >= expectedLate) break; // everything that was still running has been shown
      }
    })()
      .catch((err) => console.error("[claude-backend] late result watch failed:", safeText(err)))
      .finally(() => void this.watchers.delete(task));
    this.watchers.add(task);
  }

  /** The settled tool work of a turn that has no answer to persist: the pairs, without a final message. */
  private async persistSettled(p: ClaudeTurnParams, ledger: BridgeCallRecord[], ledgerTruncated = 0): Promise<void> {
    if (ledger.length === 0) return;
    const mapped = mapLedgerToResponseMessages({ ledger, finalText: "x", llm: p.llmModel, stamps: p.stamps });
    const settled = mapped.responseMessages.slice(0, -1);
    markLedgerTruncated(settled, ledgerTruncated);
    await this.deps.persistMessages(p.sessionId, settled).catch((err) =>
      console.error("[claude-backend] could not persist settled tool work:", safeText(err)),
    );
  }

  /** One end row per turn, only when the plan reported usage (unknown is not zero). Never throws. */
  private async journal(p: ClaudeTurnParams, runId: string, startedAt: number, outcome: AttemptUsage["outcome"], usage: ClaudeTurnUsage | undefined): Promise<void> {
    if (!usage) return;
    const row: AttemptUsage = {
      attemptId: runId,
      runId: p.sessionId,
      userId: p.userId,
      billingUserId: p.billingUserId ?? p.userId,
      fundingSource: "claude_subscription",
      fundingPrincipalId: p.userId,
      connectionId: p.decision.connectionId,
      credentialEpoch: p.decision.epoch,
      requestedModel: p.llmModel,
      requestedBackend: "claude_code",
      actualBackend: "claude_code",
      provider: "anthropic",
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(this.deps.now()).toISOString(),
      outcome,
      usage: {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      },
      settlementState: "settled",
    };
    try {
      await this.deps.writeJournal(row);
    } catch (err) {
      console.error("[claude-backend] journal write failed (fail-open):", safeText(err));
    }
  }
}

/** A stop raised before the run opened: nothing could have run. */
/** Marks the persisted messages of a turn whose ledger had to cut or drop records (the chat then shows less than the turn did). Metadata only: no user-visible text. */
function markLedgerTruncated(messages: any[], truncated: number): void {
  if (truncated <= 0 || messages.length === 0) return;
  const last = messages[messages.length - 1];
  last.metadata = { ...(last.metadata ?? {}), ledgerTruncated: truncated };
}

async function defaultConfirmDeadLogin(client: LoginHostClient, connectionId: string): Promise<boolean | "needs_reconnect"> {
  try {
    return (await client.connectionStatus({ connectionId })).state === "needs_reconnect" ? "needs_reconnect" : false;
  } catch (err) {
    return err instanceof LoginHostError && (err.code === "ENOTFOUND" || err.code === "ESTATE"); // the worker says again that it has no usable login (weaker)
  }
}

/** The stop is not held back by a slow worker: marking the record gets this long, then goes on in the background (it never throws). */
const MARK_BOUND_MS = 2_000;
async function withinMs(p: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([p, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function noToolsStop(code: ConstructorParameters<typeof ClaudeRouteStopError>[0]): ClaudeRouteStopError {
  const stop = new ClaudeRouteStopError(code);
  markTurnToolsRan(stop, false);
  return stop;
}

export function newClaudeRunId(): string {
  return `claude-${randomUUID()}`;
}
