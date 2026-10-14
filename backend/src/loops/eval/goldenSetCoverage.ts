/**
 * Golden-set label coverage (ENG-2135): how many human-labelled cases exist per surface, split and
 * criterion, and whether any grader could reach MIN_VALIDATION_N on the test split.
 *
 * Pure and read-only: it counts labels a human already saved. A case whose label an AI wrote (note starts
 * with [AI-LABEL], see goldenSet.ts) is counted as unlabelled and reported apart, so this report never says
 * the human work is done when it is not. It never grades, never calls an LLM and never produces or suggests
 * a label. Output is aggregates only: no case ids, source ids or
 * text. Pairwise creative cases (an A / B / tie label, not these binary criteria) are counted
 * apart, as runValidation excludes them too.
 */

import { MIN_VALIDATION_N, type EvalSurface } from './evalRegistry';
import { GOLDEN_CRITERIA, isAiLabelled, type GoldenCase, type GoldenCriterion, type GoldenSplit } from './goldenSet';

export interface CriterionCoverage {
  criterion: string;
  pass: number;
  fail: number;
  na: number;
  unlabelled: number;
  /** pass + fail: the cases runValidation can pair with a grader verdict (`na` is left out). */
  nAvailable: number;
}

export interface SplitCoverage {
  split: GoldenSplit;
  /** Binary (non-pairwise) cases in this split. */
  totalCases: number;
  /** Binary cases with at least one human label saved on a criterion. */
  casesWithBinaryLabel: number;
  /** Cases (binary or pairwise) carrying labels an AI wrote; those labels are not counted anywhere below. */
  aiLabelledCases: number;
  /** Pairwise creative cases, reported apart. */
  pairwiseCases: number;
  pairwiseLabelled: number;
  criteria: CriterionCoverage[];
}

export interface SurfaceCoverage {
  surface: EvalSurface;
  splits: Record<GoldenSplit, SplitCoverage>;
}

export interface LabelCoverage {
  minValidationN: number;
  surfaces: SurfaceCoverage[];
}

export type CriteriaBySurface = Readonly<Record<EvalSurface, readonly string[]>>;

/** The per-surface criteria as defined in goldenSet.ts (not a copy). */
export const GOLDEN_CRITERIA_BY_SURFACE: CriteriaBySurface = GOLDEN_CRITERIA;

function summarizeSplit(split: GoldenSplit, cases: readonly GoldenCase[], criteria: readonly string[]): SplitCoverage {
  const binary = cases.filter((c) => c.pair === undefined);
  const pairwise = cases.filter((c) => c.pair !== undefined);
  const rows: CriterionCoverage[] = criteria.map((criterion) => {
    const row: CriterionCoverage = { criterion, pass: 0, fail: 0, na: 0, unlabelled: 0, nAvailable: 0 };
    for (const c of binary) {
      const label = isAiLabelled(c) ? undefined : c.labels[criterion as GoldenCriterion];
      if (label === 'pass') row.pass++;
      else if (label === 'fail') row.fail++;
      else if (label === 'na') row.na++;
      else row.unlabelled++;
    }
    row.nAvailable = row.pass + row.fail;
    return row;
  });
  return {
    split,
    totalCases: binary.length,
    casesWithBinaryLabel: binary.filter((c) => !isAiLabelled(c) && criteria.some((k) => c.labels[k as GoldenCriterion] !== undefined)).length,
    aiLabelledCases: cases.filter((c) => isAiLabelled(c) && Object.keys(c.labels).length > 0).length,
    pairwiseCases: pairwise.length,
    pairwiseLabelled: pairwise.filter((c) => !isAiLabelled(c) && Object.keys(c.labels).length > 0).length,
    criteria: rows,
  };
}

export function summarizeLabelCoverage(
  cases: readonly GoldenCase[],
  criteriaBySurface: CriteriaBySurface = GOLDEN_CRITERIA_BY_SURFACE,
  minValidationN: number = MIN_VALIDATION_N,
): LabelCoverage {
  const surfaces = (Object.keys(criteriaBySurface) as EvalSurface[]).map((surface) => {
    const own = cases.filter((c) => c.surface === surface);
    return {
      surface,
      splits: {
        dev: summarizeSplit('dev', own.filter((c) => c.split === 'dev'), criteriaBySurface[surface]),
        test: summarizeSplit('test', own.filter((c) => c.split === 'test'), criteriaBySurface[surface]),
      },
    };
  });
  return { minValidationN, surfaces };
}

/** Human-readable report lines (aggregates only). */
export function formatLabelCoverage(coverage: LabelCoverage): string[] {
  const min = coverage.minValidationN;
  const lines: string[] = [`Golden-set label coverage (validation needs n>=${min} pass/fail-labelled test cases per criterion)`];
  for (const s of coverage.surfaces) {
    for (const split of ['test', 'dev'] as const) {
      const sp = s.splits[split];
      lines.push('', `${s.surface} / ${split}: ${sp.totalCases} cases, ${sp.casesWithBinaryLabel} with at least one binary human label`);
      if (sp.aiLabelledCases > 0) lines.push(`  ${sp.aiLabelledCases} case(s) hold AI-written labels: not counted as human`);
      if (sp.pairwiseCases > 0) lines.push(`  pairwise creative (reported separately): ${sp.pairwiseCases} cases, ${sp.pairwiseLabelled} labelled`);
      for (const c of sp.criteria) {
        lines.push(
          `  ${c.criterion}: pass=${c.pass} fail=${c.fail} na=${c.na} unlabelled=${c.unlabelled}` +
            (split === 'test' ? ` | n available for validation=${c.nAvailable}/${min}` : ''),
        );
      }
      if (split === 'test') {
        if (sp.totalCases < min) {
          lines.push(`  cannot reach n>=${min} on the test split: has ${sp.totalCases} (even if every case were labelled)`);
        } else {
          const short = sp.criteria.filter((c) => c.nAvailable < min).length;
          lines.push(
            short === 0
              ? `  every criterion has n>=${min} available on the test split`
              : `  ${short} of ${sp.criteria.length} criteria still below n>=${min}; the split has ${sp.totalCases} cases so it can be reached by labelling`,
          );
        }
      }
    }
  }
  return lines;
}
