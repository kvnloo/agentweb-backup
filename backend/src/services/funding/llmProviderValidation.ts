/**
 * ENG-2105 (A1): checks a customer's provider key against the provider itself, with
 * the cheapest authenticated read each one offers (listing models). The outcome is a
 * fixed set of values; a provider's own error text is never returned or logged, since
 * some providers echo part of the key in it.
 */

export const SUPPORTED_BYOK_PROVIDERS = ["anthropic", "openai", "google"] as const;
export type ByokProvider = (typeof SUPPORTED_BYOK_PROVIDERS)[number];

export function isSupportedByokProvider(value: unknown): value is ByokProvider {
  return typeof value === "string" && (SUPPORTED_BYOK_PROVIDERS as readonly string[]).includes(value);
}

export type KeyCheckResult =
  | "ok"
  /** The provider accepted the key but is throttling it right now. The key is good. */
  | "rate_limited"
  | "invalid_key"
  | "insufficient_permissions"
  | "quota_exhausted"
  | "provider_unreachable"
  | "unknown";

/** Results that mean the provider recognised the key as a working credential. */
export function keyCheckAccepted(result: KeyCheckResult): boolean {
  return result === "ok" || result === "rate_limited";
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

const TIMEOUT_MS = 8_000;

const REQUESTS: Record<ByokProvider, (key: string) => { url: string; headers: Record<string, string> }> = {
  anthropic: (key) => ({
    url: "https://api.anthropic.com/v1/models?limit=1",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  }),
  openai: (key) => ({ url: "https://api.openai.com/v1/models", headers: { Authorization: `Bearer ${key}` } }),
  // Header, not the documented ?key= query parameter: a URL ends up in access logs.
  google: (key) => ({
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
    headers: { "x-goog-api-key": key },
  }),
};

function classify(provider: ByokProvider, status: number, body: string): KeyCheckResult {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401) return "invalid_key";
  if (status === 400 && provider === "google" && /API_KEY_INVALID|API key not valid/i.test(body)) return "invalid_key";
  if (status === 403) {
    return provider === "google" && /API_KEY_INVALID|API key not valid/i.test(body) ? "invalid_key" : "insufficient_permissions";
  }
  if (status === 402) return "quota_exhausted";
  if (status === 429) return /insufficient_quota|billing|credit balance|exceeded your current quota/i.test(body) ? "quota_exhausted" : "rate_limited";
  if (status >= 500) return "provider_unreachable";
  return "unknown";
}

export async function validateProviderKey(
  provider: ByokProvider,
  apiKey: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<KeyCheckResult> {
  const request = REQUESTS[provider](apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(request.url, { method: "GET", headers: request.headers, signal: controller.signal });
    let body = "";
    try {
      body = (await response.text()).slice(0, 4_000);
    } catch {
      // the status alone decides
    }
    return classify(provider, response.status, body);
  } catch {
    // Network failure or timeout. Deliberately no detail: the error can carry request headers.
    return "provider_unreachable";
  } finally {
    clearTimeout(timer);
  }
}
