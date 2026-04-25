/**
 * Creative direction status — Onboarding Epic Phase 2.
 *
 * Pure state-transition logic for the async creative-direction state
 * machine. One of five concurrent per-step state machines on the User
 * record (see `icpStatusService` for the full set + design rationale).
 *
 * State machine: idle → running → ready | failed; ready/failed → running.
 *
 * Result shape: 6 psychological concepts, 5 copy angles, and a list of
 * format archetypes. All are loose string arrays at this layer — the
 * calling service tightens at the LLM-output boundary.
 */

export type CreativeDirStatus = "idle" | "running" | "ready" | "failed";

export interface CreativeDirResult {
  concepts: string[]; // 6 psychological concepts
  copy_angles: string[]; // 5 copy angles
  format_archetypes: string[]; // format archetype list
}

export interface CreativeDirStatusFields {
  creativeDirStatus?: CreativeDirStatus;
  creativeDirStartedAt?: string;
  creativeDirCompletedAt?: string;
  creativeDirDurationMs?: number;
  creativeDirError?: string;
  creativeDirResult?: CreativeDirResult;
}

export interface CreativeDirSnapshot extends CreativeDirStatusFields {
  inFlight: boolean;
  timedOut: boolean;
}

export const CREATIVE_DIR_TIMEOUT_MS = 120_000; // 2 minutes

export const MAX_CONCEPTS = 6;
export const MAX_COPY_ANGLES = 5;
export const MAX_FORMAT_ARCHETYPES = 10;

const MAX_CONCEPT_LEN = 1000;
const MAX_ANGLE_LEN = 500;
const MAX_ARCHETYPE_LEN = 200;
const MAX_ERROR_LEN = 512;

export function creativeDirStartPatch(
  now: Date = new Date()
): CreativeDirStatusFields {
  return {
    creativeDirStatus: "running",
    creativeDirStartedAt: now.toISOString(),
    creativeDirCompletedAt: undefined,
    creativeDirDurationMs: undefined,
    creativeDirError: undefined,
    creativeDirResult: undefined,
  };
}

export function creativeDirReadyPatch(
  current: CreativeDirStatusFields,
  result: CreativeDirResult,
  now: Date = new Date()
): CreativeDirStatusFields | null {
  if (current.creativeDirStatus !== "running") {
    return null;
  }
  const startedAt = current.creativeDirStartedAt
    ? Date.parse(current.creativeDirStartedAt)
    : NaN;
  const completedAtMs = now.getTime();
  const duration = Number.isFinite(startedAt) ? completedAtMs - startedAt : 0;
  return {
    creativeDirStatus: "ready",
    creativeDirCompletedAt: now.toISOString(),
    creativeDirDurationMs: Math.max(0, duration),
    creativeDirError: undefined,
    creativeDirResult: sanitizeCreativeDirResult(result),
  };
}

export function creativeDirFailedPatch(
  current: CreativeDirStatusFields,
  error: string,
  now: Date = new Date()
): CreativeDirStatusFields {
  const startedAt = current.creativeDirStartedAt
    ? Date.parse(current.creativeDirStartedAt)
    : NaN;
  const completedAtMs = now.getTime();
  const duration = Number.isFinite(startedAt) ? completedAtMs - startedAt : 0;
  const safeError = (error || "creative direction failed").slice(0, MAX_ERROR_LEN);
  return {
    creativeDirStatus: "failed",
    creativeDirCompletedAt: now.toISOString(),
    creativeDirDurationMs: Math.max(0, duration),
    creativeDirError: safeError,
  };
}

export function creativeDirSnapshot(
  current: CreativeDirStatusFields,
  now: Date = new Date()
): CreativeDirSnapshot {
  const status = current.creativeDirStatus;
  const startedAt = current.creativeDirStartedAt
    ? Date.parse(current.creativeDirStartedAt)
    : NaN;
  const age = Number.isFinite(startedAt) ? now.getTime() - startedAt : 0;
  return {
    creativeDirStatus: status,
    creativeDirStartedAt: current.creativeDirStartedAt,
    creativeDirCompletedAt: current.creativeDirCompletedAt,
    creativeDirDurationMs: current.creativeDirDurationMs,
    creativeDirError: current.creativeDirError,
    creativeDirResult: current.creativeDirResult,
    inFlight: status === "running",
    timedOut: status === "running" && age >= CREATIVE_DIR_TIMEOUT_MS,
  };
}

function sanitizeStringArray(raw: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    out.push(item.slice(0, maxLen));
    if (out.length >= maxItems) break;
  }
  return out;
}

export function sanitizeCreativeDirResult(raw: unknown): CreativeDirResult {
  if (!raw || typeof raw !== "object") {
    return { concepts: [], copy_angles: [], format_archetypes: [] };
  }
  const r = raw as Partial<CreativeDirResult>;
  return {
    concepts: sanitizeStringArray(r.concepts, MAX_CONCEPTS, MAX_CONCEPT_LEN),
    copy_angles: sanitizeStringArray(
      r.copy_angles,
      MAX_COPY_ANGLES,
      MAX_ANGLE_LEN
    ),
    format_archetypes: sanitizeStringArray(
      r.format_archetypes,
      MAX_FORMAT_ARCHETYPES,
      MAX_ARCHETYPE_LEN
    ),
  };
}

export function logCreativeDirCompletionMetric(
  userId: string,
  status: "ready" | "failed",
  durationMs: number,
  conceptCount: number
): void {
  const userPrefix = (userId || "anon").slice(0, 8);
  // eslint-disable-next-line no-console
  console.log(
    `[metrics] creative_dir_complete status=${status} duration_ms=${durationMs} concepts=${conceptCount} user=${userPrefix}`
  );
}
