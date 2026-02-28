import { RateLimiter } from '../middleware/rateLimiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  afterEach(() => {
    limiter.destroy();
  });

  describe('check', () => {
    it('should allow requests under the limit', () => {
      const result = limiter.check('key-1', 10);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
      expect(result.resetInMs).toBeGreaterThan(0);
      expect(result.resetInMs).toBeLessThanOrEqual(60000);
    });

    it('should track requests per key independently', () => {
      // Use up some for key-1
      for (let i = 0; i < 5; i++) {
        limiter.check('key-1', 10);
      }

      // key-2 should still have full capacity
      const result = limiter.check('key-2', 10);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
    });

    it('should deny requests when limit is exceeded', () => {
      // Use up all 3 requests
      for (let i = 0; i < 3; i++) {
        const r = limiter.check('key-1', 3);
        expect(r.allowed).toBe(true);
      }

      // 4th request should be denied
      const result = limiter.check('key-1', 3);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should return remaining count correctly', () => {
      const r1 = limiter.check('key-1', 5);
      expect(r1.remaining).toBe(4);

      const r2 = limiter.check('key-1', 5);
      expect(r2.remaining).toBe(3);

      const r3 = limiter.check('key-1', 5);
      expect(r3.remaining).toBe(2);
    });

    it('should handle limit of 1 correctly', () => {
      const r1 = limiter.check('key-1', 1);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(0);

      const r2 = limiter.check('key-1', 1);
      expect(r2.allowed).toBe(false);
      expect(r2.remaining).toBe(0);
    });

    it('should allow requests again after window expires', () => {
      // Use real timers but mock Date.now
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);

      // Use up all requests
      for (let i = 0; i < 3; i++) {
        limiter.check('key-1', 3);
      }

      // Should be denied
      expect(limiter.check('key-1', 3).allowed).toBe(false);

      // Advance time by 61 seconds (past the 1-minute window)
      jest.spyOn(Date, 'now').mockReturnValue(now + 61000);

      // Should be allowed again
      const result = limiter.check('key-1', 3);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);

      jest.restoreAllMocks();
    });
  });

  describe('cleanup', () => {
    it('should remove expired entries on cleanup', () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);

      limiter.check('key-1', 10);

      // Advance time past the window
      jest.spyOn(Date, 'now').mockReturnValue(now + 120000);

      limiter.cleanup();

      // After cleanup, key-1 should be cleared, new check gets full capacity
      const result = limiter.check('key-1', 10);
      expect(result.remaining).toBe(9);

      jest.restoreAllMocks();
    });
  });
});
