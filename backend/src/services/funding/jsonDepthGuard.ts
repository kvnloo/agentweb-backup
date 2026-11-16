/**
 * ENG-2113: a cheap pre-parse guard against a hostile worker's deeply nested JSON. `JSON.parse` on 8 MB of "[" takes seconds on the API server's one event
 * loop (4M deep: 0.9 s, 8M deep: 2.7 s) and the worker can repeat it. Nothing the worker legitimately sends nests anywhere near MAX_JSON_DEPTH (events and
 * replies are flat objects; a tool call's arguments are a few levels), so a line deeper than that is dropped WITHOUT being parsed.
 *
 * One iterative O(n) scan, no recursion, no allocation per character: it tracks the depth of "[" and "{", skipping string contents and escapes (so brackets
 * inside strings do not count), and stops at the first position that exceeds the limit. UTF-8 multi-byte sequences never contain the ASCII bytes it looks at.
 */
export const MAX_JSON_DEPTH = 64;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACKET = 0x5b;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACKET = 0x5d;
const CLOSE_BRACE = 0x7d;

/** True when the JSON text nests deeper than `limit`. Never throws; not a validator (malformed text is left to JSON.parse). */
export function jsonTooDeep(text: string | Buffer, limit: number = MAX_JSON_DEPTH): boolean {
  let depth = 0;
  let inString = false;
  const n = text.length;
  if (typeof text === "string") {
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);
      if (inString) {
        if (c === BACKSLASH) i++;
        else if (c === QUOTE) inString = false;
      } else if (c === QUOTE) inString = true;
      else if (c === OPEN_BRACKET || c === OPEN_BRACE) {
        if (++depth > limit) return true;
      } else if ((c === CLOSE_BRACKET || c === CLOSE_BRACE) && depth > 0) depth--;
    }
    return false;
  }
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (inString) {
      if (c === BACKSLASH) i++;
      else if (c === QUOTE) inString = false;
    } else if (c === QUOTE) inString = true;
    else if (c === OPEN_BRACKET || c === OPEN_BRACE) {
      if (++depth > limit) return true;
    } else if ((c === CLOSE_BRACKET || c === CLOSE_BRACE) && depth > 0) depth--;
  }
  return false;
}

/** The deepest nesting of the text (statistics and tests; stops counting at `cap`). */
export function jsonDepth(text: string, cap: number = 10_000): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === BACKSLASH) i++;
      else if (c === QUOTE) inString = false;
    } else if (c === QUOTE) inString = true;
    else if (c === OPEN_BRACKET || c === OPEN_BRACE) {
      if (++depth > max) max = depth;
      if (max >= cap) return max;
    } else if ((c === CLOSE_BRACKET || c === CLOSE_BRACE) && depth > 0) depth--;
  }
  return max;
}
