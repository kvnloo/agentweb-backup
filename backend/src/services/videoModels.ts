/**
 * Video generation model ids — the single source of truth shared by the video
 * service, the Emma tools and pricing. Pure module (no I/O at load).
 *
 * Google shut down the Veo preview models on 2026-10-22; their replacement is
 * gemini-omni-1.1-flash, served only through the Gemini Interactions API.
 */

export const GEMINI_OMNI_VIDEO_MODEL = "gemini-omni-1.1-flash";
export const SEEDANCE_VIDEO_MODEL = "seedance-2.0";

/** Models a caller may request. Seedance is the product default; Omni is its fallback. */
export const VIDEO_MODELS = [GEMINI_OMNI_VIDEO_MODEL, SEEDANCE_VIDEO_MODEL] as const;

/**
 * Retired Google video ids still found in stored admin settings, saved tasks and
 * old callers. They are accepted as input and resolved to the Omni model — never
 * written back anywhere.
 */
export const LEGACY_GOOGLE_VIDEO_MODELS = [
  "veo-3.1-generate-preview",
  "veo-3.1-fast-generate-preview",
  "veo-3-generate-preview",
  "veo-3.0-generate-preview",
] as const;

/** Resolve a requested model id: legacy Veo ids → Omni; anything else unchanged. */
export function normalizeVideoModel(model: string): string;
export function normalizeVideoModel(model: string | undefined): string | undefined;
export function normalizeVideoModel(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const trimmed = model.trim();
  return (LEGACY_GOOGLE_VIDEO_MODELS as readonly string[]).includes(trimmed)
    ? GEMINI_OMNI_VIDEO_MODEL
    : trimmed;
}

/** True when `model` (after legacy aliasing) is a model we can generate with. */
export function isSupportedVideoModel(model: string | undefined): boolean {
  return !!model && (VIDEO_MODELS as readonly string[]).includes(normalizeVideoModel(model));
}

/** gemini-omni-1.1-flash accepts `response_format.duration` as an integer 3–10 seconds. */
export const OMNI_MIN_CLIP_SECONDS = 3;
export const OMNI_MAX_CLIP_SECONDS = 10;
/** Default total length when a caller gives none (matches the Seedance default). */
export const DEFAULT_VIDEO_SECONDS = 8;

/** Omni's `response_format.duration` value: a string like "5s" (an integer 5 is a 400). */
export function omniDurationParam(seconds: number): string {
  return `${Math.max(OMNI_MIN_CLIP_SECONDS, Math.min(OMNI_MAX_CLIP_SECONDS, Math.round(seconds)))}s`;
}

/**
 * Split a requested total length into Omni clips of at most 10s, each with its
 * exact length (they sum to the rounded request, floored at one 3s clip). A
 * remainder below Omni's 3s minimum borrows from the previous clip, so 21s is
 * [10, 8, 3] rather than an over-long [10, 10, 3].
 */
export function omniClipDurations(requestedSeconds?: number): number[] {
  const raw = typeof requestedSeconds === "number" && Number.isFinite(requestedSeconds)
    ? requestedSeconds
    : DEFAULT_VIDEO_SECONDS;
  const total = Math.max(OMNI_MIN_CLIP_SECONDS, Math.round(raw));
  const clips: number[] = [];
  for (let left = total; left > 0; left -= OMNI_MAX_CLIP_SECONDS) {
    clips.push(Math.min(OMNI_MAX_CLIP_SECONDS, left));
  }
  const last = clips.length - 1;
  if (last > 0 && clips[last] < OMNI_MIN_CLIP_SECONDS) {
    clips[last - 1] -= OMNI_MIN_CLIP_SECONDS - clips[last];
    clips[last] = OMNI_MIN_CLIP_SECONDS;
  }
  return clips;
}
