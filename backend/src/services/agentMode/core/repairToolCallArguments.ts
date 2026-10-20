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
 * confused/malformed text? A plain bracket-depth counter (ignoring type) is
 * not enough: a lone stray `}`, or a `{`/`[` closed with the wrong bracket
 * type, can bring depth back to a "balanced" 0/nonzero reading that has
 * nothing to do with whether the stream was cut off — neither can ever
 * become valid JSON by appending more bytes, so classifying either as
 * "truncated" tells the model to retry an identical call that will fail
 * again the same way (CodeRabbit review on this PR).
 *
 * This instead tracks a stack of the actual container TYPE opened (mirroring
 * `repairUnescapedQuotes`/`hasDuplicateObjectKeys`), and returns false the
 * moment a closer shows up with no matching opener of the right type on top
 * of the stack — that is definitive, immediate evidence of malformed (not
 * merely incomplete) input, not something that can complete by appending
 * more bytes. It also rejects a `:` immediately followed (past whitespace)
 * by a structural terminator (`,` `}` `]`) with no value token in between —
 * a missing value is a genuine syntax error, not a stream that stopped
 * before the value started (that case has no terminator there at all; the
 * text just ends). Whatever remains after ruling those out — still inside an
 * open string, or inside an object/array whose container was never closed —
 * is strong, low-false-positive evidence the stream stopped mid-generation
 * rather than the model emitting genuinely invalid JSON.
 */
export function isTruncatedJsonPrefix(raw: string): boolean {
  let inString = false;
  let escaped = false;
  const stack: JsonContainer[] = [];
  const n = raw.length;

  for (let i = 0; i < n; i++) {
    const ch = raw[i];

    if (!inString) {
      if (ch === '"') {
        inString = true;
      } else if (ch === '{' || ch === '[') {
        stack.push(ch === '{' ? 'object' : 'array');
      } else if (ch === '}' || ch === ']') {
        const wantsObject = ch === '}';
        const top = stack.pop();
        if (top === undefined || (wantsObject ? top !== 'object' : top !== 'array')) {
          return false;
        }
      } else if (ch === ':') {
        const j = nextNonSpaceIndex(raw, i + 1);
        if (j < n && (raw[j] === ',' || raw[j] === '}' || raw[j] === ']')) {
          return false;
        }
      }
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

  return inString || stack.length !== 0;
}

/**
 * SECURITY (ENG-1477 review): does `text` — assumed already well-formed JSON,
 * i.e. every unescaped `"` is a genuine string boundary — contain the same
 * key twice within any single object? `repairUnescapedQuotes`'s comma
 * heuristic decides a quote is a real string terminator whenever what follows
 * merely LOOKS LIKE the next property (`"key":`). That shape check can't tell
 * a legitimate next property from untrusted echoed content (e.g. scraped
 * HTML/text in `content_draft`) that happens to contain the same lookalike
 * text — so content crafted as `...", "title":"HACKED"` inside a string value
 * gets split into real structure, and `JSON.parse` silently keeps the LAST
 * occurrence of a duplicate key, overwriting a legitimate argument (verified:
 * `title` gets clobbered this way with no error at all).
 *
 * A well-formed tool-call arguments object never legitimately repeats a key
 * within the same object — schemas define each property once. So a duplicate
 * key surviving into the repaired-and-reparsed result is proof the heuristic
 * mis-fired and turned string content into fake structure, not a case to
 * silently accept. This walks the repaired text as a strict tokenizer (no
 * heuristics needed here — repair already resolved every ambiguous quote),
 * tracking one key-set per open object, and returns true on the first key
 * seen twice in the same object.
 *
 * SECURITY (CodeRabbit review on this PR): comparing/storing the tokenizer
 * SPELLING of a key — not its decoded JSON value — let an attacker dodge the
 * duplicate check entirely. A key spelled with a unicode escape for one of
 * its letters (so the raw text differs from a plain-ASCII spelling of the
 * same property, e.g. an escaped 'l' inside "title") decodes to the exact
 * same string once JSON.parse runs — but the old code compared the raw,
 * still-escaped tokenizer text against the plain spelling and saw no match,
 * so the duplicate slipped through. `decodeJsonEscape` below performs the
 * same escape decoding JSON.parse itself does (quote, backslash, slash, and
 * the b/f/n/r/t/u control escapes) before a string is added to or checked
 * against a container's key set, so an escaped and unescaped spelling of
 * the same property name are correctly recognized as the same key.
 */
function decodeJsonEscape(text: string, backslashIndex: number): { decoded: string; consumed: number } {
  const ch = text[backslashIndex + 1];
  switch (ch) {
    case '"': return { decoded: '"', consumed: 1 };
    case '\\': return { decoded: '\\', consumed: 1 };
    case '/': return { decoded: '/', consumed: 1 };
    case 'b': return { decoded: '\b', consumed: 1 };
    case 'f': return { decoded: '\f', consumed: 1 };
    case 'n': return { decoded: '\n', consumed: 1 };
    case 'r': return { decoded: '\r', consumed: 1 };
    case 't': return { decoded: '\t', consumed: 1 };
    case 'u': {
      const hex = text.slice(backslashIndex + 2, backslashIndex + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        return { decoded: String.fromCharCode(parseInt(hex, 16)), consumed: 5 };
      }
      // Malformed \u escape — keep it as literal text. Only reachable for
      // input that will fail JSON.parse anyway; never throw from here.
      return { decoded: 'u' + hex, consumed: 1 + hex.length };
    }
    default:
      // Not a recognized JSON escape — keep the character as-is rather than
      // throwing, matching this function's best-effort, never-throw contract.
      return { decoded: ch ?? '', consumed: ch === undefined ? 0 : 1 };
  }
}

export function hasDuplicateObjectKeys(text: string): boolean {
  let inString = false;
  let stringContent = '';
  const containerStack: JsonContainer[] = [];
  const keySetStack: Set<string>[] = [];
  const n = text.length;

  for (let i = 0; i < n; i++) {
    const ch = text[i];

    if (!inString) {
      if (ch === '"') {
        inString = true;
        stringContent = '';
      } else if (ch === '{') {
        containerStack.push('object');
        keySetStack.push(new Set());
      } else if (ch === '[') {
        containerStack.push('array');
      } else if (ch === '}' || ch === ']') {
        const closed = containerStack.pop();
        if (closed === 'object') keySetStack.pop();
      }
      continue;
    }

    if (ch === '\\') {
      const { decoded, consumed } = decodeJsonEscape(text, i);
      stringContent += decoded;
      i += consumed;
      continue;
    }
    if (ch === '"') {
      inString = false;
      // A string immediately followed by `:` while directly inside an object
      // is unambiguously a key — a JSON value is never followed by `:`.
      const j = nextNonSpaceIndex(text, i + 1);
      const isKeyPosition = containerStack[containerStack.length - 1] === 'object'
        && j < n && text[j] === ':';
      if (isKeyPosition) {
        const keys = keySetStack[keySetStack.length - 1];
        if (keys.has(stringContent)) return true;
        keys.add(stringContent);
      }
      continue;
    }
    stringContent += ch;
  }

  return false;
}

/**
 * Parse a tool call's raw `arguments` string, falling back to
 * `repairUnescapedQuotes` when the direct parse fails. If neither the raw
 * text nor the repaired text parses, and the raw text is a clean JSON prefix
 * that simply never finished (see `isTruncatedJsonPrefix`), throws
 * `TruncatedToolCallArgumentsError` instead — otherwise throws the ORIGINAL
 * `JSON.parse` error (preserving today's message/position for logging).
 *
 * A repaired text that parses cleanly but contains a duplicate object key
 * (see `hasDuplicateObjectKeys`) is treated the same as a repair that didn't
 * help at all — the injected/overwritten result is never returned.
 */
export function parseToolCallArguments(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch (primaryError) {
    const deduped = parseDuplicatedJsonObjects(raw);
    if (deduped !== undefined) return deduped;
    const repaired = repairUnescapedQuotes(raw);
    if (repaired !== raw && !hasDuplicateObjectKeys(repaired)) {
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

/**
 * ENG-2597: the provider stream sometimes delivers a tool call's arguments
 * twice, back to back (`{}{}`, `{"a":1}{"a":1}`), which JSON.parse rejects
 * with "Unexpected non-whitespace character after JSON at position N".
 * When `raw` splits into two or more top-level objects that are all
 * identical, return that single object. Differing objects return undefined
 * (the caller throws) so we never guess which call the model meant.
 */
export function parseDuplicatedJsonObjects(raw: string): unknown {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (depth === 0) {
      if (/\s/.test(ch)) continue;
      if (ch !== '{') return undefined;
      start = i;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth < 0) return undefined;
      if (depth === 0) parts.push(raw.slice(start, i + 1));
    }
  }
  if (depth !== 0 || inString || parts.length < 2) return undefined;
  // Compare the RAW text, not parsed values: JSON.parse rounds integers past
  // 2^53, so two calls differing only in a long numeric id would otherwise
  // look identical and collapse into one call with a rounded id (Opslane P2).
  // The observed stream bug duplicates bytes exactly, so exact text equality
  // is all we need.
  if (!parts.every((p) => p === parts[0])) return undefined;
  try {
    return JSON.parse(parts[0]);
  } catch {
    return undefined;
  }
}

/**
 * ENG-2597: if `toolCall.function.arguments` is not itself valid JSON but was
 * successfully parsed (via repair) into `parsedArgs`, overwrite it with the
 * re-serialized repaired object. The same toolCall object lives on the
 * assistant message saved to chat history, so the next turn replays one valid
 * object instead of the malformed provider text. Valid JSON is left untouched.
 */
export function normalizeRepairedToolCallArguments(
  toolCall: { function?: { arguments?: unknown } } | undefined,
  parsedArgs: unknown,
): void {
  const fn = toolCall?.function;
  if (!fn || typeof fn.arguments !== 'string') return;
  try {
    JSON.parse(fn.arguments);
    return;
  } catch {
    fn.arguments = JSON.stringify(parsedArgs);
  }
}
