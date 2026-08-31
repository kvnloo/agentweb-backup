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
 * `{`/`}`/`[`/`]` inside string content (e.g. inline CSS in HTML) never
 * touches it. Once inside a string, an unescaped quote is treated as the
 * real terminator when:
 *   - what follows (after whitespace) is `:`, `}`, `]`, or end-of-input, or
 *   - what follows is `,` AND the current container is an array (any
 *     element boundary is plausible), or
 *   - what follows is `,` AND the current container is an object AND the
 *     text after that comma actually looks like the next property —
 *     `"key":` — rather than arbitrary trailing content.
 *
 * That last condition is what a plain "quote then comma" lookahead gets
 * wrong: a comma-separated CSS `font-family:"Arial",sans-serif` list or an
 * unescaped JS/JSON array literal embedded in an object's string value also
 * has a quote immediately followed by a comma, but nothing resembling a new
 * property follows it — so it must stay part of the string. Anything else
 * is a literal quote the model failed to escape, kept in place with `\"`.
 * This is a pure, best-effort transform — the caller re-parses the result
 * and only relies on the repair when it actually produces valid JSON (see
 * `parseToolCallArguments`).
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
      if (next === undefined || next === ':' || next === '}' || next === ']') {
        isTerminal = true;
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
 * Parse a tool call's raw `arguments` string, falling back to
 * `repairUnescapedQuotes` when the direct parse fails. Throws the ORIGINAL
 * `JSON.parse` error (preserving today's message/position for logging) when
 * neither the raw text nor the repaired text parses.
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
        // Repair didn't help — fall through to the original error below.
      }
    }
    throw primaryError;
  }
}
