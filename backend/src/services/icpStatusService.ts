/**
 * ICP status — Onboarding Epic Phase 2.
 *
 * Pure state-transition logic for the async ICP (Ideal Customer Profile)
 * generation state machine. One of five concurrent per-step state machines
 * on the User record (icp / competitor / creativeDir / adImage / adCopy)
 * that the onboarding screens use to fire the step they hide without
 * guessing what's already in flight.
 *
 * State machine:
 *   (none) → running
 *   running → ready    (when /complete is called with a valid result)
 *   running → failed   (on timeout or error)
 *   ready   → running  (allowed — re-run from the UI)
 *   failed  → running  (allowed — retry)
 *
 * This service intentionally does NOT touch DynamoDB so it can be unit-
 * tested without mocking AWS. Callers (routes) pass in the current
 * persisted fields and receive a partial `User` patch.
 *
 * Mirrors the existing single-axis `adGenStatusService` and
 * `brandBuildStatusService` patterns. Kept as 5 separate modules (one per
 * axis) rather than one parameterized module so each axis can evolve its
 * own timeout, result shape, and metric label independently.
 *
 * Result shape: 5 personas, each with name/pain/desire/objection and a
 * meta_targeting_brief. Stored as `unknown[]` for now — the calling
 * service tightens this at the LLM-output boundary.
 */

export type ICPStatus = "idle" | "running" | "ready" | "failed";

/**
 * One ICP persona returned by the generator. Kept loose so the LLM-output
 * boundary can tighten it without churning persistence types every time
 * the prompt evolves.
 */
export interface ICPPersona {
  name: string;
  pain: string;
  desire: string;
  objection: string;
  meta_targeting_brief: string;
}

export interface ICPStatusFields {
  icpStatus?: ICPStatus;
  icpStartedAt?: string;
  icpCompletedAt?: string;
  icpDurationMs?: number;
  icpError?: string;
  icpResult?: ICPPersona[];
}

export interface ICPSnapshot extends ICPStatusFields {
  /** True when the last started run is still in flight. */
  inFlight: boolean;
  /** True when an in-flight run has exceeded the timeout budget. */
  timedOut: boolean;
}

/** Target p99 latency budget — if generation runs longer, UI flips to fallback. */
export const ICP_TIMEOUT_MS = 120_000; // 2 minutes — 5 personas + meta briefs

/** Hard cap on personas we render / persist. */
export const MAX_ICP_PERSONAS = 5;

// Field length caps — keep DynamoDB item bounded.
const MAX_NAME_LEN = 200;
const MAX_TEXT_LEN = 1000;
const MAX_BRIEF_LEN = 2000;
const MAX_ERROR_LEN = 512;

/**
 * Compute a patch that marks ICP generation as just-started. Idempotent:
 * repeated calls reset the clock (user retrying from the UI).
 */
export function icpStartPatch(now: Date = new Date()): ICPStatusFields {
  return {
    icpStatus: "running",
    icpStartedAt: now.toISOString(),
    icpCompletedAt: undefined,
    icpDurationMs: undefined,
    icpError: undefined,
    icpResult: undefined,
  };
}

/**
 * Compute a patch that marks ICP generation as successfully completed
 * with the supplied personas. Returns `null` if the user was not in
 * `running` state — completion events from idle states are ignored to
 * prevent double-writes from noisy upstream hooks bumping the duration
 * metric.
 */
export function icpReadyPatch(
  current: ICPStatusFields,
  personas: ICPPersona[],
  now: Date = new Date()
): ICPStatusFields | null {
  if (current.icpStatus !== "running") {
    return null;
  }
  const startedAt = current.icpStartedAt
    ? Date.parse(current.icpStartedAt)
    : NaN;
  const completedAtMs = now.getTime();
  const duration = Number.isFinite(startedAt) ? completedAtMs - startedAt : 0;
  return {
    icpStatus: "ready",
    icpCompletedAt: now.toISOString(),
    icpDurationMs: Math.max(0, duration),
    icpError: undefined,
    icpResult: sanitizeICPPersonas(personas),
  };
}

/**
 * Compute a patch that marks ICP generation as failed. Allowed from any
 * state so watchdogs can flip stale runs.
 */
export function icpFailedPatch(
  current: ICPStatusFields,
  error: string,
  now: Date = new Date()
): ICPStatusFields {
  const startedAt = current.icpStartedAt
    ? Date.parse(current.icpStartedAt)
    : NaN;
  const completedAtMs = now.getTime();
  const duration = Number.isFinite(startedAt) ? completedAtMs - startedAt : 0;
  const safeError = (error || "icp generation failed").slice(0, MAX_ERROR_LEN);
  return {
    icpStatus: "failed",
    icpCompletedAt: now.toISOString(),
    icpDurationMs: Math.max(0, duration),
    icpError: safeError,
  };
}

/**
 * Derive a snapshot from the persisted fields. Pure; does not mutate.
 */
export function icpSnapshot(
  current: ICPStatusFields,
  now: Date = new Date()
): ICPSnapshot {
  const status = current.icpStatus;
  const startedAt = current.icpStartedAt
    ? Date.parse(current.icpStartedAt)
    : NaN;
  const age = Number.isFinite(startedAt) ? now.getTime() - startedAt : 0;
  return {
    icpStatus: status,
    icpStartedAt: current.icpStartedAt,
    icpCompletedAt: current.icpCompletedAt,
    icpDurationMs: current.icpDurationMs,
    icpError: current.icpError,
    icpResult: current.icpResult,
    inFlight: status === "running",
    timedOut: status === "running" && age >= ICP_TIMEOUT_MS,
  };
}

/**
 * Sanitize + bound-check ICP personas before persistence. Strips
 * malformed entries and caps the array at MAX_ICP_PERSONAS.
 */
export function sanitizeICPPersonas(raw: unknown): ICPPersona[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ICPPersona[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const v = item as Partial<ICPPersona>;
    if (
      typeof v.name !== "string" ||
      typeof v.pain !== "string" ||
      typeof v.desire !== "string" ||
      typeof v.objection !== "string" ||
      typeof v.meta_targeting_brief !== "string"
    ) {
      continue;
    }
    out.push({
      name: v.name.slice(0, MAX_NAME_LEN),
      pain: v.pain.slice(0, MAX_TEXT_LEN),
      desire: v.desire.slice(0, MAX_TEXT_LEN),
      objection: v.objection.slice(0, MAX_TEXT_LEN),
      meta_targeting_brief: v.meta_targeting_brief.slice(0, MAX_BRIEF_LEN),
    });
    if (out.length >= MAX_ICP_PERSONAS) break;
  }
  return out;
}

/**
 * Emit a metrics log line. Kept separate from patch functions so unit
 * tests don't need to silence console output. Call this after the DB
 * write succeeds so failed DB writes don't pollute the latency histogram.
 */
export function logICPCompletionMetric(
  userId: string,
  status: "ready" | "failed",
  durationMs: number,
  personaCount: number
): void {
  const userPrefix = (userId || "anon").slice(0, 8);
  // eslint-disable-next-line no-console
  console.log(
    `[metrics] icp_complete status=${status} duration_ms=${durationMs} personas=${personaCount} user=${userPrefix}`
  );
}
