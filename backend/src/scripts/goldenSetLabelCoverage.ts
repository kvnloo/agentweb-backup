/**
 * Read-only golden-set label coverage report (ENG-2135).
 *
 * Usage (a human runs this; `npm run eval:label-coverage`):
 *   EVAL_GOLDEN_CASES_TABLE=<table> npx ts-node --transpile-only src/scripts/goldenSetLabelCoverage.ts
 *
 * Lists cases through the store's read-only listCases and prints per-surface, per-split counts of
 * pass / fail / na / unlabelled and the n available for validation against MIN_VALIDATION_N.
 * Aggregates only: no case text, no source ids. Calls no grader and no LLM, and writes nothing.
 * Refuses to run when the store is not provisioned.
 */

import { GOLDEN_CASES_TABLE_ENV, goldenSetStoreFromEnv, type GoldenSetStore } from '../loops/eval/goldenSetStore';
import { formatLabelCoverage, summarizeLabelCoverage, GOLDEN_CRITERIA_BY_SURFACE } from '../loops/eval/goldenSetCoverage';
import type { GoldenCase } from '../loops/eval/goldenSet';
import type { EvalSurface } from '../loops/eval/evalRegistry';

export async function runLabelCoverage(
  store: Pick<GoldenSetStore, 'isProvisioned' | 'listCases'>,
  log: (line: string) => void = console.log,
): Promise<number> {
  if (!store.isProvisioned()) {
    console.error(`Golden-set store not provisioned: set ${GOLDEN_CASES_TABLE_ENV} (OPS-2 / ENG-2147).`);
    return 1;
  }
  const cases: GoldenCase[] = [];
  for (const surface of Object.keys(GOLDEN_CRITERIA_BY_SURFACE) as EvalSurface[]) {
    cases.push(...(await store.listCases(surface)));
  }
  for (const line of formatLabelCoverage(summarizeLabelCoverage(cases, GOLDEN_CRITERIA_BY_SURFACE))) log(line);
  return 0;
}

if (require.main === module) {
  runLabelCoverage(goldenSetStoreFromEnv())
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error('goldenSetLabelCoverage failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
