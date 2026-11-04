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
 * turn itself: posting the approval deck, the step budget, cancellation, the
 * repetition loop-breaker, the citation registry and open-research tracking. ENG-2113
 * owns those. The caller must call `beginTurn` for every turn with that turn's run id,
 * time budgets and the session's prior web-search count; without it a media call is
 * bounded only by the tool's own timeout, the search cap starts from zero, and the
 * gateway's failure breaker accumulates across turns under the bridge run id.
 *
 * Known difference from the loop: after a skill install the loop keeps the turn's
 * original legacy-session and allowed-skill values until the next turn; this resolves
 * them fresh, so a legacy session becomes skill-gated one turn earlier.
 */

import {
  agentModeService,
  ADMIN_SKILL_TOOL_NAMES,
  MAX_TOOL_CONTENT_SIZE,
  TOOL_RESPONSE_S3_THRESHOLD,
} from "../agentModeService";
import { executePreparedTools, NON_DEDUPABLE_TOOLS, type ToolDispatchPorts } from "../agentMode/core/toolDispatch";
import { evaluateAgentToolPolicy } from "../agentToolGatewayService";
import { WEB_SEARCH_TOOL_NAMES } from "../../utils/citations";
import { chatbotDb } from "../chatbotService";
import type { RunToolTokenClaims } from "./runToolToken";
import type { BridgeExecuteOutcome, BridgeImage, BridgeTool, BridgeToolCall, ToolBridgeDeps } from "./toolBridge";
import { isStrictRepeatEffect } from "./bridgeToolClassification";
import { withRunFunding, type RunFunding } from "./runFunding";

export interface EmmaBridgeRunContext {
  llmModel: string;
  mockMode?: boolean;
  isDelegatedAccess?: boolean;
  isInteractiveShare?: boolean;
  isUnattendedRun?: boolean;
  excludeTools?: string[];
  screenshotUrl?: string;
  socketEmit?: ToolDispatchPorts["socketEmit"];
  /**
   * The funding scope the tool's own LLM / paid calls run under. A plan turn sets an EXPLICIT agentweb scope (decision 2026-10-23): titles, embeddings
   * and tool APIs stay AgentWeb-funded and attributed to the run. The bridge route is served from the HTTP handler, not from the controller's async
   * context, so the scope has to be entered here for each call.
   */
  fundingScope?: RunFunding;
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

/** The most the instructions of newly installed skills may add to an install_skills answer (the relay's own result cap applies on top). */
const SKILL_NOTE_MAX_CHARS = 60_000;

/** `text` cut to at most `max` UTF-16 units without splitting a surrogate pair (an emoji must not end as half a character). */
function cutOnCodePoint(text: string, max: number): string {
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // a high surrogate whose low half would fall outside
  return text.slice(0, end);
}

type ToolAccess = Awaited<ReturnType<typeof agentModeService.resolveRunToolAccess>>;

interface EmmaRunState {
  context: EmmaBridgeRunContext;
  turn: EmmaBridgeTurn;
  access: ToolAccess | null;
  /** Bumped per lookup so a slower, older lookup cannot overwrite a newer one's result. */
  accessSeq: number;
  callSeq: number;
  searchCallCount: number;
  /** Web-search calls dispatched but not yet counted, so concurrent ones each see the others. */
  searchCallsInFlight: number;
  mediaAssetsProduced: number;
  longestMediaCallMs: number;
  mediaCallKeys: Map<string, string>;
}

export class EmmaToolBridgeExecutor implements ToolBridgeDeps {
  private readonly runs = new Map<string, EmmaRunState>();
  /** Per-call liveness of a connection-funded run (see bridgeLiveness.ts). A run funded by a connection cannot open without one. */
  readonly isLive?: ToolBridgeDeps["isLive"];

  constructor(opts: { isLive?: ToolBridgeDeps["isLive"] } = {}) {
    this.isLive = opts.isLive;
  }

  /** Must be called before the bridge opens the run. */
  registerRun(runId: string, context: EmmaBridgeRunContext): void {
    this.runs.set(runId, {
      context,
      turn: {},
      access: null,
      accessSeq: 0,
      callSeq: 0,
      searchCallCount: 0,
      searchCallsInFlight: 0,
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
    const seq = ++state.accessSeq;
    const access = await agentModeService.resolveRunToolAccess({
      userId: run.userId,
      sessionId: run.sessionId,
      isDelegatedAccess: state.context.isDelegatedAccess,
      isInteractiveShare: state.context.isInteractiveShare,
      excludeTools: state.context.excludeTools,
    });
    if (seq === state.accessSeq) state.access = access;
    return access.tools.map(toBridgeTool).filter((tool): tool is BridgeTool => tool !== null);
  }

  /**
   * Read-only only when Emma's own policy classifies the tool as a read whatever its
   * arguments. The `call_*` API tools are excluded because their effect depends on the
   * action argument, which a static annotation cannot express. The `ask_*` tools read
   * nothing but stop the turn for the user, so they keep their place in the order.
   */
  isReadOnly(toolName: string): boolean {
    if (toolName.startsWith("call_") || toolName.startsWith("ask_")) return false;
    return evaluateAgentToolPolicy({ toolName, args: {} }).effect === "read";
  }

  /** Same exemptions Emma's dispatcher applies to its own same-message collapsing. */
  isDedupable(toolName: string): boolean {
    return !NON_DEDUPABLE_TOOLS.has(toolName);
  }

  /** Calls whose identical repeat in one turn must return the original outcome (see bridgeToolClassification.ts). */
  isStrictEffect(toolName: string, args: Record<string, unknown>): boolean {
    return isStrictRepeatEffect(toolName, args);
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

    // Read-only calls run concurrently, and web search is read-only. The loop counts a
    // batch's searches as it prepares them, so each concurrent search here must see the
    // ones dispatched just before it, or they would all pass the session cap together.
    const isSearch = WEB_SEARCH_TOOL_NAMES.has(call.name);
    const priorSearchCallCount = state.searchCallCount + state.searchCallsInFlight;
    if (isSearch) state.searchCallsInFlight += 1;

    let dispatched: Awaited<ReturnType<typeof executePreparedTools>>;
    try {
      const dispatch = () => executePreparedTools({
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
      priorSearchCallCount,
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
      dispatched = await (context.fundingScope ? withRunFunding(context.fundingScope, dispatch) : dispatch());
    } finally {
      if (isSearch) state.searchCallsInFlight -= 1;
    }

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

    const isError = entry.error !== undefined;
    // install_skills: Emma's loop rebuilds the "Installed Skills:" block so the next model call of the turn has the new skills' instructions; a relayed turn
    // has no such block, so the same lines travel with this answer (not with the persisted record: Emma does not persist them either).
    let answerSuffix: string | undefined;
    if (!isError && dispatched.skillsUpdated === true && call.name === "install_skills" && entry.result?.success === true) {
      const note = await agentModeService.buildInstalledSkillsNote(run.sessionId, call.args?.skillIds, entry.result?.installedSkills);
      if (note) answerSuffix = `\n\n${note.length > SKILL_NOTE_MAX_CHARS ? `${cutOnCodePoint(note, SKILL_NOTE_MAX_CHARS)}\n[the skill instructions were cut here]` : note}`;
    }
    return {
      ...toBridgeContent(toolMessage.content),
      ...(answerSuffix ? { answerSuffix } : {}),
      isError,
      // The loop's own rule (collectConfirmationPrompt): a successful result carrying
      // awaitingUserConfirmation. `requiresConfirmation` alone does not stop the turn.
      requiresConfirmation: !isError && entry.result?.awaitingUserConfirmation === true,
      toolsChanged: dispatched.skillsUpdated === true,
      // The minimal result Emma's loop keeps in its ledger; backend-only (it can carry approval tokens and Meta digests).
      result: entry.result,
      ...(isError ? { error: describeError(entry.error) } : {}),
      context: {
        isUnattendedRun: context.isUnattendedRun === true,
        isDelegatedAccess: context.isDelegatedAccess === true,
        isInteractiveShare: context.isInteractiveShare === true,
      },
    };
  }

  private requireRun(runId: string): EmmaRunState {
    const state = this.runs.get(runId);
    if (!state) throw new Error("run is not registered with the executor");
    return state;
  }
}

/**
 * A tool message is a string, or for a screenshot on a vision model a list of text and
 * image parts. The image goes to the harness as an image, not as base64 inside text.
 */
function toBridgeContent(content: unknown): { content: string; images?: BridgeImage[] } {
  if (typeof content === "string") return { content };
  if (!Array.isArray(content)) return { content: JSON.stringify(content ?? "") };
  const text: string[] = [];
  const images: BridgeImage[] = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") {
      text.push(part.text);
    } else if (part?.type === "image_url") {
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(part.image_url?.url ?? ""));
      if (match) images.push({ mimeType: match[1], data: match[2] });
      else text.push("[image omitted]");
    }
  }
  return { content: text.join("\n"), ...(images.length ? { images } : {}) };
}

/** A short, non-sensitive label for a tool failure: the ledger keeps the tool's own text elsewhere. */
function describeError(error: unknown): string {
  if (typeof error === "string") return error.slice(0, 200);
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return String((error as { message: string }).message).slice(0, 200);
  }
  return "tool error";
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
