/**
 * Swarm Pipeline — Priority Sorter
 *
 * Sorts sprint tasks by the pipeline's priority matrix.
 * Order: High+Low → High+Med → Med+Low → High+High → Med+Med →
 *        Med+High → Low+Low → Low+Med → Low+High
 * Tiebreaker: CI green first, fewer unresolved comments first.
 */

import { SprintTask, RiskLevel } from './types';

/**
 * Priority rank for a (impact, risk) pair.
 * Lower number = higher priority.
 */
export interface PriorityRank {
  taskId: string;
  rank: number;
  impact: RiskLevel;  // reused as impact level
  risk: RiskLevel;
}

/**
 * The priority matrix as defined in swarm-pipeline.md.
 * Maps (impact, risk) tuple to a rank (1 = highest priority).
 */
export const PRIORITY_MATRIX: Record<string, number> = {
  'High:Low': 1,
  'High:Medium': 2,
  'Medium:Low': 3,
  'High:High': 4,
  'Medium:Medium': 5,
  'Medium:High': 6,
  'Low:Low': 7,
  'Low:Medium': 8,
  'Low:High': 9,
};

/**
 * Get the priority rank for an (impact, risk) combination.
 * Returns the rank (1-9), or 999 for unknown combinations.
 */
export function getPriorityRank(impact: RiskLevel, risk: RiskLevel): number {
  const key = `${impact}:${risk}`;
  return PRIORITY_MATRIX[key] ?? 999;
}

/**
 * Sort tasks by the priority matrix.
 * Tasks without risk levels are sorted last.
 */
export function sortByPriority(tasks: SprintTask[]): SprintTask[] {
  const defaultImpact: RiskLevel = 'Medium';
  return [...tasks].sort((a, b) => {
    const rankA = a.riskLevel ? getPriorityRank(defaultImpact, a.riskLevel) : 999;
    const rankB = b.riskLevel ? getPriorityRank(defaultImpact, b.riskLevel) : 999;
    return rankA - rankB;
  });
}

/**
 * Apply tiebreaker: CI green first, fewer unresolved comments first.
 * Used when two tasks have the same priority rank.
 */
export function applyTiebreaker(
  taskA: { ciGreen: boolean; unresolvedComments: number },
  taskB: { ciGreen: boolean; unresolvedComments: number }
): number {
  if (taskA.ciGreen !== taskB.ciGreen) {
    return taskA.ciGreen ? -1 : 1;
  }
  return taskA.unresolvedComments - taskB.unresolvedComments;
}
