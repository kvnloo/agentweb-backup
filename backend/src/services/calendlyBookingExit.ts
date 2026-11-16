/**
 * ENG-2543 (ENG-2167 slice): pure Calendly booking webhook verification,
 * event normalization, and drip-sequence exit decision for stop-on-booking.
 *
 * Pure: no persistence, no network, no env reads, no route registration.
 * Wiring into a webhook route + enrollment store is a later slice.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export type CalendlyVerifyResult =
  | { ok: true; timestampSec: number }
  | {
      ok: false;
      reason:
        | 'missing_header'
        | 'malformed_header'
        | 'missing_signing_key'
        | 'stale_timestamp'
        | 'signature_mismatch';
    };

export const DEFAULT_CALENDLY_TOLERANCE_MS = 3 * 60 * 1000;

/**
 * Verifies a `Calendly-Webhook-Signature` header (`t=<unix-sec>,v1=<hex>`):
 * HMAC-SHA256(signingKey, `${t}.${rawBody}`), constant-time compare, and
 * rejects timestamps outside `toleranceMs` of `nowMs` (either direction).
 */
export function verifyCalendlyWebhook(
  rawBody: string,
  signatureHeader: string | null | undefined,
  signingKey: string,
  nowMs: number,
  toleranceMs: number = DEFAULT_CALENDLY_TOLERANCE_MS,
): CalendlyVerifyResult {
  if (!signatureHeader || !signatureHeader.trim()) return { ok: false, reason: 'missing_header' };
  if (!signingKey) return { ok: false, reason: 'missing_signing_key' };

  let t: string | undefined;
  let v1: string | undefined;
  for (const part of signatureHeader.split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === 't' && t === undefined) t = v;
    else if (k === 'v1' && v1 === undefined) v1 = v;
  }
  if (!t || !v1 || !/^\d{1,12}$/.test(t) || !/^[0-9a-fA-F]{64}$/.test(v1)) {
    return { ok: false, reason: 'malformed_header' };
  }

  const timestampSec = Number(t);
  if (!Number.isFinite(nowMs) || !Number.isFinite(toleranceMs) || toleranceMs < 0) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  if (Math.abs(nowMs - timestampSec * 1000) > toleranceMs) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const expected = createHmac('sha256', signingKey).update(`${t}.${rawBody}`, 'utf8').digest();
  const provided = Buffer.from(v1, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true, timestampSec };
}

export type CalendlyNormalizedEvent =
  | { type: 'booked' | 'canceled'; email: string; eventUri: string | null; scheduledAt: string | null }
  | { type: 'ignored'; reason: string };

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Maps a Calendly webhook payload to a booking event; never throws. */
export function normalizeCalendlyEvent(payload: unknown): CalendlyNormalizedEvent {
  if (!payload || typeof payload !== 'object') return { type: 'ignored', reason: 'invalid_payload' };
  const p = payload as Record<string, unknown>;
  const event = str(p.event);
  const type = event === 'invitee.created' ? 'booked' : event === 'invitee.canceled' ? 'canceled' : null;
  if (!type) return { type: 'ignored', reason: `unsupported_event:${event ?? 'none'}` };

  const inner = p.payload && typeof p.payload === 'object' ? (p.payload as Record<string, unknown>) : {};
  const email = str(inner.email)?.toLowerCase() ?? null;
  if (!email) return { type: 'ignored', reason: 'missing_email' };

  const scheduled =
    inner.scheduled_event && typeof inner.scheduled_event === 'object'
      ? (inner.scheduled_event as Record<string, unknown>)
      : {};
  return {
    type,
    email,
    eventUri: str(scheduled.uri) ?? str(inner.event),
    scheduledAt: str(scheduled.start_time),
  };
}

export interface BookingEnrollment {
  enrollmentId: string;
  email: string;
  status: 'active' | 'exited' | 'completed' | 'paused' | string;
}

export interface BookingExitDecision {
  exits: Array<{ enrollmentId: string; reason: 'booked' }>;
  note: string | null;
}

/**
 * Which enrollments exit for a booking. Only `active` enrollments whose
 * email matches (case-insensitive, trimmed) exit; already-exited ones are
 * skipped, so replaying the same event is idempotent. Cancellations never
 * re-enroll. Output is sorted by enrollmentId for determinism.
 */
export function bookingExitDecision(
  event: CalendlyNormalizedEvent,
  enrollments: readonly BookingEnrollment[],
): BookingExitDecision {
  if (event.type === 'ignored') return { exits: [], note: `ignored:${event.reason}` };
  if (event.type === 'canceled') {
    return { exits: [], note: 'booking_canceled_no_reenroll' };
  }
  const target = event.email.trim().toLowerCase();
  const ids = new Set<string>();
  for (const e of enrollments) {
    if (e.status !== 'active') continue;
    if (typeof e.email !== 'string' || e.email.trim().toLowerCase() !== target) continue;
    ids.add(e.enrollmentId);
  }
  const exits = [...ids].sort().map((enrollmentId) => ({ enrollmentId, reason: 'booked' as const }));
  return { exits, note: exits.length ? null : 'no_matching_active_enrollment' };
}
