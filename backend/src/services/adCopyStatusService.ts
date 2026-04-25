/**
 * Ad copy status — Onboarding Epic Phase 2.
 *
 * Pure state-transition logic for the async ad-copy generation state
 * machine. One of five concurrent per-step state machines on the User
 * record (see `icpStatusService` for the full set + design rationale).
 *
 * Distinct from the legacy single-axis `adGenStatusService` — see
 * `adImageStatusService` for the image/copy split rationale.
 *
 * State machine: idle → running → ready | failed; ready/failed → running.
 *
 * Result shape: 3 copy variants — id, headline, primaryText, cta, and a
 * `variety` tag describing the angle/style each variant tests.
 */

export type AdCopyStatus = "idle" | "running" | "ready" | "failed";

export interface AdCopyVariant {
  id: string;
  headline: string;
  primaryText: string;
  cta: string;
  variety: string;
}

export interface AdCopyResult {
  variants: AdCopyVariant[];
}

export interface AdCopyStatusFields {
  adCopyStatus?: AdCopyStatus;
  adCopyStartedAt?: string;
  adCopyCompletedAt?: string;
  adCopyDurationMs?: number;
  adCopyError?: string;
  adCopyResult?: AdCopyResult;
}

export interface AdCopySnapshot extends AdCopyStatusFields {
  inFlight: boolean;
  timedOut: boolean;
}

export const AD_COPY_TIMEOUT_MS = 90_000; // 1.5 minutes — text generation is faster than image

export const MAX_AD_COPY_VARIANTS = 3;

const MAX_ID_LEN = 64;
const MAX_HEADLINE_LEN = 200;
const MAX_PRIMARY_TEXT_LEN = 1000;
const MAX_CTA_LEN = 40;
const MAX_VARIETY_LEN = 100;
const MAX_ERROR_LEN = 512;

export function adCopyStartPatch(now: Date = new Date()): AdCopyStatusFields {
  return {
    adCopyStatus: "running",
    adCopyStartedAt: now.toISOString(),
    adCopyCompletedAt: undefined,
    adCopyDurationMs: undefined,
    adCopyError: undefined,
    adCopyResult: undefined,
  };
}

export function adCopyReadyPatch(
  current: AdCopyStatusFields,
  result: AdCopyResult,
  now: Date = new Date()
): AdCopyStatusFields | null {
  if (current.adCopyStatus !== "running") {
    return null;
  }
  const startedAt = current.adCopyStartedAt
    ? Date.parse(current.adCopyStartedAt)
    : NaN;
  const completedAtMs = now.getTime();
  const duration = Number.isFinite(startedAt) ? completedAtMs - startedAt : 0;
  return {
    adCopyStatus: "ready",
    adCopyCompletedAt: now.toISOString(),
    adCopyDurationMs: Math.max(0, duration),
    adCopyError: undefined,
    adCopyResult: sanitizeAdCopyResult(result),
  };
}

export function adCopyFailedPatch(
  current: AdCopyStatusFields,
  error: string,
  now: Date = new Date()
): AdCopyStatusFields {
  const startedAt = current.adCopyStartedAt
    ? Date.parse(current.adCopyStartedAt)
    : NaN;
  const completedAtMs = now.getTime();
  const duration = Number.isFinite(startedAt) ? completedAtMs - startedAt : 0;
  const safeError = (error || "ad copy generation failed").slice(0, MAX_ERROR_LEN);
  return {
    adCopyStatus: "failed",
    adCopyCompletedAt: now.toISOString(),
    adCopyDurationMs: Math.max(0, duration),
    adCopyError: safeError,
  };
}

export function adCopySnapshot(
  current: AdCopyStatusFields,
  now: Date = new Date()
): AdCopySnapshot {
  const status = current.adCopyStatus;
  const startedAt = current.adCopyStartedAt
    ? Date.parse(current.adCopyStartedAt)
    : NaN;
  const age = Number.isFinite(startedAt) ? now.getTime() - startedAt : 0;
  return {
    adCopyStatus: status,
    adCopyStartedAt: current.adCopyStartedAt,
    adCopyCompletedAt: current.adCopyCompletedAt,
    adCopyDurationMs: current.adCopyDurationMs,
    adCopyError: current.adCopyError,
    adCopyResult: current.adCopyResult,
    inFlight: status === "running",
    timedOut: status === "running" && age >= AD_COPY_TIMEOUT_MS,
  };
}

export function sanitizeAdCopyResult(raw: unknown): AdCopyResult {
  if (!raw || typeof raw !== "object") return { variants: [] };
  const r = raw as Partial<AdCopyResult>;
  if (!Array.isArray(r.variants)) return { variants: [] };
  const out: AdCopyVariant[] = [];
  for (const item of r.variants) {
    if (!item || typeof item !== "object") continue;
    const v = item as Partial<AdCopyVariant>;
    if (
      typeof v.id !== "string" ||
      typeof v.headline !== "string" ||
      typeof v.primaryText !== "string" ||
      typeof v.cta !== "string" ||
      typeof v.variety !== "string"
    ) {
      continue;
    }
    out.push({
      id: v.id.slice(0, MAX_ID_LEN),
      headline: v.headline.slice(0, MAX_HEADLINE_LEN),
      primaryText: v.primaryText.slice(0, MAX_PRIMARY_TEXT_LEN),
      cta: v.cta.slice(0, MAX_CTA_LEN),
      variety: v.variety.slice(0, MAX_VARIETY_LEN),
    });
    if (out.length >= MAX_AD_COPY_VARIANTS) break;
  }
  return { variants: out };
}

export function logAdCopyCompletionMetric(
  userId: string,
  status: "ready" | "failed",
  durationMs: number,
  variantCount: number
): void {
  const userPrefix = (userId || "anon").slice(0, 8);
  // eslint-disable-next-line no-console
  console.log(
    `[metrics] ad_copy_complete status=${status} duration_ms=${durationMs} variants=${variantCount} user=${userPrefix}`
  );
}
