import crypto from "crypto";

/**
 * System-generated initial passwords / activation codes.
 *
 * Security requirements (see PR "secure initial passwords"):
 *  - Securely randomly generated — uses `crypto.randomInt`, never `Math.random`.
 *  - At least 6 characters long.
 *  - May contain letters and numbers (no symbols, to keep them easy to type
 *    from a welcome email).
 *  - Short-lived — paired with a 1-month expiry so the initial secret cannot
 *    silently become the user's long-term password. Login is rejected once the
 *    initial password is past its expiry (see the login controller).
 */

/** Alphanumeric charset — letters (mixed case) and digits only. */
const CHARSET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Minimum allowed length for a system-generated initial password. */
export const MIN_INITIAL_PASSWORD_LENGTH = 6;

/** Default length used when callers don't specify one. */
const DEFAULT_INITIAL_PASSWORD_LENGTH = 16;

/** Initial passwords expire one month after they are issued. */
export const INITIAL_PASSWORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Generate a cryptographically-random alphanumeric initial password.
 *
 * @param length desired length (>= 6). Defaults to 16.
 * @throws if `length` is below the 6-character minimum.
 */
export function generateInitialPassword(
  length: number = DEFAULT_INITIAL_PASSWORD_LENGTH
): string {
  if (!Number.isFinite(length) || length < MIN_INITIAL_PASSWORD_LENGTH) {
    throw new Error(
      `Initial password must be at least ${MIN_INITIAL_PASSWORD_LENGTH} characters long`
    );
  }

  let password = "";
  for (let i = 0; i < length; i++) {
    // crypto.randomInt is uniform over [0, CHARSET.length) and CSPRNG-backed.
    password += CHARSET.charAt(crypto.randomInt(CHARSET.length));
  }
  return password;
}

/**
 * ISO timestamp at which a newly-issued initial password expires
 * (now + INITIAL_PASSWORD_TTL_MS).
 */
export function getInitialPasswordExpiry(): string {
  return new Date(Date.now() + INITIAL_PASSWORD_TTL_MS).toISOString();
}

/**
 * Whether an initial password has expired. Returns false when no expiry is
 * set (account has no pending initial password) or when the value can't be
 * parsed — callers treat "unknown" as "not expired" so a malformed field can
 * never lock a user out.
 */
export function isInitialPasswordExpired(expiresAt?: string): boolean {
  if (!expiresAt) return false;
  const expiryMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiryMs)) return false;
  return expiryMs < Date.now();
}
