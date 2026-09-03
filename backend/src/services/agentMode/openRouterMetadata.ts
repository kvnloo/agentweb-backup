/**
 * ENG-1712: pure helpers for the resolved OpenRouter provider/is_byok slot.
 *
 * OpenRouter only returns this data when a request opts in via the
 * `X-OpenRouter-Metadata: enabled` header (see getOpenRouterClient), and even
 * then it is nested under `openrouter_metadata.endpoints` / `usage.is_byok`
 * on the response (or `metadata` on an ErrorResponse), not top-level
 * `res.provider` / `error.provider`. Centralized here so the success,
 * retry-warning, and final-failure logs stay in sync with the documented
 * shape instead of drifting independently.
 */

interface OpenRouterMetadataSlot {
  provider: string | undefined;
  is_byok: boolean | undefined;
}

function extractProvider(openrouterMetadata: any): string | undefined {
  const selected = openrouterMetadata?.endpoints?.selected ?? openrouterMetadata?.endpoints;
  const providerName = selected?.provider_name ?? selected?.provider;
  return typeof providerName === 'string' ? providerName : undefined;
}

/** Normalize the resolved provider/is_byok slot off a successful chat completion response. */
export function normalizeOpenRouterResponseMetadata(res: any): OpenRouterMetadataSlot {
  const openrouterMetadata = res?.openrouter_metadata;
  return {
    provider: extractProvider(openrouterMetadata),
    is_byok: typeof openrouterMetadata?.is_byok === 'boolean'
      ? openrouterMetadata.is_byok
      : (typeof res?.usage?.is_byok === 'boolean' ? res.usage.is_byok : undefined),
  };
}

/** Normalize the resolved provider/is_byok slot off a thrown OpenRouter error, when present. */
export function normalizeOpenRouterErrorMetadata(error: any): OpenRouterMetadataSlot {
  const metadata = error?.metadata ?? error?.error?.metadata;
  return {
    provider: extractProvider(metadata?.openrouter_metadata ?? metadata),
    is_byok: typeof metadata?.is_byok === 'boolean' ? metadata.is_byok : undefined,
  };
}
