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
