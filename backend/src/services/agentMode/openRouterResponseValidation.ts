/**
 * ENG-1681: pure helpers for validating an OpenRouter chat-completion response and
 * deciding whether a call failure is worth one retry.
 *
 * Kept out of agentModeService for the same reason as the sibling openRouterMetadata.ts
 * and the googleAds* helpers in utils/: these are rules that should be provable without
 * a network boundary, and this repo's own path instructions flag any change that grows
 * the monolith instead of extracting pure logic here.
 *
 * Context: generateMarketingResponse threw a generic "I apologize, but I encountered
 * an error processing your request" on the same customer session 8 times over 9 days,
 * across 4 distinct OpenRouter failure signatures, with no fix ever landing despite
 * being routed to autofix on day one. Two of the four were never retried at all:
 *   - The SDK's own response-body JSON parse failing ("invalid json response body ...
 *     Unexpected end of JSON input").
 *   - A 200 response with no `choices` array, which the unguarded
 *     `response.choices[0].message` at the call site turned into a bare
 *     "Cannot read properties of undefined (reading '0')" -- no signal that the cause
 *     was an upstream response shape, not a caller bug.
 * Both are one-off provider glitches in practice -- a fresh request against the same
 * model very often just works.
 */

export const MALFORMED_OPENROUTER_RESPONSE_PREFIX = 'MALFORMED_OPENROUTER_RESPONSE';

/**
 * Throws when `res` is missing a `choices` array entirely.
 *
 * Checked as "is this an array", not "is it non-empty": an empty `choices: []` is a
 * separate, already-handled case elsewhere in the caller, and this check must not fire
 * on it -- doing so would retry every real call and every one of the many tests that
 * already treat an empty array as a legitimate (if unhelpful) response.
 */
export function assertOpenRouterResponseHasChoices(res: unknown, model: string): void {
  if (!Array.isArray((res as any)?.choices)) {
    throw new Error(
      `${MALFORMED_OPENROUTER_RESPONSE_PREFIX}: model "${model}" returned a response with no choices array `
      + `(the provider likely returned an empty/degenerate completion).`,
    );
  }
}

/**
 * ENG-2720: throws on a 200 that carries no answer (`finish_reason: "error"`, or no text and no
 * tool calls). Opt-in via `requireContent`: for a caller that needs text, this is a failed call, but
 * left alone it becomes an empty string that reads downstream as "nothing found".
 */
export function assertOpenRouterResponseHasContent(res: unknown, model: string): void {
  const choice = (res as any)?.choices?.[0];
  const hasToolCalls = Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0;
  if (choice?.finish_reason === 'error' || (!choice?.message?.content && !hasToolCalls)) {
    throw new Error(
      `${MALFORMED_OPENROUTER_RESPONSE_PREFIX}: model "${model}" returned no content `
      + `(finish_reason: ${choice?.finish_reason ?? 'none'}, provider: ${(res as any)?.provider ?? 'unknown'}).`,
    );
  }
}

/**
 * Message-pattern check for the two malformed/empty-response failure classes above.
 *
 * Deliberately NOT folded into the shared `classifyToolErrorClass` taxonomy: that
 * classifier is used far more broadly than LLM calls, and a 400 or 404 must stay
 * non-retryable there for other tools -- this is scoped to exactly the two
 * OpenRouter-specific signatures this module documents.
 */
export function isMalformedOpenRouterResponseError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return /invalid json response body|unexpected end of json input|malformed_openrouter_response/.test(message);
}
