/**
 * Ad generation status — Onboarding v2 Phase 4.
 *
 * Pure state-transition logic for the async ad-creative generation state
 * machine. Mirrors the Phase 1 `brandBuildStatusService` contract but tracks
 * a separate axis on the User record — the two status machines run
 * concurrently during onboarding (brand build in parallel with ad gen is
 * intentional; the UI shows both).
 *
 * State machine:
 *   (none) → generating
 *   generating → ready     (when variants are submitted via /complete)
 *   generating → failed    (on timeout or error)
 *   ready      → generating (allowed — user can regenerate variants)
 *   failed     → generating (allowed — retry)
 *
 * This service intentionally does NOT touch DynamoDB so it can be unit-
 * tested without mocking AWS. Callers (routes, agentModeService) pass in
 * the current persisted fields and receive a partial `User` patch.
 *
 * Why a SEPARATE state machine (not a reuse of brandBuildStatus):
 *   - Brand and ads are different build axes with different timeouts
 *     (brand ~90s, ads ~2min for image + copy).
 *   - Both can be in-flight concurrently during Phase 3→4 transition.
 *   - Failure modes differ (brand failure degrades to manual form; ad
 *     failure degrades to "try again" or manual work plan run).
 *
 * Ad variants are also persisted on the User row so a reload of the Phase 4
 * reveal screen re-renders the exact variants the LLM returned — no
 * re-generation on refresh. The array is sanitized with bounded field
 * lengths to keep the DynamoDB item size predictable.
 *
 * Metrics are emitted via a structured console log on completion so the
 * existing log-pipeline scraper can compute p50/p99. Log line format:
 *   [metrics] ad_gen_complete status=<ready|failed> duration_ms=<num> variants=<num> user=<userId-prefix>
 */

export type AdGenStatus = "generating" | "ready" | "failed";

/**
 * Ad creative variant shape — mirrors the output contract of the
 * "B2B lead gen ad" work plan (see phase task body). Kept intentionally
 * simple so both the backend persistence and the frontend preview can
 * share the same type without depending on the work-plan module.
 */
export interface AdVariant {
  /** Stable client-generated id used for per-variant regenerate targeting. */
  id: string;
  /** Primary headline shown on the ad card. */
  headline: string;
  /** Body text — the "why should I care" copy block. */
  primaryText: string;
  /** Call-to-action label (e.g. "Learn more", "Sign up"). */
  cta: string;
  /** Optional hero image URL. Missing = still generating or image-less variant. */
  imageUrl?: string;
}

export interface AdGenStatusFields {
  adGenStatus?: AdGenStatus;
  adGenStartedAt?: string;
  adGenCompletedAt?: string;
  adGenDurationMs?: number;
  adGenError?: string;
  adGenVariants?: AdVariant[];
}

export interface AdGenSnapshot extends AdGenStatusFields {
  /** True when the last started generation is still in flight. */
  inFlight: boolean;
  /** True when an in-flight generation has exceeded the timeout budget. */
  timedOut: boolean;
}

/** Target p99 latency budget — if generation runs longer, UI flips to fallback. */
export const AD_GEN_TIMEOUT_MS = 180_000; // 3 minutes — images + 3 copy variants

/** Hard cap on variants we render / persist. 3 is the product spec. */
export const MAX_AD_VARIANTS = 3;

// Field length caps — keep DynamoDB item bounded.
const MAX_ID_LEN = 64;
const MAX_HEADLINE_LEN = 200;
const MAX_PRIMARY_TEXT_LEN = 1000;
const MAX_CTA_LEN = 40;
const MAX_IMAGE_URL_LEN = 1024;

/**
 * Compute a patch that marks ad generation as just-started. Idempotent:
 * repeated calls reset the clock (user retrying from the UI).
 */
export function adGenStartPatch(now: Date = new Date()): AdGenStatusFields {
  return {
    adGenStatus: "generating",
    adGenStartedAt: now.toISOString(),
    adGenCompletedAt: undefined,
    adGenDurationMs: undefined,
    adGenError: undefined,
    adGenVariants: undefined,
  };
}

/**
 * Compute a patch that marks ad generation as successfully completed with
 * the supplied variants. Returns `null` if the user was not in
 * `generating` state — completion events from idle states are ignored.
 */
export function adGenReadyPatch(
  current: AdGenStatusFields,
  variants: AdVariant[],
  now: Date = new Date()
): AdGenStatusFields | null {
  if (current.adGenStatus !== "generating") {
    return null;
  }
  const startedAt = current.adGenStartedAt
    ? Date.parse(current.adGenStartedAt)
    : NaN;
  const completedAtMs = now.getTime();
  const duration = Number.isFinite(startedAt)
    ? completedAtMs - startedAt
    : 0;
  return {
    adGenStatus: "ready",
    adGenCompletedAt: now.toISOString(),
    adGenDurationMs: Math.max(0, duration),
    adGenError: undefined,
    adGenVariants: sanitizeAdVariants(variants),
  };
}

/**
 * Compute a patch that marks ad generation as failed. Allowed from any
 * state so watchdogs can flip stale builds.
 */
export function adGenFailedPatch(
  current: AdGenStatusFields,
  error: string,
  now: Date = new Date()
): AdGenStatusFields {
  const startedAt = current.adGenStartedAt
    ? Date.parse(current.adGenStartedAt)
    : NaN;
  const completedAtMs = now.getTime();
  const duration = Number.isFinite(startedAt)
    ? completedAtMs - startedAt
    : 0;
  const safeError = (error || "ad generation failed").slice(0, 512);
  return {
    adGenStatus: "failed",
    adGenCompletedAt: now.toISOString(),
    adGenDurationMs: Math.max(0, duration),
    adGenError: safeError,
  };
}

/**
 * Derive a snapshot from the persisted fields. Pure; does not mutate.
 */
export function adGenSnapshot(
  current: AdGenStatusFields,
  now: Date = new Date()
): AdGenSnapshot {
  const status = current.adGenStatus;
  const startedAt = current.adGenStartedAt
    ? Date.parse(current.adGenStartedAt)
    : NaN;
  const age = Number.isFinite(startedAt) ? now.getTime() - startedAt : 0;
  return {
    adGenStatus: status,
    adGenStartedAt: current.adGenStartedAt,
    adGenCompletedAt: current.adGenCompletedAt,
    adGenDurationMs: current.adGenDurationMs,
    adGenError: current.adGenError,
    adGenVariants: current.adGenVariants,
    inFlight: status === "generating",
    timedOut: status === "generating" && age >= AD_GEN_TIMEOUT_MS,
  };
}

/**
 * Sanitize + bound-check ad variants before persistence. Strips malformed
 * entries and caps the array at MAX_AD_VARIANTS.
 */
export function sanitizeAdVariants(raw: unknown): AdVariant[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: AdVariant[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const v = item as Partial<AdVariant>;
    if (
      typeof v.id !== "string" ||
      typeof v.headline !== "string" ||
      typeof v.primaryText !== "string" ||
      typeof v.cta !== "string"
    ) {
      continue;
    }
    const variant: AdVariant = {
      id: v.id.slice(0, MAX_ID_LEN),
      headline: v.headline.slice(0, MAX_HEADLINE_LEN),
      primaryText: v.primaryText.slice(0, MAX_PRIMARY_TEXT_LEN),
      cta: v.cta.slice(0, MAX_CTA_LEN),
    };
    if (typeof v.imageUrl === "string" && v.imageUrl.length > 0) {
      variant.imageUrl = v.imageUrl.slice(0, MAX_IMAGE_URL_LEN);
    }
    out.push(variant);
    if (out.length >= MAX_AD_VARIANTS) break;
  }
  return out;
}

/**
 * Emit a metrics log line. Kept separate from patch functions so unit
 * tests don't need to silence console output. Call this after the DB
 * write succeeds so failed DB writes don't pollute the latency histogram.
 */
export function logAdGenCompletionMetric(
  userId: string,
  status: "ready" | "failed",
  durationMs: number,
  variantCount: number
): void {
  const userPrefix = (userId || "anon").slice(0, 8);
  // eslint-disable-next-line no-console
  console.log(
    `[metrics] ad_gen_complete status=${status} duration_ms=${durationMs} variants=${variantCount} user=${userPrefix}`
  );
}
