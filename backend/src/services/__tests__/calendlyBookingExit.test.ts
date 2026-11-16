import { createHmac } from 'crypto';
import {
  verifyCalendlyWebhook,
  normalizeCalendlyEvent,
  bookingExitDecision,
  BookingEnrollment,
} from '../calendlyBookingExit';

const KEY = 'test-signing-key';
const NOW = 1_760_000_000_000;
const T = Math.floor(NOW / 1000);
const body = JSON.stringify({ event: 'invitee.created', payload: { email: 'A@x.com' } });
const sign = (t: number, b: string, k = KEY) =>
  `t=${t},v1=${createHmac('sha256', k).update(`${t}.${b}`).digest('hex')}`;

describe('verifyCalendlyWebhook', () => {
  it('accepts a valid signature', () => {
    expect(verifyCalendlyWebhook(body, sign(T, body), KEY, NOW)).toEqual({ ok: true, timestampSec: T });
  });
  it('rejects tampered body', () => {
    expect(verifyCalendlyWebhook(body + ' ', sign(T, body), KEY, NOW)).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
  it('rejects wrong key', () => {
    expect(verifyCalendlyWebhook(body, sign(T, body, 'other'), KEY, NOW)).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
  it.each([undefined, null, '', '  '])('rejects missing header %p', (h) => {
    expect(verifyCalendlyWebhook(body, h as any, KEY, NOW)).toEqual({ ok: false, reason: 'missing_header' });
  });
  it('rejects stale and future timestamps', () => {
    expect(verifyCalendlyWebhook(body, sign(T - 600, body), KEY, NOW)).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(verifyCalendlyWebhook(body, sign(T + 600, body), KEY, NOW)).toEqual({ ok: false, reason: 'stale_timestamp' });
  });
  it.each(['garbage', 't=abc,v1=00', `t=${T}`, `t=${T},v1=zz`])('rejects malformed header %p', (h) => {
    expect(verifyCalendlyWebhook(body, h, KEY, NOW)).toEqual({ ok: false, reason: 'malformed_header' });
  });
  it('fails closed on missing key or non-finite clock', () => {
    expect(verifyCalendlyWebhook(body, sign(T, body), '', NOW)).toEqual({ ok: false, reason: 'missing_signing_key' });
    expect(verifyCalendlyWebhook(body, sign(T, body), KEY, NaN)).toEqual({ ok: false, reason: 'stale_timestamp' });
  });
});

describe('normalizeCalendlyEvent', () => {
  it('maps invitee.created to booked with lowercased email', () => {
    expect(
      normalizeCalendlyEvent({
        event: 'invitee.created',
        payload: { email: '  Lead@Haven.COM ', scheduled_event: { uri: 'u1', start_time: '2026-10-20T10:00:00Z' } },
      }),
    ).toEqual({ type: 'booked', email: 'lead@haven.com', eventUri: 'u1', scheduledAt: '2026-10-20T10:00:00Z' });
  });
  it('maps invitee.canceled to canceled', () => {
    expect(normalizeCalendlyEvent({ event: 'invitee.canceled', payload: { email: 'a@b.co' } })).toMatchObject({ type: 'canceled', email: 'a@b.co' });
  });
  it.each([null, 'x', 42, {}, { event: 'routing_form_submission.created' }, { event: 'invitee.created', payload: {} }])(
    'ignores %p without throwing',
    (p) => {
      expect(normalizeCalendlyEvent(p).type).toBe('ignored');
    },
  );
});

describe('bookingExitDecision', () => {
  const enr: BookingEnrollment[] = [
    { enrollmentId: 'e3', email: 'LEAD@haven.com', status: 'active' },
    { enrollmentId: 'e1', email: 'lead@haven.com', status: 'active' },
    { enrollmentId: 'e2', email: 'lead@haven.com', status: 'exited' },
    { enrollmentId: 'e4', email: 'other@haven.com', status: 'active' },
  ];
  const booked = normalizeCalendlyEvent({ event: 'invitee.created', payload: { email: 'Lead@Haven.com' } });

  it('exits only matching active enrollments, sorted', () => {
    expect(bookingExitDecision(booked, enr)).toEqual({
      exits: [{ enrollmentId: 'e1', reason: 'booked' }, { enrollmentId: 'e3', reason: 'booked' }],
      note: null,
    });
  });
  it('is idempotent once enrollments are exited', () => {
    const after = enr.map((e) => (e.enrollmentId === 'e1' || e.enrollmentId === 'e3' ? { ...e, status: 'exited' } : e));
    expect(bookingExitDecision(booked, after)).toEqual({ exits: [], note: 'no_matching_active_enrollment' });
    expect(bookingExitDecision(booked, enr)).toEqual(bookingExitDecision(booked, [...enr].reverse()));
  });
  it('cancellation never re-enrolls', () => {
    const c = normalizeCalendlyEvent({ event: 'invitee.canceled', payload: { email: 'lead@haven.com' } });
    expect(bookingExitDecision(c, enr)).toEqual({ exits: [], note: 'booking_canceled_no_reenroll' });
  });
  it('ignored events are no-ops', () => {
    expect(bookingExitDecision({ type: 'ignored', reason: 'x' }, enr).exits).toEqual([]);
  });
});
