/**
 * Pure Resend (Svix-signed) webhook verification + event normalization (ENG-2517).
 *
 * No env reads, no I/O, no persistence: the signing secret and the clock are
 * injected. Wiring a live route and storing suppressions is out of scope
 * (data-plane, ENG-2369).
 *
 * Svix scheme: signed content is `${svix-id}.${svix-timestamp}.${rawBody}`,
 * HMAC-SHA256 keyed with the base64-decoded secret (after the `whsec_` prefix).
 * The `svix-signature` header is a space-separated list of `v1,<base64sig>`.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export type WebhookRejectReason =
  | 'missing_headers'
  | 'invalid_secret'
  | 'invalid_timestamp'
  | 'stale_timestamp'
  | 'bad_signature';

export type WebhookVerifyResult = { ok: true } | { ok: false; reason: WebhookRejectReason };

export interface ResendWebhookHeaders {
  'svix-id'?: string;
  'svix-timestamp'?: string;
  'svix-signature'?: string;
}

export interface VerifyOptions {
  /** Current time in ms; defaults to Date.now(). Injected for tests. */
  nowMs?: number;
  toleranceSeconds?: number;
}

function decodeSecret(secret: string): Buffer | null {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = Buffer.from(raw, 'base64');
  return key.length > 0 ? key : null;
}

export function signResendPayload(secret: string, id: string, timestamp: string, rawBody: string): string {
  const key = decodeSecret(secret);
  if (!key) throw new Error('invalid secret');
  return createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
}

export function verifyResendWebhook(
  rawBody: string,
  headers: ResendWebhookHeaders,
  secret: string,
  options: VerifyOptions = {},
): WebhookVerifyResult {
  const id = headers['svix-id'];
  const ts = headers['svix-timestamp'];
  const sigHeader = headers['svix-signature'];
  if (!id || !ts || !sigHeader) return { ok: false, reason: 'missing_headers' };

  const key = decodeSecret(secret);
  if (!key) return { ok: false, reason: 'invalid_secret' };

  if (!/^\d+$/.test(ts)) return { ok: false, reason: 'invalid_timestamp' };
  const tsSeconds = Number(ts);
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - tsSeconds) > tolerance) return { ok: false, reason: 'stale_timestamp' };

  const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest();
  for (const part of sigHeader.split(' ')) {
    const [version, sig] = part.split(',', 2);
    if (version !== 'v1' || !sig) continue;
    const given = Buffer.from(sig, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: 'bad_signature' };
}

export type NormalizedEmailEventKind = 'hard_bounce' | 'soft_bounce' | 'complaint' | 'delivered' | 'ignored';

export interface NormalizedEmailEvent {
  kind: NormalizedEmailEventKind;
  email: string | null;
  messageId: string | null;
  occurredAt: string | null;
}

export type NormalizeResult = { ok: true; event: NormalizedEmailEvent } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function firstRecipient(to: unknown): string | null {
  const v = Array.isArray(to) ? to[0] : to;
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null;
}

/** Resend marks transient bounces as `Transient`/`soft`; everything else is permanent. */
function isSoftBounce(data: Record<string, unknown>): boolean {
  const bounce = isRecord(data.bounce) ? data.bounce : {};
  const type = String(bounce.type ?? data.bounce_type ?? '').toLowerCase();
  return type === 'transient' || type === 'soft' || type === 'undetermined';
}

/** Accepts the raw body string or an already-parsed object. Never throws. */
export function normalizeResendEvent(payload: unknown): NormalizeResult {
  let body: unknown = payload;
  if (typeof payload === 'string') {
    try {
      body = JSON.parse(payload);
    } catch {
      return { ok: false, error: 'invalid_json' };
    }
  }
  if (!isRecord(body)) return { ok: false, error: 'payload_not_object' };
  if (typeof body.type !== 'string') return { ok: false, error: 'missing_type' };
  const data = isRecord(body.data) ? body.data : null;

  let kind: NormalizedEmailEventKind;
  switch (body.type) {
    case 'email.bounced':
      kind = data && isSoftBounce(data) ? 'soft_bounce' : 'hard_bounce';
      break;
    case 'email.complained':
      kind = 'complaint';
      break;
    case 'email.delivered':
      kind = 'delivered';
      break;
    default:
      kind = 'ignored';
  }

  if (kind === 'ignored') {
    return { ok: true, event: { kind, email: data ? firstRecipient(data.to) : null, messageId: null, occurredAt: null } };
  }
  if (!data) return { ok: false, error: 'missing_data' };
  const email = firstRecipient(data.to);
  if (!email) return { ok: false, error: 'missing_recipient' };
  const messageId = typeof data.email_id === 'string' ? data.email_id : null;
  const occurredAt =
    typeof body.created_at === 'string' ? body.created_at : typeof data.created_at === 'string' ? data.created_at : null;
  return { ok: true, event: { kind, email, messageId, occurredAt } };
}
