/**
 * ENG-2558 (ENG-2167 Phase 1 slice): pure one-off email payload composer.
 *
 * Composes the merged pure helpers (sender identity, do-not-email
 * suppression, signed List-Unsubscribe) into one Resend `emails.send`
 * payload. Pure — no I/O, no key storage, not wired into a send path.
 * Every invalid input fails closed with a typed error; it never throws.
 */

import { buildListUnsubscribeHeaders, signUnsubscribeToken } from './dripListUnsubscribe';
import { buildSenderIdentity, type SenderIdentityError } from './dripSenderIdentity';
import {
  checkSuppression,
  normalizeEmail,
  type SuppressionList,
  type SuppressionReason,
} from './dripSuppressionList';

export interface OneOffEmailInput {
  orgId: string;
  contactId: string;
  to: unknown;
  fromAddress: unknown;
  fromName?: unknown;
  replyTo?: unknown;
  allowedDomains?: readonly string[];
  subject: unknown;
  html: unknown;
  text?: unknown;
  suppression: SuppressionList;
  unsubscribe: { secret: string; baseUrl: string; mailto?: string };
}

export interface ResendEmailPayload {
  from: string;
  to: string[];
  reply_to?: string;
  subject: string;
  html: string;
  text?: string;
  headers: Record<string, string>;
}

export type OneOffEmailError =
  | SenderIdentityError
  | 'invalid_recipient'
  | 'suppressed'
  | 'invalid_subject'
  | 'empty_body'
  | 'invalid_unsubscribe_config';

export type OneOffEmailResult =
  | { ok: true; payload: ResendEmailPayload }
  | { ok: false; error: OneOffEmailError; reason?: SuppressionReason };

const SUBJECT_INVALID_RE = /[\r\n\0]/;

export function composeOneOffEmail(input: OneOffEmailInput): OneOffEmailResult {
  const recipient = normalizeEmail(input.to);
  if (!recipient) return { ok: false, error: 'invalid_recipient' };

  const suppression = checkSuppression(input.suppression, recipient);
  if (suppression.suppressed) {
    return { ok: false, error: 'suppressed', reason: suppression.reason };
  }

  const identity = buildSenderIdentity({
    fromAddress: input.fromAddress,
    fromName: input.fromName,
    replyTo: input.replyTo,
    allowedDomains: input.allowedDomains,
  });
  if (!identity.ok) return { ok: false, error: identity.error };

  const { subject, html, text } = input;
  if (typeof subject !== 'string' || subject.trim() === '' || SUBJECT_INVALID_RE.test(subject)) {
    return { ok: false, error: 'invalid_subject' };
  }
  if (typeof html !== 'string' || html.trim() === '') return { ok: false, error: 'empty_body' };

  let headers: Record<string, string>;
  try {
    const token = signUnsubscribeToken(
      { orgId: input.orgId, contactId: input.contactId },
      input.unsubscribe?.secret,
    );
    headers = buildListUnsubscribeHeaders({
      baseUrl: input.unsubscribe?.baseUrl,
      token,
      mailto: input.unsubscribe?.mailto,
    });
  } catch {
    return { ok: false, error: 'invalid_unsubscribe_config' };
  }

  const payload: ResendEmailPayload = {
    from: identity.from,
    to: [recipient],
    subject: subject.trim(),
    html,
    headers,
  };
  if (identity.replyTo) payload.reply_to = identity.replyTo;
  if (typeof text === 'string' && text.trim() !== '') payload.text = text;
  return { ok: true, payload };
}
