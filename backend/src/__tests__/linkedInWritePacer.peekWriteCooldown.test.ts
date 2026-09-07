/**
 * Tests for `peekWriteCooldown` (ENG-1737) — the read-only status peek added
 * so `GET /api/crm/linkedin/daily-quota` can report "cooling down until HH:MM"
 * without side effects. Distinct from `reserveWriteSlot`'s own behavior tests
 * (none exist yet in this repo): this file only covers the peek, and it must
 * never itself write to the pacer's state.
 */
import {
  peekWriteCooldown,
  reserveWriteSlot,
  __resetWritePacerForTests,
} from '../services/linkedInWritePacer';

const GAP_ENV = 'LINKEDIN_WRITE_MIN_GAP_MS';
const HOURLY_ENV = 'LINKEDIN_WRITE_MAX_PER_HOUR';

describe('peekWriteCooldown', () => {
  const originalGap = process.env[GAP_ENV];
  const originalHourly = process.env[HOURLY_ENV];

  beforeEach(() => {
    __resetWritePacerForTests();
  });

  afterEach(() => {
    if (originalGap === undefined) delete process.env[GAP_ENV];
    else process.env[GAP_ENV] = originalGap;
    if (originalHourly === undefined) delete process.env[HOURLY_ENV];
    else process.env[HOURLY_ENV] = originalHourly;
    __resetWritePacerForTests();
  });

  it('reports inactive when both pacing limits are disabled (incident-response escape hatch)', () => {
    process.env[GAP_ENV] = '0';
    process.env[HOURLY_ENV] = '0';
    expect(peekWriteCooldown('acct-1')).toEqual({ active: false, expiresAt: null });
  });

  it('reports inactive for an account with no recorded writes', () => {
    process.env[GAP_ENV] = '5000';
    process.env[HOURLY_ENV] = '120';
    expect(peekWriteCooldown('acct-never-written')).toEqual({ active: false, expiresAt: null });
  });

  it('reports active and an expiry after a real write, from the gap alone', async () => {
    process.env[GAP_ENV] = '5000';
    process.env[HOURLY_ENV] = '120';
    const now = Date.now();
    const slot = await reserveWriteSlot('acct-2', { now: () => now, sleep: async () => {}, random: () => 0 });
    expect(slot.allowed).toBe(true);

    const result = peekWriteCooldown('acct-2', now);
    expect(result.active).toBe(true);
    expect(result.expiresAt).not.toBeNull();
    expect(new Date(result.expiresAt!).getTime()).toBeGreaterThan(now);
  });

  it('reports inactive once the min-gap window has fully elapsed', async () => {
    process.env[GAP_ENV] = '5000';
    process.env[HOURLY_ENV] = '120';
    const writtenAt = Date.now();
    await reserveWriteSlot('acct-3', { now: () => writtenAt, sleep: async () => {}, random: () => 0 });

    const laterCheck = writtenAt + 10_000; // well past a 5s (x1.2 max jitter) gap
    expect(peekWriteCooldown('acct-3', laterCheck)).toEqual({ active: false, expiresAt: null });
  });

  it('reports active with the ceiling expiry when the account is at the hourly cap', () => {
    process.env[GAP_ENV] = '0';
    process.env[HOURLY_ENV] = '2';
    const base = Date.now();
    // Two rapid writes exhaust an hourly cap of 2 with the gap disabled.
    process.env[GAP_ENV] = '0';
    return (async () => {
      await reserveWriteSlot('acct-4', { now: () => base, sleep: async () => {}, random: () => 0 });
      await reserveWriteSlot('acct-4', { now: () => base + 1, sleep: async () => {}, random: () => 0 });

      const result = peekWriteCooldown('acct-4', base + 2);
      expect(result.active).toBe(true);
      expect(new Date(result.expiresAt!).getTime()).toBe(base + 60 * 60 * 1000);
    })();
  });

  it('never mutates pacer state — two consecutive peeks return the same answer', async () => {
    process.env[GAP_ENV] = '5000';
    process.env[HOURLY_ENV] = '120';
    const now = Date.now();
    await reserveWriteSlot('acct-5', { now: () => now, sleep: async () => {}, random: () => 0 });

    const first = peekWriteCooldown('acct-5', now);
    const second = peekWriteCooldown('acct-5', now);
    expect(second).toEqual(first);
  });
});
