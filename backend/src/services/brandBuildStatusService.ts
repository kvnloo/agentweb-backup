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
   * True when a previously-started build has exceeded the timeout budget
   * (90s target from the task body). The caller should trip the status to
   * `failed` on the next write and surface the graceful-fallback UX.
   */
  timedOut: boolean;
}

/** Target p99 latency budget — if a build runs longer than this, the UI flips to the graceful-fallback state. */
export const BRAND_BUILD_TIMEOUT_MS = 90_000;

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
}
