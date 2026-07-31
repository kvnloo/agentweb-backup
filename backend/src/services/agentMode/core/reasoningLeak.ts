/**
 * PURE detection of leaked Gemini chain-of-thought in an assistant turn.
 *
 * Background (ENG-737): Gemini "thinking" models (e.g. gemini-3.5-flash) stream
 * their answer through the OpenAI-compatibility endpoint. When a turn is cut off
 * by the output-token limit WHILE the model is still in its reasoning phase, the
 * endpoint returns the raw chain-of-thought as `message.content` — the fragment
 * is prefixed with a bare lowercase `thought` part marker (session d103071a,
 * fragments 29/30). Each such fragment is otherwise (a) persisted as a visible
 * assistant message and (b) re-fed through the continuation loop, leaking
 * internal reasoning into chat. The model's real, synthesized answer only
 * arrives on the final non-truncated turn.
 *
 * This is now the COMPAT-PATH FALLBACK ONLY: the primary path (the native
 * @google/genai adapter, default ON — see geminiNativeClient.ts) prevents the
 * leak structurally by never returning thought parts at all, so this heuristic
 * only runs when the kill-switch has been flipped off. It uses a single signal:
 * a bare leading lowercase `thought` part marker — unambiguous, machine-emitted,
 * proven zero-false-positive across every real Gemini turn in both affected prod
 * sessions. A COMPLETED answer (`finish_reason` other than `length`) is never a
 * candidate, so a finished answer can never be blanked.
 *
 * An earlier version of this module also tried to catch a MARKERLESS
 * continuation of a suppressed leak via a degenerate-repeated-line signal
 * (session d103071a fragment 31). That signal was removed: it re-litigates the
 * same leak-vs-legitimate-repeated-content ambiguity across a prior 4-cycle
 * review, and now that the native adapter removes the leak at the source for
 * the default path, the residual risk of a markerless leak slipping through on
 * the rarely-used fallback path is an acceptable, disclosed tradeoff against the
 * bigger risk of the old signal erasing legitimate repeated content.
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
 * True when this turn is a TRUNCATED Gemini-thinking turn whose content is leaked
 * chain-of-thought and should therefore be suppressed from the chat. Requires:
 *   - the turn was truncated by the token limit (`finish_reason === 'length'`), so
 *     the continuation loop is guaranteed to run again and deliver the real answer,
 *     and a COMPLETED answer is never a candidate; AND
 *   - it is a Gemini thinking turn (thought_signature present, or a gemini-* model); AND
 *   - the content opens with a bare lowercase `thought` marker.
 */
export function isReasoningLeak(input: LeakedReasoningInput): boolean {
  if (input.finishReason !== 'length') return false;
  const isGeminiThinking = input.hasThoughtSignature || input.model.startsWith('gemini-');
  if (!isGeminiThinking) return false;
  return hasLeadingThoughtMarker(input.content);
}
