/**
 * ENG-2109 (B2): the harness-agnostic core of the tool bridge. A `claude -p` session
 * (or any other harness) reaches Emma's tools only through `listTools` and `callTool`,
 * and only with the run's own token.
 *
 * Under `claude -p` the CLI owns the agent loop, so the controls Emma's loop enforces
 * around tool dispatch have to live here instead:
 *
 *  - The model sees exactly the run's filtered tool list, and a call is checked against
 *    that list again when it executes, not only when it was listed.
 *  - A result that asks for the user's confirmation halts the run. Several tools hand
 *    the model the very token needed to confirm (campaign launches, Google Ads
 *    overrides, image edits) and rely on Emma's loop ending the turn so a human replies
 *    first. Without this halt the model could preview and confirm in one turn.
 *  - Tools not known to be read-only run one at a time per run.
 *
 * What a tool is, how it executes and what counts as read-only are injected, so this
 * file has no dependency on agentModeService and no production caller yet (ENG-2113
 * wires it in).
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
  /** The tool did not act and is waiting for the user to confirm. Halts the run. */
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
  /** Called once when a run closes, so the executor can drop any per-run state it holds. */
  releaseRun?(runId: string): void;
}

export class ToolBridgeAuthError extends Error {
  constructor(public readonly reason: RunToolTokenRejection) {
    super(`tool bridge: token rejected (${reason})`);
    this.name = "ToolBridgeAuthError";
  }
}

interface RunState {
  claims: RunToolTokenClaims;
  toolsPromise: Promise<Map<string, BridgeListedTool>> | null;
  halted: boolean;
  closed: boolean;
  /** Tail of the queue that serializes calls to tools not known to be read-only. */
  serialTail: Promise<void>;
  onToolsChanged?: () => void;
}

const HALTED_MESSAGE =
  "This run is waiting for the user to confirm an earlier action. No tool can run until the user replies. " +
  "Stop here and ask the user to confirm.";

export class ToolBridge {
  private readonly runs = new Map<string, RunState>();

  constructor(
    private readonly deps: ToolBridgeDeps,
    private readonly tokens: RunToolTokenStore = new RunToolTokenStore(),
  ) {}

  /** Opens a run and returns its token. `onToolsChanged` fires when the tool list must be re-read. */
  openRun(claims: RunToolTokenClaims, opts: { onToolsChanged?: () => void } = {}): string {
    this.closeRun(claims.runId);
    this.runs.set(claims.runId, {
      claims: { ...claims },
      toolsPromise: null,
      halted: false,
      closed: false,
      serialTail: Promise.resolve(),
      onToolsChanged: opts.onToolsChanged,
    });
    return this.tokens.mint(claims);
  }

  /** Ends the run: the token stops working and queued calls are refused. */
  closeRun(runId: string): void {
    const state = this.runs.get(runId);
    this.tokens.revokeRun(runId);
    if (!state) return;
    state.closed = true;
    this.runs.delete(runId);
    this.deps.releaseRun?.(runId);
  }

  /** Lifts a confirmation halt. Only a new turn from the user may trigger this. */
  clearHalt(runId: string): void {
    const state = this.runs.get(runId);
    if (state) state.halted = false;
  }

  isHalted(runId: string): boolean {
    return this.runs.get(runId)?.halted === true;
  }

  async listTools(token: string | undefined | null, expectedRunId?: string): Promise<BridgeListedTool[]> {
    const state = this.authenticate(token, expectedRunId);
    return [...(await this.currentTools(state)).values()].map((tool) => ({ ...tool }));
  }

  async callTool(
    token: string | undefined | null,
    call: BridgeToolCall,
    expectedRunId?: string,
  ): Promise<BridgeCallResult> {
    const state = this.authenticate(token, expectedRunId);
    if (!isPlainObject(call.args)) {
      return refusal(`Arguments for ${call.name} must be an object.`);
    }

    let tools: Map<string, BridgeListedTool>;
    try {
      tools = await this.currentTools(state);
    } catch {
      return refusal("The tool list is unavailable right now, so no tool can run.");
    }
    const tool = tools.get(call.name);
    if (!tool) return refusal(`${call.name} is not available in this run.`);

    if (tool.readOnly) return this.execute(state, call);

    const queued = state.serialTail.then(() => this.execute(state, call));
    state.serialTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private authenticate(token: string | undefined | null, expectedRunId?: string): RunState {
    const verified = this.tokens.verify(token, expectedRunId);
    if (!verified.ok) throw new ToolBridgeAuthError(verified.reason);
    const state = this.runs.get(verified.claims.runId);
    if (!state) throw new ToolBridgeAuthError("unknown");
    return state;
  }

  private currentTools(state: RunState): Promise<Map<string, BridgeListedTool>> {
    if (!state.toolsPromise) {
      const pending = this.deps.resolveTools(state.claims).then((tools) => {
        const byName = new Map<string, BridgeListedTool>();
        for (const tool of tools) {
          byName.set(tool.name, { ...tool, readOnly: this.deps.isReadOnly(tool.name) });
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

  /**
   * Every check that must hold at the moment of execution is repeated here, because a
   * queued call can wait behind one that halts the run, ends it, or changes its tools.
   */
  private async execute(state: RunState, call: BridgeToolCall): Promise<BridgeCallResult> {
    try {
      const tools = await this.currentTools(state);
      if (!tools.has(call.name)) return refusal(`${call.name} is not available in this run.`);
    } catch {
      return refusal("The tool list is unavailable right now, so no tool can run.");
    }
    // Checked after the await above and with nothing async before the executor is
    // invoked, so a halt or close that lands while this call was waiting still stops it.
    if (state.closed) return refusal("This run has ended.");
    if (state.halted) return refusal(HALTED_MESSAGE);

    let outcome: BridgeExecuteOutcome;
    try {
      outcome = await this.deps.execute(state.claims, call);
    } catch (err) {
      console.error(
        `[tool-bridge] ${call.name} failed for run ${state.claims.runId}:`,
        err instanceof Error ? err.message : String(err),
      );
      return refusal(`${call.name} failed to run.`);
    }

    if (outcome.requiresConfirmation) state.halted = true;
    if (outcome.toolsChanged) {
      state.toolsPromise = null;
      try {
        state.onToolsChanged?.();
      } catch (err) {
        console.error(
          "[tool-bridge] onToolsChanged failed (swallowed):",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return { content: outcome.content, isError: outcome.isError };
  }
}

function refusal(message: string): BridgeCallResult {
  return { content: message, isError: true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
