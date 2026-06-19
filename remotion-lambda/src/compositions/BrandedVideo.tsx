import React from "react";
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from "remotion";

export interface BrandedVideoProps {
  /** S3 URL of the first (or only) raw AI-generated video clip */
  clipUrl: string;
  /** Additional clip URLs to concatenate after clipUrl (for >8s videos) */
  extraClipUrls?: string[];
  /** Duration of each individual clip in frames (all clips have the same duration) */
  perClipDurationInFrames?: number;
  /** Per-clip durations in frames. When provided, overrides perClipDurationInFrames
   *  and allows variable-length clips (e.g. [240, 240, 240, 180] for 8,8,8,6s at 30fps). */
  clipDurationInFrames?: number[];
  /** Brand display name shown as headline */
  brandName: string;
  /** Optional tagline or subtitle */
  tagline?: string;
  /** Primary hex color (e.g. "#1a73e8") */
  primaryColor: string;
  /** Secondary hex color for gradient accents */
  secondaryColor: string;
  /** Optional logo image URL */
  logoUrl?: string;
  /** Optional call-to-action text */
  ctaText?: string;
  /** Optional website URL shown in CTA */
  ctaUrl?: string;
  /** Duration in frames for the headline intro overlay (default: 90 = 3s at 30fps) */
  introDurationFrames?: number;
  /** Duration in frames for the outro CTA overlay (default: 90 = 3s at 30fps) */
  outroDurationFrames?: number;
  /** Optional S3 URL of an MP3 voiceover audio file to overlay on the video */
  audioUrl?: string;
  /** Volume for the voiceover track (0.0–1.0, default: 1.0) */
  audioVolume?: number;
}

/** Animated lower-third headline shown at the start */
const IntroOverlay: React.FC<{
  brandName: string;
  tagline?: string;
  primaryColor: string;
  secondaryColor: string;
  logoUrl?: string;
  durationFrames: number;
}> = ({ brandName, tagline, primaryColor, secondaryColor, logoUrl, durationFrames }) => {
  const frame = useCurrentFrame();

  // Slide up from bottom
  const translateY = interpolate(frame, [0, 15], [40, 0], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Fade out in the last 20 frames
  const opacity = interpolate(
    frame,
    [0, 10, durationFrames - 20, durationFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {/* Gradient bar at bottom */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: "35%",
          background: `linear-gradient(to top, ${primaryColor}dd, transparent)`,
        }}
      />

      {/* Text block */}
      <div
        style={{
          position: "absolute",
          bottom: 60,
          left: 60,
          right: 60,
          opacity,
          transform: `translateY(${translateY}px)`,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {logoUrl && (
          <img
            src={logoUrl}
            alt={brandName}
            style={{ height: 48, objectFit: "contain", alignSelf: "flex-start", marginBottom: 8 }}
          />
        )}
        <div
          style={{
            fontSize: 52,
            fontWeight: 800,
            color: "#ffffff",
            fontFamily: "Arial, sans-serif",
            lineHeight: 1.1,
            textShadow: "0 2px 8px rgba(0,0,0,0.4)",
          }}
        >
          {brandName}
        </div>
        {tagline && (
          <div
            style={{
              fontSize: 28,
              fontWeight: 400,
              color: "#ffffffcc",
              fontFamily: "Arial, sans-serif",
              textShadow: "0 1px 4px rgba(0,0,0,0.4)",
            }}
          >
            {tagline}
          </div>
        )}
        {/* Accent line */}
        <div
          style={{
            width: 80,
            height: 4,
            borderRadius: 2,
            background: secondaryColor,
            marginTop: 4,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

/** CTA card shown at the end */
const OutroOverlay: React.FC<{
  ctaText: string;
  ctaUrl?: string;
  primaryColor: string;
  secondaryColor: string;
  durationFrames: number;
}> = ({ ctaText, ctaUrl, primaryColor, secondaryColor, durationFrames }) => {
  const frame = useCurrentFrame();

  const opacity = interpolate(frame, [0, 20, durationFrames - 10, durationFrames], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const scale = interpolate(frame, [0, 20], [0.9, 1], {
    easing: Easing.out(Easing.back(1.5)),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: `${primaryColor}cc`,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          opacity,
          transform: `scale(${scale})`,
          textAlign: "center",
          padding: "40px 60px",
          background: "rgba(255,255,255,0.12)",
          borderRadius: 16,
          border: `2px solid ${secondaryColor}`,
        }}
      >
        <div
          style={{
            fontSize: 42,
            fontWeight: 700,
            color: "#ffffff",
            fontFamily: "Arial, sans-serif",
            marginBottom: 16,
          }}
        >
          {ctaText}
        </div>
        {ctaUrl && (
          <div
            style={{
              fontSize: 24,
              color: "#ffffffbb",
              fontFamily: "Arial, sans-serif",
            }}
          >
            {ctaUrl}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

// Cross-fade duration in frames (~200ms at 30fps). Short enough to read as a hard cut
// but long enough to hide the raw Veo clip boundary seam.
const CLIP_FADE_FRAMES = 6;

/** Wraps a single clip with optional fade-in and fade-out */
const ClipWithFade: React.FC<{
  src: string;
  fadeInFrames: number;
  fadeOutFrames: number;
  seqDuration: number;
}> = ({ src, fadeInFrames, fadeOutFrames, seqDuration }) => {
  const frame = useCurrentFrame();

  // Build opacity curve only for the transitions that actually exist
  let opacity: number;
  if (fadeInFrames > 0 && fadeOutFrames > 0) {
    opacity = interpolate(
      frame,
      [0, fadeInFrames, seqDuration - fadeOutFrames, seqDuration],
      [0, 1, 1, 0],
      {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.bezier(0.65, 0, 0.35, 1), // EASE_IN_OUT_CUB — smooth cross-fade
      }
    );
  } else if (fadeInFrames > 0) {
    opacity = interpolate(frame, [0, fadeInFrames], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.22, 1, 0.36, 1), // EASE_OUT_QUART — arrival
    });
  } else if (fadeOutFrames > 0) {
    opacity = interpolate(frame, [seqDuration - fadeOutFrames, seqDuration], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.5, 0, 0.75, 0), // EASE_IN_QUART — exit
    });
  } else {
    opacity = 1;
  }

  return (
    <AbsoluteFill style={{ opacity }}>
      <OffthreadVideo
        src={src}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </AbsoluteFill>
  );
};

/** Root composition: one or more clips concatenated + intro overlay + optional outro */
export const BrandedVideo: React.FC<BrandedVideoProps> = ({
  clipUrl,
  extraClipUrls = [],
  perClipDurationInFrames,
  clipDurationInFrames,
  brandName,
  tagline,
  primaryColor,
  secondaryColor,
  logoUrl,
  ctaText,
  ctaUrl,
  introDurationFrames = 90,
  outroDurationFrames = 90,
  audioUrl,
  audioVolume = 1.0,
}) => {
  const { durationInFrames, fps } = useVideoConfig();
  const hasOutro = Boolean(ctaText);

  // Guard against 0 or negative values which would throw in <Sequence>
  const safeIntroDuration = Math.max(1, introDurationFrames);
  const safeOutroDuration = Math.max(1, outroDurationFrames);
  const outroStart = Math.max(0, durationInFrames - safeOutroDuration);

  // Build the full ordered list of clips
  const allClips = [clipUrl, ...extraClipUrls];
  const clipCount = allClips.length;

  // Resolve per-clip frame durations:
  // 1. clipDurationInFrames array (variable lengths, e.g. [240, 240, 240, 180])
  // 2. perClipDurationInFrames scalar (uniform)
  // 3. fallback: divide total composition duration equally
  const fallbackPerClip = Math.max(1, Math.floor(durationInFrames / clipCount));
  const clipFrames: number[] = allClips.map((_, i) => {
    if (clipDurationInFrames && clipDurationInFrames[i] != null) {
      return Math.max(1, clipDurationInFrames[i]);
    }
    if (perClipDurationInFrames) {
      return Math.max(1, perClipDurationInFrames);
    }
    return fallbackPerClip;
  });

  // Build cumulative start offsets from the per-clip durations
  const clipStarts: number[] = [];
  let cursor = 0;
  for (let i = 0; i < clipCount; i++) {
    clipStarts.push(cursor);
    cursor += clipFrames[i];
  }

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* Clips with cross-fade transitions at each boundary.
          Non-last sequences extend by CLIP_FADE_FRAMES so they overlap the next clip,
          creating a true cross-dissolve without changing total composition duration. */}
      {allClips.map((url, i) => {
        const isFirst = i === 0;
        const isLast = i === clipCount - 1;
        const fadeIn = isFirst ? 0 : CLIP_FADE_FRAMES;
        const fadeOut = isLast ? 0 : CLIP_FADE_FRAMES;
        // Extend non-last clips by CLIP_FADE_FRAMES so they overlap the start of the next clip
        const seqDuration = isLast ? clipFrames[i] : clipFrames[i] + CLIP_FADE_FRAMES;

        return (
          <Sequence
            key={`clip-${i}`}
            from={clipStarts[i]}
            durationInFrames={seqDuration}
          >
            <ClipWithFade
              src={url}
              fadeInFrames={fadeIn}
              fadeOutFrames={fadeOut}
              seqDuration={seqDuration}
            />
          </Sequence>
        );
      })}

      {/* Intro brand overlay — only when branding is provided. Without a brandName the
          composition acts as a plain concatenator (used to stitch multi-clip Veo videos
          for >8s requests that have no brand overlay). */}
      {brandName && (
        <Sequence from={0} durationInFrames={safeIntroDuration}>
          <IntroOverlay
            brandName={brandName}
            tagline={tagline}
            primaryColor={primaryColor}
            secondaryColor={secondaryColor}
            logoUrl={logoUrl}
            durationFrames={safeIntroDuration}
          />
        </Sequence>
      )}

      {/* Outro CTA overlay */}
      {hasOutro && ctaText && (
        <Sequence from={outroStart} durationInFrames={safeOutroDuration}>
          <OutroOverlay
            ctaText={ctaText}
            ctaUrl={ctaUrl}
            primaryColor={primaryColor}
            secondaryColor={secondaryColor}
            durationFrames={safeOutroDuration}
          />
        </Sequence>
      )}

      {/* Voiceover audio track */}
      {audioUrl && (
        <Audio src={audioUrl} volume={audioVolume} />
      )}
    </AbsoluteFill>
  );
};
