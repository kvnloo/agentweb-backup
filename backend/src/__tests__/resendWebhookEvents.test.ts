import {
  normalizeResendEvent,
  signResendPayload,
  verifyResendWebhook,
} from '../utils/resendWebhookEvents';

const SECRET = 'whsec_' + Buffer.from('test-secret-key-0123456789').toString('base64');
const NOW_MS = 1_760_000_000_000;
const TS = String(Math.floor(NOW_MS / 1000));
const BODY = JSON.stringify({ type: 'email.delivered', data: { to: ['a@b.com'], email_id: 'm1' } });

function headers(over: Record<string, string | undefined> = {}) {
  return {
    'svix-id': 'msg_1',
    'svix-timestamp': TS,
    'svix-signature': `v1,${signResendPayload(SECRET, 'msg_1', TS, BODY)}`,
    ...over,
  };
}

describe('verifyResendWebhook', () => {
  it('accepts a valid signature within tolerance', () => {
    expect(verifyResendWebhook(BODY, headers(), SECRET, { nowMs: NOW_MS })).toEqual({ ok: true });
  });

  it('accepts when one of several signatures matches', () => {
    const h = headers();
    h['svix-signature'] = `v1,AAAA ${h['svix-signature']}`;
    expect(verifyResendWebhook(BODY, h, SECRET, { nowMs: NOW_MS })).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    expect(verifyResendWebhook(BODY + ' ', headers(), SECRET, { nowMs: NOW_MS })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a wrong secret', () => {
    const other = 'whsec_' + Buffer.from('other').toString('base64');
    expect(verifyResendWebhook(BODY, headers(), other, { nowMs: NOW_MS })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each(['svix-id', 'svix-timestamp', 'svix-signature'])('rejects missing %s', (h) => {
    expect(verifyResendWebhook(BODY, headers({ [h]: undefined }), SECRET, { nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
  });

  it('rejects stale and future timestamps', () => {
    expect(verifyResendWebhook(BODY, headers(), SECRET, { nowMs: NOW_MS + 301_000 })).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(verifyResendWebhook(BODY, headers(), SECRET, { nowMs: NOW_MS - 301_000 })).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects a non-numeric timestamp and an empty secret', () => {
    expect(verifyResendWebhook(BODY, headers({ 'svix-timestamp': 'abc' }), SECRET, { nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: 'invalid_timestamp',
    });
    expect(verifyResendWebhook(BODY, headers(), '', { nowMs: NOW_MS })).toEqual({ ok: false, reason: 'invalid_secret' });
  });
});

describe('normalizeResendEvent', () => {
  const base = (type: string, data: Record<string, unknown> = {}) => ({
    type,
    created_at: '2026-10-16T00:00:00Z',
    data: { to: [' User@Example.com '], email_id: 'em_1', ...data },
  });

  it('maps a permanent bounce to hard_bounce', () => {
    expect(normalizeResendEvent(base('email.bounced', { bounce: { type: 'Permanent' } }))).toEqual({
      ok: true,
      event: { kind: 'hard_bounce', email: 'user@example.com', messageId: 'em_1', occurredAt: '2026-10-16T00:00:00Z' },
    });
  });

  it('maps a transient bounce to soft_bounce', () => {
    const r = normalizeResendEvent(base('email.bounced', { bounce: { type: 'Transient' } }));
    expect(r.ok && r.event.kind).toBe('soft_bounce');
  });

  it('maps complained and delivered', () => {
    const c = normalizeResendEvent(JSON.stringify(base('email.complained')));
    const d = normalizeResendEvent(base('email.delivered'));
    expect(c.ok && c.event.kind).toBe('complaint');
    expect(d.ok && d.event.kind).toBe('delivered');
  });

  it('maps unknown types to ignored', () => {
    const r = normalizeResendEvent(base('email.opened'));
    expect(r.ok && r.event.kind).toBe('ignored');
  });

  it.each([
    ['not json', 'invalid_json'],
    [null, 'payload_not_object'],
    [[1], 'payload_not_object'],
    [{ data: {} }, 'missing_type'],
    [{ type: 'email.bounced' }, 'missing_data'],
    [{ type: 'email.complained', data: { to: [] } }, 'missing_recipient'],
  ])('returns an error for malformed payload %p', (payload, error) => {
    expect(normalizeResendEvent(payload)).toEqual({ ok: false, error });
  });
});
