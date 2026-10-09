/**
 * ENG-2109 (B2): the tool bridge's real executor. Resolves a run's tools and runs a
 * call through the same code Emma's own loop uses: `resolveRunToolAccess` for the
 * skill-gated, filtered list and `executePreparedTools` for policy, argument repair,
 * the gateway, budgets and telemetry.
 *
 * Emma's loop hands the dispatcher one model message's tool calls as a batch and
 * carries budget state from one iteration to the next. A harness calls one tool at a
 * time, so this keeps that state per run and folds each result back in the way the
 * loop does after its own dispatch.
 *
 * Not replicated here, because they live in the loop around the dispatch and need the
 * turn itself: posting the approval deck, the step budget, cancellation and the
 * repetition loop-breaker. ENG-2113 owns those. The caller must give each turn's time
 * budgets through `beginTurn`; without them a media call is bounded only by the tool's
 * own timeout.
 */

import {
  agentModeService,
  ADMIN_SKILL_TOOL_NAMES,
  MAX_TOOL_CONTENT_SIZE,
  TOOL_RESPONSE_S3_THRESHOLD,
} from "../agentModeService";
import { executePreparedTools, NON_DEDUPABLE_TOOLS, type ToolDispatchPorts } from "../agentMode/core/toolDispatch";
import { evaluateAgentToolPolicy } from "../agentToolGatewayService";
import { chatbotDb } from "../chatbotService";
import type { RunToolTokenClaims } from "./runToolToken";
import type { BridgeExecuteOutcome, BridgeTool, BridgeToolCall, ToolBridgeDeps } from "./toolBridge";

export interface EmmaBridgeRunContext {
  llmModel: string;
  mockMode?: boolean;
  isDelegatedAccess?: boolean;
  isInteractiveShare?: boolean;
  isUnattendedRun?: boolean;
  excludeTools?: string[];
  screenshotUrl?: string;
  socketEmit?: ToolDispatchPorts["socketEmit"];
}

export interface EmmaBridgeTurn {
  /** Emma's id for this turn's run; telemetry and the gateway's failure breaker key on it. Defaults to the bridge run id. */
  agentRuntimeRunId?: string;
  mediaGenerationDeadlineMs?: number;
  generationHardCapMs?: number;
  turnHardCapMs?: number;
  approvedRevisionImageSources?: string[];
  /** Web-search calls already counted against the session cap from earlier turns. */
  priorSearchCallCount?: number;
}

type ToolAccess = Awaited<ReturnType<typeof agentModeService.resolveRunToolAccess>>;

interface EmmaRunState {
  context: EmmaBridgeRunContext;
  turn: EmmaBridgeTurn;
  access: ToolAccess | null;
  callSeq: number;
  searchCallCount: number;
  mediaAssetsProduced: number;
  longestMediaCallMs: number;
  mediaCallKeys: Map<string, string>;
}

export class EmmaToolBridgeExecutor implements ToolBridgeDeps {
  private readonly runs = new Map<string, EmmaRunState>();

  /** Must be called before the bridge opens the run. */
  registerRun(runId: string, context: EmmaBridgeRunContext): void {
    this.runs.set(runId, {
      context,
      turn: {},
      access: null,
      callSeq: 0,
      searchCallCount: 0,
      mediaAssetsProduced: 0,
      longestMediaCallMs: 0,
      mediaCallKeys: new Map(),
    });
  }

  /** Starts a new turn on an open run: sets its time budgets and resets per-turn counters. */
  beginTurn(runId: string, turn: EmmaBridgeTurn = {}): void {
    const state = this.runs.get(runId);
    if (!state) return;
    state.turn = turn;
    state.searchCallCount = turn.priorSearchCallCount ?? 0;
    state.mediaAssetsProduced = 0;
    state.longestMediaCallMs = 0;
    state.mediaCallKeys = new Map();
  }

  releaseRun(runId: string): void {
    this.runs.delete(runId);
  }

  async resolveTools(run: RunToolTokenClaims): Promise<BridgeTool[]> {
    const state = this.requireRun(run.runId);
    const access = await agentModeService.resolveRunToolAccess({
      userId: run.userId,
      sessionId: run.sessionId,
      isDelegatedAccess: state.context.isDelegatedAccess,
      isInteractiveShare: state.context.isInteractiveShare,
      excludeTools: state.context.excludeTools,
    });
    state.access = access;
    return access.tools.map(toBridgeTool).filter((tool): tool is BridgeTool => tool !== null);
  }

  /**
   * Read-only only when Emma's own policy classifies the tool as a read whatever its
   * arguments. The `call_*` API tools are excluded because their effect depends on the
   * action argument, which a static annotation cannot express.
   */
  isReadOnly(toolName: string): boolean {
    if (toolName.startsWith("call_")) return false;
    return evaluateAgentToolPolicy({ toolName, args: {} }).effect === "read";
  }

  /** Same exemptions Emma's dispatcher applies to its own same-message collapsing. */
  isDedupable(toolName: string): boolean {
    return !NON_DEDUPABLE_TOOLS.has(toolName);
  }

  async execute(run: RunToolTokenClaims, call: BridgeToolCall): Promise<BridgeExecuteOutcome> {
    const state = this.requireRun(run.runId);
    const access = state.access;
    if (!access) throw new Error("tool access was not resolved before execution");

    const { context, turn } = state;
    const sequence = ++state.callSeq;
    const toolCallId = call.callId || `bridge_${run.runId}_${sequence}`;
    const agentRuntimeRunId = turn.agentRuntimeRunId || run.runId;
    const messages: any[] = [];
    const ledger: any[] = [];

    const dispatched = await executePreparedTools({
      toolCalls: [{ id: toolCallId, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }],
      messages,
      toolCallsLedger: ledger,
      iteration: sequence,
      agentRuntimeRunId,
      sessionId: run.sessionId,
      userId: run.userId,
      llmModel: context.llmModel,
      mockMode: context.mockMode === true,
      screenshotUrl: context.screenshotUrl,
      isDelegatedAccess: context.isDelegatedAccess === true,
      hasAdminAccess: access.hasAdminAccess,
      isInteractiveShare: context.isInteractiveShare === true,
      isUnattendedRun: context.isUnattendedRun,
      adminSkillToolNames: ADMIN_SKILL_TOOL_NAMES,
      excludeTools: context.excludeTools,
      publishedSkillsCount: access.publishedSkillsCount,
      sessionAssociatedSkillIdsCount: access.sessionAssociatedSkillIdsCount,
      allowedToolNames: access.allowedToolNames,
      toolResponseS3Threshold: TOOL_RESPONSE_S3_THRESHOLD,
      maxToolContentSize: MAX_TOOL_CONTENT_SIZE,
      mediaGenerationDeadlineMs: turn.mediaGenerationDeadlineMs,
      mediaAssetsProducedThisRun: state.mediaAssetsProduced,
      generationHardCapMs: turn.generationHardCapMs,
      turnHardCapMs: turn.turnHardCapMs,
      longestMediaCallMsThisRun: state.longestMediaCallMs,
      priorMediaCallKeys: state.mediaCallKeys,
      approvedRevisionImageSources: turn.approvedRevisionImageSources,
      priorSearchCallCount: state.searchCallCount,
      ports: agentModeService.buildToolDispatchPorts({
        agentRuntimeRunId,
        sessionId: run.sessionId,
        userId: run.userId,
        iteration: sequence,
        mediaAssetsProducedThisRun: state.mediaAssetsProduced,
        mediaGenerationDeadlineMs: turn.mediaGenerationDeadlineMs,
        socketEmit: context.socketEmit,
      }),
    });

    // Fold the result back in exactly as Emma's loop does after its own dispatch.
    state.mediaAssetsProduced += dispatched.mediaAssetsProduced;
    state.searchCallCount += dispatched.searchCallsThisIteration;
    state.longestMediaCallMs = Math.max(state.longestMediaCallMs, dispatched.longestMediaCallMs ?? 0);
    for (const [key, id] of dispatched.producedMediaCallKeys ?? []) {
      if (!state.mediaCallKeys.has(key)) state.mediaCallKeys.set(key, id);
    }
    await flushCounters(run.sessionId, dispatched.failedCounterUpdates, dispatched.pendingCounterUpdates);

    const toolMessage = messages.find((message) => message?.role === "tool" && message.tool_call_id === toolCallId);
    const entry = ledger.find((item) => item?.id === toolCallId);
    if (!toolMessage || !entry) throw new Error("dispatcher produced no result for the call");

    const result = entry.result;
    return {
      content: typeof toolMessage.content === "string" ? toolMessage.content : JSON.stringify(toolMessage.content ?? ""),
      isError: entry.error !== undefined,
      requiresConfirmation: result?.awaitingUserConfirmation === true || result?.requiresConfirmation === true,
      toolsChanged: dispatched.skillsUpdated === true,
    };
  }

  private requireRun(runId: string): EmmaRunState {
    const state = this.runs.get(runId);
    if (!state) throw new Error("run is not registered with the executor");
    return state;
  }
}

function toBridgeTool(definition: any): BridgeTool | null {
  const fn = definition?.function;
  if (!fn || typeof fn.name !== "string") return null;
  return { name: fn.name, description: fn.description, inputSchema: fn.parameters };
}

async function flushCounters(
  sessionId: string,
  failed: Record<string, number>,
  succeeded: Record<string, number>,
): Promise<void> {
  if (failed && Object.keys(failed).length > 0) {
    try {
      await chatbotDb.incrementFailedFunctions(sessionId, failed);
    } catch (err) {
      console.error("[tool-bridge] failed to update failed-call counters:", err instanceof Error ? err.message : String(err));
    }
  }
  if (succeeded && Object.keys(succeeded).length > 0) {
    try {
      await chatbotDb.incrementCalledFunctions(sessionId, succeeded);
    } catch (err) {
      console.error("[tool-bridge] failed to update call counters:", err instanceof Error ? err.message : String(err));
    }
  }
}
