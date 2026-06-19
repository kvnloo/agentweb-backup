import {
  seedancePollBudgetMs,
  remainingBudgetMs,
  videoTotalBudgetMs,
  veoFallbackReserveMs,
  closestVeoAspectRatio,
} from '../services/videoGeneration';

describe('closestVeoAspectRatio (map Seedance aspect ratios to Veo-supported for fallback)', () => {
  it('passes Veo-native ratios through unchanged', () => {
    expect(closestVeoAspectRatio('16:9')).toBe('16:9');
    expect(closestVeoAspectRatio('9:16')).toBe('9:16');
  });

  it('keeps auto as auto (and treats missing as auto)', () => {
    expect(closestVeoAspectRatio('auto')).toBe('auto');
    expect(closestVeoAspectRatio(undefined)).toBe('auto');
  });

  it('maps Seedance-only ratios to the nearest Veo ratio', () => {
    expect(closestVeoAspectRatio('21:9')).toBe('16:9'); // 2.33 → landscape
    expect(closestVeoAspectRatio('4:3')).toBe('16:9');  // 1.33 closer to 1.78 than 0.56
    expect(closestVeoAspectRatio('3:4')).toBe('9:16');  // 0.75 closer to 0.56
    expect(closestVeoAspectRatio('1:1')).toBe('9:16');  // 1.0 closer to 0.56 than 1.78
  });

  it('falls back to auto for unparseable input', () => {
    expect(closestVeoAspectRatio('weird')).toBe('auto');
  });
});

describe('length-driven video time budgets', () => {
  describe('veoFallbackReserveMs (scales with Veo clip count)', () => {
    it('reserves 150s per clip; ≤8s = 1 clip, >8s = ceil(secs/8) clips', () => {
      expect(veoFallbackReserveMs(4)).toBe(150_000);   // 1 clip
      expect(veoFallbackReserveMs(8)).toBe(150_000);   // 1 clip
      expect(veoFallbackReserveMs(9)).toBe(300_000);   // 2 clips
      expect(veoFallbackReserveMs(15)).toBe(300_000);  // 2 clips
    });
    it('clamps duration to 4–15 and defaults to 8', () => {
      expect(veoFallbackReserveMs(undefined)).toBe(150_000); // 8s
      expect(veoFallbackReserveMs(99)).toBe(300_000);        // clamp 15 → 2 clips
    });
  });

  describe('videoTotalBudgetMs (longer videos get more time)', () => {
    it('grows with requested length', () => {
      // seedance = 150 + 45*secs, + veo reserve
      expect(videoTotalBudgetMs(4)).toBe((150 + 45 * 4) * 1000 + 150_000);  // 330 + 150 = 480s
      expect(videoTotalBudgetMs(8)).toBe((150 + 45 * 8) * 1000 + 150_000);  // 510 + 150 = 660s
      expect(videoTotalBudgetMs(15)).toBe((150 + 45 * 15) * 1000 + 300_000); // 825 + 300 = 1125s
    });
    it('a 14s video gets far more than the old flat ~352s seedance budget', () => {
      const total = videoTotalBudgetMs(14);
      const seedance = total - veoFallbackReserveMs(14);
      expect(seedance).toBeGreaterThan(700_000); // ≫ 352s — the 14s case that wrongly failed over
    });
  });

  describe('seedancePollBudgetMs', () => {
    it('grants whatever remains before the deadline after the length-scaled Veo reserve', () => {
      const deadline = videoTotalBudgetMs(8); // fresh 8s budget from t=0
      expect(seedancePollBudgetMs(0, deadline, 8)).toBe(deadline - veoFallbackReserveMs(8));
    });
    it('accounts for elapsed time', () => {
      const deadline = videoTotalBudgetMs(8);
      expect(seedancePollBudgetMs(100_000, deadline, 8)).toBe(deadline - 100_000 - veoFallbackReserveMs(8));
    });
    it('never goes negative — no time left → 0 (straight to Veo)', () => {
      expect(seedancePollBudgetMs(0, 100_000, 8)).toBe(0); // reserve 150s > 100s deadline
    });
  });

  describe('remainingBudgetMs', () => {
    it('returns time left until the deadline', () => {
      expect(remainingBudgetMs(0, 300000)).toBe(300000);
    });

    it('floors at 0 when the deadline has passed', () => {
      expect(remainingBudgetMs(400000, 300000)).toBe(0);
    });
  });
});
