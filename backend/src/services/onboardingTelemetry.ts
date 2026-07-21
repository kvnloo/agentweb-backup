/**
 * Onboarding reliability telemetry (WS2).
 *
 * The onboarding flow has two fragile external steps — AI image generation
 * and the brand-scrape (LLM + web) — whose failures were invisible to the
 * loops framework: the onboarding loop tracked journey events (goal_selected,
 * ads_generated…) but never the per-step success/failure of these calls. A
 * degraded image model or a flaky scrape just produced a worse onboarding
 * with no telemetry trail.
 *
 * These helpers emit lifecycle events (started / completed / failed) onto the
 * SAME onboarding loop (Dev-AW-LoopEvents) the rest of the system uses, with a
 * semantic `errorClass` on failures (via the shared toolErrorClassifier). The
 * failure-cluster analysis cron + GET /api/admin/loops/health then pick them
 * up automatically — no per-feature wiring beyond these calls.
 *
 * Best-effort and fire-and-forget: a telemetry hiccup must NEVER affect the
 * onboarding cascade, so every helper swallows its own errors.
 */

import { fireLoopEvent } from "./loopEventsEmitter";
import { ONBOARDING_LOOP_ID } from "../loops/instances/onboarding/manifest";
import { asSubjectId } from "../loops/core/types";
import { classifyToolErrorClass } from "../utils/toolErrorClassifier";

/**
 * Canonical event-type strings. MUST be mirrored in the onboarding manifest's
 * `allowedEventTypes` or the sensor will drop them. Kept as a const map so
 * call sites and the manifest can't drift on a typo.
 */
export const ONBOARDING_TELEMETRY_EVENTS = {
  imageGenStarted: "image_generation_started",
  imageGenCompleted: "image_generation_completed",
  imageGenFailed: "image_generation_failed",
  brandScrapeStarted: "brand_scrape_started",
  brandScrapeCompleted: "brand_scrape_completed",
  brandScrapeFailed: "brand_scrape_failed",
  voiceSessionStarted: "voice_session_started",
  voiceSessionReady: "voice_session_ready",
  voiceFirstAudio: "voice_first_audio",
  voiceTurnCompleted: "voice_turn_completed",
  voiceInterrupted: "voice_interrupted",
  voiceSessionFailed: "voice_session_failed",
  voiceIssueReported: "voice_issue_reported",
} as const;

export type OnboardingTelemetryEvent =
  (typeof ONBOARDING_TELEMETRY_EVENTS)[keyof typeof ONBOARDING_TELEMETRY_EVENTS];

type Dimensions = Record<string, string | number | boolean | null>;

/** Emit one onboarding loop event. Best-effort; never throws. */
export async function recordOnboardingEvent(
  userId: string,
  eventType: OnboardingTelemetryEvent,
  dimensions?: Dimensions,
): Promise<void> {
  try {
    await fireLoopEvent(ONBOARDING_LOOP_ID, {
      subjectId: asSubjectId(userId),
      eventType,
      ts: new Date(),
      ...(dimensions ? { dimensions } : {}),
    });
  } catch (err) {
    // fireLoopEvent already swallows, but guard the date/asSubjectId path too.
    // eslint-disable-next-line no-console
    console.warn("[onboardingTelemetry] emit failed (swallowed)", {
      eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Emit a failure event, injecting a semantic `errorClass` (timeout | auth |
 * rate_limit | …) and a truncated `errorMessage` so the failure clusters by
 * cause, not just by step. Best-effort; never throws.
 */
export async function recordOnboardingFailure(
  userId: string,
  eventType: OnboardingTelemetryEvent,
  error: unknown,
  dimensions?: Dimensions,
): Promise<void> {
  const errorClass = classifyToolErrorClass(error);
  const errorMessage = (
    error instanceof Error ? error.message : String(error)
  ).slice(0, 300);
  return recordOnboardingEvent(userId, eventType, {
    ...dimensions,
    errorClass,
    errorMessage,
  });
}
