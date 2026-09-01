/**
 * PURE helper: recover a tool-call `arguments` JSON string that contains an
 * unescaped double quote inside a string value (ENG-1477).
 *
 * Observed in production: create_html_file / save_file calls carrying a large
 * or quote-rich string value (report titles with a quoted phrase, HTML
 * content with `class="..."`/`href="..."` attributes) sometimes come back
 * from the model with an inner `"` that was not escaped as `\"`. JSON.parse
 * reads that quote as the string's end, then throws on whatever follows:
 *
 *     Expected ',' or '}' after property value in JSON at position N
 *
 * — exactly the error signature seen in prod logs for this session, always
 * landing right after the last property's (prematurely closed) value.
 *
 * `repairUnescapedQuotes` walks the text the way a JSON tokenizer would,
 * tracking the current container (object vs. array) via a stack that only
 * changes on structural braces/brackets seen OUTSIDE a string — a literal
 * `{`/`}`/`[`/`]` inside string content (e.g. inline CSS, or a JS/JSON
 * literal quoted in prose) never touches it. Once inside a string, an
 * unescaped quote is treated as the real terminator when:
 *   - what follows (after whitespace) is `:` or end-of-input, or
 *   - what follows is `}` AND the current container is an object (a lone
 *     `}` can only really close a value we are inside an object for), or
 *   - what follows is `]` AND the current container is an array (mirror of
 *     the `}` case), or
 *   - what follows is `,` AND the current container is an array (any
 *     element boundary is plausible), or
 *   - what follows is `,` AND the current container is an object AND the
 *     text after that comma actually looks like the next property —
 *     `"key":` — rather than arbitrary trailing content.
 *
 * The container checks on `}`/`]` are what a plain "quote immediately
 * followed by a closing bracket" lookahead gets wrong: a lone `}`/`]` right
 * after a quote is only ever REAL JSON structure when it matches the
 * container the stack says we're actually inside — a string element of an
 * array can never be legitimately followed straight by `}` (arrays close
 * with `]` first), and a string value of an object can never be legitimately
 * followed straight by `]` (objects close with `}` first). So an unescaped
 * array literal embedded in a string, ending its last quoted element right
 * before a literal `]` that is just text (`"...["a","b","c"] as the list."`),
 * no longer mis-terminates one character early just because a `]` follows —
 * requiring container === 'array' rules that out, since the string itself is
 * an object's property, not an array element. The comma case already applies
 * the same idea via a lookahead instead of a container match (a comma is
 * legitimate inside either container, so container alone can't decide it).
 * Anything that fails all of the above is a literal quote the model failed to
 * escape, kept in place with `\"`. This is a pure, best-effort transform —
 * the caller re-parses the result and only relies on the repair when it
 * actually produces valid JSON (see `parseToolCallArguments`).
 */
type JsonContainer = 'object' | 'array';

function nextNonSpaceIndex(text: string, from: number): number {
  let j = from;
  while (j < text.length && /\s/.test(text[j])) j++;
  return j;
}

const NEXT_PROPERTY_PATTERN = /^"(?:[^"\\]|\\.)*"\s*:/;

export function repairUnescapedQuotes(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  const stack: JsonContainer[] = [];
  const n = raw.length;

  for (let i = 0; i < n; i++) {
    const ch = raw[i];

    if (!inString) {
      out += ch;
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        stack.push('object');
      } else if (ch === '[') {
        stack.push('array');
      } else if (ch === '}' || ch === ']') {
        stack.pop();
      }
      continue;
    }

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      const j = nextNonSpaceIndex(raw, i + 1);
      const next = j < n ? raw[j] : undefined;
      const container = stack[stack.length - 1];

      let isTerminal: boolean;
      if (next === undefined || next === ':') {
        isTerminal = true;
      } else if (next === '}') {
        // A literal `}` right after a quote only closes a real string value when
        // we are actually inside an object at this point — an embedded, unescaped
        // object/dict literal inside string content (e.g. a JS snippet in prose)
        // can produce the same quote+`}` shape without being real JSON structure.
        isTerminal = container === 'object';
      } else if (next === ']') {
        // Mirror of the `}` case: only real inside an array. Without this, a
        // string ending in an embedded, unescaped array literal whose last
        // element is itself quoted (e.g. `"...["a","b","c"] as the list."`)
        // mis-terminates at the quote closing "c", one character before the
        // literal `]` that was actually just prose, not JSON structure.
        isTerminal = container === 'array';
      } else if (next === ',') {
        isTerminal = container === 'array'
          || NEXT_PROPERTY_PATTERN.test(raw.slice(nextNonSpaceIndex(raw, j + 1)));
      } else {
        isTerminal = false;
      }

      if (isTerminal) {
        out += ch;
        inString = false;
      } else {
        // A literal quote the model failed to escape — keep the string open.
        out += '\\"';
      }
      continue;
    }

    out += ch;
  }
  return out;
}

/**
 * A tool call's `arguments` string that isn't malformed — it's an exact,
 * clean PREFIX of a larger JSON object whose generation was cut off (ENG-1477
 * follow-up). Distinct from an unescaped-quote mistake: there is nothing to
 * "fix" in the arguments, because the arguments the model meant to send never
 * fully arrived. Confirmed against real production failures (Dev-AW-LoopEvents
 * / AW-ChatMessages, session 02ab5f5e...): every one of 7 failing
 * `create_html_file`/`save_file` calls was a syntactically-valid JSON prefix —
 * no unescaped quote anywhere — that stopped dead at the end of whatever
 * property was mid-emission (`title` or `format_requirements`), always
 * missing the required `content_draft` entirely, with no trailing comma and
 * no closing `}`. `completion_tokens` on those turns was far under the
 * output-token cap, so this is NOT the max_tokens truncation the ENG-403
 * guard (agentModeService.ts) already handles by dropping `tool_calls` when
 * `finish_reason === 'length'` — it reached here specifically because
 * whatever cut the stream short did not report `finish_reason: 'length'`.
 * Named separately from a generic parse failure so the model gets "retry the
 * same call in full" instead of ENG-124's default "don't retry, fix your
 * args" — see errorRetryability.ts / toolErrorClassifier.ts.
 */
export class TruncatedToolCallArgumentsError extends Error {
  constructor(raw: string) {
    super(
      `The arguments for this tool call were cut off before the JSON object was complete `
      + `(received ${raw.length} character(s), ending mid-object with no closing brace, or `
      + `mid-string). This looks like your previous response was interrupted, not a formatting `
      + `mistake — retry this exact tool call and emit the COMPLETE arguments object in one go, `
      + `including every required field.`,
    );
    this.name = 'TruncatedToolCallArgumentsError';
  }
}

/**
 * PURE: does `raw` look like a clean-but-incomplete JSON prefix rather than
 * confused/malformed text? Walks the string the same way `repairUnescapedQuotes`
 * does (string/escape state + bracket depth, ignoring brackets seen inside a
 * string) and checks whether we're still inside an open string or an open
 * object/array by end-of-input. A COMPLETE JSON value always returns to depth
 * 0 with `inString` false by the time it ends; ending any other way is strong,
 * low-false-positive evidence the stream stopped mid-generation rather than
 * the model emitting genuinely invalid JSON.
 */
export function isTruncatedJsonPrefix(raw: string): boolean {
  let inString = false;
  let escaped = false;
  let depth = 0;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (!inString) {
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
      continue;
    }

    if (escaped) {
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '"') {
      inString = false;
    }
  }

  return inString || depth !== 0;
}

/**
 * Parse a tool call's raw `arguments` string, falling back to
 * `repairUnescapedQuotes` when the direct parse fails. If neither the raw
 * text nor the repaired text parses, and the raw text is a clean JSON prefix
 * that simply never finished (see `isTruncatedJsonPrefix`), throws
 * `TruncatedToolCallArgumentsError` instead — otherwise throws the ORIGINAL
 * `JSON.parse` error (preserving today's message/position for logging).
 */
export function parseToolCallArguments(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch (primaryError) {
    const repaired = repairUnescapedQuotes(raw);
    if (repaired !== raw) {
      try {
        return JSON.parse(repaired);
      } catch {
        // Repair didn't help — fall through below.
      }
    }
    if (isTruncatedJsonPrefix(raw)) {
      throw new TruncatedToolCallArgumentsError(raw);
    }
    throw primaryError;
  }
}
