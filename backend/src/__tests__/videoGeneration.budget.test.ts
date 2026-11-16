import {
  seedancePollBudgetMs,
  remainingBudgetMs,
  videoTotalBudgetMs,
  omniFallbackReserveMs,
  closestOmniAspectRatio,
} from '../services/videoGeneration';

describe('closestOmniAspectRatio (map Seedance aspect ratios to Omni-supported for fallback)', () => {
  it('passes Omni-native ratios through unchanged', () => {
    expect(closestOmniAspectRatio('16:9')).toBe('16:9');
    expect(closestOmniAspectRatio('9:16')).toBe('9:16');
  });

  it('keeps auto as auto (and treats missing as auto)', () => {
    expect(closestOmniAspectRatio('auto')).toBe('auto');
    expect(closestOmniAspectRatio(undefined)).toBe('auto');
  });

  it('maps Seedance-only ratios to the nearest Omni ratio', () => {
    expect(closestOmniAspectRatio('21:9')).toBe('16:9'); // 2.33 → landscape
    expect(closestOmniAspectRatio('4:3')).toBe('16:9');  // 1.33 closer to 1.78 than 0.56
    expect(closestOmniAspectRatio('3:4')).toBe('9:16');  // 0.75 closer to 0.56
    expect(closestOmniAspectRatio('1:1')).toBe('9:16');  // 1.0 closer to 0.56 than 1.78
  });

  it('falls back to auto for unparseable input', () => {
    expect(closestOmniAspectRatio('weird')).toBe('auto');
  });
});

describe('length-driven video time budgets', () => {
  describe('omniFallbackReserveMs (scales with Omni ~10s clip count)', () => {
    it('reserves 150s per clip; ≤10s = 1 clip, >10s = ceil(secs/10) clips', () => {
      expect(omniFallbackReserveMs(4)).toBe(150_000);   // 1 clip
      expect(omniFallbackReserveMs(8)).toBe(150_000);   // 1 clip
      expect(omniFallbackReserveMs(10)).toBe(150_000);  // 1 clip
      expect(omniFallbackReserveMs(11)).toBe(300_000);  // 2 clips
      expect(omniFallbackReserveMs(15)).toBe(300_000);  // 2 clips
    });
    it('clamps duration to 4–15 and defaults to 8', () => {
      expect(omniFallbackReserveMs(undefined)).toBe(150_000); // 8s
      expect(omniFallbackReserveMs(99)).toBe(300_000);        // clamp 15 → 2 clips
    });
  });

  describe('videoTotalBudgetMs (longer videos get more time)', () => {
    it('grows with requested length', () => {
      // seedance = 150 + 45*secs, + omni reserve
      expect(videoTotalBudgetMs(4)).toBe((150 + 45 * 4) * 1000 + 150_000);  // 330 + 150 = 480s
      expect(videoTotalBudgetMs(8)).toBe((150 + 45 * 8) * 1000 + 150_000);  // 510 + 150 = 660s
      expect(videoTotalBudgetMs(15)).toBe((150 + 45 * 15) * 1000 + 300_000); // 825 + 300 = 1125s
    });
    it('a 14s video gets far more than the old flat ~352s seedance budget', () => {
      const total = videoTotalBudgetMs(14);
      const seedance = total - omniFallbackReserveMs(14);
      expect(seedance).toBeGreaterThan(700_000); // ≫ 352s — the 14s case that wrongly failed over
    });
  });

  describe('seedancePollBudgetMs', () => {
    it('grants whatever remains before the deadline after the length-scaled Omni reserve', () => {
      const deadline = videoTotalBudgetMs(8); // fresh 8s budget from t=0
      expect(seedancePollBudgetMs(0, deadline, 8)).toBe(deadline - omniFallbackReserveMs(8));
    });
    it('accounts for elapsed time', () => {
      const deadline = videoTotalBudgetMs(8);
      expect(seedancePollBudgetMs(100_000, deadline, 8)).toBe(deadline - 100_000 - omniFallbackReserveMs(8));
    });
    it('never goes negative — no time left → 0 (straight to Omni)', () => {
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
