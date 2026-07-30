/**
 * PURE detection of leaked Gemini chain-of-thought in an assistant turn.
 *
 * Background (ENG-737): Gemini "thinking" models (e.g. gemini-3.5-flash) stream
 * their answer through the OpenAI-compatibility endpoint. When a turn is cut off
 * by the output-token limit WHILE the model is still in its reasoning phase, the
 * endpoint returns the raw chain-of-thought as `message.content` — typically
 * prefixed with a bare `thought` part marker and always carrying a google
 * `thought_signature` in `extra_content`. Left untouched, each truncated
 * reasoning fragment is (a) persisted as a visible assistant message and
 * (b) re-fed through the max-tokens continuation loop, leaking internal reasoning
 * and repeated/duplicated tool queries into the user-facing chat (corrupted,
 * cluttered output). The model's real, synthesized answer only arrives on the
 * final non-truncated turn.
 *
 * This module identifies such a leaked fragment so the caller can suppress it.
 * It is intentionally conservative and only ever fires on a Gemini-thinking turn
 * whose content carries an unmistakable reasoning-leak signature:
 *   - a bare leading `thought` part marker — this is leaked thought output on ANY
 *     finish_reason (observed both on truncated `length` turns, session
 *     d103071a, AND on a completed tool-call turn, session 97d37f59, where the
 *     model prefixed its tool call with a raw `thought\n…` monologue); or
 *   - a degenerate repeated-line loop — only trusted on a TRUNCATED
 *     (`finish_reason === 'length'`) turn, where the max-tokens continuation loop
 *     will re-synthesize the real answer, so a normal (possibly repetitive but
 *     complete) answer that finished on its own is never suppressed.
 */

export interface LeakedReasoningInput {
  /** finish_reason from the model response ('length' = truncated; gates the degenerate-loop signature) */
  finishReason?: string;
  /** the assistant content the turn returned */
  content: string;
  /** whether the response message carried a google thought_signature (a Gemini thinking turn) */
  hasThoughtSignature: boolean;
  /** the model id in use for this turn */
  model: string;
}

/**
 * A leading `thought` part marker: the first non-blank line is exactly `thought`
 * (case-insensitive), the OpenAI-compat label for a Gemini thought part. This is
 * an unmistakable leak of internal reasoning that never appears at the start of a
 * real user-facing answer, so it is a leak signal on ANY finish_reason.
 */
export function hasLeadingThoughtMarker(content: string): boolean {
  if (!content) return false;
  const firstLine = content.trimStart().split('\n', 1)[0].trim();
  return /^thought$/i.test(firstLine);
}

/**
 * Heuristic: does this content look like leaked model reasoning rather than a
 * user-facing answer? Two unmistakable signatures, either of which is enough:
 *   1. A leading `thought` part marker (the OpenAI-compat label for a thought part).
 *   2. A degenerate reasoning loop — the SAME substantial line repeated back-to-back
 *      many times (the "repetitive search queries" corruption). Legitimate answer
 *      text effectively never repeats an identical ≥12-char line 4+ times in a row.
 */
export function looksLikeLeakedReasoning(content: string): boolean {
  if (!content) return false;
  return hasLeadingThoughtMarker(content) || hasDegenerateRepeatedLine(content);
}

/**
 * True when some non-trivial line (>= minLen chars, trimmed) appears identically
 * on `minRepeat` or more CONSECUTIVE lines. Blank/short lines break the run so
 * non-adjacent duplicates are never treated as a loop.
 */
export function hasDegenerateRepeatedLine(content: string, minLen = 12, minRepeat = 4): boolean {
  let run = 1;
  let prev = '';
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.length >= minLen && line === prev) {
      run++;
      if (run >= minRepeat) return true;
    } else {
      run = 1;
    }
    prev = line;
  }
  return false;
}

/**
 * True when this Gemini-thinking turn's content is leaked chain-of-thought and
 * should therefore be suppressed from the chat. Requires a Gemini thinking turn
 * (thought_signature present, or a gemini-* model) plus one of:
 *   - a bare leading `thought` marker — a leak on ANY finish_reason (seen both on
 *     a truncated `length` turn and on a completed tool-call turn); or
 *   - a degenerate repeated-line loop on a TRUNCATED (`finish_reason === 'length'`)
 *     turn, where the max-tokens continuation loop will still deliver the real
 *     answer. The length gate keeps a legitimately repetitive BUT complete answer
 *     (one that finished on its own) from ever being blanked.
 */
export function isReasoningLeak(input: LeakedReasoningInput): boolean {
  const isGeminiThinking = input.hasThoughtSignature || input.model.startsWith('gemini-');
  if (!isGeminiThinking) return false;
  if (hasLeadingThoughtMarker(input.content)) return true;
  if (input.finishReason === 'length' && hasDegenerateRepeatedLine(input.content)) return true;
  return false;
}
