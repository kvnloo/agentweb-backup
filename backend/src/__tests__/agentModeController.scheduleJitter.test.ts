/**
 * ENG-1670 — every daily/weekly/monthly/hourly schedule fired at the exact same
 * UTC second forever, with zero jitter. Prod-confirmed two independent schedules
 * (different users, different purposes) both pinned to round-second marks
 * (14:00:00.000Z and 14:45:00.000Z), all sharing one OpenRouter/Gemini quota.
 * calculateNextRunTime now takes an optional jitterSeedId and nudges the result
 * forward by a stable, per-schedule 0-59s offset.
 *
 * These tests import the REAL exported function (not a copy-pasted duplicate —
 * see agentModeController.calculateNextRunTime.test.ts, which tests its own
 * inline copy and would not have caught a regression here).
 */

jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => []),
}));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: { getMarketingSystemPrompt: jest.fn() },
}));
jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn() },
}));
jest.mock('../services/db', () => ({
  scheduleDb: { getScheduleById: jest.fn(), updateScheduleAfterRun: jest.fn() },
}));

import { calculateNextRunTime, stableJitterSeconds } from '../controllers/agentModeController';

describe('stableJitterSeconds', () => {
  it('always returns a value in [0, 59]', () => {
    for (let i = 0; i < 2000; i++) {
      const value = stableJitterSeconds(`schedule-${i}`);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(59);
    }
  });

  it('is deterministic for the same id', () => {
    const id = 'd72a7ff0-a06d-4123-8e1a-3223adb7d4ae';
    expect(stableJitterSeconds(id)).toBe(stableJitterSeconds(id));
  });

  it('spreads different ids across a meaningfully wide range (not a constant)', () => {
    const values = new Set(Array.from({ length: 200 }, (_, i) => stableJitterSeconds(`sched-${i}`)));
    expect(values.size).toBeGreaterThan(20);
  });
});

describe('calculateNextRunTime — jitter (ENG-1670)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('without a jitterSeedId, behaves exactly as before (no jitter)', () => {
    const fromDate = new Date('2026-08-01T14:45:00.000Z');
    const result = calculateNextRunTime('daily', fromDate);
    expect(result.toISOString()).toBe('2026-08-02T14:45:00.000Z');
  });

  it('with a jitterSeedId, nudges the result forward by a stable offset, never earlier', () => {
    const fromDate = new Date('2026-08-01T14:45:00.000Z');
    const seedId = 'd72a7ff0-a06d-4123-8e1a-3223adb7d4ae';
    const jitter = stableJitterSeconds(seedId);
    const result = calculateNextRunTime('daily', fromDate, undefined, seedId);

    expect(result.getTime()).toBeGreaterThanOrEqual(new Date('2026-08-02T14:45:00.000Z').getTime());
    expect(result.getUTCSeconds()).toBe(jitter);
    expect(result.getUTCHours()).toBe(14);
    expect(result.getUTCMinutes()).toBe(45);
  });

  it('different schedules get different (deterministic) offsets', () => {
    const fromDate = new Date('2026-08-01T14:45:00.000Z');
    const resultA = calculateNextRunTime('daily', fromDate, undefined, 'schedule-a');
    const resultB = calculateNextRunTime('daily', fromDate, undefined, 'schedule-20');
    // schedule-20 is a known non-trivial hash (see stableJitterSeconds tests) —
    // asserting the two differ pins that jitter is actually per-schedule, not global.
    expect(resultA.getUTCSeconds()).not.toBe(resultB.getUTCSeconds());
  });

  // The actual bug this test class exists to prevent: a naive implementation
  // (additive setUTCSeconds, or an unbounded 0-119 range) drifts a schedule's
  // fire time later by up to a full minute EVERY cycle, forever, because the
  // "preserve time from fromDate" logic re-reads whatever the previous cycle's
  // jittered value left behind. Verified this empirically before landing the
  // fix — walk 10 daily cycles and confirm the result never drifts past a
  // single jitter application.
  it('does not drift across repeated daily cycles (regression: additive/overflow jitter)', () => {
    const seedId = 'schedule-20'; // known to hash to a non-trivial offset
    const jitter = stableJitterSeconds(seedId);
    expect(jitter).toBeGreaterThan(0);

    let current = new Date('2026-08-01T14:45:00.000Z');
    const seenSeconds = new Set<number>();
    for (let day = 0; day < 10; day++) {
      current = calculateNextRunTime('daily', current, undefined, seedId);
      expect(current.getUTCHours()).toBe(14);
      expect(current.getUTCMinutes()).toBe(45);
      seenSeconds.add(current.getUTCSeconds());
    }
    // Every cycle must land on the SAME jittered second — a compounding bug
    // would produce a growing set of distinct values (45, 46, 47, ... or
    // 45, 90%60=30, ...) instead of one stable value repeated 10 times.
    expect(seenSeconds.size).toBe(1);
    expect([...seenSeconds][0]).toBe(jitter);
  });

  it('does not drift across repeated weekly cycles', () => {
    const seedId = 'schedule-20';
    const jitter = stableJitterSeconds(seedId);
    let current = new Date('2026-08-01T14:45:00.000Z');
    for (let week = 0; week < 6; week++) {
      current = calculateNextRunTime('weekly', current, undefined, seedId);
      expect(current.getUTCSeconds()).toBe(jitter);
      expect(current.getUTCMinutes()).toBe(45);
    }
  });

  it('does not drift across repeated monthly cycles', () => {
    const seedId = 'schedule-20';
    const jitter = stableJitterSeconds(seedId);
    let current = new Date('2027-01-12T10:30:00.000Z'); // 2nd Tuesday of Jan 2027
    for (let month = 0; month < 6; month++) {
      current = calculateNextRunTime('monthly', current, undefined, seedId);
      expect(current.getUTCSeconds()).toBe(jitter);
      expect(current.getUTCMinutes()).toBe(30);
    }
  });

  it('does not drift across repeated every_n_days cycles', () => {
    const seedId = 'schedule-20';
    const jitter = stableJitterSeconds(seedId);
    let current = new Date('2026-08-01T14:45:00.000Z');
    for (let cycle = 0; cycle < 8; cycle++) {
      current = calculateNextRunTime('every_n_days', current, 3, seedId);
      expect(current.getUTCSeconds()).toBe(jitter);
      expect(current.getUTCMinutes()).toBe(45);
    }
  });
});
