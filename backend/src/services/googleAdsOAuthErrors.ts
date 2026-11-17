/** Google issued a token but the adwords scope was not granted. Leaf module so callers can `instanceof` it without loading the Ads service. */
export class GoogleAdsInsufficientScopesError extends Error {
  constructor(public readonly grantedScopes: string[]) {
    super('insufficient_scopes');
  }
}
