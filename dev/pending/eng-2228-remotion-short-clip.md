## ENG-2228: compose_video no longer crashes on short branded clips (2026-11-19)

- **Symptom:** `compose_video` with one ~4s clip failed with `Remotion render failed: inputRange must be strictly monotonically increasing but got [0,10,-2,18]`.
- **Cause (not in `mediaVideo.ts`, which the ticket cleared):** the BrandedVideo composition fades its intro over `[0, 10, d - 20, d]` and its outro over `[0, 12, d - 10, d]`, where `d` is the overlay's own length. `remotionService.compose` sized each overlay at 15% of the video, so a 4s clip (120 frames) got an 18-frame intro: `[0, 10, 18 - 20, 18]`. Any branded video under about 6.6s failed on the intro, and under about 4.8s with a call to action on the outro. Single clips were only the common case, not the only one.
- **Fix:** `resolveOverlayDurations` in `remotionService.ts` keeps 15% of the video, capped at 90 frames, but never below 31 (intro) or 23 (outro) frames. Videos that already rendered get identical lengths. On a very short video the overlay simply outlasts it and is cut off by the end of the composition.
- **Guard against drift:** a test reads the fade keyframes out of `BrandedVideo.tsx` and fails if they grow past the minimums.
- **Not changed:** the composition itself. It is deployed separately (`remotion lambda sites create`), so the backend sizing is what protects the already-deployed site.
