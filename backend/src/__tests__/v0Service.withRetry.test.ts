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

import { withRetry } from "../services/v0Service";

// Use 1ms base delay for fast tests
const FAST = 1;

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
});
