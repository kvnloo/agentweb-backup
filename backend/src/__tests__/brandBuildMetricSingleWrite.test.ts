/**
 * ENG-848 — a brand-build outcome must produce exactly ONE durable metric row.
 *
 * `persistFailure` called `logCompletionMetric(...)` AND wrote its own
 * OnboardingMetrics row, on the stated premise that logCompletionMetric "only
 * writes a structured log line that rotates". That premise was false — it
 * writes a durable row too — so every failure landed twice.
 *
 * Measured in production 2026-08-04: 74 rows for 39 real attempts. The
 * heartbeat counts rows, so the denominator was doubled. It did not distort the
 * failure RATE (both copies carry the same status), but it made the sample look
 * twice its true size, and at ~5 attempts in the last active week that decides
 * whether a "below 10%" claim means anything at all.
 *
 * The duplicate pair was identifiable in the table by shape: same userId, same
 * durationMs, timestamps ~70ms apart, one carrying errorMessage and one not.
 */

const mockLogStepMetric = jest.fn();
jest.mock('../services/onboardingMetricsService', () => ({
  logStepMetric: (...a: unknown[]) => mockLogStepMetric(...a),
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), updateUser: jest.fn() },
}));

import { logCompletionMetric } from '../services/brandBuildStatusService';
import { triggerBrandBuildForUser } from '../services/onboardingBrandBuildService';
const { userDb } = require('../services/db');

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('ENG-848 — one durable metric row per brand-build outcome', () => {
  it('writes exactly one row for a failure', () => {
    logCompletionMetric('user-1', 'failed', 1234, 'no companyUrl on User record — cannot brand-build');
    expect(mockLogStepMetric).toHaveBeenCalledTimes(1);
  });

  it('carries the error message on that single row', () => {
    // The whole reason persistFailure wrote a second row was to attach this.
    // Losing it while removing the duplicate would trade one instrumentation
    // bug for another: the failure classes become unreadable.
    logCompletionMetric('user-1', 'failed', 1234, 'no companyUrl on User record — cannot brand-build');
    const [row] = mockLogStepMetric.mock.calls[0] as [Record<string, unknown>];
    expect(row.errorMessage).toBe('no companyUrl on User record — cannot brand-build');
    expect(row.step).toBe('brand-build');
    expect(row.status).toBe('failed');
  });

  it('keeps timeout distinct from a generic failure', () => {
    // "timeout" was previously unreachable through this function — only
    // persistFailure's own direct write could set it. If widening the type had
    // been missed, every >300s session would have been recorded as a plain
    // failure and the timeout class would have silently vanished from the
    // heartbeat it is reported in.
    logCompletionMetric('user-1', 'timeout', 300000, 'Emma session failed: brand-build Emma session timed out after 300000ms');
    const [row] = mockLogStepMetric.mock.calls[0] as [Record<string, unknown>];
    expect(row.status).toBe('timeout');
  });

  it('omits errorMessage entirely on success rather than writing an empty one', () => {
    logCompletionMetric('user-1', 'ready', 5000);
    expect(mockLogStepMetric).toHaveBeenCalledTimes(1);
    const [row] = mockLogStepMetric.mock.calls[0] as [Record<string, unknown>];
    expect(row.status).toBe('ready');
    expect(row).not.toHaveProperty('errorMessage');
  });

  // The isolated cases above cover logCompletionMetric's contract, but they
  // CANNOT observe the duplicate: logCompletionMetric was never the
  // duplicating party. persistFailure calling both writers was. This drives the
  // real failure path end to end, and is the case that fails on the old code.
  it('writes ONE row through the real failure path, not two', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'user-1' }); // no companyUrl
    userDb.updateUser.mockResolvedValue({ userId: 'user-1' });
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await triggerBrandBuildForUser('user-1');

    const brandBuildRows = mockLogStepMetric.mock.calls
      .map(([row]) => row as Record<string, unknown>)
      .filter((row) => row?.step === 'brand-build');
    expect(brandBuildRows).toHaveLength(1);
    expect(brandBuildRows[0].errorMessage).toBe(
      'no companyUrl on User record — cannot brand-build',
    );
    expect(brandBuildRows[0].status).toBe('failed');
  });

  it('still records a duration so p50/p95 stay computable', () => {
    logCompletionMetric('user-1', 'failed', 1234, 'boom');
    const [row] = mockLogStepMetric.mock.calls[0] as [Record<string, unknown>];
    expect(row.durationMs).toBe(1234);
  });
});
