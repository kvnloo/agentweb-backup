import React from "react";
import { Composition } from "remotion";
import { BrandedVideo, BrandedVideoProps } from "./compositions/BrandedVideo";

// Default props used in the Remotion Studio preview
const defaultBrandedVideoProps: BrandedVideoProps = {
  clipUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
  brandName: "AgentWeb",
  tagline: "AI-powered marketing automation",
  primaryColor: "#1a73e8",
  secondaryColor: "#fbbc04",
  ctaText: "Get started today",
  ctaUrl: "agentweb.pro",
  introDurationFrames: 90,
  outroDurationFrames: 90,
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/**
       * BrandedVideo: overlays brand name, tagline, logo, and optional CTA
       * onto a raw AI-generated video clip.
       *
       * When rendered via Lambda, the backend passes durationInFrames in
       * inputProps to match the source clip length.  calculateMetadata reads
       * it and overrides the composition duration so Remotion renders the
       * correct number of frames.
       */}
      <Composition
        id="BrandedVideo"
        component={BrandedVideo}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={defaultBrandedVideoProps}
        calculateMetadata={async ({ props }) => {
          const override = (props as any).durationInFrames;
          if (typeof override === "number" && override > 0) {
            return { durationInFrames: override };
          }
          return {};
        }}
      />
    </>
  );
};
