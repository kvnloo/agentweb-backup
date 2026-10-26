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
import type { LoginHostClient } from "./loginHostClient";
import type { HostTurnOptions, HostTurnOutcome } from "./loginHostTurn";
import type { RouteInput } from "../../loginHost/protocol";
import type { BridgeCallRecord, BridgeHalt, CloseAndDrainResult } from "./toolBridge";
import type { RunToolTokenClaims } from "./runToolToken";
import type { PlanRoute } from "./claudeFunding";
import type { ClaudeRunRegistry } from "./claudeRunRegistry";
import { ClaudeRunConflictError } from "./claudeRunRegistry";
import { PromptTooLargeError, appendDirective, renderPromptForCli } from "./claudePromptRenderer";
import { mapLedgerToResponseMessages, type ClaudeTurnUsage } from "./claudeTurnMessages";
import { ClaudeRouteStopError, fromHostFailure, fromResultErrorKind } from "./claudeRouteErrors";
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
    noteToolUse(runId: string, callId: string, name: string, input: unknown, messageId?: string): void;
    noteToolResult(runId: string, callId?: string): void;
    closeRunAndDrain(runId: string, timeoutMs: number): Promise<CloseAndDrainResult | null>;
    closeRun(runId: string): void;
    cancelSession(userId: string, sessionId: string): unknown;
    takeHalts(userId: string, sessionId: string): BridgeHalt[];
    /** The run's ledger, still readable after the run was closed (a Stop closes it before the drain). */
    takeLedger(runId: string): { records: BridgeCallRecord[]; truncated: number };
    generationOf(runId: string): string | undefined;
    takeLedgerByGeneration(generation: string): { records: BridgeCallRecord[]; truncated: number };
  };
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

export const OUTCOME_UNKNOWN_NOTE =
  "I lost the connection to your Claude plan while working on this. It may or may not have finished. Please check the results before asking me to repeat anything.";
export const LATE_RESULT_NOTE = "The action above finished after this turn was stopped. Please check the result before asking me to repeat it.";
export const PREVIOUS_UNKNOWN_DIRECTIVE =
  "An action in the previous turn may have run without its result reaching you. Before repeating any action that changes something, check its current state with a read-only tool, or ask the user.";
export const CONFIRMATION_NOTE =
  "That action needs your confirmation before I can go on. Approval cards are not available on your Claude plan yet, so I have stopped here without doing it.";

export class ClaudeCodeBackend {
  constructor(private readonly deps: ClaudeBackendDeps) {}

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
      console.error("[claude-backend] turn failed:", err instanceof Error ? err.message : String(err));
      throw new ClaudeRouteStopError("turn_failed");
    }
  }

  private async runInner(p: ClaudeTurnParams): Promise<ClaudeTurnResult> {
    const d = this.deps;
    const client = d.hostClient();
    if (!client) throw new ClaudeRouteStopError("host_unavailable");

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
      if (err instanceof PromptTooLargeError) throw new ClaudeRouteStopError("context_too_large");
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

    const progress = (status: string, extra: Record<string, unknown> = {}) => {
      if (seen.stopped || rawError !== undefined || pendingStop) return; // nothing is "executing" once the turn is stopped or failed
      try {
        p.onProgress?.({ iteration: uses.length, status, ...extra });
      } catch {
        /* progress is best-effort */
      }
    };

    try {
      d.executor.registerRun(runId, { llmModel: p.llmModel, isDelegatedAccess: p.isDelegatedAccess, excludeTools: p.excludeTools, screenshotUrl: p.screenshotUrl, socketEmit: d.socketEmit,
        // The tools' own paid / LLM calls: AgentWeb-funded and attributed to this run, on purpose (decision 2026-10-23). Never the plan's scope.
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
      if (began?.previousUnknownOutcome === true) prompt = appendDirective(prompt, PREVIOUS_UNKNOWN_DIRECTIVE);
      d.executor.beginTurn(runId, { agentRuntimeRunId: runId, priorSearchCallCount: d.seedSearchCount?.(p.sessionHistory) ?? 0 });

      if (d.isCancelled(p.sessionId)) {
        cancelledByUser = true;
      } else {
        // 5. the turn
        const cap = d.turnHardCapMs ?? 600_000;
        const elapsed = p.turnStartMs ? Math.max(0, d.now() - p.turnStartMs) : 0;
        const deadlineMs = Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, cap - elapsed - GRACE_MS - HOST_BUSY_WAIT_MS));
        progress("thinking");
        try {
          outcome = await d.runHostTurn(
            client,
            {
              connectionId,
              epoch,
              idempotencyKey: `${runId}-t1`,
              turnId: runId,
              prompt,
              model: p.decision.alias,
              bridgeToken: token,
              deadlineMs,
              priority: "interactive",
            },
            {
              signal: ac.signal,
              onEvent: (e: ProviderEvent) => {
                if (e.type === "tool-use") {
                  const name = e.name.replace(/^mcp__[A-Za-z0-9_]+?__/, "");
                  uses.push({ id: e.operationId, name });
                  d.bridge.noteToolUse(runId, e.operationId, name, e.input);
                  progress("executing_tools", { pendingTools: [name] });
                } else if (e.type === "tool-result") {
                  d.bridge.noteToolResult(runId, e.operationId);
                  progress("tool_executed");
                } else if (e.type === "usage") {
                  const input = e.inputTokens ?? 0;
                  const out = e.outputTokens ?? 0;
                  seen.usage = {
                    prompt_tokens: input,
                    completion_tokens: out,
                    total_tokens: input + out,
                    cache_read_input_tokens: e.cacheReadTokens ?? 0,
                    cache_creation_input_tokens: e.cacheWriteTokens ?? 0,
                  };
                }
              },
            },
          );
        } catch (err) {
          const stop = fromHostFailure(err);
          if (stop) {
            // Fields the host guarantees safe to log (a code and a short detail chosen by the host; never a path, token or text).
            console.error("[claude-backend] host failure", { code: (err as { code?: string }).code, detail: (err as { detail?: string }).detail, stop: stop.code, session: p.sessionId });
            if (stop.markNeedsReconnect) await d.markNeedsReconnect(connectionId, epoch, "host_denied").catch(() => undefined);
            pendingStop = stop; // tool work that already ran is real: it is drained and persisted below, then this is thrown
          } else {
            rawError = err; // same: persist what ran, then fail (typed, by run())
            ac.abort();
          }
        }
      }

      // 6. wait for in-flight calls, take the ledger. A Stop (or a revoke) closes the bridge run BEFORE this point, and the drain of a closed run
      // answers null: the ledger is then read from where the bridge keeps it, never treated as empty.
      const generation = d.bridge.generationOf(runId);
      const drained = await d.bridge.closeRunAndDrain(runId, d.drainTimeoutMs ?? 10_000);
      opened = false;
      const ledger: BridgeCallRecord[] = drained ? drained.ledger : d.bridge.takeLedger(runId).records;
      if (!drained || drained.stillRunning > 0) this.watchLate(p, generation, ledger, drained ? drained.stillRunning : undefined);

      // 7. map
      if (seen.stopped || cancelledByUser || d.isCancelled(p.sessionId)) {
        await this.persistSettled(p, ledger);
        await this.journal(p, runId, startedAt, "aborted", seen.usage);
        return { content: "Generation was stopped.", toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [], persistedResponseCount: 0, cancelled: true };
      }
      if (rawError !== undefined) {
        await this.persistSettled(p, ledger);
        await this.journal(p, runId, startedAt, "failed", seen.usage);
        throw rawError;
      }
      if (pendingStop) {
        await this.persistSettled(p, ledger);
        await this.journal(p, runId, startedAt, "failed", seen.usage);
        throw pendingStop;
      }
      if (!outcome || outcome.kind === "unknown_outcome") {
        // The turn may have run and its output is lost. What the bridge saw is real; say plainly that the rest is unknown. Never retried.
        const unknown = mapLedgerToResponseMessages({ ledger, finalText: OUTCOME_UNKNOWN_NOTE, llm: p.llmModel, stamps: p.stamps });
        await this.journal(p, runId, startedAt, "aborted", seen.usage);
        return { content: OUTCOME_UNKNOWN_NOTE, toolCalls: unknown.toolCalls, knowledgeBaseQueries: [], sources: [], responseMessages: unknown.responseMessages, persistedResponseCount: 0 };
      }
      const result = outcome.result;
      if (!result.ok) {
        // Anything the turn did before failing is real: keep it visible, then stop with the typed reason.
        await this.persistSettled(p, ledger);
        await this.journal(p, runId, startedAt, result.aborted ? "aborted" : "failed", seen.usage);
        const stop = fromResultErrorKind(result.errorKind, result.aborted);
        console.error("[claude-backend] turn ended not ok", { errorKind: result.errorKind, aborted: result.aborted, stop: stop.code, session: p.sessionId });
        if (stop.markNeedsReconnect) await d.markNeedsReconnect(connectionId, epoch, "turn_auth_dead").catch(() => undefined);
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
    } finally {
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
   * A call that was still executing when the turn ended (a Stop mid-write) finishes later and is recorded by the bridge as a late record. Nothing
   * else would ever show it in the chat, so it is looked for, for a bounded time, and saved with a note. Each call is saved once.
   */
  private watchLate(p: ClaudeTurnParams, generation: string | undefined, settled: BridgeCallRecord[], expectedLate: number | undefined): void {
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
        const late = d.bridge
          .takeLedgerByGeneration(generation)
          .records.filter((r) => r.late === true && (r.kind === "executed" || r.kind === "failed") && !done.has(r.toolCallId));
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
      .catch((err) => console.error("[claude-backend] late result watch failed:", err instanceof Error ? err.message : String(err)))
      .finally(() => void this.watchers.delete(task));
    this.watchers.add(task);
  }

  /** The settled tool work of a turn that has no answer to persist: the pairs, without a final message. */
  private async persistSettled(p: ClaudeTurnParams, ledger: BridgeCallRecord[]): Promise<void> {
    if (ledger.length === 0) return;
    const mapped = mapLedgerToResponseMessages({ ledger, finalText: "x", llm: p.llmModel, stamps: p.stamps });
    await this.deps.persistMessages(p.sessionId, mapped.responseMessages.slice(0, -1)).catch((err) =>
      console.error("[claude-backend] could not persist settled tool work:", err instanceof Error ? err.message : String(err)),
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
      console.error("[claude-backend] journal write failed (fail-open):", err instanceof Error ? err.message : String(err));
    }
  }
}

export function newClaudeRunId(): string {
  return `claude-${randomUUID()}`;
}
