/**
 * ENG-2555 (ENG-2167 Phase 1 slice): pure customer sender identity builder.
 *
 * Builds the From / Reply-To header values for a customer sending from its
 * own domain. Pure — no I/O, not yet wired into a send path. Header
 * injection characters are rejected, never silently stripped.
 */

import { normalizeEmail } from './dripSuppressionList';

export type SenderIdentityError =
  | 'header_injection'
  | 'invalid_from_address'
  | 'invalid_reply_to'
  | 'display_name_too_long'
  | 'from_domain_not_allowed';

export interface SenderIdentityInput {
  fromAddress: unknown;
  fromName?: unknown;
  replyTo?: unknown;
  /** When provided, the from-address domain must be one of these. */
  allowedDomains?: readonly string[];
}

export type SenderIdentityResult =
  | { ok: true; from: string; replyTo?: string }
  | { ok: false; error: SenderIdentityError };

export const MAX_DISPLAY_NAME_LENGTH = 78;

const INJECTION_RE = /[\r\n\0]/;

function hasInjection(v: unknown): boolean {
  return typeof v === 'string' && INJECTION_RE.test(v);
}

function quoteDisplayName(name: string): string {
  return `"${name.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

export function buildSenderIdentity(input: SenderIdentityInput): SenderIdentityResult {
  const { fromAddress, fromName, replyTo, allowedDomains } = input;
  if (hasInjection(fromAddress) || hasInjection(fromName) || hasInjection(replyTo)) {
    return { ok: false, error: 'header_injection' };
  }

  const from = normalizeEmail(fromAddress);
  if (!from) return { ok: false, error: 'invalid_from_address' };

  let normalizedReplyTo: string | undefined;
  if (replyTo !== undefined && replyTo !== null && !(typeof replyTo === 'string' && replyTo.trim() === '')) {
    const r = normalizeEmail(replyTo);
    if (!r) return { ok: false, error: 'invalid_reply_to' };
    normalizedReplyTo = r;
  }

  if (allowedDomains) {
    const domain = from.slice(from.lastIndexOf('@') + 1);
    const allowed = new Set(allowedDomains.map((d) => d.trim().toLowerCase()));
    if (!allowed.has(domain)) return { ok: false, error: 'from_domain_not_allowed' };
  }

  const name = typeof fromName === 'string' ? fromName.trim() : '';
  if (name.length > MAX_DISPLAY_NAME_LENGTH) return { ok: false, error: 'display_name_too_long' };

  const fromHeader = name ? `${quoteDisplayName(name)} <${from}>` : from;
  return normalizedReplyTo
    ? { ok: true, from: fromHeader, replyTo: normalizedReplyTo }
    : { ok: true, from: fromHeader };
}
