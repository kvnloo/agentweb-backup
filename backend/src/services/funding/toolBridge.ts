/**
 * ENG-2109 (B2): the harness-agnostic core of the tool bridge. A `claude -p` session
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
 *    cannot lift it; only `clearHalt` (a new turn from the user) can.
 *  - Tools not known to be read-only run one at a time per run, in arrival order.
 *  - Emma's dispatcher collapses an identical call repeated within one model message.
 *    A harness delivers that message's calls one by one, so the caller reports which
 *    message each call id belongs to (`noteCallGroup`) and the repeat is collapsed here.
 *
 * What a tool is, how it executes and what counts as read-only are injected, so this
 * file has no dependency on agentModeService and no production caller yet (ENG-2113
 * wires it in). The executor is expected to bound its own run time; closing a run
 * releases anything waiting on it but cannot cancel a call already executing.
 */

import { RunToolTokenStore, type RunToolTokenClaims, type RunToolTokenRejection } from "./runToolToken";

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
}

export interface BridgeCallResult {
  content: string;
  images?: BridgeImage[];
  isError: boolean;
}

export interface ToolBridgeDeps {
  /** The run's current filtered tool list: what Emma's own loop would offer the model right now. */
  resolveTools(run: RunToolTokenClaims): Promise<BridgeTool[]>;
  isReadOnly(toolName: string): boolean;
  execute(run: RunToolTokenClaims, call: BridgeToolCall): Promise<BridgeExecuteOutcome>;
  /** Called once when a run closes. A call may still be executing for that run. */
  releaseRun?(runId: string): void;
  /** False for tools whose identical repeat in one model message must still run. Defaults to true. */
  isDedupable?(toolName: string): boolean;
}

export interface OpenRunOptions {
  /**
   * Fires when the harness must re-read the tool list. The call that changed the list
   * is not answered until this settles, so the harness can have the new tools before
   * the model's next step. Must bound its own wait.
   */
  onToolsChanged?: () => void | Promise<void>;
  /** Fires when a result halts the session, so the caller can persist it. */
  onHalted?: () => void;
  /** Set when the session was already waiting on a confirmation before this run opened. */
  halted?: boolean;
  /**
   * How long a call waits to learn which model message it belongs to. The harness
   * reports that on a different channel from the call itself, so the call can arrive
   * first. Leave unset when nothing calls `noteCallGroup`: no wait, no collapsing.
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

interface RunState {
  claims: RunToolTokenClaims;
  toolsPromise: Promise<Map<string, BridgeListedTool>> | null;
  /** Bumped whenever the list is invalidated, so a lookup that was already in flight is not trusted. */
  toolsGeneration: number;
  closed: boolean;
  /** One entry per call still awaiting a result; closing the run settles them all. */
  waiters: Set<() => void>;
  /** Tail of the queue that serializes calls to tools not known to be read-only. */
  serialTail: Promise<void>;
  onToolsChanged?: () => void | Promise<void>;
  onHalted?: () => void;
  callGroupWaitMs: number;
  /** Harness call id -> the model message it came from. */
  callGroups: Map<string, string>;
  callGroupWaiters: Map<string, Set<() => void>>;
  /** Per model message: dedupe key -> the call id that is handling it. */
  seenByGroup: Map<string, Map<string, string>>;
}

const HALTED_MESSAGE =
  "This conversation is waiting for the user to confirm an earlier action. No tool can run until the user replies. " +
  "Stop here and ask the user to confirm.";
const RUN_ENDED_MESSAGE = "This run has ended.";
const LIST_UNAVAILABLE_MESSAGE = "The tool list is unavailable right now, so no tool can run.";
const MAX_LIST_READS_PER_CALL = 3;
const MAX_TRACKED_CALL_IDS = 512;
const MAX_TRACKED_GROUPS = 16;

export class ToolBridge {
  private readonly runs = new Map<string, RunState>();
  private readonly haltedSessions = new Set<string>();

  constructor(
    private readonly deps: ToolBridgeDeps,
    private readonly tokens: RunToolTokenStore = new RunToolTokenStore(),
  ) {}

  /** Opens a run and returns its token. A run already open under this id is closed first. */
  openRun(claims: RunToolTokenClaims, opts: OpenRunOptions = {}): string {
    // The executor's state for this id was set up by the caller just before this, so
    // replacing a run that is still open must not release it.
    this.endRun(claims.runId, false);
    if (opts.halted) this.haltedSessions.add(claims.sessionId);
    this.runs.set(claims.runId, {
      claims: { ...claims },
      toolsPromise: null,
      toolsGeneration: 0,
      closed: false,
      waiters: new Set(),
      serialTail: Promise.resolve(),
      onToolsChanged: opts.onToolsChanged,
      onHalted: opts.onHalted,
      callGroupWaitMs: Math.max(0, opts.callGroupWaitMs ?? 0),
      callGroups: new Map(),
      callGroupWaiters: new Map(),
      seenByGroup: new Map(),
    });
    return this.tokens.mint(claims);
  }

  /** Ends the run: the token stops working and everything waiting on the run is refused. */
  closeRun(runId: string): void {
    this.endRun(runId, true);
  }

  private endRun(runId: string, releaseExecutor: boolean): void {
    const state = this.runs.get(runId);
    this.tokens.revokeRun(runId);
    if (!state) return;
    state.closed = true;
    this.runs.delete(runId);
    for (const release of [...state.waiters]) release();
    state.waiters.clear();
    if (releaseExecutor) this.deps.releaseRun?.(runId);
  }

  /**
   * Records which model message a harness call id belongs to. Comes from the harness's
   * own event stream, never from the model or the MCP request, so a session cannot
   * use it to dodge collapsing.
   */
  noteCallGroup(runId: string, callId: string, groupId: string): void {
    const state = this.runs.get(runId);
    if (!state || !callId || !groupId) return;
    state.callGroups.set(callId, groupId);
    trimOldest(state.callGroups, MAX_TRACKED_CALL_IDS);
    const waiters = state.callGroupWaiters.get(callId);
    if (waiters) {
      state.callGroupWaiters.delete(callId);
      for (const wake of waiters) wake();
    }
  }

  /** Lifts a session's confirmation halt. Only a new turn from the user may trigger this. */
  clearHalt(sessionId: string): void {
    this.haltedSessions.delete(sessionId);
  }

  isHalted(sessionId: string): boolean {
    return this.haltedSessions.has(sessionId);
  }

  /** Checks a token without doing anything else. Throws ToolBridgeAuthError when it is not valid for the run. */
  verify(token: string | undefined | null, expectedRunId?: string): RunToolTokenClaims {
    return { ...this.authenticate(token, expectedRunId).claims };
  }

  async listTools(token: string | undefined | null, expectedRunId?: string): Promise<BridgeListedTool[]> {
    const state = this.authenticate(token, expectedRunId);
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
  ): Promise<BridgeCallResult> {
    const state = this.authenticate(token, expectedRunId);
    if (!call || typeof call.name !== "string" || !isPlainObject(call.args)) {
      return refusal("A tool call needs a tool name and an object of arguments.");
    }

    // Decided from the name alone, with nothing awaited first, so calls join the
    // queue in the order they arrived. Whether the tool exists is checked in execute().
    let result: Promise<BridgeCallResult>;
    if (this.isReadOnly(call.name)) {
      result = this.execute(state, call);
    } else {
      result = state.serialTail.then(() => this.execute(state, call));
      state.serialTail = result.then(
        () => undefined,
        () => undefined,
      );
    }
    // Closing the run releases the caller even if an earlier call never settles.
    const pending = result;
    return new Promise<BridgeCallResult>((resolve) => {
      const release = () => resolve(refusal(RUN_ENDED_MESSAGE));
      state.waiters.add(release);
      void pending.then((settled) => {
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
    const known = state.callGroups.get(callId);
    if (known || state.callGroupWaitMs <= 0) return known;
    return new Promise((resolve) => {
      let waiters = state.callGroupWaiters.get(callId);
      if (!waiters) {
        waiters = new Set();
        state.callGroupWaiters.set(callId, waiters);
      }
      const settle = () => {
        clearTimeout(timer);
        waiters.delete(settle);
        if (waiters.size === 0 && state.callGroupWaiters.get(callId) === waiters) state.callGroupWaiters.delete(callId);
        resolve(state.callGroups.get(callId));
      };
      const timer = setTimeout(settle, state.callGroupWaitMs);
      waiters.add(settle);
    });
  }

  private isDedupable(toolName: string): boolean {
    try {
      return this.deps.isDedupable ? this.deps.isDedupable(toolName) !== false : true;
    } catch {
      return true;
    }
  }

  /** Never rejects. Every check that must hold at the moment of execution is made here. */
  private async execute(state: RunState, call: BridgeToolCall): Promise<BridgeCallResult> {
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
      return refusal(LIST_UNAVAILABLE_MESSAGE);
    }
    if (!tools) return refusal(LIST_UNAVAILABLE_MESSAGE);

    // Checked after the last await above, with nothing async before the executor is
    // invoked, so a halt, close or list change that lands while this call was
    // waiting still stops it.
    if (state.closed) return refusal(RUN_ENDED_MESSAGE);
    if (this.haltedSessions.has(state.claims.sessionId)) return refusal(HALTED_MESSAGE);
    if (!tools.has(call.name)) return refusal(`${call.name} is not available in this run.`);

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
        return {
          content:
            `This call was collapsed: an identical ${call.name} call with the same arguments ` +
            `was already handled by tool_call_id ${handledBy}. Use that completed tool result — do not repeat this call.`,
          isError: false,
        };
      }
      seen.set(key, call.callId);
    }

    let outcome: BridgeExecuteOutcome;
    try {
      outcome = await this.deps.execute(state.claims, call);
      if (!outcome || typeof outcome.content !== "string") throw new Error("executor returned no result");
    } catch (err) {
      console.error(
        `[tool-bridge] ${call.name} failed for run ${state.claims.runId}:`,
        err instanceof Error ? err.message : String(err),
      );
      return refusal(`${call.name} failed to run.`);
    }

    // Latched even if the run closed while the tool was executing: the confirmation is
    // still outstanding for the session.
    if (outcome.requiresConfirmation) {
      this.haltedSessions.add(state.claims.sessionId);
      notify(state.onHalted, "onHalted");
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
    return {
      content: outcome.content,
      isError: outcome.isError === true,
      ...(outcome.images?.length ? { images: outcome.images } : {}),
    };
  }
}

function notify(callback: (() => void) | undefined, name: string): void {
  if (!callback) return;
  try {
    callback();
  } catch (err) {
    console.error(`[tool-bridge] ${name} failed (swallowed):`, err instanceof Error ? err.message : String(err));
  }
}

function trimOldest<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

function stableStringify(value: unknown): string {
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
