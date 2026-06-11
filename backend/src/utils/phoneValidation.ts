/**
 * Phone number validation and normalization for enrichment fills.
 *
 * Uses libphonenumber-js (Google's libphonenumber port) which covers all
 * countries and understands E.164, national, and international formats.
 *
 * Tier 1: libphonenumber strict validation → normalized international format.
 * Tier 2: Digit-count fallback for local-format numbers from unknown countries
 *         (e.g. "97000 41411" without a country code). Stored as-is to avoid
 *         losing valid non-US numbers that libphonenumber can't parse without
 *         a country hint.
 *
 * Returns null only for clear garbage: vanity numbers (letters), too short/long,
 * or strings that contain no digits at all.
 */

import { parsePhoneNumberWithError, isValidPhoneNumber, type CountryCode } from 'libphonenumber-js';

// Vanity numbers (e.g. 1-800-THE-WOLVES) contain letters — not dialable.
const HAS_LETTER = /[a-zA-Z]/;

// ITU-T E.164 max is 15 digits; minimum meaningful length is 7 (local numbers).
const MIN_DIGITS = 7;
const MAX_DIGITS = 15;

const DEFAULT_COUNTRY: CountryCode = 'US';

/**
 * Validate and normalize a raw phone string from an enrichment source.
 *
 * @returns Normalized string (international format when possible, raw when
 *          only the digit-count fallback passes), or null for clear garbage.
 */
export function sanitizePhone(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Vanity numbers are not dialable.
  if (HAS_LETTER.test(trimmed)) return null;

  try {
    // Tier 1a: E.164 / explicit country code (+ prefix).
    if (trimmed.startsWith('+')) {
      if (isValidPhoneNumber(trimmed)) {
        return parsePhoneNumberWithError(trimmed).formatInternational();
      }
      // + prefix but libphonenumber rejects — fall through to digit check.
    } else {
      // Tier 1b: US national format (no + prefix).
      if (isValidPhoneNumber(trimmed, DEFAULT_COUNTRY)) {
        return parsePhoneNumberWithError(trimmed, DEFAULT_COUNTRY).formatInternational();
      }
    }
  } catch {
    // libphonenumber threw — fall through to digit-count check.
  }

  // Tier 2: digit-count fallback. Preserves local-format non-US numbers
  // (e.g. "97000 41411") that libphonenumber can't validate without a country
  // hint. Accept if the digit count is within the ITU-T E.164 range.
  const digitsOnly = trimmed.replace(/[\s\-\(\)\.\+]/g, '');
  if (/^\d+$/.test(digitsOnly) && digitsOnly.length >= MIN_DIGITS && digitsOnly.length <= MAX_DIGITS) {
    return trimmed; // store as-is, preserving original formatting
  }

  return null;
}
