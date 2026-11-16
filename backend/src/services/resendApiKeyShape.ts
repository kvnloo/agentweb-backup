/**
 * ENG-2560 (ENG-2167 Phase 1 slice): pure customer Resend API key shape
 * validator + display mask.
 *
 * Pure — no I/O, no storage. Rejection reasons are fixed enum values and
 * never echo the raw input, so they are safe to log or return to clients.
 */

export type ResendApiKeyRejection = 'empty' | 'missing_prefix' | 'bad_length' | 'bad_characters';

export type ResendApiKeyValidation =
  | { ok: true; key: string }
  | { ok: false; reason: ResendApiKeyRejection };

const PREFIX = 're_';
const MIN_BODY = 20;
const MAX_BODY = 100;
const BODY_CHARS = /^[A-Za-z0-9_]+$/;
const MASK_PREFIX = 're_\u2026';
const MASK_FALLBACK = `${MASK_PREFIX}****`;

export function validateResendApiKey(raw: unknown): ResendApiKeyValidation {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' };
  const key = raw.trim();
  if (key.length === 0) return { ok: false, reason: 'empty' };
  if (!key.startsWith(PREFIX)) return { ok: false, reason: 'missing_prefix' };
  const body = key.slice(PREFIX.length);
  if (!BODY_CHARS.test(body)) {
    return body.length === 0 ? { ok: false, reason: 'bad_length' } : { ok: false, reason: 'bad_characters' };
  }
  if (body.length < MIN_BODY || body.length > MAX_BODY) return { ok: false, reason: 'bad_length' };
  return { ok: true, key };
}

/** Display-safe mask: `re_…` + last 4 chars of a valid key; otherwise `re_…****`. */
export function maskResendApiKey(key: unknown): string {
  const result = validateResendApiKey(key);
  if (!result.ok) return MASK_FALLBACK;
  return `${MASK_PREFIX}${result.key.slice(-4)}`;
}
