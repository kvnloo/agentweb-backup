/**
 * ENG-1197 — per-account pacing of LinkedIn write actions.
 *
 * The regression being pinned is concrete: ten cancel-invitation calls arriving in
 * one parallel tool-call batch, twice, each followed ~17 seconds later by a revoked
 * LinkedIn session that locked the customer out for days.
 */

import {
  DEFAULT_DAILY_INVITE_CAP,
  PACED_WRITE_ACTIONS,
  __resetWritePacerForTests,
  dailyInviteAbsoluteMax,
  dailyMessageCap,
  maxQueueWaitMs,
  minGapMs,
  reserveDailyVolumeSlot,
  reserveWriteSlot,
  resolveDailyInviteCap,
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
    // Midpoint jitter — deterministic. Jitter is UPWARD only, so this yields
    // 1.1x the configured gap, never less than it.
    random: () => 0.5,
  };
}

beforeEach(() => {
  __resetWritePacerForTests();
  process.env.LINKEDIN_WRITE_MIN_GAP_MS = '5000';
  process.env.LINKEDIN_WRITE_MAX_PER_HOUR = '30';
  process.env.LINKEDIN_WRITE_MAX_QUEUE_WAIT_MS = '60000';
  // Daily caps are off (0) by default under Jest, same as the two above — opt back
  // in here to the real production values so this suite exercises the mechanism.
  process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = '30';
  process.env.LINKEDIN_DAILY_MESSAGE_CAP = '20';
});

afterEach(() => {
  delete process.env.LINKEDIN_WRITE_MIN_GAP_MS;
  delete process.env.LINKEDIN_WRITE_MAX_PER_HOUR;
  delete process.env.LINKEDIN_WRITE_MAX_QUEUE_WAIT_MS;
  delete process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX;
  delete process.env.LINKEDIN_DAILY_MESSAGE_CAP;
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

  it('counts its own slot and the jitter, so an admitted caller cannot wait past the cap', async () => {
    // `maxQueueWaitMs` is a promise: a call that is ADMITTED will not sit longer
    // than that. Estimating the wait as `queuedAhead * gap` broke that promise
    // twice over — it ignored the caller's own turn, and it used the nominal gap
    // when jitter can add 20%.
    process.env.LINKEDIN_WRITE_MIN_GAP_MS = '5000';
    process.env.LINKEDIN_WRITE_MAX_QUEUE_WAIT_MS = '30000';
    process.env.LINKEDIN_WRITE_MAX_PER_HOUR = '100';
    const clock = makeClock();
    // Maximum positive jitter: gap becomes 5000 + floor(5000 * 0.2 * 0.998) = 5998.
    const maxJitter = { ...clock, random: () => 0.999 };

    // A write already sits in the window, so EVERY queued call — the one at the
    // head included — must wait a full gap. Then five more queue up.
    await reserveWriteSlot(ACCOUNT, maxJitter);
    const inFlight = Array.from({ length: 5 }, () => reserveWriteSlot(ACCOUNT, maxJitter));

    const late = await reserveWriteSlot(ACCOUNT, maxJitter);

    // Counting only the five ahead at the nominal gap gives 25,000ms and admits it.
    // The real worst case is six jittered gaps — 35,988ms, well past the 30,000ms cap.
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
    // Asserting only `>= 0` passed on the bug: Number('') is 0, so an empty env var
    // read as a deliberate "no gap" and silently disabled pacing entirely.
    //
    // Checked through maxQueueWaitMs rather than minGapMs, because minGapMs's
    // fallback under Jest IS 0 — so a correct fallback and the bug are
    // indistinguishable there. This knob falls back to 60000 in every environment,
    // so the assertion can actually tell them apart.
    for (const bad of ['not-a-number', '', '   ', '-1']) {
      process.env.LINKEDIN_WRITE_MAX_QUEUE_WAIT_MS = bad;
      expect(maxQueueWaitMs()).toBe(60_000);
    }
    process.env.LINKEDIN_WRITE_MAX_QUEUE_WAIT_MS = '1234';
    expect(maxQueueWaitMs()).toBe(1234);

    // And an explicitly configured 0 must still be honoured as "off".
    process.env.LINKEDIN_WRITE_MIN_GAP_MS = '0';
    expect(minGapMs()).toBe(0);
    process.env.LINKEDIN_WRITE_MIN_GAP_MS = '2500';
    expect(minGapMs()).toBe(2500);

  });
});

describe('daily volume caps — self-reported, not detected (ENG-1197 follow-up)', () => {
  // Env vars (LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX=30, LINKEDIN_DAILY_MESSAGE_CAP=20)
  // are set in the file-level beforeEach above and cleaned up in the file-level
  // afterEach — no additional setup needed here.

  describe('resolveDailyInviteCap — the configured-cap resolution, no detection involved', () => {
    it('defaults to 10 when nothing has ever been configured', () => {
      expect(resolveDailyInviteCap(undefined)).toBe(DEFAULT_DAILY_INVITE_CAP);
      expect(resolveDailyInviteCap(null)).toBe(DEFAULT_DAILY_INVITE_CAP);
      expect(DEFAULT_DAILY_INVITE_CAP).toBe(10);
    });

    it('honors whatever the account self-reported, up to the absolute max', () => {
      expect(resolveDailyInviteCap(30)).toBe(30);
      expect(resolveDailyInviteCap(15)).toBe(15);
    });

    it('clamps a configured value above the absolute max — the ceiling always wins', () => {
      expect(resolveDailyInviteCap(9999)).toBe(30);
    });

    it('treats a user-configured 0 as a real "send nothing", not "unlimited"', () => {
      // This is the exact collision the first draft of this cap got wrong: the
      // operator env-var convention elsewhere in this file treats 0 as "disabled
      // entirely." A user typing 0 into their own daily cap means the opposite —
      // stop sending — and must not be silently reinterpreted as no limit.
      expect(resolveDailyInviteCap(0)).toBe(0);
    });

    it('is disabled system-wide only via the operator env var, never via the per-account value', () => {
      process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = '0';
      expect(resolveDailyInviteCap(5)).toBe(Infinity);
      expect(resolveDailyInviteCap(undefined)).toBe(Infinity);
    });

    it('ignores garbage input and falls back to the safe default', () => {
      expect(resolveDailyInviteCap(-5)).toBe(DEFAULT_DAILY_INVITE_CAP);
      expect(resolveDailyInviteCap(NaN)).toBe(DEFAULT_DAILY_INVITE_CAP);
    });
  });

  it('defaults the message cap to 20/day — flat, not self-reported', () => {
    expect(dailyMessageCap()).toBe(20);
  });

  it('is env-tunable, same convention as every other threshold in this file', () => {
    process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = '50';
    process.env.LINKEDIN_DAILY_MESSAGE_CAP = '15';
    expect(resolveDailyInviteCap(50)).toBe(50);
    expect(dailyMessageCap()).toBe(15);
  });

  /**
   * State is caller-owned now (persisted by agentModeService.ts, not module
   * memory — the CodeRabbit durability fix), so tests thread it through
   * explicitly the same way the real caller does: each call's `nextState`
   * becomes the next call's `persistedState`. This helper does that threading
   * for a run of N identical calls and returns the FINAL slot.
   */
  function sendN(times: number, action: string, cap: number | undefined, clock: ReturnType<typeof makeClock>) {
    let state: import('../services/linkedInWritePacer').DailyVolumeState | undefined;
    let last: ReturnType<typeof reserveDailyVolumeSlot> = { allowed: true, nextState: {} };
    for (let i = 0; i < times; i++) {
      last = reserveDailyVolumeSlot(action, cap, state, clock);
      if (last.allowed) state = last.nextState;
    }
    return { last, state };
  }

  it('allows an account with no configured cap up to 10 invites/day, then refuses the 11th', () => {
    const clock = makeClock();
    const { last: tenth, state } = sendN(10, 'send-invite', undefined, clock);
    expect(tenth.allowed).toBe(true);

    const slot = reserveDailyVolumeSlot('send-invite', undefined, state, clock);

    expect(slot.allowed).toBe(false);
    if (!slot.allowed) {
      expect(slot.reason).toContain('10 LinkedIn connection requests');
      expect(slot.reason).toContain('ceiling of 10');
      expect(slot.reason).toContain('configured daily cap');
      expect(slot.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('allows an account configured for 30/day to send past where the unconfigured default would refuse', () => {
    const clock = makeClock();
    const { last: thirtieth, state } = sendN(30, 'send-invite', 30, clock);
    expect(thirtieth.allowed).toBe(true);

    const slot = reserveDailyVolumeSlot('send-invite', 30, state, clock);

    expect(slot.allowed).toBe(false);
    if (!slot.allowed) expect(slot.reason).toContain('the system-wide maximum');
  });

  it('blocks every invite for an account that configured a cap of 0', () => {
    const clock = makeClock();

    const slot = reserveDailyVolumeSlot('send-invite', 0, undefined, clock);

    expect(slot.allowed).toBe(false);
  });

  it('shares one 20/day budget across send-message and send-inmail, independent of the invite cap', () => {
    const clock = makeClock();
    let state: import('../services/linkedInWritePacer').DailyVolumeState | undefined;
    for (let i = 0; i < 10; i++) {
      const slot = reserveDailyVolumeSlot('send-message', 30, state, clock);
      expect(slot.allowed).toBe(true);
      if (slot.allowed) state = slot.nextState;
    }
    for (let i = 0; i < 10; i++) {
      const slot = reserveDailyVolumeSlot('send-inmail', 30, state, clock);
      expect(slot.allowed).toBe(true);
      if (slot.allowed) state = slot.nextState;
    }

    const slot = reserveDailyVolumeSlot('send-message', 30, state, clock);

    expect(slot.allowed).toBe(false);
    if (!slot.allowed) expect(slot.reason).toContain('LinkedIn message');
  });

  it('tracks invites and messages independently — hitting one cap does not block the other', () => {
    const clock = makeClock();
    const { last: tenth, state } = sendN(10, 'send-invite', undefined, clock);
    expect(tenth.allowed).toBe(true);
    expect(reserveDailyVolumeSlot('send-invite', undefined, state, clock).allowed).toBe(false);

    expect(reserveDailyVolumeSlot('send-message', undefined, state, clock).allowed).toBe(true);
  });

  it('never lets one account\'s state leak into another\'s — the caller keys state per account, this module doesn\'t', () => {
    // There's no shared module state to leak from anymore (that's the whole
    // fix), so this just pins that undefined/fresh state for a different
    // account is unaffected by another account's exhausted state object.
    const clock = makeClock();
    const { state: exhaustedAccountState } = sendN(10, 'send-invite', undefined, clock);
    expect(reserveDailyVolumeSlot('send-invite', undefined, exhaustedAccountState, clock).allowed).toBe(false);

    expect(reserveDailyVolumeSlot('send-invite', undefined, undefined, clock).allowed).toBe(true);
  });

  it('recovers once the window (anchored at the first send) passes', () => {
    const clock = makeClock();
    const { last: tenth, state } = sendN(10, 'send-invite', undefined, clock);
    expect(tenth.allowed).toBe(true);
    expect(reserveDailyVolumeSlot('send-invite', undefined, state, clock).allowed).toBe(false);

    clock.advance(24 * 60 * 60 * 1000 + 1);

    expect(reserveDailyVolumeSlot('send-invite', undefined, state, clock).allowed).toBe(true);
  });

  it('exempts cancel-invitation and accept-invitation — account maintenance, not send volume', () => {
    const clock = makeClock();
    for (let i = 0; i < 100; i++) {
      expect(reserveDailyVolumeSlot('cancel-invitation', undefined, undefined, clock).allowed).toBe(true);
      expect(reserveDailyVolumeSlot('accept-invitation', undefined, undefined, clock).allowed).toBe(true);
    }
  });

  it('the operator escape hatch (absolute max = 0) disables the check entirely, for any configured value', () => {
    process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = '0';
    const clock = makeClock();

    const { last } = sendN(50, 'send-invite', undefined, clock);
    expect(last.allowed).toBe(true);
  });

  it('surviving a restart is the whole point: fresh state in, correct decision out — no memory required', () => {
    // The regression this exists to prevent: a process restart used to wipe
    // module-level state, silently resetting an exhausted account back to 0.
    // Simulate a "restart" between calls by literally not sharing any module
    // state — pass the exact persisted object back in, as agentModeService.ts
    // would after reading it fresh from the account's config post-restart.
    const clock = makeClock();
    const { last: tenth, state: persistedAfterTen } = sendN(10, 'send-invite', undefined, clock);
    expect(tenth.allowed).toBe(true);

    // "Restart": a brand-new call site, only the persisted state carried over.
    const postRestartSlot = reserveDailyVolumeSlot('send-invite', undefined, persistedAfterTen, clock);

    expect(postRestartSlot.allowed).toBe(false);
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
    // Two grants means ONE gap elapsed, not four: the three over-cap callers were
    // refused while holding the turn, before sleeping. Asserted as a range rather
    // than a literal so it pins that fact rather than the jitter's exact shape.
    const elapsed = clock.now() - 1_000_000;
    expect(elapsed).toBeGreaterThanOrEqual(5000);
    expect(elapsed).toBeLessThan(2 * 5000);
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
