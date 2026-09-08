// ENG-1721 / ENG-1609 AC #6 — the warm-up ramp.
//
// Harsha queried Unipile directly for the account behind ENG-1132: premiumId
// null, no premium features (a FREE account), created_at ~24h before the block —
// refused at a target well under the 30/day ceiling. His conclusion: "this is
// very likely the DEFAULT new-customer failure mode, not an edge case."
//
// THE TRAP THIS SUITE HAS TO AVOID: dailyInviteAbsoluteMax() returns 0 under
// Jest, which resolveDailyInviteCap reads as "operator disabled -> Infinity".
// Every assertion about a ramp VALUE must set LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX
// explicitly or it silently asserts nothing at all.

import {
  LINKEDIN_WARMUP_RAMP,
  LINKEDIN_WARMUP_THROUGH_DAY,
  warmupInviteCap,
  resolveEffectiveDailyInviteCap,
  isWarmupLimitedInviteCap,
  resolveDailyInviteCap,
  reserveDailyVolumeSlot,
  remainingDailyInvites,
} from '../services/linkedInWritePacer';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-07T12:00:00.000Z');
/** An account connected `days` ago, where 0 = connected today (ramp day 1). */
const connectedDaysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

describe('the Jest guard this suite depends on', () => {
  it('is genuinely disabled by default, so an unguarded assertion would prove nothing', () => {
    // Documented here rather than assumed: without the env var below, the cap is
    // Infinity and every "ramped to 5" expectation would pass vacuously.
    expect(resolveDailyInviteCap(30)).toBe(Infinity);
    expect(resolveEffectiveDailyInviteCap(30, connectedDaysAgo(0), NOW)).toBe(Infinity);
  });
});

describe('warmupInviteCap — age is the only input', () => {
  it('ramps by connection age and then stops applying', () => {
    expect(LINKEDIN_WARMUP_RAMP).toEqual([
      { throughDay: 7, limit: 5 },
      { throughDay: 14, limit: 15 },
    ]);
    expect(LINKEDIN_WARMUP_THROUGH_DAY).toBe(14);

    // Day 1 is the day of connection itself.
    expect(warmupInviteCap(connectedDaysAgo(0), NOW)).toBe(5);
    expect(warmupInviteCap(connectedDaysAgo(6), NOW)).toBe(5); // day 7
    expect(warmupInviteCap(connectedDaysAgo(7), NOW)).toBe(15); // day 8
    expect(warmupInviteCap(connectedDaysAgo(13), NOW)).toBe(15); // day 14
    // AC #4: past the window there is no ramp at all.
    expect(warmupInviteCap(connectedDaysAgo(14), NOW)).toBeNull(); // day 15
    expect(warmupInviteCap(connectedDaysAgo(365), NOW)).toBeNull();
  });

  it('caps the reported iTrials shape — a ~24h-old free connection — at 5', () => {
    expect(warmupInviteCap('2026-08-25T18:18:15.338Z', Date.parse('2026-08-26T18:00:00.000Z'))).toBe(5);
  });

  it('never invents a restriction from absent or unusable data', () => {
    // All 16 unipile accounts in production carry a created_at, so this is a
    // defensive path. Throttling every account to 5/day on a missing timestamp
    // would be a far worse failure than leaving the configured cap alone.
    [undefined, null, '', '   ', 'not-a-date'].forEach((value) => {
      expect(warmupInviteCap(value as any, NOW)).toBeNull();
    });
  });

  it('floors a future-dated connection to the most conservative step, not out of the ramp', () => {
    expect(warmupInviteCap(new Date(NOW + 5 * DAY).toISOString(), NOW)).toBe(5);
  });
});

describe('resolveEffectiveDailyInviteCap', () => {
  const OLD_ENV = process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX;
  beforeEach(() => { process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = '30'; });
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX;
    else process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = OLD_ENV;
  });

  it('AC #1/#2: a new connection is ramped regardless of the requested target', () => {
    // The whole point: a user asking for 30 on a day-old connection gets 5.
    expect(resolveEffectiveDailyInviteCap(30, connectedDaysAgo(0), NOW)).toBe(5);
    expect(resolveEffectiveDailyInviteCap(30, connectedDaysAgo(10), NOW)).toBe(15);
    // And an unconfigured account (default 10) is ramped below its default too.
    expect(resolveEffectiveDailyInviteCap(undefined, connectedDaysAgo(0), NOW)).toBe(5);
  });

  it('AC #3: the ramp only ever LOWERS — a configured cap below it still wins', () => {
    expect(resolveEffectiveDailyInviteCap(3, connectedDaysAgo(0), NOW)).toBe(3);
    // Day 8-14 offers 15, but an unconfigured account is capped at its default 10.
    expect(resolveEffectiveDailyInviteCap(undefined, connectedDaysAgo(10), NOW)).toBe(10);
  });

  it('AC #4: an established account is unchanged from today\'s behaviour', () => {
    [30, 10, undefined].forEach((configured) => {
      expect(resolveEffectiveDailyInviteCap(configured, connectedDaysAgo(200), NOW))
        .toBe(resolveDailyInviteCap(configured));
    });
    // Production median connection age is 136 days, so this is the common path.
    expect(resolveEffectiveDailyInviteCap(30, connectedDaysAgo(136), NOW)).toBe(30);
  });

  it('AC #5: a user-configured 0 stays a real block, never "unlimited"', () => {
    expect(resolveEffectiveDailyInviteCap(0, connectedDaysAgo(0), NOW)).toBe(0);
    expect(resolveEffectiveDailyInviteCap(0, connectedDaysAgo(200), NOW)).toBe(0);
  });

  it('does not reintroduce a cap where the OPERATOR disabled the mechanism', () => {
    // The escape hatch must survive the ramp. Layering min(5, Infinity) on top
    // would newly throttle every account to 5/day at precisely the moment an
    // operator had switched the whole cap off — and would do it under Jest too.
    process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = '0';
    expect(resolveEffectiveDailyInviteCap(30, connectedDaysAgo(0), NOW)).toBe(Infinity);
    expect(isWarmupLimitedInviteCap(30, connectedDaysAgo(0), NOW)).toBe(false);
  });

  it('reports WHY the cap is what it is, so the refusal can be phrased honestly', () => {
    expect(isWarmupLimitedInviteCap(30, connectedDaysAgo(0), NOW)).toBe(true);
    // Not warm-up-limited when the configured cap is already the lower of the two.
    expect(isWarmupLimitedInviteCap(3, connectedDaysAgo(0), NOW)).toBe(false);
    expect(isWarmupLimitedInviteCap(30, connectedDaysAgo(200), NOW)).toBe(false);
  });
});

describe('enforcement — the ramp binds the actual send path', () => {
  const OLD_ENV = process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX;
  const now = () => NOW;
  beforeEach(() => { process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = '30'; });
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX;
    else process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = OLD_ENV;
  });

  it('AC #6: a "connected 1 day ago" account stops at the warm-up rate, not the requested target', () => {
    const connectedAt = connectedDaysAgo(0);
    let state: any = {};
    let allowed = 0;
    for (let i = 0; i < 30; i++) {
      const slot = reserveDailyVolumeSlot('send-invite', 30, state, { now, connectedAt });
      if (!slot.allowed) break;
      allowed++;
      state = slot.nextState;
    }
    expect(allowed).toBe(5);

    const refused = reserveDailyVolumeSlot('send-invite', 30, state, { now, connectedAt });
    if (refused.allowed) throw new Error('expected the warm-up cap to refuse the 6th send');
    expect(refused.reason).toContain('safety ceiling of 5');
  });

  it('the same account past the window gets its full configured 30', () => {
    const connectedAt = connectedDaysAgo(200);
    let state: any = {};
    let allowed = 0;
    for (let i = 0; i < 40; i++) {
      const slot = reserveDailyVolumeSlot('send-invite', 30, state, { now, connectedAt });
      if (!slot.allowed) break;
      allowed++;
      state = slot.nextState;
    }
    expect(allowed).toBe(30);
  });

  it('does not tell a warm-up account to raise a cap it cannot raise', () => {
    // "Raise it in Settings" is advice that cannot work here, and acting on it —
    // self-reporting Premium to lift the number — is exactly what gets a new
    // account throttled harder.
    const connectedAt = connectedDaysAgo(0);
    const exhausted = { invite: { count: 5, windowStartedAt: NOW } };
    const refused = reserveDailyVolumeSlot('send-invite', 30, exhausted, { now, connectedAt });

    if (refused.allowed) throw new Error('expected the warm-up cap to refuse this send');
    expect(refused.reason).toContain('ramped up gradually over its first 14 days');
    expect(refused.reason).not.toContain('raise it in Settings or ask Emma');
  });

  it('an established account still gets the configurable-cap wording', () => {
    const exhausted = { invite: { count: 10, windowStartedAt: NOW } };
    const refused = reserveDailyVolumeSlot('send-invite', 10, exhausted, {
      now, connectedAt: connectedDaysAgo(200),
    });
    if (refused.allowed) throw new Error('expected the configured cap to refuse this send');
    expect(refused.reason).toContain('raise it in Settings or ask Emma');
  });

  it('leaves send-message and send-inmail alone — the ramp is invites only', () => {
    process.env.LINKEDIN_DAILY_MESSAGE_CAP = '20';
    try {
      const connectedAt = connectedDaysAgo(0);
      let state: any = {};
      let allowed = 0;
      for (let i = 0; i < 25; i++) {
        const slot = reserveDailyVolumeSlot('send-message', 30, state, { now, connectedAt });
        if (!slot.allowed) break;
        allowed++;
        state = slot.nextState;
      }
      expect(allowed).toBe(20);
    } finally {
      delete process.env.LINKEDIN_DAILY_MESSAGE_CAP;
    }
  });

  it('the capacity gate measures headroom against the SAME ramped cap', () => {
    // A pre-send gate reading the unramped cap would wave a run through and let
    // the pacer refuse its very first send.
    const connectedAt = connectedDaysAgo(0);
    expect(remainingDailyInvites(30, undefined, { now, connectedAt })).toMatchObject({
      remaining: 5, cap: 5, used: 0,
    });
    expect(remainingDailyInvites(30, { invite: { count: 5, windowStartedAt: NOW } }, { now, connectedAt }))
      .toMatchObject({ remaining: 0, cap: 5, used: 5 });
    // Established account: unchanged.
    expect(remainingDailyInvites(30, undefined, { now, connectedAt: connectedDaysAgo(200) }))
      .toMatchObject({ remaining: 30, cap: 30 });
  });
});
