/**
 * PURE detection of leaked Gemini chain-of-thought in an assistant turn.
 *
 * Background (ENG-737): Gemini "thinking" models (e.g. gemini-3.5-flash) stream
 * their answer through the OpenAI-compatibility endpoint. When a turn is cut off
 * by the output-token limit WHILE the model is still in its reasoning phase, the
 * endpoint returns the raw chain-of-thought as `message.content` — prefixed with
 * a bare lowercase `thought` part marker and carrying a google `thought_signature`
 * in `extra_content`. Left untouched, that truncated reasoning fragment is
 * (a) persisted as a visible assistant message and (b) re-fed through the
 * max-tokens continuation loop, leaking internal reasoning into the user-facing
 * chat. The model's real, synthesized answer only arrives on the final
 * non-truncated turn.
 *
 * This module identifies such a leaked fragment so the caller can suppress it. It
 * is deliberately narrow and keys ONLY on the one unambiguous, machine-emitted
 * signature — a bare leading lowercase `thought` part marker — on a TRUNCATED
 * (`finish_reason === 'length'`) Gemini-thinking turn. We intentionally do NOT try
 * to classify content by shape (e.g. "looks repetitive" / "looks like reasoning"):
 * any such heuristic can mistake legitimate output (intentionally repeated data,
 * template rows, code) for a leak and erase a real answer, which is a worse
 * failure than a missed leak. Consequence: a mid-thought continuation fragment
 * that carries no `thought` marker is not caught here.
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
 * chain-of-thought and should therefore be suppressed from the chat. ALL of:
 *   - the turn was truncated by the token limit (`finish_reason === 'length'`), so
 *     the max-tokens continuation loop is guaranteed to run again and deliver the
 *     real answer — a COMPLETED answer is therefore never a candidate and can
 *     never be blanked;
 *   - it is a Gemini thinking turn (thought_signature present, or a gemini-* model);
 *   - the content opens with a bare lowercase `thought` part marker.
 */
export function isReasoningLeak(input: LeakedReasoningInput): boolean {
  if (input.finishReason !== 'length') return false;
  const isGeminiThinking = input.hasThoughtSignature || input.model.startsWith('gemini-');
  if (!isGeminiThinking) return false;
  return hasLeadingThoughtMarker(input.content);
}
