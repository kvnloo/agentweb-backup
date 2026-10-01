/**
 * Strips credential material from connected-account / user objects before
 * they leave the server in an HTTP response (ENG-2258).
 *
 * Deliberately a standalone module with no dependency on
 * services/connectedAccountsDb or services/db — both are `jest.mock`'d
 * wholesale across ~90 test files, so importing from either here would make
 * every route that redacts a response a hostage to updating each of those
 * mocks just to return a plain object through an extra function call.
 */

/**
 * Config fields that hold live credential material across every connected-
 * account platform: OAuth access/refresh tokens, Fathom's API key, and the
 * Attio/Calendly webhook HMAC signing key.
 */
const SECRET_CONFIG_KEYS = ['access_token', 'refresh_token', 'api_key', 'webhook_signing_key'] as const;

type AccountLike = Record<string, any> & { config?: Record<string, any> };

/**
 * Strips every secret field in `SECRET_CONFIG_KEYS` from a connected account.
 * Call this on every account/config object before it leaves the server in an
 * HTTP response — never send the result of `createAccount`/`getAccountById`/
 * etc. straight to `res.json`.
 */
export const redactAccountSecrets = <T extends AccountLike>(account: T): T => {
  const { config, ...rest } = account;
  const safeConfig: Record<string, any> = { ...config };
  for (const key of SECRET_CONFIG_KEYS) {
    delete safeConfig[key];
  }
  return { ...rest, config: safeConfig } as T;
};

export const redactAccountsSecrets = <T extends AccountLike>(
  accounts: T[] | undefined | null
): T[] => (Array.isArray(accounts) ? accounts.map(redactAccountSecrets) : []);

/**
 * Strips password hash, encrypted per-user secrets, the password-reset token,
 * the encrypted Stripe Connect tokens, and (via `redactAccountsSecrets`) every
 * connected account's secret config fields from a full `User` record. Use this
 * — not a bare `{ password, ...rest }` destructure — anywhere a user object is
 * about to leave the server in an HTTP response.
 */
export const sanitizeUserForResponse = (
  user: Record<string, any> | null | undefined
): Record<string, any> | null | undefined => {
  if (!user) return user;
  const {
    password,
    secrets,
    resetPasswordToken,
    stripeConnectAccessToken,
    stripeConnectRefreshToken,
    connected_accounts,
    ...safe
  } = user;
  return {
    ...safe,
    connected_accounts: redactAccountsSecrets(connected_accounts),
  };
};
