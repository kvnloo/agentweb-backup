/**
 * Competitor status — Onboarding Epic Phase 2.
 *
 * Pure state-transition logic for the async competitor research state
 * machine. One of five concurrent per-step state machines on the User
 * record (see `icpStatusService` for the full set + design rationale).
 *
 * State machine: idle → running → ready | failed; ready/failed → running.
 *
 * Result shape: per-ICP targeting briefs — for each ICP id, a list of
 * competitor names, offer angles, and a meta_targeting_brief. Stored as a
 * loose object array so the LLM-output boundary can tighten it without
 * churning persistence.
 */

export type CompetitorStatus = "idle" | "running" | "ready" | "failed";

export interface CompetitorPerICP {
  icp_id: string;
  competitor_names: string[];
  offer_angles: string[];
  meta_targeting_brief: string;
}

export interface CompetitorResult {
  per_icp: CompetitorPerICP[];
}

export interface CompetitorStatusFields {
  competitorStatus?: CompetitorStatus;
  competitorStartedAt?: string;
  competitorCompletedAt?: string;
  competitorDurationMs?: number;
  competitorError?: string;
  competitorResult?: CompetitorResult;
}

export interface CompetitorSnapshot extends CompetitorStatusFields {
  inFlight: boolean;
  timedOut: boolean;
}

export const COMPETITOR_TIMEOUT_MS = 180_000; // 3 minutes — research is the slowest axis

export const MAX_COMPETITOR_ICPS = 5;
export const MAX_COMPETITOR_NAMES = 10;
export const MAX_OFFER_ANGLES = 10;

const MAX_ID_LEN = 64;
const MAX_NAME_LEN = 200;
const MAX_ANGLE_LEN = 500;
const MAX_BRIEF_LEN = 2000;
const MAX_ERROR_LEN = 512;

export function competitorStartPatch(
  now: Date = new Date()
): CompetitorStatusFields {
  return {
    competitorStatus: "running",
    competitorStartedAt: now.toISOString(),
    competitorCompletedAt: undefined,
    competitorDurationMs: undefined,
    competitorError: undefined,
    competitorResult: undefined,
  };
}

export function competitorReadyPatch(
  current: CompetitorStatusFields,
  result: CompetitorResult,
  now: Date = new Date()
): CompetitorStatusFields | null {
  if (current.competitorStatus !== "running") {
    return null;
  }
  const startedAt = current.competitorStartedAt
    ? Date.parse(current.competitorStartedAt)
    : NaN;
  const completedAtMs = now.getTime();
  const duration = Number.isFinite(startedAt) ? completedAtMs - startedAt : 0;
  return {
    competitorStatus: "ready",
    competitorCompletedAt: now.toISOString(),
    competitorDurationMs: Math.max(0, duration),
    competitorError: undefined,
    competitorResult: sanitizeCompetitorResult(result),
  };
}

export function competitorFailedPatch(
  current: CompetitorStatusFields,
  error: string,
  now: Date = new Date()
): CompetitorStatusFields {
  const startedAt = current.competitorStartedAt
    ? Date.parse(current.competitorStartedAt)
    : NaN;
  const completedAtMs = now.getTime();
  const duration = Number.isFinite(startedAt) ? completedAtMs - startedAt : 0;
  const safeError = (error || "competitor research failed").slice(
    0,
    MAX_ERROR_LEN
  );
  return {
    competitorStatus: "failed",
    competitorCompletedAt: now.toISOString(),
    competitorDurationMs: Math.max(0, duration),
    competitorError: safeError,
  };
}

export function competitorSnapshot(
  current: CompetitorStatusFields,
  now: Date = new Date()
): CompetitorSnapshot {
  const status = current.competitorStatus;
  const startedAt = current.competitorStartedAt
    ? Date.parse(current.competitorStartedAt)
    : NaN;
  const age = Number.isFinite(startedAt) ? now.getTime() - startedAt : 0;
  return {
    competitorStatus: status,
    competitorStartedAt: current.competitorStartedAt,
    competitorCompletedAt: current.competitorCompletedAt,
    competitorDurationMs: current.competitorDurationMs,
    competitorError: current.competitorError,
    competitorResult: current.competitorResult,
    inFlight: status === "running",
    timedOut: status === "running" && age >= COMPETITOR_TIMEOUT_MS,
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

export function sanitizeCompetitorResult(raw: unknown): CompetitorResult {
  if (!raw || typeof raw !== "object") return { per_icp: [] };
  const r = raw as Partial<CompetitorResult>;
  if (!Array.isArray(r.per_icp)) return { per_icp: [] };
  const out: CompetitorPerICP[] = [];
  for (const entry of r.per_icp) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Partial<CompetitorPerICP>;
    if (typeof e.icp_id !== "string") continue;
    out.push({
      icp_id: e.icp_id.slice(0, MAX_ID_LEN),
      competitor_names: sanitizeStringArray(
        e.competitor_names,
        MAX_COMPETITOR_NAMES,
        MAX_NAME_LEN
      ),
      offer_angles: sanitizeStringArray(
        e.offer_angles,
        MAX_OFFER_ANGLES,
        MAX_ANGLE_LEN
      ),
      meta_targeting_brief:
        typeof e.meta_targeting_brief === "string"
          ? e.meta_targeting_brief.slice(0, MAX_BRIEF_LEN)
          : "",
    });
    if (out.length >= MAX_COMPETITOR_ICPS) break;
  }
  return { per_icp: out };
}

export function logCompetitorCompletionMetric(
  userId: string,
  status: "ready" | "failed",
  durationMs: number,
  icpCount: number
): void {
  const userPrefix = (userId || "anon").slice(0, 8);
  // eslint-disable-next-line no-console
  console.log(
    `[metrics] competitor_complete status=${status} duration_ms=${durationMs} icps=${icpCount} user=${userPrefix}`
  );
}
