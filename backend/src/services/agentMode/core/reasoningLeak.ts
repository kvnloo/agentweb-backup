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
 * It is intentionally conservative: it only fires on a TRUNCATED
 * (`finish_reason === 'length'`) Gemini-thinking turn whose content carries an
 * unmistakable reasoning-leak signature, so a normal truncated answer fragment
 * (which the continuation loop legitimately keeps and stitches together) is never
 * suppressed.
 */

export interface LeakedReasoningInput {
  /** finish_reason from the model response (only 'length' turns can be a truncated leak) */
  finishReason?: string;
  /** the assistant content the turn returned */
  content: string;
  /** whether the response message carried a google thought_signature (a Gemini thinking turn) */
  hasThoughtSignature: boolean;
  /** the model id in use for this turn */
  model: string;
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

  // 1. Leading OpenAI-compat "thought" part marker (a line that is exactly "thought").
  const firstLine = content.trimStart().split('\n', 1)[0].trim();
  if (/^thought$/i.test(firstLine)) return true;

  // 2. Degenerate repeated-line loop.
  if (hasDegenerateRepeatedLine(content)) return true;

  return false;
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
 * True when this turn is a truncated Gemini-thinking turn whose content is leaked
 * chain-of-thought and should therefore be suppressed from the chat. All of:
 *   - the turn was truncated by the token limit (`finish_reason === 'length'`), so
 *     the max-tokens continuation loop will run again and deliver the real answer;
 *   - it is a Gemini thinking turn (thought_signature present, or a gemini-* model);
 *   - the content carries an unmistakable reasoning-leak signature.
 */
export function isTruncatedReasoningLeak(input: LeakedReasoningInput): boolean {
  if (input.finishReason !== 'length') return false;
  const isGeminiThinking = input.hasThoughtSignature || input.model.startsWith('gemini-');
  if (!isGeminiThinking) return false;
  return looksLikeLeakedReasoning(input.content);
}
