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
 * `repairUnescapedQuotes` walks the text the way a JSON tokenizer would. Once
 * inside a string, an unescaped quote is only treated as the real terminator
 * when what follows (after skipping whitespace) is a structural JSON
 * character (`,` `:` `}` `]`) or end-of-input; otherwise it is escaped in
 * place and the string keeps going. This is a pure, best-effort transform —
 * the caller re-parses the result and only relies on the repair when it
 * actually produces valid JSON (see `parseToolCallArguments`).
 */
export function repairUnescapedQuotes(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  const n = raw.length;
  for (let i = 0; i < n; i++) {
    const ch = raw[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
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
      let j = i + 1;
      while (j < n && /\s/.test(raw[j])) j++;
      const next = j < n ? raw[j] : undefined;
      if (next === undefined || next === ',' || next === ':' || next === '}' || next === ']') {
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
