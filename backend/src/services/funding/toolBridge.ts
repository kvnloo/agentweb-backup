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
}

export interface BridgeExecuteOutcome {
  content: string;
  isError: boolean;
  /** The tool did not act and is waiting for the user to confirm. Halts the session. */
  requiresConfirmation: boolean;
  /** The run's tool list may have changed (a skill was installed). */
  toolsChanged: boolean;
}

export interface BridgeCallResult {
  content: string;
  isError: boolean;
}

export interface ToolBridgeDeps {
  /** The run's current filtered tool list: what Emma's own loop would offer the model right now. */
  resolveTools(run: RunToolTokenClaims): Promise<BridgeTool[]>;
  isReadOnly(toolName: string): boolean;
  execute(run: RunToolTokenClaims, call: BridgeToolCall): Promise<BridgeExecuteOutcome>;
  /** Called once when a run closes. A call may still be executing for that run. */
  releaseRun?(runId: string): void;
}

export interface OpenRunOptions {
  /** Fires when the harness must re-read the tool list. */
  onToolsChanged?: () => void;
  /** Fires when a result halts the session, so the caller can persist it. */
  onHalted?: () => void;
  /** Set when the session was already waiting on a confirmation before this run opened. */
  halted?: boolean;
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
  onToolsChanged?: () => void;
  onHalted?: () => void;
}

const HALTED_MESSAGE =
  "This conversation is waiting for the user to confirm an earlier action. No tool can run until the user replies. " +
  "Stop here and ask the user to confirm.";
const RUN_ENDED_MESSAGE = "This run has ended.";
const LIST_UNAVAILABLE_MESSAGE = "The tool list is unavailable right now, so no tool can run.";
const MAX_LIST_READS_PER_CALL = 3;

export class ToolBridge {
  private readonly runs = new Map<string, RunState>();
  private readonly haltedSessions = new Set<string>();

  constructor(
    private readonly deps: ToolBridgeDeps,
    private readonly tokens: RunToolTokenStore = new RunToolTokenStore(),
  ) {}

  /** Opens a run and returns its token. A run already open under this id is closed first. */
  openRun(claims: RunToolTokenClaims, opts: OpenRunOptions = {}): string {
    this.closeRun(claims.runId);
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
    });
    return this.tokens.mint(claims);
  }

  /** Ends the run: the token stops working and everything waiting on the run is refused. */
  closeRun(runId: string): void {
    const state = this.runs.get(runId);
    this.tokens.revokeRun(runId);
    if (!state) return;
    state.closed = true;
    this.runs.delete(runId);
    for (const release of [...state.waiters]) release();
    state.waiters.clear();
    this.deps.releaseRun?.(runId);
  }

  /** Lifts a session's confirmation halt. Only a new turn from the user may trigger this. */
  clearHalt(sessionId: string): void {
    this.haltedSessions.delete(sessionId);
  }

  isHalted(sessionId: string): boolean {
    return this.haltedSessions.has(sessionId);
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

  /** Never rejects. Every check that must hold at the moment of execution is made here. */
  private async execute(state: RunState, call: BridgeToolCall): Promise<BridgeCallResult> {
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
      if (!state.closed) notify(state.onToolsChanged, "onToolsChanged");
    }
    return { content: outcome.content, isError: outcome.isError === true };
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

function refusal(message: string): BridgeCallResult {
  return { content: message, isError: true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
