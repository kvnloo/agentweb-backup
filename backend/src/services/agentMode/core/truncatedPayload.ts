/**
 * PURE helper: make a hard-sliced tool payload SELF-TERMINATING (ENG-1054).
 *
 * Large tool responses are offloaded to S3 and the in-memory copy is cut with a
 * plain `substring` (see toolDispatch's S3 preview). That slice lands wherever the
 * byte budget runs out — routinely mid-string, inside a half-written JSON object —
 * so what reaches the model is an OPEN structure:
 *
 *     {"success":true,"ads":[{"id":"120248669405960585","picture":"https://s3.amaz
 *
 * In the production session behind ENG-1054 the model was handed exactly that and
 * responded by *finishing the structure* instead of answering:
 *   - message 163: a 20,081-char verbatim echo of the tool result, plus `}}`
 *   - message 214: the closing punctuation alone — the literal two chars `}]`,
 *     which became the turn's entire user-facing answer.
 *
 * This is not a model quirk we can only catch downstream; it is a payload WE built.
 * Balancing the slice removes the invitation: the model receives valid, complete
 * JSON plus an explicit note that it is partial and where the rest lives.
 *
 * WHY THE PAYLOAD WAS CONVERSATIONAL TEXT AT ALL (the amplifier, deliberately not
 * changed here): Gemini attaches a `thoughtSignature` to only the FIRST functionCall
 * part of a multi-call turn, so every later call in that turn is unsigned. The
 * request builder (`geminiNativeClient.toGeminiRequest`) treats an unsigned call as
 * rare "legacy/compat" history and degrades its result to a user-role text part
 * (`[Result of <name>: …]`) — a fallback the comment there assumes is exceptional.
 * In the ENG-1054 session it was the MAJORITY path: 77 of 105 calls were unsigned,
 * injecting ~111 KB of raw tool JSON into the conversation as prose. Re-signing that
 * history would 400 every Gemini turn if wrong, so it is left alone; balancing the
 * payload fixes the failure without touching signature semantics.
 */

/** Appended so the model knows the payload is partial and must not be completed. */
export const TRUNCATION_NOTICE = '[Content truncated — full response in S3]';

/**
 * How many times we rewind to an earlier boundary looking for a slice that closes
 * into valid JSON. Each rewind is cheap and strictly shortens the body; the cap is
 * only a backstop against a pathological payload (e.g. a long string value full of
 * commas), where we fall back to emitting the slice untouched.
 */
const MAX_REWINDS = 50;

/**
 * Walk `text` as JSON and report the stack of unclosed `{` / `[` in order.
 *
 * Returns null when `text` is not JSON-shaped (its first non-space char is neither
 * `{` nor `[`) — plain-text payloads have nothing to balance and are left untouched.
 */
function scanOpenStructure(text: string): { stack: string[] } | null {
  const firstChar = text.trimStart()[0];
  if (firstChar !== '{' && firstChar !== '[') return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      // A backslash escapes the next char — including a quote, which would
      // otherwise be read as closing the string.
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  return { stack };
}

/**
 * Append the closers `body` still needs, or null if `body` is not JSON-shaped.
 * Any trailing `,` or `:` is dropped first — either would make the result invalid.
 */
function closeOpenStructures(body: string): string | null {
  const trimmed = body.replace(/[,:]\s*$/, '');
  const open = scanOpenStructure(trimmed);
  if (!open) return null;
  const closers = open.stack
    .slice()
    .reverse()
    .map((c) => (c === '{' ? '}' : ']'))
    .join('');
  return trimmed + closers;
}

/** Index of the last structural boundary we can safely rewind to, or -1. */
function lastBoundary(body: string): number {
  return Math.max(body.lastIndexOf(','), body.lastIndexOf('{'), body.lastIndexOf('['));
}

/**
 * Close whatever `slice` left open so the payload reads as complete JSON, then
 * append the truncation notice.
 *
 * The result is PARSE-VERIFIED: closing brackets alone is not enough, because a cut
 * can land somewhere no set of closers can rescue — mid-string (the ENG-1054 slice
 * ended inside a Google Storage URL) or after a key with no value (`{"a":1,"b":`).
 * So we close, try to parse, and on failure rewind to the previous boundary and try
 * again. That also gives the property we want for a mangled value: it is DROPPED
 * rather than silently completed, so the model never sees a half-URL that looks whole.
 *
 * Non-JSON payloads, and anything still unparseable after `MAX_REWINDS`, get the
 * notice appended and are otherwise left exactly as they are — never worse than the
 * bare substring this replaced.
 */
export function sealTruncatedPayload(slice: string): string {
  const withNotice = (body: string) => `${body}\n\n${TRUNCATION_NOTICE}`;
  if (scanOpenStructure(slice) === null) return withNotice(slice);

  let body = slice;
  for (let attempt = 0; attempt < MAX_REWINDS; attempt++) {
    const candidate = closeOpenStructures(body);
    if (candidate !== null) {
      try {
        JSON.parse(candidate);
        return withNotice(candidate);
      } catch {
        // fall through and rewind
      }
    }
    const cut = lastBoundary(body);
    if (cut <= 0) break;
    // Cut BEFORE the boundary char so a rewind onto `{`/`[` drops the empty
    // container instead of closing it into a junk `{}` entry.
    body = body.slice(0, cut);
  }

  return withNotice(slice);
}
