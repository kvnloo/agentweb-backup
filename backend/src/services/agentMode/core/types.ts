/**
 * Agentic-core type contract for the AgentMode monolith→core strangler migration.
 *
 * These types define the SHAPE the small, legible core loop converges toward
 * (Claude-Code / OpenAI-agent-loop reference): one model call → parse tool calls
 * → dispatch via a typed registry → append results → repeat, with explicit
 * termination. The monolith is migrated onto these seams one at a time; each
 * extraction is proven behavior-preserving by the characterization harness.
 *
 * This file is intentionally dependency-free (pure types) so it can anchor the
 * boundary without dragging the 24k-line monolith into the core modules.
 */

/** Stable per-run context threaded through every step. Keyed by runId for idempotency. */
export interface RunContext {
  runId: string;
  sessionId: string;
  userId: string;
  /** the model id in use for this run (may switch to a backup mid-run) */
  llmModel: string;
  /** admin or admin-delegated access (gates admin-only tools) */
  hasAdminAccess: boolean;
  /** interactive-share session (blocks admin tools + connect_account) */
  isInteractiveShare: boolean;
}

/** A single normalized tool call the model emitted this step. */
export interface NormalizedToolCall {
  id: string;
  name: string;
  /** raw JSON-string arguments as emitted by the model (parsed downstream) */
  rawArguments: string;
}

/** Input to one step of the agent loop (one model turn + its consequences). */
export interface StepInput {
  /** the running message array (system + user + assistant + tool messages) */
  messages: any[];
  /** the model's response for this turn, in the shape `callLLM` returns */
  response: any;
  /** loop counters carried across steps (drive termination) */
  counters: LoopCounters;
}

/** The mutable counters the loop tracks to make termination decisions. */
export interface LoopCounters {
  iteration: number;
  maxIterations: number;
  maxTokensContinuations: number;
  maxTokenContinuationsLimit: number;
  emptySynthesisRetries: number;
  maxEmptySynthesisRetries: number;
}

/** The outcome of one step: what the loop should do next. */
export interface StepResult {
  /** messages after appending the assistant message + any tool results */
  messages: any[];
  /** the tool calls executed (or attempted) this step, in order */
  toolCalls: any[];
  /** the assistant content produced this step (may be '') */
  content: string;
  /** whether the loop should run another iteration */
  shouldContinue: boolean;
  /** machine-readable reason for the continue/stop decision */
  reason: TerminationReason;
}

/**
 * Why the loop continued or stopped after a turn. Exhaustive over the monolith's
 * current decision points (see core/termination.ts). 'tool_calls' means the model
 * requested tools, so the loop continues to dispatch + feed results back.
 */
export type TerminationReason =
  | 'tool_calls' // model requested tools -> continue
  | 'max_tokens_continuation' // truncated -> nudge to continue
  | 'empty_synthesis_retry' // empty text after tools -> nudge once
  | 'final_response' // model gave a final text answer -> stop
  | 'content_filtered' // blocked by safety -> stop with canned message
  | 'cancelled' // user cancelled -> stop
  | 'max_iterations'; // hit the iteration budget -> stop

/** A typed tool: one schema + one pure-ish handler behind the gateway boundary. */
export interface RegisteredTool {
  name: string;
  /** JSON schema for the tool's arguments (validated at the boundary) */
  inputSchema?: any;
}

/** The boundary the core loop dispatches through. Implemented by the monolith today. */
export interface ToolRegistry {
  getTool(name: string): RegisteredTool | undefined;
  /** execute a validated tool call and return its raw result */
  execute(name: string, args: any, ctx: RunContext): Promise<any>;
}
