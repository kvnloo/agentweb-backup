/** Google issued a token but the adwords scope was not granted. Leaf module so callers can `instanceof` it without loading the Ads service. */
export class GoogleAdsInsufficientScopesError extends Error {
  constructor(public readonly grantedScopes: string[]) {
    super('insufficient_scopes');
  }
}

/** Google Ads error codes (e.g. `NOT_ADS_USER`, `CUSTOMER_NOT_ENABLED`) carried in an axios error's response body. Never throws. */
export function googleAdsErrorCodes(error: unknown): string[] {
  const details = (error as { response?: { data?: { error?: { details?: unknown } } } } | null)?.response?.data?.error?.details;
  if (!Array.isArray(details)) return [];
  return details
    .flatMap((d: { errors?: unknown } | null) => (Array.isArray(d?.errors) ? d.errors : []))
    .flatMap((e: { errorCode?: unknown } | null) => (e?.errorCode && typeof e.errorCode === 'object' ? Object.values(e.errorCode) : []))
    .filter((code): code is string => typeof code === 'string');
}
