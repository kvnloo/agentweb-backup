/**
 * ENG-1197 — per-account pacing of LinkedIn write actions.
 *
 * The regression being pinned is concrete: ten cancel-invitation calls arriving in
 * one parallel tool-call batch, twice, each followed ~17 seconds later by a revoked
 * LinkedIn session that locked the customer out for days.
 */

import {
  PACED_WRITE_ACTIONS,
  __resetWritePacerForTests,
  minGapMs,
  reserveWriteSlot,
} from '../services/linkedInWritePacer';

const ACCOUNT = 'tMgX8uZJTZWTG_mFY1aI2A';
const OTHER_ACCOUNT = 'b7S0eC2ITLS-ydjPEhj-5g';

/**
 * A virtual clock: sleeps advance time instead of elapsing it, so the suite pins
 * real spacing without waiting for it.
 */
function makeClock(startAt = 1_000_000) {
  let current = startAt;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
    // Midpoint jitter — deterministic, and leaves the gap exactly at its nominal value.
    random: () => 0.5,
  };
}

beforeEach(() => {
  __resetWritePacerForTests();
  process.env.LINKEDIN_WRITE_MIN_GAP_MS = '5000';
  process.env.LINKEDIN_WRITE_MAX_PER_HOUR = '30';
  process.env.LINKEDIN_WRITE_MAX_QUEUE_WAIT_MS = '60000';
});

afterEach(() => {
  delete process.env.LINKEDIN_WRITE_MIN_GAP_MS;
  delete process.env.LINKEDIN_WRITE_MAX_PER_HOUR;
  delete process.env.LINKEDIN_WRITE_MAX_QUEUE_WAIT_MS;
});

describe('which actions are paced', () => {
  it('covers cancel-invitation, the action that actually killed the sessions', () => {
    expect(PACED_WRITE_ACTIONS.has('cancel-invitation')).toBe(true);
  });

  it('covers every mutating action, and no read action', () => {
    for (const action of ['send-invite', 'send-message', 'send-inmail', 'accept-invitation']) {
      expect(PACED_WRITE_ACTIONS.has(action)).toBe(true);
    }
    for (const action of ['search-people', 'get-profile', 'get-company', 'list-sent-invitations']) {
      expect(PACED_WRITE_ACTIONS.has(action)).toBe(false);
    }
  });
});

describe('serialization of a parallel batch', () => {
  it('spaces ten simultaneous withdrawals instead of bursting them', async () => {
    const clock = makeClock();
    const grantedAt: number[] = [];

    // Exactly the shape of the 2026-07-12 batch: ten calls issued at once.
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        const slot = await reserveWriteSlot(ACCOUNT, clock);
        expect(slot.allowed).toBe(true);
        grantedAt.push(clock.now());
      }),
    );

    expect(grantedAt).toHaveLength(10);
    const sorted = [...grantedAt].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(5000);
    }
    // The whole batch now spans ~45s rather than arriving inside one second.
    expect(sorted[sorted.length - 1] - sorted[0]).toBeGreaterThanOrEqual(45_000);
  });

  it('grants the first write immediately — pacing is a floor, not a tax', async () => {
    const clock = makeClock();

    const slot = await reserveWriteSlot(ACCOUNT, clock);

    expect(slot).toEqual({ allowed: true, waitedMs: 0 });
  });

  it('does not delay a write that already arrived a full gap later', async () => {
    const clock = makeClock();
    await reserveWriteSlot(ACCOUNT, clock);
    clock.advance(6000);

    const slot = await reserveWriteSlot(ACCOUNT, clock);

    expect(slot).toEqual({ allowed: true, waitedMs: 0 });
  });

  it('never lets one account block another', async () => {
    const clock = makeClock();
    await reserveWriteSlot(ACCOUNT, clock);

    const slot = await reserveWriteSlot(OTHER_ACCOUNT, clock);

    // Jennifer's drain must not throttle Sue's account.
    expect(slot).toEqual({ allowed: true, waitedMs: 0 });
  });
});

describe('refusals', () => {
  it('refuses once the hourly ceiling is reached, without sleeping', async () => {
    process.env.LINKEDIN_WRITE_MAX_PER_HOUR = '3';
    const clock = makeClock();
    for (let i = 0; i < 3; i++) {
      clock.advance(6000);
      expect((await reserveWriteSlot(ACCOUNT, clock)).allowed).toBe(true);
    }
    const before = clock.now();

    const slot = await reserveWriteSlot(ACCOUNT, clock);

    expect(slot.allowed).toBe(false);
    expect(clock.now()).toBe(before); // refused immediately, did not park the caller
    if (!slot.allowed) {
      expect(slot.reason).toContain('safety ceiling');
      expect(slot.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('lets the ceiling recover once the rolling window passes', async () => {
    process.env.LINKEDIN_WRITE_MAX_PER_HOUR = '2';
    const clock = makeClock();
    clock.advance(6000);
    await reserveWriteSlot(ACCOUNT, clock);
    clock.advance(6000);
    await reserveWriteSlot(ACCOUNT, clock);
    expect((await reserveWriteSlot(ACCOUNT, clock)).allowed).toBe(false);

    clock.advance(60 * 60 * 1000 + 1);

    expect((await reserveWriteSlot(ACCOUNT, clock)).allowed).toBe(true);
  });

  it('refuses rather than parking a caller behind an over-long queue', async () => {
    // A 40-invite drain would otherwise hold a request open for minutes and blow
    // the run's own timeouts.
    process.env.LINKEDIN_WRITE_MAX_QUEUE_WAIT_MS = '10000';
    process.env.LINKEDIN_WRITE_MAX_PER_HOUR = '100';
    const clock = makeClock();

    const inFlight = Array.from({ length: 6 }, () => reserveWriteSlot(ACCOUNT, clock));
    const late = await reserveWriteSlot(ACCOUNT, clock);

    expect(late.allowed).toBe(false);
    if (!late.allowed) expect(late.reason).toContain('already queued');
    await Promise.all(inFlight);
  });

  it('reports the hourly refusal before the queue refusal', async () => {
    // Both can be true at once; the ceiling is the more informative answer.
    process.env.LINKEDIN_WRITE_MAX_PER_HOUR = '1';
    process.env.LINKEDIN_WRITE_MAX_QUEUE_WAIT_MS = '0';
    const clock = makeClock();
    await reserveWriteSlot(ACCOUNT, clock);

    const slot = await reserveWriteSlot(ACCOUNT, clock);

    expect(slot.allowed).toBe(false);
    if (!slot.allowed) expect(slot.reason).toContain('safety ceiling');
  });
});

describe('resilience', () => {
  it('does not wedge an account when a queued caller rejects', async () => {
    const clock = makeClock();
    // The first write is granted immediately and never sleeps, so a second one is
    // needed to reach the waiting path that can throw.
    await reserveWriteSlot(ACCOUNT, clock);
    const failing = reserveWriteSlot(ACCOUNT, {
      ...clock,
      sleep: async () => {
        throw new Error('aborted mid-wait');
      },
    });
    await expect(failing).rejects.toThrow('aborted mid-wait');
    clock.advance(6000);

    // The next caller must still be served rather than waiting on a dead chain.
    await expect(reserveWriteSlot(ACCOUNT, clock)).resolves.toMatchObject({ allowed: true });
  });

  it('can be disabled entirely for incident response', async () => {
    process.env.LINKEDIN_WRITE_MIN_GAP_MS = '0';
    process.env.LINKEDIN_WRITE_MAX_PER_HOUR = '0';
    const clock = makeClock();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => reserveWriteSlot(ACCOUNT, clock)),
    );

    expect(results.every((r) => r.allowed)).toBe(true);
    expect(clock.now()).toBe(1_000_000);
  });

  it('never lets a malformed env var produce a NaN delay', async () => {
    // A NaN gap would make every wait computation NaN and silently stop pacing —
    // the failure mode this whole module exists to prevent.
    for (const bad of ['not-a-number', '', '-1']) {
      process.env.LINKEDIN_WRITE_MIN_GAP_MS = bad;
      expect(Number.isFinite(minGapMs())).toBe(true);
      expect(minGapMs()).toBeGreaterThanOrEqual(0);
    }

    process.env.LINKEDIN_WRITE_MIN_GAP_MS = '2500';
    expect(minGapMs()).toBe(2500);
  });
});

describe('default dependencies', () => {
  it('paces with a real timer when no deps are injected', async () => {
    // Everything above injects a virtual clock, which leaves the production
    // sleep/now/random path unexercised. A 20ms gap makes it real but instant.
    process.env.LINKEDIN_WRITE_MIN_GAP_MS = '20';
    process.env.LINKEDIN_WRITE_MAX_PER_HOUR = '10';

    const startedAt = Date.now();
    const first = await reserveWriteSlot(ACCOUNT);
    const second = await reserveWriteSlot(ACCOUNT);
    const elapsed = Date.now() - startedAt;

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    // The second call really waited, using setTimeout and Math.random jitter.
    expect(elapsed).toBeGreaterThanOrEqual(10);
  });
});

describe('the hourly ceiling under concurrency (Greptile P1)', () => {
  it('does not let a simultaneous batch overshoot the ceiling', async () => {
    // The entry-time check runs BEFORE queueing, so with the cap one write away
    // every concurrent caller reads the same under-cap history and passes it. Only
    // a re-check taken while holding the turn sees what the callers ahead recorded.
    process.env.LINKEDIN_WRITE_MAX_PER_HOUR = '3';
    process.env.LINKEDIN_WRITE_MAX_QUEUE_WAIT_MS = '600000';
    const clock = makeClock();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserveWriteSlot(ACCOUNT, clock)),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect(results.filter((r) => !r.allowed)).toHaveLength(7);
  });

  it('refuses an over-cap caller without making it wait out the gap first', async () => {
    process.env.LINKEDIN_WRITE_MAX_PER_HOUR = '2';
    process.env.LINKEDIN_WRITE_MAX_QUEUE_WAIT_MS = '600000';
    const clock = makeClock();

    const results = await Promise.all(
      Array.from({ length: 4 }, () => reserveWriteSlot(ACCOUNT, clock)),
    );
    const refused = results.filter((r) => !r.allowed);

    expect(refused).toHaveLength(2);
    for (const r of refused) {
      if (!r.allowed) expect(r.reason).toContain('safety ceiling');
    }
    // Two grants means exactly one gap elapsed, not four.
    expect(clock.now()).toBe(1_000_000 + 5000);
  });

  it('still allows the full quota when calls arrive one at a time', async () => {
    process.env.LINKEDIN_WRITE_MAX_PER_HOUR = '3';
    const clock = makeClock();

    const outcomes = [];
    for (let i = 0; i < 3; i++) {
      clock.advance(6000);
      outcomes.push((await reserveWriteSlot(ACCOUNT, clock)).allowed);
    }

    // The re-check must not cost a legitimate caller its slot.
    expect(outcomes).toEqual([true, true, true]);
  });
});
