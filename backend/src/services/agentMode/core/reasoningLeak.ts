/**
 * PURE detection of leaked Gemini chain-of-thought in an assistant turn.
 *
 * Background (ENG-737): Gemini "thinking" models (e.g. gemini-3.5-flash) stream
 * their answer through the OpenAI-compatibility endpoint. When a turn is cut off
 * by the output-token limit WHILE the model is still in its reasoning phase, the
 * endpoint returns the raw chain-of-thought as `message.content` — the first such
 * fragment is prefixed with a bare lowercase `thought` part marker, and the
 * max-tokens continuation loop then emits FURTHER truncated fragments that
 * continue the same monologue with NO marker (session d103071a: fragments 29/30
 * carry the marker, 30's continuation 31 is a markerless repeated-query loop).
 * Each fragment is otherwise (a) persisted as a visible assistant message and
 * (b) re-fed through the continuation loop, leaking internal reasoning into chat.
 * The model's real, synthesized answer only arrives on the final non-truncated turn.
 *
 * This module identifies such a leaked fragment so the caller can suppress it. It
 * uses two signals, both requiring a TRUNCATED (`finish_reason === 'length'`)
 * Gemini-thinking turn:
 *   1. a bare leading lowercase `thought` part marker — unambiguous, machine-emitted;
 *   2. a degenerate repeated-line loop that DIRECTLY CONTINUES an already-suppressed
 *      leak in the same continuation chain (`precededBySuppressedLeak`). This second
 *      signal is deliberately double-gated: it fires only when BOTH the prior
 *      fragment was itself a suppressed leak AND this fragment is a degenerate loop.
 *      That is what lets it catch the markerless continuation (fragment 31) WITHOUT
 *      ever suppressing (a) a standalone answer that merely contains repeated data /
 *      template rows / code — such content does not follow a suppressed leak — or
 *      (b) a truncated real prose answer — which is not a degenerate loop.
 * A COMPLETED answer (`finish_reason` other than `length`) is never a candidate, so
 * a finished answer can never be blanked.
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
  /**
   * True when the immediately-preceding assistant fragment in this same
   * continuation chain was itself suppressed as a leak. Gates the markerless
   * degenerate-loop continuation signal so it can only fire mid-leak, never on
   * standalone content. Defaults to false (a fresh turn is never a continuation).
   */
  precededBySuppressedLeak?: boolean;
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
 * True when some non-trivial line (>= minLen chars, trimmed) appears identically
 * on `minRepeat` or more CONSECUTIVE lines — the degenerate-loop shape of a
 * runaway reasoning fragment. Blank/short lines break the run so non-adjacent
 * duplicates are never treated as a loop. NOTE: this shape alone is NOT trusted as
 * a leak (legitimate output can repeat lines); `isReasoningLeak` only consults it
 * for a fragment that continues an already-suppressed leak.
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
 * True when this turn is a TRUNCATED Gemini-thinking turn whose content is leaked
 * chain-of-thought and should therefore be suppressed from the chat. Requires:
 *   - the turn was truncated by the token limit (`finish_reason === 'length'`), so
 *     the continuation loop is guaranteed to run again and deliver the real answer,
 *     and a COMPLETED answer is never a candidate; AND
 *   - it is a Gemini thinking turn (thought_signature present, or a gemini-* model); AND
 *   - EITHER the content opens with a bare lowercase `thought` marker, OR it is a
 *     degenerate repeated-line loop that directly continues an already-suppressed
 *     leak (`precededBySuppressedLeak`) — see the module header for why this second
 *     signal is double-gated and therefore safe.
 */
export function isReasoningLeak(input: LeakedReasoningInput): boolean {
  if (input.finishReason !== 'length') return false;
  const isGeminiThinking = input.hasThoughtSignature || input.model.startsWith('gemini-');
  if (!isGeminiThinking) return false;
  if (hasLeadingThoughtMarker(input.content)) return true;
  if (input.precededBySuppressedLeak && hasDegenerateRepeatedLine(input.content)) return true;
  return false;
}
