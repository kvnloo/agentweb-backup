import {
  seedancePollBudgetMs,
  remainingBudgetMs,
  VIDEO_TOTAL_BUDGET_MS,
  VEO_FALLBACK_RESERVE_MS,
} from '../services/videoGeneration';

describe('video generation time-budget helpers (option C: fit seedance+veo inside the turn cap)', () => {
  it('total video budget stays safely under the 600s turn cap', () => {
    expect(VIDEO_TOTAL_BUDGET_MS).toBeLessThan(600000);
  });

  describe('seedancePollBudgetMs', () => {
    it('reserves Veo time: seedance gets (remaining - reserve) when that is the binding constraint', () => {
      // deadline 540s away, reserve 300s, max 480s → seedance capped at 240s so 300s remains for Veo
      expect(seedancePollBudgetMs(0, 540000, 480000, 300000)).toBe(240000);
    });

    it('caps at the seedance max when there is ample time', () => {
      expect(seedancePollBudgetMs(0, 2000000, 480000, 300000)).toBe(480000);
    });

    it('shrinks under tight deadlines', () => {
      expect(seedancePollBudgetMs(0, 350000, 480000, 300000)).toBe(50000);
    });

    it('never goes negative — when no time is left, seedance gets 0 (straight to Veo)', () => {
      expect(seedancePollBudgetMs(0, 200000, 480000, 300000)).toBe(0);
    });

    it('with the configured defaults, a fresh call grants Seedance 360s (reserving 180s for Veo)', () => {
      expect(seedancePollBudgetMs(0, VIDEO_TOTAL_BUDGET_MS)).toBe(360000);
      expect(VIDEO_TOTAL_BUDGET_MS - VEO_FALLBACK_RESERVE_MS).toBe(360000);
    });

    it('accounts for elapsed time (now > 0)', () => {
      // 540s deadline, 100s already elapsed → 440s remain, minus 300s reserve = 140s
      expect(seedancePollBudgetMs(100000, 540000, 480000, 300000)).toBe(140000);
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
