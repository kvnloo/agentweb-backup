/**
 * ENG-3163: RateLimiter takes an optional window length (third constructor
 * argument). The default stays one minute so every existing caller is unchanged.
 */
import { RateLimiter } from '../middleware/rateLimiter';

describe('RateLimiter window length', () => {
  const HOUR = 60 * 60 * 1000;
  let limiter: RateLimiter | undefined;

  afterEach(() => {
    limiter?.destroy();
    limiter = undefined;
    jest.restoreAllMocks();
  });

  it('keeps the one-minute window when no window is given', () => {
    limiter = new RateLimiter();
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    expect(limiter.check('k', 1).allowed).toBe(true);
    expect(limiter.check('k', 1).allowed).toBe(false);

    jest.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    expect(limiter.check('k', 1).allowed).toBe(true);
  });

  it('holds a blocked key for the whole custom window, then frees it', () => {
    limiter = new RateLimiter(60_000, 50_000, HOUR);
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    for (let i = 0; i < 3; i++) expect(limiter.check('k', 3).allowed).toBe(true);
    expect(limiter.check('k', 3).allowed).toBe(false);

    // 59 minutes later: still blocked (a one-minute window would have freed it).
    jest.spyOn(Date, 'now').mockReturnValue(now + 59 * 60_000);
    const blocked = limiter.check('k', 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.resetInMs).toBeGreaterThan(0);
    expect(blocked.resetInMs).toBeLessThanOrEqual(60_000);

    jest.spyOn(Date, 'now').mockReturnValue(now + HOUR + 1_000);
    expect(limiter.check('k', 3).allowed).toBe(true);
  });

  it('ignores an invalid window and falls back to one minute', () => {
    limiter = new RateLimiter(60_000, 50_000, -5);
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    expect(limiter.check('k', 1).allowed).toBe(true);
    jest.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    expect(limiter.check('k', 1).allowed).toBe(true);
  });
});
