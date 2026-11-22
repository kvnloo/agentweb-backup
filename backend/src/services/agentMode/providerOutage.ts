/**
 * ENG-2381: decide whether an error caught by generateMarketingResponse is a final
 * upstream 5xx from the LLM provider (OpenRouter/OpenAI client or Bedrock runtime),
 * as opposed to an internal failure (session, skill, settings, DynamoDB) that happens
 * to carry a 5xx status. Only the former may be labelled PROVIDER_UNAVAILABLE; the
 * latter must keep the unknown-error alert so it pages.
 *
 * Pure: no imports from the service graph.
 */

/** Bedrock runtime exception names that represent a provider-side outage. */
const BEDROCK_OUTAGE_NAMES = new Set([
  'ServiceUnavailableException',
  'InternalServerException',
  'ModelNotReadyException',
  'ModelErrorException',
]);

/** OpenAI/OpenRouter SDK error classes for 5xx responses. */
const OPENAI_SDK_5XX_NAMES = new Set(['InternalServerError', 'APIError']);

/** OpenRouter's own wording for a provider-side failure after its failover. */
const PROVIDER_MESSAGE_PATTERN = /provider returned error|upstream (provider|model).*(error|unavailable)/i;

function statusOf(e: any): number | undefined {
  const s = e?.status ?? e?.$metadata?.httpStatusCode;
  return typeof s === 'number' ? s : undefined;
}

function textOf(e: any): string {
  return [e?.message, e?.originalMessage, e?.originalError?.message]
    .filter((p): p is string => typeof p === 'string')
    .join(' ');
}

export function isLLMProviderOutage(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as any;
  const status = statusOf(e);
  const is5xx = status !== undefined && status >= 500 && status < 600;

  // Bedrock runtime: provider-specific exception names (DynamoDB uses different names,
  // e.g. "InternalServerError", so a DynamoDB 5xx does not match here).
  if (BEDROCK_OUTAGE_NAMES.has(e.name)) return true;

  // OpenAI/OpenRouter SDK APIError: carries response `headers` alongside the status.
  const ctorName = e.constructor?.name ?? '';
  const isOpenAIError = (OPENAI_SDK_5XX_NAMES.has(ctorName) || OPENAI_SDK_5XX_NAMES.has(e.name))
    && e.headers !== undefined;
  if (is5xx && isOpenAIError) return true;

  // OpenRouter's explicit provider-failure text (also preserved on wrapped errors).
  if (PROVIDER_MESSAGE_PATTERN.test(textOf(e))) return true;

  return false;
}
