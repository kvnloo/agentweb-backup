import {
  runWithConcurrency,
  BULK_ENRICH_CONCURRENCY,
} from '../services/crmEnrichmentConcurrency';

describe('crmEnrichmentConcurrency', () => {
  describe('BULK_ENRICH_CONCURRENCY', () => {
    it('exports a sane default cap (>=1, <50)', () => {
      expect(BULK_ENRICH_CONCURRENCY).toBeGreaterThanOrEqual(1);
      expect(BULK_ENRICH_CONCURRENCY).toBeLessThan(50);
    });
  });

  describe('runWithConcurrency', () => {
    it('returns immediately on empty array without invoking the worker', async () => {
      const worker = jest.fn();
      await runWithConcurrency([], 4, worker);
      expect(worker).not.toHaveBeenCalled();
    });

    it('processes every item exactly once', async () => {
      const items = Array.from({ length: 20 }, (_, i) => i);
      const seen: number[] = [];
      await runWithConcurrency(items, 4, async (n) => {
        seen.push(n);
      });
      expect(seen.sort((a, b) => a - b)).toEqual(items);
    });

    it('does not exceed the concurrency cap at any moment', async () => {
      let inFlight = 0;
      let max = 0;
      const items = Array.from({ length: 30 }, (_, i) => i);
      await runWithConcurrency(items, 5, async () => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      });
      expect(max).toBeLessThanOrEqual(5);
    });

    it('clamps a cap of 0 to at least 1 (does not deadlock)', async () => {
      const items = [1, 2, 3];
      const seen: number[] = [];
      await runWithConcurrency(items, 0, async (n) => {
        seen.push(n);
      });
      expect(seen.length).toBe(3);
    });

    it('isolates worker errors so siblings still run', async () => {
      const items = [1, 2, 3, 4];
      const seen: number[] = [];
      await runWithConcurrency(items, 2, async (n) => {
        if (n === 2) throw new Error('boom');
        seen.push(n);
      });
      expect(seen.sort((a, b) => a - b)).toEqual([1, 3, 4]);
    });
  });
});
