/**
 * Ad image status — Onboarding Epic Phase 2.
 *
 * Pure state-transition logic for the async ad-image generation state
 * machine. One of five concurrent per-step state machines on the User
 * record (see `icpStatusService` for the full set + design rationale).
 *
 * Distinct from the legacy single-axis `adGenStatusService`, which mixed
 * image + copy in one machine. This Epic splits image and copy into two
 * independent axes so a single failure on one doesn't block the other,
 * and so the UI can render images and copy with separate spinners.
 *
 * State machine: idle → running → ready | failed; ready/failed → running.
 *
 * Result shape: 3 image variants — id, imageUrl, prompt.
 */

export type AdImageStatus = "idle" | "running" | "ready" | "failed";

export interface AdImageVariant {
  id: string;
  imageUrl: string;
  prompt: string;
}

export interface AdImageResult {
  variants: AdImageVariant[];
}

export interface AdImageStatusFields {
  adImageStatus?: AdImageStatus;
  adImageStartedAt?: string;
  adImageCompletedAt?: string;
  adImageDurationMs?: number;
  adImageError?: string;
  adImageResult?: AdImageResult;
}

export interface AdImageSnapshot extends AdImageStatusFields {
  inFlight: boolean;
  timedOut: boolean;
}

export const AD_IMAGE_TIMEOUT_MS = 240_000; // 4 minutes — image gen is slow

export const MAX_AD_IMAGE_VARIANTS = 3;

const MAX_ID_LEN = 64;
const MAX_URL_LEN = 1024;
const MAX_PROMPT_LEN = 2000;
const MAX_ERROR_LEN = 512;

export function adImageStartPatch(now: Date = new Date()): AdImageStatusFields {
  return {
    adImageStatus: "running",
    adImageStartedAt: now.toISOString(),
    adImageCompletedAt: undefined,
    adImageDurationMs: undefined,
    adImageError: undefined,
    adImageResult: undefined,
  };
}

export function adImageReadyPatch(
  current: AdImageStatusFields,
  result: AdImageResult,
  now: Date = new Date()
): AdImageStatusFields | null {
  if (current.adImageStatus !== "running") {
    return null;
  }
  const startedAt = current.adImageStartedAt
    ? Date.parse(current.adImageStartedAt)
    : NaN;
  const completedAtMs = now.getTime();
  const duration = Number.isFinite(startedAt) ? completedAtMs - startedAt : 0;
  return {
    adImageStatus: "ready",
    adImageCompletedAt: now.toISOString(),
    adImageDurationMs: Math.max(0, duration),
    adImageError: undefined,
    adImageResult: sanitizeAdImageResult(result),
  };
}

export function adImageFailedPatch(
  current: AdImageStatusFields,
  error: string,
  now: Date = new Date()
): AdImageStatusFields {
  const startedAt = current.adImageStartedAt
    ? Date.parse(current.adImageStartedAt)
    : NaN;
  const completedAtMs = now.getTime();
  const duration = Number.isFinite(startedAt) ? completedAtMs - startedAt : 0;
  const safeError = (error || "ad image generation failed").slice(0, MAX_ERROR_LEN);
  return {
    adImageStatus: "failed",
    adImageCompletedAt: now.toISOString(),
    adImageDurationMs: Math.max(0, duration),
    adImageError: safeError,
  };
}

export function adImageSnapshot(
  current: AdImageStatusFields,
  now: Date = new Date()
): AdImageSnapshot {
  const status = current.adImageStatus;
  const startedAt = current.adImageStartedAt
    ? Date.parse(current.adImageStartedAt)
    : NaN;
  const age = Number.isFinite(startedAt) ? now.getTime() - startedAt : 0;
  return {
    adImageStatus: status,
    adImageStartedAt: current.adImageStartedAt,
    adImageCompletedAt: current.adImageCompletedAt,
    adImageDurationMs: current.adImageDurationMs,
    adImageError: current.adImageError,
    adImageResult: current.adImageResult,
    inFlight: status === "running",
    timedOut: status === "running" && age >= AD_IMAGE_TIMEOUT_MS,
  };
}

export function sanitizeAdImageResult(raw: unknown): AdImageResult {
  if (!raw || typeof raw !== "object") return { variants: [] };
  const r = raw as Partial<AdImageResult>;
  if (!Array.isArray(r.variants)) return { variants: [] };
  const out: AdImageVariant[] = [];
  for (const item of r.variants) {
    if (!item || typeof item !== "object") continue;
    const v = item as Partial<AdImageVariant>;
    if (
      typeof v.id !== "string" ||
      typeof v.imageUrl !== "string" ||
      typeof v.prompt !== "string"
    ) {
      continue;
    }
    out.push({
      id: v.id.slice(0, MAX_ID_LEN),
      imageUrl: v.imageUrl.slice(0, MAX_URL_LEN),
      prompt: v.prompt.slice(0, MAX_PROMPT_LEN),
    });
    if (out.length >= MAX_AD_IMAGE_VARIANTS) break;
  }
  return { variants: out };
}

export function logAdImageCompletionMetric(
  userId: string,
  status: "ready" | "failed",
  durationMs: number,
  variantCount: number
): void {
  const userPrefix = (userId || "anon").slice(0, 8);
  // eslint-disable-next-line no-console
  console.log(
    `[metrics] ad_image_complete status=${status} duration_ms=${durationMs} variants=${variantCount} user=${userPrefix}`
  );
}
