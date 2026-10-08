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
