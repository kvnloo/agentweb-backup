/**
 * PURE termination-decision logic for the AgentMode core loop.
 *
 * Extracted (behavior-preserving) from `agentModeService.generateMarketingResponse`'s
 * "no tool_calls" branch (the post-turn decision after the model returns without
 * requesting tools). The monolith calls `decideTermination` and acts on the result
 * instead of inlining the branch ladder. The characterization harness proves the
 * tool-call sequence + final content are unchanged.
 *
 * Decision ladder (must match the monolith EXACTLY):
 *   1. finish_reason === 'length' AND maxTokensContinuations < limit
 *        -> continue, inject "continue where you left off", increment continuations
 *   2. content_filter / guardrail_intervened / content_filtered
 *        -> set canned safety message IF no content yet; then fall through to (3/4)
 *   3. no content AND tools ran earlier AND emptySynthesisRetries < limit
 *        -> continue, inject synthesis nudge, increment retries
 *   4. otherwise -> final response (stop)
 *
 * This function is PURE: it reads inputs and returns a decision. It does NOT mutate
 * messages or counters — the caller applies `counterDelta` and pushes `injectMessage`.
 */

import type { TerminationReason } from './types';

export interface TerminationInput {
  /** finish_reason from the model response (e.g. 'stop' | 'length' | 'content_filter') */
  finishReason?: string;
  /** stop_reason passthrough (Claude: 'guardrail_intervened' | 'content_filtered' | ...) */
  stopReason?: string;
  /** accumulated assistant content so far (the loop's `content` variable) */
  content: string;
  /** how many tool calls have run this whole session so far */
  toolCallsSoFar: number;
  /** continuations already used after max_tokens truncation */
  maxTokensContinuations: number;
  maxTokenContinuationsLimit: number;
  /** empty-synthesis nudges already used */
  emptySynthesisRetries: number;
  maxEmptySynthesisRetries: number;
}

export interface TerminationDecision {
  /** whether the loop should run another iteration */
  shouldContinue: boolean;
  /** machine-readable reason */
  reason: TerminationReason;
  /** a user-role message to push before continuing (only when shouldContinue) */
  injectMessage?: string;
  /**
   * the content the loop should adopt IF it currently has none. The monolith only
   * applies this when `content` is falsy (the safety/canned-message case).
   * undefined means "leave content as-is".
   */
  contentIfEmpty?: string;
  /** counter increments the caller must apply to keep the loop's state in sync */
  counterDelta: {
    maxTokensContinuations: number;
    emptySynthesisRetries: number;
  };
}

const CONTINUE_PROMPT =
  '[SYSTEM] Your previous response was cut off because it exceeded the token limit. Please continue exactly where you left off.';

const CONTENT_FILTER_MESSAGE =
  "I'm unable to complete this request due to content safety guidelines. Please try rephrasing your request.";

const SYNTHESIS_NUDGE =
  '[SYSTEM] You have gathered all the necessary data. Please now synthesize the information and provide your complete final response to the user.';

/**
 * Decide what to do after a model turn that returned NO tool calls.
 * Call this only when the response has no tool_calls (the monolith's branch guard).
 */
export function decideTermination(input: TerminationInput): TerminationDecision {
  const noDelta = { maxTokensContinuations: 0, emptySynthesisRetries: 0 };

  // 1. max_tokens truncation -> continuation (bounded)
  if (
    input.finishReason === 'length' &&
    input.maxTokensContinuations < input.maxTokenContinuationsLimit
  ) {
    return {
      shouldContinue: true,
      reason: 'max_tokens_continuation',
      injectMessage: CONTINUE_PROMPT,
      counterDelta: { maxTokensContinuations: 1, emptySynthesisRetries: 0 },
    };
  }

  // 2. content filter -> adopt canned message only if no content yet.
  //    NOTE: in the monolith this does NOT short-circuit; it falls through to the
  //    empty-synthesis check and then the final break. We model that by carrying
  //    `contentIfEmpty` and continuing the ladder with the (possibly) filled content.
  const isContentFiltered =
    input.finishReason === 'content_filter' ||
    input.stopReason === 'guardrail_intervened' ||
    input.stopReason === 'content_filtered';
  const effectiveContent =
    isContentFiltered && !input.content ? CONTENT_FILTER_MESSAGE : input.content;
  const contentIfEmpty =
    isContentFiltered && !input.content ? CONTENT_FILTER_MESSAGE : undefined;

  // 3. empty synthesis after tools -> nudge once (bounded).
  //    Uses effectiveContent so a content-filter canned message counts as "has content"
  //    and does NOT trigger a synthesis retry — matching the monolith's `if (!content ...)`
  //    which runs AFTER the content-filter block has already set `content`.
  if (
    !effectiveContent &&
    input.toolCallsSoFar > 0 &&
    input.emptySynthesisRetries < input.maxEmptySynthesisRetries
  ) {
    return {
      shouldContinue: true,
      reason: 'empty_synthesis_retry',
      injectMessage: SYNTHESIS_NUDGE,
      counterDelta: { maxTokensContinuations: 0, emptySynthesisRetries: 1 },
    };
  }

  // 4. otherwise -> final response (stop).
  return {
    shouldContinue: false,
    reason: isContentFiltered ? 'content_filtered' : 'final_response',
    contentIfEmpty,
    counterDelta: noDelta,
  };
}
