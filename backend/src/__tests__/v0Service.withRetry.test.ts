/**
 * Tests for withRetry exponential backoff in v0Service.
 * Validates retry behavior on transient network errors vs non-retryable errors.
 */

// Minimal mocks to allow v0Service module to load
jest.mock("aws-sdk", () => {
  const mockFn = jest.fn().mockReturnValue({ promise: () => Promise.resolve() });
  const mockS3 = { putObject: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }) };
  return {
    __esModule: true,
    default: {
      DynamoDB: {
        DocumentClient: jest.fn().mockImplementation(() => ({
          put: mockFn, update: mockFn, get: mockFn, query: mockFn, delete: mockFn,
        })),
      },
      SecretsManager: jest.fn().mockImplementation(() => ({
        getSecretValue: jest.fn().mockReturnValue({
          promise: () => Promise.resolve({ SecretString: '{"apiKey":"test-key"}' }),
        }),
      })),
      S3: jest.fn().mockImplementation(() => mockS3),
      config: { update: jest.fn() },
    },
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        put: mockFn, update: mockFn, get: mockFn, query: mockFn, delete: mockFn,
      })),
    },
    S3: jest.fn().mockImplementation(() => mockS3),
    config: { update: jest.fn() },
  };
});

jest.mock("undici", () => ({
  Agent: jest.fn(),
  setGlobalDispatcher: jest.fn(),
}));

jest.mock("../utils/secretsManager", () => ({
  getV0ApiKey: jest.fn().mockResolvedValue("test-key"),
  getGitHubOrgToken: jest.fn().mockResolvedValue("test-token"),
  getVercelToken: jest.fn().mockResolvedValue("test-token"),
}));

jest.mock("../services/settingsService", () => ({
  settingsService: { getSetting: jest.fn().mockResolvedValue(null) },
}));

import { withRetry, describeError } from "../services/v0Service";

// Use 1ms base delay for fast tests
const FAST = 1;
// Large per-attempt timeout so timeout logic never fires in the retry tests below.
const NO_TIMEOUT = 60_000;

describe("withRetry", () => {
  it("SUCCESS: returns on first attempt if no error", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, "test-op", 3, FAST);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("SUCCESS: retries on 'fetch failed' and succeeds on 2nd attempt", async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce("recovered");

    const result = await withRetry(fn, "test-op", 3, FAST);
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("SUCCESS: retries on ECONNREFUSED and succeeds on 3rd attempt", async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce("finally");

    const result = await withRetry(fn, "test-op", 3, FAST);
    expect(result).toBe("finally");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("FAIL: exhausts all retries on persistent network error", async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed"));

    await expect(withRetry(fn, "test-op", 3, FAST)).rejects.toThrow("fetch failed");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("FAIL: does NOT retry on non-retryable errors (e.g. auth)", async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error("Unauthorized: invalid API key"));

    await expect(withRetry(fn, "test-op", 3, FAST)).rejects.toThrow("Unauthorized");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("FAIL: does NOT retry on validation errors", async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error("prompt must be a string"));

    await expect(withRetry(fn, "test-op", 3, FAST)).rejects.toThrow("prompt must be a string");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ENG-287: a v0 chat-create timeout (our synthetic 300s ceiling) should not be
  // re-burned 3× — that reproduces the ~15-min hang ENG-158 set out to kill. The
  // opt-in `retryOnTimeout: false` fails a timeout fast while keeping 5xx/network
  // retryable. Default behaviour (timeouts retryable) is unchanged for all other callers.
  const v0Timeout = () => {
    const e: any = new Error("v0 chat creation (additional page) timed out after 300s");
    e.code = "V0_CALL_TIMEOUT";
    return e;
  };

  it("DEFAULT: a timeout is still retryable (global behaviour unchanged)", async () => {
    const fn = jest.fn().mockRejectedValueOnce(v0Timeout()).mockResolvedValueOnce("ok");
    const result = await withRetry(fn, "test-op", 3, FAST, NO_TIMEOUT);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retryOnTimeout:false — does NOT retry a v0 timeout (fail fast)", async () => {
    const fn = jest.fn().mockRejectedValueOnce(v0Timeout());
    await expect(
      withRetry(fn, "test-op", 3, FAST, NO_TIMEOUT, { retryOnTimeout: false }),
    ).rejects.toThrow(/timed out/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retryOnTimeout:false — STILL retries a 5xx / network error", async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValueOnce("ok");
    const result = await withRetry(fn, "test-op", 3, FAST, NO_TIMEOUT, { retryOnTimeout: false });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("SUCCESS: retries on ETIMEDOUT", async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, "test-op", 3, FAST);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("SUCCESS: retries on socket hang up", async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, "test-op", 3, FAST);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // The v0 SDK throws `Error("HTTP <status>: <body>")` on non-2xx responses.
  // Transient 5xx/429 should be retried — this is the v0-outage symptom in the bug report.
  it("SUCCESS: retries on v0 HTTP 500 and recovers", async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('HTTP 500: {"error":{"code":"500","message":"Internal Server Error"}}'))
      .mockResolvedValueOnce("recovered");

    const result = await withRetry(fn, "v0 chat creation", 3, FAST);
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("SUCCESS: retries on HTTP 503 and 502", async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error("HTTP 503: Service Unavailable"))
      .mockRejectedValueOnce(new Error("HTTP 502: Bad Gateway"))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, "test-op", 3, FAST);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("SUCCESS: retries on HTTP 429 rate limit", async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error("HTTP 429: Too Many Requests"))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, "test-op", 3, FAST);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("FAIL: exhausts retries on persistent HTTP 500", async () => {
    const err = new Error('HTTP 500: {"error":{"code":"500","message":"Internal Server Error"}}');
    const fn = jest.fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err);

    await expect(withRetry(fn, "v0 chat creation", 3, FAST)).rejects.toThrow("HTTP 500");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("FAIL: does NOT retry on HTTP 4xx client errors (e.g. 400, 401, 404)", async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error("HTTP 400: Bad Request"));
    await expect(withRetry(fn, "test-op", 3, FAST)).rejects.toThrow("HTTP 400");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ENG-135/159: the underlying reason must be surfaced, never a bare "fetch failed".
  it("FAIL: surfaces the undici cause chain on the thrown error", async () => {
    const err: any = new TypeError("fetch failed");
    err.cause = new Error("Connect Timeout Error (api.v0.dev:443)");
    const fn = jest.fn().mockRejectedValue(err);

    await expect(withRetry(fn, "v0 chat creation", 2, FAST, NO_TIMEOUT)).rejects.toThrow(
      /Connect Timeout Error/
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // ENG-158: a v0 call that never resolves must fail loudly, not hang forever.
  it("FAIL: times out a hung call and reports a clear timeout error", async () => {
    const fn = jest.fn().mockImplementation(() => new Promise(() => {})); // never settles
    await expect(withRetry(fn, "v0 chat creation", 2, FAST, 20)).rejects.toThrow(/timed out/i);
    expect(fn).toHaveBeenCalledTimes(2); // timeout is retryable, so it retries then gives up
  });
});

describe("describeError", () => {
  it("unwraps the undici cause chain (fetch failed -> real reason)", () => {
    const err: any = new TypeError("fetch failed");
    err.cause = new Error("getaddrinfo ENOTFOUND api.v0.dev");
    const detail = describeError(err);
    expect(detail).toContain("fetch failed");
    expect(detail).toContain("ENOTFOUND api.v0.dev");
  });

  it("includes an AggregateError's inner failures", () => {
    const inner: any = new Error("Connect Timeout Error");
    inner.code = "UND_ERR_CONNECT_TIMEOUT";
    const agg: any = new Error("fetch failed");
    agg.cause = { name: "AggregateError", message: "", errors: [inner] };
    const detail = describeError(agg);
    expect(detail).toContain("fetch failed");
    expect(detail).toContain("Connect Timeout Error");
  });

  it("appends a distinct error code that is not already in the message", () => {
    const err: any = new Error("socket problem");
    err.code = "ECONNRESET";
    expect(describeError(err)).toContain("ECONNRESET");
  });

  it("preserves a v0 HTTP error body verbatim (no cause to unwrap)", () => {
    const err = new Error('HTTP 422: {"error":{"message":"insufficient credits"}}');
    expect(describeError(err)).toBe('HTTP 422: {"error":{"message":"insufficient credits"}}');
  });

  it("is safe on non-error inputs", () => {
    expect(describeError("plain string")).toBe("plain string");
    expect(describeError(undefined)).toBe("Unknown error");
  });
});
