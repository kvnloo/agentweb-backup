import { dripSendIdempotencyKey, decideDuplicateSend } from '../dripSendIdempotency';

const base = { orgId: 'org-1', sequenceId: 'seq-1', enrollmentId: 'enr-1', stepIndex: 0 };
const SAFE = /^[A-Za-z0-9:_-]+$/;

describe('dripSendIdempotencyKey', () => {
  it('is deterministic for identical inputs', () => {
    expect(dripSendIdempotencyKey(base)).toBe(dripSendIdempotencyKey({ ...base }));
  });

  it.each([
    ['orgId', { orgId: 'org-2' }],
    ['sequenceId', { sequenceId: 'seq-2' }],
    ['enrollmentId (re-enrolment)', { enrollmentId: 'enr-2' }],
    ['stepIndex', { stepIndex: 1 }],
    ['attemptEpoch', { attemptEpoch: 1 }],
  ])('changes when %s changes', (_n, patch) => {
    expect(dripSendIdempotencyKey({ ...base, ...patch })).not.toBe(dripSendIdempotencyKey(base));
  });

  it('does not collide across field boundaries', () => {
    const a = dripSendIdempotencyKey({ ...base, orgId: 'a:b', sequenceId: 'c' });
    const b = dripSendIdempotencyKey({ ...base, orgId: 'a', sequenceId: 'b:c' });
    expect(a).not.toBe(b);
  });

  it('is header-safe and <=256 chars for unusual IDs', () => {
    const key = dripSendIdempotencyKey({
      orgId: 'ørg 🚀 "quoted"\n',
      sequenceId: 'x'.repeat(5000),
      enrollmentId: '../../etc/passwd',
      stepIndex: 7,
    });
    expect(key.length).toBeLessThanOrEqual(256);
    expect(key).toMatch(SAFE);
  });

  it('rejects invalid stepIndex', () => {
    expect(() => dripSendIdempotencyKey({ ...base, stepIndex: -1 })).toThrow();
    expect(() => dripSendIdempotencyKey({ ...base, stepIndex: 1.5 })).toThrow();
  });
});

describe('decideDuplicateSend', () => {
  const key = dripSendIdempotencyKey(base);
  const now = 1_000_000;
  const staleQueuedMs = 60_000;

  it('sends when there is no prior send', () => {
    expect(decideDuplicateSend({ key, priorSends: [], now, staleQueuedMs })).toEqual({ send: true });
  });

  it('blocks when already sent', () => {
    expect(
      decideDuplicateSend({ key, priorSends: [{ key, status: 'sent', at: now - 10 }], now, staleQueuedMs }),
    ).toEqual({ send: false, reason: 'already_sent' });
  });

  it('blocks a fresh queued send as in_flight', () => {
    expect(
      decideDuplicateSend({ key, priorSends: [{ key, status: 'queued', at: now - 1000 }], now, staleQueuedMs }),
    ).toEqual({ send: false, reason: 'in_flight' });
  });

  it('allows retry of a stale queued send', () => {
    expect(
      decideDuplicateSend({
        key,
        priorSends: [{ key, status: 'queued', at: new Date(now - staleQueuedMs) }],
        now: new Date(now),
        staleQueuedMs,
      }),
    ).toEqual({ send: true });
  });

  it('allows retry after a failed send', () => {
    expect(
      decideDuplicateSend({ key, priorSends: [{ key, status: 'failed', at: now - 10 }], now, staleQueuedMs }),
    ).toEqual({ send: true });
  });

  it('sent wins over a later failure for the same key', () => {
    expect(
      decideDuplicateSend({
        key,
        priorSends: [
          { key, status: 'sent', at: now - 500 },
          { key, status: 'failed', at: now - 10 },
        ],
        now,
        staleQueuedMs,
      }),
    ).toEqual({ send: false, reason: 'already_sent' });
  });

  it('ignores prior sends for other keys', () => {
    expect(
      decideDuplicateSend({ key, priorSends: [{ key: 'drip:v1:other', status: 'sent', at: now }], now, staleQueuedMs }),
    ).toEqual({ send: true });
  });

  it('fails closed on non-finite queued timing instead of authorizing a send', () => {
    const k = 'drip:v1:x';
    expect(() =>
      decideDuplicateSend({ key: k, priorSends: [{ key: k, status: 'queued', at: new Date(NaN) }], now: 1000, staleQueuedMs: 60_000 }),
    ).toThrow('invalid duplicate-send timing');
    expect(() =>
      decideDuplicateSend({ key: k, priorSends: [{ key: k, status: 'queued', at: 900 }], now: NaN, staleQueuedMs: 60_000 }),
    ).toThrow('invalid duplicate-send timing');
    expect(() =>
      decideDuplicateSend({ key: k, priorSends: [{ key: k, status: 'queued', at: 900 }], now: 1000, staleQueuedMs: NaN }),
    ).toThrow('invalid duplicate-send timing');
  });
});
