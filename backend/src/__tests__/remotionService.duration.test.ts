// Unit tests for resolveCompositionDuration — the pure duration-math helper behind
// remotionService.compose. Regression guard for ENG-123 "black hole": when the caller
// requests a target duration LONGER than the actual clip footage, the composition used
// to run past the clips and render the bare black background as a multi-second tail.
// The helper must clamp the composition to available footage.

import { resolveCompositionDuration } from '../services/remotionService';

describe('resolveCompositionDuration', () => {
  describe('happy path', () => {
    it('sums uniform clip durations when no target is given', () => {
      const r = resolveCompositionDuration({ clipCount: 3, clipDurationSeconds: 8 });
      expect(r.perClipSeconds).toEqual([8, 8, 8]);
      expect(r.sumSeconds).toBe(24);
      expect(r.totalDurationSeconds).toBe(24);
      expect(r.durationInFrames).toBe(24 * 30);
      expect(r.clipDurationInFrames).toEqual([240, 240, 240]);
      expect(r.targetExceededFootage).toBe(false);
    });

    it('defaults per-clip duration to maxClipSeconds (8) when none supplied', () => {
      const r = resolveCompositionDuration({ clipCount: 2 });
      expect(r.perClipSeconds).toEqual([8, 8]);
      expect(r.sumSeconds).toBe(16);
    });
  });

  describe('trim (target < sum) — intended use, no black', () => {
    it('honors a target shorter than the clip sum', () => {
      const r = resolveCompositionDuration({ clipCount: 4, clipDurationSeconds: 8, targetDurationSeconds: 30 });
      // 4×8 = 32s of footage, trimmed to 30s
      expect(r.sumSeconds).toBe(32);
      expect(r.totalDurationSeconds).toBe(30);
      expect(r.durationInFrames).toBe(30 * 30);
      expect(r.targetExceededFootage).toBe(false);
    });
  });

  describe('black-hole regression (target > sum)', () => {
    it('clamps the composition to the clip sum so no black tail is rendered', () => {
      // 3×8 = 24s of footage but a 30s target was requested (the xCures 30s spot case).
      const r = resolveCompositionDuration({ clipCount: 3, clipDurationSeconds: 8, targetDurationSeconds: 30 });
      expect(r.sumSeconds).toBe(24);
      // Must NOT be 30 — that 6s gap is the black hole.
      expect(r.totalDurationSeconds).toBe(24);
      expect(r.durationInFrames).toBe(24 * 30);
      expect(r.targetExceededFootage).toBe(true);
    });

    it('flags targetExceededFootage when capped clips fall short of the target', () => {
      // Caller thinks 4×8=32 but per-clip cap (maxClipSeconds) is 8 and one clip is 4s.
      const r = resolveCompositionDuration({
        clipCount: 4,
        clipDurationsSeconds: [8, 8, 8, 4],
        targetDurationSeconds: 30,
        maxClipSeconds: 8,
      });
      expect(r.sumSeconds).toBe(28);
      expect(r.totalDurationSeconds).toBe(28);
      expect(r.targetExceededFootage).toBe(true);
    });
  });

  describe('boundary: target === sum', () => {
    it('does not flag when target exactly equals footage', () => {
      const r = resolveCompositionDuration({ clipCount: 3, clipDurationSeconds: 8, targetDurationSeconds: 24 });
      expect(r.totalDurationSeconds).toBe(24);
      expect(r.targetExceededFootage).toBe(false);
    });
  });

  describe('per-clip caps', () => {
    it('clamps each clip to maxClipSeconds', () => {
      const r = resolveCompositionDuration({
        clipCount: 3,
        clipDurationsSeconds: [20, 8, 8], // 20 is stale/incorrect
        maxClipSeconds: 15,
      });
      expect(r.perClipSeconds).toEqual([15, 8, 8]);
      expect(r.sumSeconds).toBe(31);
    });
  });
});
