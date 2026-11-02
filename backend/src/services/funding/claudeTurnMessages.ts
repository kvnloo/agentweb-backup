/**
 * ENG-2113 PR C: turns the tool bridge's ledger for one Claude Code turn into the messages Emma's own loop would have persisted,
 * so a later turn (Emma or Claude) reads the chat history exactly as it reads today.
 *
 * Shape, verified against Emma's loop (agentModeService / core/toolDispatch):
 *  - one assistant message per model message, carrying OpenAI-shape `tool_calls` (arguments as a JSON string), immediately followed by
 *    one `role:'tool'` message per call id (`tool_call_id`, `name`, `content`, `metadata.timestamp`). `buildMarketingContext` keeps an
 *    assistant's tool_calls only when the very next message is a tool message, so the pairs must be adjacent.
 *  - a collapsed duplicate is a tool message with `metadata.duplicateSuppressed` and `duplicateOfId`, and a ledger entry with `duplicateOf`.
 *  - the last assistant message carries the answer, `llm`, the usage, and `metadata.toolCalls` (the ledger).
 *
 * The tool message content is `answeredContent ?? toolMessageContent`: what the MODEL was handed. The ledger's own text can carry an
 * approval token the model was deliberately not given (a halted preview answered with TURN_ENDED), and chat history is read by the next turn.
 * Likewise a minimal `result` is not copied for a call whose answer differs from the tool's real output.
 *
 * Pure: no I/O, no clock unless `now` is not supplied. Images are not persisted (the ledger omits them).
 */
import { EMPTY_FINAL_RESPONSE_FALLBACK } from "../agentMode/core/termination";
import type { BridgeCallRecord } from "./toolBridge";

export interface ClaudeTurnUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface MapLedgerInput {
  ledger: BridgeCallRecord[];
  /** The visible answer. A blank one becomes Emma's EMPTY_FINAL_RESPONSE_FALLBACK, so a reload never shows an empty assistant message. */
  finalText: string;
  /** The registry id, never the CLI alias (vision gating, acks and cost estimates read it). */
  llm: string;
  /** Extra stamps on every assistant message, e.g. the AgentWeb Model selection. */
  stamps?: Record<string, unknown>;
  usage?: ClaudeTurnUsage;
  now?: () => string;
}

/** A ledger entry shaped like the ones Emma keeps in `metadata.toolCalls`. */
export interface LedgerToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  duration: number;
  result?: unknown;
  error?: string;
  duplicateOf?: string;
}

export interface MappedTurn {
  responseMessages: any[];
  toolCalls: LedgerToolCall[];
}

/**
 * A "this call was deferred" result is the signal Emma's backstops use to start an AUTOMATIC follow-up turn (media budget deferral), and those turns run on
 * AgentWeb's models. A plan turn must never leave that signal in its stored ledger, whatever a tool returned, or a later read of the chat could continue
 * it on AgentWeb. The tool message text is kept; only the machine-readable marker is not.
 */
function isDeferral(result: unknown): boolean {
  return !!result && typeof result === "object" && (result as { deferred?: unknown }).deferred === true;
}

/** Consecutive records of one model message. A call the stream never announced is its own group. */
function groupRecords(ledger: BridgeCallRecord[]): BridgeCallRecord[][] {
  const groups: BridgeCallRecord[][] = [];
  let currentId: string | undefined;
  for (const rec of ledger) {
    const last = groups[groups.length - 1];
    if (rec.groupId !== undefined && rec.groupId === currentId && last) {
      last.push(rec);
    } else {
      groups.push([rec]);
      currentId = rec.groupId;
    }
  }
  return groups;
}

export function mapLedgerToResponseMessages(input: MapLedgerInput): MappedTurn {
  const now = input.now ?? (() => new Date().toISOString());
  const stamps = input.stamps ?? {};
  const responseMessages: any[] = [];
  const toolCalls: LedgerToolCall[] = [];

  for (const group of groupRecords(input.ledger)) {
    responseMessages.push({
      role: "assistant",
      content: "",
      tool_calls: group.map((rec) => ({
        id: rec.toolCallId,
        type: "function",
        function: { name: rec.name, arguments: JSON.stringify(rec.args ?? {}) },
      })),
      llm: input.llm,
      ...stamps,
      metadata: { timestamp: now() },
    });
    for (const rec of group) {
      const collapsed = rec.kind === "collapsed" && rec.duplicateOfId !== undefined;
      responseMessages.push({
        tool_call_id: rec.toolCallId,
        role: "tool",
        name: rec.name,
        content: rec.answeredContent ?? rec.toolMessageContent,
        metadata: { timestamp: now(), ...(collapsed ? { duplicateSuppressed: true, duplicateOfId: rec.duplicateOfId } : {}) },
      });
      const failed = rec.isError || rec.kind === "failed" || rec.kind === "refused";
      toolCalls.push({
        id: rec.toolCallId,
        name: rec.name,
        arguments: rec.args ?? {},
        duration: collapsed ? 0 : rec.durationMs,
        ...(collapsed ? { duplicateOf: rec.duplicateOfId } : {}),
        ...(rec.result !== undefined && rec.answeredContent === undefined && !collapsed && !isDeferral(rec.result) ? { result: rec.result } : {}),
        ...(failed && !collapsed ? { error: rec.error ?? "Tool call did not complete" } : {}),
      });
    }
  }

  responseMessages.push({
    role: "assistant",
    content: input.finalText && input.finalText.trim() ? input.finalText : EMPTY_FINAL_RESPONSE_FALLBACK,
    llm: input.llm,
    ...stamps,
    ...(input.usage
      ? {
          usage: {
            prompt_tokens: input.usage.prompt_tokens,
            completion_tokens: input.usage.completion_tokens,
            total_tokens: input.usage.total_tokens,
            cache_read_input_tokens: input.usage.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: input.usage.cache_creation_input_tokens ?? 0,
            // The customer's plan paid for these tokens. AgentWeb spent nothing, so no cost is booked against the session.
            estimated_cost: 0,
          },
        }
      : {}),
    metadata: {
      timestamp: now(),
      funding: "subscription",
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    },
  });

  return { responseMessages, toolCalls };
}
