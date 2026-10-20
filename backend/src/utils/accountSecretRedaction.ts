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

// Compile-time tripwire: `SECRET_CONFIG_KEYS` above is a hand-maintained
// literal list with nothing forcing it to stay in sync with
// `PlatformConfig` as platforms are added. `import type` is erased
// entirely by the compiler — zero runtime import, so this does NOT
// reintroduce the jest.mock problem the module comment above describes.
// `KeysOf` distributes over the union to get every field name that
// appears on ANY platform's config (not just fields common to all of
// them); `CredentialShapedKey` keeps the ones that look like a secret by
// the same naming heuristic org.ts used before this fix existed. If a
// future platform adds e.g. `bearer_token` or `signing_secret` and
// forgets to add it to `SECRET_CONFIG_KEYS`, this line fails to compile.
import type { PlatformConfig } from '../services/connectedAccountsDb';
// Pure module (no db / connectedAccountsDb dependency), so the note above still holds.
import { toCustomerPaygOverage } from '../services/paygOverage';
type KeysOf<U> = U extends infer T ? keyof T : never;
type CredentialShapedKey = Extract<
  KeysOf<PlatformConfig>,
  `${string}token` | `${string}_key` | `${string}secret${string}`
>;
type MissingFromSecretConfigKeys = Exclude<CredentialShapedKey, (typeof SECRET_CONFIG_KEYS)[number]>;
// If this errors, a credential-shaped field exists that SECRET_CONFIG_KEYS doesn't cover.
const _assertNoSecretConfigKeyMissing: MissingFromSecretConfigKeys extends never ? true : [
  'add to SECRET_CONFIG_KEYS:', MissingFromSecretConfigKeys
] = true;
void _assertNoSecretConfigKeyMissing;

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
    paygOverage,
    ...safe
  } = user;
  // ENG-668 PR-2: settlement records carry provider cost and markup; the closed-month ledger is
  // settlement input. No customer surface reads either.
  delete safe.paygSettlements;
  delete safe.llmUsageCreditsClosed;
  return {
    ...safe,
    connected_accounts: redactAccountsSecrets(connected_accounts),
    // ENG-668: the stored opt-in carries micro-USD (pool high-water mark, opt-in baseline) that no
    // customer surface may see; only the on/off state and the percentage cap pass.
    ...(paygOverage ? { paygOverage: toCustomerPaygOverage(paygOverage) } : {}),
  };
};
