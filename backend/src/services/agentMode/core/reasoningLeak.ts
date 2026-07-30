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
 * It is intentionally conservative: it fires ONLY on a TRUNCATED
 * (`finish_reason === 'length'`) Gemini-thinking turn — i.e. one the max-tokens
 * continuation loop is guaranteed to re-run and re-synthesize a real answer for —
 * whose content carries an unmistakable reasoning-leak signature:
 *   - a bare leading lowercase `thought` part marker (the exact OpenAI-compat
 *     thought-part label, always lowercase — never a human `Thought` heading); or
 *   - a degenerate repeated-line loop (the same substantial line back-to-back many
 *     times).
 * Because suppression only ever happens on a turn that WILL be continued, a
 * COMPLETED answer (`finish_reason === 'stop'`/`tool_calls`) is never touched — so
 * a real, finished answer can never be blanked, even if it happens to look
 * reasoning-shaped. (This deliberately does not catch the rarer leak shape where a
 * completed tool-call turn is prefixed with a `thought` monologue — accepting that
 * miss is the price of guaranteeing a finished answer is never erased.)
 */

export interface LeakedReasoningInput {
  /** finish_reason from the model response — only a truncated ('length') turn can be a suppressible leak */
  finishReason?: string;
  /** the assistant content the turn returned */
  content: string;
  /** whether the response message carried a google thought_signature (a Gemini thinking turn) */
  hasThoughtSignature: boolean;
  /** the model id in use for this turn */
  model: string;
}

/**
 * A leading `thought` part marker: the first non-blank line is exactly the
 * lowercase word `thought`, the OpenAI-compat label for a Gemini thought part.
 * The match is case-SENSITIVE on purpose: the machine-emitted label is always
 * lowercase `thought`, whereas a legitimate user-facing answer that opens with a
 * `Thought` / `THOUGHT` heading is capitalized — so this never mistakes a real
 * heading for leaked reasoning.
 */
export function hasLeadingThoughtMarker(content: string): boolean {
  if (!content) return false;
  const firstLine = content.trimStart().split('\n', 1)[0].trim();
  return firstLine === 'thought';
}

/**
 * Heuristic: does this content look like leaked model reasoning rather than a
 * user-facing answer? Two unmistakable signatures, either of which is enough:
 *   1. A leading `thought` part marker (the OpenAI-compat label for a thought part).
 *   2. A degenerate reasoning loop — the SAME substantial line repeated back-to-back
 *      many times (the "repetitive search queries" corruption). Legitimate answer
 *      text effectively never repeats an identical ≥12-char line 6+ times in a row.
 */
export function looksLikeLeakedReasoning(content: string): boolean {
  if (!content) return false;
  return hasLeadingThoughtMarker(content) || hasDegenerateRepeatedLine(content);
}

/**
 * True when some non-trivial line (>= minLen chars, trimmed) appears identically
 * on `minRepeat` or more CONSECUTIVE lines. Blank/short lines break the run so
 * non-adjacent duplicates are never treated as a loop. The default `minRepeat` is
 * deliberately high (6): the real leak repeats its query line 10-12× in a row,
 * while a legitimate answer might intentionally repeat an identical line a handful
 * of times (template/data/code rows), so 6 keeps real coverage without erasing
 * those.
 */
export function hasDegenerateRepeatedLine(content: string, minLen = 12, minRepeat = 6): boolean {
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
 * True when this turn is a TRUNCATED Gemini-thinking turn whose content is leaked
 * chain-of-thought and should therefore be suppressed from the chat. ALL of:
 *   - the turn was truncated by the token limit (`finish_reason === 'length'`), so
 *     the max-tokens continuation loop is guaranteed to run again and deliver the
 *     real answer — a COMPLETED answer is therefore never a candidate and can
 *     never be blanked;
 *   - it is a Gemini thinking turn (thought_signature present, or a gemini-* model);
 *   - the content carries an unmistakable reasoning-leak signature (a lowercase
 *     `thought` marker or a degenerate repeated-line loop).
 */
export function isReasoningLeak(input: LeakedReasoningInput): boolean {
  if (input.finishReason !== 'length') return false;
  const isGeminiThinking = input.hasThoughtSignature || input.model.startsWith('gemini-');
  if (!isGeminiThinking) return false;
  return looksLikeLeakedReasoning(input.content);
}
