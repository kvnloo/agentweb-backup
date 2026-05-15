/**
 * Signs and verifies HMAC-SHA256 signatures for one-click unsubscribe URLs.
 *
 * Without a signature, the unsubscribe endpoint relies on the client-supplied
 * `email` matching the lead record — which is replayable by anyone who knows
 * the lead's email address. Signing with HMAC over (listId:leadId:email) and
 * verifying server-side closes the replay window.
 *
 * Legacy URLs (no `sig` query param) still work via the email-match fallback
 * in the route handler, so existing emails in customer inboxes don't break.
 */

import { createHmac, timingSafeEqual } from 'crypto';

interface SignParams {
  baseUrl: string;
  listId: string;
  leadId: string;
  email: string;
}

interface VerifyParams {
  listId: string;
  leadId: string;
  email: string;
  sig: string;
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured — cannot sign/verify unsubscribe URLs');
  }
  return secret;
}

function normaliseEmail(email: string): string {
  return (email || '').trim().toLowerCase();
}

function computeSignature(listId: string, leadId: string, email: string): string {
  // Always sign over the normalised (lowercase, trimmed) email so trivial
  // case/whitespace differences between sign-time and verify-time don't
  // produce false negatives.
  const message = `${listId}:${leadId}:${normaliseEmail(email)}`;
  return createHmac('sha256', getSecret()).update(message).digest('hex');
}

/**
 * Build a signed unsubscribe URL.
 *
 * Returns: `${baseUrl}/crm-unsubscribe?listId=...&leadId=...&email=...&sig=<hex>`
 */
export function signUnsubscribeUrl({ baseUrl, listId, leadId, email }: SignParams): string {
  const sig = computeSignature(listId, leadId, email);
  const qs =
    `listId=${encodeURIComponent(listId)}` +
    `&leadId=${encodeURIComponent(leadId)}` +
    `&email=${encodeURIComponent(email)}` +
    `&sig=${sig}`;
  // Trim trailing slash on baseUrl so we don't get a doubled slash
  const root = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${root}/crm-unsubscribe?${qs}`;
}

/**
 * Verify an unsubscribe signature using a constant-time comparison.
 *
 * Returns false on any malformed sig (wrong length, non-hex characters,
 * mismatch); never throws on bad input. Throws only when JWT_SECRET is unset.
 */
export function verifyUnsubscribeSignature({ listId, leadId, email, sig }: VerifyParams): boolean {
  if (typeof sig !== 'string' || sig.length === 0) return false;

  const expected = computeSignature(listId, leadId, email);
  // Both sides must be the same byte length for timingSafeEqual; if a caller
  // sends a sig of the wrong length, fail fast without running compare.
  if (sig.length !== expected.length) return false;

  // Reject non-hex sigs early (Buffer.from('zz...', 'hex') silently truncates,
  // which would let a bogus sig pass the byte-length check and reach compare).
  if (!/^[0-9a-fA-F]+$/.test(sig)) return false;

  try {
    const expectedBuf = Buffer.from(expected, 'hex');
    const sigBuf = Buffer.from(sig, 'hex');
    /* istanbul ignore next — sig.length === expected.length and both are pre-validated hex, so byte lengths always match here */
    if (expectedBuf.length !== sigBuf.length) return false;
    return timingSafeEqual(expectedBuf, sigBuf);
  } catch {
    return false;
  }
}
