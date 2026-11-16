import {
  withRetry,
  parseRetryAfterMs,
  setRateLimitBackoffConfig,
  V0_RATE_LIMITED_CODE,
} from "../services/v0Service";

// ENG-949: landing-page builds hit v0 rate limits; 429s must back off for the provider's
// window (Retry-After when sent), and exhaustion must surface as a distinct recoverable error.
describe("v0Service withRetry — 429 handling (ENG-949)", () => {
  afterEach(() => {
    jest.useRealTimers();
    setRateLimitBackoffConfig(20_000, 120_000);
  });

  it("parses Retry-After from headers (seconds and HTTP-date) and from SDK error bodies", () => {
    expect(parseRetryAfterMs({ response: { headers: { "retry-after": "7" } } }, "")).toBe(7000);
    const now = Date.parse("2026-10-20T00:00:00Z");
    expect(
      parseRetryAfterMs({ response: { headers: { "retry-after": "Tue, 20 Oct 2026 00:00:30 GMT" } } }, "", now)
    ).toBe(30_000);
    expect(parseRetryAfterMs({}, 'HTTP 429: {"error":"rate limited","retryAfter":12}')).toBe(12_000);
    expect(parseRetryAfterMs({}, "HTTP 429: too many requests")).toBeUndefined();
  });

  it("waits the Retry-After window before retrying a 429, then succeeds without duplicate work", async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0);
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 429: {"retry_after": 15}'))
      .mockResolvedValueOnce("ok");
    const p = withRetry(fn, "test", 3, 10, 60_000);
    await jest.advanceTimersByTimeAsync(14_999);
    expect(fn).toHaveBeenCalledTimes(1); // still honouring Retry-After
    await jest.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("uses the rate-limit floor (not the 2s generic backoff) when no Retry-After, capped", async () => {
    setRateLimitBackoffConfig(20_000, 25_000);
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0);
    const fn = jest.fn().mockRejectedValueOnce(new Error("HTTP 429: slow down")).mockResolvedValueOnce("ok");
    const p = withRetry(fn, "test", 3, 10, 60_000);
    await jest.advanceTimersByTimeAsync(19_999);
    expect(fn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe("ok");

    const huge = jest.fn().mockRejectedValueOnce(new Error('HTTP 429: {"retryAfter": 3600}')).mockResolvedValueOnce("ok");
    const p2 = withRetry(huge, "test", 3, 10, 60_000);
    await jest.advanceTimersByTimeAsync(25_000);
    await expect(p2).resolves.toBe("ok");
  });

  it("tags terminal 429 exhaustion as V0_RATE_LIMITED with a recoverable message", async () => {
    setRateLimitBackoffConfig(1, 1);
    const fn = jest.fn().mockRejectedValue(new Error("HTTP 429: rate limited"));
    const err: any = await withRetry(fn, "test", 2, 1, 60_000).catch((e) => e);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(err.code).toBe(V0_RATE_LIMITED_CODE);
    expect(err.message).toMatch(/rate limit reached.*retry the generation/i);
  });

  it("leaves non-429 retry behaviour unchanged", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("HTTP 400: bad"));
    const err: any = await withRetry(fn, "test", 3, 1, 60_000).catch((e) => e);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(err.code).toBeUndefined();
  });
});
