import React from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from "remotion";

export interface BrandedVideoProps {
  /** S3 URL of the raw AI-generated video clip */
  clipUrl: string;
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

/** Root composition: clip + intro overlay + optional outro */
export const BrandedVideo: React.FC<BrandedVideoProps> = ({
  clipUrl,
  brandName,
  tagline,
  primaryColor,
  secondaryColor,
  logoUrl,
  ctaText,
  ctaUrl,
  introDurationFrames = 90,
  outroDurationFrames = 90,
}) => {
  const { durationInFrames } = useVideoConfig();
  const hasOutro = Boolean(ctaText);
  const outroStart = durationInFrames - outroDurationFrames;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* Raw AI-generated clip fills the full frame */}
      <OffthreadVideo src={clipUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />

      {/* Intro brand overlay */}
      <Sequence from={0} durationInFrames={introDurationFrames}>
        <IntroOverlay
          brandName={brandName}
          tagline={tagline}
          primaryColor={primaryColor}
          secondaryColor={secondaryColor}
          logoUrl={logoUrl}
          durationFrames={introDurationFrames}
        />
      </Sequence>

      {/* Outro CTA overlay */}
      {hasOutro && ctaText && (
        <Sequence from={outroStart} durationInFrames={outroDurationFrames}>
          <OutroOverlay
            ctaText={ctaText}
            ctaUrl={ctaUrl}
            primaryColor={primaryColor}
            secondaryColor={secondaryColor}
            durationFrames={outroDurationFrames}
          />
        </Sequence>
      )}
    </AbsoluteFill>
  );
};
