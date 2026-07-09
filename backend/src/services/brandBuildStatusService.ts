/**
 * Brand build status — Onboarding v2 Phase 1.
 *
 * Pure state-transition logic for the async brand build state machine. This
 * service intentionally does NOT touch DynamoDB so it can be unit-tested
 * without mocking AWS. Callers (routes, agentModeService) pass in the
 * current persisted fields and receive a partial `User` patch to persist.
 *
 * State machine:
 *   (none) → building
 *   building → ready    (when brandGuidelines is written)
 *   building → failed   (on timeout or error)
 *   ready   → building  (allowed — user can re-run brand build from Settings)
 *   failed  → building  (allowed — retry)
 *
 * Once `ready` or `failed`, the build is terminal until a new `start` is
 * explicitly called. The frontend pill derives its copy from these states.
 *
 * Metrics are emitted via a structured console log on completion so the
 * existing log-pipeline scraper can compute p50/p99 without introducing a
 * new Datadog dependency. Log line format (grep-able):
 *   [metrics] brand_build_complete status=<ready|failed> duration_ms=<num> user=<userId-prefix>
 */

export type BrandBuildStatus = "building" | "ready" | "failed";

export interface BrandBuildStatusFields {
  brandBuildStatus?: BrandBuildStatus;
  brandBuildStartedAt?: string;
  brandBuildCompletedAt?: string;
  brandBuildDurationMs?: number;
  brandBuildError?: string;
}

export interface StatusSnapshot extends BrandBuildStatusFields {
  /** True when the last started build is still in flight (status=building). */
  inFlight: boolean;
  /**
   * True when `/start` was called but no website URL could be resolved for the
   * user, so no build was started (see ENG-238). The UI should route the user
   * to the "no website" collaborative path instead of showing a spinner —
   * starting a build with no URL is dead-on-arrival and immediately fails.
   */
  needsUrl?: boolean;
  /**
   * True when a previously-started build has exceeded the timeout budget
   * (90s target from the task body). The caller should trip the status to
   * `failed` on the next write and surface the graceful-fallback UX.
   */
  timedOut: boolean;
}

/**
 * UI/status budget — the point at which `snapshot.timedOut` flips true and the
 * pill offers the graceful-fallback manual input.
 *
 * This MUST match the real server-side Emma session budget
 * (`onboardingBrandBuildService.BRAND_BUILD_TIMEOUT_MS`, currently 300s). It
 * was previously a stale 90s left over from an earlier 90s target — but the
 * server session budget was later raised to 300s (web research + scrape +
 * multiple `update_*` tool calls routinely take 90s–300s; telemetry p95 ≈ 5m).
 * With the old 90s value, a build that was legitimately still running was
 * reported as timed out and the client stopped polling before the server
 * finished, so successful builds surfaced as failures. Keep this in lock-step
 * with the server budget.
 */
export const BRAND_BUILD_TIMEOUT_MS = 300_000;

/**
 * Hard watchdog wall. A build still in `building` past this age is treated as
 * dead (its fire-and-forget background job was lost to a deploy / instance
 * recycle / crash) and force-failed on the next status read so the UI shows a
 * visible error + retry instead of an infinite spinner.
 *
 * Set ABOVE the server session budget so, in the normal case, the server's own
 * `persistFailure` (which writes a descriptive error at 300s) wins the race and
 * this watchdog only fires for genuinely-orphaned builds.
 */
export const BRAND_BUILD_HARD_TIMEOUT_MS = 330_000;

/**
 * Compute a patch that marks the brand build as just-started. Idempotent: if
 * a build is already in-flight, the patch still resets the clock — this is
 * intentional so a user retrying from the UI gets a fresh latency estimate.
 */
export function buildStartPatch(now: Date = new Date()): BrandBuildStatusFields {
  return {
    brandBuildStatus: "building",
    brandBuildStartedAt: now.toISOString(),
    brandBuildCompletedAt: undefined,
    brandBuildDurationMs: undefined,
    brandBuildError: undefined,
  };
}

/**
 * Compute a patch that marks the brand build as successfully completed.
 * Returns `null` if the user was not in `building` state — completion
 * events from non-building states are ignored (prevents double-writes from
 * noisy upstream hooks bumping the duration metric).
 */
export function buildReadyPatch(
  current: BrandBuildStatusFields,
  now: Date = new Date()
): BrandBuildStatusFields | null {
  if (current.brandBuildStatus !== "building") {
    return null;
  }
  const startedAt = current.brandBuildStartedAt
    ? Date.parse(current.brandBuildStartedAt)
    : NaN;
  const completedAtMs = now.getTime();
  const duration = Number.isFinite(startedAt)
    ? completedAtMs - startedAt
    : 0;
  return {
    brandBuildStatus: "ready",
    brandBuildCompletedAt: now.toISOString(),
    brandBuildDurationMs: Math.max(0, duration),
    brandBuildError: undefined,
  };
}

/**
 * Compute a patch that marks the brand build as failed. Accepts an error
 * message for the graceful-fallback UI. Unlike `buildReadyPatch`, this
 * transition is allowed from any state so callers can surface terminal
 * errors detected outside the normal success path (e.g., a timeout watcher
 * that is not itself holding the building lock).
 */
export function buildFailedPatch(
  current: BrandBuildStatusFields,
  error: string,
  now: Date = new Date()
): BrandBuildStatusFields {
  const startedAt = current.brandBuildStartedAt
    ? Date.parse(current.brandBuildStartedAt)
    : NaN;
  const completedAtMs = now.getTime();
  const duration = Number.isFinite(startedAt)
    ? completedAtMs - startedAt
    : 0;
  // Cap the error message to keep the User record bounded. Same pattern as
  // the onboardingEvents route's MAX_DATA_BYTES guard.
  const safeError = (error || "brand build failed").slice(0, 512);
  return {
    brandBuildStatus: "failed",
    brandBuildCompletedAt: now.toISOString(),
    brandBuildDurationMs: Math.max(0, duration),
    brandBuildError: safeError,
  };
}

/**
 * Watchdog: if a build has been stuck in `building` past the hard timeout wall,
 * return a `failed` patch so the caller can persist it and the UI surfaces a
 * retry. Returns `null` when the build is not stuck (not building, no valid
 * startedAt, or still within budget) so callers can cheaply no-op.
 *
 * This is what converts the "silent stuck spinner" failure mode into a loud,
 * retryable failure — and what unsticks users whose background brand-build job
 * was orphaned (e.g. the 70-day `brand_submitted`-stuck cohort) the next time
 * their onboarding polls `/brand-build/status`.
 */
export function buildAutoFailPatchIfStuck(
  current: BrandBuildStatusFields,
  now: Date = new Date()
): BrandBuildStatusFields | null {
  if (current.brandBuildStatus !== "building") return null;
  const startedAt = current.brandBuildStartedAt
    ? Date.parse(current.brandBuildStartedAt)
    : NaN;
  if (!Number.isFinite(startedAt)) return null;
  const age = now.getTime() - startedAt;
  if (age < BRAND_BUILD_HARD_TIMEOUT_MS) return null;
  return buildFailedPatch(
    current,
    `Brand build timed out after ${Math.round(age / 1000)}s — the background job did not complete. Please retry.`,
    now
  );
}

/**
 * Derive a snapshot from the persisted fields. Pure; does not mutate.
 */
export function snapshot(
  current: BrandBuildStatusFields,
  now: Date = new Date()
): StatusSnapshot {
  const status = current.brandBuildStatus;
  const startedAt = current.brandBuildStartedAt
    ? Date.parse(current.brandBuildStartedAt)
    : NaN;
  const age = Number.isFinite(startedAt) ? now.getTime() - startedAt : 0;
  return {
    brandBuildStatus: status,
    brandBuildStartedAt: current.brandBuildStartedAt,
    brandBuildCompletedAt: current.brandBuildCompletedAt,
    brandBuildDurationMs: current.brandBuildDurationMs,
    brandBuildError: current.brandBuildError,
    inFlight: status === "building",
    timedOut: status === "building" && age >= BRAND_BUILD_TIMEOUT_MS,
  };
}

/**
 * Emit a metrics log line. Kept separate from the patch functions so unit
 * tests don't need to silence console output. Call this after the DB write
 * succeeds so failed DB writes don't pollute the latency histogram.
 */
export function logCompletionMetric(
  userId: string,
  status: "ready" | "failed",
  durationMs: number
): void {
  const userPrefix = (userId || "anon").slice(0, 8);
  // Structured for the log-scraper pipeline that feeds swarm metrics.
  // eslint-disable-next-line no-console
  console.log(
    `[metrics] brand_build_complete status=${status} duration_ms=${durationMs} user=${userPrefix}`
  );
  // Durable per-step metric. Emitted in addition to the structured log
  // line so the OnboardingMetrics dashboard has aggregate visibility (logs
  // rotate; the table doesn't). Lazy-required to avoid pulling AWS SDK at
  // module-load time in tests that mock this service.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { logStepMetric } = require("./onboardingMetricsService");
  const completedAt = new Date();
  void logStepMetric({
    userId,
    step: "brand-build",
    startedAt: new Date(completedAt.getTime() - (durationMs || 0)).toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: durationMs || 0,
    status,
  });
}
