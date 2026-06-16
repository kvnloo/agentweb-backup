/**
 * Cryptographically-secure random helpers.
 *
 * All randomness used for security-sensitive values (passwords, secrets, tokens)
 * MUST come from a CSPRNG. Node's `crypto` module is CSPRNG-backed; `Math.random()`
 * is NOT and produces predictable output, so it must never be used for secrets.
 */
import crypto from 'crypto';

/**
 * Generate a cryptographically-secure random password of the given length.
 *
 * Uses `crypto.randomInt`, which draws from the OS CSPRNG and rejects biased
 * samples so every character in the charset is equally likely (unlike
 * `Math.floor(Math.random() * n)`, which is both predictable and slightly biased).
 *
 * @param length number of characters (must be a positive integer)
 * @param charset characters to draw from (defaults to alphanumeric + symbols)
 */
export function generateSecurePassword(
  length: number = 16,
  charset: string = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*'
): string {
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error('generateSecurePassword: length must be a positive integer');
  }
  if (!charset || charset.length === 0) {
    throw new Error('generateSecurePassword: charset must be non-empty');
  }

  let password = '';
  for (let i = 0; i < length; i++) {
    // crypto.randomInt(max) returns an unbiased integer in [0, max).
    password += charset.charAt(crypto.randomInt(charset.length));
  }
  return password;
}

/**
 * Initial-password lifecycle.
 *
 * A system-generated initial (temporary) password must not silently become the
 * user's long-term password. It is issued with a short expiry; login is
 * rejected once the expiry passes (see the login controller), forcing the user
 * to set their own password via the forced-change / reset flow.
 */

/** Initial passwords expire one month after they are issued. */
export const INITIAL_PASSWORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * ISO timestamp at which a newly-issued initial password expires
 * (now + INITIAL_PASSWORD_TTL_MS).
 */
export function getInitialPasswordExpiry(): string {
  return new Date(Date.now() + INITIAL_PASSWORD_TTL_MS).toISOString();
}

/**
 * Whether an initial password has expired. Returns false when no expiry is set
 * (account has no pending initial password) or when the value can't be parsed —
 * callers treat "unknown" as "not expired" so a malformed field can never lock
 * a user out.
 */
export function isInitialPasswordExpired(expiresAt?: string | null): boolean {
  if (!expiresAt) return false;
  const expiryMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiryMs)) return false;
  return expiryMs < Date.now();
}
