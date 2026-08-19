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
 *   3. the terminating turn produced no text AND tools ran earlier AND
 *      emptySynthesisRetries < limit
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
  /**
   * ENG-946: the text THIS terminating turn produced, independent of `content`.
   *
   * The loop's `content` is replace-on-nonempty, so a mid-run narration
   * ("I'll scan his roster…") survives into a final turn that came back empty —
   * making an unanswered run look answered and suppressing the synthesis nudge.
   * The empty-synthesis decision belongs to the turn that is ending, not to
   * whatever text is still sitting in the accumulator.
   *
   * Optional: when omitted the ladder falls back to `content`, i.e. exactly the
   * pre-fix behavior (the characterization harness relies on this).
   */
  currentTurnText?: string;
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

// Exported so synthesisResidue.ts can recognize a turn that echoes one of these
// back instead of answering it (ENG-1188) — each is pushed into the conversation
// and then the model is asked to respond again, so each is just as capable of being
// echoed back verbatim as an "answer" as SYNTHESIS_NUDGE is. These and their
// injection sites must never drift apart.
export const CONTINUE_PROMPT =
  '[SYSTEM] Your previous response was cut off because it exceeded the token limit. Please continue exactly where you left off.';

const CONTENT_FILTER_MESSAGE =
  "I'm unable to complete this request due to content safety guidelines. Please try rephrasing your request.";

export const SYNTHESIS_NUDGE =
  '[SYSTEM] You have gathered all the necessary data. Please now synthesize the information and provide your complete final response to the user.';

// Injected by agentModeService.ts's anti-loop detector when the model repeats an
// identical tool call MAX_CONSECUTIVE_REPEATS times. Defined here (not inline at the
// call site) so synthesisResidue.ts can import the same string rather than a copy
// that could drift.
export const ANTI_LOOP_STOP_MESSAGE =
  '[SYSTEM] You have been calling the same tools with the same arguments repeatedly without making progress. STOP calling tools and provide your final response to the user. Summarize what you accomplished and what could not be completed.';

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
  const contentIfEmpty =
    isContentFiltered && !input.content ? CONTENT_FILTER_MESSAGE : undefined;

  // 3. empty synthesis after tools -> nudge once (bounded).
  //    ENG-946: judged on THIS turn's text when the caller supplies it, so a stale
  //    accumulated narration can no longer masquerade as the final answer. When
  //    `currentTurnText` is omitted this falls back to `content` — the pre-fix input.
  //    Trimmed, so a whitespace-only turn counts as no answer (same test as
  //    `isFinalAssistantAnswer` applies downstream).
  //    A content-filtered turn never nudges (the canned message is the answer),
  //    which is what the monolith did by filling `content` before this check.
  const terminatingText = (
    input.currentTurnText !== undefined ? input.currentTurnText : input.content
  )?.trim();
  if (
    !isContentFiltered &&
    !terminatingText &&
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
