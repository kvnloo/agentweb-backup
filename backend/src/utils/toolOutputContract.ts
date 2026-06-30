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

  // MCP-shaped object: a content array with no usable text and no formattedContent
  // is empty output regardless of what JSON.stringify would produce.
  if (typeof result === 'object') {
    const obj = result as Record<string, any>;
    const hasFormatted = typeof obj.formattedContent === 'string' && obj.formattedContent.trim() !== '';
    if (!hasFormatted && Array.isArray(obj.content)) {
      const hasText = obj.content.some(
        (part: any) => part && typeof part.text === 'string' && part.text.trim() !== '',
      );
      if (!hasText) {
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
