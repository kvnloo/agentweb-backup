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
import { PromptTooLargeError, renderPromptForCli } from "./claudePromptRenderer";
import { mapLedgerToResponseMessages, type ClaudeTurnUsage } from "./claudeTurnMessages";
import { ClaudeRouteStopError, fromHostFailure, fromResultErrorKind } from "./claudeRouteErrors";
import type { AttemptUsage } from "./attemptUsageJournal";

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
    isDelegatedAccess?: boolean;
    publishAuthorizationOverride?: undefined;
    isUnattendedRun: boolean;
  }): Promise<{ messages: any[] }>;
  trimToolMessages(messages: any[]): any[];
  runHostTurn(client: LoginHostClient, req: RouteInput<"turn.run">, opts: HostTurnOptions): Promise<HostTurnOutcome>;
  bridge: {
    openRun(claims: RunToolTokenClaims, opts?: { callGroupWaitMs?: number; onHalted?: (info: { fallbackNeeded: boolean }) => void }): string;
    beginTurn(userId: string, sessionId: string): unknown;
    noteToolUse(runId: string, callId: string, name: string, input: unknown, messageId?: string): void;
    noteToolResult(runId: string, callId?: string): void;
    closeRunAndDrain(runId: string, timeoutMs: number): Promise<CloseAndDrainResult | null>;
    closeRun(runId: string): void;
    cancelSession(userId: string, sessionId: string): unknown;
    takeHalts(userId: string, sessionId: string): BridgeHalt[];
  };
  executor: {
    registerRun(runId: string, ctx: { llmModel: string; isDelegatedAccess?: boolean; excludeTools?: string[]; screenshotUrl?: string }): void;
    beginTurn(runId: string, turn: { agentRuntimeRunId?: string }): void;
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
  /** Cap for the whole turn; the host deadline is what is left of it. Default 600 s (the controller's generation timeout). */
  turnHardCapMs?: number;
  drainTimeoutMs?: number;
}

const GRACE_MS = 20_000;
const MIN_DEADLINE_MS = 30_000;

export const OUTCOME_UNKNOWN_NOTE =
  "I lost the connection to your Claude plan while working on this. It may or may not have finished. Please check the results before asking me to repeat anything.";
export const CONFIRMATION_NOTE =
  "That action needs your confirmation before I can go on. Approval cards are not available on your Claude plan yet, so I have stopped here without doing it.";

export class ClaudeCodeBackend {
  constructor(private readonly deps: ClaudeBackendDeps) {}

  async run(p: ClaudeTurnParams): Promise<ClaudeTurnResult> {
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
      isDelegatedAccess: p.isDelegatedAccess,
      publishAuthorizationOverride: undefined,
      isUnattendedRun: false,
    });
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
    const seen: { usage?: ClaudeTurnUsage; confirmationFallback: boolean } = { confirmationFallback: false };
    let pendingStop: ClaudeRouteStopError | undefined;
    let registered: { release(): void } | undefined;
    let opened = false;
    let executorRegistered = false;
    let drained: CloseAndDrainResult | null = null;
    let outcome: HostTurnOutcome | undefined;
    let cancelledByUser = false;

    const progress = (status: string, extra: Record<string, unknown> = {}) => {
      try {
        p.onProgress?.({ iteration: uses.length, status, ...extra });
      } catch {
        /* progress is best-effort */
      }
    };

    try {
      d.executor.registerRun(runId, { llmModel: p.llmModel, isDelegatedAccess: p.isDelegatedAccess, excludeTools: p.excludeTools, screenshotUrl: p.screenshotUrl });
      executorRegistered = true;
      const token = d.bridge.openRun(
        { runId, userId: p.userId, sessionId: p.sessionId, connectionId, epoch },
        { callGroupWaitMs: 1_500, onHalted: (info) => void (seen.confirmationFallback ||= info.fallbackNeeded) },
      );
      opened = true;
      d.bridge.beginTurn(p.userId, p.sessionId);
      d.executor.beginTurn(runId, { agentRuntimeRunId: runId });

      // 4. cancel handle, then the Stop re-check
      try {
        registered = d.registry.register(p.sessionId, p.userId, connectionId, {
          refuseNewCalls: () => void d.bridge.cancelSession(p.userId, p.sessionId),
          abort: () => ac.abort(),
        });
      } catch (err) {
        if (err instanceof ClaudeRunConflictError) throw new ClaudeRouteStopError("host_busy");
        throw err;
      }
      if (d.isCancelled(p.sessionId)) {
        cancelledByUser = true;
      } else {
        // 5. the turn
        const cap = d.turnHardCapMs ?? 600_000;
        const elapsed = p.turnStartMs ? Math.max(0, d.now() - p.turnStartMs) : 0;
        const deadlineMs = Math.max(MIN_DEADLINE_MS, cap - elapsed - GRACE_MS);
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
          if (!stop) throw err;
          if (stop.markNeedsReconnect) await d.markNeedsReconnect(connectionId, epoch, "host_denied").catch(() => undefined);
          pendingStop = stop; // tool work that already ran is real: it is drained and persisted below, then this is thrown
        }
      }

      // 6. wait for in-flight calls, take the ledger
      drained = await d.bridge.closeRunAndDrain(runId, d.drainTimeoutMs ?? 10_000);
      opened = false;
      const ledger: BridgeCallRecord[] = drained?.ledger ?? [];

      // 7. map
      if (cancelledByUser || ac.signal.aborted || d.isCancelled(p.sessionId)) {
        await this.persistSettled(p, ledger);
        await this.journal(p, runId, startedAt, "aborted", seen.usage);
        return { content: "Generation was stopped.", toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [], persistedResponseCount: 0, cancelled: true };
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
        const stop = fromResultErrorKind(result.errorKind);
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
      if (executorRegistered) {
        try {
          d.executor.releaseRun(runId);
        } catch {
          /* already released */
        }
      }
    }
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
