/**
 * ENG-2103 (F2) — shared, stateless HTML-escaping helpers.
 *
 * Extracted verbatim from `AgentModeService`'s `private static escapeHtml/
 * unescapeHtml/deepEscapeHtmlValues/escapeRegExp/collectRawToEscapedMap`
 * methods. All five are pure functions of their arguments.
 *
 * Shared by two call sites: `emma/impl/googleDocsSheets.ts`'s markdown-to-HTML
 * pipeline (this extraction) and `AgentModeService.prototype.createHtmlFromTemplate`
 * (a different, not-yet-extracted "HTML/landing pages" cluster).
 * `AgentModeService`'s own copies now delegate here so both share one
 * implementation.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Decodes the 5 entities `escapeHtml` produces, back to their plain characters. Order
 * matters: `&amp;` must be decoded LAST, since decoding it first would turn a literal
 * `&amp;lt;` (an already-escaped `&lt;` that was itself escaped again) into `&lt;`,
 * silently re-introducing a markup-meaningful character into a plain-text field.
 */
export function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Escapes every string leaf of an arbitrarily-nested value while preserving its
 * structure — unlike `String(value)`, which collapses an object/array to
 * "[object Object]" and turns `null`/`undefined` into the literal text "null"/
 * "undefined". Needed because caller-supplied template variable values are not
 * contractually flat strings (existing callers pass array-of-object items), and
 * this feeds `JSON.stringify` afterward, which already renders `null`/numbers/
 * booleans correctly on its own — only string leaves need escaping.
 */
export function deepEscapeHtmlValues(value: any): any {
  if (typeof value === 'string') return escapeHtml(value);
  if (Array.isArray(value)) return value.map((v) => deepEscapeHtmlValues(v));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, deepEscapeHtmlValues(v)])
    );
  }
  return value;
}

/** Escapes every regex metacharacter so a value can be used as a literal match. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Collects every string leaf (however deeply nested) that contains a raw `<` or `>`,
 * mapped to its escaped form — so the LLM's OUTPUT can be corrected if it decoded
 * either back to raw HTML. Escaping the PROMPT proves nothing about the RESPONSE:
 * substitution is LLM-driven, not a deterministic string-replace, so nothing
 * guarantees the model reproduces an escaped entity as-is rather than "cleaning up"
 * what looks like a stray HTML entity mid-generation.
 *
 * Deliberately narrower than the 5-character escape set (& < > " ') applied on the way
 * IN: `<`/`>` can construct a genuinely new element regardless of surrounding markup,
 * so a raw one resurfacing is unambiguously dangerous. `&`, `"`, and `'` alone cannot —
 * they only matter for breaking out of an ALREADY-quoted attribute using that exact
 * quote character, a narrower, template-structure-dependent risk the live template
 * doesn't even have today (text-node placeholders only). Including them here caused a
 * real false-positive class: an ordinary apostrophe in a real name ("O'Brien's Q3")
 * could trip this check if that short substring coincidentally reappeared anywhere
 * else in the output, failing a legitimate report for no real security benefit.
 */
export function collectRawToEscapedMap(value: any, out: Map<string, string>): void {
  if (typeof value === 'string') {
    if (/[<>]/.test(value)) out.set(value, escapeHtml(value));
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectRawToEscapedMap(v, out));
  } else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((v) => collectRawToEscapedMap(v, out));
  }
}
