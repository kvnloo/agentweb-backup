/**
 * Defensive JSON extractor for LLM text responses.
 *
 * The onboarding pipeline (ICP → Competitor → Creative direction → Ad copy)
 * relies on Claude returning strict JSON. In practice, models occasionally
 * preface or wrap their JSON in prose ("It looks like..."), markdown code
 * fences, or both. A naked `JSON.parse` throws and cascades the entire
 * Phase 4 pipeline into failure.
 *
 * `extractJson` centralises the recovery logic so every onboarding service
 * gets the same defence:
 *   1. Strip ```json or ``` fences if present.
 *   2. Try `JSON.parse` directly on the stripped string.
 *   3. If that fails, scan for the first balanced `{...}` or `[...]` block
 *      (string-aware so braces inside string literals are ignored) and
 *      try `JSON.parse` on that slice.
 *   4. If that still fails, throw `JsonExtractError` with a truncated
 *      snippet of the raw response so callers can persist a useful debug
 *      breadcrumb.
 *
 * Pure / sync. No I/O. Safe to call from anywhere.
 */

const MAX_SNIPPET = 500;

/**
 * Thrown when no JSON value can be recovered from the input. The original
 * (truncated) raw text is preserved on the error so callers can surface it
 * in their failure-state persistence path.
 */
export class JsonExtractError extends Error {
  public readonly rawSnippet: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = "JsonExtractError";
    this.rawSnippet = (raw || "").slice(0, MAX_SNIPPET);
  }
}

/**
 * Strip a leading + trailing markdown code fence if present. Tolerant of
 * `` ```json ``, `` ```JSON ``, or bare `` ``` ``. Tolerates leading /
 * trailing whitespace.
 */
function stripFences(input: string): string {
  const trimmed = input.trim();
  // Match the entire fenced block: ```[lang]?\n ... \n```
  const fenceRe = /^```(?:[a-zA-Z0-9_-]*)?\s*\n?([\s\S]*?)\n?\s*```$/;
  const m = trimmed.match(fenceRe);
  if (m && typeof m[1] === "string") {
    return m[1].trim();
  }
  return trimmed;
}

/**
 * Scan `text` for the first balanced JSON value (`{...}` or `[...]`). The
 * scanner is string-literal aware: braces / brackets inside a `"..."`
 * string do not count toward the depth. Returns the matched substring or
 * `null` if no balanced block exists.
 */
function findFirstBalancedJsonBlock(text: string): string | null {
  // Find the first { or [
  let start = -1;
  let openChar = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{" || c === "[") {
      start = i;
      openChar = c;
      break;
    }
  }
  if (start === -1) return null;

  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === openChar) {
      depth++;
    } else if (c === closeChar) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Best-effort extract a JSON value from `raw`. See module docs for the
 * recovery layers. Throws `JsonExtractError` if nothing parseable is
 * recoverable.
 */
export function extractJson<T = unknown>(raw: string): T {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new JsonExtractError("empty LLM response", raw || "");
  }
  const stripped = stripFences(raw);

  // Layer 1 — direct parse on stripped text
  try {
    return JSON.parse(stripped) as T;
  } catch {
    // fall through
  }

  // Layer 2 — balanced-block scan
  const block = findFirstBalancedJsonBlock(stripped);
  if (block) {
    try {
      return JSON.parse(block) as T;
    } catch {
      // fall through to layer 3
    }
  }

  // Layer 3 — repair common malformed JSON: trailing commas before } or ]
  const candidate = block ?? stripped;
  const repaired = candidate.replace(/,(\s*[}\]])/g, "$1");
  if (repaired !== candidate) {
    try {
      return JSON.parse(repaired) as T;
    } catch {
      // fall through to error
    }
  }

  throw new JsonExtractError(
    "could not extract JSON from LLM response",
    raw,
  );
}
