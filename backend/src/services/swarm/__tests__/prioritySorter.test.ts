import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  getPriorityRank,
  sortByPriority,
  applyTiebreaker,
  PRIORITY_MATRIX,
} from '../prioritySorter';
import { SprintTask, RiskLevel } from '../types';
import { createTask, resetCounters } from './helpers';

describe('prioritySorter', () => {
  beforeEach(() => {
    resetCounters();
  });

  // =====================================================
  // PRIORITY_MATRIX constant
  // =====================================================
  describe('PRIORITY_MATRIX', () => {
    it('should define exactly 9 priority combinations', () => {
      const entries = Object.keys(PRIORITY_MATRIX);
      expect(entries).toHaveLength(9);
    });

    it('should have unique rank values for each combination', () => {
      const ranks = Object.values(PRIORITY_MATRIX);
      const uniqueRanks = new Set(ranks);
      expect(uniqueRanks.size).toBe(9);
    });
  });

  // =====================================================
  // getPriorityRank
  // =====================================================
  describe('getPriorityRank', () => {
    /**
     * Priority order from swarm-pipeline.md:
     * High+Low → High+Med → Med+Low → High+High →
     * Med+Med → Med+High → Low+Low → Low+Med → Low+High
     *
     * Interpretation: (Impact + Risk)
     * The first value is impact level, second is risk level.
     */

    it('should rank High impact + Low risk as highest priority (rank 1)', () => {
      expect(getPriorityRank('High', 'Low')).toBe(1);
    });

    it('should rank High impact + Medium risk as second priority (rank 2)', () => {
      expect(getPriorityRank('High', 'Medium')).toBe(2);
    });

    it('should rank Medium impact + Low risk as third priority (rank 3)', () => {
      expect(getPriorityRank('Medium', 'Low')).toBe(3);
    });

    it('should rank High impact + High risk as fourth priority (rank 4)', () => {
      expect(getPriorityRank('High', 'High')).toBe(4);
    });

    it('should rank Medium impact + Medium risk as fifth priority (rank 5)', () => {
      expect(getPriorityRank('Medium', 'Medium')).toBe(5);
    });

    it('should rank Medium impact + High risk as sixth priority (rank 6)', () => {
      expect(getPriorityRank('Medium', 'High')).toBe(6);
    });

    it('should rank Low impact + Low risk as seventh priority (rank 7)', () => {
      expect(getPriorityRank('Low', 'Low')).toBe(7);
    });

    it('should rank Low impact + Medium risk as eighth priority (rank 8)', () => {
      expect(getPriorityRank('Low', 'Medium')).toBe(8);
    });

    it('should rank Low impact + High risk as lowest priority (rank 9)', () => {
      expect(getPriorityRank('Low', 'High')).toBe(9);
    });

    it('should maintain relative ordering: High+Low < High+Med < Med+Low', () => {
      const highLow = getPriorityRank('High', 'Low');
      const highMed = getPriorityRank('High', 'Medium');
      const medLow = getPriorityRank('Medium', 'Low');
      expect(highLow).toBeLessThan(highMed);
      expect(highMed).toBeLessThan(medLow);
    });

    it('should maintain relative ordering: Med+Med < Low+Low < Low+High', () => {
      const medMed = getPriorityRank('Medium', 'Medium');
      const lowLow = getPriorityRank('Low', 'Low');
      const lowHigh = getPriorityRank('Low', 'High');
      expect(medMed).toBeLessThan(lowLow);
      expect(lowLow).toBeLessThan(lowHigh);
    });
  });

  // =====================================================
  // sortByPriority
  // =====================================================
  describe('sortByPriority', () => {
    it('should sort tasks by priority rank (lowest rank first)', () => {
      // Use the riskLevel field as "risk" — the task needs an "impact" field
      // For now, assume the implementation derives impact from some task property
      // We test with varied risk levels on tasks
      const lowRisk = createTask({ riskLevel: 'Low', storyPoints: 5 });
      const highRisk = createTask({ riskLevel: 'High', storyPoints: 5 });
      const medRisk = createTask({ riskLevel: 'Medium', storyPoints: 5 });

      const sorted = sortByPriority([highRisk, lowRisk, medRisk]);
      // Low risk tasks should come before Medium, before High
      // (assuming equal impact, lower risk = higher priority)
      expect(sorted[0].riskLevel).not.toBe('High');
    });

    it('should put tasks without risk levels last', () => {
      const withRisk = createTask({ riskLevel: 'Low' });
      const withoutRisk = createTask({ riskLevel: null });

      const sorted = sortByPriority([withoutRisk, withRisk]);
      expect(sorted[0].riskLevel).toBe('Low');
      expect(sorted[1].riskLevel).toBeNull();
    });

    it('should handle empty array', () => {
      expect(sortByPriority([])).toEqual([]);
    });

    it('should handle single task', () => {
      const task = createTask();
      expect(sortByPriority([task])).toEqual([task]);
    });

    it('should be stable sort for equal priorities', () => {
      const task1 = createTask({ id: 'first', riskLevel: 'Low' });
      const task2 = createTask({ id: 'second', riskLevel: 'Low' });
      const sorted = sortByPriority([task1, task2]);
      expect(sorted[0].id).toBe('first');
      expect(sorted[1].id).toBe('second');
    });
  });

  // =====================================================
  // applyTiebreaker
  // =====================================================
  describe('applyTiebreaker', () => {
    it('should prefer CI green over CI red', () => {
      const a = { ciGreen: true, unresolvedComments: 2 };
      const b = { ciGreen: false, unresolvedComments: 2 };
      // Negative = a comes first
      expect(applyTiebreaker(a, b)).toBeLessThan(0);
    });

    it('should prefer fewer unresolved comments when CI is equal', () => {
      const a = { ciGreen: true, unresolvedComments: 1 };
      const b = { ciGreen: true, unresolvedComments: 5 };
      expect(applyTiebreaker(a, b)).toBeLessThan(0);
    });

    it('should return 0 for identical tiebreaker values', () => {
      const a = { ciGreen: true, unresolvedComments: 2 };
      const b = { ciGreen: true, unresolvedComments: 2 };
      expect(applyTiebreaker(a, b)).toBe(0);
    });

    it('should prefer CI green even with more unresolved comments', () => {
      const a = { ciGreen: true, unresolvedComments: 10 };
      const b = { ciGreen: false, unresolvedComments: 0 };
      // CI green is the primary tiebreaker
      expect(applyTiebreaker(a, b)).toBeLessThan(0);
    });

    it('should rank CI red with fewer comments before CI red with more', () => {
      const a = { ciGreen: false, unresolvedComments: 1 };
      const b = { ciGreen: false, unresolvedComments: 5 };
      expect(applyTiebreaker(a, b)).toBeLessThan(0);
    });

    it('should handle zero unresolved comments', () => {
      const a = { ciGreen: true, unresolvedComments: 0 };
      const b = { ciGreen: true, unresolvedComments: 0 };
      expect(applyTiebreaker(a, b)).toBe(0);
    });

    it('should be symmetric (b < a when a > b)', () => {
      const a = { ciGreen: false, unresolvedComments: 5 };
      const b = { ciGreen: true, unresolvedComments: 0 };
      expect(applyTiebreaker(a, b)).toBeGreaterThan(0);
    });
  });

  // =====================================================
  // getPriorityRank — edge cases
  // =====================================================
  describe('getPriorityRank - edge cases', () => {
    it('should cover all 9 combinations exhaustively', () => {
      const levels: RiskLevel[] = ['High', 'Medium', 'Low'];
      const seen = new Set<number>();
      for (const impact of levels) {
        for (const risk of levels) {
          const rank = getPriorityRank(impact, risk);
          expect(rank).toBeGreaterThanOrEqual(1);
          expect(rank).toBeLessThanOrEqual(9);
          seen.add(rank);
        }
      }
      expect(seen.size).toBe(9);
    });

    it('should rank higher impact before lower impact for same risk', () => {
      // For Low risk: High+Low (1) < Medium+Low (3) < Low+Low (7)
      expect(getPriorityRank('High', 'Low')).toBeLessThan(getPriorityRank('Medium', 'Low'));
      expect(getPriorityRank('Medium', 'Low')).toBeLessThan(getPriorityRank('Low', 'Low'));
    });

    it('should rank lower risk before higher risk for same impact', () => {
      // For High impact: High+Low (1) < High+Med (2) < High+High (4)
      expect(getPriorityRank('High', 'Low')).toBeLessThan(getPriorityRank('High', 'Medium'));
      expect(getPriorityRank('High', 'Medium')).toBeLessThan(getPriorityRank('High', 'High'));
    });
  });

  // =====================================================
  // sortByPriority — additional scenarios
  // =====================================================
  describe('sortByPriority - additional scenarios', () => {
    it('should correctly sort Low < Medium < High risk with default impact', () => {
      const low = createTask({ id: 'low', riskLevel: 'Low' });
      const med = createTask({ id: 'med', riskLevel: 'Medium' });
      const high = createTask({ id: 'high', riskLevel: 'High' });
      const sorted = sortByPriority([high, low, med]);
      // With default Medium impact: Med+Low=3, Med+Med=5, Med+High=6
      expect(sorted[0].id).toBe('low');
      expect(sorted[1].id).toBe('med');
      expect(sorted[2].id).toBe('high');
    });

    it('should not mutate the original array', () => {
      const tasks = [
        createTask({ id: 'a', riskLevel: 'High' }),
        createTask({ id: 'b', riskLevel: 'Low' }),
      ];
      const original = [...tasks];
      sortByPriority(tasks);
      expect(tasks[0].id).toBe(original[0].id);
      expect(tasks[1].id).toBe(original[1].id);
    });

    it('should group all null risk tasks at the end', () => {
      const tasks = [
        createTask({ id: 'null-1', riskLevel: null }),
        createTask({ id: 'low', riskLevel: 'Low' }),
        createTask({ id: 'null-2', riskLevel: null }),
        createTask({ id: 'med', riskLevel: 'Medium' }),
      ];
      const sorted = sortByPriority(tasks);
      expect(sorted[0].riskLevel).not.toBeNull();
      expect(sorted[1].riskLevel).not.toBeNull();
      expect(sorted[2].riskLevel).toBeNull();
      expect(sorted[3].riskLevel).toBeNull();
    });
  });
});
