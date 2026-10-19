import { resendStopEvent } from '../dripResendStopEvents';

const at = '2026-10-19T07:00:00.000Z';
const ms = Date.parse(at);
const ev = (type: string, data: Record<string, unknown> = {}, created_at: unknown = at) => ({
  type,
  created_at,
  data: { to: ['lead@example.com'], email_id: 'e1', ...data },
});

describe('resendStopEvent (ENG-2544)', () => {
  it('AC1: hard/Permanent bounce maps to bounced', () => {
    expect(resendStopEvent(ev('email.bounced', { bounce: { type: 'Permanent' } }))).toEqual({ type: 'bounced', at: ms });
  });

  it('AC2: soft/Transient bounce does not stop', () => {
    expect(resendStopEvent(ev('email.bounced', { bounce: { type: 'Transient' } }))).toBeNull();
  });

  it('AC3: complaint maps to unsubscribed', () => {
    expect(resendStopEvent(ev('email.complained'))).toEqual({ type: 'unsubscribed', at: ms });
  });

  it.each(['email.delivered', 'email.opened', 'email.clicked', 'email.something'])('AC4: %s returns null', (t) => {
    expect(resendStopEvent(ev(t))).toBeNull();
  });

  it.each([undefined, 'not-a-date', 123])('AC5: invalid created_at %p returns null', (c) => {
    const p: any = ev('email.complained', {}, c);
    if (c === undefined) delete p.created_at;
    expect(resendStopEvent(p)).toBeNull();
  });

  it('accepts raw JSON string; rejects malformed JSON', () => {
    expect(resendStopEvent(JSON.stringify(ev('email.complained')))).toEqual({ type: 'unsubscribed', at: ms });
    expect(resendStopEvent('{nope')).toBeNull();
  });
});
