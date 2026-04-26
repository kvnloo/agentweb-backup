/**
 * Onboarding metrics — durable per-step timing log.
 *
 * Every onboarding step (brand-build, icp, competitor, creative-dir,
 * ad-image, ad-copy) writes one row here on completion (success OR
 * failure). The dataset is the source of truth for "how long is
 * onboarding actually taking" — durationMs distributions per step,
 * failure rates per step, time-of-day patterns, etc.
 *
 * Table: Dev-AW-OnboardingMetrics (or AW-OnboardingMetrics in prod).
 *   PK:  metricId (UUID)
 *   GSI: StepStartedAtIndex (step + startedAt) — for "show me brand-build
 *        durations over the last 7 days" queries
 *
 * Item shape:
 *   {
 *     metricId, userId, step, startedAt, completedAt, durationMs,
 *     status: 'ready' | 'failed' | 'timeout',
 *     errorMessage?: string,
 *     env?: string  // 'dev' | 'staging' | 'prod' — derived from NODE_ENV
 *   }
 *
 * Writes are deliberately fire-and-forget at the call site (we don't want
 * a metrics-table outage to break onboarding for the customer). Errors are
 * caught and console.warn'd; the caller never sees them.
 */

import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";

const TABLE_PREFIX =
  process.env.NODE_ENV === "development" ? "Dev-" : "";
const METRICS_TABLE = `${TABLE_PREFIX}AW-OnboardingMetrics`;

const docClient = new AWS.DynamoDB.DocumentClient();

export type OnboardingStep =
  | "brand-build"
  | "icp"
  | "competitor"
  | "creative-dir"
  | "ad-image"
  | "ad-copy";

export type OnboardingStepStatus = "ready" | "failed" | "timeout";

export interface OnboardingStepMetricInput {
  userId: string;
  step: OnboardingStep;
  /** ISO 8601 string. */
  startedAt: string;
  /** ISO 8601 string. */
  completedAt: string;
  durationMs: number;
  status: OnboardingStepStatus;
  errorMessage?: string;
}

/**
 * Fire-and-forget. Resolves immediately; the actual write happens in the
 * background and any error is swallowed (with a console.warn) so a
 * metrics-table outage cannot cascade into broken onboarding.
 *
 * Tests await the returned promise to assert the write happened.
 */
export async function logStepMetric(
  input: OnboardingStepMetricInput,
): Promise<void> {
  const env =
    process.env.NODE_ENV === "production"
      ? "prod"
      : process.env.NODE_ENV === "staging"
        ? "staging"
        : "dev";
  const item: Record<string, unknown> = {
    metricId: uuidv4(),
    userId: input.userId,
    step: input.step,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
    status: input.status,
    env,
  };
  if (input.errorMessage) {
    // Cap error message to keep the row bounded. Same pattern as
    // brandBuildStatusService.buildFailedPatch.
    item.errorMessage = input.errorMessage.slice(0, 512);
  }
  try {
    await docClient
      .put({ TableName: METRICS_TABLE, Item: item })
      .promise();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[onboardingMetricsService] write failed", {
      step: input.step,
      userId: input.userId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Convenience wrapper that derives `startedAt` / `completedAt` /
 * `durationMs` from a single `startedAtMs` and the current clock. Most
 * call sites already have a `startedAt` ISO string from the User record's
 * status fields — they should call `logStepMetric` directly. This helper
 * is for the rare path that only has the start timestamp.
 */
export async function logStepMetricFromStart(input: {
  userId: string;
  step: OnboardingStep;
  startedAtMs: number;
  status: OnboardingStepStatus;
  errorMessage?: string;
}): Promise<void> {
  const completedAtMs = Date.now();
  await logStepMetric({
    userId: input.userId,
    step: input.step,
    startedAt: new Date(input.startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: Math.max(0, completedAtMs - input.startedAtMs),
    status: input.status,
    errorMessage: input.errorMessage,
  });
}

/**
 * Read recent metrics for a step. Used by the admin "how is onboarding
 * doing" dashboard. Pure read — no writes, no side effects.
 *
 * Returns at most `limit` rows, sorted by startedAt descending (most
 * recent first).
 */
export async function getRecentStepMetrics(input: {
  step: OnboardingStep;
  limit?: number;
}): Promise<OnboardingStepMetricInput[]> {
  const limit = input.limit ?? 100;
  const resp = await docClient
    .query({
      TableName: METRICS_TABLE,
      IndexName: "StepStartedAtIndex",
      KeyConditionExpression: "#s = :step",
      ExpressionAttributeNames: { "#s": "step" },
      ExpressionAttributeValues: { ":step": input.step },
      ScanIndexForward: false,
      Limit: limit,
    })
    .promise();
  return (resp.Items || []) as unknown as OnboardingStepMetricInput[];
}

/**
 * Compute simple p50 / p95 / fail-rate over a slice of step metrics.
 * Pure helper — no DB calls.
 */
export function summariseStepMetrics(
  rows: OnboardingStepMetricInput[],
): {
  count: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  failureRate: number;
} {
  const count = rows.length;
  if (count === 0) {
    return { count: 0, p50DurationMs: null, p95DurationMs: null, failureRate: 0 };
  }
  const sorted = [...rows]
    .map((r) => Number(r.durationMs))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  const p = (q: number): number | null => {
    if (sorted.length === 0) return null;
    const idx = Math.min(
      sorted.length - 1,
      Math.floor((q / 100) * sorted.length),
    );
    return sorted[idx];
  };
  const failures = rows.filter(
    (r) => r.status === "failed" || r.status === "timeout",
  ).length;
  return {
    count,
    p50DurationMs: p(50),
    p95DurationMs: p(95),
    failureRate: failures / count,
  };
}
