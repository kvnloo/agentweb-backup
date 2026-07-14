/**
 * toolOutputContract — a minimum-output contract for tool results (ENG-105).
 *
 * `extractToolContent` applies a loose `JSON.stringify` fallback with no schema
 * check, so a tool that returns WITHOUT throwing but yields no usable payload
 * (undefined, `{}`, `{content:[]}`) was treated as a successful tool result: the
 * extracted garbage was fed back to the model as a normal tool message and the
 * call counted as success. `JSON.stringify(undefined)` even yields the literal
 * string `'undefined'`.
 *
 * This PURE validator returns an Error when a "successful" result fails the
 * minimum-output contract, so the dispatch boundary can downgrade it to a
 * structured tool failure (telemetry classifies it as `invalid_output`, distinct
 * from an execution failure). It is the same boundary pattern the repo already
 * uses for encoded-error downgrade (toolResultError) and the `empty_result`
 * errorClass — extended, not reinvented.
 *
 * Prior art: Claude Code / OpenAI agent-loop "validate tool results at the
 * boundary and return a structured tool error to the model", and the MCP
 * `isError` convention.
 */

export class ToolOutputContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolOutputContractError';
  }
}

/**
 * Validate a (already-successful) tool result against the minimum-output
 * contract. Returns a `ToolOutputContractError` when the output is unusable,
 * else null (valid — caller leaves the result untouched).
 *
 * The extractor is injected (rather than importing the 24k-line monolith's
 * `extractToolContent`) so this stays a pure, isolated unit.
 *
 * Invalid when:
 *  - result is null/undefined
 *  - result is an MCP-shaped object with no truthy `formattedContent` AND a
 *    content array whose parts all lack non-empty `.text` (incl. an empty array)
 *  - the extracted string is non-string / empty-or-whitespace / 'undefined' / '{}'
 *
 * Valid (MUST return null — behavior-preserving) for: a non-empty string, a
 * truthy `formattedContent`, `content[0].text`, AND plain data objects that
 * legitimately rely on the JSON.stringify fallback (e.g. `{leads:[...]}`), since
 * those extract to meaningful non-empty JSON.
 */
export function validateToolOutputContract(
  result: unknown,
  extract: (r: any) => string,
): Error | null {
  if (result === null || result === undefined) {
    return new ToolOutputContractError('Tool returned no output (null/undefined).');
  }

  // MCP-shaped object: a content array with NO usable part and no formattedContent
  // is empty output regardless of what JSON.stringify would produce. A "usable part"
  // is a non-blank text part OR any non-text part (image/audio/file/resource/…) —
  // those carry their own payload, so an image-only result
  // (content:[{type:'image',...}]) must NOT be downgraded just because it has no
  // .text. Only a genuinely empty array, or one whose every part is blank text,
  // counts as empty output.
  if (typeof result === 'object') {
    const obj = result as Record<string, any>;
    const hasFormatted = typeof obj.formattedContent === 'string' && obj.formattedContent.trim() !== '';
    if (!hasFormatted && Array.isArray(obj.content)) {
      const hasUsablePart = obj.content.some((part: any) => {
        if (!part || typeof part !== 'object') return false;
        // Non-text parts (image, audio, file, resource, …) are payload of their own.
        if (typeof part.type === 'string' && part.type !== 'text') return true;
        // Text parts (or untyped parts) are usable only with non-blank text.
        return typeof part.text === 'string' && part.text.trim() !== '';
      });
      if (!hasUsablePart) {
        return new ToolOutputContractError('Tool returned an empty content array (no usable text).');
      }
    }
  }

  let extracted: string;
  try {
    extracted = extract(result as any);
  } catch {
    return new ToolOutputContractError('Tool output could not be extracted.');
  }

  if (typeof extracted !== 'string') {
    return new ToolOutputContractError('Tool output is not a string.');
  }

  const trimmed = extracted.trim();
  if (trimmed === '' || trimmed === 'undefined' || trimmed === '{}') {
    return new ToolOutputContractError(`Tool produced empty or invalid output ("${trimmed}").`);
  }

  return null;
}
