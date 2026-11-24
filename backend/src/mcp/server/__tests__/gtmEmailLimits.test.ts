/**
 * ENG-2840 (W2-4 follow-up): the limits on `send_gtm_status_report`, with a fake clock. What each limit refuses, what it lets through, and
 * that a refusal says what happened and when to try again.
 */
import {
  GTM_EMAIL_COOLDOWN_MS,
  GTM_EMAIL_HOURLY_BUDGET,
  GTM_EMAIL_MAX_MESSAGE_CHARS,
  GTM_EMAIL_MAX_RECIPIENTS,
  GTM_EMAIL_WINDOW_MS,
  GtmEmailLimiter,
  reportFingerprint,
} from '../gtmEmailLimits';

const MINUTE = 60_000;

function limiterAt(start = 1_000_000_000) {
  let now = start;
  const limiter = new GtmEmailLimiter(() => now);
  return { limiter, advance: (ms: number) => { now += ms; }, now: () => now };
}
function ok(reservation: ReturnType<GtmEmailLimiter['reserve']>) {
  if (!reservation.ok) throw new Error(`expected a reservation, got a refusal: ${reservation.message}`);
  return reservation.ticket;
}

describe('the numbers', () => {
  it('are the ones the owner decided: 10 people a call, 50 emails an hour, 10 minutes between identical reports, 2,000 characters', () => {
    expect(GTM_EMAIL_MAX_RECIPIENTS).toBe(10);
    expect(GTM_EMAIL_HOURLY_BUDGET).toBe(50);
    expect(GTM_EMAIL_WINDOW_MS).toBe(60 * MINUTE);
    expect(GTM_EMAIL_COOLDOWN_MS).toBe(10 * MINUTE);
    expect(GTM_EMAIL_MAX_MESSAGE_CHARS).toBe(2000);
  });
});

describe('the cooldown on an identical report', () => {
  it('refuses the same report from the same key within 10 minutes, and allows it again after', () => {
    const { limiter, advance } = limiterAt();
    ok(limiter.reserve('key-1', 'fp-a', 1));

    const refused = limiter.reserve('key-1', 'fp-a', 1);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('cooldown');
      expect(refused.retryAfterMs).toBe(10 * MINUTE);
      expect(refused.message).toContain('Nothing was emailed');
      expect(refused.message).toContain('about 10 minutes');
    }

    advance(10 * MINUTE - 1);
    expect(limiter.reserve('key-1', 'fp-a', 1).ok).toBe(false);
    advance(1);
    expect(limiter.reserve('key-1', 'fp-a', 1).ok).toBe(true);
  });

  it('says how long is left, rounded up', () => {
    const { limiter, advance } = limiterAt();
    ok(limiter.reserve('key-1', 'fp-a', 1));
    advance(7 * MINUTE + 1);
    const refused = limiter.reserve('key-1', 'fp-a', 1);
    expect(!refused.ok && refused.message).toContain('wait about 3 minutes');
  });

  it('a different report, or the same report from another key, is not held', () => {
    const { limiter } = limiterAt();
    ok(limiter.reserve('key-1', 'fp-a', 1));
    expect(limiter.reserve('key-1', 'fp-b', 1).ok).toBe(true);
    expect(limiter.reserve('key-2', 'fp-a', 1).ok).toBe(true);
  });

  it('is checked before the budget: a repeat of a report is "identical report", not "budget"', () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 5; i++) ok(limiter.reserve('key-1', `fp-${i}`, 10)); // the hour is spent
    const refused = limiter.reserve('key-1', 'fp-0', 10);
    expect(!refused.ok && refused.reason).toBe('cooldown');
  });
});

describe('the hourly budget', () => {
  it('lets a key reserve up to 50 emails in an hour and refuses the next call, naming the numbers', () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 5; i++) ok(limiter.reserve('key-1', `fp-${i}`, 10));
    expect(limiter.used('key-1')).toBe(50);

    const refused = limiter.reserve('key-1', 'fp-new', 1);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('budget');
      expect(refused.message).toContain('50 of the 50 emails');
      expect(refused.message).toContain('this report could send up to 1 more');
      expect(refused.message).toContain('Nothing was emailed');
      expect(refused.retryAfterMs).toBe(GTM_EMAIL_WINDOW_MS);
    }
  });

  it('a call that does not fit is refused whole: 41 used and a call that could send 10 is refused, a call that could send 9 is not', () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 4; i++) ok(limiter.reserve('key-1', `fp-${i}`, 10));
    ok(limiter.reserve('key-1', 'fp-x', 1)); // 41 reserved
    expect(limiter.reserve('key-1', 'fp-big', 10).ok).toBe(false);
    expect(limiter.reserve('key-1', 'fp-fits', 9).ok).toBe(true);
    expect(limiter.used('key-1')).toBe(50);
  });

  it('reservations count while a call is in flight, so parallel calls cannot overshoot together', () => {
    const { limiter } = limiterAt();
    const first = limiter.reserve('key-1', 'fp-1', 30);
    const second = limiter.reserve('key-1', 'fp-2', 30); // started before the first finished
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it('settling gives back what was not attempted, never more than was reserved', () => {
    const { limiter } = limiterAt();
    const ticket = ok(limiter.reserve('key-1', 'fp-1', 10));
    limiter.settle(ticket, 3);
    expect(limiter.used('key-1')).toBe(3);
    limiter.settle(ticket, 99); // cannot grow back past what is counted now
    expect(limiter.used('key-1')).toBe(3);
    limiter.settle(ticket, -5);
    expect(limiter.used('key-1')).toBe(0);
    limiter.settle(ticket, 2.9); // whole emails
    expect(limiter.used('key-1')).toBe(0);
  });

  it('settle floors a fraction and keeps a reservation that is smaller', () => {
    const { limiter } = limiterAt();
    const ticket = ok(limiter.reserve('key-1', 'fp-1', 5));
    limiter.settle(ticket, 4.9);
    expect(limiter.used('key-1')).toBe(4);
  });

  it('a send only counts for an hour: after it, the budget is back', () => {
    const { limiter, advance } = limiterAt();
    for (let i = 0; i < 5; i++) ok(limiter.reserve('key-1', `fp-${i}`, 10));
    advance(GTM_EMAIL_WINDOW_MS - 1);
    expect(limiter.reserve('key-1', 'fp-late', 1).ok).toBe(false);
    advance(1);
    expect(limiter.used('key-1')).toBe(0);
    expect(limiter.reserve('key-1', 'fp-late', 1).ok).toBe(true);
  });

  it('is rolling, and the refusal says when enough of the oldest sends have left the hour', () => {
    const { limiter, advance } = limiterAt();
    ok(limiter.reserve('key-1', 'fp-1', 10)); // t = 0
    advance(20 * MINUTE);
    for (let i = 2; i <= 5; i++) ok(limiter.reserve('key-1', `fp-${i}`, 10)); // t = 20 min: 50 in all

    const refused = limiter.reserve('key-1', 'fp-6', 10);
    expect(refused.ok).toBe(false);
    // the first 10 leave at t = 60 min, i.e. in 40 minutes: room for 10 more
    if (!refused.ok) {
      expect(refused.retryAfterMs).toBe(40 * MINUTE);
      expect(refused.message).toContain('about 40 minutes');
    }
    advance(40 * MINUTE);
    expect(limiter.reserve('key-1', 'fp-6', 10).ok).toBe(true);
  });

  it('is per key: one key spending its hour does not touch another', () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 5; i++) ok(limiter.reserve('key-1', `fp-${i}`, 10));
    expect(limiter.reserve('key-1', 'fp-new', 1).ok).toBe(false);
    expect(limiter.reserve('key-2', 'fp-new', 10).ok).toBe(true);
    expect(limiter.used('key-2')).toBe(10);
  });
});

describe('release: the route refused before sending anything', () => {
  it('gives the whole reservation back and lets the same report be retried at once', () => {
    const { limiter } = limiterAt();
    const ticket = ok(limiter.reserve('key-1', 'fp-1', 10));
    expect(limiter.used('key-1')).toBe(10);

    limiter.release(ticket);
    expect(limiter.used('key-1')).toBe(0);
    expect(limiter.reserve('key-1', 'fp-1', 10).ok).toBe(true);
  });

  it('does not clear a cooldown that a later identical report started', () => {
    const { limiter, advance } = limiterAt();
    const first = ok(limiter.reserve('key-1', 'fp-1', 1));
    advance(11 * MINUTE); // the cooldown has passed; the same report starts again
    ok(limiter.reserve('key-1', 'fp-1', 1));
    limiter.release(first); // the first one finishes late
    expect(limiter.reserve('key-1', 'fp-1', 1).ok).toBe(false); // the second one's cooldown still holds
  });

  it('is safe to call after the key has been forgotten', () => {
    const { limiter, advance } = limiterAt();
    const ticket = ok(limiter.reserve('key-1', 'fp-1', 1));
    advance(2 * GTM_EMAIL_WINDOW_MS);
    expect(() => limiter.release(ticket)).not.toThrow();
    expect(() => limiter.settle(ticket, 0)).not.toThrow();
  });
});

describe('memory is bounded', () => {
  it('refuses a new key, rather than forgetting one that is being counted, once 1,000 keys are tracked', () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 1000; i++) ok(limiter.reserve(`key-${i}`, 'fp', 1));

    const refused = limiter.reserve('key-new', 'fp', 1);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toBe('capacity');
    expect(!refused.ok && refused.message).toContain('Nothing was emailed');
    // a key that is already tracked is not affected, and cannot be reset by the flood
    expect(limiter.reserve('key-0', 'fp-other', 1).ok).toBe(true);
    expect(limiter.reserve('key-0', 'fp', 1).ok).toBe(false); // still in its cooldown
  });

  it('forgets keys that have gone quiet, so capacity comes back', () => {
    const { limiter, advance } = limiterAt();
    for (let i = 0; i < 1000; i++) ok(limiter.reserve(`key-${i}`, 'fp', 1));
    advance(GTM_EMAIL_WINDOW_MS);
    expect(limiter.reserve('key-new', 'fp', 1).ok).toBe(true);
  });

  it('remembers at most 200 distinct reports per key; the oldest is forgotten first', () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 205; i++) ok(limiter.reserve('key-1', `fp-${i}`, 0));
    expect(limiter.reserve('key-1', 'fp-204', 0).ok).toBe(false); // the newest is remembered
    expect(limiter.reserve('key-1', 'fp-0', 0).ok).toBe(true); // the oldest was dropped
  });
});

describe('reportFingerprint', () => {
  const base = { planId: 'plan-1', phaseId: 'phase-1', flags: { notify_user: true, notify_phase_poc: true }, message: 'Status update' };

  it('is the same for the same report, whatever the order the choices were written in', () => {
    expect(reportFingerprint(base)).toBe(reportFingerprint({ ...base, flags: { notify_phase_poc: true, notify_user: true } }));
  });

  it('changes with the plan, the phase, who was chosen, and the message', () => {
    const fp = reportFingerprint(base);
    expect(reportFingerprint({ ...base, planId: 'plan-2' })).not.toBe(fp);
    expect(reportFingerprint({ ...base, phaseId: 'phase-2' })).not.toBe(fp);
    expect(reportFingerprint({ ...base, phaseId: undefined })).not.toBe(fp);
    expect(reportFingerprint({ ...base, flags: { notify_user: true } })).not.toBe(fp);
    expect(reportFingerprint({ ...base, message: 'Another update' })).not.toBe(fp);
    expect(reportFingerprint({ ...base, message: undefined })).not.toBe(fp);
  });

  it('does not run a plan and a phase together: an id that looks like the other part cannot collide', () => {
    expect(reportFingerprint({ planId: 'a', phaseId: 'b', flags: {} })).not.toBe(reportFingerprint({ planId: 'a-b', flags: {} }));
  });

  it('is a hash: it holds nothing of the message', () => {
    const fp = reportFingerprint({ ...base, message: 'confidential launch date' });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).not.toContain('confidential');
  });
});
