/**
 * Unit tests for the in-memory loop dispatch tracker.
 *
 * Tracks Slack message timestamps that have already been dispatched to
 * cloud-dev so a second ✅ reaction on the same daily-digest DM does NOT
 * fire duplicate EC2 launches.
 *
 * Trade-off (v1): in-memory Map resets on backend redeploy. A dispatched
 * message could re-dispatch once after a deploy. Acceptable for now; v2
 * will move to DynamoDB AW-LoopDispatches if it bites.
 */

import {
  markDispatched,
  isDispatched,
  getDispatched,
  _resetForTesting,
  _sweepForTesting,
  TTL_MS,
} from '../services/loopDispatchTracker';

describe('loopDispatchTracker', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  describe('isDispatched / markDispatched', () => {
    it('returns false for a never-seen messageTs', () => {
      expect(isDispatched('1234567890.000001')).toBe(false);
    });

    it('returns true after markDispatched is called', () => {
      markDispatched('1234567890.000001', ['page-a', 'page-b']);
      expect(isDispatched('1234567890.000001')).toBe(true);
    });

    it('marking twice does not throw and idempotently keeps it dispatched', () => {
      markDispatched('1234567890.000001', ['page-a']);
      markDispatched('1234567890.000001', ['page-b']);
      expect(isDispatched('1234567890.000001')).toBe(true);
    });

    it('different messageTs values are independent', () => {
      markDispatched('1234567890.000001', ['page-a']);
      expect(isDispatched('1234567890.000001')).toBe(true);
      expect(isDispatched('1234567890.000002')).toBe(false);
    });
  });

  describe('getDispatched', () => {
    it('returns null for unknown messageTs', () => {
      expect(getDispatched('1234567890.000001')).toBeNull();
    });

    it('returns dispatchedAt + pageIds after markDispatched', () => {
      const before = Date.now();
      markDispatched('1234567890.000001', ['page-a', 'page-b']);
      const after = Date.now();

      const entry = getDispatched('1234567890.000001');
      expect(entry).not.toBeNull();
      expect(entry!.pageIds).toEqual(['page-a', 'page-b']);
      expect(entry!.dispatchedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(entry!.dispatchedAt.getTime()).toBeLessThanOrEqual(after);
    });
  });

  describe('TTL sweep', () => {
    it('removes entries older than the TTL', () => {
      markDispatched('1234567890.000001', ['page-a']);
      expect(isDispatched('1234567890.000001')).toBe(true);

      // Simulate a clock 8 days in the future (TTL is 7 days)
      const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
      const fakeNow = Date.now() + eightDaysMs;
      _sweepForTesting(fakeNow);

      expect(isDispatched('1234567890.000001')).toBe(false);
    });

    it('keeps entries that are still within the TTL', () => {
      markDispatched('1234567890.000001', ['page-a']);

      // 1 day later — still well within 7-day TTL
      const oneDayMs = 24 * 60 * 60 * 1000;
      const fakeNow = Date.now() + oneDayMs;
      _sweepForTesting(fakeNow);

      expect(isDispatched('1234567890.000001')).toBe(true);
    });

    it('sweeps only expired entries, leaving fresh ones intact', () => {
      // Stale entry: mark with timestamp in the distant past via getDispatched manipulation
      markDispatched('stale', ['page-a']);
      const staleEntry = getDispatched('stale')!;
      // Mutate dispatchedAt to be 8 days ago
      staleEntry.dispatchedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

      markDispatched('fresh', ['page-b']);

      _sweepForTesting(Date.now());

      expect(isDispatched('stale')).toBe(false);
      expect(isDispatched('fresh')).toBe(true);
    });
  });

  describe('TTL constant', () => {
    it('TTL is 7 days in milliseconds', () => {
      expect(TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });
  });
});
