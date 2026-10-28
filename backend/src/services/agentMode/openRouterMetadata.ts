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
  const endpoints = openrouterMetadata?.endpoints;
  // Documented shape is `endpoints.available[]` with the winning candidate
  // flagged `selected: true`; `endpoints.selected` (a bare object) is kept as
  // a legacy fallback in case an older/alternate response shape uses it.
  const fromAvailable = Array.isArray(endpoints?.available)
    ? endpoints.available.find((candidate: any) => candidate?.selected === true)
    : undefined;
  const selected = fromAvailable ?? endpoints?.selected ?? endpoints;
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

/** Max chars of the upstream provider body kept in a log line. */
export const UPSTREAM_ERROR_LOG_MAX_CHARS = 500;

/**
 * Normalize the resolved provider/is_byok slot off a thrown OpenRouter error, when present.
 *
 * ENG-2721: an OpenRouter "400 Provider returned error" carries the real upstream
 * reason only in the ErrorResponse's `metadata = { provider_name, raw }`, which is
 * top-level, not under `endpoints`. Before this, the failure log printed
 * `provider: undefined` and dropped `raw`, so a mid-run 400 left no root cause in
 * the logs. `upstream_error` is bounded so a large provider body cannot flood logs.
 */
export function normalizeOpenRouterErrorMetadata(
  error: any,
): OpenRouterMetadataSlot & { upstream_error?: string } {
  const metadata = error?.metadata ?? error?.error?.metadata;
  const provider = extractProvider(metadata?.openrouter_metadata ?? metadata)
    ?? (typeof metadata?.provider_name === 'string' ? metadata.provider_name : undefined);
  const raw = metadata?.raw;
  let upstreamError: string | undefined;
  if (typeof raw === 'string' && raw.length > 0) {
    upstreamError = raw;
  } else if (raw !== undefined && raw !== null) {
    try { upstreamError = JSON.stringify(raw); } catch { upstreamError = String(raw); }
  }
  return {
    provider,
    is_byok: typeof metadata?.is_byok === 'boolean' ? metadata.is_byok : undefined,
    ...(upstreamError ? { upstream_error: upstreamError.slice(0, UPSTREAM_ERROR_LOG_MAX_CHARS) } : {}),
  };
}

/**
 * ENG-1345: map OpenRouter's served `model` back to the logical model id in
 * the requested chain (primary followed by `fallbackModels`), so metering
 * attributes a served fallback to the fallback rather than the primary.
 *
 * Returns undefined when the response names no model or a model outside the
 * chain; callers keep the primary in that case, so primary-path metering is
 * unchanged. OpenRouter may answer with a dated variant
 * (`vendor/model-20260901`), which matches its chain entry by prefix; the
 * longest matching upstream id wins so `x-pro` never resolves to `x`.
 */
export function resolveServedChainModel(
  servedModel: unknown,
  chain: ReadonlyArray<{ modelId: string; upstreamModel: string }>,
): string | undefined {
  if (typeof servedModel !== 'string' || !servedModel) return undefined;
  const served = servedModel.toLowerCase();
  let best: { modelId: string; len: number } | undefined;
  for (const { modelId, upstreamModel } of chain) {
    const up = upstreamModel.toLowerCase();
    if (served === up || served.startsWith(`${up}-`) || served.startsWith(`${up}:`)) {
      if (!best || up.length > best.len) best = { modelId, len: up.length };
    }
  }
  return best?.modelId;
}
