/**
 * ENG-2566 (ENG-2167 Phase 2 slice): pure classifier that turns a failed
 * Resend send (via the customer's own key) into a drip-worker decision.
 *
 * - retry:          transient (rate limit, 5xx, network, unknown) — bounded by existing retry caps
 * - skip_recipient: this lead's address is bad; continue the sequence for others
 * - pause_sequence: customer config or step content is broken; never hammer
 *
 * Pure — no I/O. Not yet wired into the send path.
 */

export type ResendSendErrorAction = 'retry' | 'skip_recipient' | 'pause_sequence';

export type ResendSendErrorReason =
  | 'rate_limited'
  | 'quota_exhausted'
  | 'provider_unavailable'
  | 'auth_invalid'
  | 'sender_misconfigured'
  | 'domain_not_verified'
  | 'invalid_recipient'
  | 'invalid_message'
  | 'unknown';

export interface ResendSendErrorInput {
  statusCode?: number | null;
  name?: string | null;
  message?: string | null;
}

export interface ResendSendErrorDecision {
  action: ResendSendErrorAction;
  reason: ResendSendErrorReason;
  retryable: boolean;
}

const AUTH_NAMES = new Set(['missing_api_key', 'invalid_api_key', 'restricted_api_key']);
const NETWORK_RE = /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network)\b/i;
const DOMAIN_RE = /domain (is )?not verified|verify (a|your) domain/i;
const RECIPIENT_RE = /`to`|\bto\b field|recipient|invalid email/i;

const retry = (reason: ResendSendErrorReason): ResendSendErrorDecision => ({ action: 'retry', reason, retryable: true });
const pause = (reason: ResendSendErrorReason): ResendSendErrorDecision => ({
  action: 'pause_sequence',
  reason,
  retryable: false,
});

export function classifyResendSendError(input: ResendSendErrorInput): ResendSendErrorDecision {
  const status =
    typeof input?.statusCode === 'number' && Number.isFinite(input.statusCode) ? input.statusCode : undefined;
  const name = typeof input?.name === 'string' ? input.name.trim().toLowerCase() : '';
  const message = typeof input?.message === 'string' ? input.message : '';

  if (name === 'daily_quota_exceeded') return pause('quota_exhausted');
  if (name === 'rate_limit_exceeded' || status === 429) return retry('rate_limited');

  if (DOMAIN_RE.test(message)) return pause('domain_not_verified');
  if (name === 'invalid_from_address') return pause('sender_misconfigured');
  if (AUTH_NAMES.has(name) || status === 401 || status === 403) return pause('auth_invalid');

  if (status === 422 || name === 'validation_error') {
    return RECIPIENT_RE.test(message)
      ? { action: 'skip_recipient', reason: 'invalid_recipient', retryable: false }
      : pause('invalid_message');
  }

  if ((status !== undefined && status >= 500) || (status === undefined && NETWORK_RE.test(message))) {
    return retry('provider_unavailable');
  }

  return retry('unknown');
}
